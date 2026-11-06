import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ConnectionDraft, ImportMappingDto } from '@shared/protocol'

import { ConnectionService } from '../connection-service'
import { DataEditorService } from '../data-editor-service'
import { ImportService } from '../import-service'
import { SchemaService } from '../schema-service'
import type { ConnectionConfig } from '../../domain/connection'
import { PostgresDriver } from '../../infrastructure/postgres/postgres-driver'
import { MemoryConnectionStore, MemorySecretStore } from '../../test/memory-stores'

const url = process.env.DATAFORGE_TEST_PG
const suite = url ? describe : describe.skip

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
const table = `dataforge_import_${randomBytes(6).toString('hex')}`

function draftFrom(target: URL): ConnectionDraft {
  return {
    kind: 'postgresql',
    name: `import ${target.host}`,
    host: target.hostname,
    port: Number(target.port || 5432),
    database: target.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(target.username) || 'postgres',
    password: decodeURIComponent(target.password),
    ssl: 'disable',
    readOnly: false,
  }
}

suite('CSV import', () => {
  const target = url ? new URL(url) : undefined
  let directory = ''
  let connections: ConnectionService
  let connectionId = ''
  let importer: ImportService
  let pickTarget = ''
  let goodFile = ''
  let badFile = ''

  async function preview() {
    return importer.preview({
      connectionId,
      schema: 'public',
      relation: table,
      format: 'csv',
      hasHeader: true,
    })
  }

  async function startFromCurrentPick(requestId: string, mapping: ImportMappingDto[], batchSize?: number) {
    const picked = await preview()
    return importer.start(requestId, {
      connectionId,
      schema: 'public',
      relation: table,
      token: picked.token,
      mapping,
      batchSize,
    })
  }

  async function countRows(): Promise<number> {
    const driver = await connections.requireDriver(connectionId)
    const result = await driver.query({ sql: `select count(*)::int as n from public.${table}`, maxRows: 1 })
    return Number(result.rows[0]?.[0] ?? 0)
  }

  beforeAll(async () => {
    if (!target) return
    directory = await mkdtemp(join(tmpdir(), 'dataforge-import-it-'))
    goodFile = join(directory, 'good.csv')
    badFile = join(directory, 'bad.csv')
    await writeFile(goodFile, 'id,label,note\n1,one,first\n2,two,\n3,three,third\n')
    await writeFile(badFile, 'id,label\n1,one\n2,\n')

    const connectionsService = new ConnectionService({
      store: new MemoryConnectionStore(),
      secrets: new MemorySecretStore(),
      createDriver: (config: ConnectionConfig) =>
        new PostgresDriver(config, { connectTimeoutMs: 5_000, statementTimeoutMs: 5_000 }),
      logger,
    })
    connections = connectionsService
    await connections.initialize()
    connectionId = (await connections.create(draftFrom(target))).id
    await connections.connect(connectionId)
    const driver = await connections.requireDriver(connectionId)
    await driver.query({
      sql: `create table public.${table} (id integer primary key, label text not null, note text)`,
      maxRows: 1,
    })

    const schemas = new SchemaService(connections, logger)
    const editor = new DataEditorService({ connections, schemas, logger })
    importer = new ImportService({
      schemas,
      dataEditor: editor,
      logger,
      pickFile: async () => pickTarget,
    })
    pickTarget = goodFile
  })

  afterAll(async () => {
    if (!target) return
    try {
      const driver = connections ? await connections.requireDriver(connectionId) : undefined
      await driver?.query({ sql: `drop table if exists public.${table}`, maxRows: 1 })
    } catch {
      // The table may already be gone.
    }
    await connections?.dispose()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('previews the header row and maps every column', async () => {
    const picked = await preview()

    expect(picked.fileName).toBe('good.csv')
    expect(picked.headers).toEqual(['id', 'label', 'note'])
    expect(picked.mapping).toEqual([
      { source: 'id', target: 'id' },
      { source: 'label', target: 'label' },
      { source: 'note', target: 'note' },
    ])
    expect(picked.issues).toEqual([])
    expect(picked.columns.map((column) => column.name)).toEqual(['id', 'label', 'note'])
    expect(picked.token).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('streams the rows into the table through the editor', async () => {
    const picked = await preview()
    const result = await importer.start('import-it-1', {
      connectionId,
      schema: 'public',
      relation: table,
      token: picked.token,
      mapping: picked.mapping,
      batchSize: 2,
    })

    expect(result).toMatchObject({ imported: 3, failed: 0, cancelled: false, errors: [] })
    const driver = await connections.requireDriver(connectionId)
    const rows = await driver.query({
      sql: `select id, label, note from public.${table} order by id`,
      maxRows: 10,
    })
    expect(rows.rows.map((row) => [...row])).toEqual([
      [1, 'one', 'first'],
      [2, 'two', null],
      [3, 'three', 'third'],
    ])
  })

  it('reports failing rows and rolls the batch back', async () => {
    const driver = await connections.requireDriver(connectionId)
    await driver.query({ sql: `truncate public.${table}`, maxRows: 1 })
    pickTarget = badFile

    const result = await startFromCurrentPick('import-it-2', [
      { source: 'id', target: 'id' },
      { source: 'label', target: 'label' },
    ])

    expect(result.imported).toBe(0)
    expect(result.failed).toBeGreaterThan(0)
    expect(result.errors.some((error) => error.message.includes('label'))).toBe(true)
    expect(await countRows()).toBe(0)
  })
})
