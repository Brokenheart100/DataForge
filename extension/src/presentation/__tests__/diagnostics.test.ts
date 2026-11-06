import { describe, expect, it } from 'vitest'

import type { Logger } from '../../application/ports'
import type { QueryExecutionInfo } from '../../application/query-service'
import { createQueryDiagnostics } from '../diagnostics'

interface FakeStatusBar {
  text: string
  tooltip: string
  shown: boolean
  show: () => void
}

function setup(slowQueryMs = 1_000) {
  const statusBar: FakeStatusBar = {
    text: '',
    tooltip: '',
    shown: false,
    show: () => {
      statusBar.shown = true
    },
  }
  const logger: Logger & { warnings: string[] } = {
    warnings: [],
    info: () => undefined,
    error: () => undefined,
    warn: (message) => logger.warnings.push(message),
  }
  const report = createQueryDiagnostics({
    statusBar: statusBar as never,
    logger,
    slowQueryMs: () => slowQueryMs,
  })
  return { statusBar, logger, report }
}

function info(overrides: Partial<QueryExecutionInfo> = {}): QueryExecutionInfo {
  return {
    connectionId: 'c1',
    connectionName: 'local',
    sql: 'select 1',
    durationMs: 12,
    success: true,
    rowCount: 1,
    ...overrides,
  }
}

describe('createQueryDiagnostics', () => {
  it('shows duration and row count for a successful query', () => {
    const { statusBar, report } = setup()
    report(info())
    expect(statusBar.text).toBe('$(watch) 12 ms')
    expect(statusBar.tooltip).toBe('local · 1 row(s) · 12 ms')
    expect(statusBar.shown).toBe(true)
  })

  it('marks failures in the status bar', () => {
    const { statusBar, report } = setup()
    report(info({ success: false, rowCount: null, durationMs: 40 }))
    expect(statusBar.text).toBe('$(warning) query failed')
    expect(statusBar.tooltip).toBe('local · failed · 40 ms')
  })

  it('logs failures but not successes', () => {
    const { logger, report } = setup()
    report(info())
    expect(logger.warnings).toEqual([])
    report(info({ success: false }))
    expect(logger.warnings[0]).toContain('Query failed on local')
  })

  it('logs slow queries and marks them in the tooltip', () => {
    const { statusBar, logger, report } = setup(500)
    report(info({ durationMs: 800 }))
    expect(statusBar.tooltip).toContain('slow query')
    expect(logger.warnings[0]).toContain('Slow query on local took 800 ms')
  })

  it('treats a zero threshold as disabled', () => {
    const { statusBar, report } = setup(0)
    report(info({ durationMs: 10_000 }))
    expect(statusBar.tooltip).not.toContain('slow query')
  })

  it('does not re-render for an unknown connection name', () => {
    const { statusBar, report } = setup()
    report(info({ connectionName: '' }))
    expect(statusBar.tooltip.startsWith(' · 1 row(s)')).toBe(true)
  })

  it('never throws when the status bar is disposed', () => {
    const { report } = setup()
    expect(() => report(info())).not.toThrow()
  })
})
