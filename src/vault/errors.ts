export type VaultErrorCode =
  /** The id/path is malformed, escapes the vault, or points into a hidden/asset directory. */
  | 'INVALID_PATH'
  /** The note, folder or trash entry does not exist. */
  | 'NOT_FOUND'
  /** The destination of a create/rename/move already exists. */
  | 'EXISTS'
  /** The vault root is missing or not a directory. */
  | 'NOT_A_VAULT'
  /** The note on disk no longer matches the `baseHash` a write was based on. */
  | 'CHANGED'
  /** An import would copy more files or bytes than allowed. */
  | 'TOO_LARGE'

/** Error thrown by vault operations; `code` lets callers (router controllers) map it to an HTTP status. */
export class VaultError extends Error {
  readonly code: VaultErrorCode

  constructor(code: VaultErrorCode, message: string) {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

export function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
