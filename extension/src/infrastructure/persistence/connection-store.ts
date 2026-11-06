import type { Memento } from 'vscode'
import { z } from 'zod'

import type { ConnectionStore } from '../../application/ports'
import type { ConnectionProfile } from '../../domain/connection'

const STORAGE_KEY = 'dataforge.connections.v1'

const tunnelSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  auth: z.enum(['password', 'private key']),
  privateKeyPath: z.string().min(1).optional(),
})

const profileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  // Profiles written before protocol v4 have no kind: default them to PostgreSQL.
  kind: z.enum(['postgresql', 'mysql', 'sqlite', 'sqlserver']).default('postgresql'),
  host: z.string().min(1),
  port: z.number().int().min(0).max(65535),
  database: z.string().min(1),
  user: z.string().min(1),
  ssl: z.enum(['disable', 'require', 'verify-full']),
  readOnly: z.boolean(),
  // Profiles written before protocol v7 have no tunnel.
  tunnel: tunnelSchema.optional(),
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
