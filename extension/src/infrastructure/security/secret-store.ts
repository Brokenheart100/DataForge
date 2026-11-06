import type { SecretStorage } from 'vscode'

import type { SecretStore } from '../../application/ports'

/**
 * SecretStorage-backed password store: credentials never touch settings.json,
 * the webview, or the log output.
 */
export class VsCodeSecretStore implements SecretStore {
  constructor(private readonly secrets: SecretStorage) {}

  private static key(connectionId: string): string {
    return `dataforge.connection.${connectionId}.password`
  }

  async read(connectionId: string) {
    const password = await this.secrets.get(VsCodeSecretStore.key(connectionId))
    return password === undefined ? undefined : { password }
  }

  async write(connectionId: string, credentials: { password: string }): Promise<void> {
    await this.secrets.store(VsCodeSecretStore.key(connectionId), credentials.password)
  }

  async delete(connectionId: string): Promise<void> {
    await this.secrets.delete(VsCodeSecretStore.key(connectionId))
  }
}
