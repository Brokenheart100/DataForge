import type { ConnectionState, SslMode } from '@shared/protocol'

/**
 * Persistent, secret-free description of a PostgreSQL connection.
 *
 * Passwords never live here: they are stored in VS Code SecretStorage and
 * fetched by the infrastructure layer only when a pool is created.
 */
export interface ConnectionProfile {
  readonly id: string
  readonly name: string
  readonly host: string
  readonly port: number
  readonly database: string
  readonly user: string
  readonly ssl: SslMode
  /** Marks the connection as read-only, blocking every write path in the UI. */
  readonly readOnly: boolean
  readonly createdAt: number
}

/** Transient secret paired with a profile, never persisted in settings. */
export interface ConnectionCredentials {
  readonly password: string
}

/** Everything infrastructure needs to open a pool. */
export interface ConnectionConfig {
  readonly profile: ConnectionProfile
  readonly credentials: ConnectionCredentials
}

export interface ConnectionStatus {
  readonly profile: ConnectionProfile
  readonly state: ConnectionState
  readonly serverVersion?: string
  readonly lastError?: string
}

export const DEFAULT_PORT = 5432

export interface ProfileDraft {
  name?: string
  host?: string
  port?: number
  database?: string
  user?: string
  ssl?: SslMode
  readOnly?: boolean
}

const SSL_MODES: readonly SslMode[] = ['disable', 'require', 'verify-full']

export function isSslMode(value: unknown): value is SslMode {
  return typeof value === 'string' && (SSL_MODES as readonly string[]).includes(value)
}

/**
 * Normalises user input into a profile. Validation that needs to reject the
 * request lives in the presentation layer; this keeps only the cheap,
 * deterministic clean-up so the domain stays free of transport concerns.
 */
export function createProfile(id: string, draft: ProfileDraft, now: number): ConnectionProfile {
  const host = draft.host?.trim() || 'localhost'
  const database = draft.database?.trim() || 'postgres'
  const user = draft.user?.trim() || 'postgres'
  return {
    id,
    name: draft.name?.trim() || `${database}@${host}`,
    host,
    port: clampPort(draft.port),
    database,
    user,
    ssl: draft.ssl ?? 'require',
    readOnly: draft.readOnly ?? false,
    createdAt: now,
  }
}

export function clampPort(port: number | undefined): number {
  if (port === undefined || !Number.isFinite(port)) return DEFAULT_PORT
  const rounded = Math.trunc(port)
  if (rounded < 1) return 1
  if (rounded > 65535) return 65535
  return rounded
}

/** Case-insensitive identity check used to avoid duplicate names in the list. */
export function sameProfileName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()
}
