import { afterEach, expect, it, vi } from 'vitest'
import { PathManager } from '../src/paths.ts'

const managers: PathManager<FakeConnection>[] = []
class FakeConnection {
  closes = 0
  close(): void {
    this.closes++
  }
}
function manager(options: ConstructorParameters<typeof PathManager<FakeConnection>>[0] = {}) {
  const value = new PathManager<FakeConnection>(options)
  managers.push(value)
  return value
}
function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(done => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => {
  for (const value of managers.splice(0)) value.close()
  vi.useRealTimers()
})

it('keeps the old connection until the new path completes resume and does not abort an installed setup signal', async () => {
  const paths = manager(),
    first = new FakeConnection(),
    second = new FakeConnection()
  let firstSignal!: AbortSignal
  const old = await paths.migrate(
    [
      {
        id: 'lan-a',
        kind: 'direct',
        async connect(signal) {
          firstSignal = signal
          return first
        },
      },
    ],
    async () => 'old-state',
  )
  const gate = deferred<string>(),
    resume = vi.fn(() => gate.promise)
  const pending = paths.migrate(
    [
      {
        id: 'lan-b',
        kind: 'direct',
        async connect() {
          return second
        },
      },
    ],
    resume,
  )
  await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce())
  expect(first.closes).toBe(0)
  expect(paths.isCurrent(old)).toBe(true)
  expect(firstSignal.aborted).toBe(false)
  gate.resolve('new-state')
  const installed = await pending
  expect(installed).toMatchObject({ kind: 'installed', snapshot: 'new-state' })
  expect(first.closes).toBe(1)
  expect(paths.isCurrent(old)).toBe(false)
  expect(paths.isCurrent(installed)).toBe(true)
})
it('closes a late successful setup after network changes without replacing the installed path', async () => {
  const paths = manager(),
    old = deferred<FakeConnection>(),
    obsolete = new FakeConnection(),
    current = new FakeConnection()
  const pending = paths.migrate([{ id: 'stale', kind: 'direct', connect: () => old.promise }], async () => 'stale')
  paths.networkChanged()
  const installed = await paths.migrate(
    [
      {
        id: 'current',
        kind: 'direct',
        async connect() {
          return current
        },
      },
    ],
    async () => 'current',
  )
  expect(await pending).toEqual({ kind: 'superseded' })
  old.resolve(obsolete)
  await vi.waitFor(() => expect(obsolete.closes).toBe(1))
  expect(paths.isCurrent(installed)).toBe(true)
  expect(current.closes).toBe(0)
})
it('reserves a bounded relay attempt while LAN candidates stay silent', async () => {
  vi.useFakeTimers()
  const paths = manager(),
    relay = new FakeConnection(),
    signals: AbortSignal[] = []
  const silent = vi.fn((signal: AbortSignal) => {
    signals.push(signal)
    return new Promise<FakeConnection>(() => {})
  })
  const dialRelay = vi.fn(async () => relay)
  const pending = paths.migrate(
    [
      { id: 'lan-a', kind: 'direct', connect: silent },
      { id: 'lan-b', kind: 'direct', connect: silent },
      { id: 'lan-c', kind: 'direct', connect: silent },
      { id: 'relay', kind: 'relay', connect: dialRelay },
    ],
    async () => 'relay-state',
  )
  expect(silent).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(249)
  expect(dialRelay).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(await pending).toMatchObject({ kind: 'installed', candidateId: 'relay' })
  expect(silent).toHaveBeenCalledTimes(2)
  expect(signals.every(signal => signal.aborted)).toBe(true)
})
it('retains the previous path if resume fails and clears candidate failure memory on a new network', async () => {
  const paths = manager(),
    first = new FakeConnection(),
    second = new FakeConnection(),
    dial = vi.fn(async () => second)
  await paths.migrate(
    [
      {
        id: 'old',
        kind: 'direct',
        async connect() {
          return first
        },
      },
    ],
    async () => 'old',
  )
  const candidate = { id: 'new', kind: 'direct' as const, connect: dial }
  expect(
    await paths.migrate([candidate], async () => {
      throw new Error('checkpoint refused')
    }),
  ).toEqual({ kind: 'unchanged' })
  expect(first.closes).toBe(0)
  expect(second.closes).toBe(1)
  await paths.migrate([candidate], async () => 'cached-failure')
  expect(dial).toHaveBeenCalledOnce()
  paths.networkChanged()
  const third = new FakeConnection()
  dial.mockResolvedValue(third)
  expect(await paths.migrate([candidate], async () => 'recovered')).toMatchObject({ kind: 'installed' })
  expect(dial).toHaveBeenCalledTimes(2)
})
it('bounds resume and ignores a callback that resolves after its deadline', async () => {
  vi.useFakeTimers()
  const paths = manager({ resumeTimeoutMs: 1000 }),
    connection = new FakeConnection(),
    resume = deferred<string>()
  const pending = paths.migrate(
    [
      {
        id: 'path',
        kind: 'direct',
        async connect() {
          return connection
        },
      },
    ],
    () => resume.promise,
  )
  await vi.advanceTimersByTimeAsync(1000)
  expect(await pending).toEqual({ kind: 'unchanged' })
  expect(connection.closes).toBe(1)
  resume.resolve('too-late')
  await vi.advanceTimersByTimeAsync(0)
  expect(paths.current()).toBeUndefined()
  expect(connection.closes).toBe(1)
})
