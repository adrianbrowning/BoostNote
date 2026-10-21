import { MigrationError } from '../migrate/index.ts'
import { VaultError, type VaultErrorCode } from '../vault/index.ts'
import type { ApiErrorBody } from './actions/public/workspace/types.ts'

/** HTTP status of each `VaultError` code. */
export const VAULT_ERROR_STATUS: Record<VaultErrorCode, number> = {
  INVALID_PATH: 400,
  NOT_FOUND: 404,
  EXISTS: 409,
  NOT_A_VAULT: 400,
}

const MIGRATION_ERROR_STATUS: Record<MigrationError['code'], number> = {
  NOT_A_LEGACY_STORAGE: 400,
  INVALID_TARGET: 400,
  TARGET_NOT_EMPTY: 409,
}

/** An expected failure an action reports with a status and a JSON `ApiErrorBody`. */
export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'no-store')
  return Response.json(data, { ...init, headers })
}

/** Maps expected errors (`HttpError`, `VaultError`, `MigrationError`) to JSON responses; rethrows the rest (→ 500). */
export function errorResponse(error: unknown): Response {
  let status: number
  let code: string
  if (error instanceof HttpError) {
    status = error.status
    code = error.code
  } else if (error instanceof VaultError) {
    status = VAULT_ERROR_STATUS[error.code]
    code = error.code
  } else if (error instanceof MigrationError) {
    status = MIGRATION_ERROR_STATUS[error.code]
    code = error.code
  } else {
    throw error
  }
  const body: ApiErrorBody = { error: code, message: error.message }
  return json(body, { status })
}

/** The request's JSON object body; anything else is a `400`. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'Expected a JSON body')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'BAD_REQUEST', 'Expected a JSON object')
  }
  return value as Record<string, unknown>
}

/** A string field of a JSON body or a search param. Folder ids may be `''` (the vault root) when `allowEmpty`. */
export function requireString(value: unknown, name: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string' || (!options.allowEmpty && value === '')) {
    throw new HttpError(400, 'BAD_REQUEST', `Missing or invalid "${name}"`)
  }
  return value
}
