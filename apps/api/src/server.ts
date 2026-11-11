import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { AppConfig } from './config.js';
import { createDb, type DbHandle, type Database } from './db/client.js';
import { AuthService } from './services/auth/index.js';
import { ProjectService } from './services/projects/index.js';
import { DocumentService } from './services/documents/index.js';
import { TemplateService } from './services/template/index.js';
import { CredentialService } from './services/credentials/index.js';
import { FactService } from './services/facts/index.js';
import { MappingService } from './services/mapping/index.js';
import { GenerationService } from './services/generation/index.js';
import { ExportService } from './services/export/index.js';
import { UsageService } from './services/usage/index.js';
import { JobService } from './services/jobs/index.js';
import { createStorage, type StorageAdapter } from './services/storage/index.js';
import { storageRegistry } from './services/storage/registry.js';
import { SafeLogger } from './lib/logger.js';
import { ProviderRegistry } from '@formaai/ai-providers';
import { registerPlugins } from './plugins/index.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerTemplateRoutes } from './routes/template.js';
import { registerCredentialRoutes } from './routes/credentials.js';
import { registerPipelineRoutes } from './routes/pipeline.js';
import { registerExportRoutes } from './routes/exports.js';
import type { ServerContext } from './server-context.js';
import type { AllServices } from './services/worker/runtime.js';

export interface ServerServices {
  credentials: CredentialService;
}

export interface BuildServerOptions {
  config: AppConfig;
  db?: Database;
  dbHandle?: DbHandle;
  storage?: StorageAdapter;
  registry?: ProviderRegistry;
  logger?: SafeLogger;
}

export interface BuiltServer {
  app: FastifyInstance;
  services: {
    auth: AuthService;
    projects: ProjectService;
    documents: DocumentService;
    template: TemplateService;
    credentials: CredentialService;
    facts: FactService;
    mapping: MappingService;
    generation: GenerationService;
    exports: ExportService;
    usage: UsageService;
    jobs: JobService;
  };
  db: Database;
  dbHandle: DbHandle;
  storage: StorageAdapter;
  registry: ProviderRegistry;
  safeLogger: SafeLogger;
  /** The same service instances the HTTP layer uses, ready for the job worker. */
  workerServices: AllServices;
}

export async function buildServer(options: BuildServerOptions): Promise<BuiltServer> {
  const { config } = options;
  const dbHandle = options.dbHandle ?? createDb(config);
  const db = options.db ?? dbHandle.db;
  const storage = options.storage ?? createStorage(config);
  storageRegistry.set(storage);

  const registry =
    options.registry ??
    new ProviderRegistry({ timeoutMs: config.AI_REQUEST_TIMEOUT_MS, enableDevProvider: config.ENABLE_DEV_PROVIDER });

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.apiKey',
          '*.api_key',
          '*.password',
          '*.authorization',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        req(request) {
          return { method: request.method, url: request.url.split('?')[0] };
        },
      },
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: Math.max(1024 * 1024, config.MAX_FILE_MB * 1024 * 1024 + 65536),
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
  });

  const logger = options.logger ?? new SafeLogger(app.log, config.LOG_DOCUMENT_CONTENT);

  const auth = new AuthService(db, config);
  const projects = new ProjectService(db, storage);
  const documents = new DocumentService(db, storage, {
    maxBytes: config.MAX_FILE_MB * 1024 * 1024,
    userQuotaBytes: config.USER_STORAGE_QUOTA_MB * 1024 * 1024,
  });
  const template = new TemplateService(db);
  const credentials = new CredentialService(db, config, registry);
  const facts = new FactService(db);
  const usage = new UsageService(db);
  const mapping = new MappingService(db, config, credentials, facts, registry);
  const generation = new GenerationService(db, config, credentials, mapping, usage, facts, registry);
  const exports = new ExportService(db, storage, config);
  const jobs = new JobService(db, config.JOB_MAX_ATTEMPTS);

  await registerPlugins(app, { config, auth });

  const ctx: ServerContext = {
    config,
    db,
    auth,
    services: { credentials },
    projectService: projects,
    documentService: documents,
    templateService: template,
    credentialService: credentials,
    factService: facts,
    mappingService: mapping,
    generationService: generation,
    exportService: exports,
    usageService: usage,
    providers: registry,
  };

  app.decorate('config', config);
  app.decorate('appContext', { config, db, storage });

  await registerAuthRoutes(app, ctx);
  await registerProjectRoutes(app, ctx);
  await registerDocumentRoutes(app, ctx);
  await registerTemplateRoutes(app, ctx);
  await registerCredentialRoutes(app, ctx);
  await registerPipelineRoutes(app, ctx);
  await registerExportRoutes(app, ctx);

  app.get('/api/health', async () => ({
    status: 'ok',
    time: new Date().toISOString(),
    features: {
      pdfConversion: Boolean(config.LIBREOFFICE_BIN || config.CONVERTER_URL),
      ocr: Boolean(process.env.TESSERACT_BIN || process.env.OCR_ENDPOINT),
      devProvider: config.ENABLE_DEV_PROVIDER,
      registration: config.REGISTRATION_ENABLED,
    },
  }));

  app.get('/api/health/ready', async (_request, reply) => {
    try {
      await db.execute(sql`select 1`);
      return reply.send({ status: 'ready' });
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  return {
    app,
    services: { auth, projects, documents, template, credentials, facts, mapping, generation, exports, usage, jobs },
    db,
    dbHandle,
    storage,
    registry,
    safeLogger: logger,
    // Same instances as above, shaped for the worker (plus its credential access).
    workerServices: {
      db,
      config,
      storage,
      registry,
      logger,
      documents,
      template,
      facts,
      mapping,
      generation,
      exports,
      usage,
      jobs,
      credentials,
    },
  };
}
