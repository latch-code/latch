/** Error crossing a module boundary. On the wire: `{ error: code, message, ...details }`; `details` never holds secrets. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'AppError'
  }
}
