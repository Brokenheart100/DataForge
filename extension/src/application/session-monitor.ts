import type { ServerSessionDto, SessionListDto, SessionTerminateDto } from '@shared/protocol'

import type { ServerSessionInfo, SessionDriver } from '../domain/driver'
import { isSessionDriver } from '../domain/driver'
import { DataForgeError } from '../domain/errors'
import type { ConnectionService } from './connection-service'
import type { Logger } from './ports'

/** Sessions idle for longer than this are flagged in the panel. */
export const DEFAULT_LONG_RUNNING_MS = 60_000

export interface SessionMonitorDeps {
  readonly connections: ConnectionService
  readonly logger: Logger
  readonly longRunningMs?: number
}

export interface SessionListRequest {
  readonly connectionId: string
  readonly database?: string
}

export interface SessionTerminateRequest extends SessionListRequest {
  readonly sessionId: string
  readonly confirm: boolean
}

/**
 * Operations view of the server: which backends are connected and what they
 * are doing. Termination only ever targets sessions owned by the connection's
 * own role, so a shared server cannot be used to disrupt other users.
 */
export class SessionMonitor {
  private readonly longRunningMs: number

  constructor(private readonly deps: SessionMonitorDeps) {
    this.longRunningMs = deps.longRunningMs ?? DEFAULT_LONG_RUNNING_MS
  }

  async list(request: SessionListRequest): Promise<SessionListDto> {
    const driver = await this.driverFor(request)
    const [sessions, currentUser] = await Promise.all([
      driver.listSessions(),
      driver.currentUser().catch(() => undefined),
    ])
    const dto: SessionListDto = {
      sessions: sessions.map((session) => this.toDto(session)),
      longRunningMs: this.longRunningMs,
    }
    if (currentUser !== undefined) dto.currentUser = currentUser
    return dto
  }

  async terminate(request: SessionTerminateRequest): Promise<SessionTerminateDto> {
    if (request.confirm !== true) {
      throw new DataForgeError('invalid_request', 'Confirm the termination before closing a session.')
    }
    const driver = await this.driverFor(request)
    const sessions = await driver.listSessions()
    const session = sessions.find((candidate) => candidate.id === request.sessionId)
    if (!session) {
      throw new DataForgeError('not_found', 'That session is no longer running.')
    }
    const currentUser = await driver.currentUser()
    if (currentUser === undefined || session.user !== currentUser) {
      throw new DataForgeError(
        'invalid_request',
        `Only sessions owned by "${currentUser ?? 'this connection'}" can be terminated.`,
      )
    }
    await driver.terminateSession(session.id)
    this.deps.logger.info(`Terminated session ${session.id} on ${request.database ?? 'the default database'}`)
    return { sessionId: session.id }
  }

  private toDto(session: ServerSessionInfo): ServerSessionDto {
    const dto: ServerSessionDto = {
      id: session.id,
      longRunning: (session.durationMs ?? 0) >= this.longRunningMs,
    }
    if (session.user !== undefined) dto.user = session.user
    if (session.database !== undefined) dto.database = session.database
    if (session.application !== undefined) dto.application = session.application
    if (session.client !== undefined) dto.client = session.client
    if (session.state !== undefined) dto.state = session.state
    if (session.startedAt !== undefined) dto.startedAt = session.startedAt
    if (session.durationMs !== undefined) dto.durationMs = session.durationMs
    if (session.query !== undefined) dto.query = session.query
    if (session.waitEvent !== undefined) dto.waitEvent = session.waitEvent
    return dto
  }

  private async driverFor(request: SessionListRequest): Promise<SessionDriver> {
    const driver = await this.deps.connections.requireScopedDriver(request.connectionId, request.database)
    if (!isSessionDriver(driver)) {
      throw new DataForgeError('internal', 'Session monitoring is not available for this driver yet.')
    }
    return driver
  }
}
