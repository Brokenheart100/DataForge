import * as vscode from 'vscode'

import { ConnectionService } from './application/connection-service'
import type { Logger } from './application/ports'
import { QueryService } from './application/query-service'
import { SchemaService } from './application/schema-service'
import type { ConnectionConfig } from './domain/connection'
import { DataForgeError } from './domain/errors'
import { PostgresDriver } from './infrastructure/postgres/postgres-driver'
import { MementoConnectionStore } from './infrastructure/persistence/connection-store'
import { VsCodeSecretStore } from './infrastructure/security/secret-store'
import { ConnectionsTreeProvider } from './presentation/connections-tree'
import { OutputChannelLogger } from './presentation/logging'
import { MessageRouter } from './presentation/message-router'
import { WorkbenchPanel } from './presentation/workbench-panel'

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new OutputChannelLogger()
  logger.info('DataForge is activating')

  const connections = new ConnectionService({
    store: new MementoConnectionStore(context.globalState),
    secrets: new VsCodeSecretStore(context.secrets),
    logger,
    createDriver: (config) => createDriver(config, logger),
  })

  await connections.initialize()

  const queries = new QueryService(connections, {
    logger,
    defaultMaxRows: vscode.workspace.getConfiguration('dataforge').get<number>('maxRows', 500),
  })
  const schemas = new SchemaService(connections, logger)
  const router = new MessageRouter({ connections, queries, logger })
  const tree = new ConnectionsTreeProvider(connections, schemas, logger)
  const treeView = vscode.window.createTreeView('dataforge.connections', {
    treeDataProvider: tree,
    showCollapseAll: true,
  })

  let panel: WorkbenchPanel | undefined
  const openWorkbench = (argument?: unknown): WorkbenchPanel => {
    panel = WorkbenchPanel.open(context, { connections, router, logger })
    const target = tableTargetOf(argument)
    if (target) {
      const sql = `select * from ${quoteIdentifier(target.schema)}.${quoteIdentifier(target.relation)} limit 100;`
      panel.prefill(sql, target.connectionId)
    }
    return panel
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  status.command = 'dataforge.openWorkbench'
  status.tooltip = 'Open the DataForge workbench'

  const refreshStatus = (): void => {
    const list = connections.list()
    const connected = list.filter((item) => item.state === 'connected').length
    status.text = connected > 0 ? `$(database) DataForge · ${connected}/${list.length}` : '$(database) DataForge'
    status.show()
  }

  const guard = async <T>(title: string, action: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await action()
    } catch (error) {
      const message = error instanceof DataForgeError ? error.message : error instanceof Error ? error.message : String(error)
      logger.error(`${title} failed`, error)
      const choice = await vscode.window.showErrorMessage(`DataForge: ${message}`, 'Show Log')
      if (choice === 'Show Log') logger.show()
      return undefined
    }
  }

  const requireConnectionId = (argument: unknown): string | undefined => connectionIdOf(argument)

  const registrations = [
    vscode.commands.registerCommand('dataforge.newConnection', () => {
      openWorkbench()
      void vscode.commands.executeCommand('dataforge.connections.focus')
    }),

    vscode.commands.registerCommand('dataforge.refreshConnections', () => {
      schemas.invalidate()
      tree.refresh()
      logger.info('Connections refreshed')
    }),

    vscode.commands.registerCommand('dataforge.openWorkbench', (argument?: unknown) => {
      openWorkbench(argument)
    }),

    vscode.commands.registerCommand('dataforge.connect', async (argument: unknown) => {
      const connectionId = requireConnectionId(argument)
      if (!connectionId) return
      await guard('Connect', async () => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Connecting to PostgreSQL…' },
          () => connections.connect(connectionId),
        )
        tree.refresh()
      })
    }),

    vscode.commands.registerCommand('dataforge.disconnect', async (argument: unknown) => {
      const connectionId = requireConnectionId(argument)
      if (!connectionId) return
      await guard('Disconnect', async () => {
        schemas.invalidate(connectionId)
        await connections.disconnect(connectionId)
        tree.refresh()
      })
    }),

    vscode.commands.registerCommand('dataforge.deleteConnection', async (argument: unknown) => {
      const connectionId = requireConnectionId(argument)
      if (!connectionId) return
      const summary = connections.list().find((item) => item.id === connectionId)
      const confirmed = await vscode.window.showWarningMessage(
        `Delete the connection "${summary?.name ?? connectionId}"? The saved password is removed too.`,
        { modal: true },
        'Delete',
      )
      if (confirmed !== 'Delete') return
      await guard('Delete connection', async () => {
        schemas.invalidate(connectionId)
        await connections.delete(connectionId)
        tree.refresh()
      })
    }),
  ]

  const changeSubscription = connections.onDidChange((list) => {
    refreshStatus()
    for (const summary of list) {
      if (summary.state !== 'connected') schemas.invalidate(summary.id)
    }
  })

  refreshStatus()

  context.subscriptions.push(
    logger,
    tree,
    treeView,
    status,
    { dispose: changeSubscription.dispose },
    { dispose: () => void connections.dispose() },
    { dispose: () => void queries.dispose() },
    { dispose: () => panel?.dispose() },
    ...registrations,
  )

  logger.info('DataForge is ready')
}

export function deactivate(): void {
  // Everything is released through context.subscriptions.
}

function createDriver(config: ConnectionConfig, logger: Logger): PostgresDriver {
  const settings = vscode.workspace.getConfiguration('dataforge')
  return new PostgresDriver(config, {
    connectTimeoutMs: settings.get<number>('connectTimeoutMs', 10_000),
    statementTimeoutMs: settings.get<number>('statementTimeoutMs', 30_000),
    onBackgroundError: (message) => logger.warn(message),
  })
}

/** Tree commands receive the tree element, so accept both shapes. */
function connectionIdOf(argument: unknown): string | undefined {
  if (typeof argument !== 'object' || argument === null) return undefined
  const node = argument as { connectionId?: unknown; summary?: { id?: unknown } }
  if (typeof node.connectionId === 'string') return node.connectionId
  const id = node.summary?.id
  return typeof id === 'string' ? id : undefined
}

interface TableTarget {
  readonly connectionId: string
  readonly schema: string
  readonly relation: string
}

/** Recognises the argument a relation node passes to `dataforge.openWorkbench`. */
function tableTargetOf(argument: unknown): TableTarget | undefined {
  if (typeof argument !== 'object' || argument === null) return undefined
  const node = argument as { connectionId?: unknown; schema?: unknown; relation?: unknown }
  const { connectionId, schema, relation } = node
  if (typeof connectionId !== 'string' || typeof schema !== 'string' || typeof relation !== 'string') return undefined
  return { connectionId, schema, relation }
}

/** Quotes a PostgreSQL identifier for names that came back from the server. */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}
