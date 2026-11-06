import { describe, expect, it, vi } from 'vitest'

import type { ImportService } from '../../application/import-service'
import type { Logger } from '../../application/ports'
import { MessageRouter } from '../message-router'

const PREVIEW = {
  token: 'token-1',
  fileName: 'orders.csv',
  format: 'csv' as const,
  delimiter: ',',
  hasHeader: true,
  totalBytes: 128,
  headers: ['id'],
  sample: [['1']],
  mapping: [{ source: 'id', target: 'id' }],
  columns: [{ name: 'id', dataType: 'integer', nullable: false, defaultValue: null }],
  issues: [],
}

function setup() {
  const importer = {
    preview: vi.fn<ImportService['preview']>(async () => PREVIEW),
    start: vi.fn<ImportService['start']>(async () => ({ imported: 2, failed: 0, cancelled: false, errors: [], durationMs: 5 })),
    cancel: vi.fn<ImportService['cancel']>(() => true),
  }
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
  const router = new MessageRouter({
    connections: {} as never,
    queries: {} as never,
    dataEditor: {} as never,
    exporter: {} as never,
    pickExportPath: async () => undefined,
    logger,
    importer: importer as unknown as ImportService,
  })
  return { router, importer }
}

describe('MessageRouter imports', () => {
  it('previews a picked file', async () => {
    const { router, importer } = setup()
    const response = await router.handle({
      kind: 'request',
      id: 'i1',
      type: 'import.preview',
      payload: { connectionId: 'c1', schema: 'public', relation: 'orders', format: 'csv' },
    })
    expect(response).toMatchObject({ ok: true, data: { token: 'token-1', headers: ['id'] } })
    expect(importer.preview).toHaveBeenCalledWith({
      connectionId: 'c1',
      schema: 'public',
      relation: 'orders',
      format: 'csv',
    })
  })

  it('starts an import with the envelope id so it can be cancelled', async () => {
    const { router, importer } = setup()
    const response = await router.handle({
      kind: 'request',
      id: 'i2',
      type: 'import.start',
      payload: {
        connectionId: 'c1',
        schema: 'public',
        relation: 'orders',
        token: 'token-1',
        mapping: [{ source: 'id', target: 'id' }],
        batchSize: 500,
      },
    })
    expect(response).toMatchObject({ ok: true, data: { imported: 2, failed: 0 } })
    expect(importer.start).toHaveBeenCalledWith(
      'i2',
      expect.objectContaining({ token: 'token-1', batchSize: 500 }),
    )
  })

  it('rejects a malformed mapping before touching the service', async () => {
    const { router, importer } = setup()
    const response = await router.handle({
      kind: 'request',
      id: 'i3',
      type: 'import.start',
      payload: { connectionId: 'c1', schema: 'public', relation: 'orders', token: 't', mapping: 'nope' },
    })
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(importer.start).not.toHaveBeenCalled()
  })

  it('cancels a running import and reports an unknown id as not found', async () => {
    const { router, importer } = setup()
    const first = await router.handle({
      kind: 'request',
      id: 'i4',
      type: 'import.cancel',
      payload: { targetRequestId: 'i2' },
    })
    expect(first).toMatchObject({ ok: true, data: null })
    expect(importer.cancel).toHaveBeenCalledWith('i2')

    importer.cancel.mockReturnValueOnce(false)
    const second = await router.handle({
      kind: 'request',
      id: 'i5',
      type: 'import.cancel',
      payload: { targetRequestId: 'i2' },
    })
    expect(second).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })
})
