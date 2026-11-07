import { describe, expect, it, vi } from 'vitest'

import type { WorkbenchStateDto } from '@shared/protocol'

import type { Logger, WorkbenchStateStore } from '../../application/ports'
import { MessageRouter } from '../message-router'

const STATE: WorkbenchStateDto = {
  activeConsoleId: 'tab-1',
  consoles: [{ key: 'tab-1', title: 'Console 1', sql: 'select 1;' }],
  view: 'sql',
}

function setup() {
  const workbench = {
    load: vi.fn<WorkbenchStateStore['load']>(async () => STATE),
    save: vi.fn<WorkbenchStateStore['save']>(async () => undefined),
  }
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
  const router = new MessageRouter({
    connections: {} as never,
    queries: {} as never,
    dataEditor: {} as never,
    exporter: {} as never,
    pickExportPath: async () => undefined,
    logger,
    workbench,
  })
  return { router, workbench }
}

describe('MessageRouter workbench session', () => {
  it('returns the stored session', async () => {
    const { router, workbench } = setup()
    const response = await router.handle({ kind: 'request', id: 'w1', type: 'workbench.load', payload: null })
    expect(response).toMatchObject({ ok: true, data: { activeConsoleId: 'tab-1' } })
    expect(workbench.load).toHaveBeenCalled()
  })

  it('saves a validated snapshot', async () => {
    const { router, workbench } = setup()
    const response = await router.handle({ kind: 'request', id: 'w2', type: 'workbench.save', payload: STATE })
    expect(response).toMatchObject({ ok: true, data: null })
    expect(workbench.save).toHaveBeenCalledWith(STATE)
  })

  it('rejects a snapshot whose console shape is wrong', async () => {
    const { router, workbench } = setup()
    const response = await router.handle({
      kind: 'request',
      id: 'w3',
      type: 'workbench.save',
      payload: { consoles: [{ key: 'k', title: 'T', sql: 42 }] },
    })
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(workbench.save).not.toHaveBeenCalled()
  })
})
