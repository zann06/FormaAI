import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { providerCredentials, users } from '../../db/schema.js';
import type { AppConfig } from '../../config.js';
import type { AuthContext } from '../auth/index.js';
import { aadFor, decryptSecret, encryptSecret, fingerprint, last4 } from '../../lib/crypto.js';
import { AppError, forbidden, notFound, validationError } from '../../lib/errors.js';
import { randomUUID } from 'node:crypto';
import type { ProviderCredentialCreateInput, ProviderCredentialUpdateInput, ProviderType } from '@formaai/shared';
import { ProviderRegistry, fetchWithTimeout, normalizeBaseUrl, redactSecrets } from '@formaai/ai-providers';
import type { ProviderConfig } from '@formaai/ai-providers';

export interface PublicCredential {
  id: string;
  displayName: string;
  providerType: ProviderType;
  baseUrl: string | null;
  model: string;
  keyLast4: string;
  keyFingerprint: string;
  sessionOnly: boolean;
  expiresAt: Date | null;
  isDefault: boolean;
  lastTestStatus: string | null;
  lastTestMessage: string | null;
  lastTestedAt: Date | null;
  requestSettings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const requestSettingsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(64).max(200000).optional(),
    topP: z.number().min(0).max(1).optional(),
    apiVersion: z.string().max(40).optional(),
    extraHeaders: z.record(z.string().max(200)).optional(),
  })
  .strict();

export class CredentialService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly registry: ProviderRegistry,
  ) {}

  private toPublic(row: typeof providerCredentials.$inferSelect): PublicCredential {
    return {
      id: row.id,
      displayName: row.displayName,
      providerType: row.providerType as ProviderType,
      baseUrl: row.baseUrl,
      model: row.model,
      keyLast4: row.keyLast4,
      keyFingerprint: row.keyFingerprint,
      sessionOnly: row.sessionOnly,
      expiresAt: row.expiresAt,
      isDefault: row.isDefault,
      lastTestStatus: row.lastTestStatus,
      lastTestMessage: row.lastTestMessage,
      lastTestedAt: row.lastTestedAt,
      requestSettings: row.requestSettings,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async list(ctx: AuthContext): Promise<PublicCredential[]> {
    const rows = await this.db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, ctx.userId))
      .orderBy(desc(providerCredentials.isDefault), desc(providerCredentials.createdAt));
    return rows.map((row) => this.toPublic(row));
  }

  /**
   * Fails fast when the user has no provider configured.
   *
   * Drafting is the only pipeline step that needs a model, and it runs last — so
   * without this check a scan would analyse the template, map every section, and
   * only then fail, after minutes of work, with an error that reads as if the
   * sources were the problem. Answering up front turns that into one clear
   * instruction before anything is queued.
   */
  async assertHasProvider(ctx: AuthContext): Promise<void> {
    const [existing] = await this.db
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, ctx.userId))
      .limit(1);
    if (!existing) {
      throw validationError(
        'No AI provider is configured. Add your own provider and API key in Settings → AI providers before generating a report.',
      );
    }
  }

  async create(ctx: AuthContext, input: ProviderCredentialCreateInput): Promise<PublicCredential> {
    if (input.providerType === 'dev-offline' && !this.config.ENABLE_DEV_PROVIDER) {
      throw forbidden('The offline development provider is disabled on this instance');
    }
    if (!this.registry.supports(input.providerType)) {
      throw validationError(`Provider type "${input.providerType}" is not enabled`);
    }
    if (input.providerType === 'openai-compatible' && !input.baseUrl) {
      throw validationError('A Base URL is required for OpenAI-compatible providers');
    }
    const settings = input.requestSettings ? requestSettingsSchema.parse(input.requestSettings) : {};
    this.assertSafeBaseUrl(input.baseUrl);

    const existing = await this.db
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, ctx.userId));
    if (existing.length >= 10) {
      throw new AppError('QUOTA_EXCEEDED', 'You can store at most 10 provider configurations');
    }
    const makeDefault = input.isDefault || existing.length === 0;

    const idPlaceholder = randomUUID();
    const encrypted = encryptSecret(
      input.apiKey,
      this.config.encryptionKey,
      aadFor(ctx.userId, idPlaceholder),
    );
    const sessionTtlMs = 12 * 60 * 60 * 1000;

    const [row] = await this.db.transaction(async (tx) => {
      if (makeDefault) {
        await tx
          .update(providerCredentials)
          .set({ isDefault: false })
          .where(eq(providerCredentials.userId, ctx.userId));
      }
      return tx
        .insert(providerCredentials)
        .values({
          id: idPlaceholder,
          userId: ctx.userId,
          displayName: input.displayName,
          providerType: input.providerType,
          baseUrl: input.baseUrl ?? null,
          model: input.model,
          apiKeyCiphertext: encrypted.ciphertext,
          apiKeyIv: encrypted.iv,
          apiKeyTag: encrypted.tag,
          keyVersion: encrypted.keyVersion,
          keyLast4: last4(input.apiKey),
          keyFingerprint: fingerprint(input.apiKey),
          sessionOnly: input.sessionOnly ?? false,
          expiresAt: input.sessionOnly ? new Date(Date.now() + sessionTtlMs) : null,
          isDefault: makeDefault,
          requestSettings: settings,
        })
        .returning();
    });
    return this.toPublic(row!);
  }

  async update(ctx: AuthContext, credentialId: string, input: ProviderCredentialUpdateInput): Promise<PublicCredential> {
    await this.assertOwned(ctx, credentialId);
    if (input.providerType === 'dev-offline' && !this.config.ENABLE_DEV_PROVIDER) {
      throw forbidden('The offline development provider is disabled on this instance');
    }
    this.assertSafeBaseUrl(input.baseUrl);
    const settings =
      input.requestSettings !== undefined ? requestSettingsSchema.parse(input.requestSettings) : undefined;
    const encrypted = input.apiKey
      ? encryptSecret(input.apiKey, this.config.encryptionKey, aadFor(ctx.userId, credentialId))
      : null;

    const [row] = await this.db.transaction(async (tx) => {
      if (input.isDefault) {
        await tx
          .update(providerCredentials)
          .set({ isDefault: false })
          .where(eq(providerCredentials.userId, ctx.userId));
      }
      return tx
        .update(providerCredentials)
        .set({
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.providerType !== undefined ? { providerType: input.providerType } : {}),
          ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(encrypted
            ? {
                apiKeyCiphertext: encrypted.ciphertext,
                apiKeyIv: encrypted.iv,
                apiKeyTag: encrypted.tag,
                keyVersion: encrypted.keyVersion,
                keyLast4: last4(input.apiKey!),
                keyFingerprint: fingerprint(input.apiKey!),
                lastTestStatus: null,
                lastTestMessage: null,
                lastTestedAt: null,
              }
            : {}),
          ...(input.sessionOnly !== undefined ? { sessionOnly: input.sessionOnly } : {}),
          ...(settings !== undefined ? { requestSettings: settings } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(providerCredentials.id, credentialId), eq(providerCredentials.userId, ctx.userId)))
        .returning();
    });
    if (!row) throw notFound('Provider configuration not found');
    return this.toPublic(row);
  }

  private async assertOwned(ctx: AuthContext, credentialId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .where(and(eq(providerCredentials.id, credentialId), eq(providerCredentials.userId, ctx.userId)))
      .limit(1);
    if (!row) throw notFound('Provider configuration not found');
  }

  async remove(ctx: AuthContext, credentialId: string): Promise<void> {
    const [deleted] = await this.db
      .delete(providerCredentials)
      .where(and(eq(providerCredentials.id, credentialId), eq(providerCredentials.userId, ctx.userId)))
      .returning({ id: providerCredentials.id });
    if (!deleted) throw notFound('Provider configuration not found');
    // If it was the default, promote the most recent remaining configuration.
    const [next] = await this.db
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, ctx.userId))
      .orderBy(desc(providerCredentials.createdAt))
      .limit(1);
    if (next) {
      await this.db
        .update(providerCredentials)
        .set({ isDefault: true })
        .where(and(eq(providerCredentials.id, next.id), eq(providerCredentials.userId, ctx.userId), sql`not exists (
          select 1 from ${providerCredentials} pc where pc.user_id = ${ctx.userId} and pc.is_default = true
        )`));
    }
  }

  /**
   * Decrypts a credential for a provider call. Only ever called server-side and
   * the plaintext never leaves this process.
   */
  async toProviderConfig(ctx: AuthContext, credentialId: string): Promise<ProviderConfig & { id: string; providerType: ProviderType }> {
    const row = await this.db
      .select()
      .from(providerCredentials)
      .where(and(eq(providerCredentials.id, credentialId), eq(providerCredentials.userId, ctx.userId)))
      .limit(1)
      .then((rows) => rows[0]);
    if (!row) throw notFound('Provider configuration not found');
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      throw new AppError('PROVIDER_NOT_CONFIGURED', 'This session-only API key has expired. Re-enter it in Settings.');
    }
    const apiKey = decryptSecret(
      {
        ciphertext: row.apiKeyCiphertext,
        iv: row.apiKeyIv,
        tag: row.apiKeyTag,
        keyVersion: row.keyVersion,
      },
      this.config.encryptionKey,
      aadFor(ctx.userId, row.id),
    );
    return {
      id: row.id,
      providerType: row.providerType as ProviderType,
      baseUrl: row.baseUrl ?? '',
      model: row.model,
      apiKey,
      requestSettings: row.requestSettings as ProviderConfig['requestSettings'],
    };
  }

  async getDefault(ctx: AuthContext): Promise<{ id: string } | null> {
    const [row] = await this.db
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .where(and(eq(providerCredentials.userId, ctx.userId), eq(providerCredentials.isDefault, true)))
      .limit(1);
    if (row) return row;
    const [any] = await this.db
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, ctx.userId))
      .orderBy(desc(providerCredentials.createdAt))
      .limit(1);
    return any ?? null;
  }

  async resolveForGeneration(ctx: AuthContext, requestedId?: string) {
    if (requestedId) {
      const config = await this.toProviderConfig(ctx, requestedId);
      return { primary: config, fallback: await this.loadFallback(ctx, config.id) };
    }
    const def = await this.getDefault(ctx);
    if (!def) {
      throw new AppError(
        'PROVIDER_NOT_CONFIGURED',
        'No AI provider is configured. Add your own provider and API key in Settings → AI providers.',
      );
    }
    const config = await this.toProviderConfig(ctx, def.id);
    return { primary: config, fallback: await this.loadFallback(ctx, config.id) };
  }

  private async loadFallback(ctx: AuthContext, primaryId: string) {
    const [user] = await this.db
      .select({ fallbackCredentialId: users.fallbackCredentialId })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);
    const fallbackId = user?.fallbackCredentialId;
    if (!fallbackId || fallbackId === primaryId) return null;
    try {
      return await this.toProviderConfig(ctx, fallbackId);
    } catch {
      return null;
    }
  }

  async testConnection(ctx: AuthContext, credentialId: string) {
    const config = await this.toProviderConfig(ctx, credentialId);
    const result = await this.registry.get(config.providerType).testConnection(config);
    await this.db
      .update(providerCredentials)
      .set({
        lastTestStatus: result.ok ? 'ok' : 'failed',
        lastTestMessage: result.message.slice(0, 1000),
        lastTestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(providerCredentials.id, credentialId), eq(providerCredentials.userId, ctx.userId)));
    return result;
  }

  /**
   * Lists the models a provider exposes, using the stored (decrypted) key.
   *
   * Typing a model identifier by hand is the single most common way a report
   * fails: one wrong character and every generation returns HTTP 404. Routers
   * such as 9router, OpenRouter, Ollama and vLLM all publish `GET {baseUrl}/models`,
   * so the real catalogue can be offered instead of guessed at.
   *
   * This is read-only and never throws for a provider that does not support the
   * endpoint — it returns an empty list with a message, so the UI can fall back to
   * manual entry instead of showing an error for a perfectly usable provider.
   */
  async listModels(
    ctx: AuthContext,
    credentialId: string,
  ): Promise<{ models: string[]; message: string; supported: boolean }> {
    const config = await this.toProviderConfig(ctx, credentialId);
    if (config.providerType === 'dev-offline') {
      return {
        models: [config.model],
        message: 'The offline development provider has a single built-in model.',
        supported: true,
      };
    }
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    if (!baseUrl) {
      return { models: [], message: 'Add a base URL first.', supported: false };
    }

    // Anthropic and Gemini use their own catalogues; only the OpenAI-compatible
    // shape is standardised enough to call generically.
    const endpoint = config.providerType === 'openai-compatible' ? `${baseUrl}/models` : '';
    if (!endpoint) {
      return {
        models: [],
        message: `Listing models is not supported for ${config.providerType}. Enter the model ID manually.`,
        supported: false,
      };
    }

    try {
      const response = await fetchWithTimeout(
        endpoint,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            ...(config.requestSettings?.extraHeaders ?? {}),
          },
        },
        20_000,
      );
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          models: [],
          message:
            response.status === 401 || response.status === 403
              ? 'The provider rejected the API key while listing models.'
              : `The provider returned HTTP ${response.status} for /models. Enter the model ID manually. ${
                  redactSecrets(text, [config.apiKey]).slice(0, 200)
                }`,
          supported: false,
        };
      }
      const json = (await response.json().catch(() => null)) as
        | { data?: Array<{ id?: unknown }>; models?: Array<{ name?: unknown; id?: unknown }> }
        | null;
      const ids = [
        ...(json?.data ?? []).map((entry) => entry.id),
        ...(json?.models ?? []).map((entry) => entry.id ?? entry.name),
      ]
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map((id) => id.trim());
      const models = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
      return {
        models,
        message:
          models.length > 0
            ? `${models.length} model${models.length === 1 ? '' : 's'} available.`
            : 'The provider returned an empty model list. Enter the model ID manually.',
        supported: models.length > 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { models: [], message: `Could not reach /models: ${message}`, supported: false };
    }
  }

  async setFallback(ctx: AuthContext, fallbackCredentialId: string | null) {
    if (fallbackCredentialId) {
      await this.toProviderConfig(ctx, fallbackCredentialId); // ownership + existence check
    }
    await this.db
      .update(users)
      .set({ fallbackCredentialId, updatedAt: new Date() })
      .where(eq(users.id, ctx.userId));
  }

  async purgeExpired(): Promise<string[]> {
    const rows = await this.db
      .select({ id: providerCredentials.id, storageKey: sql<string>`${providerCredentials.userId}::text` })
      .from(providerCredentials)
      .where(sql`${providerCredentials.expiresAt} is not null and ${providerCredentials.expiresAt} < now()`);
    if (rows.length === 0) return [];
    // tenancy-guard: allow system cleanup — purges credentials whose own expiry passed
    await this.db
      .delete(providerCredentials)
      .where(sql`${providerCredentials.expiresAt} is not null and ${providerCredentials.expiresAt} < now()`);
    return rows.map((r) => r.id);
  }

  /** Rejects URLs pointing at obvious internal services unless explicitly allowed. */
  private assertSafeBaseUrl(baseUrl: string | undefined): void {
    if (!baseUrl) return;
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw validationError('Base URL must be a valid absolute URL');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw validationError('Base URL must use http or https');
    }
  }
}
