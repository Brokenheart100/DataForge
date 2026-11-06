import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ColumnInfo } from '../../domain/driver'
import type { CommitRequest, CommitRow } from '../data-editor-service'
import { convertCell, defaultMapping, ImportService } from '../import-service'
import type { ImportServiceDeps, ImportSchemaSource, ImportSink } from '../import-service'
import type { Logger } from '../ports'

const COLUMNS: ColumnInfo[] = [
  {
    name: 'id',
    dataType: 'integer',
    nullable: false,
    defaultValue: "nextval('people_id_seq'::regclass)",
    isPrimaryKey: true,
    ordinal: 1,
  },
  { name: 'name', dataType: 'text', nullable: false, defaultValue: null, isPrimaryKey: false, ordinal: 2 },
]

const logger: Logger = {
  info: vi.fn<Logger['info']>(),
  warn: vi.fn<Logger['warn']>(),
  error: vi.fn<Logger['error']>(),
}

let directory: string
let people: string
let renamed: string
let triple: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dataforge-import-'))
  people = join(directory, 'people.csv')
  renamed = join(directory, 'renamed.csv')
  triple = join(directory, 'triple.csv')
  await writeFile(people, 'id,name\n1,one\n2,two\n')
  await writeFile(renamed, 'nickname\nsomeone\n')
  await writeFile(triple, 'id,name\n1,one\n2,two\n3,three\n')
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

function setup(options: { file?: string; onCommit?: (rows: readonly CommitRow[]) => void } = {}): {
  service: ImportService
  sink: { commit: ReturnType<typeof vi.fn>; validateChanges: ReturnType<typeof vi.fn> }
  schemas: ImportSchemaSource
} {
  const sink = {
    commit: vi.fn<ImportSink['commit']>(async (request) => {
      options.onCommit?.(request.rows)
      return { inserted: request.rows.length, updated: 0, deleted: 0, returnedKeys: [] }
    }),
    validateChanges: vi.fn<ImportSink['validateChanges']>(() => []),
  }
  const schemas: ImportSchemaSource = { listColumns: async () => COLUMNS }
  const deps: ImportServiceDeps = {
    schemas,
    dataEditor: sink as unknown as ImportSink,
    logger,
    pickFile: async () => options.file ?? people,
  }
  return { service: new ImportService(deps), sink, schemas }
}

describe('convertCell', () => {
  it('maps text, numbers, booleans and empty cells', () => {
    expect(convertCell('integer', '42')).toBe(42)
    expect(convertCell('numeric', '12.5')).toBe(12.5)
    expect(convertCell('boolean', 'yes')).toBe(true)
    expect(convertCell('boolean', 'no')).toBe(false)
    expect(convertCell('text', 'one')).toBe('one')
    expect(convertCell('integer', '')).toBeNull()
    expect(convertCell('integer', 'abc')).toBe('abc')
  })
})

describe('defaultMapping', () => {
  it('matches headers to columns case-insensitively and leaves unknown headers unmapped', () => {
    expect(defaultMapping(['ID', ' name ', 'extra'], COLUMNS)).toEqual([
      { source: 'ID', target: 'id' },
      { source: ' name ', target: 'name' },
      { source: 'extra', target: null },
    ])
  })
})

describe('ImportService preview', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns headers, sample rows, mapping and an opaque token', async () => {
    const { service } = setup()
    const preview = await service.preview({
      connectionId: 'c1',
      schema: 'public',
      relation: 'people',
      format: 'csv',
    })

    expect(preview.fileName).toBe('people.csv')
    expect(preview.headers).toEqual(['id', 'name'])
    expect(preview.sample).toEqual([
      ['1', 'one'],
      ['2', 'two'],
    ])
    expect(preview.mapping).toEqual([
      { source: 'id', target: 'id' },
      { source: 'name', target: 'name' },
    ])
    expect(preview.issues).toEqual([])
    expect(preview.token).toMatch(/^[0-9a-f-]{36}$/)
    expect(preview.totalBytes).toBeGreaterThan(0)
  })

  it('reports required columns that have no source column', async () => {
    const { service } = setup({ file: renamed })
    const preview = await service.preview({
      connectionId: 'c1',
      schema: 'public',
      relation: 'people',
      format: 'csv',
      hasHeader: true,
    })
    expect(preview.headers).toEqual(['nickname'])
    expect(preview.mapping).toEqual([{ source: 'nickname', target: null }])
    expect(preview.issues.join(' ')).toContain('Required column "name" has no matching source column.')
  })

  it('rejects a file that metadata says does not exist', async () => {
    const service = new ImportService({
      schemas: { listColumns: async () => [] },
      dataEditor: { commit: vi.fn<ImportSink['commit']>(), validateChanges: vi.fn<ImportSink['validateChanges']>() } as unknown as ImportSink,
      logger,
      pickFile: async () => people,
    })
    await expect(
      service.preview({ connectionId: 'c1', schema: 'public', relation: 'gone', format: 'csv' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('ImportService start', () => {
  beforeEach(() => vi.clearAllMocks())

  it('commits the parsed rows through the data editor', async () => {
    const { service, sink } = setup()
    const preview = await service.preview({ connectionId: 'c1', schema: 'public', relation: 'people', format: 'csv' })
    const result = await service.start('import-1', {
      connectionId: 'c1',
      schema: 'public',
      relation: 'people',
      token: preview.token,
      mapping: preview.mapping,
    })

    expect(result).toMatchObject({ imported: 2, failed: 0, cancelled: false, errors: [] })
    expect(sink.commit).toHaveBeenCalledTimes(1)
    const rows = sink.commit.mock.calls[0]?.[0] as CommitRequest
    expect(rows.rows.map((row) => row.change.kind === 'insert' && row.change.values)).toEqual([
      { id: 1, name: 'one' },
      { id: 2, name: 'two' },
    ])
  })

  it('stops between batches when cancelled from the progress event', async () => {
    const commit = vi.fn<ImportSink['commit']>(async (request) => ({
      inserted: request.rows.length,
      updated: 0,
      deleted: 0,
      returnedKeys: [],
    }))
    const service = new ImportService({
      schemas: { listColumns: async () => COLUMNS },
      dataEditor: { commit, validateChanges: vi.fn<ImportSink['validateChanges']>(() => []) } as unknown as ImportSink,
      logger,
      pickFile: async () => triple,
      onProgress: (event) => {
        if (!event.done) service.cancel('import-2')
      },
    })
    const preview = await service.preview({ connectionId: 'c1', schema: 'public', relation: 'people', format: 'csv' })
    const result = await service.start('import-2', {
      connectionId: 'c1',
      schema: 'public',
      relation: 'people',
      token: preview.token,
      mapping: preview.mapping,
      batchSize: 1,
    })

    expect(result.cancelled).toBe(true)
    expect(result.imported).toBe(1)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('rejects an expired token', async () => {
    const { service } = setup()
    await expect(
      service.start('import-3', {
        connectionId: 'c1',
        schema: 'public',
        relation: 'people',
        token: 'missing',
        mapping: [],
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('cancels only a running import', () => {
    const { service } = setup()
    expect(service.cancel('unknown')).toBe(false)
  })
})
