import { z } from 'zod'

import type {
  ConnectionDraft,
  ConnectionTestTarget,
  QueryInput,
  RequestOutput,
  RequestType,
  ResponseError,
  WebviewResponse,
} from '@shared/protocol'
import { REQUEST_TYPES } from '@shared/protocol'

import type { Logger } from '../application/ports'
import type { ConnectionService } from '../application/connection-service'
import type { QueryService } from '../application/query-service'
import { DataForgeError, toErrorDto } from '../domain/errors'

const sslSchema = z.enum(['disable', 'require', 'verify-full'])

const draftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1).max(120),
  user: z.string().trim().min(1).max(120),
  password: z.string().max(4096),
  ssl: sslSchema,
  readOnly: z.boolean(),
})

const idSchema = z.object({ id: z.string().min(1).max(128) })

/** Per-request payload schemas: every message from the webview is untrusted. */
const payloadSchemas: Readonly<Record<RequestType, z.ZodType>> = {
  'connection.list': z.null(),
  'connection.create': draftSchema,
  'connection.update': idSchema.and(draftSchema.partial()),
  'connection.delete': idSchema,
  'connection.test': z
    .object({ connectionId: z.string().min(1).max(128).optional(), draft: draftSchema.optional() })
    .refine((value) => value.connectionId !== undefined || value.draft !== undefined, {
      message: 'Provide a connectionId or a draft.',
    }),
  'connection.connect': idSchema,
  'connection.disconnect': idSchema,
  'query.execute': z.object({
    connectionId: z.string().min(1).max(128),
    sql: z.string().min(1).max(1_000_000),
    maxRows: z.number().int().min(1).max(10_000),
  }),
  'query.cancel': z.object({ targetRequestId: z.string().min(1).max(128) }),
  'workbench.ready': z.null(),
}

const envelopeSchema = z.object({
  kind: z.literal('request'),
  id: z.string().min(1).max(128),
  type: z.enum(REQUEST_TYPES),
  payload: z.unknown(),
})

export interface MessageRouterDeps {
  readonly connections: ConnectionService
  readonly queries: QueryService
  readonly logger: Logger
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'payload'}: ${issue.message}`)
    .join('; ')
}

function okResponse<T extends RequestType>(id: string, type: T, data: RequestOutput<T>): WebviewResponse {
  // TypeScript cannot correlate the mapped union member with a generic `type`,
  // so the cast is local to this constructor.
  return { kind: 'response', id, type, ok: true, data } as WebviewResponse
}

function errorResponse(id: string, error: unknown): ResponseError {
  return { kind: 'response', id, ok: false, error: toErrorDto(error) }
}

/**
 * Validates every inbound webview message and dispatches it to a use case.
 * Returns the response to post back, or null when the message is unusable.
 */
export class MessageRouter {
  constructor(private readonly deps: MessageRouterDeps) {}

  async handle(raw: unknown): Promise<ResponseError | WebviewResponse | null> {
    const envelope = envelopeSchema.safeParse(raw)
    if (!envelope.success) {
      const id = extractId(raw)
      if (id) return errorResponse(id, new DataForgeError('invalid_request', formatIssues(envelope.error)))
      this.deps.logger.warn('Ignored a webview message that is not a request')
      return null
    }

    const { id, type } = envelope.data
    const payload = payloadSchemas[type].safeParse(envelope.data.payload)
    if (!payload.success) {
      return errorResponse(id, new DataForgeError('invalid_request', `Invalid ${type} payload — ${formatIssues(payload.error)}`))
    }

    try {
      return okResponse(id, type, await this.dispatch(type, payload.data, id))
    } catch (error) {
      if (!(error instanceof DataForgeError)) {
        this.deps.logger.error(`Unhandled error while serving ${type}`, error)
      }
      return errorResponse(id, error)
    }
  }

  /** Narrowed dispatch: each branch receives the payload validated for its type. */
  private async dispatch(type: RequestType, payload: unknown, requestId: string): Promise<RequestOutput<RequestType>> {
    const { connections, queries } = this.deps
    switch (type) {
      case 'connection.list':
        return connections.list()
      case 'connection.create':
        return connections.create(as<ConnectionDraft>(payload))
      case 'connection.update': {
        const patch = as<{ id: string } & Partial<ConnectionDraft>>(payload)
        const { id, ...changes } = patch
        return connections.update(id, changes)
      }
      case 'connection.delete':
        await connections.delete(as<{ id: string }>(payload).id)
        return null
      case 'connection.test':
        return connections.test(as<ConnectionTestTarget>(payload))
      case 'connection.connect':
        return connections.connect(as<{ id: string }>(payload).id)
      case 'connection.disconnect':
        return connections.disconnect(as<{ id: string }>(payload).id)
      case 'query.execute':
        return queries.execute(requestId, as<QueryInput>(payload))
      case 'query.cancel':
        queries.cancel(as<{ targetRequestId: string }>(payload).targetRequestId)
        return null
      case 'workbench.ready':
        return null
    }
  }
}

function as<T>(value: unknown): T {
  return value as T
}

function extractId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const id = (raw as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : undefined
}
