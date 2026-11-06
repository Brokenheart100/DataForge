/**
 * Shared kernel: the contract between the extension host and the Vue webview.
 *
 * This module is intentionally dependency-free and must stay runtime-safe on
 * both sides (Node 22 and the webview browser context). It contains the wire
 * protocol plus the value types that both sides need to agree on.
 *
 * Rule enforced by design: no secret ever crosses this boundary. Passwords are
 * accepted from the webview when creating/testing a connection and are written
 * straight into VS Code SecretStorage; the host never sends them back.
 */

export const PROTOCOL_VERSION = 2

export type SslMode = 'disable' | 'require' | 'verify-full'
export type ConnectionState = 'disconnected' | 'connected' | 'error'

/** JSON-safe cell value. Dates arrive as ISO strings, bytea as `\x…`. */
export type CellValue = string | number | boolean | null

export interface ColumnDto {
  name: string
  /** PostgreSQL type name when known, e.g. `int4`, `timestamptz`. */
  dataType: string
}

export interface ConnectionSummary {
  id: string
  name: string
  host: string
  port: number
  database: string
  user: string
  ssl: SslMode
  readOnly: boolean
  state: ConnectionState
  serverVersion?: string
  lastError?: string
}

/** Payload accepted when creating or testing a connection (write-only password). */
export interface ConnectionDraft {
  name: string
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: SslMode
  readOnly: boolean
}

export interface ConnectionTestTarget {
  /** Test a saved connection instead of a draft. */
  connectionId?: string
  draft?: ConnectionDraft
}

export interface ConnectionTestResult {
  serverVersion: string
  database: string
  user: string
  latencyMs: number
}

export interface QueryResultDto {
  columns: ColumnDto[]
  rows: CellValue[][]
  /** Number of rows in `rows` (after the maxRows cap). */
  rowCount: number
  /** Rows reported by the driver before truncation, when the driver knows it. */
  command: string
  durationMs: number
  truncated: boolean
  /** Rows touched by INSERT/UPDATE/DELETE, null for statements that return rows. */
  affectedRows: number | null
  notices: string[]
}

export interface QueryInput {
  connectionId: string
  sql: string
  maxRows: number
}

export interface ErrorDto {
  code: ErrorCode
  message: string
}

export type ErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'connection_failed'
  | 'query_failed'
  | 'cancelled'
  | 'internal'

/**
 * Request catalogue: one entry per request type, describing its input and
 * output. Everything else in the protocol is derived from this map, so adding
 * a request keeps the webview client fully typed.
 */
export interface RequestCatalogue {
  'connection.list': { input: null; output: ConnectionSummary[] }
  'connection.create': { input: ConnectionDraft; output: ConnectionSummary }
  'connection.update': { input: { id: string } & Partial<ConnectionDraft>; output: ConnectionSummary }
  'connection.delete': { input: { id: string }; output: null }
  'connection.test': { input: ConnectionTestTarget; output: ConnectionTestResult }
  'connection.connect': { input: { id: string }; output: ConnectionSummary }
  'connection.disconnect': { input: { id: string }; output: ConnectionSummary }
  'query.execute': { input: QueryInput; output: QueryResultDto }
  'query.cancel': { input: { targetRequestId: string }; output: null }
  'workbench.ready': { input: null; output: null }
}

export type RequestType = keyof RequestCatalogue
export type RequestInput<T extends RequestType> = RequestCatalogue[T]['input']
export type RequestOutput<T extends RequestType> = RequestCatalogue[T]['output']

export const REQUEST_TYPES = [
  'connection.list',
  'connection.create',
  'connection.update',
  'connection.delete',
  'connection.test',
  'connection.connect',
  'connection.disconnect',
  'query.execute',
  'query.cancel',
  'workbench.ready',
] as const satisfies readonly RequestType[]

export type WebviewRequest = {
  [K in RequestType]: {
    kind: 'request'
    id: string
    type: K
    payload: RequestInput<K>
  }
}[RequestType]

export type WebviewResponse = {
  [K in RequestType]: {
    kind: 'response'
    id: string
    type: K
    ok: true
    data: RequestOutput<K>
  }
}[RequestType]

export interface ResponseError {
  kind: 'response'
  id: string
  ok: false
  error: ErrorDto
}

export interface BootstrapPayload {
  protocolVersion: number
  connections: ConnectionSummary[]
  prefs: {
    maxRows: number
    statementTimeoutMs: number
    connectTimeoutMs: number
  }
}

export type HostEvent =
  | { type: 'connections.changed'; payload: ConnectionSummary[] }
  | { type: 'toast'; payload: { level: 'info' | 'warn' | 'error'; message: string } }
  | { type: 'editor.prefill'; payload: { sql: string; connectionId?: string } }

export type HostMessage =
  | { kind: 'ready'; payload: BootstrapPayload }
  | { kind: 'response'; payload: WebviewResponse | ResponseError }
  | { kind: 'event'; payload: HostEvent }
