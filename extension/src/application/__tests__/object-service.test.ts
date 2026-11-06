import { describe, expect, it } from 'vitest'

import { ConnectionService } from '../connection-service'
import { ObjectService } from '../object-service'
import { MemoryConnectionStore, MemorySecretStore } from '../../test/memory-stores'
import { FakeObjectDriver } from '../../test/fake-object-driver'

const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined }

async function connectedService(driver = new FakeObjectDriver()) {
  const connections = new ConnectionService({
    store: new MemoryConnectionStore(),
    secrets: new MemorySecretStore(),
    createDriver: () => driver,
    logger: noopLogger,
  })
  await connections.initialize()
  const summary = await connections.create({
    name: 'local',
    host: '127.0.0.1',
    port: 5432,
    database: 'forge',
    user: 'postgres',
    password: 'secret',
    ssl: 'disable',
    readOnly: false,
    kind: 'postgresql',
  })
  await connections.connect(summary.id)
  return { connections, driver, connectionId: summary.id }
}

describe('ObjectService', () => {
  it('filters search results and reports truncation', async () => {
    const driver = new FakeObjectDriver()
    const { connections, connectionId } = await connectedService(driver)
    const objects = new ObjectService({ connections, logger: noopLogger })

    const all = await objects.search({ connectionId, query: 'ord' })
    expect(all.objects.map((object) => object.name)).toEqual(['orders', 'order_items'])
    expect(all.truncated).toBe(false)

    const narrow = await objects.search({ connectionId, query: 'ord', limit: 1 })
    expect(narrow.objects).toHaveLength(1)
    expect(narrow.truncated).toBe(true)
    expect(driver.searches).toEqual(['ord', 'ord'])
  })

  it('caches the DDL per scope until invalidated', async () => {
    const driver = new FakeObjectDriver()
    const { connections, connectionId } = await connectedService(driver)
    const objects = new ObjectService({ connections, logger: noopLogger })
    const target = { connectionId, schema: 'public', name: 'orders', kind: 'table' as const }

    const first = await objects.ddl(target)
    const second = await objects.ddl(target)
    expect(first.ddl).toContain('create table')
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(driver.ddlCalls).toBe(1)

    objects.invalidate(connectionId)
    await objects.ddl(target)
    expect(driver.ddlCalls).toBe(2)
  })

  it('returns index sizes and row estimates', async () => {
    const driver = new FakeObjectDriver()
    const { connections, connectionId } = await connectedService(driver)
    const objects = new ObjectService({ connections, logger: noopLogger })

    const stats = await objects.stats({ connectionId, schema: 'public', name: 'orders', kind: 'table' })
    expect(stats.totalBytes).toBe(8192)
    expect(stats.rowEstimate).toBe(42)
    expect(stats.indexes).toEqual([
      { name: 'orders_pkey', bytes: 4096, unique: true, definition: 'create unique index orders_pkey on public.orders using btree (id)' },
    ])
  })

  it('refuses drivers without a catalog and unknown relations', async () => {
    const driver = new FakeObjectDriver()
    const { connections, connectionId } = await connectedService(driver)
    const objects = new ObjectService({ connections, logger: noopLogger })

    driver.failNext = true
    await expect(objects.ddl({ connectionId, schema: 'public', name: 'missing', kind: 'table' })).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})
