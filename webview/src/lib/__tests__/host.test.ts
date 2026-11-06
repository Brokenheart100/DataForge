import { describe, expect, it } from 'vitest'

import { host, HostRequestError } from '../host'

/**
 * jsdom has no `acquireVsCodeApi`, so the singleton bridge falls back to the
 * demo transport — the same code path the browser dev server uses.
 */
describe('HostBridge over the demo transport', () => {
  it('bootstraps protocol version, connections and preferences', async () => {
    const bootstrap = await host.ready()

    expect(bootstrap.protocolVersion).toBeGreaterThan(0)
    expect(bootstrap.connections.length).toBeGreaterThan(0)
    expect(bootstrap.prefs.maxRows).toBeGreaterThan(0)
    expect(bootstrap.connections[0]?.id).toBe('demo-0')
  })

  it('answers a query with columns, rows and a notice', async () => {
    const result = await host.request('query.execute', { connectionId: 'demo-0', sql: 'select 1', maxRows: 10 })

    expect(result.command).toBe('SELECT')
    expect(result.columns.map((column) => column.name)).toEqual(['id', 'customer', 'total', 'created_at'])
    expect(result.rows).toHaveLength(24)
    expect(result.notices[0]).toContain('Demo data')
  })

  it('keeps the caller supplied request id', async () => {
    const result = await host.request('query.execute', { connectionId: 'demo-0', sql: 'select 2', maxRows: 5 }, 'query-42')

    expect(result.rowCount).toBe(24)
  })

  it('rejects unimplemented requests with a typed error', async () => {
    await expect(host.request('connection.create', { ...demoDraft() })).rejects.toBeInstanceOf(HostRequestError)
  })
})

function demoDraft() {
  return {
    name: 'scratch',
    host: 'localhost',
    port: 5432,
    database: 'forge',
    user: 'postgres',
    password: '',
    ssl: 'disable' as const,
    readOnly: false,
  }
}
