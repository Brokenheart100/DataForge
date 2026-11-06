import { beforeEach, describe, expect, it } from 'vitest'

import type { FakePanel } from '../test/vscode-mock'
import { commands, createMockContext, state } from '../test/vscode-mock'
import { activate } from '../extension'

interface ResponsePayload {
  id: string
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
}

function responses(panel: FakePanel): ResponsePayload[] {
  return panel.posted.filter((message) => message.kind === 'response').map((message) => message.payload as ResponsePayload)
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  state.panels.length = 0
  state.channels.length = 0
  state.errors.length = 0
  state.commandCalls.length = 0
})

describe('extension activation', () => {
  it('registers every Phase 1 command and disposes cleanly', async () => {
    const context = createMockContext()
    await activate(context)

    expect([...commands.handlers.keys()]).toEqual(
      expect.arrayContaining([
        'dataforge.newConnection',
        'dataforge.refreshConnections',
        'dataforge.openWorkbench',
        'dataforge.connect',
        'dataforge.disconnect',
        'dataforge.deleteConnection',
      ]),
    )
    expect(context.subscriptions.length).toBeGreaterThan(0)
    expect(state.channels).toContain('DataForge')

    expect(() => context.subscriptions.forEach((item) => item.dispose())).not.toThrow()
  })

  it('renders a locked-down webview and answers the ready handshake', async () => {
    const context = createMockContext()
    await activate(context)

    await commands.executeCommand('dataforge.openWorkbench')
    const panel = state.panels.at(-1)
    expect(panel).toBeDefined()
    if (!panel) return

    expect(panel.webview.html).toContain("default-src 'none'")
    expect(panel.webview.html).toContain('script-src \'nonce-')
    expect(panel.webview.html).toContain('assets/index.js')

    panel.receive({ kind: 'request', id: 'ready-1', type: 'workbench.ready', payload: null })
    await flush()

    const ready = panel.posted.find((message) => message.kind === 'ready')
    expect(ready).toBeDefined()
    expect(ready?.payload).toMatchObject({ protocolVersion: expect.any(Number), connections: [] })

    context.subscriptions.forEach((item) => item.dispose())
  })

  it('prefills the editor when a relation node opens the workbench', async () => {
    const context = createMockContext()
    await activate(context)

    await commands.executeCommand('dataforge.openWorkbench', {
      connectionId: 'conn-1',
      schema: 'public',
      relation: 'customer"orders',
    })
    const panel = state.panels.at(-1)
    expect(panel).toBeDefined()
    if (!panel) return

    panel.receive({ kind: 'request', id: 'ready-2', type: 'workbench.ready', payload: null })
    await flush()

    const prefill = panel.posted.find((message) => message.kind === 'event')
    expect(prefill?.payload).toEqual({
      type: 'editor.prefill',
      payload: {
        sql: 'select * from "public"."customer""orders" limit 100;',
        connectionId: 'conn-1',
        target: { connectionId: 'conn-1', schema: 'public', relation: 'customer"orders' },
      },
    })

    context.subscriptions.forEach((item) => item.dispose())
  })

  it('validates webview payloads before they reach a service', async () => {
    const context = createMockContext()
    await activate(context)
    await commands.executeCommand('dataforge.openWorkbench')
    const panel = state.panels.at(-1)
    expect(panel).toBeDefined()
    if (!panel) return

    panel.receive({ kind: 'request', id: 'list-1', type: 'connection.list', payload: null })
    await flush()
    const listed = responses(panel).find((response) => response.id === 'list-1')
    expect(listed).toMatchObject({ ok: true, data: [] })

    panel.receive({ kind: 'request', id: 'bad-1', type: 'connection.list', payload: { unexpected: true } })
    await flush()
    const rejected = responses(panel).find((response) => response.id === 'bad-1')
    expect(rejected?.ok).toBe(false)
    expect(rejected?.error?.code).toBe('invalid_request')
    expect(state.errors).toHaveLength(0)

    context.subscriptions.forEach((item) => item.dispose())
  })

  it('reuses the single workbench panel', async () => {
    const context = createMockContext()
    await activate(context)

    await commands.executeCommand('dataforge.openWorkbench')
    await commands.executeCommand('dataforge.openWorkbench')

    expect(state.panels).toHaveLength(1)
    context.subscriptions.forEach((item) => item.dispose())
    expect(state.panels[0]?.disposed).toBe(true)
  })
})
