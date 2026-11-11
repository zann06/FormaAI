/** Maximum accepted upload size per file (overridable server-side via MAX_FILE_MB). */
export const DEFAULT_MAX_FILE_MB = 25;

/** Maximum number of source documents per project. */
export const MAX_DOCUMENTS_PER_PROJECT = 40;

/** Maximum number of projects per user. */
export const MAX_PROJECTS_PER_USER = 100;

/** Maximum total storage per user (bytes). Overridable via USER_STORAGE_QUOTA_MB. */
export const DEFAULT_USER_STORAGE_QUOTA_MB = 1024;

export const SOURCE_EXTENSIONS = ['.pdf', '.docx', '.txt', '.png', '.jpg', '.jpeg'] as const;
export const TEMPLATE_EXTENSIONS = ['.docx'] as const;
export const EXTENSIBLE_SOURCE_EXTENSIONS = ['.xlsx', '.csv', '.pptx'] as const;

/** Source formats that carry no text of their own and therefore require OCR. */
export const IMAGE_SOURCE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;

export function isImageSourceExtension(extension: string): boolean {
  return (IMAGE_SOURCE_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());
}

export const MIME_BY_EXTENSION: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.docx': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/octet-stream',
    'application/zip',
  ],
  '.txt': ['text/plain', 'application/octet-stream', 'text/markdown'],
  '.csv': ['text/csv', 'text/plain', 'application/vnd.ms-excel'],
  '.png': ['image/png', 'application/octet-stream'],
  '.jpg': ['image/jpeg', 'image/jpg', 'application/octet-stream'],
  '.jpeg': ['image/jpeg', 'image/jpg', 'application/octet-stream'],
};

export const PROJECT_STATUSES = ['draft', 'processing', 'needs_review', 'ready', 'failed', 'archived'] as const;

export const DOCUMENT_KINDS = ['template', 'source'] as const;
export const DOCUMENT_STATUSES = ['uploaded', 'queued', 'extracting', 'extracted', 'failed'] as const;

export const JOB_KINDS = [
  'extract_document',
  'analyze_template',
  'map_evidence',
  'generate_section',
  'generate_all',
  'assemble_docx',
  'convert_pdf',
  'cleanup',
] as const;

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;

export const SECTION_STATUSES = ['empty', 'draft', 'needs_review', 'validated', 'final'] as const;

export const INSERTION_STRATEGIES = ['placeholder', 'after_heading', 'manual'] as const;

export const PROVIDER_TYPES = ['openai-compatible', 'anthropic', 'gemini', 'dev-offline'] as const;

export const PROVIDER_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  type: (typeof PROVIDER_TYPES)[number];
  baseUrl: string;
  suggestedModels: string[];
  notes?: string;
}> = [
  {
    id: 'openai',
    label: 'OpenAI',
    type: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    suggestedModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    type: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    suggestedModels: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-flash-1.5'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'qwen',
    label: 'Qwen (DashScope compatible)',
    type: 'openai-compatible',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    suggestedModels: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  },
  {
    id: 'glm',
    label: 'GLM (Zhipu / Z.ai)',
    type: 'openai-compatible',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    suggestedModels: ['glm-4-plus', 'glm-4-flash'],
  },
  {
    id: 'groq',
    label: 'Groq',
    type: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    suggestedModels: ['llama-3.3-70b-versatile'],
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    type: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    suggestedModels: ['llama3.1', 'qwen2.5'],
    notes: 'Any API key value is accepted by Ollama; use a placeholder such as "local".',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    type: 'openai-compatible',
    baseUrl: '',
    suggestedModels: [],
    notes: 'Any server that implements POST {baseUrl}/chat/completions.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    suggestedModels: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    type: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    suggestedModels: ['gemini-2.0-flash', 'gemini-1.5-pro'],
  },
];

export const REPORT_LANGUAGES = ['en', 'id', 'ms', 'es', 'fr', 'de', 'pt', 'ar', 'zh', 'ja'] as const;

export const REPORT_TONES = ['formal', 'academic', 'neutral', 'concise', 'persuasive'] as const;

export const DEFAULT_PLACEHOLDER_OPEN = '{{';
export const DEFAULT_PLACEHOLDER_CLOSE = '}}';
