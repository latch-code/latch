import { describe, expect, it, vi } from 'vitest'
import type { GitDeliveryState } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { WorkbenchDeliveryReader } from '../src/workbench-delivery.ts'

const state: GitDeliveryState = {
  branch: 'main',
  head: 'a'.repeat(40),
  ahead: 1,
  behind: 0,
  staged: [{ path: 'private-name.txt', status: 'M' }],
  unstaged: [{ path: 'private-name.txt', status: 'M' }],
  untracked: ['new.txt'],
  conflicted: [],
  hooks: ['pre-commit'],
  filters: false,
}
const now = () => Date.parse('2026-11-13T00:00:00Z')

describe('workbench delivery reads', () => {
  it('shares one repository read, counts partially staged files once and never queries an unbound PR', async () => {
    const read = vi.fn(async () => state)
    const pr = vi.fn(async () => ({ checks: [] }))
    const reader = new WorkbenchDeliveryReader({ now, state: read, pr })
    const result = await reader.read(Array.from({ length: 8 }, (_, i) => ({ sessionId: `s${i}`, folder: '/project', boundPr: false })))
    expect(read).toHaveBeenCalledTimes(1)
    expect(pr).not.toHaveBeenCalled()
    expect(result.entries).toHaveLength(8)
    expect(result.entries[0]?.state).toMatchObject({ staged: 1, unstaged: 1, untracked: 1, files: 2, ahead: 1 })
    expect(JSON.stringify(result)).not.toContain('private-name')
    expect(JSON.stringify(result)).not.toContain('pre-commit')
    await reader.read([{ sessionId: 's0', folder: '/project', boundPr: false }])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('preserves partial failures without exposing raw errors, discussion or PR drafts', async () => {
    const reader = new WorkbenchDeliveryReader({
      now,
      state: async folder => {
        if (folder === '/missing') throw new AppError(409, 'git-folder-unavailable', '/private/path')
        return state
      },
      pr: async id => {
        if (id === 'offline') throw new Error('secret raw response')
        return {
          checks: [],
          draft: { title: 'private subject' },
          discussion: [{ kind: 'comment', author: 'someone', body: 'private discussion' }],
        }
      },
    })
    const result = await reader.read([
      { sessionId: 'missing', folder: '/missing', boundPr: true },
      { sessionId: 'offline', folder: '/project', boundPr: true },
      { sessionId: 'unbound', folder: '/project', boundPr: true },
    ])
    expect(result.entries[0]?.error?.code).toBe('git-folder-unavailable')
    expect(result.entries[1]?.state?.files).toBe(2)
    expect(result.entries[1]?.prError?.code).toBe('git-failed')
    expect(result.entries[2]?.pr).toEqual({ checks: [] })
    expect(JSON.stringify(result)).not.toMatch(/private|secret/)
  })

  it('bounds parallel work and coalesces identical reads across requests', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const read = vi.fn(async () => {
      await gate
      return state
    })
    const reader = new WorkbenchDeliveryReader({ now, state: read, pr: async () => ({ checks: [] }) })
    const targets = Array.from({ length: 9 }, (_, i) => ({ sessionId: `s${i}`, folder: `/project${i}`, boundPr: false }))
    const one = reader.read(targets)
    const two = reader.read(targets)
    expect(read).toHaveBeenCalledTimes(3)
    release()
    await Promise.all([one, two])
    expect(read).toHaveBeenCalledTimes(9)
  })
})
