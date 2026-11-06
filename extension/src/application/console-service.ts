import { randomUUID } from 'node:crypto'

import type { ConsoleDto } from '@shared/protocol'

import { DataForgeError } from '../domain/errors'
import type { ConnectionService } from './connection-service'
import type { Logger } from './ports'
import type { QueryService } from './query-service'
import type { QuerySessionService } from './query-session-service'

export interface ConsoleServiceDeps {
  readonly connections: ConnectionService
  readonly queries: QueryService
  readonly sessions: QuerySessionService
  readonly logger: Logger
}

interface ConsoleRecord extends ConsoleDto {
  /** Request id of the statement the console is currently running. */
  requestId?: string
}

/**
 * Console registry: one console per editor tab the webview keeps open.
 *
 * The service only owns identity and lifecycle. SQL text and result rows stay in
 * the webview so the host never holds result sets it does not display.
 */
export class ConsoleService {
  private readonly consoles = new Map<string, ConsoleRecord>()
  private sequence = 0

  constructor(private readonly deps: ConsoleServiceDeps) {}

  open(connectionId: string, database?: string, title?: string): ConsoleDto {
    const summary = this.deps.connections.get(connectionId)
    const record: ConsoleRecord = {
      id: randomUUID(),
      connectionId,
      database: database ?? summary.database,
      title: title?.trim() || `Console ${(this.sequence += 1)}`,
    }
    this.consoles.set(record.id, record)
    this.deps.logger.info(`Opened ${record.title} on ${summary.name}`)
    return toDto(record)
  }

  copy(consoleId: string): ConsoleDto {
    const source = this.requireRecord(consoleId)
    const record: ConsoleRecord = {
      id: randomUUID(),
      connectionId: source.connectionId,
      database: source.database,
      title: `${source.title} copy`,
    }
    this.consoles.set(record.id, record)
    return toDto(record)
  }

  list(connectionId: string): ConsoleDto[] {
    return [...this.consoles.values()]
      .filter((record) => record.connectionId === connectionId)
      .map(toDto)
  }

  get openCount(): number {
    return this.consoles.size
  }

  require(consoleId: string): ConsoleDto {
    return toDto(this.requireRecord(consoleId))
  }

  /** Remembers which statement a console is running so closing it can cancel. */
  registerRun(consoleId: string | undefined, requestId: string): void {
    if (!consoleId) return
    const record = this.consoles.get(consoleId)
    if (record) record.requestId = requestId
  }

  clearRun(requestId: string): void {
    for (const record of this.consoles.values()) {
      if (record.requestId === requestId) delete record.requestId
    }
  }

  async close(consoleId: string): Promise<void> {
    const record = this.requireRecord(consoleId)
    this.consoles.delete(consoleId)
    if (record.requestId) {
      try {
        this.deps.queries.cancel(record.requestId)
      } catch {
        // The statement already finished; nothing to cancel.
      }
    }
    await this.deps.sessions.rollbackConsole(consoleId)
    this.deps.logger.info(`Closed ${record.title} on ${this.nameOf(record.connectionId)}`)
  }

  private requireRecord(consoleId: string): ConsoleRecord {
    const record = this.consoles.get(consoleId)
    if (!record) throw new DataForgeError('not_found', 'That console is not open any more.')
    return record
  }

  private nameOf(connectionId: string): string {
    return this.deps.connections.list().find((item) => item.id === connectionId)?.name ?? connectionId
  }
}

function toDto(record: ConsoleRecord): ConsoleDto {
  return {
    id: record.id,
    connectionId: record.connectionId,
    database: record.database,
    title: record.title,
  }
}
