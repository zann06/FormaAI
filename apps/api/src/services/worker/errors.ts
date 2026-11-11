/** Error type used inside the job runtime to preserve a machine-readable code. */
export class ApiErrorWithCode extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiErrorWithCode';
  }
}
