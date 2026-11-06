import { createServer, connect, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { describe, expect, it } from 'vitest'
import type { ConnectConfig } from 'ssh2'

import { buildSshConfig, openSshTunnel, type SshClientLike, type SshTunnelOptions } from '../tunnel'

interface FakeTarget {
  readonly host: string
  readonly port: number
}

class FakeSshClient implements SshClientLike {
  readonly configs: ConnectConfig[] = []
  forwarded = 0
  ended = false
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>()

  constructor(
    private readonly target: FakeTarget,
    private readonly failure?: Error,
  ) {}

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  connect(config: ConnectConfig): void {
    this.configs.push(config)
    queueMicrotask(() => {
      if (this.failure) this.emit('error', this.failure)
      else this.emit('ready')
    })
  }

  forwardOut(
    _srcIP: string,
    _srcPort: number,
    _dstIP: string,
    _dstPort: number,
    callback: (error: Error | null, stream: Duplex | null) => void,
  ): void {
    this.forwarded += 1
    const stream = connect(this.target.port, this.target.host)
    stream.once('connect', () => callback(null, stream))
    stream.once('error', (error) => callback(error, null))
  }

  end(): void {
    this.ended = true
  }

  destroy(): void {
    this.ended = true
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

function options(overrides: Partial<SshTunnelOptions> = {}): SshTunnelOptions {
  return {
    sshHost: 'bastion.example.test',
    sshPort: 22,
    user: 'forge',
    auth: { method: 'password', password: 's3cret' },
    targetHost: '127.0.0.1',
    targetPort: 5432,
    connectTimeoutMs: 5_000,
    ...overrides,
  }
}

async function listenEcho(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer((socket) => socket.pipe(socket))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

describe('buildSshConfig', () => {
  it('uses the password when the tunnel authenticates by password', async () => {
    const config = await buildSshConfig(options())
    expect(config).toMatchObject({
      host: 'bastion.example.test',
      port: 22,
      username: 'forge',
      password: 's3cret',
      readyTimeout: 5_000,
    })
  })

  it('reads the private key and passes the passphrase through', async () => {
    const config = await buildSshConfig(
      options({
        auth: { method: 'private key', privateKeyPath: '/keys/forge', passphrase: 'open sesame' },
      }),
      async (path) => {
        expect(path).toBe('/keys/forge')
        return '-----BEGIN OPENSSH PRIVATE KEY-----'
      },
    )
    expect(config.privateKey).toBe('-----BEGIN OPENSSH PRIVATE KEY-----')
    expect(config.passphrase).toBe('open sesame')
    expect(config.password).toBeUndefined()
  })
})

describe('openSshTunnel', () => {
  it('forwards local connections through the SSH session', async () => {
    const echo = await listenEcho()
    const fake = new FakeSshClient({ host: '127.0.0.1', port: echo.port })
    const tunnel = await openSshTunnel(options({ targetPort: echo.port }), { createClient: () => fake })

    const received = await new Promise<string>((resolve, reject) => {
      const socket = connect(tunnel.port, tunnel.host)
      socket.once('connect', () => socket.write('ping'))
      socket.once('data', (chunk) => {
        socket.end()
        resolve(String(chunk))
      })
      socket.once('error', reject)
    })

    expect(received).toBe('ping')
    expect(fake.forwarded).toBe(1)
    expect(fake.configs[0]).toMatchObject({ host: 'bastion.example.test', username: 'forge' })

    await tunnel.close()
    expect(fake.ended).toBe(true)
    await new Promise<void>((resolve) => echo.server.close(() => resolve()))
  })

  it('rejects and closes the client when the handshake fails', async () => {
    const fake = new FakeSshClient({ host: '127.0.0.1', port: 1 }, new Error('All configured authentication methods failed'))
    await expect(openSshTunnel(options(), { createClient: () => fake })).rejects.toThrow(
      'All configured authentication methods failed',
    )
    expect(fake.ended).toBe(true)
  })

  it('closes the listener exactly once', async () => {
    const echo = await listenEcho()
    const fake = new FakeSshClient({ host: '127.0.0.1', port: echo.port })
    const tunnel = await openSshTunnel(options({ targetPort: echo.port }), { createClient: () => fake })
    await tunnel.close()
    await tunnel.close()
    expect(fake.ended).toBe(true)
    await new Promise<void>((resolve) => echo.server.close(() => resolve()))
  })
})
