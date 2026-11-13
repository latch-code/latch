import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CustomAgentCreate } from '@latch/protocol'
import { AgentCreation, forgetAgentCreations, forgetPrivateAgentCreation } from '../src/core/agentCreation.ts'

afterEach(() => vi.unstubAllGlobals())

function setup() {
  const entries = new Map<string, string>()
  const storage = {
    get length() {
      return entries.size
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    },
    removeItem: (key: string) => {
      entries.delete(key)
    },
    clear: () => entries.clear(),
  }
  vi.stubGlobal('localStorage', storage)
  const tails = new Map<string, Promise<unknown>>()
  vi.stubGlobal('navigator', {
    locks: {
      request: <T>(key: string, task: () => Promise<T>) => {
        const next = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(task)
        tails.set(key, next)
        return next
      },
    },
  })
  const origin = `https://${crypto.randomUUID()}.invalid`
  forgetAgentCreations(origin, 'first')
  const body: CustomAgentCreate = {
    requestId: crypto.randomUUID(),
    name: '资料员',
    description: '',
    harnessId: 'standard',
    mode: 'agent',
    instructions: '保留来源',
    skills: [],
  }
  return { entries, storage, origin, body, store: new AgentCreation(origin, 'first', true) }
}

describe('private Agent creation requests', () => {
  it('retains the exact request until a matching result, never overwrites it with another creation', async () => {
    const { store, body, origin } = setup()
    await store.exclusive(async () => store.begin(body))
    const reopened = new AgentCreation(origin, 'first', true)
    expect(reopened.read()?.body).toEqual(body)
    expect(() => reopened.begin({ ...body, requestId: crypto.randomUUID() })).toThrow('上一次创建')
    expect(() => reopened.begin({ ...body, name: '不相同' })).toThrow('不同创建')
    expect(reopened.finish('another-request')).toBe(false)
    expect(reopened.read()?.body).toEqual(body)
    expect(reopened.finish(body.requestId)).toBe(true)
    expect(store.read()).toBeNull()
  })

  it('keeps sensitive text in memory while persisting only an unknown-request marker', () => {
    const { store, body, entries } = setup()
    const secret = `sk-${'a'.repeat(40)}`
    const sensitive = { ...body, instructions: `使用 ${secret}` }
    store.begin(sensitive)
    expect(store.read()?.body).toEqual(sensitive)
    expect(JSON.stringify([...entries])).not.toContain(secret)
    expect(JSON.stringify([...entries])).toContain(body.requestId)
  })

  it('refuses private reads and writes without all-data authority', () => {
    const { store, body, origin } = setup()
    store.begin(body)
    const narrow = new AgentCreation(origin, 'first', false)
    expect(narrow.read()).toBeNull()
    expect(() => narrow.begin(body)).toThrow('不能创建')
    expect(narrow.finish(body.requestId)).toBe(false)
  })

  it('clears revoked private state and prevents old callbacks from restoring it, while a new grant can work', () => {
    const { store, body, origin, entries } = setup()
    store.begin(body)
    forgetPrivateAgentCreation(origin, 'first')
    expect(store.read()).toBeNull()
    expect(() => store.begin(body)).toThrow('不能创建')
    expect(store.finish(body.requestId)).toBe(false)
    expect(JSON.stringify([...entries])).not.toContain('保留来源')
    const granted = new AgentCreation(origin, 'first', true)
    granted.begin(body)
    expect(granted.read()?.body).toEqual(body)
  })

  it('isolates origins and replaces a device without letting a late old write erase the replacement request', () => {
    const { store, body, origin } = setup()
    store.begin(body)
    expect(new AgentCreation('https://other.invalid', 'first', true).read()).toBeNull()
    forgetAgentCreations(origin, 'next')
    const next = new AgentCreation(origin, 'next', true)
    const newer = { ...body, requestId: crypto.randomUUID(), name: '下一台' }
    next.begin(newer)
    expect(() => store.begin(body)).toThrow('不能创建')
    expect(store.finish(body.requestId)).toBe(false)
    expect(next.read()?.body).toEqual(newer)
    forgetAgentCreations(origin)
    expect(next.read()).toBeNull()
    expect(() => next.begin(newer)).toThrow('不能创建')
  })

  it('does not send if the required pending record cannot be stored', async () => {
    const { store, body, storage } = setup()
    const send = vi.fn()
    storage.setItem = () => {
      throw new Error('quota')
    }
    await expect(
      store.exclusive(async () => {
        store.begin(body)
        send()
      }),
    ).rejects.toThrow('quota')
    expect(send).not.toHaveBeenCalled()
  })

  it('never replaces an unknown request when reading its storage entry throws', () => {
    const { store, body, entries, storage } = setup()
    store.begin(body)
    const [key, original] = [...entries].find(([, value]) => value.includes(body.requestId))!
    const read = storage.getItem
    storage.getItem = name => {
      if (name === key) throw new Error('temporarily unreadable')
      return read(name)
    }
    expect(() => store.begin({ ...body, requestId: crypto.randomUUID(), name: '不能覆盖' })).toThrow()
    expect(store.read()).toMatchObject({ unavailable: true })
    expect(store.read()?.token).toBeUndefined()
    expect(store.finish(body.requestId)).toBe(false)
    expect(entries.get(key)).toBe(original)
    storage.getItem = read
    expect(store.read()?.body).toEqual(body)
  })

  it('keeps an unreadable existing record blocking until an explicit abandonment, without guessing its result', () => {
    const { store, body, storage, entries } = setup()
    store.begin(body)
    const key = [...entries].find(([, value]) => value.includes(body.requestId))![0]
    storage.setItem(key, '{broken')
    expect(store.read()).toMatchObject({ requestId: '无法读取', unread: true })
    expect(() => store.begin({ ...body, requestId: crypto.randomUUID() })).toThrow('上一次创建')
    expect(store.finish('无法读取')).toBe(true)
    expect(store.read()).toBeNull()
  })

  it('does not abandon a replacement request or a different corrupt record using an old confirmation', () => {
    const { store, body, entries, storage } = setup()
    store.begin(body)
    const original = store.read()!.token!
    store.finish(body.requestId)
    const next = { ...body, requestId: crypto.randomUUID(), name: '另一个请求' }
    store.begin(next)
    expect(store.abandon(original)).toBe(false)
    expect(store.read()?.body).toEqual(next)
    const key = [...entries].find(([, value]) => value.includes(next.requestId))![0]
    storage.setItem(key, '{broken first')
    const corrupt = store.read()!.token!
    storage.setItem(key, '{broken replacement')
    expect(store.abandon(corrupt)).toBe(false)
    expect(storage.getItem(key)).toBe('{broken replacement')
    expect(store.abandon(store.read()!.token!)).toBe(true)
  })

  it('serializes two windows and refuses a different request while the first result is unknown', async () => {
    const { store, body, origin } = setup()
    const second = new AgentCreation(origin, 'first', true)
    const calls: string[] = []
    let release!: () => void
    const waiting = new Promise<void>(resolve => {
      release = resolve
    })
    const first = store.exclusive(async () => {
      store.begin(body)
      calls.push(body.requestId)
      await waiting
    })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const refused = second.exclusive(async () => {
      second.begin({ ...body, requestId: crypto.randomUUID() })
      calls.push('wrong')
    })
    const rejection = expect(refused).rejects.toThrow('上一次创建')
    expect(calls).toEqual([body.requestId])
    release()
    await first
    await rejection
    expect(second.read()?.body).toEqual(body)
    expect(calls).toHaveLength(1)
  })

  it('does not abandon a new request after waiting for another window to finish the previous one', async () => {
    const { store, body, origin } = setup()
    store.begin(body)
    const seen = store.read()!.token!
    const other = new AgentCreation(origin, 'first', true)
    let release!: () => void
    const waiting = new Promise<void>(resolve => {
      release = resolve
    })
    const next = { ...body, requestId: crypto.randomUUID(), name: '锁内的新请求' }
    const retry = other.exclusive(async () => {
      await waiting
      expect(other.finish(body.requestId)).toBe(true)
      other.begin(next)
    })
    const abandon = store.exclusive(async () => store.abandon(seen))
    release()
    await retry
    expect(await abandon).toBe(false)
    expect(store.read()?.body).toEqual(next)
  })
})
