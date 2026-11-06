import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ConnectionDraft } from '@shared/protocol'

import type { ConnectionCredentials, ConnectionProfile } from '../../domain/connection'
import { ConnectionService } from '../connection-service'
import { ExportService } from '../export-service'
import type { ConnectionStore, Logger, SecretStore } from '../ports'
import { SchemaService } from '../schema-service'
import { PostgresDriver } from '../../infrastructure/postgres/postgres-driver'

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

class MemoryStore implements ConnectionStore {
  private profiles: ConnectionProfile[] = []

  async load(): Promise<ConnectionProfile[]> {
    return [...this.profiles]
  }

  async save(profiles: readonly ConnectionProfile[]): Promise<void> {
    this.profiles = [...profiles]
  }
}

class MemorySecrets implements SecretStore {
  private readonly values = new Map<string, ConnectionCredentials>()

  async read(connectionId: string): Promise<ConnectionCredentials | undefined> {
    return this.values.get(connectionId)
  }

  async write(connectionId: string, credentials: ConnectionCredentials): Promise<void> {
    this.values.set(connectionId, credentials)
  }

  async delete(connectionId: string): Promise<void> {
    this.values.delete(connectionId)
  }
}

const url = process.env.DATAFORGE_TEST_PG
const suite = url ? describe : describe.skip

suite('ExportService against a live server', () => {
  const table = `dataforge_export_${Math.random().toString(16).slice(2, 14)}`
  const connections = new ConnectionService({
    store: new MemoryStore(),
    secrets: new MemorySecrets(),
    createDriver: (config) =>
      new PostgresDriver(config, {
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 5_000,
        onBackgroundError: (message) => logger.warn(message),
      }),
    logger,
  })
  const schemas = new SchemaService(connections, logger)
  const exporter = new ExportService({ connections, schemas, logger })
  let connectionId = ''
  let directory = ''

  beforeAll(async () => {
    const target = new URL(url ?? 'postgres://postgres@127.0.0.1:5432/postgres')
    const draft: ConnectionDraft = {
      name: 'export target',
      host: target.hostname,
      port: Number(target.port || 5432),
      database: target.pathname.slice(1) || 'postgres',
      user: decodeURIComponent(target.username) || 'postgres',
      password: decodeURIComponent(target.password),
      ssl: 'disable',
      readOnly: false,
    }
    await connections.initialize()
    const summary = await connections.create(draft)
    connectionId = summary.id
    await connections.connect(connectionId)

    const driver = connections.requireDriver(connectionId)
    await driver.query({ sql: `create table public."${table}" (id int primary key, label text, note text)`, maxRows: 1 })
    await driver.query({
      sql: `insert into public."${table}" (id, label, note) select g, 'label ' || g, case when g = 2 then 'a,b' when g = 3 then 'say "hi"' end from generate_series(1, 2500) g`,
      maxRows: 1,
    })
    directory = await mkdtemp(join(tmpdir(), 'dataforge-export-'))
  })

  afterAll(async () => {
    if (table) await connections.requireDriver(connectionId).query({ sql: `drop table if exists public."${table}"`, maxRows: 1 })
    await connections.dispose()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('streams every row into a CSV file', async () => {
    const path = join(directory, 'export.csv')
    const result = await exporter.exportTable({ connectionId, schema: 'public', relation: table, targetPath: path })

    expect(result).toMatchObject({ path, rowCount: 2500 })
    expect(result.bytes).toBeGreaterThan(0)

    const text = await readFile(path, 'utf8')
    const lines = text.split('\r\n')
    expect(lines[0]).toBe('id,label,note')
    expect(lines[1]).toBe('1,label 1,')
    expect(lines[2]).toBe('2,label 2,"a,b"')
    expect(lines[3]).toBe('3,label 3,"say ""hi"""')
    expect(lines.filter((line) => line.length > 0)).toHaveLength(2501)
  })

  it('fails for a relation that does not exist', async () => {
    await expect(
      exporter.exportTable({ connectionId, schema: 'public', relation: `${table}_missing`, targetPath: join(directory, 'x.csv') }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('aborts a running export and deletes the partial file', async () => {
    const big = `${table}_big`
    const driver = connections.requireDriver(connectionId)
    await driver.query({ sql: `create table public."${big}" (id int primary key, label text)`, maxRows: 1 })
    await driver.query({
      sql: `insert into public."${big}" (id, label) select g, 'row ' || g from generate_series(1, 300000) g`,
      maxRows: 1,
    })

    const path = join(directory, 'cancelled.csv')
    const requestId = crypto.randomUUID()
    const pending = exporter.exportTable({ connectionId, schema: 'public', relation: big, targetPath: path, requestId })

    let cancelled = false
    for (let attempt = 0; attempt < 2_000 && !cancelled; attempt += 1) {
      cancelled = exporter.cancel(requestId)
      if (!cancelled) await new Promise((resolve) => setTimeout(resolve, 1))
    }

    expect(cancelled).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await expect(stat(path)).rejects.toThrow('ENOENT')
    expect(exporter.cancel(requestId)).toBe(false)

    await driver.query({ sql: `drop table public."${big}"`, maxRows: 1 })
  })
})
