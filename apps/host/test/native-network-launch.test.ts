import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'

// Only the codesign check is faked; the shell and the helper are real processes.
const mocks = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...(await original<object>()), execFile: mocks.execute }))
import { MacNetworkBackend } from '../src/native-network-backend.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
  vi.clearAllMocks()
})
async function helper(body: (record: string) => string) {
  const directory = await mkdtemp(join(tmpdir(), 'latch-network-launch-')),
    binary = join(directory, 'component'),
    record = join(directory, 'record')
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(binary, `#!/bin/sh\n${body(record)}\n`, { mode: 0o700 })
  mocks.execute.mockImplementation((_path, _args, _options, callback: (error: null, stdout: string, stderr: string) => void) => {
    callback(null, '', '')
    return new EventEmitter()
  })
  return { binary, record }
}
async function recorded(record: string, fields: number): Promise<number[]> {
  const pattern = new RegExp(`^\\d+(?: +\\d+){${fields - 1}}$`, 'u')
  await vi.waitFor(async () => expect((await readFile(record, 'utf8').catch(() => '')).trim()).toMatch(pattern), { timeout: 10000 })
  return (await readFile(record, 'utf8')).trim().split(/ +/u).map(Number)
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
it.skipIf(process.platform !== 'darwin')('runs the helper under launchd with working pipes and ends it by closing its input', async () => {
  const epoch = randomUUID(),
    // It answers first, then records its parent: the shell that started it has exited by then.
    { binary, record } = await helper(
      record =>
        `IFS= read -r line; id=$(printf '%s' "$line" | /usr/bin/sed -E 's/.*"id":"([^"]+)".*/\\1/')\nprintf '{"version":1,"event":"result","id":"%s","data":{"epoch":"${epoch}","interfaces":[]}}\\n' "$id"\n/bin/sleep 0.2\necho "$$ $(/bin/ps -o ppid= -p $$)" > '${record}'\nwhile IFS= read -r line; do :; done`,
    )
  const backend = await MacNetworkBackend.open(binary)
  expect(await backend.snapshot()).toEqual({ epoch, interfaces: [] })
  const [pid, parent] = await recorded(record, 2)
  expect(parent).toBe(1)
  await backend.close()
  expect(alive(pid!)).toBe(false)
})
it.skipIf(process.platform !== 'darwin')('kills a misbehaving helper by pid and waits for its actual exit', async () => {
  const { binary, record } = await helper(
    record => `trap '' HUP INT TERM\necho "$$" > '${record}'\necho 'not json'\nwhile :; do /bin/sleep 1; done`,
  )
  const backend = await MacNetworkBackend.open(binary),
    seen: string[] = []
  backend.onStatus(status => seen.push(status))
  const [pid] = await recorded(record, 1)
  await vi.waitFor(() => expect(seen).toContain('blocked'))
  await backend.close()
  expect(alive(pid!)).toBe(false)
})
