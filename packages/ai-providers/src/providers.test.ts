import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AnthropicAdapter,
  GeminiAdapter,
  OpenAICompatibleAdapter,
  ProviderError,
  ProviderRegistry,
  completeWithFallback,
  redactSecrets,
  type ProviderConfig,
} from '../src/index.js';

interface Recorded {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

let server: Server;
let baseUrl: string;
const requests: Recorded[] = [];
const behaviour = {
  mode: 'ok' as 'ok' | 'auth' | 'rate' | 'server' | 'no-json-schema' | 'fail-once',
  failures: 0,
};

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: req.url ?? '', method: req.method ?? '', headers: req.headers as Record<string, string>, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url?.includes('chat/completions')) {
        if (req.headers.authorization !== 'Bearer test-key-123') {
          return send(401, { error: { message: 'Invalid API key: sk-abcdef123456789' } });
        }
        if (behaviour.mode === 'rate') return send(429, { error: { message: 'rate limited' } });
        if (behaviour.mode === 'server') return send(500, { error: { message: 'boom' } });
        if (behaviour.mode === 'fail-once' && behaviour.failures++ === 0) return send(500, { error: { message: 'flaky' } });
        if (behaviour.mode === 'no-json-schema' && body.response_format?.type === 'json_schema') {
          return send(400, { error: { message: 'response_format json_schema not supported' } });
        }
        return send(200, {
          model: body.model,
          choices: [{ message: { role: 'assistant', content: body.response_format ? '{"hello":"world"}' : 'OK pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        });
      }
      if (req.url?.includes('/v1/messages')) {
        if (req.headers['x-api-key'] !== 'anthropic-key') {
          return send(401, { error: { message: 'invalid x-api-key' } });
        }
        const toolName = body.tools?.[0]?.name;
        return send(200, {
          model: body.model,
          content: toolName
            ? [{ type: 'tool_use', name: toolName, input: { structured: true } }]
            : [{ type: 'text', text: 'anthropic pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 5 },
        });
      }
      if (req.url?.includes(':generateContent')) {
        if (req.headers['x-goog-api-key'] !== 'gemini-key') {
          return send(400, { error: { message: 'API key not valid', status: 'INVALID_ARGUMENT' } });
        }
        return send(200, {
          candidates: [{ content: { parts: [{ text: body.generationConfig?.responseMimeType ? '{"ok":true}' : 'gemini pong' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 },
        });
      }
      send(404, { error: { message: 'not found' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (typeof address === 'object' && address) baseUrl = `http://127.0.0.1:${address.port}`;
});

const openaiConfig = (): ProviderConfig => live().openai;

/**
 * `baseUrl` is assigned in `beforeAll`, which runs after module evaluation.
 * Provider configs are therefore resolved lazily through this helper.
 */
function live() {
  return {
    openai: {
      providerType: 'openai-compatible' as const,
      baseUrl,
      model: 'test-model',
      apiKey: 'test-key-123',
    },
    anthropicConfig: {
      providerType: 'anthropic' as const,
      baseUrl,
      model: 'claude-test',
      apiKey: 'anthropic-key',
    },
    geminiConfig: {
      providerType: 'gemini' as const,
      baseUrl,
      model: 'gemini-test',
      apiKey: 'gemini-key',
    },
  };
}

describe('OpenAI-compatible adapter', () => {
  beforeAll(() => {
    behaviour.mode = 'ok';
    behaviour.failures = 0;
    requests.length = 0;
  });

  it('sends a chat completion request and parses text + usage', async () => {
    const adapter = new OpenAICompatibleAdapter(5000);
    const result = await adapter.complete(openaiConfig(), {
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'ping' },
      ],
    });
    expect(result.text).toBe('OK pong');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    const sent = requests.at(-1)!;
    expect(sent.path).toBe('/chat/completions');
    expect(sent.headers.authorization).toBe('Bearer test-key-123');
    expect(sent.body.messages[0]).toEqual({ role: 'system', content: 'be terse' });
  });

  it('supports a custom Base URL with a path prefix', async () => {
    const adapter = new OpenAICompatibleAdapter(5000);
    await adapter.complete({ ...openaiConfig(), baseUrl: `${baseUrl}/v1/` }, { messages: [{ role: 'user', content: 'x' }] });
    expect(requests.at(-1)!.path).toBe('/v1/chat/completions');
  });

  it('requests JSON schema output', async () => {
    const adapter = new OpenAICompatibleAdapter(5000);
    const result = await adapter.complete(openaiConfig(), {
      messages: [{ role: 'user', content: 'json' }],
      jsonSchema: { name: 'thing', schema: { type: 'object', properties: { hello: { type: 'string' } } } },
    });
    expect(JSON.parse(result.text)).toEqual({ hello: 'world' });
    expect(requests.at(-1)!.body.response_format.type).toBe('json_schema');
  });

  it('falls back to json_object when the server rejects json_schema', async () => {
    behaviour.mode = 'no-json-schema';
    const adapter = new OpenAICompatibleAdapter(5000);
    const result = await adapter.complete(openaiConfig(), {
      messages: [{ role: 'user', content: 'json' }],
      jsonSchema: { name: 'thing', schema: { type: 'object' } },
    });
    expect(result.text).toBe('{"hello":"world"}');
    behaviour.mode = 'ok';
  });

  it('normalises auth errors without leaking the key', async () => {
    const adapter = new OpenAICompatibleAdapter(5000);
    await expect(
      adapter.complete({ ...openaiConfig(), apiKey: 'wrong-key-999' }, { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    try {
      await adapter.complete({ ...openaiConfig(), apiKey: 'wrong-key-999' }, { messages: [{ role: 'user', content: 'x' }] });
    } catch (error) {
      expect((error as ProviderError).message).not.toContain('sk-abcdef');
    }
  });

  it('normalises rate limit and server errors', async () => {
    const adapter = new OpenAICompatibleAdapter(5000);
    behaviour.mode = 'rate';
    await expect(adapter.complete(openaiConfig(), { messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    behaviour.mode = 'server';
    await expect(adapter.complete(openaiConfig(), { messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    behaviour.mode = 'ok';
  });

  it('reports connection test success and failure', async () => {
    const adapter = new OpenAICompatibleAdapter(5000);
    const ok = await adapter.testConnection(openaiConfig());
    expect(ok.ok).toBe(true);
    const bad = await adapter.testConnection({ ...openaiConfig(), apiKey: 'nope-nope' });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('AUTH_FAILED');
  });
});

describe('Anthropic adapter', () => {
  const config = (): ProviderConfig => ({
    providerType: 'anthropic',
    baseUrl,
    model: 'claude-test',
    apiKey: 'anthropic-key',
  });

  it('uses the messages API with x-api-key and anthropic-version', async () => {
    const adapter = new AnthropicAdapter(5000);
    const result = await adapter.complete(live().anthropicConfig, { messages: [{ role: 'user', content: 'ping' }] });
    expect(result.text).toBe('anthropic pong');
    const sent = requests.at(-1)!;
    expect(sent.path).toBe('/v1/messages');
    expect(sent.headers['x-api-key']).toBe('anthropic-key');
    expect(sent.headers['anthropic-version']).toBeDefined();
    expect(result.usage.inputTokens).toBe(20);
  });

  it('implements structured output through forced tool use', async () => {
    const adapter = new AnthropicAdapter(5000);
    const result = await adapter.complete(live().anthropicConfig, {
      messages: [{ role: 'user', content: 'json' }],
      jsonSchema: { name: 'section_draft', schema: { type: 'object' } },
    });
    expect(JSON.parse(result.text)).toEqual({ structured: true });
    expect(requests.at(-1)!.body.tool_choice).toEqual({ type: 'tool', name: 'section_draft' });
  });

  it('fails with AUTH_FAILED for a bad key', async () => {
    const adapter = new AnthropicAdapter(5000);
    await expect(adapter.testConnection({ ...live().anthropicConfig, apiKey: 'bad' })).resolves.toMatchObject({ ok: false });
  });
});

describe('Gemini adapter', () => {

  it('calls generateContent with the key in a header', async () => {
    const adapter = new GeminiAdapter(5000);
    const result = await adapter.complete(live().geminiConfig, { messages: [{ role: 'user', content: 'ping' }] });
    expect(result.text).toBe('gemini pong');
    const sent = requests.at(-1)!;
    expect(sent.path).toContain('/v1beta/models/gemini-test:generateContent');
    expect(sent.headers['x-goog-api-key']).toBe('gemini-key');
  });

  it('maps a JSON schema to a responseSchema', async () => {
    const adapter = new GeminiAdapter(5000);
    const result = await adapter.complete(live().geminiConfig, {
      messages: [{ role: 'user', content: 'json' }],
      jsonSchema: {
        name: 'thing',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      },
    });
    expect(JSON.parse(result.text)).toEqual({ ok: true });
    const sent = requests.at(-1)!;
    expect(sent.body.generationConfig.responseMimeType).toBe('application/json');
    expect(sent.body.generationConfig.responseSchema.type).toBe('OBJECT');
    expect(sent.body.generationConfig.responseSchema.additionalProperties).toBeUndefined();
  });
});

describe('ProviderRegistry and fallback', () => {
  const registry = new ProviderRegistry({ timeoutMs: 5000 });

  it('exposes only implemented adapters', () => {
    expect(registry.list()).toEqual(['openai-compatible', 'anthropic', 'gemini']);
    expect(() => registry.get('mystery')).toThrow(ProviderError);
  });

  it('retries a retryable failure once', async () => {
    behaviour.mode = 'fail-once';
    behaviour.failures = 0;
    const result = await completeWithFallback({
      registry,
      primary: { ...openaiConfig(), id: 'cred-1' },
      request: { messages: [{ role: 'user', content: 'x' }] },
    });
    expect(result.result.text).toBe('OK pong');
    expect(result.fellBack).toBe(false);
    behaviour.mode = 'ok';
  });

  it('uses the user-provided fallback credential explicitly and reports it', async () => {
    const attempts: string[] = [];
    const result = await completeWithFallback({
      registry,
      primary: { ...openaiConfig(), apiKey: 'broken-key', id: 'cred-bad' },
      fallback: { ...openaiConfig(), id: 'cred-good' },
      request: { messages: [{ role: 'user', content: 'x' }] },
      onAttempt: (id) => {
        attempts.push(id);
      },
    });
    expect(result.fellBack).toBe(true);
    expect(result.usedCredentialId).toBe('cred-good');
    expect(result.firstError?.code).toBe('AUTH_FAILED');
    expect(attempts).toEqual(['cred-bad', 'cred-good']);
  });

  it('throws a clear error when no fallback exists (never a hidden platform key)', async () => {
    await expect(
      completeWithFallback({
        registry,
        primary: { ...openaiConfig(), apiKey: 'broken-key', id: 'cred-bad' },
        fallback: null,
        request: { messages: [{ role: 'user', content: 'x' }] },
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('dev provider is disabled unless explicitly enabled', async () => {
    expect(registry.supports('dev-offline')).toBe(false);
    const devRegistry = new ProviderRegistry({ enableDevProvider: true });
    expect(devRegistry.supports('dev-offline')).toBe(true);
  });
});

describe('redactSecrets', () => {
  it('removes api keys, bearer tokens and JSON key fields', () => {
    const out = redactSecrets('key=sk-abcdefghijkl mn Bearer abcdefghijklmn {"api_key":"supersecretvalue"}', [
      'supersecretvalue',
    ]);
    expect(out).not.toContain('sk-abcdefghijkl');
    expect(out).not.toContain('abcdefghijklmn');
    expect(out).not.toContain('supersecretvalue');
  });
});

