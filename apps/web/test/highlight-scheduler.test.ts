import { describe, expect, it } from 'vitest'
import { HighlightScheduler, type HighlightWorker } from '../src/preview/highlightScheduler.ts'
import type { HighlightRequest, SyntaxLines } from '../src/preview/highlight-protocol.ts'

type Request = Extract<HighlightRequest, { id: number }>

/** A worker and timers the test drives by hand: nothing here depends on the wall clock. */
function harness() {
  const workers: Array<HighlightWorker & { posted: HighlightRequest[]; terminated: boolean }> = []
  const timers = new Map<number, { run: () => void; ms: number }>()
  let nextTimer = 0
  const scheduler = new HighlightScheduler({
    createWorker: () => {
      const worker = {
        posted: [] as HighlightRequest[],
        terminated: false,
        onmessage: null,
        onerror: null,
        postMessage(message: HighlightRequest) {
          worker.posted.push(message)
        },
        terminate() {
          worker.terminated = true
        },
      }
      workers.push(worker)
      return worker
    },
    timeoutMs: 5000,
    setTimer: (run, ms) => {
      timers.set(++nextTimer, { run, ms })
      return nextTimer
    },
    clearTimer: timer => timers.delete(timer as number),
  })
  const inFlight = () =>
    workers
      .at(-1)!
      .posted.filter((message): message is Request => 'id' in message)
      .at(-1)!
  return {
    scheduler,
    workers,
    timers,
    inFlight,
    /** The worker answers the job in flight with one plain token per line. */
    answer() {
      const request = inFlight()
      workers.at(-1)!.onmessage?.({ data: { id: request.id, lines: tokens(request.code) } })
      return request.code
    },
    expire() {
      const last = [...timers.keys()].at(-1)!
      const timer = timers.get(last)!
      timers.delete(last)
      timer.run()
      return timer.ms
    },
  }
}
const tokens = (code: string): SyntaxLines => code.split('\n').map(text => [{ text, role: 'plain' }])

describe('highlight scheduling', () => {
  it('colours every block of a burst, newest first, one at a time, with no worker lost', () => {
    const { scheduler, workers, answer } = harness()
    const done: string[] = []
    for (let index = 0; index < 600; index++) scheduler.request(`block ${index}`, 'ts', () => done.push(`block ${index}`))
    expect(workers[0]!.posted).toHaveLength(1)
    expect(answer()).toBe('block 0')
    expect(answer()).toBe('block 599')
    expect(answer()).toBe('block 598')
    for (let index = 3; index < 600; index++) answer()
    expect(done).toHaveLength(600)
    expect(done.at(-1)).toBe('block 1')
    expect(workers).toHaveLength(1)
    expect(workers[0]!.terminated).toBe(false)
  })

  it('takes a cancelled job off the stack and never sends it', () => {
    const { scheduler, workers, answer } = harness()
    scheduler.request('first', 'ts', () => {})
    const cancel = scheduler.request('gone', 'ts', () => {
      throw new Error('a cancelled job must not answer')
    })
    scheduler.request('kept', 'ts', () => {})
    cancel()
    answer()
    answer()
    expect(workers[0]!.posted.map(message => 'code' in message && message.code)).toEqual(['first', 'kept'])
  })

  it('answers from the cache without the worker, and joins a job already asked for', () => {
    const { scheduler, workers, answer } = harness()
    const seen: Array<SyntaxLines | undefined> = []
    scheduler.request('same', 'ts', lines => seen.push(lines))
    scheduler.request('same', 'ts', lines => seen.push(lines))
    expect(workers[0]!.posted).toHaveLength(1)
    answer()
    expect(seen).toEqual([tokens('same'), tokens('same')])
    scheduler.request('same', 'ts', lines => seen.push(lines))
    expect(seen).toHaveLength(3)
    expect(workers[0]!.posted).toHaveLength(1)
    expect(scheduler.peek('same', 'ts')).toEqual(tokens('same'))
    expect(scheduler.peek('same', 'py')).toBeUndefined()
  })

  it('remembers a key that outlives the watchdog twice, and the blocks behind it still colour', () => {
    const { scheduler, workers, answer, expire, inFlight } = harness()
    const results = new Map<string, SyntaxLines | undefined>()
    const ask = (code: string) => scheduler.request(code, 'cpp', lines => results.set(code, lines))
    ask('warm')
    answer()
    ask('pathological')
    ask('ordinary one')
    ask('ordinary two')
    expect(expire()).toBe(5000)
    expect(workers[0]!.terminated).toBe(true)
    // The next worker is still loading, which its first job gets time for.
    expect(answer()).toBe('ordinary two')
    expect(answer()).toBe('ordinary one')
    // Its second try comes last, with a longer watchdog: a machine under load is not a pathological block.
    expect(inFlight().code).toBe('pathological')
    expect(expire()).toBe(20_000)
    expect(results.has('pathological')).toBe(true)
    expect(results.get('pathological')).toBeUndefined()
    const posted = workers.flatMap(worker => worker.posted).length
    let again = 'unset' as unknown
    ask('pathological')
    scheduler.request('pathological', 'cpp', lines => {
      again = lines
    })
    expect(again).toBeUndefined()
    expect(workers.flatMap(worker => worker.posted)).toHaveLength(posted)
    ask('after')
    expect(answer()).toBe('after')
    expect(results.get('after')).toEqual(tokens('after'))
  })

  it('gives a worker still loading time for its first job, and then the ordinary watchdog', () => {
    const { scheduler, answer, expire } = harness()
    scheduler.request('first', 'ts', () => {})
    scheduler.request('second', 'ts', () => {})
    answer()
    expect(expire()).toBe(5000)
    const { scheduler: fresh, expire: expireFresh } = harness()
    fresh.request('first', 'ts', () => {})
    expect(expireFresh()).toBe(30_000)
  })

  it('colours an ordinary block on its second try when the first timed out', () => {
    const { scheduler, answer, expire } = harness()
    let result: SyntaxLines | undefined
    scheduler.request('slow machine', 'ts', lines => {
      result = lines
    })
    expire()
    expect(answer()).toBe('slow machine')
    expect(result).toEqual(tokens('slow machine'))
  })

  it('gives up the queue after repeated worker crashes, and tries again on the next request', () => {
    const { scheduler, workers, answer } = harness()
    const settled: string[] = []
    for (const code of ['a', 'b', 'c', 'd']) scheduler.request(code, 'ts', () => settled.push(code))
    workers.at(-1)!.onerror?.({})
    workers.at(-1)!.onerror?.({})
    workers.at(-1)!.onerror?.({})
    expect([...settled].sort()).toEqual(['a', 'b', 'c', 'd'])
    let later: SyntaxLines | undefined
    scheduler.request('later', 'ts', lines => {
      later = lines
    })
    answer()
    expect(later).toEqual(tokens('later'))
  })

  it('does not hold a worker that failed to load against the blocks it was given', () => {
    const { scheduler, workers, answer } = harness()
    const settled: string[] = []
    scheduler.request('a', 'ts', () => settled.push('a'))
    workers.at(-1)!.onerror?.({})
    workers.at(-1)!.onerror?.({})
    workers.at(-1)!.onerror?.({})
    expect(settled).toEqual(['a'])
    let later: SyntaxLines | undefined
    scheduler.request('a', 'ts', lines => {
      later = lines
    })
    answer()
    expect(later).toEqual(tokens('a'))
  })

  it('does not try again, or remember, a job nobody is waiting for when it times out', () => {
    const { scheduler, workers, answer, expire } = harness()
    const cancel = scheduler.request('left the view', 'cpp', () => {})
    cancel()
    expire()
    expect(workers[0]!.terminated).toBe(true)
    let result: SyntaxLines | undefined
    scheduler.request('left the view', 'cpp', lines => {
      result = lines
    })
    expect(answer()).toBe('left the view')
    expect(result).toEqual(tokens('left the view'))
  })

  it('asks for a stream only what it adds, and passes on a worker that lost it', () => {
    const { scheduler, workers, inFlight } = harness()
    const results: unknown[] = []
    scheduler.requestLines(7, 'ts', 3, 'const a\nconst b', result => results.push(result))
    expect(inFlight()).toMatchObject({ stream: 7, from: 3, code: 'const a\nconst b', language: 'ts' })
    workers[0]!.onmessage?.({ data: { id: inFlight().id, lines: tokens('const a\nconst b') } })
    scheduler.requestLines(7, 'ts', 5, 'const c', result => results.push(result))
    workers[0]!.onmessage?.({ data: { id: inFlight().id, restart: true } })
    expect(results).toEqual([{ lines: tokens('const a\nconst b') }, { restart: true }])
    scheduler.release(7)
    expect(workers[0]!.posted.at(-1)).toEqual({ release: 7 })
  })

  it('refuses an answer whose text differs from the source', () => {
    const { scheduler, workers, inFlight } = harness()
    let result: SyntaxLines | undefined = tokens('x')
    scheduler.request('real text', 'ts', lines => {
      result = lines
    })
    workers[0]!.onmessage?.({ data: { id: inFlight().id, lines: tokens('forged text') } })
    expect(result).toBeUndefined()
    expect(scheduler.peek('real text', 'ts')).toBeUndefined()
  })
})
