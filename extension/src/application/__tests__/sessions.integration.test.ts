import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Client } from 'pg'

import type { ConnectionDraft } from '@shared/protocol'

import { ConnectionService } from '../connection-service'
import { SessionMonitor } from '../session-monitor'
import type { ConnectionConfig } from '../../domain/connection'
import { PostgresDriver } from '../../infrastructure/postgres/postgres-driver'
import { MemoryConnectionStore, MemorySecretStore } from '../../test/memory-stores'

const url = process.env.DATAFORGE_TEST_PG
const suite = url ? describe : describe.skip

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

function draftFrom(target: URL): ConnectionDraft {
  return {
    kind: 'postgresql',
    name: `sessions ${target.host}`,
    host: target.hostname,
    port: Number(target.port || 5432),
    database: target.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(target.username) || 'postgres',
    password: decodeURIComponent(target.password),
    ssl: 'disable',
    readOnly: false,
  }
}

suite('SessionMonitor', () => {
  const target = url ? new URL(url) : undefined
  let connections: ConnectionService
  let monitor: SessionMonitor
  let connectionId = ''
  let other: Client | undefined

  beforeAll(async () => {
    if (!target) return
    connections = new ConnectionService({
      store: new MemoryConnectionStore(),
      secrets: new MemorySecretStore(),
      createDriver: (config: ConnectionConfig) =>
        new PostgresDriver(config, { connectTimeoutMs: 5_000, statementTimeoutMs: 5_000 }),
      logger,
    })
    const summary = await connections.create(draftFrom(target))
    connectionId = summary.id
    await connections.connect(connectionId)
    monitor = new SessionMonitor({ connections, logger, longRunningMs: 1_000 })

    other = new Client({ connectionString: url })
    // The terminated backend emits an `error` event; the test asserts the
    // termination through pg_stat_activity instead of the client callback.
    other.on('error', () => undefined)
    await other.connect()
    // Keep the second backend visibly busy so pg_stat_activity reports a query.
    void other.query('select pg_sleep(30)').catch(() => undefined)
  })

  afterAll(async () => {
    await connections?.disconnect(connectionId).catch(() => undefined)
    await connections?.dispose().catch(() => undefined)
    await other?.end().catch(() => undefined)
  })

  async function findSleeping(): Promise<string | undefined> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await monitor.list({ connectionId })
      const session = result.sessions.find((candidate) => candidate.query?.includes('pg_sleep(30)'))
      if (session) return session.id
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return undefined
  }

  it('lists another backend and terminates it', async () => {
    const sessionId = await findSleeping()
    expect(sessionId).toBeDefined()
    if (!sessionId) return

    await expect(
      monitor.terminate({ connectionId, sessionId, confirm: false }),
    ).rejects.toMatchObject({ code: 'invalid_request' })

    await expect(
      monitor.terminate({ connectionId, sessionId, confirm: true }),
    ).resolves.toEqual({ sessionId })

    let gone = false
    for (let attempt = 0; attempt < 40 && !gone; attempt += 1) {
      const result = await monitor.list({ connectionId })
      gone = !result.sessions.some((candidate) => candidate.id === sessionId)
      if (!gone) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(gone).toBe(true)
  })
})
