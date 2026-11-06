import { describe, expect, it, vi } from 'vitest'

import type { ServerSessionInfo, SessionDriver } from '../../domain/driver'
import type { ConnectionService } from '../connection-service'
import type { Logger } from '../ports'
import { SessionMonitor } from '../session-monitor'

function session(overrides: Partial<ServerSessionInfo> = {}): ServerSessionInfo {
  return {
    id: '42',
    user: 'analytics',
    database: 'analytics',
    state: 'active',
    durationMs: 5_000,
    query: 'select 1',
    ...overrides,
  }
}

function setup(overrides: Partial<SessionDriver> = {}) {
  const driver = {
    listSessions: vi.fn<SessionDriver['listSessions']>(async () => [session()]),
    terminateSession: vi.fn<SessionDriver['terminateSession']>(async () => undefined),
    currentUser: vi.fn<SessionDriver['currentUser']>(async () => 'analytics'),
    ...overrides,
  } as unknown as SessionDriver
  const connections = {
    requireScopedDriver: vi.fn<ConnectionService['requireScopedDriver']>(async () => driver),
  } as unknown as ConnectionService
  const logger = {
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
  }
  const monitor = new SessionMonitor({ connections, logger, longRunningMs: 60_000 })
  return { monitor, driver, connections, logger }
}

describe('SessionMonitor', () => {
  it('lists sessions and flags long-running ones', async () => {
    const { monitor, driver } = setup({
      listSessions: vi.fn<SessionDriver['listSessions']>(async () => [
        session(),
        session({ id: '43', durationMs: 120_000 }),
        session({ id: '44', durationMs: undefined }),
      ]),
    })
    const result = await monitor.list({ connectionId: 'c1', database: 'analytics' })
    expect(driver.listSessions).toHaveBeenCalledOnce()
    expect(result.currentUser).toBe('analytics')
    expect(result.longRunningMs).toBe(60_000)
    expect(result.sessions.map((item) => [item.id, item.longRunning])).toEqual([
      ['42', false],
      ['43', true],
      ['44', false],
    ])
  })

  it('refuses to terminate without confirmation', async () => {
    const { monitor, driver } = setup()
    await expect(
      monitor.terminate({ connectionId: 'c1', sessionId: '42', confirm: false }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(driver.terminateSession).not.toHaveBeenCalled()
  })

  it('reports a missing session', async () => {
    const { monitor } = setup()
    await expect(
      monitor.terminate({ connectionId: 'c1', sessionId: '99', confirm: true }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses sessions owned by another role', async () => {
    const { monitor, driver } = setup({
      listSessions: vi.fn<SessionDriver['listSessions']>(async () => [
        session({ user: 'someone-else' }),
      ]),
    })
    await expect(
      monitor.terminate({ connectionId: 'c1', sessionId: '42', confirm: true }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(driver.terminateSession).not.toHaveBeenCalled()
  })

  it('terminates an owned session', async () => {
    const { monitor, driver, logger } = setup()
    await expect(
      monitor.terminate({ connectionId: 'c1', sessionId: '42', confirm: true }),
    ).resolves.toEqual({ sessionId: '42' })
    expect(driver.terminateSession).toHaveBeenCalledWith('42')
    expect(logger.info).toHaveBeenCalled()
  })

  it('reports drivers without session support', async () => {
    const { monitor } = setup({ listSessions: undefined })
    await expect(monitor.list({ connectionId: 'c1' })).rejects.toMatchObject({ code: 'internal' })
  })
})
