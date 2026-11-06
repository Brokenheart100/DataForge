import type { CellValue, ColumnDto, ConnectionKind } from '@shared/protocol'

/** Identity of the server behind a connection, shown in the connection card. */
export interface ServerInfo {
  readonly serverVersion: string
  readonly database: string
  readonly user: string
}

export interface DriverQueryInput {
  readonly sql: string
  /** Hard cap on rows handed back to the host; extra rows are discarded. */
  readonly maxRows: number
  /** Aborting must stop execution server-side, not just ignore the result. */
  readonly signal?: AbortSignal
}

export interface DriverQueryResult {
  readonly columns: readonly ColumnDto[]
  readonly rows: readonly CellValue[][]
  readonly command: string
  readonly durationMs: number
  readonly truncated: boolean
  readonly affectedRows: number | null
}

export type RelationKind = 'table' | 'view' | 'materialized view' | 'partitioned table' | 'foreign table'

export interface RelationInfo {
  readonly schema: string
  readonly name: string
  readonly kind: RelationKind
}

export interface ColumnInfo {
  readonly name: string
  readonly dataType: string
  readonly nullable: boolean
  readonly defaultValue: string | null
  readonly isPrimaryKey: boolean
  readonly ordinal: number
}

/**
 * Port implemented by every database adapter. Phase 1 ships PostgreSQL only;
 * a second adapter should only appear when a second database is really added.
 */
/** One dedicated backend connection with an open transaction. */
export interface DriverSession {
  query(input: DriverQueryInput): Promise<DriverQueryResult>
  commit(): Promise<void>
  rollback(): Promise<void>
  /** Rolls back if still open; always releases the backend. */
  close(): Promise<void>
}

/** Drivers that can hold a single-client transaction per connection. */
export interface TransactionalDriver extends DatabaseDriver {
  openSession(): Promise<DriverSession>
}

export interface DatabaseDriver {
  readonly kind: ConnectionKind
  /** Optional: adapters advertise what the UI may offer; absent means nothing beyond queries. */
  readonly capabilities?: DriverCapabilities
  testConnection(): Promise<ServerInfo>
  query(input: DriverQueryInput): Promise<DriverQueryResult>
  listSchemas(): Promise<string[]>
  listRelations(schema: string): Promise<RelationInfo[]>
  listColumns(schema: string, relation: string): Promise<ColumnInfo[]>
  dispose(): Promise<void>
}

/** Primary-key values that identify exactly one row. */
export type RowIdentity = Readonly<Record<string, CellValue>>

export interface SortSpec {
  readonly column: string
  readonly direction: 'asc' | 'desc'
}

export interface DriverPageInput {
  readonly schema: string
  readonly relation: string
  /** Columns to select, in result order. */
  readonly columns: readonly string[]
  /** Primary-key columns; used to build {@link DataRow.identity}. */
  readonly identityColumns: readonly string[]
  readonly orderBy: readonly SortSpec[]
  readonly limit: number
  readonly offset: number
  /** Ask for the row version (`xmin`); only editable heap relations have one. */
  readonly withVersion?: boolean
}

export interface DataRow {
  /** Values aligned with {@link DriverPageInput.columns}. */
  readonly values: readonly CellValue[]
  readonly identity: RowIdentity
  /** Row version for optimistic locking (`xmin` on PostgreSQL). */
  readonly version: string | null
}

export interface DriverPageResult {
  readonly rows: readonly DataRow[]
  readonly totalRows: number
}

export interface MutationField {
  readonly column: string
  readonly value: CellValue
}

/**
 * A row-level write, expressed as data rather than SQL.
 *
 * The driver turns it into a parameterized statement, so the application layer
 * never concatenates identifiers or values.
 */
export interface RowMutation {
  readonly kind: 'insert' | 'update' | 'delete'
  /** Columns and values to write; empty for a delete. */
  readonly values: readonly MutationField[]
  /** Primary-key predicate; empty for an insert. */
  readonly identity: readonly MutationField[]
  /** Row version from {@link DataRow.version}; `null` disables the check. */
  readonly version: string | null
  /** Columns returned by `INSERT`/`UPDATE` via `RETURNING`. */
  readonly returning: readonly string[]
}

export interface MutationResult {
  readonly rowCount: number
  /** Row returned by `RETURNING`, or `null` when nothing was requested. */
  readonly returned: readonly CellValue[] | null
}

export interface MutationBatch {
  readonly schema: string
  readonly relation: string
  readonly mutations: readonly RowMutation[]
  /**
   * Aborted when the user cancels the commit. Statements already sent cannot
   * be recalled, so the driver checks this between statements and still rolls
   * the whole transaction back.
   */
  readonly signal?: AbortSignal
}

export interface DriverCapabilities {
  readonly transactions: boolean
  readonly returning: boolean
  /** Character used to quote identifiers, e.g. `"` on PostgreSQL. */
  readonly identifierQuote: string
}

/**
 * Role interface for drivers that can edit table data.
 *
 * Kept separate from {@link DatabaseDriver} so a read-only driver remains a
 * valid connection target and editing support is an explicit capability
 * instead of an assumption.
 */
export interface DataEditingDriver extends DatabaseDriver {
  readonly capabilities: DriverCapabilities
  selectPage(input: DriverPageInput): Promise<DriverPageResult>
  countRows(schema: string, relation: string): Promise<number>
  /** Applies every mutation in one transaction; any failure rolls all back. */
  applyMutations(batch: MutationBatch): Promise<readonly MutationResult[]>
}

export interface DriverStreamInput {
  readonly schema: string
  readonly relation: string
  /** Rows per round trip; keeps host memory bounded on large tables. */
  readonly batchSize: number
  readonly signal?: AbortSignal
}

export interface StreamResult {
  readonly rowCount: number
}

/**
 * Role interface for drivers that can stream a whole relation.
 *
 * Separation mirrors {@link DataEditingDriver}: bulk reads are a capability,
 * not something every adapter has to implement.
 */
export interface TableExportDriver extends DatabaseDriver {
  /**
   * Reads the relation in batches and hands each one to `onBatch`.
   *
   * The callback may be async; the driver waits for it before fetching the
   * next batch so a slow disk never turns into unbounded memory.
   */
  exportTable(
    input: DriverStreamInput,
    onBatch: (rows: readonly (readonly CellValue[])[]) => void | Promise<void>,
  ): Promise<StreamResult>
}
