import { z } from 'zod';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => value === true || value === 'true' || value === '1');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  API_HOST: z.string().default('0.0.0.0'),
  /** Public URL of the web app, used for CORS + cookie settings. */
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  TRUST_PROXY: booleanish.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_DOCUMENT_CONTENT: booleanish.default(false),

  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://postgres:postgres@localhost:5432/formaai'),
  DATABASE_SSL: booleanish.default(false),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  /** 32-byte key, base64 or hex. Required in production. */
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  /** 32+ char secret used to derive session token hashing pepper. */
  SESSION_SECRET: z.string().min(16).optional(),
  COOKIE_SECURE: booleanish.default(false),
  COOKIE_DOMAIN: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  REGISTRATION_ENABLED: booleanish.default(true),
  /** Optional bootstrap admin email (limited operator role, no document access). */
  ADMIN_EMAILS: z.string().default(''),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('./data/storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanish.default(true),

  MAX_FILE_MB: z.coerce.number().int().min(1).max(200).default(25),
  MAX_PDF_PAGES: z.coerce.number().int().min(1).max(2000).default(300),
  USER_STORAGE_QUOTA_MB: z.coerce.number().int().min(10).default(1024),
  DAILY_AI_REQUEST_QUOTA: z.coerce.number().int().min(1).default(500),
  DAILY_EXPORT_QUOTA: z.coerce.number().int().min(1).default(50),

  LIBREOFFICE_BIN: z.string().optional(),
  CONVERTER_URL: z.string().optional(),
  CONVERTER_TOKEN: z.string().optional(),
  PDF_CONVERSION_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(120_000),

  ENABLE_DEV_PROVIDER: booleanish.default(false),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(90_000),
  AI_MAX_EVIDENCE_CHARS: z.coerce.number().int().min(1000).default(14_000),
  AI_MAX_SECTIONS_PER_JOB: z.coerce.number().int().min(1).default(40),
  AI_STRUCTURED_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(3).default(1),

  WORKER_ENABLED: booleanish.default(true),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  EXPORT_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
});

export type AppConfig = z.infer<typeof envSchema> & {
  encryptionKey: Buffer;
  sessionSecret: string;
  adminEmails: string[];
  webOrigins: string[];
};

function decodeKey(raw: string): Buffer {
  const base64 = /^[A-Za-z0-9+/=_\-]+$/.test(raw) ? Buffer.from(raw, 'base64') : null;
  if (base64 && base64.length === 32) return base64;
  const hex = Buffer.from(raw, 'hex');
  if (hex.length === 32) return hex;
  throw new Error(
    'CREDENTIAL_ENCRYPTION_KEY must be 32 bytes encoded as base64 (openssl rand -base64 32) or hex (openssl rand -hex 32)',
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const config = parsed.data;
  const isProduction = config.NODE_ENV === 'production';

  let encryptionKey: Buffer;
  if (config.CREDENTIAL_ENCRYPTION_KEY) {
    encryptionKey = decodeKey(config.CREDENTIAL_ENCRYPTION_KEY);
  } else if (isProduction) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is required in production (generate with: openssl rand -base64 32)');
  } else {
    // Development/test fallback: deterministic, clearly non-secret key.
    encryptionKey = Buffer.alloc(32, 7);
  }

  let sessionSecret = config.SESSION_SECRET;
  if (!sessionSecret) {
    if (isProduction) throw new Error('SESSION_SECRET is required in production (32+ characters)');
    sessionSecret = 'development-session-secret-not-for-production';
  }
  if (isProduction && config.COOKIE_SECURE === false) {
    // Warn rather than fail: reverse proxies terminate TLS and set the cookie flags.
    process.emitWarning('COOKIE_SECURE=false in production — session cookies will be sent over plain HTTP.');
  }
  if (config.STORAGE_DRIVER === 's3' && (!config.S3_BUCKET || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY)) {
    throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  }

  return {
    ...config,
    encryptionKey,
    sessionSecret,
    adminEmails: config.ADMIN_EMAILS.split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
    webOrigins: config.WEB_ORIGIN.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

export const config: AppConfig = loadConfig();
