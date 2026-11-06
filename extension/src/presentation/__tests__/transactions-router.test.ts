import { describe, expect, it, vi } from 'vitest'

import type { DriverQueryResult } from '../../domain/driver'
import type { Logger } from '../../application/ports'
import { MessageRouter } from '../message-router'

const RESULT: DriverQueryResult = {
  columns: [{ name: 'n', dataType: 'int4' }],
  rows: [[1]],
  command: 'SELECT',
  durationMs: 3,
  truncated: false,
  affectedRows: null,
}

function setup() {
  const sessions = {
    begin: vi.fn<() => Promise<void>>(async () => undefined),
    commit: vi.fn<() => Promise<void>>(async () => undefined),
    rollback: vi.fn<() => Promise<void>>(async () => undefined),
    run: vi.fn<() => Promise<DriverQueryResult>>(async () => RESULT),
  }
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
  const router = new MessageRouter({
    connections: {} as never,
    queries: {} as never,
    dataEditor: {} as never,
    exporter: {} as never,
    pickExportPath: async () => undefined,
    logger,
    sessions: sessions as never,
  })
  return { router, sessions }
}

describe('MessageRouter transactions', () => {
  it('opens a transaction and reports it active', async () => {
    const { router, sessions } = setup()
    const response = await router.handle({ kind: 'request', id: 'r1', type: 'transaction.begin', payload: { connectionId: 'c1' } })
    expect(response).toEqual({
      kind: 'response',
      id: 'r1',
      type: 'transaction.begin',
      ok: true,
      data: { connectionId: 'c1', active: true },
    })
    expect(sessions.begin).toHaveBeenCalledWith('c1', undefined, undefined)
  })

  it('commits and reports the session closed', async () => {
    const { router, sessions } = setup()
    const response = await router.handle({ kind: 'request', id: 'r2', type: 'transaction.commit', payload: { connectionId: 'c1' } })
    expect(response).toMatchObject({ ok: true, data: { connectionId: 'c1', active: false } })
    expect(sessions.commit).toHaveBeenCalledWith('c1', undefined)
  })

  it('maps session rows to the query DTO', async () => {
    const { router, sessions } = setup()
    const response = await router.handle({
      kind: 'request',
      id: 'r3',
      type: 'transaction.run',
      payload: { connectionId: 'c1', sql: 'select 1', maxRows: 100 },
    })
    expect(response).toMatchObject({
      ok: true,
      data: { columns: [{ name: 'n', dataType: 'int4' }], rows: [[1]], rowCount: 1, command: 'SELECT' },
    })
    expect(sessions.run).toHaveBeenCalledWith('c1', 'select 1', 100, undefined)
  })

  it('rejects a malformed payload', async () => {
    const { router, sessions } = setup()
    const response = await router.handle({ kind: 'request', id: 'r4', type: 'transaction.begin', payload: {} })
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(sessions.begin).not.toHaveBeenCalled()
  })
})
