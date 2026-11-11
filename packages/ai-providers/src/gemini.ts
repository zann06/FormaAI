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

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: unknown }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { message?: string; status?: string };
}

function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  // Gemini accepts an OpenAPI-ish subset; strip unsupported keywords defensively.
  const allowed = new Set([
    'type',
    'format',
    'description',
    'nullable',
    'enum',
    'items',
    'properties',
    'required',
    'minItems',
    'maxItems',
    'minimum',
    'maximum',
    'propertyOrdering',
    'title',
  ]);
  if (Array.isArray(schema)) return schema.map(toGeminiSchema) as unknown as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!allowed.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(value as Record<string, unknown>)) {
        props[propKey] = toGeminiSchema(propValue as Record<string, unknown>);
      }
      output.properties = props;
    } else if (key === 'items' && value && typeof value === 'object') {
      output.items = toGeminiSchema(value as Record<string, unknown>);
    } else {
      output[key] = value;
    }
  }
  // Gemini requires an uppercase type
  if (typeof output.type === 'string') output.type = output.type.toUpperCase();
  return output;
}

/** Google Gemini `generateContent` adapter (API key auth via header). */
export class GeminiAdapter implements ProviderAdapter {
  readonly type = 'gemini' as const;

  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async complete(config: ProviderConfig, request: CompletionRequest): Promise<CompletionResult> {
    const baseUrl = normalizeBaseUrl(config.baseUrl) || 'https://generativelanguage.googleapis.com';
    const started = Date.now();
    const version = config.requestSettings?.apiVersion ?? 'v1beta';

    const systemParts = request.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const contents = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: request.temperature ?? config.requestSettings?.temperature ?? 0.2,
        maxOutputTokens: request.maxTokens ?? config.requestSettings?.maxTokens ?? 2048,
      },
    };
    if (systemParts.length) body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
    if (request.jsonSchema) {
      (body.generationConfig as Record<string, unknown>).responseMimeType = 'application/json';
      (body.generationConfig as Record<string, unknown>).responseSchema = toGeminiSchema(request.jsonSchema.schema);
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-goog-api-key': config.apiKey,
      ...(config.requestSettings?.extraHeaders ?? {}),
    };

    const url = `${baseUrl}/${version}/models/${encodeURIComponent(config.model)}:generateContent`;
    const response = await fetchWithTimeout(
      url,
      { method: 'POST', headers, body: JSON.stringify(body) },
      this.timeoutMs,
      request.signal,
    );
    if (!response.ok) throw await parseErrorResponse(response, config.apiKey);

    const json = (await response.json().catch(() => null)) as GeminiResponse | null;
    if (!json) throw new ProviderError('Gemini returned a non-JSON response', 'INVALID_RESPONSE');
    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    if (!text) {
      throw new ProviderError(
        'Gemini returned no text (the prompt may have been blocked by safety filters)',
        'INVALID_RESPONSE',
      );
    }
    return {
      text,
      model: config.model,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount,
        outputTokens: json.usageMetadata?.candidatesTokenCount,
        totalTokens: json.usageMetadata?.totalTokenCount,
      },
      finishReason: candidate?.finishReason,
      durationMs: Date.now() - started,
    };
  }

  async testConnection(config: ProviderConfig): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const result = await this.complete(
        { ...config, requestSettings: { ...config.requestSettings, maxTokens: 32 } },
        {
          messages: [
            { role: 'system', content: 'You are a connectivity probe. Reply with exactly: OK' },
            { role: 'user', content: 'Reply with OK' },
          ],
          maxTokens: 32,
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
