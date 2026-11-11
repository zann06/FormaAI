import type { ReactNode } from 'react';
import type { Coverage, DocumentStatus, JobStatus, ProjectStatus, SectionStatus } from '../lib/types';

type Tone = 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'purple';

const TONES: Record<Tone, string> = {
  neutral: 'bg-ink-100 text-ink-700',
  blue: 'bg-brand-50 text-brand-700',
  green: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-800',
  red: 'bg-red-50 text-red-700',
  purple: 'bg-violet-50 text-violet-700',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${TONES[tone]}`}>{children}</span>;
}

const PROJECT_TONE: Record<ProjectStatus, Tone> = {
  draft: 'neutral',
  processing: 'blue',
  needs_review: 'amber',
  ready: 'green',
  failed: 'red',
  archived: 'neutral',
};

const PROJECT_LABEL: Record<ProjectStatus, string> = {
  draft: 'Draft',
  processing: 'Processing',
  needs_review: 'Needs review',
  ready: 'Ready',
  failed: 'Failed',
  archived: 'Archived',
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return <Badge tone={PROJECT_TONE[status]}>{PROJECT_LABEL[status]}</Badge>;
}

const DOCUMENT_TONE: Record<DocumentStatus, Tone> = {
  uploaded: 'neutral',
  queued: 'blue',
  extracting: 'blue',
  extracted: 'green',
  failed: 'red',
};

const DOCUMENT_LABEL: Record<DocumentStatus, string> = {
  uploaded: 'Uploaded',
  queued: 'Queued',
  extracting: 'Extracting…',
  extracted: 'Extracted',
  failed: 'Failed',
};

export function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  return <Badge tone={DOCUMENT_TONE[status]}>{DOCUMENT_LABEL[status]}</Badge>;
}

const SECTION_TONE: Record<SectionStatus, Tone> = {
  empty: 'neutral',
  draft: 'blue',
  needs_review: 'amber',
  validated: 'green',
  final: 'green',
};

const SECTION_LABEL: Record<SectionStatus, string> = {
  empty: 'Empty',
  draft: 'Draft',
  needs_review: 'Needs review',
  validated: 'Validated',
  final: 'Final',
};

export function SectionStatusBadge({ status }: { status: SectionStatus }) {
  return <Badge tone={SECTION_TONE[status]}>{SECTION_LABEL[status]}</Badge>;
}

const JOB_TONE: Record<JobStatus, Tone> = {
  queued: 'neutral',
  running: 'blue',
  succeeded: 'green',
  failed: 'red',
  cancelled: 'neutral',
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <Badge tone={JOB_TONE[status]}>{status[0]!.toUpperCase() + status.slice(1)}</Badge>;
}

const COVERAGE_TONE: Record<Coverage, Tone> = {
  strong: 'green',
  partial: 'amber',
  none: 'red',
};

const COVERAGE_LABEL: Record<Coverage, string> = {
  strong: 'Strong coverage',
  partial: 'Partial coverage',
  none: 'No evidence',
};

export function CoverageBadge({ coverage }: { coverage: Coverage }) {
  return <Badge tone={COVERAGE_TONE[coverage]}>{COVERAGE_LABEL[coverage]}</Badge>;
}
