import { RunFileTracking, recordFileOutputs } from '@latch/core/file-tracking'
import { describe, expect, it, vi } from 'vitest'
import { type FileTrackingInput, type FileTrackingResult } from '@latch/sdk'
import type { Message } from '@latch/protocol'
const output = (path: string): FileTrackingResult => ({ files: [{ root: 'main', path, change: 'modified' }] })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
describe('shared run file observation lifecycle', () => {
  it('does not project a delayed old watcher into a newer run and persists each result only through its captured target', async () => {
    let current = 'first'
    const inputs: FileTrackingInput[] = []
    const finishes = [deferred<FileTrackingResult>(), deferred<FileTrackingResult>()]
    const notify = vi.fn()
    const tracking = new RunFileTracking({
      current: (_session, run) => run === current,
      notify,
      track: async input => {
        const index = inputs.push(input) - 1
        return { dispose: () => {}, finish: () => finishes[index]!.promise }
      },
    })
    await tracking.start('session', 'first', [])
    inputs[0]!.onChange(output('first.md'))
    const saveOld = vi.fn(async (_result: FileTrackingResult) => {})
    tracking.finish('first', saveOld)
    expect(tracking.projection('session', 'first')).toMatchObject({ state: 'settling', files: [{ path: 'first.md' }] })
    current = 'second'
    await tracking.start('session', 'second', [])
    inputs[1]!.onChange(output('second.md'))
    inputs[0]!.onChange(output('wrong.md'))
    finishes[0]!.resolve(output('settled-first.md'))
    await vi.waitFor(() => expect(saveOld).toHaveBeenCalledWith(output('settled-first.md')))
    expect(tracking.projection('session', current)?.files).toEqual(output('second.md').files)
    tracking.finish('second', async () => {})
    finishes[1]!.resolve(output('second.md'))
    await tracking.close()
  })
  it('keeps unsupported hosts empty, treats failed setup honestly and bounds malformed metadata', async () => {
    const old = new RunFileTracking({ current: () => true, notify: () => {} })
    await old.start('session', 'run', [])
    expect(old.capture('run')).toBeUndefined()
    const failed = new RunFileTracking({
      current: () => true,
      notify: () => {},
      track: async () => {
        throw new Error('path contains private diagnostic')
      },
    })
    await failed.start('session', 'run', [])
    expect(failed.capture('run')).toEqual({ files: [], unavailable: true })
    const bad = new RunFileTracking({
      current: () => true,
      notify: () => {},
      track: async input => {
        input.onChange({ files: [{ root: 'main', path: '../private.txt', change: 'modified' }] })
        return { finish: async () => output('fine.txt'), dispose: () => {} }
      },
    })
    await bad.start('session', 'run', [])
    expect(bad.capture('run')).toEqual({ files: [], truncated: true })
    await Promise.all([old.close(), failed.close(), bad.close()])
  })
  it('clears temporary flags when the fixed message settles', () => {
    const message: Message = { id: 'm', role: 'assistant', text: 'answer' }
    recordFileOutputs(message, { ...output('one.txt'), truncated: true }, true)
    expect(message).toMatchObject({ outputsPending: true, outputsTruncated: true })
    recordFileOutputs(message, output('two.txt'))
    expect(message.outputs).toEqual(output('two.txt').files)
    expect(message.outputsPending).toBeUndefined()
    expect(message.outputsTruncated).toBeUndefined()
  })
})
