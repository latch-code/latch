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

const HELPER = 424242
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0).toReversed()) await close()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})
/** The short-lived shell: fd 1 and 2 are shared with the helper, fd 3 carries its pid, fd 4 is its input. */
class Launcher extends EventEmitter {
  pid = 123456
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdout = new PassThrough()
  stderr = new PassThrough()
  report = new PassThrough()
  input = new PassThrough()
  stdio = [null, this.stdout, this.stderr, this.report, this.input]
  kill = vi.fn(() => true)
  started(pid = HELPER): void {
    this.report.end(`${pid}\n`)
    this.exitCode = 0
    this.emit('exit', 0, null)
  }
  /** The helper is gone once nobody holds the write end of stdout. */
  helperExit(): void {
    this.stdout.end()
  }
}
async function setup(options: { start?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'latch-network-ipc-')),
    binary = join(directory, 'component')
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(binary, 'fixture', { mode: 0o700 })
  const launcher = new Launcher()
  mocks.spawn.mockReturnValue(launcher)
  mocks.execute.mockImplementation((_path, _args, _options, callback: (error: null, stdout: string, stderr: string) => void) => {
    callback(null, '', '')
    return new EventEmitter()
  })
  const kills = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid !== HELPER || signal !== 'SIGKILL') throw new Error('unexpected kill')
    queueMicrotask(() => launcher.helperExit())
    return true
  })
  const backend = await MacNetworkBackend.open(binary)
  if (options.start !== false) launcher.started()
  cleanup.push(() => backend.close())
  return { backend, launcher, binary, kills }
}
it.skipIf(process.platform !== 'darwin')(
  'starts the helper through a short-lived shell, keeps IPC private, and settles its actual exit',
  async () => {
    const { backend, launcher, binary, kills } = await setup(),
      epoch = randomUUID()
    expect(mocks.spawn).toHaveBeenCalledWith('/bin/sh', ['-c', '"$0" <&4 3>&- 4>&- & echo "$!" >&3', binary], {
      env: {},
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    })
    const response = backend.snapshot(),
      request = JSON.parse(launcher.input.read().toString()) as { id: string }
    launcher.stdout.write(`${JSON.stringify({ version: 1, event: 'result', id: request.id, data: { epoch, interfaces: [] } })}\n`)
    expect(await response).toEqual({ epoch, interfaces: [] })
    let closed = false
    launcher.input.once('finish', () => {
      closed = true
      launcher.helperExit()
    })
    await backend.close()
    expect(closed).toBe(true)
    expect(kills).not.toHaveBeenCalled()
    expect(launcher.kill).not.toHaveBeenCalled()
  },
)
it.skipIf(process.platform !== 'darwin')('rejects malformed, unsolicited and oversized messages and kills the helper by pid', async () => {
  for (const payload of [
    '{"event":"unknown"}\n',
    `${JSON.stringify({ version: 1, event: 'result', id: randomUUID(), data: null })}\n`,
    'x'.repeat(65537),
  ]) {
    const { backend, launcher, kills } = await setup(),
      pending = backend.snapshot()
    const rejected = expect(pending).rejects.toThrow('unavailable')
    launcher.stdout.write(payload)
    await rejected
    await backend.close()
    expect(kills).toHaveBeenCalledWith(HELPER, 'SIGKILL')
  }
})
it.skipIf(process.platform !== 'darwin')('kills a helper whose pid arrives after a failure and fails without a pid', async () => {
  const late = await setup({ start: false })
  late.launcher.stdout.write('{"event":"unknown"}\n')
  await vi.waitFor(() => expect(late.launcher.kill).toHaveBeenCalledWith('SIGKILL'))
  expect(late.kills).not.toHaveBeenCalled()
  late.launcher.started()
  await late.backend.close()
  expect(late.kills).toHaveBeenCalledWith(HELPER, 'SIGKILL')

  for (const report of ['', 'not-a-pid\n', `${'9'.repeat(13)}`]) {
    const { backend, launcher } = await setup({ start: false }),
      pending = backend.snapshot()
    const rejected = expect(pending).rejects.toThrow('unavailable')
    launcher.report.end(report)
    await rejected
    launcher.helperExit()
    await backend.close()
  }
})
it.skipIf(process.platform !== 'darwin')('bounds pending requests, times out stuck helpers, and rejects a permissive binary', async () => {
  const { backend, binary, kills } = await setup()
  vi.useFakeTimers()
  const pending = Array.from({ length: 8 }, () => backend.snapshot())
  const rejected = Promise.all(pending.map(promise => expect(promise).rejects.toThrow('unavailable')))
  await expect(backend.snapshot()).rejects.toThrow('busy')
  await vi.advanceTimersByTimeAsync(3001)
  await rejected
  expect(kills).toHaveBeenCalledTimes(1)
  await backend.close()
  vi.useRealTimers()
  await chmod(binary, 0o777)
  await expect(MacNetworkBackend.open(binary)).rejects.toThrow('unavailable')
})
it.skipIf(process.platform !== 'darwin')('passes a Local Network refusal and its end through as statuses', async () => {
  const { backend, launcher, kills } = await setup()
  const seen: string[] = []
  backend.onStatus(status => seen.push(status))
  launcher.stdout.write(`${JSON.stringify({ version: 1, event: 'status', state: 'denied', index: 4 })}\n`)
  launcher.stdout.write(`${JSON.stringify({ version: 1, event: 'status', state: 'ready', index: 4 })}\n`)
  await vi.waitFor(() => expect(seen).toEqual(['denied', 'ready']))
  expect(kills).not.toHaveBeenCalled()
})
