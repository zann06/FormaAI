import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: id(),
    email: varchar('email', { length: 254 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: varchar('display_name', { length: 80 }),
    role: varchar('role', { length: 20 }).notNull().default('user'),
    isActive: boolean('is_active').notNull().default(true),
    fallbackCredentialId: uuid('fallback_credential_id'),
    storageUsedBytes: integer('storage_used_bytes').notNull().default(0),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('users_email_unique').on(sql`lower(${table.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    userAgent: varchar('user_agent', { length: 300 }),
    ipHash: varchar('ip_hash', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 160 }).notNull(),
    reportType: varchar('report_type', { length: 80 }),
    language: varchar('language', { length: 10 }).notNull().default('en'),
    tone: varchar('tone', { length: 40 }),
    audience: varchar('audience', { length: 160 }),
    instructions: text('instructions'),
    targetLength: varchar('target_length', { length: 20 }),
    status: varchar('status', { length: 20 }).notNull().default('draft'),
    templateReady: boolean('template_ready').notNull().default(false),
    mappingReady: boolean('mapping_ready').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('projects_user_updated_idx').on(table.userId, table.updatedAt)],
);

export const documents = pgTable(
  'documents',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 20 }).notNull(),
    originalName: varchar('original_name', { length: 300 }).notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: varchar('mime_type', { length: 160 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    checksum: varchar('checksum', { length: 64 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('uploaded'),
    pageCount: integer('page_count'),
    wordCount: integer('word_count'),
    chunkCount: integer('chunk_count').notNull().default(0),
    extractionMethod: varchar('extraction_method', { length: 40 }),
    extractionError: text('extraction_error'),
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('documents_project_idx').on(table.projectId, table.kind),
    index('documents_user_idx').on(table.userId),
    uniqueIndex('documents_project_template_unique')
      .on(table.projectId)
      .where(sql`kind = 'template'`),
  ],
);

export const extractedChunks = pgTable(
  'extracted_chunks',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    page: integer('page'),
    paragraphIndex: integer('paragraph_index'),
    sheet: varchar('sheet', { length: 120 }),
    slide: integer('slide'),
    startOffset: integer('start_offset'),
    endOffset: integer('end_offset'),
    headingPath: text('heading_path'),
    createdAt: createdAt(),
  },
  (table) => [
    index('chunks_document_idx').on(table.documentId, table.ordinal),
    index('chunks_project_idx').on(table.projectId),
  ],
);

export const sourceFacts = pgTable(
  'source_facts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => extractedChunks.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    category: varchar('category', { length: 30 }).notNull(),
    subject: varchar('subject', { length: 200 }),
    value: varchar('value', { length: 300 }),
    normalizedValue: varchar('normalized_value', { length: 300 }),
    page: integer('page'),
    confidence: real('confidence').notNull().default(0.5),
    producedBy: varchar('produced_by', { length: 20 }).notNull().default('heuristic'),
    reviewStatus: varchar('review_status', { length: 20 }).notNull().default('unreviewed'),
    createdAt: createdAt(),
  },
  (table) => [
    index('facts_project_idx').on(table.projectId, table.category),
    index('facts_chunk_idx').on(table.chunkId),
  ],
);

export const templateSections = pgTable(
  'template_sections',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    sectionKey: varchar('section_key', { length: 120 }).notNull(),
    headingOriginal: text('heading_original').notNull(),
    heading: text('heading').notNull(),
    level: integer('level').notNull(),
    sortOrder: integer('sort_order').notNull(),
    paragraphIndex: integer('paragraph_index').notNull(),
    styleId: varchar('style_id', { length: 120 }),
    bodyPreview: text('body_preview'),
    tableCount: integer('table_count').notNull().default(0),
    hasImages: boolean('has_images').notNull().default(false),
    required: boolean('required').notNull().default(true),
    excluded: boolean('excluded').notNull().default(false),
    insertionStrategy: varchar('insertion_strategy', { length: 20 }).notNull().default('after_heading'),
    placeholder: varchar('placeholder', { length: 120 }),
    instructions: text('instructions'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('sections_project_idx').on(table.projectId, table.sortOrder),
    uniqueIndex('sections_project_key_unique').on(table.projectId, table.sectionKey),
  ],
);

export const sectionMappings = pgTable(
  'section_mappings',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => templateSections.id, { onDelete: 'cascade' }),
    purpose: text('purpose'),
    requirements: jsonb('requirements').$type<string[]>().notNull().default([]),
    evidenceChunkIds: jsonb('evidence_chunk_ids').$type<string[]>().notNull().default([]),
    gaps: jsonb('gaps').$type<string[]>().notNull().default([]),
    conflicts: jsonb('conflicts').$type<unknown[]>().notNull().default([]),
    contentPlan: jsonb('content_plan').$type<string[]>().notNull().default([]),
    coverage: varchar('coverage', { length: 20 }).notNull().default('none'),
    producedBy: varchar('produced_by', { length: 20 }).notNull().default('heuristic'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('mappings_section_unique').on(table.sectionId)],
);

export const reportSections = pgTable(
  'report_sections',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    templateSectionId: uuid('template_section_id')
      .notNull()
      .references(() => templateSections.id, { onDelete: 'cascade' }),
    content: text('content').notNull().default(''),
    status: varchar('status', { length: 20 }).notNull().default('empty'),
    revision: integer('revision').notNull().default(0),
    citedChunkIds: jsonb('cited_chunk_ids').$type<string[]>().notNull().default([]),
    warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
    placeholders: jsonb('placeholders').$type<string[]>().notNull().default([]),
    providerCredentialId: uuid('provider_credential_id'),
    modelUsed: varchar('model_used', { length: 160 }),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    wordCount: integer('word_count').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('report_sections_template_unique').on(table.templateSectionId)],
);

export const reportVersions = pgTable(
  'report_versions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    label: varchar('label', { length: 160 }).notNull(),
    kind: varchar('kind', { length: 30 }).notNull().default('snapshot'),
    snapshot: jsonb('snapshot').$type<unknown>().notNull(),
    createdBy: varchar('created_by', { length: 30 }).notNull().default('user'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('versions_project_number_unique').on(table.projectId, table.versionNumber),
    index('versions_project_idx').on(table.projectId, table.createdAt),
  ],
);

export const providerCredentials = pgTable(
  'provider_credentials',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    displayName: varchar('display_name', { length: 80 }).notNull(),
    providerType: varchar('provider_type', { length: 40 }).notNull(),
    baseUrl: varchar('base_url', { length: 500 }),
    model: varchar('model', { length: 160 }).notNull(),
    /** AES-256-GCM ciphertext (base64). Never returned to clients. */
    apiKeyCiphertext: text('api_key_ciphertext').notNull(),
    apiKeyIv: varchar('api_key_iv', { length: 64 }).notNull(),
    apiKeyTag: varchar('api_key_tag', { length: 64 }).notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    keyLast4: varchar('key_last4', { length: 4 }).notNull(),
    keyFingerprint: varchar('key_fingerprint', { length: 32 }).notNull(),
    sessionOnly: boolean('session_only').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    isDefault: boolean('is_default').notNull().default(false),
    lastTestStatus: varchar('last_test_status', { length: 20 }),
    lastTestMessage: text('last_test_message'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    requestSettings: jsonb('request_settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('credentials_user_idx').on(table.userId)],
);

export const aiUsageEvents = pgTable(
  'ai_usage_events',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    credentialId: uuid('credential_id').references(() => providerCredentials.id, { onDelete: 'set null' }),
    jobId: uuid('job_id'),
    providerType: varchar('provider_type', { length: 40 }).notNull(),
    model: varchar('model', { length: 160 }).notNull(),
    operation: varchar('operation', { length: 40 }).notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    durationMs: integer('duration_ms'),
    status: varchar('status', { length: 20 }).notNull(),
    errorCode: varchar('error_code', { length: 40 }),
    fallbackUsed: boolean('fallback_used').notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [index('usage_user_created_idx').on(table.userId, table.createdAt)],
);

export const processingJobs = pgTable(
  'processing_jobs',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 40 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('queued'),
    stage: varchar('stage', { length: 60 }),
    progress: integer('progress').notNull().default(0),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    stageEvents: jsonb('stage_events').$type<Array<Record<string, unknown>>>().notNull().default([]),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    errorCode: varchar('error_code', { length: 60 }),
    errorMessage: text('error_message'),
    fallbackUsed: boolean('fallback_used').notNull().default(false),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('jobs_status_idx').on(table.status, table.createdAt),
    index('jobs_project_idx').on(table.projectId, table.createdAt),
    index('jobs_user_idx').on(table.userId, table.createdAt),
  ],
);

export const exportArtifacts = pgTable(
  'export_artifacts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').references(() => reportVersions.id, { onDelete: 'set null' }),
    format: varchar('format', { length: 10 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    storageKey: text('storage_key'),
    sizeBytes: integer('size_bytes'),
    checksum: varchar('checksum', { length: 64 }),
    versionNumber: integer('version_number').notNull().default(1),
    fidelityReport: jsonb('fidelity_report').$type<Record<string, unknown> | null>(),
    warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
    errorMessage: text('error_message'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('exports_project_idx').on(table.projectId, table.createdAt)],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 60 }).notNull(),
    entityType: varchar('entity_type', { length: 40 }),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [index('audit_user_created_idx').on(table.userId, table.createdAt)],
);

export const schema = {
  users,
  sessions,
  projects,
  documents,
  extractedChunks,
  sourceFacts,
  templateSections,
  sectionMappings,
  reportSections,
  reportVersions,
  providerCredentials,
  aiUsageEvents,
  processingJobs,
  exportArtifacts,
  auditEvents,
};

export type UserRow = typeof users.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type TemplateSectionRow = typeof templateSections.$inferSelect;
export type ReportSectionRow = typeof reportSections.$inferSelect;
export type ProviderCredentialRow = typeof providerCredentials.$inferSelect;
export type ProcessingJobRow = typeof processingJobs.$inferSelect;
export type ExportArtifactRow = typeof exportArtifacts.$inferSelect;
export type ReportVersionRow = typeof reportVersions.$inferSelect;
export type ChunkRow = typeof extractedChunks.$inferSelect;
export type SectionMappingRow = typeof sectionMappings.$inferSelect;

void primaryKey;
