/**
 * Response types mirroring the API's JSON exactly.
 *
 * These are hand-written (rather than generated) because the API does not expose
 * an OpenAPI schema yet; they are kept in sync with `apps/api/src/routes`. Field
 * names match the server, so a mismatch is a compile error at the call site.
 */

export type ProviderType = 'openai-compatible' | 'anthropic' | 'gemini' | 'dev-offline';
export type ProjectStatus = 'draft' | 'processing' | 'needs_review' | 'ready' | 'failed' | 'archived';
export type DocumentStatus = 'uploaded' | 'queued' | 'extracting' | 'extracted' | 'failed';
export type SectionStatus = 'empty' | 'draft' | 'needs_review' | 'validated' | 'final';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type Coverage = 'strong' | 'partial' | 'none';

export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
  displayName: string | null;
}

export interface Project {
  id: string;
  title: string;
  reportType: string | null;
  language: string;
  tone: string | null;
  audience: string | null;
  instructions: string | null;
  targetLength: 'short' | 'medium' | 'long' | null;
  status: ProjectStatus;
  templateReady: boolean;
  mappingReady: boolean;
  archivedAt: string | null;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  documentCount: number;
  sourceCount: number;
}

export interface DocumentRecord {
  id: string;
  kind: 'template' | 'source';
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  extractionError?: string | null;
  createdAt: string;
}

export interface OutlineSection {
  id: string;
  heading: string;
  headingOriginal?: string;
  level: number;
  sortOrder: number;
  required: boolean;
  excluded: boolean;
  insertionStrategy: 'placeholder' | 'after_heading' | 'manual';
  placeholder: string | null;
  instructions: string | null;
  tableCount: number;
  bodyPreview: string | null;
}

export interface ReportSection {
  id: string;
  sectionId: string;
  content: string;
  status: SectionStatus;
  revision: number;
  warnings: string[];
  citedChunkIds: string[];
  placeholders: string[];
  wordCount: number;
  modelUsed: string | null;
  generatedAt: string | null;
  editedAt: string | null;
}

export interface EvidenceExcerpt {
  id: string;
  documentName: string;
  page: number | null;
  paragraphIndex: number | null;
  text: string;
}

export interface SectionMapping {
  purpose: string | null;
  requirements: string[];
  gaps: string[];
  conflicts: Array<{ label: string; values: Array<{ value: string; documentName: string }> }>;
  contentPlan: string[];
  coverage: Coverage;
  producedBy: 'heuristic' | 'ai';
}

export interface MappingSection {
  sectionId: string;
  heading: string;
  level: number;
  excluded: boolean;
  coverage: Coverage;
  purpose: string | null;
  requirements: string[];
  gaps: string[];
  evidence: EvidenceExcerpt[];
  producedBy: 'heuristic' | 'ai';
}

export interface SectionDetail {
  section: OutlineSection;
  content: string;
  status: SectionStatus;
  revision: number;
  warnings: string[];
  placeholders: string[];
  citedChunkIds: string[];
  modelUsed: string | null;
  mapping: SectionMapping | null;
  evidence: EvidenceExcerpt[];
}

export interface Job {
  id: string;
  kind: string;
  status: JobStatus;
  stage: string | null;
  progress: number;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  fallbackUsed: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  documentId: string | null;
  result?: Record<string, unknown>;
}

export interface Credential {
  id: string;
  displayName: string;
  providerType: ProviderType;
  baseUrl: string | null;
  model: string;
  keyLast4: string;
  keyFingerprint: string;
  sessionOnly: boolean;
  isDefault: boolean;
  lastTestStatus: 'ok' | 'failed' | null;
  lastTestMessage: string | null;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialsResponse {
  credentials: Credential[];
  supportedTypes: string[];
  devProviderEnabled: boolean;
}

export interface ExportArtifact {
  id: string;
  format: 'docx' | 'pdf';
  status: 'pending' | 'processing' | 'ready' | 'failed';
  versionNumber: number;
  sizeBytes: number | null;
  checksum?: string | null;
  warnings?: string[] | null;
  fidelityReport?: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface VersionSummary {
  id: string;
  versionNumber: number;
  label: string;
  kind: string;
  createdAt: string;
}

export interface UsageEvent {
  id: string;
  providerType: string;
  model: string;
  operation: string;
  status: 'success' | 'failure';
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  fallbackUsed: boolean;
  createdAt: string;
  projectId?: string | null;
}

export interface UsageTotals {
  requests: number;
  successes: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  fallbacks: number;
}

export interface UsageSummary {
  windowDays: number;
  totals: UsageTotals;
  byModel: Array<{
    model: string | null;
    providerType: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

export interface SessionInfo {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  current: boolean;
}

export interface TemplateAnalysis {
  template: {
    id: string;
    originalName: string;
    sizeBytes: number;
    status: DocumentStatus;
    extractionError: string | null;
    createdAt: string;
  } | null;
  structure: {
    title: string | null;
    headings: Array<{ id: string; text: string; level: number; styleName?: string }>;
  } | null;
  sections: OutlineSection[];
  latestJob: { id: string; status: JobStatus; stage: string | null; errorMessage: string | null } | null;
}
