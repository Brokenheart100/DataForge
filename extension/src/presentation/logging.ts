import * as vscode from 'vscode'

import type { Logger } from '../application/ports'
import { redactSecrets } from '../domain/errors'

/**
 * VS Code log channel logger. Every message is redacted before it reaches the
 * channel, so a password echoed inside a driver error never lands in a log file.
 */
export class OutputChannelLogger implements Logger, vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel

  constructor(name = 'DataForge') {
    this.channel = vscode.window.createOutputChannel(name, { log: true })
  }

  info(message: string): void {
    this.channel.info(redactSecrets(message))
  }

  warn(message: string): void {
    this.channel.warn(redactSecrets(message))
  }

  error(message: string, error?: unknown): void {
    const detail = describe(error)
    this.channel.error(detail ? `${redactSecrets(message)} — ${detail}` : redactSecrets(message))
  }

  show(): void {
    this.channel.show(true)
  }

  dispose(): void {
    this.channel.dispose()
  }
}

function describe(error: unknown): string {
  if (error === undefined) return ''
  if (error instanceof Error) return redactSecrets(error.stack ?? error.message)
  return redactSecrets(String(error))
}
