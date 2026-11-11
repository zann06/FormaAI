import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { aiUsageEvents } from '../../db/schema.js';
import type { AuthContext } from '../auth/index.js';

export interface UsageInput {
  projectId?: string | null;
  credentialId?: string | null;
  jobId?: string | null;
  providerType: string;
  model: string;
  operation: string;
  status: 'success' | 'failure';
  errorCode?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  fallbackUsed?: boolean;
}

export class UsageService {
  constructor(private readonly db: Database) {}

  async record(ctx: AuthContext, input: UsageInput): Promise<void> {
    await this.db.insert(aiUsageEvents).values({
      userId: ctx.userId,
      projectId: input.projectId ?? null,
      credentialId: input.credentialId ?? null,
      jobId: input.jobId ?? null,
      providerType: input.providerType,
      model: input.model.slice(0, 160),
      operation: input.operation,
      status: input.status,
      errorCode: input.errorCode ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      durationMs: input.durationMs ?? null,
      fallbackUsed: input.fallbackUsed ?? false,
    });
  }

  async list(ctx: AuthContext, limit = 100) {
    return this.db
      .select()
      .from(aiUsageEvents)
      .where(eq(aiUsageEvents.userId, ctx.userId))
      .orderBy(sql`${aiUsageEvents.createdAt} desc`)
      .limit(limit);
  }

  async summary(ctx: AuthContext) {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [totals] = await this.db
      .select({
        requests: sql<number>`count(*)::int`,
        successes: sql<number>`count(*) filter (where ${aiUsageEvents.status} = 'success')::int`,
        failures: sql<number>`count(*) filter (where ${aiUsageEvents.status} = 'failure')::int`,
        inputTokens: sql<number>`coalesce(sum(${aiUsageEvents.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${aiUsageEvents.outputTokens}), 0)::int`,
        fallbacks: sql<number>`count(*) filter (where ${aiUsageEvents.fallbackUsed})::int`,
      })
      .from(aiUsageEvents)
      .where(and(eq(aiUsageEvents.userId, ctx.userId), gte(aiUsageEvents.createdAt, since)));
    const byModel = await this.db
      .select({
        model: aiUsageEvents.model,
        providerType: aiUsageEvents.providerType,
        requests: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${aiUsageEvents.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${aiUsageEvents.outputTokens}), 0)::int`,
      })
      .from(aiUsageEvents)
      .where(and(eq(aiUsageEvents.userId, ctx.userId), gte(aiUsageEvents.createdAt, since)))
      .groupBy(aiUsageEvents.model, aiUsageEvents.providerType);
    return { windowDays: 30, totals, byModel };
  }

  async todayCount(ctx: AuthContext): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiUsageEvents)
      .where(
        and(
          eq(aiUsageEvents.userId, ctx.userId),
          sql`${aiUsageEvents.createdAt} >= date_trunc('day', now())`,
        ),
      );
    return Number(row?.count ?? 0);
  }
}
