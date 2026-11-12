import { AnthropicAdapter } from './anthropic.js';
import { DevOfflineAdapter } from './dev-offline.js';
import { GeminiAdapter } from './gemini.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type ConnectionTestResult,
  type ProviderAdapter,
  type ProviderConfig,
  type UsageMetadata,
} from './types.js';

export * from './types.js';
export { OpenAICompatibleAdapter } from './openai-compatible.js';
export { AnthropicAdapter } from './anthropic.js';
export { GeminiAdapter } from './gemini.js';
export { DevOfflineAdapter } from './dev-offline.js';

export interface ProviderRegistryOptions {
  timeoutMs?: number;
  enableDevProvider?: boolean;
  devResponder?: (request: CompletionRequest) => string;
}

export class ProviderRegistry {
  private readonly adapters: Map<string, ProviderAdapter> = new Map();

  constructor(options: ProviderRegistryOptions = {}) {
    const timeout = options.timeoutMs ?? 90_000;
    this.adapters.set('openai-compatible', new OpenAICompatibleAdapter(timeout));
    this.adapters.set('anthropic', new AnthropicAdapter(timeout));
    this.adapters.set('gemini', new GeminiAdapter(timeout));
    if (options.enableDevProvider) {
      this.adapters.set('dev-offline', new DevOfflineAdapter(options.devResponder));
    }
  }

  get(type: string): ProviderAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new ProviderError(
        `The provider type "${type}" is not enabled on this instance.`,
        'UNSUPPORTED',
      );
    }
    return adapter;
  }

  supports(type: string): boolean {
    return this.adapters.has(type);
  }

  list(): string[] {
    return Array.from(this.adapters.keys());
  }
}

export interface CompleteWithFallbackOptions {
  registry: ProviderRegistry;
  primary: ProviderConfig & { id: string };
  fallback?: (ProviderConfig & { id: string }) | null;
  request: CompletionRequest;
  /**
   * Called with the credential id actually used, for usage logging.
   *
   * On success the fourth argument carries the token counts the provider
   * reported. They must be forwarded here: usage logging has no other way to see
   * them, and dropping them made every request record 0 input / 0 output tokens
   * even though the call had clearly produced a completion.
   */
  onAttempt?: (
    credentialId: string,
    outcome: 'success' | 'failure',
    error?: ProviderError,
    usage?: UsageMetadata,
  ) => Promise<void> | void;
}

export interface CompleteWithFallbackResult {
  result: CompletionResult;
  usedCredentialId: string;
  fellBack: boolean;
  firstError?: { code: string; message: string };
}

/**
 * Runs a completion against the requesting user's primary credential and, only
 * if that user explicitly configured a fallback credential, retries once with it.
 * There is no platform-wide key and no cross-user lookup anywhere in this path.
 */
export async function completeWithFallback(
  options: CompleteWithFallbackOptions,
): Promise<CompleteWithFallbackResult> {
  const { registry, primary, fallback, request, onAttempt } = options;
  let firstError: ProviderError | undefined;
  try {
    const result = await withRetry(() => registry.get(primary.providerType).complete(primary, request));
    await onAttempt?.(primary.id, 'success', undefined, result.usage);
    return { result, usedCredentialId: primary.id, fellBack: false };
  } catch (error) {
    firstError = error instanceof ProviderError ? error : new ProviderError((error as Error).message, 'PROVIDER_ERROR');
    await onAttempt?.(primary.id, 'failure', firstError);
    if (!fallback) throw firstError;
  }
  try {
    const result = await withRetry(() => registry.get(fallback!.providerType).complete(fallback!, request));
    await onAttempt?.(fallback!.id, 'success', undefined, result.usage);
    return {
      result,
      usedCredentialId: fallback!.id,
      fellBack: true,
      firstError: { code: firstError!.code, message: firstError!.message },
    };
  } catch (error) {
    const fallbackError =
      error instanceof ProviderError ? error : new ProviderError((error as Error).message, 'PROVIDER_ERROR');
    await onAttempt?.(fallback!.id, 'failure', fallbackError);
    throw new ProviderError(
      `Primary provider failed (${firstError!.code}) and the configured fallback also failed (${fallbackError.code}): ${fallbackError.message}`,
      fallbackError.code,
      fallbackError.status,
    );
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ProviderError && error.retryable && error.code !== 'TIMEOUT';
      if (!retryable || attempt === attempts - 1) throw error;
      await sleep(750 * (attempt + 1));
    }
  }
  throw lastError;
}
