import type { Memento } from 'vscode'
import { describe, expect, it } from 'vitest'

import type { WorkbenchStateDto } from '@shared/protocol'

import { MementoWorkbenchStateStore } from '../workbench-state-store'

const KEY = 'dataforge.workbench.v1'

class MemoryMemento {
  readonly values = new Map<string, unknown>()

  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value)
  }
}

const STATE: WorkbenchStateDto = {
  activeConnectionId: 'conn-1',
  activeConsoleId: 'tab-1',
  consoles: [{ key: 'tab-1', title: 'Console 1', sql: 'select 1;', connectionId: 'conn-1' }],
  view: 'data',
  relation: { connectionId: 'conn-1', database: 'reporting', schema: 'public', relation: 'orders' },
  data: {
    offset: 200,
    orderBy: [{ column: 'id', direction: 'desc' }],
    filters: [{ column: 'state', operator: 'eq', value: 'open' }],
  },
}

describe('MementoWorkbenchStateStore', () => {
  it('round-trips a session snapshot', async () => {
    const memento = new MemoryMemento()
    const store = new MementoWorkbenchStateStore(memento as unknown as Memento)

    expect(await store.load()).toBeNull()
    await store.save(STATE)
    expect(await store.load()).toEqual(STATE)
  })

  it('treats a corrupt stored value as no session', async () => {
    const memento = new MemoryMemento()
    memento.values.set(KEY, { consoles: 'not-an-array' })
    const store = new MementoWorkbenchStateStore(memento as unknown as Memento)

    expect(await store.load()).toBeNull()
    memento.values.set(KEY, { consoles: [{ key: 't', title: 'T', sql: 'x', connectionId: 42 }] })
    expect(await store.load()).toBeNull()
  })
})
