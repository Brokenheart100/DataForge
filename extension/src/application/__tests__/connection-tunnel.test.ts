import { describe, expect, it } from 'vitest'

import type { ConnectionDraft } from '@shared/protocol'

import { createProfile } from '../../domain/connection'
import type { ConnectionCredentials, ConnectionProfile } from '../../domain/connection'
import type { ColumnInfo, DatabaseDriver, DriverQueryInput, DriverQueryResult, RelationInfo, ServerInfo } from '../../domain/driver'
import { ConnectionService } from '../connection-service'
import type {
  ConnectionStore,
  ConnectionTunnel,
  DriverFactory,
  Logger,
  SecretStore,
  TunnelFactory,
} from '../ports'

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

const tunnelDraft: ConnectionDraft = {
  name: 'through bastion',
  host: 'db.internal',
  port: 5432,
  database: 'forge',
  user: 'app',
  password: 'db-secret',
  ssl: 'disable',
  readOnly: false,
  tunnel: { host: 'bastion.example', port: 22, user: 'deploy', auth: 'password' },
  sshPassword: 'ssh-secret',
}

class MemoryStore implements ConnectionStore {
  profiles: ConnectionProfile[] = []
  async load(): Promise<ConnectionProfile[]> {
    return this.profiles.map((profile) => ({ ...profile }))
  }
  async save(profiles: readonly ConnectionProfile[]): Promise<void> {
    this.profiles = profiles.map((profile) => ({ ...profile }))
  }
}

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, ConnectionCredentials>()
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

class FakeDriver implements DatabaseDriver {
  readonly kind = 'sqlserver'
  disposed = false

  constructor(
    readonly endpoint: { host: string; port: number },
    private readonly fail = false,
  ) {}

  async testConnection(): Promise<ServerInfo> {
    if (this.fail) throw new Error('login failed')
    return { serverVersion: 'SQL Server 2022', database: 'forge', user: 'app' }
  }

  async query(_input: DriverQueryInput): Promise<DriverQueryResult> {
    throw new Error('not used')
  }

  async listDatabases(): Promise<string[]> {
    return ['forge']
  }

  async listSchemas(): Promise<string[]> {
    return []
  }

  async listRelations(_schema: string): Promise<RelationInfo[]> {
    return []
  }

  async listColumns(_schema: string, _relation: string): Promise<ColumnInfo[]> {
    return []
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

function setup(fail = false) {
  const store = new MemoryStore()
  store.profiles = [createProfile('c1', tunnelDraft, Date.now())]
  const secrets = new MemorySecrets()
  secrets.values.set('c1', { password: 'db-secret', sshPassword: 'ssh-secret' })
  const endpoints: { host: string; port: number }[] = []
  const drivers: FakeDriver[] = []
  const tunnels: { disposed: boolean }[] = []
  const createDriver: DriverFactory = (config) => {
    const driver = new FakeDriver({ host: config.profile.host, port: config.profile.port }, fail)
    endpoints.push(driver.endpoint)
    drivers.push(driver)
    return driver
  }
  const createTunnel: TunnelFactory = async (profile): Promise<ConnectionTunnel> => {
    expect(profile.tunnel).toBeDefined()
    const state = { disposed: false }
    tunnels.push(state)
    return {
      host: '127.0.0.1',
      port: 45001,
      async dispose() {
        state.disposed = true
      },
    }
  }
  const service = new ConnectionService({ store, secrets, createDriver, createTunnel, logger })
  return { service, endpoints, drivers, tunnels }
}

describe('ConnectionService SSH tunnels', () => {
  it('connects the driver through the tunnel endpoint and closes it on disconnect', async () => {
    const { service, endpoints, drivers, tunnels } = setup()
    await service.initialize()

    const summary = await service.connect('c1')

    expect(tunnels).toHaveLength(1)
    expect(endpoints).toEqual([{ host: '127.0.0.1', port: 45001 }])
    expect(summary.state).toBe('connected')
    expect(summary.tunnel).toEqual(tunnelDraft.tunnel)
    expect(summary.capabilities).toEqual({
      query: true,
      dataEditing: false,
      exportCsv: false,
      transactions: false,
      schemaChanges: false,
      objectBrowser: false,
      databaseList: true,
      sessions: false,
    })

    await service.disconnect('c1')
    expect(drivers[0]?.disposed).toBe(true)
    expect(tunnels[0]?.disposed).toBe(true)
  })

  it('closes the tunnel and the driver when the login fails', async () => {
    const { service, drivers, tunnels } = setup(true)
    await service.initialize()

    await expect(service.connect('c1')).rejects.toMatchObject({ code: 'connection_failed' })

    expect(drivers[0]?.disposed).toBe(true)
    expect(tunnels[0]?.disposed).toBe(true)
    expect(service.list()[0]?.state).toBe('error')
  })

  it('opens an owned tunnel for a draft test and always closes it', async () => {
    const { service, endpoints, tunnels } = setup()
    await service.initialize()

    const result = await service.test({ draft: tunnelDraft })

    expect(result.database).toBe('forge')
    expect(tunnels).toHaveLength(1)
    expect(endpoints).toEqual([{ host: '127.0.0.1', port: 45001 }])
    expect(tunnels[0]?.disposed).toBe(true)
  })
})
