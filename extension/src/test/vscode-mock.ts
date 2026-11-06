import { join } from 'node:path'

import type * as vscode from 'vscode'

/* Minimal fake of the VS Code extension API, enough for the host wiring. */

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>()
  readonly event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  fire(value: T): void {
    for (const listener of this.listeners) listener(value)
  }

  dispose(): void {
    this.listeners.clear()
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const
export const StatusBarAlignment = { Left: 1, Right: 2 } as const
export const ViewColumn = { Active: -1, One: 1, Two: 2 } as const
export const ProgressLocation = { Notification: 15, Window: 10, SourceControl: 1 } as const

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class MarkdownString {
  value: string
  constructor(value = '') {
    this.value = value
  }

  appendMarkdown(value: string): this {
    this.value += value
    return this
  }
}

export class TreeItem {
  description?: string
  tooltip?: unknown
  iconPath?: unknown
  contextValue?: string
  command?: unknown
  id?: string
  constructor(
    readonly label: string,
    readonly collapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

export interface FakeUri {
  fsPath: string
  path: string
  query: string
  toString(): string
  with(changes: { query?: string }): FakeUri
}

function makeUri(fsPath: string, query = ''): FakeUri {
  return {
    fsPath,
    path: fsPath,
    query,
    toString: () => `vscode-webview://test${fsPath.replaceAll('\\', '/')}${query ? `?${query}` : ''}`,
    with: (changes) => makeUri(fsPath, changes.query ?? query),
  }
}

export const Uri = {
  file: (fsPath: string): FakeUri => makeUri(fsPath),
  joinPath: (base: FakeUri, ...parts: string[]): FakeUri => makeUri(join(base.fsPath, ...parts)),
  parse: (value: string): FakeUri => makeUri(value),
}

export interface PostedMessage {
  kind: string
  payload?: unknown
}

export interface FakePanel {
  webview: {
    html: string
    cspSource: string
    asWebviewUri: (uri: FakeUri) => FakeUri
    postMessage: (message: PostedMessage) => Promise<boolean>
    onDidReceiveMessage: (listener: (message: unknown) => void) => { dispose(): void }
  }
  posted: PostedMessage[]
  receive(message: unknown): void
  onDidDispose: (listener: () => void) => { dispose(): void }
  reveal: () => void
  dispose: () => void
  disposed: boolean
}

export const state = {
  panels: [] as FakePanel[],
  channels: [] as string[],
  errors: [] as string[],
  warnings: [] as string[],
  commandCalls: [] as string[],
}

export const commands = {
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  registerCommand(id: string, handler: (...args: unknown[]) => unknown): { dispose(): void } {
    this.handlers.set(id, handler)
    return { dispose: () => this.handlers.delete(id) }
  },
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    state.commandCalls.push(id)
    const handler = this.handlers.get(id)
    if (!handler) throw new Error(`command ${id} is not registered`)
    return handler(...args)
  },
}

function createChannel(name: string): vscode.LogOutputChannel {
  state.channels.push(name)
  const noop = (): void => undefined
  return { name, info: noop, warn: noop, error: noop, debug: noop, trace: noop, show: noop, hide: noop, dispose: noop, append: noop, appendLine: noop, replace: noop, clear: noop, logLevel: 2, onDidChangeLogLevel: () => ({ dispose: noop }) } as unknown as vscode.LogOutputChannel
}

function createPanel(): FakePanel {
  const listeners: Array<(message: unknown) => void> = []
  const disposeListeners: Array<() => void> = []
  const panel: FakePanel = {
    posted: [],
    disposed: false,
    webview: {
      html: '',
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri) => uri,
      postMessage: async (message) => {
        panel.posted.push(message)
        return true
      },
      onDidReceiveMessage: (listener) => {
        listeners.push(listener)
        return { dispose: () => undefined }
      },
    },
    receive: (message) => {
      for (const listener of listeners) listener(message)
    },
    onDidDispose: (listener) => {
      disposeListeners.push(listener)
      return { dispose: () => undefined }
    },
    reveal: () => undefined,
    dispose: () => {
      if (panel.disposed) return
      panel.disposed = true
      for (const listener of disposeListeners) listener()
    },
  }
  state.panels.push(panel)
  return panel
}

export const window = {
  activeTextEditor: undefined,
  createOutputChannel: (name: string) => createChannel(name),
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    command: '',
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
  createTreeView: () => ({
    dispose: () => undefined,
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    reveal: async () => undefined,
  }),
  createWebviewPanel: () => createPanel(),
  showErrorMessage: async (message: string) => {
    state.errors.push(message)
    return undefined
  },
  showWarningMessage: async (message: string) => {
    state.warnings.push(message)
    return undefined
  },
  showInformationMessage: async () => undefined,
  withProgress: async <T>(_options: unknown, task: () => Promise<T>): Promise<T> => task(),
}

export const workspace = {
  getConfiguration: () => ({
    get: <T>(_key: string, fallback: T): T => fallback,
    has: () => false,
    update: async () => undefined,
  }),
  onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  applyEdit: async () => true,
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  constructor(
    readonly startLine: number,
    readonly startCharacter: number,
    readonly endLine: number,
    readonly endCharacter: number,
  ) {}
}

export const CompletionItemKind = { Keyword: 13, Module: 8, Struct: 21, Field: 4 } as const

export class CompletionItem {
  detail = ''
  range: unknown

  constructor(
    readonly label: string,
    readonly kind: number,
  ) {}
}

export class CompletionList {
  constructor(
    readonly items: readonly unknown[],
    readonly isIncomplete = false,
  ) {}
}

export class WorkspaceEdit {
  readonly edits: { uri: unknown; range: unknown; newText: string }[] = []

  replace(uri: unknown, range: unknown, newText: string): void {
    this.edits.push({ uri, range, newText })
  }
}

export const languages = {
  registerCompletionItemProvider: () => ({ dispose: () => undefined }),
}

export interface MockMemento {
  get<T>(key: string, fallback?: T): T | undefined
  update(key: string, value: unknown): Promise<void>
  keys(): readonly string[]
}

export function createMemento(): MockMemento {
  const values = new Map<string, unknown>()
  return {
    get: <T>(key: string, fallback?: T): T | undefined => (values.has(key) ? (values.get(key) as T) : fallback),
    update: async (key, value) => {
      values.set(key, value)
    },
    keys: () => [...values.keys()],
  }
}

export function createSecrets(): vscode.SecretStorage {
  const values = new Map<string, string>()
  return {
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => {
      values.set(key, value)
    },
    delete: async (key: string) => {
      values.delete(key)
    },
    onDidChange: () => ({ dispose: () => undefined }),
  } as unknown as vscode.SecretStorage
}

export interface MockContext {
  subscriptions: Array<{ dispose(): void }>
  globalState: MockMemento
  secrets: vscode.SecretStorage
  extensionUri: FakeUri
  extensionPath: string
}

export function createMockContext(): vscode.ExtensionContext {
  const context: MockContext = {
    subscriptions: [],
    globalState: createMemento(),
    secrets: createSecrets(),
    extensionUri: Uri.file('C:/fake/dataforge-extension'),
    extensionPath: 'C:/fake/dataforge-extension',
  }
  return context as unknown as vscode.ExtensionContext
}
