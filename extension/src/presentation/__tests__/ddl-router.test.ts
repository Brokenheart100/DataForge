import { describe, expect, it, vi } from 'vitest'

import type { DdlPlanDto, DdlPreviewDto, SchemaDiffInput } from '@shared/protocol'

import type { DdlService } from '../../application/ddl-service'
import { MessageRouter } from '../message-router'

const PLAN: DdlPlanDto = {
  kind: 'create table',
  connectionId: 'c1',
  schema: 'public',
  table: 'orders',
  columns: [{ name: 'id', dataType: 'integer', nullable: false, primaryKey: true }],
}

const PREVIEW: DdlPreviewDto = {
  statements: [{ sql: 'create table "public"."orders" ("id" integer not null primary key);', risk: 'safe' }],
  requiresConfirmation: false,
  expectedConfirmation: null,
  warnings: [],
}

function setup() {
  const ddl = {
    preview: vi.fn<DdlService['preview']>(() => PREVIEW),
    apply: vi.fn<DdlService['apply']>(async () => ({ statements: 1, durationMs: 4 })),
    diff: vi.fn<DdlService['diff']>(async () => ({ added: [], removed: [], changed: [] })),
  }
  const opened: string[] = []
  const router = new MessageRouter({
    connections: {} as never,
    queries: {} as never,
    dataEditor: {} as never,
    exporter: {} as never,
    pickExportPath: async () => undefined,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    ddl: ddl as unknown as DdlService,
    openDdlDocument: async (sql) => {
      opened.push(sql)
    },
  })
  return { router, ddl, opened }
}

describe('MessageRouter DDL', () => {
  it('previews a plan through the service', async () => {
    const { router, ddl } = setup()
    const response = await router.handle({
      kind: 'request',
      id: 'd1',
      type: 'ddl.preview',
      payload: PLAN,
    } as never)

    expect(response).toMatchObject({ ok: true, type: 'ddl.preview', data: PREVIEW })
    expect(ddl.preview).toHaveBeenCalledWith(PLAN)
  })

  it('passes the confirmation through to apply', async () => {
    const { router, ddl } = setup()
    const response = await router.handle({
      kind: 'request',
      id: 'd2',
      type: 'ddl.apply',
      payload: { plan: PLAN, confirm: 'orders' },
    } as never)

    expect(response).toMatchObject({ ok: true, type: 'ddl.apply' })
    expect(ddl.apply).toHaveBeenCalledWith({ plan: PLAN, confirm: 'orders' })
  })

  it('rejects malformed plans before the service runs', async () => {
    const { router, ddl } = setup()
    const response = await router.handle({
      kind: 'request',
      id: 'd3',
      type: 'ddl.preview',
      payload: { ...PLAN, columns: [] },
    } as never)

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(ddl.preview).not.toHaveBeenCalled()
  })

  it('opens the preview statements as one document', async () => {
    const { router, ddl, opened } = setup()
    ddl.preview.mockReturnValue({
      ...PREVIEW,
      statements: [
        { sql: 'create table a (id integer);', risk: 'safe' },
        { sql: 'create index a_id on a (id);', risk: 'caution' },
      ],
    })

    const response = await router.handle({
      kind: 'request',
      id: 'd4',
      type: 'ddl.openInEditor',
      payload: PLAN,
    } as never)

    expect(response).toMatchObject({ ok: true, data: null })
    expect(opened).toEqual(['create table a (id integer);\n\ncreate index a_id on a (id);'])
  })

  it('diffs two scopes', async () => {
    const { router, ddl } = setup()
    const input: SchemaDiffInput = {
      connectionId: 'c1',
      left: { schema: 'public' },
      right: { schema: 'archive' },
    }
    const response = await router.handle({
      kind: 'request',
      id: 'd5',
      type: 'schema.diff',
      payload: input,
    } as never)

    expect(response).toMatchObject({ ok: true, type: 'schema.diff' })
    expect(ddl.diff).toHaveBeenCalledWith(input)
  })
})
