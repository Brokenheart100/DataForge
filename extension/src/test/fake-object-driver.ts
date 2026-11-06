import type {
  ColumnInfo,
  DriverQueryInput,
  DriverQueryResult,
  ObjectCatalogDriver,
  ObjectStats,
  RelationInfo,
  ServerInfo,
} from '../domain/driver'
import { DataForgeError } from '../domain/errors'

const OBJECTS: RelationInfo[] = [
  { schema: 'public', name: 'orders', kind: 'table' },
  { schema: 'public', name: 'order_items', kind: 'table' },
  { schema: 'public', name: 'audit_log', kind: 'view' },
]

/** Minimal in-memory catalog driver for ObjectService tests. */
export class FakeObjectDriver implements ObjectCatalogDriver {
  readonly kind = 'postgresql' as const
  readonly searches: string[] = []
  ddlCalls = 0
  failNext = false

  async testConnection(): Promise<ServerInfo> {
    return { serverVersion: 'PostgreSQL 17', database: 'forge', user: 'postgres' }
  }

  async query(_input: DriverQueryInput): Promise<DriverQueryResult> {
    return { columns: [], rows: [], command: 'SELECT', durationMs: 1, truncated: false, affectedRows: null }
  }

  async listSchemas(): Promise<string[]> {
    return ['public']
  }

  async listRelations(): Promise<RelationInfo[]> {
    return OBJECTS.filter((object) => object.kind === 'table')
  }

  async listColumns(): Promise<ColumnInfo[]> {
    return [{ name: 'id', dataType: 'integer', nullable: false, defaultValue: null, ordinal: 1, isPrimaryKey: true }]
  }

  async searchObjects(query: string, limit: number): Promise<RelationInfo[]> {
    this.searches.push(query)
    return OBJECTS.filter((object) => object.name.includes(query)).slice(0, limit)
  }

  async objectDdl(relation: RelationInfo): Promise<string> {
    this.ddlCalls += 1
    if (this.failNext) {
      throw new DataForgeError('not_found', `Relation "${relation.schema}.${relation.name}" no longer exists.`)
    }
    return `create table ${relation.schema}.${relation.name} (id integer primary key);`
  }

  async objectStats(): Promise<ObjectStats> {
    return {
      totalBytes: 8192,
      rowEstimate: 42,
      indexBytes: 4096,
      indexes: [
        {
          name: 'orders_pkey',
          bytes: 4096,
          unique: true,
          definition: 'create unique index orders_pkey on public.orders using btree (id)',
        },
      ],
    }
  }

  async dispose(): Promise<void> {
    return undefined
  }
}
