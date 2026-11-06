import type { ConnectionKind, ConnectionState, SshAuthMethod, SslMode } from '@shared/protocol'

/** SSH hop in front of the database. Contains no secrets. */
export interface SshTunnelProfile {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly auth: SshAuthMethod
  /** Private-key path when `auth` is `private key`. */
  readonly privateKeyPath?: string
}

/**
 * Persistent, secret-free description of a database connection.
 *
 * Passwords never live here: they are stored in VS Code SecretStorage and
 * fetched by the infrastructure layer only when a pool is created.
 */
export interface ConnectionProfile {
  readonly id: string
  readonly name: string
  /** Selects the driver; defaults to PostgreSQL for profiles written before v4. */
  readonly kind: ConnectionKind
  readonly host: string
  readonly port: number
  readonly database: string
  readonly user: string
  readonly ssl: SslMode
  /** Marks the connection as read-only, blocking every write path in the UI. */
  readonly readOnly: boolean
  readonly tunnel?: SshTunnelProfile
  readonly createdAt: number
}

/** Transient secrets paired with a profile, never persisted in settings. */
export interface ConnectionCredentials {
  readonly password: string
  readonly sshPassword?: string
  readonly sshPassphrase?: string
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

export const CONNECTION_KINDS: readonly ConnectionKind[] = ['postgresql', 'mysql', 'sqlite', 'sqlserver']

const KIND_DEFAULTS: Readonly<Record<ConnectionKind, { port: number; database: string; user: string }>> = {
  postgresql: { port: 5432, database: 'postgres', user: 'postgres' },
  mysql: { port: 3306, database: 'mysql', user: 'root' },
  sqlite: { port: 0, database: 'dataforge.sqlite', user: 'sqlite' },
  sqlserver: { port: 1433, database: 'master', user: 'sa' },
}

export function isConnectionKind(value: unknown): value is ConnectionKind {
  return typeof value === 'string' && (CONNECTION_KINDS as readonly string[]).includes(value)
}

export function defaultPortFor(kind: ConnectionKind): number {
  return KIND_DEFAULTS[kind].port
}

export interface ProfileDraft {
  kind?: ConnectionKind
  name?: string
  host?: string
  port?: number
  database?: string
  user?: string
  ssl?: SslMode
  readOnly?: boolean
  tunnel?: SshTunnelProfile | null
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
  const kind: ConnectionKind = draft.kind ?? 'postgresql'
  const defaults = KIND_DEFAULTS[kind]
  const host = draft.host?.trim() || 'localhost'
  const database = draft.database?.trim() || defaults.database
  const user = draft.user?.trim() || defaults.user
  return {
    id,
    kind,
    name: draft.name?.trim() || (kind === 'sqlite' ? database : `${database}@${host}`),
    host,
    port: clampPort(draft.port, defaults.port),
    database,
    user,
    ssl: draft.ssl ?? 'require',
    readOnly: draft.readOnly ?? false,
    ...(draft.tunnel ? { tunnel: normalizeTunnel(draft.tunnel) } : {}),
    createdAt: now,
  }
}

/** Trims an SSH hop and drops key material fields that do not apply. */
export function normalizeTunnel(tunnel: SshTunnelProfile): SshTunnelProfile {
  const auth: SshAuthMethod = tunnel.auth === 'private key' ? 'private key' : 'password'
  const privateKeyPath = tunnel.privateKeyPath?.trim()
  return {
    host: tunnel.host.trim(),
    port: clampPort(tunnel.port, 22),
    user: tunnel.user.trim(),
    auth,
    ...(auth === 'private key' && privateKeyPath ? { privateKeyPath } : {}),
  }
}

export function clampPort(port: number | undefined, fallback = DEFAULT_PORT): number {
  if (port === undefined || !Number.isFinite(port)) return fallback
  const rounded = Math.trunc(port)
  if (rounded < 1) return 1
  if (rounded > 65535) return 65535
  return rounded
}

/** Case-insensitive identity check used to avoid duplicate names in the list. */
export function sameProfileName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()
}
