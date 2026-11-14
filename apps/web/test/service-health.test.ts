import { describe, expect, it } from 'vitest'
import type { Message } from '@latch/protocol'
import { healthWords, menuHealth, nameWithHealth } from '../src/components/ServiceHealth.tsx'
import { turnRoute, type Turn } from '../src/conversation.ts'
import { activityWords } from '../src/sessions.ts'

const now = new Date('2026-11-14T10:00:00.000Z')

describe("a service's health as the Host's real requests showed it", () => {
  it('says the state in a word, red for what failed and still does, amber for what passes by itself', () => {
    expect(healthWords(undefined, now)).toBeUndefined()
    expect(healthWords({ state: 'failing', last: 'server', at: '2026-11-14T09:57:00.000Z' }, now)).toEqual({
      state: '出错中',
      tone: 'err',
      detail: '最近一次：服务出错 · 3 分钟前',
    })
    expect(healthWords({ state: 'key-invalid', last: 'auth', at: '2026-11-14T09:59:50.000Z' }, now)).toMatchObject({
      state: '密钥无效',
      tone: 'err',
      detail: '最近一次：密钥无效 · 刚刚',
    })
    const resting = healthWords({ state: 'quota', last: 'quota', at: '2026-11-14T09:50:00.000Z', until: '2026-11-14T10:20:00.000Z' }, now)!
    expect(resting).toMatchObject({ state: '额度用完', tone: 'warn' })
    expect(resting.detail).toContain('前先用其他服务')
    expect(healthWords({ state: 'slow' }, now)).toEqual({ state: '变慢', tone: 'warn', detail: '' })
    // A state that ended since the catalog was read is no state: the next real request asks the service again.
    for (const state of ['quota', 'failing', 'key-invalid'] as const)
      expect(healthWords({ state, until: '2026-11-14T09:59:00.000Z' }, now)).toBeUndefined()
    expect(healthWords({ state: 'failing', last: 'forbidden', until: '2026-11-14T10:00:30.000Z' }, now)).toMatchObject({
      state: '出错中',
      detail: '最近一次：服务拒绝',
    })
  })

  it('shows a model menu only what stops the service now, as a word in its name', () => {
    expect(menuHealth({ health: { state: 'slow' } }, now)).toBeUndefined()
    expect(menuHealth({}, now)).toBeUndefined()
    const failing = menuHealth({ health: { state: 'failing' } }, now)
    expect(nameWithHealth('DeepSeek', failing)).toBe('DeepSeek · 出错中')
    expect(nameWithHealth('DeepSeek', undefined)).toBe('DeepSeek')
  })
})

describe('a turn a 「出错时改用」 service answered', () => {
  const turn = (routed: NonNullable<Message['turn']>['routed']): Turn =>
    ({
      key: 'turn',
      user: { id: 'u', role: 'user', text: 'hello', state: 'completed', createdAt: '', turn: { routed } },
      replies: [],
    }) as unknown as Turn

  it('names the service whose reply came back, for a session through Latch and for Latch 内置', () => {
    expect(
      turnRoute(
        turn({
          requests: 2,
          chosen: 'fake-model',
          models: [{ model: 'fake-model', requests: 2, fallback: 1, provider: 'second', used: 'other' }],
        }),
      ),
    ).toMatchObject({ fallback: { providerId: 'second', model: 'other' }, direct: false })
    expect(
      turnRoute(turn({ requests: 1, direct: true, models: [{ model: 'fake-model', requests: 1, fallback: 1, provider: 'second' }] })),
    ).toMatchObject({ fallback: { providerId: 'second' }, direct: true })
    const own = turnRoute(turn({ requests: 1, chosen: 'fake-model', models: [{ model: 'fake-model', requests: 1 }] }))!
    expect(own).not.toHaveProperty('fallback')
    expect(own.direct).toBe(false)
  })
})

describe('a run whose model request waits for a place', () => {
  it('says which service it waits for instead of what it was doing', () => {
    const live = { runId: 'run', activity: 'model' as const, since: '', lastEventAt: '' }
    expect(activityWords(live)).toBe('在等模型')
    expect(activityWords({ ...live, queued: true, queuedFor: 'DeepSeek' })).toBe('排队：DeepSeek')
    // Waiting for the Host's own limit names no service.
    expect(activityWords({ ...live, queued: true })).toBe('排队')
  })
})
