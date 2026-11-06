import type { ConnectionConfig, ConnectionCredentials, ConnectionProfile } from '../domain/connection'
import type { DatabaseDriver } from '../domain/driver'
/**
 * Ports owned by the application layer. Infrastructure implements them, so the
 * use cases never depend on VS Code, PostgreSQL, or the filesystem.
 */

/** Minimal logger port: the extension implements it with an OutputChannel. */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
}

/** Password port: implemented with VS Code SecretStorage. */
export interface SecretStore {
  read(connectionId: string): Promise<ConnectionCredentials | undefined>
  write(connectionId: string, credentials: ConnectionCredentials): Promise<void>
  delete(connectionId: string): Promise<void>
}

/** Connection metadata port: implemented with VS Code globalState. */
export interface ConnectionStore {
  load(): Promise<ConnectionProfile[]>
  save(profiles: readonly ConnectionProfile[]): Promise<void>
}

/** Builds a driver for a fully resolved connection (profile + password). */
export type DriverFactory = (config: ConnectionConfig) => DatabaseDriver

/** Loopback endpoint of an open SSH tunnel. */
export interface ConnectionTunnel {
  readonly host: string
  readonly port: number
  dispose(): Promise<void>
}

/**
 * Opens the SSH hop before the driver is created. The factory gets the real
 * profile (so it knows the bastion) and the resolved secrets (password or key
 * passphrase), and returns only the local endpoint the driver should dial.
 */
export type TunnelFactory = (
  profile: ConnectionProfile,
  credentials: ConnectionCredentials,
) => Promise<ConnectionTunnel>

export type Listener<T> = (value: T) => void

export interface Subscription {
  dispose(): void
}

/** Tiny synchronous emitter, so the application layer stays free of VS Code. */
export class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>()

  readonly event = (listener: Listener<T>): Subscription => {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  fire(value: T): void {
    // Iterating the live set is safe: JS defines deletion of the current entry
    // during iteration, and a listener that disposes itself must not skip peers.
    for (const listener of this.listeners) {
      try {
        listener(value)
      } catch {
        // A failing listener must not break the others.
      }
    }
  }
}
