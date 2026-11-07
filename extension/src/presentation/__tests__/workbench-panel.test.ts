import * as vscode from 'vscode'
import { describe, expect, it, vi } from 'vitest'

import { PROTOCOL_VERSION } from '@shared/protocol'

import type { ConnectionService } from '../../application/connection-service'
import type { Logger } from '../../application/ports'
import type { FakePanel } from '../../test/vscode-mock'
import type { MessageRouter } from '../message-router'
import { WORKBENCH_VIEW_TYPE, WorkbenchPanel } from '../workbench-panel'

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

function createPanel(): vscode.WebviewPanel & FakePanel {
  return vscode.window.createWebviewPanel(WORKBENCH_VIEW_TYPE, 'DataForge', 1, {}) as unknown as vscode.WebviewPanel &
    FakePanel
}

function setup() {
  const connections = {
    list: () => [],
    onDidChange: () => ({ dispose: () => undefined }),
  } as unknown as ConnectionService
  const router = { handle: vi.fn<MessageRouter['handle']>(async () => null) } as unknown as MessageRouter
  const context = {
    extensionUri: vscode.Uri.file('D:/Code/VueProjects/DataForge/extension'),
  } as unknown as vscode.ExtensionContext
  return { context, deps: { connections, router, logger } }
}

describe('WorkbenchPanel.restore', () => {
  it('adopts the restored panel and bootstraps protocol v9', async () => {
    const { context, deps } = setup()
    const panel = createPanel()
    const restored = WorkbenchPanel.restore(panel, context, deps)

    expect(panel.webview.html).toContain('Content-Security-Policy')
    expect(panel.webview.html).toContain('DataForge')

    panel.receive({ kind: 'request', type: 'workbench.ready' })
    await vi.waitFor(() => expect(panel.posted.length).toBeGreaterThan(0))
    const ready = panel.posted.find((message) => message.kind === 'ready')
    expect(ready?.payload).toMatchObject({ protocolVersion: PROTOCOL_VERSION })

    restored.dispose()
    expect(panel.disposed).toBe(true)
  })

  it('reuses the open panel instead of adopting a second one', () => {
    const { context, deps } = setup()
    const firstPanel = createPanel()
    const first = WorkbenchPanel.restore(firstPanel, context, deps)
    const secondPanel = createPanel()
    const second = WorkbenchPanel.restore(secondPanel, context, deps)

    expect(second).toBe(first)
    expect(secondPanel.disposed).toBe(true)
    expect(firstPanel.disposed).toBe(false)

    first.dispose()
  })
})
