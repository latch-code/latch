import { describe, expect, it } from 'vitest'
import type { ComputerSummary } from '@latch/protocol'
import { computerState, olderVersion, otherWaiting } from '../src/core/computers.ts'

const HOST_A = 'a'.repeat(52)
const HOST_B = 'b'.repeat(52)
const item = { hostId: HOST_B, taskId: 't1', title: '添加币种筛选', kind: 'approval' as const, since: '2026-11-12T08:00:00.000Z' }
const computer = (extra: Partial<ComputerSummary>): ComputerSummary => ({
  hostId: HOST_B,
  name: 'build-mini',
  local: false,
  state: 'online',
  ...extra,
})

describe('other computers on this Mac’s page', () => {
  it('lists what waits on other computers only, live while they answer and 离线前 otherwise', () => {
    const local = computer({ hostId: HOST_A, local: true, name: 'studio' })
    expect(otherWaiting({ computers: [local, computer({ waiting: [item] })] }, HOST_A)).toEqual([
      { computer: computer({ waiting: [item] }), items: [item], live: true },
    ])
    expect(otherWaiting({ computers: [local, computer({ state: 'offline', waiting: [item] })] }, HOST_A)[0]!.live).toBe(false)
    // This page's own Host, a computer with nothing waiting, and no list at all add nothing.
    expect(otherWaiting({ computers: [computer({ waiting: [item] })] }, HOST_B)).toEqual([])
    expect(otherWaiting({ computers: [computer({ waiting: [] })] }, HOST_A)).toEqual([])
    expect(otherWaiting(undefined, HOST_A)).toEqual([])
  })

  it('says 正在更新 for a Host stopping to update, and compares versions numerically', () => {
    expect(computerState({ state: 'stopping', reason: 'update' }).text).toBe('正在更新')
    expect(olderVersion('0.9.1', '0.9.3')).toBe(true)
    expect(olderVersion('0.10.0', '0.9.3')).toBe(false)
    expect(olderVersion('0.9.3', '0.9.3')).toBe(false)
    expect(olderVersion('0.9.3-beta.1', '0.9.3')).toBe(true)
    expect(olderVersion(undefined, '0.9.3')).toBe(false)
    expect(olderVersion('x', '0.9.3')).toBe(false)
  })
})
