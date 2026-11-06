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

export const PROTOCOL_VERSION = 3

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

export interface DataSortDto {
  column: string
  direction: 'asc' | 'desc'
}

export interface DataColumnDto {
  name: string
  dataType: string
  nullable: boolean
  isPrimaryKey: boolean
  defaultValue: string | null
  ordinal: number
}

export interface DataRowDto {
  values: CellValue[]
  identity: Record<string, CellValue>
  /** `xmin` the row was read with; null when it cannot be versioned. */
  version: string | null
}

export interface DataPageInput {
  connectionId: string
  schema: string
  relation: string
  limit: number
  offset: number
  orderBy: DataSortDto[]
}

export interface DataPageDto {
  columns: DataColumnDto[]
  primaryKey: string[]
  rows: DataRowDto[]
  totalRows: number
  limit: number
  offset: number
  /** False for views, foreign tables and tables without a primary key. */
  editable: boolean
  readOnlyReason?: string
}

export type RowChangeDto =
  | { kind: 'insert'; values: Record<string, CellValue> }
  | { kind: 'update'; identity: Record<string, CellValue>; values: Record<string, CellValue> }
  | { kind: 'delete'; identity: Record<string, CellValue> }

export interface DataChangeDto {
  /** Client-side id of the grid row, echoed back in error messages. */
  rowId: string
  version: string | null
  change: RowChangeDto
}

export interface DataCommitInput {
  connectionId: string
  schema: string
  relation: string
  changes: DataChangeDto[]
}

export interface DataCommitResult {
  inserted: number
  updated: number
  deleted: number
  returnedKeys: (CellValue[] | null)[]
}

/** Explicit transaction state for one connection, as the webview sees it. */
export interface SessionStateDto {
  connectionId: string
  active: boolean
}

export interface ExplainInput {
  connectionId: string
  sql: string
}

/** PostgreSQL's `EXPLAIN (FORMAT JSON)` output, pretty-printed as text. */
export interface ExplainResultDto {
  plan: string
  durationMs: number
}

export interface DataExportInput {
  connectionId: string
  schema: string
  relation: string
}

/**
 * `saved: false` means the user dismissed the save dialog — not an error.
 * The host owns the file path; the webview never chooses where data lands.
 */
export interface DataExportDto {
  saved: boolean
  path?: string
  rowCount?: number
}

export interface ErrorDto {
  code: ErrorCode
  message: string
  /** Identity fragments (`id=42`) of the rows that changed elsewhere; conflict only. */
  conflictingKeys?: string[]
}

export type ErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'connection_failed'
  | 'query_failed'
  | 'conflict'
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
  'query.explain': { input: ExplainInput; output: ExplainResultDto }
  'transaction.begin': { input: { connectionId: string }; output: SessionStateDto }
  'transaction.commit': { input: { connectionId: string }; output: SessionStateDto }
  'transaction.rollback': { input: { connectionId: string }; output: SessionStateDto }
  'transaction.run': { input: QueryInput; output: QueryResultDto }
  'data.page': { input: DataPageInput; output: DataPageDto }
  'data.commit': { input: DataCommitInput; output: DataCommitResult }
  'data.export': { input: DataExportInput; output: DataExportDto }
  /** Aborts a running `data.commit` or `data.export` by its request id. */
  'data.cancel': { input: { targetRequestId: string }; output: null }
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
  'query.explain',
  'transaction.begin',
  'transaction.commit',
  'transaction.rollback',
  'transaction.run',
  'data.page',
  'data.commit',
  'data.export',
  'data.cancel',
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

export interface RelationTarget {
  connectionId: string
  schema: string
  relation: string
}

export type HostEvent =
  | { type: 'connections.changed'; payload: ConnectionSummary[] }
  | { type: 'toast'; payload: { level: 'info' | 'warn' | 'error'; message: string } }
  | { type: 'editor.prefill'; payload: { sql: string; connectionId?: string; target?: RelationTarget } }

export type HostMessage =
  | { kind: 'ready'; payload: BootstrapPayload }
  | { kind: 'response'; payload: WebviewResponse | ResponseError }
  | { kind: 'event'; payload: HostEvent }
