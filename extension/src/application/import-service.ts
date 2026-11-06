import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'

import { parse as parseCsv } from 'csv-parse'
import { parse as parseCsvSync } from 'csv-parse/sync'

import type {
  CellValue,
  ImportColumnDto,
  ImportErrorDto,
  ImportFormat,
  ImportMappingDto,
  ImportPreviewDto,
  ImportProgressEvent,
  ImportResultDto,
  ImportStartInput,
} from '@shared/protocol'

import { DataForgeError, wrapError } from '../domain/errors'
import type { ColumnInfo } from '../domain/driver'
import type { ChangeIssue, CommitRequest, CommitResult, CommitRow } from './data-editor-service'
import type { Logger } from './ports'

/** The metadata the preview needs; SchemaService satisfies it. */
export interface ImportSchemaSource {
  listColumns(connectionId: string, schema: string, relation: string, database?: string): Promise<ColumnInfo[]>
}

/** Where imported rows land; DataEditorService satisfies it. */
export interface ImportSink {
  commit(request: CommitRequest): Promise<CommitResult>
  validateChanges(columns: readonly ColumnInfo[], rows: readonly CommitRow[]): readonly ChangeIssue[]
}

const PREVIEW_BYTES = 256 * 1024
const PREVIEW_ROWS = 50
const DEFAULT_BATCH_SIZE = 1_000
const MAX_BATCH_SIZE = 5_000
const MAX_ERRORS = 100
const MAX_JSON_BYTES = 64 * 1024 * 1024
const TOKEN_TTL_MS = 10 * 60_000
const INTEGER_TYPES = /^(int|serial|smallint|bigint|mediumint|tinyint)/
const NUMERIC_TYPES = /^(numeric|decimal|real|double|float|money)/

/** What a preview needs; the file itself is chosen by the host. */
export interface ImportPreviewRequest {
  readonly connectionId: string
  readonly database?: string
  readonly schema: string
  readonly relation: string
  readonly format: ImportFormat
  readonly delimiter?: string
  readonly hasHeader?: boolean
}

export interface ImportServiceDeps {
  readonly schemas: ImportSchemaSource
  readonly dataEditor: ImportSink
  readonly logger: Logger
  /** Opens the host file picker; `undefined` means the user cancelled. */
  readonly pickFile: (format: ImportFormat) => Promise<string | undefined>
  readonly onProgress?: (event: ImportProgressEvent) => void
}

interface PickedFile {
  readonly path: string
  readonly fileName: string
  readonly format: ImportFormat
  readonly delimiter: string
  readonly hasHeader: boolean
  readonly headers: readonly string[]
  readonly columns: readonly ImportColumnDto[]
  readonly pickedAt: number
}

interface TargetColumn {
  readonly name: string
  readonly dataType: string
}

interface ParsedRecord {
  readonly row: number
  readonly cells: readonly string[]
}

/** Converts one CSV/JSON cell according to the target column type. */
export function convertCell(dataType: string, cell: string): CellValue {
  if (cell === '') return null
  const type = dataType.toLowerCase()
  if (INTEGER_TYPES.test(type) || NUMERIC_TYPES.test(type)) {
    const numeric = Number(cell)
    return Number.isFinite(numeric) ? numeric : cell
  }
  if (/bool/.test(type)) {
    const lower = cell.trim().toLowerCase()
    if (['true', 't', '1', 'yes'].includes(lower)) return true
    if (['false', 'f', '0', 'no'].includes(lower)) return false
  }
  return cell
}

/** Default mapping: match headers to columns by name, case-insensitively. */
export function defaultMapping(headers: readonly string[], columns: readonly ImportColumnDto[]): ImportMappingDto[] {
  const byName = new Map(columns.map((column) => [column.name.toLowerCase(), column.name]))
  return headers.map((header) => ({ source: header, target: byName.get(header.trim().toLowerCase()) ?? null }))
}

export class ImportService {
  private readonly tokens = new Map<string, PickedFile>()
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly deps: ImportServiceDeps) {}

  /** Picks a file, then returns its header row, first rows and default mapping. */
  async preview(request: ImportPreviewRequest): Promise<ImportPreviewDto> {
    const path = await this.deps.pickFile(request.format)
    if (!path) throw new DataForgeError('cancelled', 'No file was chosen.')

    try {
      const info = await stat(path)
      if (!info.isFile()) throw new DataForgeError('invalid_request', 'That path is not a file.')
      const fileName = path.split(/[\\/]/).pop() ?? path
      const format: ImportFormat = fileName.toLowerCase().endsWith('.json') ? 'json' : request.format
      const delimiter = request.delimiter && request.delimiter.length > 0 ? request.delimiter : ','
      const hasHeader = request.hasHeader ?? true

      const columnInfo = await this.deps.schemas.listColumns(
        request.connectionId,
        request.schema,
        request.relation,
        request.database,
      )
      if (columnInfo.length === 0) {
        throw new DataForgeError('not_found', `Relation "${request.schema}.${request.relation}" no longer exists.`)
      }
      const columns: ImportColumnDto[] = columnInfo.map((column) => ({
        name: column.name,
        dataType: column.dataType,
        nullable: column.nullable,
        defaultValue: column.defaultValue,
      }))

      const { headers, sample } = await this.readSample(path, format, delimiter, hasHeader, info.size)
      const mapping = defaultMapping(headers, columns)
      const token = randomUUID()
      this.tokens.set(token, {
        path,
        fileName,
        format,
        delimiter,
        hasHeader,
        headers,
        columns,
        pickedAt: Date.now(),
      })
      this.pruneTokens()

      return {
        token,
        fileName,
        format,
        delimiter,
        hasHeader,
        totalBytes: info.size,
        headers,
        sample,
        mapping,
        columns,
        issues: mappingIssues(mapping, columns),
      }
    } catch (cause) {
      if (cause instanceof DataForgeError) throw cause
      throw wrapError('invalid_request', 'Reading the import file', cause)
    }
  }

  /** Streams the previewed file into the relation in batches of up to 5 000 rows. */
  async start(requestId: string, request: ImportStartInput): Promise<ImportResultDto> {
    const file = this.tokens.get(request.token)
    if (!file) throw new DataForgeError('not_found', 'That import preview expired. Choose the file again.')
    this.tokens.delete(request.token)

    if (this.controllers.has(requestId)) throw new DataForgeError('invalid_request', 'That import is already running.')
    const controller = new AbortController()
    this.controllers.set(requestId, controller)

    const startedAt = Date.now()
    const errors: ImportErrorDto[] = []
    let processed = 0
    let inserted = 0
    let failed = 0
    let batch: CommitRow[] = []
    let firstRow = 1
    const batchSize = clampBatch(request.batchSize)

    try {
      const targets = resolveTargets(file, request.mapping)
      const missing = requiredColumnsMissing(targets, file.columns)
      if (missing.length > 0) {
        throw new DataForgeError(
          'invalid_request',
          `These required columns have no mapped source: ${missing.join(', ')}.`,
        )
      }

      const flush = async (): Promise<boolean> => {
        if (batch.length === 0) return true
        const outcome = await this.flush(request, file, batch, firstRow, errors, controller.signal)
        inserted += outcome.inserted
        failed += outcome.failed
        this.report(requestId, file.fileName, processed, inserted, failed, false)
        batch = []
        firstRow = processed + 1
        return !outcome.aborted
      }

      for await (const record of this.records(file, controller.signal)) {
        if (controller.signal.aborted) break
        processed = record.row
        const row = buildRow(record, targets)
        if (row) batch.push(row)
        if (batch.length >= batchSize && !(await flush())) break
      }

      if (!controller.signal.aborted && errors.length === 0) await flush()

      const cancelled = controller.signal.aborted
      this.report(requestId, file.fileName, processed, inserted, failed, true)
      this.deps.logger.info(
        `Imported ${inserted} row(s) from ${file.fileName} into ${request.schema}.${request.relation}`,
      )
      return { imported: inserted, failed, cancelled, errors: errors.slice(0, MAX_ERRORS), durationMs: Date.now() - startedAt }
    } catch (cause) {
      if (controller.signal.aborted) {
        return { imported: inserted, failed, cancelled: true, errors, durationMs: Date.now() - startedAt }
      }
      throw wrapError('internal', `Importing ${file.fileName}`, cause)
    } finally {
      this.controllers.delete(requestId)
    }
  }

  /** Aborts a running import between batches. */
  cancel(requestId: string): boolean {
    const controller = this.controllers.get(requestId)
    if (!controller) return false
    controller.abort()
    return true
  }

  private async flush(
    request: ImportStartInput,
    file: PickedFile,
    batch: CommitRow[],
    firstRow: number,
    errors: ImportErrorDto[],
    signal: AbortSignal,
  ): Promise<{ inserted: number; failed: number; aborted: boolean }> {
    if (signal.aborted) return { inserted: 0, failed: 0, aborted: true }
    try {
      const result = await this.deps.dataEditor.commit({
        connectionId: request.connectionId,
        database: request.database,
        schema: request.schema,
        relation: request.relation,
        rows: batch,
      })
      return { inserted: result.inserted, failed: 0, aborted: false }
    } catch (cause) {
      if (signal.aborted) return { inserted: 0, failed: 0, aborted: true }
      if (isValidationError(cause)) {
        const columns = file.columns.map((column) => ({
          name: column.name,
          dataType: column.dataType,
          nullable: column.nullable,
          defaultValue: column.defaultValue,
          isPrimaryKey: false,
          ordinal: 0,
        }))
        const issues = this.deps.dataEditor.validateChanges(columns, batch)
        for (const issue of issues.slice(0, MAX_ERRORS - errors.length)) {
          const index = batch.findIndex((row) => row.rowId === issue.rowId)
          errors.push({ row: firstRow + Math.max(0, index), message: `${issue.column}: ${issue.message}` })
        }
      } else {
        errors.push({ row: firstRow, message: firstLine(cause instanceof Error ? cause.message : String(cause)) })
      }
      return { inserted: 0, failed: batch.length, aborted: true }
    }
  }

  private report(
    requestId: string,
    fileName: string,
    processed: number,
    inserted: number,
    failed: number,
    done: boolean,
  ): void {
    this.deps.onProgress?.({ requestId, fileName, processed, inserted, failed, done })
  }

  private async readSample(
    path: string,
    format: ImportFormat,
    delimiter: string,
    hasHeader: boolean,
    size: number,
  ): Promise<{ headers: string[]; sample: string[][] }> {
    if (format === 'json') {
      if (size > MAX_JSON_BYTES) {
        throw new DataForgeError(
          'invalid_request',
          `JSON import is limited to ${Math.round(MAX_JSON_BYTES / 1024 / 1024)} MB; this file is larger. Convert it to CSV.`,
        )
      }
      const records = parseJsonRecords(await readFile(path, 'utf8'))
      const headers = [...new Set(records.flatMap((record) => Object.keys(record)))]
      return {
        headers,
        sample: records.slice(0, PREVIEW_ROWS).map((record) => headers.map((header) => jsonCell(record[header]))),
      }
    }

    const contents = await readFile(path)
    const head = contents.subarray(0, Math.min(contents.length, PREVIEW_BYTES))
    const parsed = parseCsvSync(head, {
      delimiter,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      to: hasHeader ? PREVIEW_ROWS + 1 : PREVIEW_ROWS,
    }) as unknown as string[][]
    const first = parsed[0] ?? []
    const headers = hasHeader ? first.map((cell) => String(cell).trim()) : first.map((_cell, index) => `column ${index + 1}`)
    const rows = hasHeader ? parsed.slice(1) : parsed
    return { headers, sample: rows.slice(0, PREVIEW_ROWS).map((row) => row.map((cell) => String(cell ?? ''))) }
  }

  private async *records(file: PickedFile, signal: AbortSignal): AsyncGenerator<ParsedRecord> {
    if (file.format === 'json') {
      const records = parseJsonRecords(await readFile(file.path, 'utf8'))
      for (let index = 0; index < records.length; index += 1) {
        if (signal.aborted) return
        const record = records[index] ?? {}
        yield { row: index + 1, cells: file.headers.map((header) => jsonCell(record[header])) }
      }
      return
    }

    const parser = createReadStream(file.path).pipe(
      parseCsv({
        delimiter: file.delimiter,
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
        columns: false,
      }),
    )
    let dataRow = 0
    let first = true
    for await (const record of parser) {
      if (signal.aborted) return
      if (first) {
        first = false
        if (file.hasHeader) continue
      }
      dataRow += 1
      yield { row: dataRow, cells: (record as string[]).map((cell) => String(cell ?? '')) }
    }
  }

  private pruneTokens(): void {
    const now = Date.now()
    for (const [token, file] of this.tokens) {
      if (now - file.pickedAt > TOKEN_TTL_MS) this.tokens.delete(token)
    }
  }
}

function resolveTargets(file: PickedFile, mapping: readonly ImportMappingDto[]): TargetColumn[] {
  const known = new Map(file.columns.map((column) => [column.name, column]))
  const targets = mapping
    .map((entry) => (entry.target === null ? undefined : known.get(entry.target)))
    .filter((column): column is ImportColumnDto => column !== undefined)
  const names = targets.map((column) => column.name)
  if (new Set(names).size !== names.length) {
    throw new DataForgeError('invalid_request', 'Two source columns point at the same target column.')
  }
  return targets.map((column) => ({ name: column.name, dataType: column.dataType }))
}

function requiredColumnsMissing(targets: readonly TargetColumn[], columns: readonly ImportColumnDto[]): string[] {
  const mapped = new Set(targets.map((entry) => entry.name))
  return columns
    .filter((column) => !column.nullable && column.defaultValue === null && !mapped.has(column.name))
    .map((column) => column.name)
}

function mappingIssues(mapping: readonly ImportMappingDto[], columns: readonly ImportColumnDto[]): string[] {
  const issues: string[] = []
  const mapped = new Set(mapping.map((entry) => entry.target).filter((target): target is string => target !== null))
  for (const column of columns) {
    if (!column.nullable && column.defaultValue === null && !mapped.has(column.name)) {
      issues.push(`Required column "${column.name}" has no matching source column.`)
    }
  }
  const counts = new Map<string, number>()
  for (const entry of mapping) {
    if (entry.target === null) continue
    counts.set(entry.target, (counts.get(entry.target) ?? 0) + 1)
  }
  for (const [target, count] of counts) {
    if (count > 1) issues.push(`Column "${target}" is mapped from ${count} source columns.`)
  }
  return issues
}

function buildRow(record: ParsedRecord, targets: readonly TargetColumn[]): CommitRow | null {
  if (record.cells.length === 0) return null
  const values: Record<string, CellValue> = {}
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]
    if (!target) continue
    values[target.name] = convertCell(target.dataType, record.cells[index] ?? '')
  }
  return { rowId: `import-${record.row}`, version: null, change: { kind: 'insert', values } }
}

function jsonCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function firstLine(message: string): string {
  const [line] = message.split('\n')
  return (line ?? message).slice(0, 300)
}

function isValidationError(cause: unknown): boolean {
  return cause instanceof DataForgeError && cause.code === 'invalid_request'
}

function clampBatch(size: number | undefined): number {
  if (!size || !Number.isFinite(size)) return DEFAULT_BATCH_SIZE
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.trunc(size)))
}

function parseJsonRecords(text: string): Record<string, unknown>[] {
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new DataForgeError('invalid_request', 'The JSON file could not be parsed. Expected an array of objects.')
  }
  if (!Array.isArray(parsed)) {
    throw new DataForgeError('invalid_request', 'The JSON file must contain an array of objects.')
  }
  return parsed.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
}
