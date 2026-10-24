/** Error crossing a module boundary. On the wire: `{ error: code, message, ...details }`; `details` never holds secrets. */
export class AppError extends Error {
  // Fields, not constructor parameter properties, which Node's type stripping rejects (erasableSyntaxOnly).
  readonly status: number
  readonly code: string
  readonly details?: Readonly<Record<string, unknown>>

  constructor(status: number, code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
    this.name = 'AppError'
  }
}
