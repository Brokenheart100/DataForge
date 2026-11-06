import type { Memento } from 'vscode'
import { z } from 'zod'

import type { ConnectionStore } from '../../application/ports'
import type { ConnectionProfile } from '../../domain/connection'

const STORAGE_KEY = 'dataforge.connections.v1'

const profileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1),
  user: z.string().min(1),
  ssl: z.enum(['disable', 'require', 'verify-full']),
  readOnly: z.boolean(),
  createdAt: z.number(),
})

/**
 * Connection metadata is not secret, so it lives in globalState next to other
 * extension settings. Passwords are stored separately through SecretStorage.
 */
export class MementoConnectionStore implements ConnectionStore {
  constructor(private readonly state: Memento) {}

  async load(): Promise<ConnectionProfile[]> {
    const raw: unknown = this.state.get(STORAGE_KEY, [])
    if (!Array.isArray(raw)) return []

    // globalState is user-editable on disk: never trust its shape.
    const profiles: ConnectionProfile[] = []
    for (const entry of raw) {
      const parsed = profileSchema.safeParse(entry)
      if (parsed.success) profiles.push(parsed.data)
    }
    return profiles
  }

  async save(profiles: readonly ConnectionProfile[]): Promise<void> {
    await this.state.update(STORAGE_KEY, profiles)
  }
}
