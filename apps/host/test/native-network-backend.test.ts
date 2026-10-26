import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execute: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...(await original<object>()), spawn: mocks.spawn, execFile: mocks.execute }))
import { MacNetworkBackend } from '../src/native-network-backend.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0).toReversed()) await close()
  vi.clearAllMocks()
})
class Child extends EventEmitter {
  pid = 123456
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => {
    queueMicrotask(() => this.emit('exit', null, 'SIGKILL'))
    return true
  })
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'latch-network-ipc-')),
    binary = join(directory, 'component')
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(binary, 'fixture', { mode: 0o700 })
  const child = new Child()
  mocks.spawn.mockReturnValue(child)
  mocks.execute.mockImplementation((_path, _args, _options, callback: (error: null, stdout: string, stderr: string) => void) => {
    callback(null, '', '')
    return new EventEmitter()
  })
  const backend = await MacNetworkBackend.open(binary)
  cleanup.push(() => backend.close())
  return { backend, child, binary }
}
it.skipIf(process.platform !== 'darwin')('keeps helper IPC private, validates replies, and settles actual own-child exit', async () => {
  const { backend, child, binary } = await setup(),
    epoch = randomUUID()
  expect(mocks.spawn).toHaveBeenCalledWith(binary, [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
  const response = backend.snapshot(),
    request = JSON.parse(child.stdin.read().toString()) as { id: string }
  child.stdout.write(`${JSON.stringify({ version: 1, event: 'result', id: request.id, data: { epoch, interfaces: [] } })}\n`)
  expect(await response).toEqual({ epoch, interfaces: [] })
  let closed = false
  child.stdin.once('finish', () => {
    closed = true
    child.emit('exit', 0)
  })
  await backend.close()
  expect(closed).toBe(true)
  expect(child.kill).not.toHaveBeenCalled()
})
it.skipIf(process.platform !== 'darwin')('rejects malformed, unsolicited and oversized messages without retaining a child', async () => {
  for (const payload of [
    '{"event":"unknown"}\n',
    `${JSON.stringify({ version: 1, event: 'result', id: randomUUID(), data: null })}\n`,
    'x'.repeat(65537),
  ]) {
    const { backend, child } = await setup(),
      pending = backend.snapshot()
    const rejected = expect(pending).rejects.toThrow('unavailable')
    child.stdout.write(payload)
    await rejected
    await backend.close()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  }
})
it.skipIf(process.platform !== 'darwin')('bounds pending requests, times out stuck helpers, and rejects a permissive binary', async () => {
  const { backend, child, binary } = await setup()
  vi.useFakeTimers()
  const pending = Array.from({ length: 8 }, () => backend.snapshot())
  const rejected = Promise.all(pending.map(promise => expect(promise).rejects.toThrow('unavailable')))
  await expect(backend.snapshot()).rejects.toThrow('busy')
  await vi.advanceTimersByTimeAsync(3001)
  await rejected
  expect(child.kill).toHaveBeenCalledTimes(1)
  await backend.close()
  vi.useRealTimers()
  await chmod(binary, 0o777)
  await expect(MacNetworkBackend.open(binary)).rejects.toThrow('unavailable')
})
