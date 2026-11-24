import { describe, expect, it } from 'vitest'
import type { ComputerSummary } from '@latch/protocol'
import {
  computerState,
  connectionTransport,
  currentDesktopComputer,
  olderVersion,
  otherComputerRows,
  otherWaiting,
} from '../src/core/computers.ts'

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
  it('uses the current desktop origin to exclude its own computer from the switcher', () => {
    const local = computer({ hostId: HOST_A, local: true, name: 'studio' })
    const remote = computer({ state: 'offline' })
    const view = { computers: [local, remote] }
    expect(currentDesktopComputer(view, { protocol: 'latch:', hostname: 'app' })).toBe(local)
    const current = currentDesktopComputer(view, { protocol: 'latch:', hostname: `h-${HOST_B}` })
    expect(current).toBe(remote)
    expect(otherComputerRows(view, current?.hostId, undefined).map(row => row.hostId)).toEqual([HOST_A])
    expect(currentDesktopComputer(view, { protocol: 'https:', hostname: `h-${HOST_B}` })).toBeUndefined()
  })

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

  it('lists the other computers for the computer popover, counting what waits only where it answers', () => {
    const local = computer({ hostId: HOST_A, local: true, name: 'studio', version: '1.0.0' })
    const remote = computer({ waiting: [item], version: '0.9.0' })
    // From this Mac's page: the remote one, its waiting count and an older version against this Mac's Host.
    expect(otherComputerRows({ computers: [local, remote] }, HOST_A, '1.0.0')).toEqual([
      { hostId: HOST_B, name: 'build-mini', state: 'online', text: '在线', count: 1, older: true },
    ])
    // From the remote computer's window: this Mac is 「这台 Mac」 and never older; a gone computer says what waited.
    expect(otherComputerRows({ computers: [local, remote] }, HOST_B, undefined)).toEqual([
      { hostId: HOST_A, name: '这台 Mac', state: 'online', text: '在线', count: 0, older: false },
    ])
    const gone = otherComputerRows({ computers: [local, computer({ state: 'offline', waiting: [item] })] }, HOST_A, undefined)
    expect(gone[0]).toMatchObject({ text: '离线 · 离线前 1 项', count: 0 })
    expect(otherComputerRows(undefined, HOST_A, undefined)).toEqual([])
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

it('recognizes the synchronized Host’s loopback alias without trusting similar names', () => {
  const current = { local: false, remote: false, hostId: HOST_A }
  const alias = `h-${HOST_A}.localhost`
  expect(connectionTransport({ protocol: 'http:', hostname: alias }, current)).toBe('回环 HTTP')
  expect(connectionTransport({ protocol: 'http:', hostname: '::1' }, current)).toBe('回环 HTTP')
  expect(connectionTransport({ protocol: 'http:', hostname: `h-${HOST_B}.localhost` }, current)).toBe('')
  expect(connectionTransport({ protocol: 'http:', hostname: `${alias}.example.test` }, current)).toBe('')
  expect(connectionTransport({ protocol: 'http:', hostname: alias }, { ...current, hostId: undefined })).toBe('')
})
