export type ProjectStatus = (typeof import('./constants.js').PROJECT_STATUSES)[number];
export type DocumentKind = (typeof import('./constants.js').DOCUMENT_KINDS)[number];
export type DocumentStatus = (typeof import('./constants.js').DOCUMENT_STATUSES)[number];
export type JobKind = (typeof import('./constants.js').JOB_KINDS)[number];
export type JobStatus = (typeof import('./constants.js').JOB_STATUSES)[number];
export type SectionStatus = (typeof import('./constants.js').SECTION_STATUSES)[number];
export type InsertionStrategy = (typeof import('./constants.js').INSERTION_STRATEGIES)[number];
export type ProviderType = (typeof import('./constants.js').PROVIDER_TYPES)[number];

export interface TemplateHeading {
  /** Stable identifier, e.g. "sec-3" */
  id: string;
  text: string;
  level: number;
  order: number;
  styleId: string | null;
  styleName: string | null;
  numberingLabel: string | null;
  /** Paragraph index in document order (body-level, tables count as one) */
  paragraphIndex: number;
  /** Text of the paragraphs inside the section body, before the next heading */
  bodyText: string;
  bodyParagraphCount: number;
  /** Placeholders found inside this section (after the heading, before the next heading) */
  placeholders: string[];
  /** True when a placeholder with the section key exists anywhere in the document */
  hasExplicitPlaceholder: boolean;
  tableCount: number;
  hasImages: boolean;
  pageBreakBefore: boolean;
  suggestedStrategy: InsertionStrategy;
}

export interface TemplateStructure {
  detectedAt: string;
  title: string | null;
  headings: TemplateHeading[];
  placeholders: string[];
  paragraphCount: number;
  tableCount: number;
  nestedTableCount: number;
  imagesCount: number;
  hasHeaders: boolean;
  hasFooters: boolean;
  headerTexts: string[];
  footerTexts: string[];
  pageSetup: {
    widthTwips: number | null;
    heightTwips: number | null;
    orientation: 'portrait' | 'landscape' | null;
    marginTopTwips: number | null;
    marginBottomTwips: number | null;
    marginLeftTwips: number | null;
    marginRightTwips: number | null;
    sectionCount: number;
  } | null;
  styleIds: string[];
  sectionBreakCount: number;
  contentControlCount: number;
  warnings: string[];
}

export interface ExtractedChunk {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  page: number | null;
  paragraphIndex: number | null;
  sheet: string | null;
  slide: number | null;
  startOffset: number | null;
  endOffset: number | null;
  headingPath: string | null;
}

export type FactCategory = 'date' | 'number' | 'money' | 'percent' | 'name' | 'organization' | 'statement';

export interface FactCandidate {
  chunkId: string;
  text: string;
  category: FactCategory;
  subject: string | null;
  value: string | null;
  normalizedValue: string | null;
  page: number | null;
  paragraphIndex: number | null;
  confidence: number;
}

export interface FactConflict {
  key: string;
  label: string;
  values: Array<{
    value: string;
    documentId: string;
    documentName: string;
    chunkId: string;
    page: number | null;
  }>;
}

export interface MappingResult {
  sectionKey: string;
  purpose: string;
  requirements: string[];
  evidenceChunkIds: string[];
  gaps: string[];
  conflicts: FactConflict[];
  contentPlan: string[];
  coverage: 'strong' | 'partial' | 'none';
  producedBy: 'heuristic' | 'ai';
}

export interface GeneratedSectionPayload {
  body: string;
  citedChunkIds: string[];
  warnings: string[];
  placeholders: string[];
  wordCount: number;
}

export interface FidelityReport {
  templateHeadings: number;
  outputHeadings: number;
  templateTables: number;
  outputTables: number;
  templateImages: number;
  outputImages: number;
  templateStylesPreserved: boolean;
  headersPreserved: boolean;
  footersPreserved: boolean;
  insertedParagraphs: number;
  replacedPlaceholders: number;
  warnings: string[];
  passed: boolean;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}
