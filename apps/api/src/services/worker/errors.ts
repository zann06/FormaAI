/** Error type used inside the job runtime to preserve a machine-readable code. */
export class ApiErrorWithCode extends Error {
  constructor(
    readonly code: string,
    message: string,
    /**
     * Structured context kept for the UI (for example, the per-step report of a
     * failed pipeline run). Stored on the job row as `result` when the job fails
     * so the client can explain what failed without re-deriving it.
     */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiErrorWithCode';
  }
}
