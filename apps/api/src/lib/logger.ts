import type { FastifyBaseLogger } from 'fastify';

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{10,}/g, '[REDACTED_KEY]'],
  [/Bearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer [REDACTED]'],
  [/(x-api-key|x-goog-api-key|authorization)["']?\s*[:=]\s*["']?[^"'\s,}]{6,}/gi, '$1: [REDACTED]'],
];

export function redactString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Structured logger wrapper that forbids document contents by default. */
export class SafeLogger {
  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly allowDocumentContent = false,
  ) {}

  private sanitize(context: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context)) {
      if (typeof value === 'string') {
        out[key] = redactString(value);
      } else if (value instanceof Error) {
        out[key] = { name: value.name, message: redactString(value.message) };
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  info(message: string, context: Record<string, unknown> = {}): void {
    this.logger.info(this.sanitize(context), message);
  }

  warn(message: string, context: Record<string, unknown> = {}): void {
    this.logger.warn(this.sanitize(context), message);
  }

  error(message: string, context: Record<string, unknown> = {}): void {
    this.logger.error(this.sanitize(context), message);
  }

  debug(message: string, context: Record<string, unknown> = {}): void {
    this.logger.debug(this.sanitize(context), message);
  }

  documentPreview(text: string, max = 200): string | null {
    if (!this.allowDocumentContent) return null;
    return redactString(text.slice(0, max));
  }
}
