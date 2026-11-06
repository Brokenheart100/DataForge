import { randomBytes } from 'node:crypto'

import * as vscode from 'vscode'

import type { BootstrapPayload, HostEvent, HostMessage, ObjectTargetInput, RelationTarget } from '@shared/protocol'
import { PROTOCOL_VERSION } from '@shared/protocol'

import type { ConnectionService } from '../application/connection-service'
import type { Logger } from '../application/ports'
import type { MessageRouter } from './message-router'

const VIEW_TYPE = 'dataforge.workbench'

interface PrefillRequest {
  sql: string
  connectionId?: string
  target?: RelationTarget
}

export interface WorkbenchDeps {
  readonly connections: ConnectionService
  readonly router: MessageRouter
  readonly logger: Logger
  /** Called when the panel goes away so leftover transactions can be rolled back. */
  readonly onClose?: () => void
}

/**
 * Hosts the Vue workbench in a webview panel.
 *
 * The host owns the security boundary: strict CSP with a per-load nonce, no
 * remote origins, and every inbound message goes through MessageRouter, which
 * validates it against the protocol schemas.
 */
export class WorkbenchPanel implements vscode.Disposable {
  private static current: WorkbenchPanel | undefined

  private readonly disposables: vscode.Disposable[] = []
  private disposed = false
  private ready = false
  private pendingPrefill: PrefillRequest | undefined
  private pendingObject: ObjectTargetInput | undefined

  static open(context: vscode.ExtensionContext, deps: WorkbenchDeps): WorkbenchPanel {
    const existing = WorkbenchPanel.current
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active)
      return existing
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'DataForge', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    })

    const instance = new WorkbenchPanel(panel, context, deps)
    WorkbenchPanel.current = instance
    return instance
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly deps: WorkbenchDeps,
  ) {
    panel.webview.html = renderHtml(panel.webview, context.extensionUri)

    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        void this.onMessage(raw)
      }),
      deps.connections.onDidChange((connections) => {
        void this.postEvent({ type: 'connections.changed', payload: [...connections] })
      }),
      panel.onDidDispose(() => this.dispose()),
    )
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (isReadyRequest(raw)) {
      this.ready = true
      await this.post({ kind: 'ready', payload: this.bootstrap() })
      const pending = this.pendingPrefill
      this.pendingPrefill = undefined
      if (pending) await this.postEvent({ type: 'editor.prefill', payload: pending })
      const object = this.pendingObject
      this.pendingObject = undefined
      if (object) await this.postEvent({ type: 'object.ddl', payload: object })
      return
    }

    const response = await this.deps.router.handle(raw)
    if (response) await this.post({ kind: 'response', payload: response })
  }

  /**
   * Loads a statement into the webview editor. Calls made before the webview
   * handshake are queued so a freshly opened panel still receives them.
   */
  prefill(sql: string, request: { connectionId?: string; target?: RelationTarget } = {}): void {
    const payload: PrefillRequest = { sql, ...request }
    if (this.ready) void this.postEvent({ type: 'editor.prefill', payload })
    else this.pendingPrefill = payload
  }

  /** Shows the object's DDL in the webview; queued until the handshake. */
  showObject(target: ObjectTargetInput): void {
    if (this.ready) void this.postEvent({ type: 'object.ddl', payload: target })
    else this.pendingObject = target
  }

  private bootstrap(): BootstrapPayload {
    const config = vscode.workspace.getConfiguration('dataforge')
    return {
      protocolVersion: PROTOCOL_VERSION,
      connections: this.deps.connections.list(),
      prefs: {
        maxRows: config.get<number>('maxRows', 500),
        statementTimeoutMs: config.get<number>('statementTimeoutMs', 30_000),
        connectTimeoutMs: config.get<number>('connectTimeoutMs', 10_000),
      },
    }
  }

  private async post(message: HostMessage): Promise<void> {
    if (this.disposed) return
    await this.panel.webview.postMessage(message)
  }

  private async postEvent(event: HostEvent): Promise<void> {
    await this.post({ kind: 'event', payload: event })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (WorkbenchPanel.current === this) WorkbenchPanel.current = undefined
    for (const disposable of this.disposables) disposable.dispose()
    this.panel.dispose()
    try {
      this.deps.onClose?.()
    } catch (error) {
      this.deps.logger.warn(`Workbench close hook failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function isReadyRequest(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const candidate = raw as { kind?: unknown; type?: unknown }
  return candidate.kind === 'request' && candidate.type === 'workbench.ready'
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64')
  const assets = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets')
  const version = { query: `v=${Date.now()}` }
  const script = webview.asWebviewUri(vscode.Uri.joinPath(assets, 'index.js')).with(version)
  const style = webview.asWebviewUri(vscode.Uri.joinPath(assets, 'index.css')).with(version)
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
  ].join('; ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${style.toString()}" />
  <title>DataForge</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`
}
