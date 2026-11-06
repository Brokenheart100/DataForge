import { readFile } from 'node:fs/promises'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import { Client } from 'ssh2'
import type { ConnectConfig } from 'ssh2'

/**
 * Password or key material for the SSH hop. The database password is separate:
 * the SSH secret only unlocks the tunnel, and the caller resolves it from
 * SecretStorage right before opening the tunnel.
 */
export type SshAuthentication =
  | { readonly method: 'password'; readonly password: string }
  | { readonly method: 'private key'; readonly privateKeyPath: string; readonly passphrase?: string }

export interface SshTunnelOptions {
  readonly sshHost: string
  readonly sshPort: number
  readonly user: string
  readonly auth: SshAuthentication
  /** Database endpoint as seen from the SSH server, e.g. `localhost:5432`. */
  readonly targetHost: string
  readonly targetPort: number
  readonly connectTimeoutMs: number
}

/** A listening forwarder on 127.0.0.1 that pipes every client into the SSH session. */
export interface SshTunnelHandle {
  readonly host: string
  readonly port: number
  close(): Promise<void>
}

/** The slice of `ssh2.Client` this module needs; lets tests fake the handshake. */
export interface SshClientLike {
  connect(config: ConnectConfig): void
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (error: Error | null, stream: Duplex | null) => void,
  ): void
  end(): void
  destroy(): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface SshTunnelDeps {
  readonly createClient?: () => SshClientLike
  readonly readText?: (path: string) => Promise<string>
}

const LOOPBACK = '127.0.0.1'

/**
 * Builds the `ssh2` connect options. Key material is read lazily through the
 * injected reader so tests never need a real private-key file.
 */
export async function buildSshConfig(
  options: SshTunnelOptions,
  readText: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: options.sshHost,
    port: options.sshPort,
    username: options.user,
    readyTimeout: options.connectTimeoutMs,
  }
  if (options.auth.method === 'password') return { ...base, password: options.auth.password }
  const privateKey = await readText(options.auth.privateKeyPath)
  return options.auth.passphrase ? { ...base, privateKey, passphrase: options.auth.passphrase } : { ...base, privateKey }
}

/**
 * Opens a local TCP listener that forwards each connection through SSH to the
 * database endpoint. Callers put the returned host/port into the driver config,
 * so no driver knows that SSH exists.
 */
export async function openSshTunnel(
  options: SshTunnelOptions,
  deps: SshTunnelDeps = {},
): Promise<SshTunnelHandle> {
  const client = (deps.createClient ?? (() => new Client() as unknown as SshClientLike))()
  const sockets = new Set<Socket>()
  let server: Server | undefined
  let closed = false

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
    }
    client.end()
  }

  try {
    const config = await buildSshConfig(options, deps.readText)
    await new Promise<void>((resolve, reject) => {
      let connected = false
      client.on('ready', () => {
        connected = true
        resolve()
      })
      client.on('error', (...args: unknown[]) => {
        const error = args[0] instanceof Error ? args[0] : new Error('SSH connection failed.')
        if (connected) void close()
        else reject(error)
      })
      client.on('close', () => {
        if (!closed) void close()
      })
      client.connect(config)
    })

    server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => socket.destroy())
      client.forwardOut(
        socket.remoteAddress ?? LOOPBACK,
        socket.remotePort ?? 0,
        options.targetHost,
        options.targetPort,
        (error, stream) => {
          if (error || !stream) {
            socket.destroy()
            return
          }
          stream.on('error', () => socket.destroy())
          socket.on('close', () => stream.destroy())
          socket.pipe(stream).pipe(socket)
        },
      )
    })

    const port = await new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server!.once('error', onError)
      server!.listen(0, LOOPBACK, () => {
        server!.off('error', onError)
        resolve((server!.address() as AddressInfo).port)
      })
    })

    return { host: LOOPBACK, port, close }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}
