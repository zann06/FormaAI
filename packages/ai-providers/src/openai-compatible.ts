import {
  fetchWithTimeout,
  normalizeBaseUrl,
  parseErrorResponse,
  ProviderError,
  redactSecrets,
  type CompletionRequest,
  type CompletionResult,
  type ConnectionTestResult,
  type ProviderAdapter,
  type ProviderConfig,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 90_000;

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { role?: string; content?: string | Array<{ type: string; text?: string }> | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

/**
 * Adapter for any server exposing the OpenAI Chat Completions API
 * (`POST {baseUrl}/chat/completions`). This covers OpenAI, DeepSeek, Qwen
 * (DashScope compatible mode), GLM, OpenRouter, Groq, Together, Mistral,
 * LM Studio, Ollama (OpenAI mode), vLLM and any custom gateway.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const;

  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async complete(config: ProviderConfig, request: CompletionRequest): Promise<CompletionResult> {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    if (!baseUrl) throw new ProviderError('Base URL is required', 'INVALID_CONFIG');
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: config.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: request.temperature ?? config.requestSettings?.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? config.requestSettings?.maxTokens,
      stream: false,
    };
    if (body.max_tokens === undefined) delete body.max_tokens;
    if (config.requestSettings?.topP !== undefined) body.top_p = config.requestSettings.topP;
    if (request.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.jsonSchema.name,
          strict: false,
          schema: request.jsonSchema.schema,
        },
      };
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
      ...(config.requestSettings?.extraHeaders ?? {}),
    };

    const response = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      this.timeoutMs,
      request.signal,
    );

    if (!response.ok) {
      const fallbackWorthy =
        response.status === 400 || response.status === 422 ? await this.retryWithoutJsonSchema(baseUrl, headers, body, request, config) : null;
      if (fallbackWorthy) return fallbackWorthy;
      throw await parseErrorResponse(response, config.apiKey);
    }

    const json = (await response.json().catch(() => null)) as ChatCompletionResponse | null;
    if (!json) throw new ProviderError('The provider returned a non-JSON response', 'INVALID_RESPONSE');
    if (json.error) {
      throw new ProviderError(
        `Provider error: ${redactSecrets(json.error.message ?? 'unknown', [config.apiKey])}`,
        'PROVIDER_ERROR',
      );
    }
    const choice = json.choices?.[0];
    const text = extractContent(choice?.message?.content);
    if (typeof text !== 'string') {
      throw new ProviderError('The provider response contained no message content', 'INVALID_RESPONSE');
    }
    return {
      text,
      model: json.model ?? config.model,
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
        totalTokens: json.usage?.total_tokens,
      },
      finishReason: choice?.finish_reason,
      durationMs: Date.now() - started,
    };
  }

  /** Some OpenAI-compatible servers do not accept `response_format: json_schema`. */
  private async retryWithoutJsonSchema(
    baseUrl: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    request: CompletionRequest,
    config: ProviderConfig,
  ): Promise<CompletionResult | null> {
    if (!request.jsonSchema) return null;
    const started = Date.now();
    const cloned: Record<string, unknown> = { ...body, response_format: { type: 'json_object' } };
    const retry = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      { method: 'POST', headers, body: JSON.stringify(cloned) },
      this.timeoutMs,
      request.signal,
    );
    if (!retry.ok) return null;
    const json = (await retry.json().catch(() => null)) as ChatCompletionResponse | null;
    const text = extractContent(json?.choices?.[0]?.message?.content);
    if (typeof text !== 'string') return null;
    return {
      text,
      model: json?.model ?? config.model,
      usage: {
        inputTokens: json?.usage?.prompt_tokens,
        outputTokens: json?.usage?.completion_tokens,
        totalTokens: json?.usage?.total_tokens,
      },
      finishReason: json?.choices?.[0]?.finish_reason,
      durationMs: Date.now() - started,
    };
  }

  async testConnection(config: ProviderConfig): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const result = await this.complete(
        { ...config, requestSettings: { ...config.requestSettings, maxTokens: 16, temperature: 0 } },
        {
          messages: [
            { role: 'system', content: 'You are a connectivity probe. Reply with exactly: OK' },
            { role: 'user', content: 'Reply with OK' },
          ],
          maxTokens: 16,
        },
      );
      return {
        ok: true,
        message: `Connected to "${result.model}". Reply: ${result.text.slice(0, 40)}`,
        model: result.model,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return failure(error);
    }
  }
}

function failure(error: unknown): ConnectionTestResult {
  if (error instanceof ProviderError) return { ok: false, message: `${error.code}: ${error.message}` };
  return { ok: false, message: `Unexpected error: ${(error as Error).message}` };
}

function extractContent(content: string | Array<{ type: string; text?: string }> | null | undefined): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return null;
}
