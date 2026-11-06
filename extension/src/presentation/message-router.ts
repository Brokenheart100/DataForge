import { z } from 'zod'

import type {
  ConnectionDraft,
  ConnectionTestTarget,
  DataCommitInput,
  DataCommitResult,
  DataExportDto,
  DataExportInput,
  DataPageDto,
  DataPageInput,
  ExplainInput,
  ImportPreviewInput,
  ImportStartInput,
  ObjectRefDto,
  ObjectSearchDto,
  ObjectSearchInput,
  ObjectTargetInput,
  QueryInput,
  SessionStateDto,
  RequestOutput,
  RequestType,
  ResponseError,
  WebviewResponse,
} from '@shared/protocol'
import { REQUEST_TYPES } from '@shared/protocol'

import type { Logger } from '../application/ports'
import type { ConnectionService } from '../application/connection-service'
import type { ConsoleService } from '../application/console-service'
import type { ImportService } from '../application/import-service'
import type { ObjectService } from '../application/object-service'
import type { CommitResult, DataPage, DataEditorService } from '../application/data-editor-service'
import type { ExportService } from '../application/export-service'
import type { QueryService } from '../application/query-service'
import { toQueryResultDto } from '../application/query-service'
import type { QuerySessionService } from '../application/query-session-service'
import { DataForgeError, toErrorDto } from '../domain/errors'

const sslSchema = z.enum(['disable', 'require', 'verify-full'])

const draftSchema = z.object({
  // Optional: clients built before protocol v4 send no kind and get PostgreSQL.
  kind: z.enum(['postgresql', 'mysql', 'sqlite', 'sqlserver']).optional(),
  name: z.string().trim().min(1).max(120),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(0).max(65535),
  database: z.string().trim().min(1).max(120),
  user: z.string().trim().min(1).max(120),
  password: z.string().max(4096),
  ssl: sslSchema,
  readOnly: z.boolean(),
})

const idSchema = z.object({ id: z.string().min(1).max(128) })

const cellValueSchema = z.union([z.string().max(1_000_000), z.number(), z.boolean(), z.null()])

const valuesSchema = z.record(z.string().min(1).max(63), cellValueSchema)

const sortSchema = z.object({
  column: z.string().min(1).max(63),
  direction: z.enum(['asc', 'desc']),
})

const filterSchema = z.object({
  column: z.string().min(1).max(63),
  operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'is null', 'is not null']),
  value: cellValueSchema.optional(),
})

const dataPageSchema = z.object({
  connectionId: z.string().min(1).max(128),
  database: z.string().min(1).max(63).optional(),
  schema: z.string().min(1).max(63),
  relation: z.string().min(1).max(63),
  limit: z.number().int().min(1).max(1_000),
  offset: z.number().int().min(0).max(1_000_000),
  orderBy: z.array(sortSchema).max(5),
  filters: z.array(filterSchema).max(10).optional(),
})

const rowChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('insert'), values: valuesSchema }),
  z.object({ kind: z.literal('update'), identity: valuesSchema, values: valuesSchema }),
  z.object({ kind: z.literal('delete'), identity: valuesSchema }),
])

const dataCommitSchema = z.object({
  connectionId: z.string().min(1).max(128),
  database: z.string().min(1).max(63).optional(),
  schema: z.string().min(1).max(63),
  relation: z.string().min(1).max(63),
  changes: z
    .array(
      z.object({
        rowId: z.string().min(1).max(128),
        version: z.string().max(64).nullable(),
        change: rowChangeSchema,
      }),
    )
    .max(500),
})

const objectTargetSchema = z.object({
  connectionId: z.string().min(1).max(128),
  database: z.string().min(1).max(63).optional(),
  schema: z.string().min(1).max(63),
  name: z.string().min(1).max(63),
  kind: z.enum(['table', 'view', 'materialized view', 'partitioned table', 'foreign table']),
})

/** Per-request payload schemas: every message from the webview is untrusted. */
const payloadSchemas: Readonly<Record<RequestType, z.ZodType>> = {
  'connection.list': z.null(),
  'connection.create': draftSchema,
  'connection.update': idSchema.and(draftSchema.partial()),
  'connection.delete': idSchema,
  'connection.test': z
    .object({ connectionId: z.string().min(1).max(128).optional(), draft: draftSchema.optional() })
    .refine((value) => value.connectionId !== undefined || value.draft !== undefined, {
      message: 'Provide a connectionId or a draft.',
    }),
  'connection.connect': idSchema,
  'connection.disconnect': idSchema,
  'database.list': z.object({ connectionId: z.string().min(1).max(128) }),
  'console.open': z.object({
    connectionId: z.string().min(1).max(128),
    database: z.string().min(1).max(63).optional(),
    title: z.string().min(1).max(120).optional(),
  }),
  'console.list': z.object({ connectionId: z.string().min(1).max(128) }),
  'console.close': z.object({ consoleId: z.string().min(1).max(128) }),
  'query.execute': z.object({
    connectionId: z.string().min(1).max(128),
    database: z.string().min(1).max(63).optional(),
    consoleId: z.string().min(1).max(128).optional(),
    sql: z.string().min(1).max(1_000_000),
    maxRows: z.number().int().min(1).max(10_000),
  }),
  'query.cancel': z.object({ targetRequestId: z.string().min(1).max(128) }),
  'query.explain': z.object({
    connectionId: z.string().min(1).max(128),
    database: z.string().min(1).max(63).optional(),
    sql: z.string().min(1).max(1_000_000),
  }),
  'transaction.begin': z.object({
    connectionId: z.string().min(1).max(128),
    database: z.string().min(1).max(63).optional(),
    consoleId: z.string().min(1).max(128).optional(),
  }),
  'transaction.commit': z.object({
    connectionId: z.string().min(1).max(128),
    consoleId: z.string().min(1).max(128).optional(),
  }),
  'transaction.rollback': z.object({
    connectionId: z.string().min(1).max(128),
    consoleId: z.string().min(1).max(128).optional(),
  }),
  'transaction.run': z.object({
    connectionId: z.string().min(1).max(128),
    database: z.string().min(1).max(63).optional(),
    consoleId: z.string().min(1).max(128).optional(),
    sql: z.string().min(1).max(1_000_000),
    maxRows: z.number().int().min(1).max(10_000),
  }),
  'data.page': dataPageSchema,
  'data.commit': dataCommitSchema,
  'data.export': z.object({
    connectionId: z.string().min(1).max(128),
    database: z.string().min(1).max(63).optional(),
    schema: z.string().min(1).max(63),
    relation: z.string().min(1).max(63),
  }),
  'object.search': z.object({
    connectionId: z.string().min(1).max(128),
    database: z.string().min(1).max(63).optional(),
    query: z.string().min(1).max(120),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  'object.ddl': objectTargetSchema,
  'object.stats': objectTargetSchema,
  'object.openInEditor': objectTargetSchema,
  'import.preview': z.object({
    connectionId: z.string().min(1).max(128),
    database: z.string().min(1).max(63).optional(),
    schema: z.string().min(1).max(63),
    relation: z.string().min(1).max(63),
    format: z.enum(['csv', 'json']),
    delimiter: z.string().min(1).max(2).optional(),
    hasHeader: z.boolean().optional(),
  }),
  'import.start': z.object({
    connectionId: z.string().min(1).max(128),
    database: z.string().min(1).max(63).optional(),
    schema: z.string().min(1).max(63),
    relation: z.string().min(1).max(63),
    token: z.string().min(1).max(64),
    mapping: z
      .array(
        z.object({
          source: z.string().min(1).max(200),
          target: z.string().min(1).max(63).nullable(),
        }),
      )
      .max(500),
    batchSize: z.number().int().min(1).max(5000).optional(),
  }),
  'import.cancel': z.object({ targetRequestId: z.string().min(1).max(128) }),
  'data.cancel': z.object({ targetRequestId: z.string().min(1).max(128) }),
  'workbench.ready': z.null(),
}

const envelopeSchema = z.object({
  kind: z.literal('request'),
  id: z.string().min(1).max(128),
  type: z.enum(REQUEST_TYPES),
  payload: z.unknown(),
})

export interface MessageRouterDeps {
  readonly connections: ConnectionService
  readonly queries: QueryService
  readonly dataEditor: DataEditorService
  readonly exporter: ExportService
  /** Shows the host save dialog; the webview never picks a path itself. */
  readonly pickExportPath: (suggestedName: string) => Promise<string | undefined>
  readonly logger: Logger
  /** Optional so router tests can run without a transaction service. */
  readonly sessions?: QuerySessionService
  /** Optional so router tests can run without a console registry. */
  readonly consoles?: ConsoleService
  /** Optional so router tests can run without an object catalog. */
  readonly objects?: ObjectService
  /** Optional so router tests can run without the import wizard. */
  readonly importer?: ImportService
  /** Opens the DDL as a read-only document in the editor. */
  readonly openObjectDdl?: (target: ObjectTargetInput) => Promise<void>
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'payload'}: ${issue.message}`)
    .join('; ')
}

function sessionService(deps: MessageRouterDeps): QuerySessionService {
  if (!deps.sessions) throw new DataForgeError('internal', 'Transactions are not available in this build.')
  return deps.sessions
}

function consoleService(deps: MessageRouterDeps): ConsoleService {
  if (!deps.consoles) throw new DataForgeError('internal', 'Consoles are not available in this build.')
  return deps.consoles
}

function objectService(deps: MessageRouterDeps): ObjectService {
  if (!deps.objects) throw new DataForgeError('internal', 'The object browser is not available in this build.')
  return deps.objects
}

function importService(deps: MessageRouterDeps): ImportService {
  if (!deps.importer) throw new DataForgeError('internal', 'Importing files is not available in this build.')
  return deps.importer
}

function okResponse<T extends RequestType>(id: string, type: T, data: RequestOutput<T>): WebviewResponse {
  // TypeScript cannot correlate the mapped union member with a generic `type`,
  // so the cast is local to this constructor.
  return { kind: 'response', id, type, ok: true, data } as WebviewResponse
}

function errorResponse(id: string, error: unknown): ResponseError {
  return { kind: 'response', id, ok: false, error: toErrorDto(error) }
}

function toPageDto(page: DataPage): DataPageDto {
  return {
    columns: page.columns.map((column) => ({
      name: column.name,
      dataType: column.dataType,
      nullable: column.nullable,
      isPrimaryKey: column.isPrimaryKey,
      defaultValue: column.defaultValue,
      ordinal: column.ordinal,
      generated: column.generated === true,
    })),
    primaryKey: [...page.primaryKey],
    rows: page.rows.map((row) => ({ values: [...row.values], identity: { ...row.identity }, version: row.version })),
    totalRows: page.totalRows,
    limit: page.limit,
    offset: page.offset,
    editable: page.editable,
    ...(page.readOnlyReason === undefined ? {} : { readOnlyReason: page.readOnlyReason }),
  }
}

function toCommitResult(result: CommitResult): DataCommitResult {
  return {
    inserted: result.inserted,
    updated: result.updated,
    deleted: result.deleted,
    returnedKeys: result.returnedKeys.map((keys) => (keys === null ? null : [...keys])),
  }
}

/**
 * Validates every inbound webview message and dispatches it to a use case.
 * Returns the response to post back, or null when the message is unusable.
 */
export class MessageRouter {
  constructor(private readonly deps: MessageRouterDeps) {}

  async handle(raw: unknown): Promise<ResponseError | WebviewResponse | null> {
    const envelope = envelopeSchema.safeParse(raw)
    if (!envelope.success) {
      const id = extractId(raw)
      if (id) return errorResponse(id, new DataForgeError('invalid_request', formatIssues(envelope.error)))
      this.deps.logger.warn('Ignored a webview message that is not a request')
      return null
    }

    const { id, type } = envelope.data
    const payload = payloadSchemas[type].safeParse(envelope.data.payload)
    if (!payload.success) {
      return errorResponse(id, new DataForgeError('invalid_request', `Invalid ${type} payload — ${formatIssues(payload.error)}`))
    }

    try {
      return okResponse(id, type, await this.dispatch(type, payload.data, id))
    } catch (error) {
      if (!(error instanceof DataForgeError)) {
        this.deps.logger.error(`Unhandled error while serving ${type}`, error)
      }
      return errorResponse(id, error)
    }
  }

  /** Narrowed dispatch: each branch receives the payload validated for its type. */
  private async dispatch(type: RequestType, payload: unknown, requestId: string): Promise<RequestOutput<RequestType>> {
    const { connections, queries, dataEditor } = this.deps
    switch (type) {
      case 'connection.list':
        return connections.list()
      case 'connection.create':
        return connections.create(as<ConnectionDraft>(payload))
      case 'connection.update': {
        const patch = as<{ id: string } & Partial<ConnectionDraft>>(payload)
        const { id, ...changes } = patch
        return connections.update(id, changes)
      }
      case 'connection.delete':
        await connections.delete(as<{ id: string }>(payload).id)
        return null
      case 'connection.test':
        return connections.test(as<ConnectionTestTarget>(payload))
      case 'connection.connect':
        return connections.connect(as<{ id: string }>(payload).id)
      case 'connection.disconnect':
        return connections.disconnect(as<{ id: string }>(payload).id)
      case 'database.list':
        return connections.listDatabases(as<{ connectionId: string }>(payload).connectionId)
      case 'console.open': {
        const input = as<{ connectionId: string; database?: string; title?: string }>(payload)
        return consoleService(this.deps).open(input.connectionId, input.database, input.title)
      }
      case 'console.list':
        return consoleService(this.deps).list(as<{ connectionId: string }>(payload).connectionId)
      case 'console.close':
        await consoleService(this.deps).close(as<{ consoleId: string }>(payload).consoleId)
        return null
      case 'query.execute': {
        const input = as<QueryInput>(payload)
        this.deps.consoles?.registerRun(input.consoleId, requestId)
        try {
          return await queries.execute(requestId, input)
        } finally {
          this.deps.consoles?.clearRun(requestId)
        }
      }
      case 'query.cancel':
        queries.cancel(as<{ targetRequestId: string }>(payload).targetRequestId)
        return null
      case 'query.explain':
        return queries.explain(requestId, as<ExplainInput>(payload))
      case 'transaction.begin': {
        const { connectionId, database, consoleId } = as<{
          connectionId: string
          database?: string
          consoleId?: string
        }>(payload)
        await sessionService(this.deps).begin(connectionId, database, consoleId)
        return { connectionId, active: true } satisfies SessionStateDto
      }
      case 'transaction.commit': {
        const { connectionId, consoleId } = as<{ connectionId: string; consoleId?: string }>(payload)
        await sessionService(this.deps).commit(connectionId, consoleId)
        return { connectionId, active: false } satisfies SessionStateDto
      }
      case 'transaction.rollback': {
        const { connectionId, consoleId } = as<{ connectionId: string; consoleId?: string }>(payload)
        await sessionService(this.deps).rollback(connectionId, consoleId)
        return { connectionId, active: false } satisfies SessionStateDto
      }
      case 'transaction.run': {
        const input = as<QueryInput>(payload)
        const result = await sessionService(this.deps).run(
          input.connectionId,
          input.sql,
          input.maxRows,
          input.consoleId,
        )
        return toQueryResultDto(result)
      }
      case 'data.page':
        return toPageDto(await dataEditor.loadPage(as<DataPageInput>(payload)))
      case 'data.commit': {
        const input = as<DataCommitInput>(payload)
        const result = await dataEditor.commit({
          connectionId: input.connectionId,
          database: input.database,
          schema: input.schema,
          relation: input.relation,
          rows: input.changes,
          requestId,
        })
        return toCommitResult(result)
      }
      case 'data.export': {
        const input = as<DataExportInput>(payload)
        const targetPath = await this.deps.pickExportPath(`${input.relation}.csv`)
        if (!targetPath) return { saved: false } satisfies DataExportDto
        const result = await this.deps.exporter.exportTable({ ...input, targetPath, requestId })
        return { saved: true, path: result.path, rowCount: result.rowCount } satisfies DataExportDto
      }
      case 'object.search': {
        const result = await objectService(this.deps).search(as<ObjectSearchInput>(payload))
        const objects: ObjectRefDto[] = result.objects.map((object) => ({
          schema: object.schema,
          name: object.name,
          kind: object.kind,
        }))
        return { objects, truncated: result.truncated } satisfies ObjectSearchDto
      }
      case 'object.ddl':
        return objectService(this.deps).ddl(as<ObjectTargetInput>(payload))
      case 'object.stats':
        return objectService(this.deps).stats(as<ObjectTargetInput>(payload))
      case 'object.openInEditor': {
        if (!this.deps.openObjectDdl) {
          throw new DataForgeError('internal', 'Opening the DDL is not available in this build.')
        }
        await this.deps.openObjectDdl(as<ObjectTargetInput>(payload))
        return null
      }
      case 'import.preview':
        return importService(this.deps).preview(as<ImportPreviewInput>(payload))
      case 'import.start':
        return importService(this.deps).start(requestId, as<ImportStartInput>(payload))
      case 'import.cancel': {
        const { targetRequestId } = as<{ targetRequestId: string }>(payload)
        if (!importService(this.deps).cancel(targetRequestId)) {
          throw new DataForgeError('not_found', 'That import is not running any more.')
        }
        return null
      }
      case 'data.cancel': {
        const { targetRequestId } = as<{ targetRequestId: string }>(payload)
        if (!dataEditor.cancel(targetRequestId) && !this.deps.exporter.cancel(targetRequestId)) {
          throw new DataForgeError('not_found', 'That operation is not running any more.')
        }
        return null
      }
      case 'workbench.ready':
        return null
    }
  }
}

function as<T>(value: unknown): T {
  return value as T
}

function extractId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const id = (raw as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : undefined
}
