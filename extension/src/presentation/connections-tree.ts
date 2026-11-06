import * as vscode from 'vscode'

import type { ConnectionSummary } from '@shared/protocol'

import type { ConnectionService } from '../application/connection-service'
import type { Logger } from '../application/ports'
import type { SchemaService } from '../application/schema-service'
import type { ColumnInfo, RelationInfo } from '../domain/driver'

type TreeNode =
  | { readonly kind: 'connection'; readonly summary: ConnectionSummary }
  | { readonly kind: 'databases'; readonly connectionId: string; readonly active: string }
  | { readonly kind: 'database'; readonly connectionId: string; readonly name: string; readonly active: boolean }
  | { readonly kind: 'schemas'; readonly connectionId: string }
  | { readonly kind: 'schema'; readonly connectionId: string; readonly name: string }
  | { readonly kind: 'relations'; readonly connectionId: string; readonly schema: string; readonly title: string; readonly views: boolean }
  | { readonly kind: 'relation'; readonly connectionId: string; readonly schema: string; readonly relation: RelationInfo }
  | { readonly kind: 'column'; readonly column: ColumnInfo }
  | { readonly kind: 'message'; readonly label: string; readonly description?: string; readonly icon?: string }

function stateIcon(state: ConnectionSummary['state']): string {
  if (state === 'connected') return 'plug'
  if (state === 'error') return 'error'
  return 'debug-disconnect'
}

/**
 * Lazy connections tree: nothing is loaded until a node is expanded, and
 * metadata requests go through SchemaService so repeated expansions are cached.
 */
export class ConnectionsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>()
  private readonly disposables: vscode.Disposable[] = []

  readonly onDidChangeTreeData = this.changed.event

  constructor(
    private readonly connections: ConnectionService,
    private readonly schemas: SchemaService,
    private readonly logger: Logger,
  ) {
    this.disposables.push(this.connections.onDidChange(() => this.changed.fire(undefined)))
  }

  refresh(): void {
    this.changed.fire(undefined)
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'connection': {
        const item = new vscode.TreeItem(node.summary.name, vscode.TreeItemCollapsibleState.Collapsed)
        item.id = `connection:${node.summary.id}`
        item.contextValue = `dataforge.connection.${node.summary.state}`
        item.description = `${node.summary.database}@${node.summary.host}:${node.summary.port}`
        item.tooltip = new vscode.MarkdownString(
          [
            `**${node.summary.name}**`,
            `User: \`${node.summary.user}\``,
            `Database: \`${node.summary.database}\``,
            `SSL: ${node.summary.ssl}${node.summary.readOnly ? ' · read-only' : ''}`,
            node.summary.serverVersion ?? '',
            node.summary.lastError ?? '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        )
        item.iconPath = new vscode.ThemeIcon(stateIcon(node.summary.state))
        return item
      }
      case 'databases': {
        const item = new vscode.TreeItem('Databases', vscode.TreeItemCollapsibleState.Collapsed)
        item.description = node.active
        item.iconPath = new vscode.ThemeIcon('database')
        return item
      }
      case 'database': {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None)
        item.iconPath = new vscode.ThemeIcon('database')
        item.description = node.active ? 'current' : undefined
        item.tooltip = node.active
          ? `${node.name} — this connection is using it`
          : `Switch this connection to ${node.name}`
        if (!node.active) {
          item.command = {
            command: 'dataforge.switchDatabase',
            title: 'Use this database',
            arguments: [{ connectionId: node.connectionId, database: node.name }],
          }
        }
        return item
      }
      case 'schemas': {
        const item = new vscode.TreeItem('Schemas', vscode.TreeItemCollapsibleState.Collapsed)
        item.iconPath = new vscode.ThemeIcon('symbol-namespace')
        return item
      }
      case 'schema': {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed)
        item.iconPath = new vscode.ThemeIcon('symbol-namespace')
        return item
      }
      case 'relations': {
        const item = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.Collapsed)
        item.iconPath = new vscode.ThemeIcon(node.views ? 'eye' : 'table')
        return item
      }
      case 'relation': {
        const item = new vscode.TreeItem(node.relation.name, vscode.TreeItemCollapsibleState.Collapsed)
        item.contextValue = 'dataforge.relation'
        item.description = node.relation.kind === 'view' ? 'view' : undefined
        item.iconPath = new vscode.ThemeIcon(node.relation.kind === 'view' ? 'eye' : 'table')
        item.command = {
          command: 'dataforge.openWorkbench',
          title: 'Open query',
          arguments: [{ connectionId: node.connectionId, schema: node.schema, relation: node.relation.name }],
        }
        return item
      }
      case 'column': {
        const suffix = [
          node.column.isPrimaryKey ? 'PK' : undefined,
          node.column.nullable ? undefined : 'NOT NULL',
          node.column.defaultValue ? `default ${node.column.defaultValue}` : undefined,
        ].filter(Boolean)
        const item = new vscode.TreeItem(node.column.name, vscode.TreeItemCollapsibleState.None)
        item.description = [node.column.dataType, ...suffix].join(' · ')
        item.tooltip = `${node.column.name} ${node.column.dataType}`
        item.iconPath = new vscode.ThemeIcon(node.column.isPrimaryKey ? 'key' : 'symbol-field')
        return item
      }
      case 'message': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None)
        item.description = node.description
        if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon)
        return item
      }
    }
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    try {
      if (!node) {
        return this.connections.list().map((summary) => ({ kind: 'connection', summary }) as const)
      }

      switch (node.kind) {
        case 'connection': {
          if (node.summary.state !== 'connected') {
            await this.connections.connect(node.summary.id)
          }
          return [
            { kind: 'databases', connectionId: node.summary.id, active: node.summary.database } as const,
            { kind: 'schemas', connectionId: node.summary.id } as const,
          ]
        }
        case 'databases': {
          const databases = await this.connections.listDatabases(node.connectionId)
          const summaries = this.connections.list()
          const active = summaries.find((summary) => summary.id === node.connectionId)?.database ?? node.active
          return databases.map(
            (name): TreeNode => ({ kind: 'database', connectionId: node.connectionId, name, active: name === active }),
          )
        }
        case 'database':
          return []
        case 'schemas': {
          const names = await this.schemas.listSchemas(node.connectionId)
          return names.map((name) => ({ kind: 'schema', connectionId: node.connectionId, name }) as const)
        }
        case 'schema': {
          const relations = await this.schemas.listRelations(node.connectionId, node.name)
          const tables = relations.filter((relation) => relation.kind !== 'view')
          const views = relations.filter((relation) => relation.kind === 'view')
          const groups: TreeNode[] = []
          if (tables.length > 0) {
            groups.push({
              kind: 'relations',
              connectionId: node.connectionId,
              schema: node.name,
              title: `Tables (${tables.length})`,
              views: false,
            })
          }
          if (views.length > 0) {
            groups.push({
              kind: 'relations',
              connectionId: node.connectionId,
              schema: node.name,
              title: `Views (${views.length})`,
              views: true,
            })
          }
          return groups.length > 0 ? groups : [message('No tables or views')]
        }
        case 'relations': {
          const relations = await this.schemas.listRelations(node.connectionId, node.schema)
          return relations
            .filter((relation) => (node.views ? relation.kind === 'view' : relation.kind !== 'view'))
            .map(
              (relation): TreeNode => ({
                kind: 'relation',
                connectionId: node.connectionId,
                schema: node.schema,
                relation,
              }),
            )
        }
        case 'relation': {
          const columns = await this.schemas.listColumns(node.connectionId, node.schema, node.relation.name)
          return columns.map((column) => ({ kind: 'column', column }) as const)
        }
        case 'column':
          return []
        case 'message':
          return []
      }
    } catch (error) {
      const label = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error)
      this.logger.error(`Tree expansion failed`, error)
      return [message(label, undefined, 'error')]
    }
  }

  dispose(): void {
    this.changed.dispose()
    for (const disposable of this.disposables) disposable.dispose()
  }
}

function message(label: string, description?: string, icon?: string): TreeNode {
  return { kind: 'message', label, description, icon }
}
