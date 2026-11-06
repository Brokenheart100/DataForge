import type { SecretStorage } from 'vscode'

import type { SecretStore } from '../../application/ports'
import type { ConnectionCredentials } from '../../domain/connection'

/**
 * SecretStorage-backed credential store: database and SSH secrets never touch
 * settings.json, the webview, or the log output.
 */
export class VsCodeSecretStore implements SecretStore {
  constructor(private readonly secrets: SecretStorage) {}

  private static key(connectionId: string, field: 'password' | 'ssh-password' | 'ssh-passphrase'): string {
    return `dataforge.connection.${connectionId}.${field}`
  }

  async read(connectionId: string): Promise<ConnectionCredentials | undefined> {
    const [password, sshPassword, sshPassphrase] = await Promise.all([
      this.secrets.get(VsCodeSecretStore.key(connectionId, 'password')),
      this.secrets.get(VsCodeSecretStore.key(connectionId, 'ssh-password')),
      this.secrets.get(VsCodeSecretStore.key(connectionId, 'ssh-passphrase')),
    ])
    if (password === undefined && sshPassword === undefined && sshPassphrase === undefined) return undefined
    return {
      password: password ?? '',
      ...(sshPassword ? { sshPassword } : {}),
      ...(sshPassphrase ? { sshPassphrase } : {}),
    }
  }

  async write(connectionId: string, credentials: ConnectionCredentials): Promise<void> {
    await Promise.all([
      this.secrets.store(VsCodeSecretStore.key(connectionId, 'password'), credentials.password),
      this.writeOptional(connectionId, 'ssh-password', credentials.sshPassword),
      this.writeOptional(connectionId, 'ssh-passphrase', credentials.sshPassphrase),
    ])
  }

  async delete(connectionId: string): Promise<void> {
    await Promise.all([
      this.secrets.delete(VsCodeSecretStore.key(connectionId, 'password')),
      this.secrets.delete(VsCodeSecretStore.key(connectionId, 'ssh-password')),
      this.secrets.delete(VsCodeSecretStore.key(connectionId, 'ssh-passphrase')),
    ])
  }

  /** An omitted or empty secret deletes any previous value (auth method switched). */
  private async writeOptional(
    connectionId: string,
    field: 'ssh-password' | 'ssh-passphrase',
    value: string | undefined,
  ): Promise<void> {
    const key = VsCodeSecretStore.key(connectionId, field)
    if (value) await this.secrets.store(key, value)
    else await this.secrets.delete(key)
  }
}
