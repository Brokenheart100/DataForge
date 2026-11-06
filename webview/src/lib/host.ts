import type {
  BootstrapPayload,
  ConnectionDraft,
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
                  'Node Type': 'Seq Scan',
                  'Relation Name': 'orders',
                  'Startup Cost': 0,
                  'Total Cost': 24.5,
                  'Plan Rows': 24,
                  'Plan Width': 42,
                },
              },
            ],
            null,
            2,
          ),
          durationMs: 4,
        })
        return
      case 'data.page':
        succeed({
          columns: [
            { name: 'id', dataType: 'int4', nullable: false, isPrimaryKey: true, defaultValue: null, ordinal: 1 },
            { name: 'customer', dataType: 'text', nullable: false, isPrimaryKey: false, defaultValue: null, ordinal: 2 },
            { name: 'total', dataType: 'numeric', nullable: true, isPrimaryKey: false, defaultValue: null, ordinal: 3 },
            { name: 'created_at', dataType: 'timestamptz', nullable: false, isPrimaryKey: false, defaultValue: null, ordinal: 4 },
          ],
          primaryKey: ['id'],
          rows: Array.from({ length: 24 }, (_, index) => ({
            values: [index + 1, `Customer ${index + 1}`, (index + 1) * 12.5, '2026-11-06T09:12:00.000Z'],
            identity: { id: index + 1 },
            version: String(1000 + index),
          })),
          totalRows: 24,
          limit: 200,
          offset: 0,
          editable: true,
        })
        return
      case 'data.commit':
        succeed({
          inserted: 0,
          updated: 0,
          deleted: 0,
          returnedKeys: [],
        })
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
