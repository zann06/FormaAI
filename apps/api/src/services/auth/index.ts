import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { sessions, users } from '../../db/schema.js';
import { createSessionToken, hashIp, hashSessionToken, hashPassword, verifyPassword } from '../../lib/crypto.js';
import { AppError, unauthorized, validationError } from '../../lib/errors.js';
import type { AppConfig } from '../../config.js';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  fallbackCredentialId: string | null;
}

export interface AuthContext {
  userId: string;
  email: string;
  role: string;
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
  user: SessionUser;
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;

/**
 * Short-lived in-memory login throttle. For multi-instance deployments the
 * global rate limiter on /api/auth/* remains the primary control; this adds
 * per-account exponential backoff within a process.
 */
class LoginThrottle {
  private readonly attempts = new Map<string, { count: number; lockedUntil: number }>();

  check(email: string): void {
    const entry = this.attempts.get(email);
    if (!entry) return;
    if (entry.lockedUntil > Date.now()) {
      throw new AppError(
        'RATE_LIMITED',
        'Too many failed sign-in attempts. Try again in a few minutes.',
      );
    }
    if (entry.lockedUntil !== 0 && entry.lockedUntil <= Date.now()) this.attempts.delete(email);
  }

  fail(email: string): void {
    const entry = this.attempts.get(email) ?? { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILED_ATTEMPTS) {
      entry.lockedUntil = Date.now() + LOCK_WINDOW_MS;
      entry.count = 0;
    }
    this.attempts.set(email, entry);
  }

  reset(email: string): void {
    this.attempts.delete(email);
  }
}

export class AuthService {
  private readonly throttle = new LoginThrottle();

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  async signUp(input: { email: string; password: string; displayName?: string }, context: { userAgent?: string; ip?: string }): Promise<CreatedSession> {
    if (!this.config.REGISTRATION_ENABLED) {
      throw new AppError('FORBIDDEN', 'Registration is disabled on this instance. Ask the operator for an account.');
    }
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email.toLowerCase()}`)
      .limit(1);
    if (existing.length > 0) {
      throw new AppError('CONFLICT', 'An account with this email already exists');
    }
    const passwordHash = await hashPassword(input.password);
    const role = this.config.adminEmails.includes(input.email.toLowerCase()) ? 'admin' : 'user';
    const [created] = await this.db
      .insert(users)
      .values({
        email: input.email,
        passwordHash,
        displayName: input.displayName ?? null,
        role,
      })
      .returning({ id: users.id, email: users.email, displayName: users.displayName, role: users.role });
    if (!created) throw new AppError('INTERNAL', 'Could not create the account');
    return this.createSession(created, context);
  }

  async signIn(input: { email: string; password: string }, context: { userAgent?: string; ip?: string }): Promise<CreatedSession> {
    this.throttle.check(input.email.toLowerCase());
    const [user] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email.toLowerCase()}`)
      .limit(1);
    // Constant-ish work whether or not the account exists.
    const stored = user?.passwordHash ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';
    const valid = await verifyPassword(input.password, stored);
    if (!user || !valid) {
      this.throttle.fail(input.email.toLowerCase());
      throw unauthorized('Email or password is incorrect');
    }
    if (!user.isActive) throw new AppError('FORBIDDEN', 'This account has been disabled');
    this.throttle.reset(input.email.toLowerCase());
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    return this.createSession(user, context);
  }

  private async createSession(
    user: { id: string; email: string; displayName: string | null; role: string },
    context: { userAgent?: string; ip?: string },
  ): Promise<CreatedSession> {
    const token = createSessionToken();
    const tokenHash = hashSessionToken(token, this.config.sessionSecret);
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    await this.db.insert(sessions).values({
      userId: user.id,
      tokenHash,
      userAgent: context.userAgent?.slice(0, 300) ?? null,
      ipHash: hashIp(context.ip, this.config.sessionSecret),
      expiresAt,
    });
    const [full] = await this.db
      .select({ fallbackCredentialId: users.fallbackCredentialId })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    return {
      token,
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        fallbackCredentialId: full?.fallbackCredentialId ?? null,
      },
    };
  }

  /** Resolves a session token to a user, renewing the expiry when it is past half-life. */
  async resolveSession(token: string | undefined): Promise<{ user: SessionUser; renewedExpiry: Date | null } | null> {
    if (!token) return null;
    const tokenHash = hashSessionToken(token, this.config.sessionSecret);
    const [row] = await this.db
      .select({
        sessionId: sessions.id,
        expiresAt: sessions.expiresAt,
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        isActive: users.isActive,
        fallbackCredentialId: users.fallbackCredentialId,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!row || !row.isActive) return null;

    const ttl = this.config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
    const remaining = row.expiresAt.getTime() - Date.now();
    let renewedExpiry: Date | null = null;
    if (remaining < ttl / 2) {
      renewedExpiry = new Date(Date.now() + ttl);
      await this.db
        .update(sessions)
        .set({ expiresAt: renewedExpiry, lastUsedAt: new Date() })
        .where(eq(sessions.id, row.sessionId));
    } else {
      await this.db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, row.sessionId));
    }
    return {
      user: {
        id: row.userId,
        email: row.email,
        displayName: row.displayName,
        role: row.role,
        fallbackCredentialId: row.fallbackCredentialId,
      },
      renewedExpiry,
    };
  }

  async signOut(token: string | undefined): Promise<void> {
    if (!token) return;
    const tokenHash = hashSessionToken(token, this.config.sessionSecret);
    await this.db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }

  async signOutEverywhere(userId: string, exceptToken?: string): Promise<void> {
    if (exceptToken) {
      const tokenHash = hashSessionToken(exceptToken, this.config.sessionSecret);
      await this.db.delete(sessions).where(and(eq(sessions.userId, userId), sql`${sessions.tokenHash} <> ${tokenHash}`));
      return;
    }
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string, currentToken?: string): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw unauthorized();
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw validationError('The current password is incorrect');
    }
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw validationError('Choose a password different from the current one');
    }
    await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
      .where(eq(users.id, userId));
    await this.signOutEverywhere(userId, currentToken);
  }

  async deleteAccount(userId: string, password: string): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw unauthorized();
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw validationError('The password is incorrect');
    }
    await this.db.delete(users).where(eq(users.id, userId));
  }

  async listSessions(userId: string): Promise<Array<{ id: string; userAgent: string | null; createdAt: Date; lastUsedAt: Date }>> {
    return this.db
      .select({ id: sessions.id, userAgent: sessions.userAgent, createdAt: sessions.createdAt, lastUsedAt: sessions.lastUsedAt })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(sessions.lastUsedAt);
  }

  async purgeExpiredSessions(): Promise<number> {
    const deleted = await this.db.delete(sessions).where(lt(sessions.expiresAt, new Date())).returning({ id: sessions.id });
    return deleted.length;
  }
}
