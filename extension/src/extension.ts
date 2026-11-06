import * as os from 'node:os'

import * as vscode from 'vscode'

import { ConnectionService } from './application/connection-service'
import { DataEditorService } from './application/data-editor-service'
import { ExportService } from './application/export-service'
import { FormatService } from './application/format-service'
import { HistoryService } from './application/history-service'
import { ImportService } from './application/import-service'
import type { Logger } from './application/ports'
import { QueryService } from './application/query-service'
import { QuerySessionService } from './application/query-session-service'
import { ConsoleService } from './application/console-service'
import { ObjectService } from './application/object-service'
import { DdlService } from './application/ddl-service'
import { buildDdlStatements } from './infrastructure/postgres/ddl-sql'
import { SchemaService } from './application/schema-service'
import type { ConnectionConfig, ConnectionCredentials, ConnectionProfile } from './domain/connection'
import type { SshAuthentication } from './infrastructure/ssh/tunnel'
import { openSshTunnel } from './infrastructure/ssh/tunnel'
import type { ObjectTargetInput } from '@shared/protocol'
import type { DatabaseDriver } from './domain/driver'
import { DataForgeError } from './domain/errors'
import { MySqlDriver } from './infrastructure/mysql/mysql-driver'
import { PostgresDriver } from './infrastructure/postgres/postgres-driver'
import { SqlServerDriver } from './infrastructure/sqlserver/sqlserver-driver'
import { MementoConnectionStore } from './infrastructure/persistence/connection-store'
import { MementoHistoryStore } from './infrastructure/persistence/history-store'
import { VsCodeSecretStore } from './infrastructure/security/secret-store'
import { ConnectionsTreeProvider } from './presentation/connections-tree'
import { createSqlCompletionProvider } from './presentation/completion'
import { createQueryDiagnostics } from './presentation/diagnostics'
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
    createTunnel: (profile, credentials) => createTunnelFor(profile, credentials),
  })

  await connections.initialize()

  const history = new HistoryService({ store: new MementoHistoryStore(context.globalState), logger })
  const timing = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99)
  timing.command = 'dataforge.openWorkbench'
  timing.tooltip = 'Duration of the last DataForge query'
  let lastConnectionId: string | undefined

  const queries = new QueryService(connections, {
    logger,
    defaultMaxRows: vscode.workspace.getConfiguration('dataforge').get<number>('maxRows', 500),
    history,
    onExecuted: (info) => {
      lastConnectionId = info.connectionId
      createQueryDiagnostics({
        statusBar: timing,
        logger,
        slowQueryMs: () => vscode.workspace.getConfiguration('dataforge').get<number>('slowQueryMs', 1_000),
      })(info)
    },
  })
  const schemas = new SchemaService(connections, logger)
  const sessions = new QuerySessionService({
    connections,
    logger,
    defaultMaxRows: vscode.workspace.getConfiguration('dataforge').get<number>('maxRows', 500),
  })
  const consoles = new ConsoleService({ connections, queries, sessions, logger })
  const objects = new ObjectService({ connections, logger })
  const ddl = new DdlService({
    connections,
    sessions,
    schemas,
    planner: buildDdlStatements,
    logger,
  })
  const dataEditor = new DataEditorService({ connections, schemas, logger })
  const exporter = new ExportService({ connections, schemas, logger })
  let panel: WorkbenchPanel | undefined
  const importer = new ImportService({
    schemas,
    dataEditor,
    logger,
    pickFile: (format) => pickImportFile(format),
    onProgress: (event) => panel?.notify({ type: 'import.progress', payload: event }),
  })
  const router = new MessageRouter({
    connections,
    queries,
    consoles,
    objects,
    openObjectDdl: (target) => openObjectDdl(target),
    ddl,
    openDdlDocument: (sql) => openSqlDocument(sql),
    dataEditor,
    exporter,
    importer,
    pickExportPath: (suggestedName) => pickExportPath(suggestedName),
    logger,
    sessions,
  })
  const tree = new ConnectionsTreeProvider(connections, schemas, logger)
  const formatter = new FormatService()
  const completion = createSqlCompletionProvider({
    schemas,
    logger,
    activeConnectionId: () => (lastConnectionId && connections.isConnected(lastConnectionId) ? lastConnectionId : undefined),
  })
  const treeView = vscode.window.createTreeView('dataforge.connections', {
    treeDataProvider: tree,
    showCollapseAll: true,
  })

  const openWorkbench = (argument?: unknown): WorkbenchPanel => {
    panel = WorkbenchPanel.open(context, {
      connections,
      router,
      logger,
      onClose: () => void sessions.rollbackAll(),
    })
    const target = tableTargetOf(argument)
    if (target) {
      const sql = `select * from ${quoteIdentifier(target.schema)}.${quoteIdentifier(target.relation)} limit 100;`
      panel.prefill(sql, { connectionId: target.connectionId, target })
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

  const openObjectDdl = async (target: ObjectTargetInput): Promise<void> => {
    const ddl = await objects.ddl(target)
    const document = await vscode.workspace.openTextDocument({ content: ddl.ddl, language: 'sql' })
    await vscode.window.showTextDocument(document, { preview: ddl.cached })
  }

  const openSqlDocument = async (sql: string): Promise<void> => {
    const document = await vscode.workspace.openTextDocument({ content: sql, language: 'sql' })
    await vscode.window.showTextDocument(document, { preview: true })
  }

  const showObject = (target: ObjectTargetInput): void => {
    openWorkbench().showObject(target)
  }

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

    vscode.commands.registerCommand('dataforge.showObjectDdl', (argument?: unknown) => {
      const target = objectTargetOf(argument)
      if (target) showObject(target)
    }),

    vscode.commands.registerCommand('dataforge.searchObjects', async () => {
      const connectionId = lastConnectionId ?? connections.list().find((item) => item.state === 'connected')?.id
      if (!connectionId) {
        void vscode.window.showInformationMessage('DataForge: connect a database first.')
        return
      }
      const query = await vscode.window.showInputBox({
        title: 'Search database objects',
        prompt: 'Part of a table or view name',
        placeHolder: 'orders',
        ignoreFocusOut: true,
      })
      if (!query || !query.trim()) return
      await guard('Search objects', async () => {
        const result = await objects.search({ connectionId, query: query.trim(), limit: 200 })
        if (result.objects.length === 0) {
          void vscode.window.showInformationMessage(`DataForge: no objects match "${query.trim()}".`)
          return
        }
        const picked = await vscode.window.showQuickPick(
          result.objects.map((object) => ({
            label: `${object.schema}.${object.name}`,
            description: object.kind,
            target: {
              connectionId,
              schema: object.schema,
              name: object.name,
              kind: object.kind,
            } satisfies ObjectTargetInput,
          })),
          { placeHolder: `${result.objects.length} object(s) — pick one to read its DDL`, matchOnDescription: true },
        )
        if (picked) showObject(picked.target)
      })
    }),

    vscode.commands.registerCommand('dataforge.switchDatabase', async (argument: unknown) => {
      const request = databaseRequestOf(argument)
      if (!request) return
      await guard('Use database', async () => {
        schemas.invalidate(request.connectionId)
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Switching to ${request.database}…` },
          () => connections.switchDatabase(request.connectionId, request.database),
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

    vscode.commands.registerCommand('dataforge.formatSql', async () => {
      await guard('Format SQL', async () => {
        const editor = vscode.window.activeTextEditor
        if (!editor) throw new DataForgeError('invalid_request', 'Open a SQL document before formatting.')
        const selection = editor.selection
        const range: vscode.Range = selection.isEmpty ? fullDocumentRange(editor.document) : selection
        const original = editor.document.getText(range)
        const formatted = formatter.format(original)
        if (formatted === original) return
        const edit = new vscode.WorkspaceEdit()
        edit.replace(editor.document.uri, range, formatted)
        if (!(await vscode.workspace.applyEdit(edit))) {
          throw new DataForgeError('internal', 'The editor rejected the formatting edit.')
        }
      })
    }),

    vscode.languages.registerCompletionItemProvider('sql', completion, '.', ' '),

    vscode.commands.registerCommand('dataforge.showHistory', async () => {
      const entries = await history.list()
      if (entries.length === 0) {
        await vscode.window.showInformationMessage('DataForge: no queries have been run yet.')
        return
      }
      const items = entries.map((entry) => ({
        label: `${entry.success ? '$(check)' : '$(warning)'} ${collapse(entry.sql)}`,
        description: `${entry.connectionName} · ${entry.durationMs} ms · ${new Date(entry.executedAt).toLocaleString()}`,
        detail: entry.sql.slice(0, 500),
        entry,
      }))
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Query history — pick a statement to load',
        matchOnDescription: true,
      })
      if (!picked) return
      const editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor
      if (editor) {
        await editor.edit((builder) => builder.replace(fullDocumentRange(editor.document), picked.entry.sql))
        return
      }
      openWorkbench().prefill(picked.entry.sql, { connectionId: picked.entry.connectionId })
    }),

    vscode.commands.registerCommand('dataforge.clearHistory', async () => {
      const confirmed = await vscode.window.showWarningMessage('Clear the DataForge query history?', { modal: true }, 'Clear')
      if (confirmed !== 'Clear') return
      await guard('Clear history', async () => {
        await history.clear()
      })
    }),
  ]

  const changeSubscription = connections.onDidChange((list) => {
    refreshStatus()
    for (const summary of list) {
      if (summary.state === 'connected') continue
      schemas.invalidate(summary.id)
      if (sessions.isOpen(summary.id)) void sessions.rollback(summary.id).catch((error: unknown) => logger.warn(String(error)))
    }
  })

  refreshStatus()

  context.subscriptions.push(
    logger,
    tree,
    treeView,
    status,
    timing,
    { dispose: changeSubscription.dispose },
    { dispose: () => void connections.dispose() },
    { dispose: () => void queries.dispose() },
    { dispose: () => void sessions.rollbackAll() },
    { dispose: () => panel?.dispose() },
    ...registrations,
  )

  logger.info('DataForge is ready')
}

export function deactivate(): void {
  // Everything is released through context.subscriptions.
}

function createDriver(config: ConnectionConfig, logger: Logger): DatabaseDriver {
  const settings = vscode.workspace.getConfiguration('dataforge')
  const connectTimeoutMs = settings.get<number>('connectTimeoutMs', 10_000)
  const statementTimeoutMs = settings.get<number>('statementTimeoutMs', 30_000)

  if (config.profile.kind === 'mysql') return new MySqlDriver(config, { connectTimeoutMs, statementTimeoutMs })
  if (config.profile.kind === 'sqlserver') {
    return new SqlServerDriver(config, { connectTimeoutMs, statementTimeoutMs })
  }
  if (config.profile.kind !== 'postgresql') {
    throw new DataForgeError('internal', `The ${config.profile.kind} driver is not implemented yet.`)
  }
  return new PostgresDriver(config, {
    connectTimeoutMs,
    statementTimeoutMs,
    onBackgroundError: (message) => logger.warn(message),
  })
}

async function createTunnelFor(profile: ConnectionProfile, credentials: ConnectionCredentials) {
  const tunnel = profile.tunnel
  if (!tunnel) throw new DataForgeError('internal', 'That connection has no SSH tunnel configured.')
  let auth: SshAuthentication
  if (tunnel.auth === 'password') {
    if (!credentials.sshPassword) {
      throw new DataForgeError('invalid_request', `Enter the SSH password for "${tunnel.user}@${tunnel.host}" again.`)
    }
    auth = { method: 'password', password: credentials.sshPassword }
  } else {
    if (!tunnel.privateKeyPath) {
      throw new DataForgeError('invalid_request', 'Choose a private key file for the SSH tunnel.')
    }
    auth = {
      method: 'private key',
      privateKeyPath: tunnel.privateKeyPath,
      ...(credentials.sshPassphrase === undefined ? {} : { passphrase: credentials.sshPassphrase }),
    }
  }
  const connectTimeoutMs = vscode.workspace.getConfiguration('dataforge').get<number>('connectTimeoutMs', 10_000)
  const handle = await openSshTunnel({
    sshHost: tunnel.host,
    sshPort: tunnel.port,
    user: tunnel.user,
    auth,
    targetHost: profile.host,
    targetPort: profile.port,
    connectTimeoutMs,
  })
  return { host: handle.host, port: handle.port, dispose: handle.close }
}

async function pickImportFile(format: 'csv' | 'json'): Promise<string | undefined> {
  const filters: Record<string, string[]> =
    format === 'json' ? { 'JSON file': ['json'] } : { 'CSV file': ['csv', 'txt'] }
  const [target] = (await vscode.window.showOpenDialog({
    title: 'Import data from a file',
    openLabel: 'Import',
    canSelectMany: false,
    filters,
  })) ?? []
  return target?.fsPath
}

async function pickExportPath(suggestedName: string): Promise<string | undefined> {
  const defaultUri = vscode.Uri.joinPath(vscode.Uri.file(os.homedir()), suggestedName)
  const target = await vscode.window.showSaveDialog({
    title: 'Export table as CSV',
    saveLabel: 'Export',
    defaultUri,
    filters: { 'CSV file': ['csv'] },
  })
  return target?.fsPath
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  const lastLine = Math.max(0, document.lineCount - 1)
  return new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).text.length)
}

/** One-line preview of a statement for the history picker. */
function collapse(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** Tree commands receive the tree element, so accept both shapes. */
function connectionIdOf(argument: unknown): string | undefined {
  if (typeof argument !== 'object' || argument === null) return undefined
  const node = argument as { connectionId?: unknown; summary?: { id?: unknown } }
  if (typeof node.connectionId === 'string') return node.connectionId
  const id = node.summary?.id
  return typeof id === 'string' ? id : undefined
}

interface DatabaseRequest {
  readonly connectionId: string
  readonly database: string
}

/** Recognises the argument a database node passes to `dataforge.switchDatabase`. */
function databaseRequestOf(argument: unknown): DatabaseRequest | undefined {
  if (typeof argument !== 'object' || argument === null) return undefined
  const node = argument as { connectionId?: unknown; database?: unknown }
  const { connectionId, database } = node
  if (typeof connectionId !== 'string' || typeof database !== 'string') return undefined
  return { connectionId, database }
}

interface TableTarget {
  readonly connectionId: string
  /** Set when the node belongs to a secondary database of the connection. */
  readonly database?: string
  readonly schema: string
  readonly relation: string
}

/** Recognises the argument a relation node passes to `dataforge.openWorkbench`. */
function tableTargetOf(argument: unknown): TableTarget | undefined {
  if (typeof argument !== 'object' || argument === null) return undefined
  const node = argument as { connectionId?: unknown; database?: unknown; schema?: unknown; relation?: unknown }
  const { connectionId, database, schema, relation } = node
  if (typeof connectionId !== 'string' || typeof schema !== 'string' || typeof relation !== 'string') return undefined
  return typeof database === 'string' ? { connectionId, database, schema, relation } : { connectionId, schema, relation }
}

/** Recognises the argument a relation node passes to `dataforge.showObjectDdl`. */
function objectTargetOf(argument: unknown): ObjectTargetInput | undefined {
  if (typeof argument !== 'object' || argument === null) return undefined
  const node = argument as {
    connectionId?: unknown
    database?: unknown
    schema?: unknown
    relation?: unknown
    kind?: unknown
  }
  const { connectionId, database, schema, relation, kind } = node
  if (typeof connectionId !== 'string' || typeof schema !== 'string' || typeof relation !== 'string') return undefined
  const objectKind = typeof kind === 'string' ? kind : 'table'
  const target = { connectionId, schema, name: relation, kind: objectKind as ObjectTargetInput['kind'] }
  return typeof database === 'string' ? { ...target, database } : target
}

/** Quotes a PostgreSQL identifier for names that came back from the server. */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}
