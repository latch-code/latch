import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
type RecoveryChoice = 'reload' | 'start' | undefined
const { createWorkbenchRecovery } = require('../src/workbench-recovery.cjs') as {
  createWorkbenchRecovery(
    contents: EventEmitter,
    options: {
      url: string
      active: () => boolean
      offerReload: (signal: AbortSignal) => Promise<RecoveryChoice>
      log: (message: string) => void
    },
  ): { update(): void; reloadFailed(): boolean }
}

const url = 'latch://app/link/'
const start = (offerReload = vi.fn<(signal: AbortSignal) => Promise<RecoveryChoice>>().mockResolvedValue(undefined)) => {
  const contents = Object.assign(new EventEmitter(), {
    isCrashed: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(async (_url: string) => {}),
  })
  const active = vi.fn(() => true)
  const recovery = createWorkbenchRecovery(contents, { url, active, offerReload, log: vi.fn() })
  return { contents, recovery, active, offerReload }
}

afterEach(() => vi.useRealTimers())

it('ignores subframe, cancelled and different-origin failures, and coalesces failures of the workbench document', () => {
  vi.useFakeTimers()
  const { contents, offerReload } = start()
  contents.emit('did-fail-load', {}, -2, 'failed', 'latch-frame://app/workbench', false)
  contents.emit('did-fail-load', {}, -2, 'failed', 'latch://elsewhere/link/', true)
  contents.emit('did-fail-load', {}, -3, 'aborted', url, true)
  vi.advanceTimersByTime(1_000)
  expect(contents.loadURL).not.toHaveBeenCalled()
  contents.emit('did-fail-load', {}, -2, 'failed', `${url}#safe`, true)
  contents.emit('render-process-gone', {}, { reason: 'crashed' })
  vi.advanceTimersByTime(1_000)
  expect(contents.loadURL.mock.calls).toEqual([[url]])
  expect(offerReload).not.toHaveBeenCalled()
})

it('stops automatically retrying rapid failures and ignores an answer from a hidden workbench', async () => {
  vi.useFakeTimers()
  const prompt = Promise.resolve<RecoveryChoice>('start')
  const { contents, recovery, active, offerReload } = start(vi.fn(() => prompt))
  contents.emit('render-process-gone', {}, { reason: 'crashed' })
  // The in-flight automatic attempt still consumes the retry even if it has taken more than a minute.
  vi.advanceTimersByTime(61_000)
  contents.emit('render-process-gone', {}, { reason: 'crashed' })
  contents.emit('did-fail-load', {}, -2, 'failed', url, true)
  vi.advanceTimersByTime(1_000)
  expect(contents.loadURL).toHaveBeenCalledTimes(1)
  expect(offerReload).toHaveBeenCalledTimes(1)

  active.mockReturnValue(false)
  recovery.update()
  expect(offerReload.mock.calls[0]![0].aborted).toBe(true)
  await prompt
  expect(contents.loadURL).toHaveBeenCalledTimes(1)
  active.mockReturnValue(true)
  expect(recovery.reloadFailed()).toBe(true)
  expect(contents.loadURL.mock.calls).toEqual([[url], [url]])
})

it('cancels a deferred recovery when a new document starts or the workbench closes', () => {
  vi.useFakeTimers()
  const { contents } = start()
  contents.emit('render-process-gone', {}, { reason: 'crashed' })
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url })
  vi.advanceTimersByTime(1_000)
  expect(contents.loadURL).not.toHaveBeenCalled()

  contents.emit('render-process-gone', {}, { reason: 'crashed' })
  contents.isDestroyed.mockReturnValue(true)
  contents.emit('destroyed')
  vi.advanceTimersByTime(1_000)
  expect(contents.loadURL).not.toHaveBeenCalled()
})
