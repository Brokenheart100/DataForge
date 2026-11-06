import type { CellValue, ColumnDto } from '@shared/protocol'

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
export interface DatabaseDriver {
  readonly kind: string
  testConnection(): Promise<ServerInfo>
  query(input: DriverQueryInput): Promise<DriverQueryResult>
  listSchemas(): Promise<string[]>
  listRelations(schema: string): Promise<RelationInfo[]>
  listColumns(schema: string, relation: string): Promise<ColumnInfo[]>
  dispose(): Promise<void>
}
