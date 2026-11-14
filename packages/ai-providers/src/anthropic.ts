import {
  fetchWithTimeout,
  messageText,
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
const ANTHROPIC_VERSION = '2023-06-01';

interface MessagesResponse {
  id?: string;
  model?: string;
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Anthropic Messages API adapter. Structured output is implemented with a
 * forced tool call, which is Anthropic's supported way of constraining output.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly type = 'anthropic' as const;

  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async complete(config: ProviderConfig, request: CompletionRequest): Promise<CompletionResult> {
    const baseUrl = normalizeBaseUrl(config.baseUrl) || 'https://api.anthropic.com';
    const version = config.requestSettings?.apiVersion ?? ANTHROPIC_VERSION;
    const started = Date.now();

    const systemParts = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => messageText(m.content));
    // Anthropic expects images as `image` blocks with a base64 source, positioned
    // before the text that refers to them. Text-only messages stay a plain string.
    const conversation = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content.map((part) =>
                part.type === 'text'
                  ? { type: 'text', text: part.text }
                  : {
                      type: 'image',
                      source: { type: 'base64', media_type: part.mediaType, data: part.base64 },
                    },
              ),
      }));

    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: request.maxTokens ?? config.requestSettings?.maxTokens ?? 2048,
      temperature: request.temperature ?? config.requestSettings?.temperature ?? 0.2,
      messages: conversation,
    };
    if (systemParts.length) body.system = systemParts.join('\n\n');
    if (request.jsonSchema) {
      body.tools = [
        {
          name: request.jsonSchema.name,
          description: request.jsonSchema.description ?? 'Return the structured result using this tool.',
          input_schema: request.jsonSchema.schema,
        },
      ];
      body.tool_choice = { type: 'tool', name: request.jsonSchema.name };
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': version,
      ...(config.requestSettings?.extraHeaders ?? {}),
    };

    const response = await fetchWithTimeout(
      `${baseUrl}/v1/messages`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      this.timeoutMs,
      request.signal,
    );
    if (!response.ok) throw await parseErrorResponse(response, config.apiKey);

    const json = (await response.json().catch(() => null)) as MessagesResponse | null;
    if (!json) throw new ProviderError('Anthropic returned a non-JSON response', 'INVALID_RESPONSE');

    let text = '';
    const toolUse = json.content?.find((c) => c.type === 'tool_use');
    if (toolUse && request.jsonSchema) {
      text = JSON.stringify(toolUse.input ?? {});
    } else {
      text = (json.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text!)
        .join('');
    }
    if (!text) throw new ProviderError('Anthropic returned an empty message', 'INVALID_RESPONSE');

    return {
      text,
      model: json.model ?? config.model,
      usage: {
        inputTokens: json.usage?.input_tokens,
        outputTokens: json.usage?.output_tokens,
        totalTokens:
          json.usage?.input_tokens !== undefined && json.usage?.output_tokens !== undefined
            ? json.usage.input_tokens + json.usage.output_tokens
            : undefined,
      },
      finishReason: json.stop_reason,
      durationMs: Date.now() - started,
    };
  }

  async testConnection(config: ProviderConfig): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const result = await this.complete(
        { ...config, requestSettings: { ...config.requestSettings, maxTokens: 16 } },
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
        message: `Connected to "${result.model}". Reply: ${redactSecrets(result.text.slice(0, 40), [config.apiKey])}`,
        model: result.model,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof ProviderError) return { ok: false, message: `${error.code}: ${error.message}` };
      return { ok: false, message: `Unexpected error: ${(error as Error).message}` };
    }
  }
}
