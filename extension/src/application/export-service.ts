import { createWriteStream } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'

import type { DatabaseDriver, TableExportDriver } from '../domain/driver'
import { DataForgeError, wrapError } from '../domain/errors'
import { CsvWriter } from '../infrastructure/export/csv'
import type { ConnectionService } from './connection-service'
import type { Logger } from './ports'
import type { SchemaService } from './schema-service'

/** Rows per round trip; small enough to keep memory flat, large enough to be fast. */
const EXPORT_BATCH_SIZE = 1_000

export interface ExportRequest {
  readonly connectionId: string
  /** A secondary database of the same connection; omitted means its own database. */
  readonly database?: string
  readonly schema: string
  readonly relation: string
  readonly targetPath: string
  /** Envelope request id; registered so `cancel` can abort this export. */
  readonly requestId?: string
}

export interface ExportResult {
  readonly path: string
  readonly rowCount: number
  readonly bytes: number
}

export interface ExportServiceDeps {
  readonly connections: ConnectionService
  readonly schemas: SchemaService
  readonly logger: Logger
}

/**
 * Bulk reads are a driver capability: a driver without `exportTable` stays a
 * valid connection but cannot export.
 */
export function isTableExportDriver(driver: DatabaseDriver): driver is TableExportDriver {
  return typeof (driver as Partial<TableExportDriver>).exportTable === 'function'
}

/**
 * Writes a relation to a CSV file without ever holding the whole table in
 * memory: the driver streams batches, this service appends them to disk.
 */
export class ExportService {
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly deps: ExportServiceDeps) {}

  /** Aborts a running export by request id; `false` when it already finished. */
  cancel(requestId: string): boolean {
    const controller = this.controllers.get(requestId)
    if (!controller) return false
    controller.abort()
    return true
  }

  async exportTable(request: ExportRequest): Promise<ExportResult> {
    const controller = request.requestId === undefined ? undefined : new AbortController()
    if (request.requestId !== undefined && controller) this.controllers.set(request.requestId, controller)
    try {
      return await this.streamTable(request, controller?.signal)
    } finally {
      if (request.requestId !== undefined) this.controllers.delete(request.requestId)
    }
  }

  private async streamTable(request: ExportRequest, signal?: AbortSignal): Promise<ExportResult> {
    const driver = await this.requireDriver(request.connectionId, request.database)
    const { schemas, logger } = this.deps

    const columns = await schemas.listColumns(request.connectionId, request.schema, request.relation, request.database)
    if (columns.length === 0) {
      throw new DataForgeError('not_found', `Relation "${request.schema}.${request.relation}" no longer exists.`)
    }

    const writer = new CsvWriter()
    const stream = createWriteStream(request.targetPath, { encoding: 'utf8' })

    try {
      await write(stream, writer.writeRow(columns.map((column) => column.name)))
      const result = await driver.exportTable(
        {
          schema: request.schema,
          relation: request.relation,
          batchSize: EXPORT_BATCH_SIZE,
          signal,
        },
        async (rows) => {
          if (signal?.aborted) throw new DataForgeError('cancelled', 'The export was cancelled.')
          if (rows.length > 0) await write(stream, writer.writeRows(rows))
        },
      )
      await close(stream)

      const { size } = await stat(request.targetPath)
      logger.info(
        `Exported ${result.rowCount} row(s) from ${request.schema}.${request.relation} to ${request.targetPath}`,
      )
      return { path: request.targetPath, rowCount: result.rowCount, bytes: size }
    } catch (error) {
      await discard(stream, request.targetPath)
      if (error instanceof DataForgeError) throw error
      throw wrapError('internal', 'Exporting data', error)
    }
  }

  private async requireDriver(connectionId: string, database?: string): Promise<TableExportDriver> {
    const driver = await this.deps.connections.requireScopedDriver(connectionId, database)
    if (!isTableExportDriver(driver)) {
      throw new DataForgeError('internal', 'This connection does not support CSV export yet.')
    }
    return driver
  }
}

/** Awaits the write callback, which only fires once the OS has taken the chunk. */
function write(stream: WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()))
  })
}

function close(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('error', reject)
    stream.end(() => resolve())
  })
}

async function discard(stream: WriteStream, targetPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    stream.destroy()
    stream.once('close', () => resolve())
    if (stream.closed) resolve()
  })
  await unlink(targetPath).catch(() => undefined)
}
