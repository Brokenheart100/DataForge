import type { ConnectionCredentials, ConnectionProfile } from '../domain/connection'
import type { ConnectionStore, SecretStore } from '../application/ports'

/** In-memory `ConnectionStore` for tests; persists nothing outside the process. */
export class MemoryConnectionStore implements ConnectionStore {
  private profiles: ConnectionProfile[] = []

  async load(): Promise<ConnectionProfile[]> {
    return [...this.profiles]
  }

  async save(profiles: readonly ConnectionProfile[]): Promise<void> {
    this.profiles = [...profiles]
  }
}

/** In-memory `SecretStore` for tests; stands in for VS Code SecretStorage. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, ConnectionCredentials>()

  async read(connectionId: string): Promise<ConnectionCredentials | undefined> {
    return this.values.get(connectionId)
  }

  async write(connectionId: string, credentials: ConnectionCredentials): Promise<void> {
    this.values.set(connectionId, credentials)
  }

  async delete(connectionId: string): Promise<void> {
    this.values.delete(connectionId)
  }
}
