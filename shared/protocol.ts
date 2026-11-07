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

/**
 * v5 adds the database dimension: connection-scoped requests accept an optional
 * `database`, which defaults to the connection's own database. `database.list`
 * enumerates what the server exposes so the explorer can nest by database.
 *
 * v6 adds structural changes: `ddl.preview` / `ddl.apply` carry a structured
 * plan (never raw SQL) that the host turns into statements, and `schema.diff`
 * compares two scopes.
 *
 * v7 adds driver capabilities to the connection summary (so the UI hides what a
 * driver cannot do) and the optional SSH tunnel a profile connects through.
 *
 * v8 adds the operations view: server session listing/termination and a
 * structured EXPLAIN plan tree beside the raw JSON text.
 *
 * v9 adds workbench session restore: the webview saves its tabs, SQL buffers
 * and the open data page to host globalState so a window reload restores them.
 */
export const PROTOCOL_VERSION = 9

export type SslMode = 'disable' | 'require' | 'verify-full'
export type ConnectionState = 'disconnected' | 'connected' | 'error'

/** Database flavour a profile points at. Drivers are selected by this value. */
export type ConnectionKind = 'postgresql' | 'mysql' | 'sqlite' | 'sqlserver'

export type SshAuthMethod = 'password' | 'private key'

/**
 * SSH hop used before the database handshake. Secrets (`sshPassword`,
 * `sshPassphrase`) travel only in drafts and live in SecretStorage, never here.
 */
export interface SshTunnelDto {
  host: string
  port: number
  user: string
  auth: SshAuthMethod
  /** Absolute path to the private key when `auth` is `private key`. */
  privateKeyPath?: string
}

/** What a connected driver offers; the webview hides everything else. */
export interface DriverCapabilitiesDto {
  query: boolean
  dataEditing: boolean
  exportCsv: boolean
  transactions: boolean
  schemaChanges: boolean
  objectBrowser: boolean
  databaseList: boolean
  /** Server session listing and termination (Stage H). */
  sessions: boolean
}

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
  kind: ConnectionKind
  host: string
  port: number
  database: string
  user: string
  ssl: SslMode
  readOnly: boolean
  state: ConnectionState
  /** Absent while disconnected; describes what the live driver supports. */
  capabilities?: DriverCapabilitiesDto
  /** SSH hop the profile connects through, when configured. */
  tunnel?: SshTunnelDto
  serverVersion?: string
  lastError?: string
}

/** Payload accepted when creating or testing a connection (write-only password). */
export interface ConnectionDraft {
  /** Optional for backwards compatibility; defaults to `postgresql`. */
  kind?: ConnectionKind
  name: string
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: SslMode
  readOnly: boolean
  /** `null` turns a previously configured tunnel off; omitted keeps it. */
  tunnel?: SshTunnelDto | null
  /** Write-only SSH password; stored in SecretStorage next to the DB password. */
  sshPassword?: string
  /** Write-only passphrase for an encrypted private key. */
  sshPassphrase?: string
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
  /** Database to run in; omitted means the connection's own database. */
  database?: string
  /** Console that issued the statement, so closing it can cancel the query. */
  consoleId?: string
  sql: string
  maxRows: number
}

export interface ConsoleDto {
  id: string
  connectionId: string
  /** Database the console was opened against. */
  database: string
  title: string
}

export type ObjectKind = 'table' | 'view' | 'materialized view' | 'partitioned table' | 'foreign table'

/** A relation found by the object search; `kind` drives the icon and the DDL request. */
export interface ObjectRefDto {
  schema: string
  name: string
  kind: ObjectKind
}

export interface ObjectSearchInput {
  connectionId: string
  database?: string
  /** Case-insensitive fragment matched against schema and relation names. */
  query: string
  limit?: number
}

export interface ObjectSearchDto {
  objects: ObjectRefDto[]
  truncated: boolean
}

export interface ObjectTargetInput {
  connectionId: string
  database?: string
  schema: string
  name: string
  kind: ObjectKind
}

export interface ObjectIndexDto {
  name: string
  bytes: number | null
  unique: boolean
  definition: string | null
}

export interface ObjectStatsDto {
  totalBytes: number | null
  rowEstimate: number | null
  indexBytes: number | null
  indexes: ObjectIndexDto[]
}

export interface ObjectDdlDto {
  ddl: string
  /** True when the answer came from the host cache instead of the server. */
  cached: boolean
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
  /** Computed columns cannot be written and are read-only in the grid. */
  generated?: boolean
}

export interface DataRowDto {
  values: CellValue[]
  identity: Record<string, CellValue>
  /** `xmin` the row was read with; null when it cannot be versioned. */
  version: string | null
}

export type DataFilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'is null' | 'is not null'

/** Server-side filter; `value` is bound as a parameter by the driver. */
export interface DataFilterDto {
  column: string
  operator: DataFilterOperator
  value?: CellValue
}

export interface DataPageInput {
  connectionId: string
  /** Database to browse; omitted means the connection's own database. */
  database?: string
  schema: string
  relation: string
  limit: number
  offset: number
  orderBy: DataSortDto[]
  filters?: DataFilterDto[]
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
  database?: string
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
  database?: string
  sql: string
}

/** PostgreSQL's `EXPLAIN (FORMAT JSON)` output, pretty-printed as text. */
export interface ExplainResultDto {
  plan: string
  durationMs: number
  /** Parsed plan tree; absent when the server returned a shape we do not know. */
  root?: ExplainPlanNodeDto
}

/** One node of a PostgreSQL EXPLAIN plan, flattened for rendering. */
export interface ExplainPlanNodeDto {
  nodeType: string
  relation?: string
  alias?: string
  indexName?: string
  joinType?: string
  startupCost?: number
  totalCost?: number
  planRows?: number
  planWidth?: number
  actualRows?: number
  actualTotalTime?: number
  loops?: number
  filter?: string
  children: ExplainPlanNodeDto[]
}

export interface SessionListInput {
  connectionId: string
  database?: string
}

/** One server-side connection as shown in the session monitor. */
export interface ServerSessionDto {
  /** Backend id: PostgreSQL pid, MySQL connection id. */
  id: string
  user?: string
  database?: string
  application?: string
  client?: string
  state?: string
  /** ISO timestamp when the session started, when the server reports it. */
  startedAt?: string
  /** Time spent in the current state or transaction, in milliseconds. */
  durationMs?: number
  /** Current or last statement, truncated by the host. */
  query?: string
  waitEvent?: string
  /** True when the session has been running longer than the host threshold. */
  longRunning: boolean
}

export interface SessionListDto {
  sessions: ServerSessionDto[]
  /** Sessions older than this are flagged `longRunning`. */
  longRunningMs: number
  /** Role that owns this connection; only its sessions may be terminated. */
  currentUser?: string
}

export interface SessionTerminateInput {
  connectionId: string
  database?: string
  sessionId: string
  /** The webview asks the user first; the host refuses without it. */
  confirm: boolean
}

export interface SessionTerminateDto {
  sessionId: string
}

export interface DataExportInput {
  connectionId: string
  database?: string
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

export type ImportFormat = 'csv' | 'json'

export interface ImportPreviewInput {
  connectionId: string
  database?: string
  schema: string
  relation: string
  format: ImportFormat
  delimiter?: string
  hasHeader?: boolean
}

/** One source column and where it lands; `target: null` means "ignore this column". */
export interface ImportMappingDto {
  source: string
  target: string | null
}

export interface ImportColumnDto {
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string | null
}

/**
 * Preview of the file the host picked. `token` is opaque to the webview and
 * identifies the host-side file for the subsequent `import.start` request.
 */
export interface ImportPreviewDto {
  token: string
  fileName: string
  format: ImportFormat
  delimiter: string
  hasHeader: boolean
  totalBytes: number
  headers: string[]
  sample: string[][]
  mapping: ImportMappingDto[]
  columns: ImportColumnDto[]
  issues: string[]
}

export interface ImportStartInput {
  connectionId: string
  database?: string
  schema: string
  relation: string
  token: string
  mapping: ImportMappingDto[]
  batchSize?: number
}

export interface ImportErrorDto {
  row: number
  message: string
}

export interface ImportResultDto {
  imported: number
  failed: number
  cancelled: boolean
  errors: ImportErrorDto[]
  durationMs: number
}

/**
 * Structural change plans are data, not SQL: the webview describes intent and
 * the host owns identifier quoting, type checks and the final statement text.
 */
export type DdlRisk = 'safe' | 'caution' | 'dangerous'

export interface DdlColumnPlanDto {
  name: string
  /** PostgreSQL type text, e.g. `text`, `numeric(10,2)`, `timestamptz`. */
  dataType: string
  nullable?: boolean
  /** Literal or small allow-listed function, rendered by the host. */
  defaultValue?: string | null
  primaryKey?: boolean
  unique?: boolean
}

export interface DdlIndexPlanDto {
  /** Defaults to `<table>_<columns>_idx` when omitted. */
  name?: string
  unique?: boolean
  columns: string[]
}

/**
 * A column change. Every field is optional: omitted means "keep", while
 * `defaultValue: null` drops the current default.
 */
export interface DdlAlterColumnPlanDto {
  name: string
  dataType?: string
  nullable?: boolean
  defaultValue?: string | null
}

export type DdlPlanDto =
  | {
      kind: 'create table'
      connectionId: string
      database?: string
      schema: string
      table: string
      columns: DdlColumnPlanDto[]
      ifNotExists?: boolean
    }
  | {
      kind: 'add column'
      connectionId: string
      database?: string
      schema: string
      table: string
      column: DdlColumnPlanDto
      ifNotExists?: boolean
    }
  | {
      kind: 'drop table'
      connectionId: string
      database?: string
      schema: string
      table: string
      ifExists?: boolean
    }
  | {
      kind: 'create index'
      connectionId: string
      database?: string
      schema: string
      table: string
      index: DdlIndexPlanDto
      ifNotExists?: boolean
    }
  | {
      kind: 'alter column'
      connectionId: string
      database?: string
      schema: string
      table: string
      column: DdlAlterColumnPlanDto
    }

export interface DdlStatementDto {
  sql: string
  risk: DdlRisk
  /** Why the statement is risky, or what the user should know before running it. */
  note?: string
}

export interface DdlPreviewDto {
  statements: DdlStatementDto[]
  /** True when at least one statement is `dangerous`. */
  requiresConfirmation: boolean
  /** Exact text the user must type before `ddl.apply` accepts the plan. */
  expectedConfirmation: string | null
  warnings: string[]
}

export interface DdlApplyInput {
  plan: DdlPlanDto
  /** Typed confirmation; required only when the preview asked for it. */
  confirm?: string
}

export interface DdlApplyDto {
  statements: number
  durationMs: number
}

export interface SchemaScopeDto {
  database?: string
  schema: string
}

export interface SchemaDiffInput {
  connectionId: string
  left: SchemaScopeDto
  right: SchemaScopeDto
}

export interface SchemaDiffEntryDto {
  schema: string
  name: string
  kind: ObjectKind
}

export interface SchemaDiffChangedDto {
  name: string
  leftKind: ObjectKind
  rightKind: ObjectKind
}

export interface SchemaDiffDto {
  added: SchemaDiffEntryDto[]
  removed: SchemaDiffEntryDto[]
  changed: SchemaDiffChangedDto[]
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
  'database.list': { input: { connectionId: string }; output: string[] }
  'console.open': { input: { connectionId: string; database?: string; title?: string }; output: ConsoleDto }
  'console.list': { input: { connectionId: string }; output: ConsoleDto[] }
  'console.close': { input: { consoleId: string }; output: null }
  'object.search': { input: ObjectSearchInput; output: ObjectSearchDto }
  'object.ddl': { input: ObjectTargetInput; output: ObjectDdlDto }
  'object.stats': { input: ObjectTargetInput; output: ObjectStatsDto }
  /** Opens a read-only SQL document in the editor with the object's DDL. */
  'object.openInEditor': { input: ObjectTargetInput; output: null }
  'schema.diff': { input: SchemaDiffInput; output: SchemaDiffDto }
  'ddl.preview': { input: DdlPlanDto; output: DdlPreviewDto }
  'ddl.apply': { input: DdlApplyInput; output: DdlApplyDto }
  /** Opens the previewed statements as a read-only SQL document. */
  'ddl.openInEditor': { input: DdlPlanDto; output: null }
  'query.execute': { input: QueryInput; output: QueryResultDto }
  'query.cancel': { input: { targetRequestId: string }; output: null }
  'query.explain': { input: ExplainInput; output: ExplainResultDto }
  'session.list': { input: SessionListInput; output: SessionListDto }
  /** Confirmation is required; only the connection's own role may be targeted. */
  'session.terminate': { input: SessionTerminateInput; output: SessionTerminateDto }
  'transaction.begin': { input: { connectionId: string; database?: string; consoleId?: string }; output: SessionStateDto }
  'transaction.commit': { input: { connectionId: string; consoleId?: string }; output: SessionStateDto }
  'transaction.rollback': { input: { connectionId: string; consoleId?: string }; output: SessionStateDto }
  'transaction.run': { input: QueryInput; output: QueryResultDto }
  'data.page': { input: DataPageInput; output: DataPageDto }
  'data.commit': { input: DataCommitInput; output: DataCommitResult }
  'data.export': { input: DataExportInput; output: DataExportDto }
  /** Opens a picker in the host, then returns the first rows and a file token. */
  'import.preview': { input: ImportPreviewInput; output: ImportPreviewDto }
  /** Streams a previously previewed file into the relation in batches. */
  'import.start': { input: ImportStartInput; output: ImportResultDto }
  'import.cancel': { input: { targetRequestId: string }; output: null }
  /** Aborts a running `data.commit` or `data.export` by its request id. */
  'data.cancel': { input: { targetRequestId: string }; output: null }
  'workbench.load': { input: null; output: WorkbenchStateDto | null }
  /** Stores the session snapshot; called on an idle debounce by the webview. */
  'workbench.save': { input: WorkbenchStateDto; output: null }
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
  'database.list',
  'console.open',
  'console.list',
  'console.close',
  'object.search',
  'object.ddl',
  'object.stats',
  'object.openInEditor',
  'schema.diff',
  'ddl.preview',
  'ddl.apply',
  'ddl.openInEditor',
  'query.execute',
  'query.cancel',
  'query.explain',
  'session.list',
  'session.terminate',
  'transaction.begin',
  'transaction.commit',
  'transaction.rollback',
  'transaction.run',
  'data.page',
  'data.commit',
  'data.export',
  'import.preview',
  'import.start',
  'import.cancel',
  'data.cancel',
  'workbench.load',
  'workbench.save',
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
  /** VS Code display language, so “Auto” can follow the editor rather than the OS. */
  locale?: string
  prefs: {
    maxRows: number
    statementTimeoutMs: number
    connectTimeoutMs: number
  }
}

/** Which pane the workbench shows for a restored session. */
export type WorkbenchViewDto = 'sql' | 'data'

/** One restored editor tab. Results and transactions are never persisted. */
export interface SavedConsoleDto {
  key: string
  title: string
  sql: string
  connectionId?: string
}

/** Relation whose data page was open when the window was closed. */
export interface SavedRelationDto {
  connectionId: string
  database?: string
  schema: string
  relation: string
}

/** Paging and filtering of the restored data page; pending edits are dropped. */
export interface SavedDataViewDto {
  offset: number
  orderBy: DataSortDto[]
  filters: DataFilterDto[]
}

/**
 * Last workbench session, stored in host globalState. It contains SQL text and
 * relation names only — no results, row data, transactions or credentials.
 */
export interface WorkbenchStateDto {
  activeConnectionId?: string
  activeConsoleId?: string
  consoles: SavedConsoleDto[]
  view?: WorkbenchViewDto
  relation?: SavedRelationDto
  data?: SavedDataViewDto
}

export interface RelationTarget {
  connectionId: string
  /** Database the relation lives in; omitted means the connection's own database. */
  database?: string
  schema: string
  relation: string
}

export interface ImportProgressEvent {
  requestId: string
  fileName: string
  processed: number
  inserted: number
  failed: number
  done: boolean
}

export type HostEvent =
  | { type: 'connections.changed'; payload: ConnectionSummary[] }
  | { type: 'toast'; payload: { level: 'info' | 'warn' | 'error'; message: string } }
  | { type: 'editor.prefill'; payload: { sql: string; connectionId?: string; target?: RelationTarget } }
  | { type: 'object.ddl'; payload: ObjectTargetInput }
  | { type: 'import.progress'; payload: ImportProgressEvent }

export type HostMessage =
  | { kind: 'ready'; payload: BootstrapPayload }
  | { kind: 'response'; payload: WebviewResponse | ResponseError }
  | { kind: 'event'; payload: HostEvent }
