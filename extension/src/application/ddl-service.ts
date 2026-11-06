import type {
  DdlApplyDto,
  DdlApplyInput,
  DdlPlanDto,
  DdlPreviewDto,
  DdlStatementDto,
  SchemaDiffDto,
  SchemaDiffInput,
  SchemaDiffEntryDto,
  ObjectKind,
} from '@shared/protocol'

import { expectedConfirmation, needsConfirmation, validateDdlPlan } from '../domain/ddl'
import type { DatabaseDriver, DdlDriver } from '../domain/driver'
import { DataForgeError, wrapError } from '../domain/errors'
import type { ConnectionService } from './connection-service'
import type { Logger } from './ports'
import type { QuerySessionService } from './query-session-service'
import type { SchemaService } from './schema-service'

/** Turns a validated plan into dialect statements; injected by the host. */
export type DdlPlanner = (plan: DdlPlanDto) => readonly DdlStatementDto[]

export interface DdlServiceDeps {
  connections: ConnectionService
  sessions: QuerySessionService
  schemas: SchemaService
  planner: DdlPlanner
  logger: Logger
}

export function isDdlDriver(driver: DatabaseDriver): driver is DdlDriver {
  return typeof (driver as Partial<DdlDriver>).applyDdl === 'function'
}

function firstProblems(problems: readonly string[]): string {
  const shown = problems.slice(0, 5)
  const suffix = problems.length > shown.length ? ` (+${problems.length - shown.length} more)` : ''
  return `${shown.join(' ')}${suffix}`
}

/**
 * Previews and applies structural changes.
 *
 * The service owns the safety rules: plans are validated before any SQL exists,
 * DDL is compiled by the injected dialect, destructive plans need a typed
 * confirmation, and read-only connections or open transactions refuse outright.
 */
export class DdlService {
  constructor(private readonly deps: DdlServiceDeps) {}

  preview(plan: DdlPlanDto): DdlPreviewDto {
    const summary = this.deps.connections.get(plan.connectionId)
    if (summary.kind !== 'postgresql') {
      throw new DataForgeError(
        'internal',
        `Structural changes are not available for ${summary.kind} connections yet.`,
      )
    }

    const validation = validateDdlPlan(plan)
    if (validation.problems.length > 0) {
      throw new DataForgeError('invalid_request', firstProblems(validation.problems))
    }

    const statements = this.deps.planner(plan)
    const requiresConfirmation = needsConfirmation(statements)
    return {
      statements: statements.map((statement) => ({ ...statement })),
      requiresConfirmation,
      expectedConfirmation: expectedConfirmation(plan, statements),
      warnings: validation.warnings,
    }
  }

  async apply(input: DdlApplyInput): Promise<DdlApplyDto> {
    const preview = this.preview(input.plan)
    const summary = this.deps.connections.get(input.plan.connectionId)

    if (summary.readOnly) {
      throw new DataForgeError(
        'invalid_request',
        'This connection is read-only, so schema changes are refused.',
      )
    }
    if (this.deps.sessions.hasOpenTransaction(input.plan.connectionId)) {
      throw new DataForgeError(
        'invalid_request',
        'Commit or roll back the open transaction before changing the schema.',
      )
    }
    if (preview.expectedConfirmation !== null && input.confirm !== preview.expectedConfirmation) {
      throw new DataForgeError(
        'invalid_request',
        `Type "${preview.expectedConfirmation}" to confirm this change.`,
      )
    }

    const driver = await this.deps.connections.requireDriver(input.plan.connectionId)
    if (!isDdlDriver(driver)) {
      throw new DataForgeError('internal', 'This connection does not support schema changes yet.')
    }

    const started = Date.now()
    try {
      const statements = preview.statements.map((statement) => statement.sql)
      await driver.applyDdl(statements)
      this.deps.schemas.invalidate(input.plan.connectionId)
      this.deps.logger.info(
        `Applied ${statements.length} DDL statement(s) to "${input.plan.schema}"."${input.plan.table}".`,
      )
      return { statements: statements.length, durationMs: Date.now() - started }
    } catch (error) {
      throw wrapError('query_failed', 'Applying schema changes', error)
    }
  }

  async diff(input: SchemaDiffInput): Promise<SchemaDiffDto> {
    const left = await this.deps.schemas.listRelations(
      input.connectionId,
      input.left.schema,
      input.left.database,
    )
    const right = await this.deps.schemas.listRelations(
      input.connectionId,
      input.right.schema,
      input.right.database,
    )

    const leftByName = new Map(left.map((relation) => [relation.name, relation]))
    const rightByName = new Map(right.map((relation) => [relation.name, relation]))

    const added: SchemaDiffEntryDto[] = []
    const removed: SchemaDiffEntryDto[] = []
    const changed: { name: string; leftKind: ObjectKind; rightKind: ObjectKind }[] = []

    for (const relation of right) {
      const previous = leftByName.get(relation.name)
      if (!previous) {
        added.push({ schema: input.right.schema, name: relation.name, kind: relation.kind })
      } else if (previous.kind !== relation.kind) {
        changed.push({ name: relation.name, leftKind: previous.kind, rightKind: relation.kind })
      }
    }

    for (const relation of left) {
      if (!rightByName.has(relation.name)) {
        removed.push({ schema: input.left.schema, name: relation.name, kind: relation.kind })
      }
    }

    const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)
    added.sort(byName)
    removed.sort(byName)
    changed.sort(byName)
    return { added, removed, changed }
  }
}
