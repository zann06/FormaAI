/**
 * Shared test harness for the API.
 *
 * Each test file gets an isolated database schema (created and dropped around
 * the run) so tests can execute in parallel without seeing each other's rows.
 * The Fastify instance is built with `buildServer()` exactly as in production.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import { applyMigrationsToSchema } from './apply-migrations.js';
import { createStorage } from '../src/services/storage/index.js';
import { storageRegistry } from '../src/services/storage/registry.js';
import { ProviderRegistry } from '@formaai/ai-providers';
import { JobWorker } from '../src/services/worker/index.js';

export const BASE_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/formaai';

const MIGRATIONS_FOLDER = path.join(process.cwd(), 'drizzle');

export interface TestApp {
  server: BuiltServer;
  app: FastifyInstance;
  config: AppConfig;
  storageDir: string;
  /** Database handle, for arranging state the HTTP surface does not expose. */
  db: ReturnType<typeof createDb>['db'];
  /** Storage adapter, so a test can place bytes the API will read back. */
  storage: ReturnType<typeof createStorage>;
  /** Drains queued jobs synchronously so tests never wait on timers. */
  drainQueue: (maxJobs?: number) => Promise<number>;
  /** Claims and runs at most one job, so a test can watch queue ordering. */
  drainQueueOnce: () => Promise<number>;
  close: () => Promise<void>;
}

/**
 * Creates a throwaway Postgres schema and points a fresh pool at it via
 * `search_path`, then applies the real migrations into that schema.
 */
function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

async function createSchema(): Promise<{ schema: string; admin: pg.Pool }> {
  const admin = new pg.Pool({ connectionString: BASE_DATABASE_URL, max: 1 });
  const schema = `test_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await admin.query(`create schema "${schema}"`);
  return { schema, admin };
}

export async function createTestApp(overrides: Partial<Record<string, string>> = {}): Promise<TestApp> {
  const { schema, admin } = await createSchema();
  const storageDir = await mkdtemp(path.join(tmpdir(), 'formaai-test-'));
  const schemaUrl = withSearchPath(BASE_DATABASE_URL, schema);

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: schemaUrl,
    STORAGE_DRIVER: 'local',
    STORAGE_DIR: storageDir,
    LOG_LEVEL: 'silent',
    ENABLE_DEV_PROVIDER: 'true',
    REGISTRATION_ENABLED: 'true',
    COOKIE_SECURE: 'false',
    WEB_ORIGIN: 'http://localhost:5173',
    ...overrides,
  } as NodeJS.ProcessEnv);

  const dbHandle = createDb(config);
  const db = dbHandle.db;
  // Every pool connection inherits the throwaway schema from the `options`
  // URL parameter, so all statements below are confined to it.
  await applyMigrationsToSchema(dbHandle.pool, schema, MIGRATIONS_FOLDER);

  const storage = createStorage(config);
  storageRegistry.set(storage);
  const registry = new ProviderRegistry({
    timeoutMs: config.AI_REQUEST_TIMEOUT_MS,
    enableDevProvider: true,
  });

  const server = await buildServer({
    config,
    db,
    dbHandle,
    storage,
    registry,
  });

  const worker = new JobWorker(server.workerServices, db, {
    concurrency: 1,
    pollIntervalMs: 5,
    logger: server.safeLogger,
  });

  await server.app.ready();

  return {
    server,
    app: server.app,
    config,
    storageDir,
    db,
    storage,
    drainQueue: async (maxJobs = 50) => worker.runOnce(maxJobs),
    /** Run exactly one claim+execute cycle — lets a test observe queue ordering. */
    drainQueueOnce: async () => worker.runOnce(1),
    close: async () => {
      await server.app.close();
      await dbHandle.close();
      await admin.query(`drop schema "${schema}" cascade`);
      await admin.end();
      await rm(storageDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * Minimal cookie-jar client. Keeps the session cookie between calls and
 * supports multipart uploads built with the native FormData/Blob APIs.
 */
export class TestClient {
  private cookie: string | null = null;

  constructor(private readonly app: FastifyInstance) {}

  get sessionCookie(): string | null {
    return this.cookie;
  }

  set sessionCookie(value: string | null) {
    this.cookie = value;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.cookie) headers.cookie = this.cookie;
    return headers;
  }

  private captureCookie(response: { headers: Record<string, unknown> }): void {
    const raw = response.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
    for (const entry of list) {
      const [pair] = entry.split(';');
      if (pair?.startsWith('formaai_session=')) this.cookie = pair;
    }
  }

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    options: { body?: unknown; headers?: Record<string, string>; payload?: FormData } = {},
  ): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
    const response = await this.rawRequest(method, url, options);
    let body: unknown = response.body;
    try {
      body = response.body ? JSON.parse(response.body) : null;
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body, headers: response.headers };
  }

  /** Like `request`, but keeps the raw payload (binary downloads). */
  async bytes(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
  ): Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }> {
    const response = await this.rawRequest(method, url, {});
    return { status: response.statusCode, body: response.rawPayload, headers: response.headers };
  }

  private async rawRequest(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    options: { body?: unknown; headers?: Record<string, string>; payload?: FormData },
  ) {
    const response = await this.app.inject({
      method,
      url,
      headers: options.headers ? this.headers(options.headers) : this.headers(),
      ...(options.payload
        ? { payload: options.payload as never, headers: { ...this.headers(), ...options.headers } }
        : options.body !== undefined
          ? { payload: JSON.stringify(options.body), headers: this.headers({ 'content-type': 'application/json', ...options.headers }) }
          : {}),
    });
    this.captureCookie(response);
    return response;
  }

  get(url: string) {
    return this.request('GET', url);
  }
  post(url: string, body?: unknown) {
    return this.request('POST', url, { body });
  }
  patch(url: string, body?: unknown) {
    return this.request('PATCH', url, { body });
  }
  delete(url: string, body?: unknown) {
    return this.request('DELETE', url, body === undefined ? {} : { body });
  }

  /**
   * Uploads a file the same way the browser does (multipart/form-data).
   *
   * `kindLast` appends the "kind" field *after* the file, which is what a browser
   * FormData does when the file is appended first. @fastify/multipart only exposes
   * fields parsed before the file part, so this ordering used to silently drop the
   * field and store every upload as a "source" — the exact bug that made a template
   * uploaded from the chat become a plain source file.
   */
  upload(
    url: string,
    file: { name: string; type: string; bytes: Uint8Array },
    kind?: 'template' | 'source',
    options: { kindLast?: boolean } = {},
  ) {
    const form = new FormData();
    if (kind && !options.kindLast) form.append('kind', kind);
    const copy = new Uint8Array(file.bytes.byteLength);
    copy.set(file.bytes);
    form.append('file', new Blob([copy], { type: file.type }), file.name);
    if (kind && options.kindLast) form.append('kind', kind);
    return this.request('POST', url, { payload: form });
  }
}

export interface TestUser {
  client: TestClient;
  id: string;
  email: string;
}

let userCounter = 0;

/** Registers a fresh account and returns an authenticated client. */
export async function signUpUser(app: FastifyInstance, emailPrefix = 'user'): Promise<TestUser> {
  userCounter += 1;
  const client = new TestClient(app);
  const email = `${emailPrefix}${userCounter}-${randomUUID().slice(0, 8)}@example.test`;
  const result = await client.post('/api/auth/signup', {
    email,
    password: 'CorrectHorseBattery9!',
    displayName: `${emailPrefix} ${userCounter}`,
  });
  if (result.status !== 201) {
    throw new Error(`signup failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
  return { client, id: result.body.user.id, email };
}
