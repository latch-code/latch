import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { DESKTOP_STALE_MS, HostComputer, MAX_SLEEPS, desktopReportSchema } from '../src/computer.ts'

const roots: string[] = []
const opened = new Set<HostComputer>()
afterEach(async () => {
  for (const item of opened) await item.close()
  opened.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const iso = (text: string) => new Date(text).toISOString()

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-computer-'))
  roots.push(dataDir)
  const f = {
    dataDir,
    clock: Date.parse('2026-11-12T22:00:00Z'),
    changed: vi.fn(),
    setAside: vi.fn(),
    open: async () => {
      const computer = await HostComputer.open({ dataDir, now: () => f.clock, changed: f.changed, setAside: f.setAside })
      opened.add(computer)
      return computer
    },
    /** An orderly stop, as the Host's shutdown does it. */
    stop: async (computer: HostComputer) => {
      opened.delete(computer)
      await computer.close()
    },
  }
  return { f, computer: await f.open() }
}

test('says sleep only inside a closed sleep, and unknown while one is open or nothing covers the time', async () => {
  const { f, computer } = await fixture()
  expect(computer.view()).toEqual({ desktop: false })
  await computer.sleeping()
  f.clock = Date.parse('2026-11-13T07:30:00Z')
  // Not woken yet: nothing says how long the sleep lasted.
  expect(computer.cause(iso('2026-11-13T07:00:00Z'))).toBe('unknown')
  await computer.awake()
  expect(computer.view().wokeAt).toBe(iso('2026-11-13T07:30:00Z'))
  expect(computer.cause(iso('2026-11-13T07:00:00Z'))).toBe('sleep')
  // Before any record, and after the wake: unknown, never guessed as off.
  expect(computer.cause(iso('2026-11-12T21:00:00Z'))).toBe('unknown')
  expect(computer.cause(iso('2026-11-13T08:00:00Z'))).toBe('unknown')
})

test('a repeated sleep report ends the open sleep there and starts another', async () => {
  const { f, computer } = await fixture()
  await computer.sleeping()
  f.clock = Date.parse('2026-11-12T23:00:00Z')
  await computer.sleeping()
  f.clock = Date.parse('2026-11-13T01:00:00Z')
  expect(computer.cause(iso('2026-11-12T22:30:00Z'))).toBe('sleep')
  expect(computer.cause(iso('2026-11-13T00:00:00Z'))).toBe('unknown')
  await computer.awake()
  expect(computer.cause(iso('2026-11-13T00:00:00Z'))).toBe('sleep')
})

test('an unclosed sleep across a Host restart is dropped, an orderly stop reads as off, a crash as unknown', async () => {
  const { f, computer } = await fixture()
  await computer.sleeping()
  // The Host stops in order while the sleep is still open (no wake report ever came).
  f.clock = Date.parse('2026-11-12T23:00:00Z')
  await f.stop(computer)
  f.clock = Date.parse('2026-11-13T09:00:00Z')
  const again = await f.open()
  expect(again.cause(iso('2026-11-12T22:30:00Z'))).toBe('unknown')
  // Latch was stopped from 23:00 until this start.
  expect(again.cause(iso('2026-11-13T06:00:00Z'))).toBe('off')
  expect(again.view()).toEqual({ desktop: false })
  // A Host that ends without stopping (a crash) records no stop: its gap stays unknown, and a late Host says no more.
  opened.delete(again)
  f.clock = Date.parse('2026-11-14T09:00:00Z')
  const late = await f.open()
  expect(late.cause(iso('2026-11-13T06:00:00Z'))).toBe('off')
  expect(late.cause(iso('2026-11-14T06:00:00Z'))).toBe('unknown')
})

test('keeps a bounded record, so a miss older than what is kept is unknown', async () => {
  const { f, computer } = await fixture()
  const first = iso('2026-11-12T22:30:00Z')
  for (let index = 0; index < MAX_SLEEPS + 8; index++) {
    await computer.sleeping()
    await computer.sleeping()
    f.clock += 60 * 60_000
    await computer.awake()
    f.clock += 60_000
  }
  const stored = JSON.parse(await readFile(join(f.dataDir, 'agents', 'computer.json'), 'utf8')) as { sleeps: unknown[] }
  expect(stored.sleeps).toHaveLength(MAX_SLEEPS)
  expect(computer.cause(first)).toBe('unknown')
})

test('a record that does not read is set aside and the Host starts with none', async () => {
  const { f, computer } = await fixture()
  await f.stop(computer)
  await writeFile(join(f.dataDir, 'agents', 'computer.json'), JSON.stringify({ version: 1, sleeps: [], stops: [], extra: true }), {
    mode: 0o600,
  })
  const again = await f.open()
  expect(f.setAside).toHaveBeenCalledWith('invalid')
  expect(again.view()).toEqual({ desktop: false })
  const files = await readdir(join(f.dataDir, 'agents'))
  expect(files.filter(name => name.startsWith('computer.json.invalid-'))).toHaveLength(1)
  await again.sleeping()
  f.clock += 60_000
  await again.awake()
  expect(again.cause(iso('2026-11-12T22:00:30Z'))).toBe('sleep')
})

test('the desktop app counts as running only while it keeps reporting', async () => {
  const { f, computer } = await fixture()
  computer.report({ state: 'desktop', keepAwake: 'schedule' })
  expect(computer.view()).toEqual({ desktop: true, keepAwake: 'schedule' })
  expect(f.changed).toHaveBeenCalled()
  computer.report({ state: 'desktop', keepAwake: null })
  expect(computer.view()).toEqual({ desktop: true })
  f.clock += DESKTOP_STALE_MS + 1
  expect(computer.view()).toEqual({ desktop: false })
  expect(desktopReportSchema.safeParse({ state: 'desktop', keepAwake: 'always' }).success).toBe(false)
  expect(desktopReportSchema.safeParse({ state: 'desktop', keepAwake: null, at: 'x' }).success).toBe(false)
})
