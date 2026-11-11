import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { changePasswordSchema, deleteAccountSchema, signInSchema, signUpSchema } from '@formaai/shared';
import type { ServerContext } from '../server-context.js';
import { clearSessionCookie, parseBody, requireUser, readSessionToken, setSessionCookie } from '../plugins/auth-helpers.js';
import { users } from '../db/schema.js';

export async function registerAuthRoutes(instance: FastifyInstance, ctx: ServerContext): Promise<void> {
  const { auth, config } = ctx;

  instance.post(
    '/api/auth/signup',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const input = parseBody(request, signUpSchema);
      const session = await auth.signUp(input, { userAgent: request.headers['user-agent'], ip: request.ip });
      setSessionCookie(reply, session.token, session.expiresAt, {
        secure: config.COOKIE_SECURE,
        domain: config.COOKIE_DOMAIN,
        ttlDays: config.SESSION_TTL_DAYS,
      });
      request.log.info({ userId: session.user.id }, 'account created');
      return reply.status(201).send({ user: session.user });
    },
  );

  instance.post(
    '/api/auth/signin',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const input = parseBody(request, signInSchema);
      const session = await auth.signIn(input, { userAgent: request.headers['user-agent'], ip: request.ip });
      setSessionCookie(reply, session.token, session.expiresAt, {
        secure: config.COOKIE_SECURE,
        domain: config.COOKIE_DOMAIN,
        ttlDays: config.SESSION_TTL_DAYS,
      });
      request.log.info({ userId: session.user.id }, 'signed in');
      return reply.send({ user: session.user });
    },
  );

  instance.post('/api/auth/signout', async (request, reply) => {
    const token = readSessionToken(request);
    await auth.signOut(token);
    clearSessionCookie(reply, config.COOKIE_DOMAIN);
    return reply.send({ ok: true });
  });

  instance.get('/api/auth/session', async (request, reply) => {
    const user = requireUser(request);
    const [full] = await ctx.db
      .select({ displayName: users.displayName, fallbackCredentialId: users.fallbackCredentialId })
      .from(users)
      .where(eq(users.id, user.userId))
      .limit(1);
    return reply.send({
      user: { id: user.userId, email: user.email, role: user.role, displayName: full?.displayName ?? null },
      fallbackCredentialId: full?.fallbackCredentialId ?? null,
      registrationEnabled: config.REGISTRATION_ENABLED,
    });
  });

  instance.patch('/api/auth/password', async (request, reply) => {
    const user = requireUser(request);
    const input = parseBody(request, changePasswordSchema);
    await auth.changePassword(user.userId, input.currentPassword, input.newPassword, readSessionToken(request));
    return reply.send({ ok: true });
  });

  instance.delete('/api/auth/account', async (request, reply) => {
    const user = requireUser(request);
    const input = parseBody(request, deleteAccountSchema);
    // Remove stored files first so a failure never leaves orphaned private data.
    const fileDeletion = await ctx.projectService.deleteAllFiles(user);
    if (fileDeletion.failed > 0) {
      request.log.warn({ userId: user.userId, failed: fileDeletion.failed }, 'some stored files could not be removed');
    }
    await auth.deleteAccount(user.userId, input.password);
    clearSessionCookie(reply, config.COOKIE_DOMAIN);
    request.log.info({ userId: user.userId }, 'account deleted');
    return reply.send({ ok: true });
  });

  instance.get('/api/auth/sessions', async (request, reply) => {
    const user = requireUser(request);
    const sessions = await auth.listSessions(user.userId);
    return reply.send({ sessions });
  });

  instance.delete('/api/auth/sessions', async (request, reply) => {
    const user = requireUser(request);
    await auth.signOutEverywhere(user.userId, readSessionToken(request));
    return reply.send({ ok: true });
  });

  instance.get('/api/auth/signup-availability', async (_request, reply) => {
    return reply.send({ registrationEnabled: config.REGISTRATION_ENABLED });
  });
}
