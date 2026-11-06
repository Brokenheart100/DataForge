import type {
  BootstrapPayload,
  CellValue,
  ConnectionDraft,
  DdlPreviewDto,
  ErrorCode,
  ErrorDto,
  HostEvent,
  HostMessage,
  RequestInput,
  RequestOutput,
  RequestType,
  WebviewResponse,
} from '@shared/protocol'
import { PROTOCOL_VERSION, REQUEST_TYPES } from '@shared/protocol'

declare global {
  interface VsCodeApi {
    postMessage(message: unknown): void
    getState(): unknown
    setState(state: unknown): void
  }
  function acquireVsCodeApi(): VsCodeApi
}

export class HostRequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Identity fragments (`id=42`) of rows changed elsewhere; conflict only. */
    readonly conflictingKeys: readonly string[] = [],
  ) {
    super(message)
    this.name = 'HostRequestError'
  }
}

interface Transport {
  post(message: unknown): void
  subscribe(listener: (message: unknown) => void): void
  persist(state: unknown): void
  restore(): unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isHostMessage(value: unknown): value is HostMessage {
  return isRecord(value) && (value.kind === 'ready' || value.kind === 'response' || value.kind === 'event')
}

class VsCodeTransport implements Transport {
  private readonly api: VsCodeApi

  constructor() {
    this.api = acquireVsCodeApi()
  }

  post(message: unknown): void {
    this.api.postMessage(message)
  }

  subscribe(listener: (message: unknown) => void): void {
    window.addEventListener('message', (event: MessageEvent) => listener(event.data))
  }

  persist(state: unknown): void {
    this.api.setState(state)
  }

  restore(): unknown {
    return this.api.getState()
  }
}

/**
 * Stand-in host used by `npm run dev -w webview`.
 *
 * The webview bundle is also served by the plain Vite dev server, outside VS
 * Code, where no extension host exists. This keeps the UI iterable in a normal
 * browser with in-memory data instead of a blank panel.
 */
class DemoTransport implements Transport {
  private listener: ((message: unknown) => void) | undefined
  private state: unknown
  private consoleSequence = 0
  private readonly consoles = new Map<string, { id: string; connectionId: string; database: string; title: string }>()
  private readonly connections: ConnectionDraft[] = [
    {
      name: 'analytics@localhost',
      host: 'localhost',
      port: 5432,
      database: 'analytics',
      user: 'postgres',
      password: '',
      ssl: 'disable',
      readOnly: false,
    },
  ]

  post(message: unknown): void {
    if (!isRecord(message) || message.kind !== 'request') return
    const request = message as { id: string; type: RequestType; payload: unknown }
    setTimeout(() => this.reply(request), 120)
  }

  subscribe(listener: (message: unknown) => void): void {
    this.listener = listener
    this.emit({ kind: 'ready', payload: this.bootstrap() })
    // Give the demo a table to look at: the browser stand-in has no explorer
    // tree, so it opens `public.orders` a moment after the handshake.
    setTimeout(() => {
      this.emit({
        kind: 'event',
        payload: {
          type: 'editor.prefill',
          payload: {
            sql: 'select * from public.orders limit 100;',
            connectionId: 'demo-0',
            target: { connectionId: 'demo-0', schema: 'public', relation: 'orders' },
          },
        },
      })
    }, 400)
  }

  persist(state: unknown): void {
    this.state = state
  }

  restore(): unknown {
    return this.state
  }

  private bootstrap(): BootstrapPayload {
    return {
      protocolVersion: PROTOCOL_VERSION,
      connections: this.connections.map((draft, index) => ({
        id: `demo-${index}`,
        name: draft.name,
        kind: 'postgresql',
        host: draft.host,
        port: draft.port,
        database: draft.database,
        user: draft.user,
        ssl: draft.ssl,
        readOnly: draft.readOnly,
        state: 'connected',
        serverVersion: 'PostgreSQL 17.3 (demo)',
        capabilities: {
          query: true,
          dataEditing: true,
          exportCsv: true,
          transactions: true,
          schemaChanges: true,
          objectBrowser: true,
          databaseList: true,
          sessions: true,
        },
      })),
      prefs: { maxRows: 500, statementTimeoutMs: 30_000, connectTimeoutMs: 10_000 },
    }
  }

  private emit(message: HostMessage): void {
    this.listener?.(message)
  }

  private reply(request: { id: string; type: RequestType; payload: unknown }): void {
    const fail = (error: ErrorDto): void => this.emit({ kind: 'response', payload: { kind: 'response', id: request.id, ok: false, error } })
    const succeed = (data: unknown): void =>
      this.emit({
        kind: 'response',
        // The demo host answers with hand-written values; the cast is confined
        // to this throw-away stand-in for the extension host.
        payload: { kind: 'response', id: request.id, type: request.type, ok: true, data } as WebviewResponse,
      })

    switch (request.type) {
      case 'workbench.ready':
        this.emit({ kind: 'ready', payload: this.bootstrap() })
        return
      case 'connection.list':
        succeed(this.bootstrap().connections)
        return
      case 'database.list':
        succeed(['analytics', 'reporting'])
        return
      case 'console.open': {
        const payload = request.payload as { connectionId: string; database?: string; title?: string }
        this.consoleSequence += 1
        const console = {
          id: `demo-console-${this.consoleSequence}`,
          connectionId: payload.connectionId,
          database: payload.database ?? 'analytics',
          title: payload.title ?? `Console ${this.consoleSequence}`,
        }
        this.consoles.set(console.id, console)
        succeed(console)
        return
      }
      case 'console.list': {
        const payload = request.payload as { connectionId: string }
        succeed([...this.consoles.values()].filter((item) => item.connectionId === payload.connectionId))
        return
      }
      case 'import.preview': {
        succeed({
          token: 'demo-import',
          fileName: 'orders.csv',
          format: 'csv',
          delimiter: ',',
          hasHeader: true,
          totalBytes: 2048,
          headers: ['id', 'customer', 'total'],
          sample: [
            ['1', 'Customer 1', '12.5'],
            ['2', 'Customer 2', '99'],
          ],
          mapping: [
            { source: 'id', target: 'id' },
            { source: 'customer', target: 'customer' },
            { source: 'total', target: 'total' },
          ],
          columns: [
            { name: 'id', dataType: 'int4', nullable: false, defaultValue: null },
            { name: 'customer', dataType: 'text', nullable: false, defaultValue: null },
            { name: 'total', dataType: 'numeric', nullable: true, defaultValue: null },
            { name: 'created_at', dataType: 'timestamptz', nullable: true, defaultValue: 'now()' },
          ],
          issues: [],
        })
        return
      }
      case 'import.start':
        this.emit({
          kind: 'event',
          payload: {
            type: 'import.progress',
            payload: { requestId: request.id, fileName: 'orders.csv', processed: 3, inserted: 3, failed: 0, done: false },
          },
        })
        succeed({ imported: 3, failed: 0, cancelled: false, errors: [], durationMs: 12 })
        return
      case 'ddl.preview': {
        const payload = request.payload as { kind: string; schema: string; table: string }
        succeed({
          statements: [
            {
              sql:
                payload.kind === 'drop table'
                  ? `drop table "${payload.schema}"."${payload.table}";`
                  : `create table "${payload.schema}"."${payload.table}" (\n  "id" integer not null primary key\n);`,
              risk: payload.kind === 'drop table' ? 'dangerous' : 'safe',
            },
          ],
          requiresConfirmation: payload.kind === 'drop table',
          expectedConfirmation: payload.kind === 'drop table' ? payload.table : null,
          warnings: [],
        } satisfies DdlPreviewDto)
        return
      }
      case 'ddl.apply':
        succeed({ statements: 1, durationMs: 4 })
        return
      case 'ddl.openInEditor':
        succeed(null)
        return
      case 'schema.diff':
        succeed({ added: [], removed: [], changed: [] })
        return
      case 'import.cancel':
        succeed(null)
        return
      case 'console.close': {
        const payload = request.payload as { consoleId: string }
        this.consoles.delete(payload.consoleId)
        succeed(null)
        return
      }
      case 'connection.test':
        succeed({ serverVersion: 'PostgreSQL 16.4 (demo)', database: 'analytics', user: 'postgres', latencyMs: 42 })
        return
      case 'query.execute':
      case 'transaction.run':
        succeed({
          columns: [
            { name: 'id', dataType: 'int4' },
            { name: 'customer', dataType: 'text' },
            { name: 'total', dataType: 'numeric' },
            { name: 'created_at', dataType: 'timestamptz' },
          ],
          rows: Array.from({ length: 24 }, (_, index) => [index + 1, `Customer ${index + 1}`, (index + 1) * 12.5, '2026-11-06T09:12:00.000Z']),
          rowCount: 24,
          command: 'SELECT',
          durationMs: 18,
          truncated: false,
          affectedRows: null,
          notices: ['Demo data — no database is connected.'],
        })
        return
      case 'query.cancel':
        succeed(null)
        return
      case 'transaction.begin':
      case 'transaction.commit':
      case 'transaction.rollback': {
        const payload = request.payload as { connectionId?: string }
        succeed({ connectionId: payload.connectionId ?? 'demo-0', active: request.type === 'transaction.begin' })
        return
      }
      case 'query.explain':
        succeed({
          plan: JSON.stringify(
            [
              {
                Plan: {
                  'Node Type': 'Nested Loop',
                  'Join Type': 'Inner',
                  'Startup Cost': 0.15,
                  'Total Cost': 31.2,
                  'Plan Rows': 24,
                  'Plan Width': 42,
                  Plans: [
                    {
                      'Node Type': 'Seq Scan',
                      'Relation Name': 'orders',
                      'Startup Cost': 0,
                      'Total Cost': 24.5,
                      'Plan Rows': 24,
                      'Plan Width': 42,
                    },
                    {
                      'Node Type': 'Index Scan',
                      'Relation Name': 'customers',
                      'Index Name': 'customers_pkey',
                      'Startup Cost': 0.15,
                      'Total Cost': 6.7,
                      'Plan Rows': 1,
                      'Plan Width': 8,
                    },
                  ],
                },
              },
            ],
            null,
            2,
          ),
          root: {
            nodeType: 'Nested Loop',
            joinType: 'Inner',
            startupCost: 0.15,
            totalCost: 31.2,
            planRows: 24,
            planWidth: 42,
            children: [
              {
                nodeType: 'Seq Scan',
                relation: 'orders',
                startupCost: 0,
                totalCost: 24.5,
                planRows: 24,
                planWidth: 42,
                children: [],
              },
              {
                nodeType: 'Index Scan',
                relation: 'customers',
                indexName: 'customers_pkey',
                startupCost: 0.15,
                totalCost: 6.7,
                planRows: 1,
                planWidth: 8,
                children: [],
              },
            ],
          },
          durationMs: 4,
        })
        return
      case 'session.list':
        succeed({
          longRunningMs: 60_000,
          currentUser: 'analytics',
          sessions: [
            {
              id: '4242',
              user: 'analytics',
              database: 'analytics',
              application: 'psql',
              client: '10.0.0.5',
              state: 'active',
              durationMs: 12_000,
              query: `select count(*) from orders where created_at > now() - interval '1 day'`,
              longRunning: false,
            },
            {
              id: '4301',
              user: 'analytics',
              database: 'analytics',
              application: 'DataForge',
              client: '10.0.0.9',
              state: 'idle in transaction',
              durationMs: 184_000,
              query: 'begin',
              waitEvent: 'Client:ClientRead',
              longRunning: true,
            },
          ],
        })
        return
      case 'session.terminate': {
        const payload = request.payload as { sessionId: string }
        succeed({ sessionId: payload.sessionId })
        return
      }
      case 'data.page': {
        const payload = request.payload as {
          filters?: { column: string; operator: string; value?: CellValue }[]
        }
        const demoColumns = [
          ['id', 'int4', false, true, 1],
          ['customer', 'text', false, false, 2],
          ['total', 'numeric', true, false, 3],
          ['created_at', 'timestamptz', false, false, 4],
        ] as const
        const allRows = Array.from({ length: 24 }, (_, index) => ({
          values: [index + 1, `Customer ${index + 1}`, (index + 1) * 12.5, '2026-11-06T09:12:00.000Z'] as CellValue[],
          identity: { id: index + 1 },
          version: String(1000 + index),
        }))
        const filters = payload.filters ?? []
        const filtered = allRows.filter((row) =>
          filters.every((filter) => {
            const index = demoColumns.findIndex((column) => column[0] === filter.column)
            const value = index === -1 ? null : row.values[index]
            const text = String(value ?? '').toLowerCase()
            const target = String(filter.value ?? '').toLowerCase()
            switch (filter.operator) {
              case 'is null':
                return value === null
              case 'is not null':
                return value !== null
              case 'contains':
                return text.includes(target)
              case 'eq':
                return String(value) === String(filter.value)
              default:
                return true
            }
          }),
        )
        succeed({
          columns: demoColumns.map(([name, dataType, nullable, isPrimaryKey, ordinal]) => ({
            name,
            dataType,
            nullable,
            isPrimaryKey,
            defaultValue: null,
            ordinal,
          })),
          primaryKey: ['id'],
          rows: filtered,
          totalRows: filtered.length,
          limit: 200,
          offset: 0,
          editable: true,
        })
        return
      }
      case 'data.commit':
        succeed({
          inserted: 0,
          updated: 0,
          deleted: 0,
          returnedKeys: [],
        })
        return
      case 'object.search':
        succeed({
          objects: [
            { schema: 'public', name: 'orders', kind: 'table' },
            { schema: 'public', name: 'customers', kind: 'table' },
          ],
          truncated: false,
        })
        return
      case 'object.ddl':
        succeed({
          ddl:
            'create table public.orders (\n  id integer primary key,\n  customer text not null,\n  total numeric\n);',
          cached: false,
        })
        return
      case 'object.stats':
        succeed({
          totalBytes: 8192,
          rowEstimate: 24,
          indexBytes: 4096,
          indexes: [
            { name: 'orders_pkey', bytes: 4096, unique: true, definition: 'create unique index orders_pkey on public.orders using btree (id)' },
          ],
        })
        return
      case 'object.openInEditor':
        succeed(null)
        return
      case 'data.export':
        succeed({ saved: true, path: '~/Downloads/orders.csv', rowCount: 24 })
        return
      default:
        fail({ code: 'invalid_request', message: `The demo host does not implement ${request.type}.` })
    }
  }
}

function createTransport(): Transport {
  return typeof acquireVsCodeApi === 'function' ? new VsCodeTransport() : new DemoTransport()
}

export interface PersistedUiState {
  activeConnectionId?: string
  sql?: string
}

class HostBridge {
  private readonly transport = createTransport()
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
  private readonly eventListeners = new Set<(event: HostEvent) => void>()
  private readonly readyListeners: Array<(payload: BootstrapPayload) => void> = []
  private bootstrap: BootstrapPayload | undefined
  private sequence = 0

  constructor() {
    this.transport.subscribe((message) => this.receive(message))
  }

  /** Resolves with the host bootstrap; sends `workbench.ready` on first call. */
  ready(): Promise<BootstrapPayload> {
    if (this.bootstrap) return Promise.resolve(this.bootstrap)
    return new Promise((resolve) => {
      this.readyListeners.push(resolve)
      this.send('workbench.ready', null)
    })
  }

  /**
   * `requestId` lets the caller keep the correlation id: the host uses it as the
   * cancellation handle for long-running work such as a query.
   */
  request<T extends RequestType>(type: T, payload: RequestInput<T>, requestId?: string): Promise<RequestOutput<T>> {
    return new Promise<RequestOutput<T>>((resolve, reject) => {
      this.pending.set(this.send(type, payload, requestId), { resolve: resolve as (value: unknown) => void, reject })
    })
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  persist(state: PersistedUiState): void {
    this.transport.persist(state)
  }

  restore(): PersistedUiState {
    const state = this.transport.restore()
    return isRecord(state) ? (state as PersistedUiState) : {}
  }

  private send(type: RequestType, payload: unknown, requestId?: string): string {
    const id = requestId ?? `${++this.sequence}-${Date.now().toString(36)}`
    this.transport.post({ kind: 'request', id, type, payload })
    return id
  }

  private receive(message: unknown): void {
    if (!isHostMessage(message)) return

    if (message.kind === 'ready') {
      this.bootstrap = message.payload
      for (const listener of this.readyListeners.splice(0)) listener(message.payload)
      return
    }

    if (message.kind === 'event') {
      for (const listener of this.eventListeners) listener(message.payload)
      return
    }

    const response = message.payload
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)

    if (response.ok) {
      pending.resolve(response.data)
      return
    }
    pending.reject(new HostRequestError(response.error.code, response.error.message, response.error.conflictingKeys))
  }
}

export const host = new HostBridge()

/** Guard used by UI code before trusting a request type from persisted state. */
export function isRequestType(value: unknown): value is RequestType {
  return typeof value === 'string' && (REQUEST_TYPES as readonly string[]).includes(value)
}
