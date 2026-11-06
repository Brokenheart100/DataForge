import { describe, expect, it, vi } from 'vitest'

import type { SessionListDto, SessionListInput, SessionTerminateInput } from '@shared/protocol'

import type { SessionMonitor } from '../../application/session-monitor'
import { MessageRouter } from '../message-router'

const LIST: SessionListDto = {
  longRunningMs: 60_000,
  currentUser: 'analytics',
  sessions: [{ id: '42', user: 'analytics', durationMs: 1_000, longRunning: false }],
}

function setup() {
  const monitor = {
    list: vi.fn<SessionMonitor['list']>(async () => LIST),
    terminate: vi.fn<SessionMonitor['terminate']>(async ({ sessionId }) => ({ sessionId })),
  }
  const router = new MessageRouter({
    connections: {} as never,
    queries: {} as never,
    dataEditor: {} as never,
    exporter: {} as never,
    pickExportPath: async () => undefined,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    monitor: monitor as unknown as SessionMonitor,
  })
  return { router, monitor }
}

describe('MessageRouter sessions', () => {
  it('lists sessions through the monitor', async () => {
    const { router, monitor } = setup()
    const payload: SessionListInput = { connectionId: 'c1', database: 'analytics' }
    const response = await router.handle({ kind: 'request', id: 's1', type: 'session.list', payload } as never)
    expect(response).toMatchObject({ ok: true, type: 'session.list', data: LIST })
    expect(monitor.list).toHaveBeenCalledWith(payload)
  })

  it('terminates a session after confirmation', async () => {
    const { router, monitor } = setup()
    const payload: SessionTerminateInput = { connectionId: 'c1', sessionId: '42', confirm: true }
    const response = await router.handle({ kind: 'request', id: 's2', type: 'session.terminate', payload } as never)
    expect(response).toMatchObject({ ok: true, type: 'session.terminate', data: { sessionId: '42' } })
    expect(monitor.terminate).toHaveBeenCalledWith(payload)
  })

  it('rejects a termination without a confirmation flag', async () => {
    const { router, monitor } = setup()
    const response = await router.handle({
      kind: 'request',
      id: 's3',
      type: 'session.terminate',
      payload: { connectionId: 'c1', sessionId: '42' },
    } as never)
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(monitor.terminate).not.toHaveBeenCalled()
  })
})
