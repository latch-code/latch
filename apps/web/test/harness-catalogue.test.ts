import { describe, expect, it, vi } from 'vitest'
import type { HarnessInfo } from '@latch/protocol'
import { api } from '../src/core/api.ts'
import {
  panelCatalogueTarget,
  readHarnessCatalogue,
  readModelOnSelect,
  readNeedsLogin,
  readOnSelect,
  readsOnPermission,
  readsOnSelect,
} from '../src/composer/harnessCatalogue.tsx'
import { saveOfferedPreset } from '../src/core/offeredHarness.ts'

vi.mock('../src/core/api.ts', async original => ({ ...(await original<typeof import('../src/core/api.ts')>()), api: vi.fn() }))
vi.mock('../src/core/offeredHarness.ts', () => ({ saveOfferedPreset: vi.fn() }))

const access = { scopes: new Set(['view', 'run'] as const) }
const harness = (read: HarnessInfo['catalogueRead']) =>
  ({ id: 'agent-one', status: 'ready', catalogueRead: read }) as unknown as HarnessInfo

describe('reading a draft’s model and thinking panel', () => {
  const local = { ...access, local: true, admin: true }
  const request = harness({ when: 'request', modes: true })
  const read = { when: 'request', modes: true } as const
  const list = { options: [], perModel: [], reportedAt: '2026-11-08T00:00:00Z', source: 'check' as const }

  it('asks for a missing list or just the selected model’s missing levels, leaving cached and failed reads alone', () => {
    expect(panelCatalogueTarget(request, local)).toEqual({})
    expect(readsOnSelect(request, access)).toBe(false)
    expect(panelCatalogueTarget({ ...request, catalogue: list }, local)).toBeUndefined()
    expect(panelCatalogueTarget({ ...request, catalogue: list }, local, 'large')).toEqual({ model: 'large' })
    expect(panelCatalogueTarget({ ...request, catalogueRead: { ...read, modes: false }, catalogue: list }, local, 'large')).toBeUndefined()
    expect(
      panelCatalogueTarget({ ...request, catalogueRead: { ...read, last: { at: '2026-11-08T00:00:00Z', ok: false } } }, local),
    ).toBeUndefined()
    expect(panelCatalogueTarget({ ...request, catalogueRead: { ...read, running: true } }, local)).toBeUndefined()
    expect(panelCatalogueTarget(request, { ...local, scopes: new Set(['view']) })).toBeUndefined()
  })

  it('only saves a ready offered preset for a local admin with run', () => {
    const offered = { ...request, offer: { presetId: 'pi' } }
    expect(panelCatalogueTarget(offered, local)).toEqual({})
    expect(panelCatalogueTarget(offered, { ...local, local: false })).toBeUndefined()
    expect(panelCatalogueTarget(offered, { ...local, admin: false })).toBeUndefined()
    expect(panelCatalogueTarget({ ...offered, status: 'unavailable' }, local)).toBeUndefined()
  })

  it('joins the save and first read even if the panel receives the registered Harness while saving', async () => {
    vi.mocked(api).mockClear().mockResolvedValue({ ran: true })
    let saved!: (value: boolean) => void
    vi.mocked(saveOfferedPreset).mockReturnValueOnce(
      new Promise(resolve => {
        saved = resolve
      }),
    )
    const first = readHarnessCatalogue({ ...request, offer: { presetId: 'pi' } }, false)
    const second = readHarnessCatalogue(request, false)
    expect(first).toBe(second)
    expect(saveOfferedPreset).toHaveBeenCalledExactlyOnceWith('pi')
    expect(api).not.toHaveBeenCalled()
    saved(true)
    await first
    expect(api).toHaveBeenCalledExactlyOnceWith('agents/agent-one/catalogue', { method: 'POST', body: { auto: false } })
    vi.mocked(api).mockClear()
  })
  it('retains a failed model read across panel openings but permits a manual retry or a new catalogue', async () => {
    const target = { ...request, id: 'retry-test', catalogue: list }
    vi.mocked(api).mockRejectedValueOnce(new Error('Read failed'))
    await expect(readHarnessCatalogue(target, false, 'large')).rejects.toThrow('Read failed')
    expect(panelCatalogueTarget(target, local, 'large')).toBeUndefined()
    expect(panelCatalogueTarget(target, local, 'small')).toEqual({ model: 'small' })
    expect(panelCatalogueTarget({ ...target, catalogue: { ...list, reportedAt: '2026-11-09T00:00:00Z' } }, local, 'large')).toEqual({
      model: 'large',
    })
    vi.mocked(api).mockResolvedValueOnce({ ran: true })
    await readHarnessCatalogue(target, false, 'large')
    expect(api).toHaveBeenLastCalledWith('agents/retry-test/catalogue', { method: 'POST', body: { auto: false, model: 'large' } })
    vi.mocked(api).mockClear()
  })
  it('also leaves a failed automatic list for a manual retry when selecting the same Harness again', async () => {
    const target = { ...harness({ when: 'select', modes: true }), id: 'offline-list' }
    vi.mocked(api).mockRejectedValueOnce(new Error('Offline'))
    await expect(readHarnessCatalogue(target, true)).rejects.toThrow('Offline')
    expect(readsOnSelect(target, access)).toBe(false)
    expect(readsOnPermission(target, access)).toBe(false)
    expect(panelCatalogueTarget(target, local)).toBeUndefined()
    expect(readsOnSelect({ ...target, commandCatalogue: { generation: 'new definition' } }, access)).toBe(true)
    vi.mocked(api).mockClear()
  })
})

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

describe('a read refused for want of a login', () => {
  const at = '2026-11-15T03:00:00.000Z'
  const refused = { when: 'select', modes: true, last: { at, ok: false, loginRequired: true, message: 'Qwen Code 还没登录。' } } as const
  const list = (reportedAt: string) => ({ options: [], perModel: [], reportedAt, source: 'session' as const })

  it('goes by the Host’s mark of the Harness’s error code, never by the words of the failure', () => {
    expect(readNeedsLogin(harness(refused))).toBe(true)
    // The same sentence without the mark is any other failure.
    const { loginRequired: _mark, ...unmarked } = refused.last
    expect(readNeedsLogin(harness({ ...refused, last: unmarked }))).toBe(false)
    expect(readNeedsLogin(harness({ when: 'select', modes: true, last: { at, ok: true } }))).toBe(false)
    expect(readNeedsLogin(harness({ when: 'select', modes: true }))).toBe(false)
    expect(readNeedsLogin(undefined)).toBe(false)
  })

  it('stops once something newer says it is logged in: a running process, or a session started since', () => {
    expect(readNeedsLogin({ ...harness(refused), login: { reported: { status: 'authenticated' } } })).toBe(false)
    expect(readNeedsLogin({ ...harness(refused), login: { reported: { status: 'unknown' } } })).toBe(true)
    expect(readNeedsLogin({ ...harness(refused), catalogue: list('2026-11-15T03:05:00.000Z') })).toBe(false)
    // A list from before the refusal says nothing about now.
    expect(readNeedsLogin({ ...harness(refused), catalogue: list('2026-11-14T00:00:00.000Z') })).toBe(true)
  })
})
