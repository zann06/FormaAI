/**
 * Typed browser client for the FormaAI API.
 *
 * Every call goes to same-origin `/api/...` so the session cookie is first-party
 * and we never need CORS. Errors are normalised into `ApiError`, which carries
 * the server's error code so the UI can react to specific failures (for example
 * `PDF_CONVERTER_NOT_CONFIGURED` or `RATE_LIMITED`) instead of guessing.
 */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when retrying the same request could plausibly succeed. */
  get isTransient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

async function parseError(response: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  const code = body?.error?.code ?? `HTTP_${response.status}`;
  const message =
    body?.error?.message ??
    (response.status === 0 ? 'The server could not be reached.' : `Request failed (${response.status}).`);
  return new ApiError(response.status, code, message, body?.error?.details);
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  const init: RequestInit = { method, credentials: 'same-origin' };
  // Only declare a JSON content type when there is actually a JSON body. Sending
  // `content-type: application/json` with an empty body makes Fastify reject the
  // request ("Body cannot be empty when content-type is set to
  // 'application/json'"), which broke every bodyless POST/DELETE.
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return init;
}

export const api = {
  get: <T>(path: string) =>
    fetch(path, { credentials: 'same-origin' }).then((r) => handle<T>(r)),

  post: <T>(path: string, body?: unknown) =>
    fetch(path, jsonInit('POST', body)).then((r) => handle<T>(r)),

  patch: <T>(path: string, body?: unknown) =>
    fetch(path, jsonInit('PATCH', body)).then((r) => handle<T>(r)),

  del: <T>(path: string, body?: unknown) =>
    fetch(path, jsonInit('DELETE', body)).then((r) => handle<T>(r)),

  /** Uploads one file as multipart/form-data (kind selects template vs source). */
  async upload<T>(path: string, file: File, kind?: 'template' | 'source'): Promise<T> {
    const form = new FormData();
    if (kind) form.append('kind', kind);
    form.append('file', file, file.name);
    const response = await fetch(path, { method: 'POST', body: form, credentials: 'same-origin' });
    return handle<T>(response);
  },

  /**
   * Downloads a binary response and hands it to the browser as a save prompt.
   * Filenames come from `content-disposition`; falls back to `fallback`.
   */
  async download(path: string, fallbackName: string): Promise<void> {
    const response = await fetch(path, { credentials: 'same-origin' });
    if (!response.ok) throw await parseError(response);
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const name = match?.[1] ? decodeURIComponent(match[1]) : fallbackName;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoke on the next tick so Safari has time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

/** Human-readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
