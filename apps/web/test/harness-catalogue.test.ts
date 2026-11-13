import { describe, expect, it, vi } from 'vitest'
import type { HarnessInfo } from '@latch/protocol'
import { api } from '../src/core/api.ts'
import { readModelOnSelect, readOnSelect, readsOnPermission, readsOnSelect } from '../src/composer/harnessCatalogue.tsx'

vi.mock('../src/core/api.ts', async original => ({ ...(await original<typeof import('../src/core/api.ts')>()), api: vi.fn() }))

const access = { scopes: new Set(['view', 'run'] as const) }
const harness = (read: HarnessInfo['catalogueRead']) =>
  ({ id: 'agent-one', status: 'ready', catalogueRead: read }) as unknown as HarnessInfo

describe('reading a Harness by selection', () => {
  it('reads once while it runs, and again when the Host has no read of a changed definition', async () => {
    let finish!: () => void
    vi.mocked(api).mockReturnValue(new Promise(resolve => (finish = () => resolve({ ran: true }))))
    const unread = harness({ when: 'select', modes: true })
    expect(readsOnPermission(unread, access)).toBe(true)
    const done = new Promise<void>(resolve => readOnSelect(unread, resolve))
    // Asked already: opening 权限 again starts nothing more.
    expect(readsOnSelect(unread, access)).toBe(false)
    finish()
    await done
    expect(api).toHaveBeenCalledTimes(1)
    // The Host reports the read it kept, so nothing more is due for this definition.
    expect(readsOnPermission(harness({ when: 'select', modes: true, last: { at: '2026-11-08T00:00:00Z', ok: true } }), access)).toBe(false)
    // Its definition changed and the Host has no read of the new one: opening 权限 reads it, as its note says.
    expect(readsOnPermission(unread, access)).toBe(true)
  })
})

it('reads a model again after the Host replaces the catalogue for a changed definition', async () => {
  vi.mocked(api).mockClear().mockResolvedValue({ ran: true })
  const first = {
    ...harness({ when: 'select', modes: true }),
    id: 'per-model-agent',
    catalogue: { options: [], perModel: [], reportedAt: '2026-11-13T00:00:00Z', source: 'check' as const },
  }
  readModelOnSelect(first, 'large')
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1))
  readModelOnSelect(first, 'large')
  expect(api).toHaveBeenCalledTimes(1)
  readModelOnSelect({ ...first, catalogue: { ...first.catalogue, reportedAt: '2026-11-13T01:00:00Z' } }, 'large')
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2))
})
