import type { ErrorCode, ErrorDto } from '@shared/protocol'

/**
 * Domain error carrying a message that is safe to show in the webview.
 *
 * Driver errors are wrapped, never re-thrown raw: PostgreSQL messages can
 * contain connection details and must pass through {@link redactSecrets}.
 */
export class DataForgeError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DataForgeError'
    this.code = code
  }
}

export function isDataForgeError(value: unknown): value is DataForgeError {
  return value instanceof DataForgeError
}

const PASSWORD_ASSIGNMENT = /(password|pwd)\s*=\s*([^\s;&]+)/gi
const URL_CREDENTIALS = /(postgres(?:ql)?:\/\/[^:/@\s]+):[^@\s]+@/gi

/** Strips anything that looks like a credential from a message or stack. */
export function redactSecrets(text: string): string {
  return text.replace(PASSWORD_ASSIGNMENT, '$1=***').replace(URL_CREDENTIALS, '$1:***@')
}

export function toErrorDto(error: unknown): ErrorDto {
  if (isDataForgeError(error)) {
    return { code: error.code, message: redactSecrets(error.message) }
  }

  const message = error instanceof Error ? error.message : String(error)
  return { code: 'internal', message: redactSecrets(message) || 'Unexpected extension host error' }
}

/** Wraps any thrown value into a DataForgeError, keeping the original cause. */
export function wrapError(code: ErrorCode, context: string, error: unknown): DataForgeError {
  if (isDataForgeError(error)) return error
  const cause = error instanceof Error ? error.message : String(error)
  return new DataForgeError(code, `${context}: ${redactSecrets(cause)}`, { cause: error })
}
