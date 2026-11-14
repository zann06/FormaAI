import type { ProviderType } from '@formaai/shared';

/**
 * One block of a multi-modal message.
 *
 * Reports are built from screenshots — a Packet Tracer canvas, a CLI capture, a
 * photographed topology — and the OCR text of those is exactly where a section
 * ends up with `[PERLU DICEK]`. Letting a request carry the pixels alongside the
 * text is what allows a model to read the value the OCR missed, instead of only
 * seeing the OCR's guess.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; base64: string };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /**
   * Plain text for ordinary prompts, or content parts when an image has to travel
   * with the instruction. Every adapter accepts both, so callers do not have to
   * know which provider will serve the request.
   */
  content: string | ContentPart[];
}

/** Concatenated text of a message, for logging and for adapters without vision. */
export function messageText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** True when a message carries at least one image. */
export function hasImage(content: string | ContentPart[]): boolean {
  return typeof content !== 'string' && content.some((part) => part.type === 'image');
}

export interface ProviderConfig {
  providerType: ProviderType;
  baseUrl: string;
  model: string;
  apiKey: string;
  requestSettings?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    extraHeaders?: Record<string, string>;
    apiVersion?: string;
  };
}

export interface CompletionRequest {
  messages: ChatMessage[];
  jsonSchema?: JsonSchemaSpec;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface JsonSchemaSpec {
  name: string;
  /** JSON Schema (draft-07 subset) describing the expected object. */
  schema: Record<string, unknown>;
  description?: string;
}

export interface UsageMetadata {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  usage: UsageMetadata;
  finishReason?: string;
  durationMs: number;
  raw?: unknown;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  model?: string;
  latencyMs?: number;
  /** Some providers allow listing models; only populated when actually returned. */
  models?: string[];
}

export interface ProviderAdapter {
  readonly type: ProviderType;
  complete(config: ProviderConfig, request: CompletionRequest): Promise<CompletionResult>;
  testConnection(config: ProviderConfig): Promise<ConnectionTestResult>;
}

export type ProviderErrorCode =
  | 'INVALID_CONFIG'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'PROVIDER_ERROR'
  | 'UNSUPPORTED'
  | 'INVALID_RESPONSE'
  | 'ABORTED';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: ProviderErrorCode,
    readonly status?: number,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Remove anything that looks like a secret from provider payloads before logging/returning. */
export function redactSecrets(input: string, secrets: string[] = []): string {
  let output = input;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    output = output.split(secret).join('[REDACTED]');
  }
  return output
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/("?(?:api[_-]?key|authorization|x-api-key|x-goog-api-key)"?\s*[:=]\s*"?)([^"\s,}]{6,})/gi, '$1[REDACTED]');
}

export function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(new Error('aborted'));
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(new Error('aborted'));
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (externalSignal?.aborted) throw new ProviderError('The request was cancelled', 'ABORTED');
    if ((error as Error).name === 'AbortError') {
      throw new ProviderError(`Provider request timed out after ${timeoutMs} ms`, 'TIMEOUT', undefined, true);
    }
    throw new ProviderError(
      `Could not reach the provider endpoint: ${(error as Error).message}`,
      'NETWORK_ERROR',
      undefined,
      true,
    );
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', onAbort);
  }
}

export async function parseErrorResponse(response: Response, apiKey: string): Promise<ProviderError> {
  let bodyText = '';
  try {
    bodyText = (await response.text()).slice(0, 2000);
  } catch {
    bodyText = '';
  }
  const safeBody = redactSecrets(bodyText, [apiKey]);
  if (response.status === 401 || response.status === 403) {
    return new ProviderError(
      `The provider rejected the API key (HTTP ${response.status}). Check the key and permissions.`,
      'AUTH_FAILED',
      response.status,
    );
  }
  if (response.status === 429) {
    return new ProviderError(
      'The provider rate-limited this request (HTTP 429). Wait and retry, or pick another model.',
      'RATE_LIMITED',
      response.status,
      true,
    );
  }
  if (response.status === 404) {
    return new ProviderError(
      `Endpoint or model not found (HTTP 404). Check the Base URL and model ID. Provider says: ${safeBody}`,
      'PROVIDER_ERROR',
      response.status,
    );
  }
  if (response.status >= 500) {
    return new ProviderError(
      `The provider returned a server error (HTTP ${response.status}). Provider says: ${safeBody}`,
      'PROVIDER_ERROR',
      response.status,
      true,
    );
  }
  return new ProviderError(
    `The provider rejected the request (HTTP ${response.status}). Provider says: ${safeBody}`,
    'PROVIDER_ERROR',
    response.status,
  );
}
