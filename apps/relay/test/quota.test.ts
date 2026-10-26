import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { QuotaMeter, type NetworkCounter, type QuotaConfig } from '../src/quota.ts'
import { quotaCalendar } from '../src/calendar.ts'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(config: Partial<QuotaConfig> = {}, start = Date.UTC(2026, 9, 1)) {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-relay-quota-'))
  roots.push(dataDir)
  let now = start,
    raw: NetworkCounter = { boot: 'a'.repeat(64), rx: 1000, tx: 2000 }
  const input = {
    dataDir,
    config: {
      monthlyBytes: 3_100_000,
      resetDay: 1,
      timezone: 'UTC',
      count: 'in+out',
      iface: 'eth0',
      burstBytes: 16_384,
      stopRatio: 0.9,
      ...config,
    } as QuotaConfig,
    now: () => now,
    counter: async () => ({ ...raw }),
  }
  const open = () => QuotaMeter.open(input)
  return {
    dataDir,
    open,
    time(value: number) {
      now = value
    },
    add(rx: number, tx: number) {
      raw = { ...raw, rx: raw.rx + rx, tx: raw.tx + tx }
    },
    reset(boot: string, rx: number, tx: number) {
      raw = { boot: boot.repeat(64), rx, tx }
    },
  }
}
describe('aggregate Linux interface accounting', () => {
  it('requires explicit initial calibration, counts the selected direction and restores the aggregate baseline', async () => {
    const f = await fixture(),
      meter = await f.open()
    expect(meter.snapshot()).toMatchObject({ calibrated: false, admission: false, rate: 0 })
    await meter.setUsed(100)
    f.add(1000, 2000)
    await meter.sample()
    expect(meter.snapshot()).toMatchObject({ monthlyUsed: 3100, dailyUsed: 3000, calibrated: true, admission: true })
    const before = meter.snapshot()
    const loaded = await f.open()
    expect(loaded.snapshot().monthlyUsed).toBe(before.monthlyUsed)
    f.add(20, 30)
    await loaded.sample()
    expect(loaded.snapshot().monthlyUsed).toBe(3150)
    expect((await stat(join(f.dataDir, 'quota.json'))).mode & 0o777).toBe(0o600)
    const ledger = JSON.parse(await readFile(join(f.dataDir, 'quota.json'), 'utf8'))
    expect(Object.keys(ledger).sort()).toEqual([
      'at',
      'boot',
      'calibrated',
      'count',
      'cycle',
      'dailyBudget',
      'dailyUsed',
      'day',
      'iface',
      'monthlyUsed',
      'rx',
      'tx',
      'version',
    ])
    const out = await fixture({ count: 'out' }),
      output = await out.open()
    await output.setUsed(0)
    out.add(99999, 42)
    await output.sample()
    expect(output.snapshot().monthlyUsed).toBe(42)
  })
  it('counts fresh boot/interface counters without subtracting the old boot and conservatively charges the interval after a reset', async () => {
    const f = await fixture(),
      meter = await f.open()
    await meter.setUsed(0)
    f.reset('b', 5000, 6000)
    await meter.sample()
    expect(meter.snapshot().monthlyUsed).toBe(11000)
    f.reset('b', 10, 20)
    await meter.sample()
    expect(meter.snapshot().monthlyUsed).toBe(11030)
    f.time(Date.UTC(2026, 10, 1))
    f.add(5, 10)
    await meter.sample()
    expect(meter.snapshot()).toMatchObject({ monthlyUsed: 15, dailyUsed: 15, calibrated: true, healthy: true })
  })
  it('limits excess to the current day, restores next-day admission, and gates monthly admission by calendar as well as usage', async () => {
    const f = await fixture(),
      meter = await f.open()
    await meter.setUsed(0)
    const budget = meter.snapshot().dailyBudget
    f.add(budget + 1, 0)
    await meter.sample()
    expect(meter.snapshot()).toMatchObject({ mode: 'day-exhausted', admission: false, rate: 0 })
    f.time(Date.UTC(2026, 9, 2))
    await meter.sample()
    expect(meter.snapshot().admission).toBe(true)
    await meter.setUsed(2_800_000)
    expect(meter.snapshot().warning).toBe(true)
    expect(meter.snapshot().admission).toBe(true)
    f.time(Date.UTC(2026, 9, 30))
    await meter.sample()
    expect(meter.snapshot()).toMatchObject({ mode: 'admission-stopped', admission: false })
    await meter.setUsed(3_010_000)
    expect(meter.snapshot().mode).toBe('admission-stopped')
    f.time(Date.UTC(2026, 9, 31, 12))
    await meter.sample()
    expect(meter.snapshot().mode).toBe('evicting')
    await meter.setUsed(3_069_000)
    expect(meter.snapshot()).toMatchObject({ mode: 'monthly-protection', rate: 0, admission: false })
  })
  it('fails closed on stale counters, invalid state, changed meter configuration and private-file permissions without discarding the old ledger', async () => {
    const f = await fixture(),
      meter = await f.open()
    await meter.setUsed(0)
    f.time(Date.UTC(2026, 9, 1, 0, 0, 3))
    expect(meter.snapshot()).toMatchObject({ healthy: false, admission: false, rate: 0 })
    await meter.sample()
    expect(meter.snapshot().healthy).toBe(true)
    const path = join(f.dataDir, 'quota.json'),
      original = await readFile(path, 'utf8')
    await writeFile(path, '{"bad":true}', { mode: 0o600 })
    await expect(f.open()).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('{"bad":true}')
    await writeFile(path, original)
    await chmod(path, 0o644)
    await expect(f.open()).rejects.toThrow()
    await chmod(path, 0o600)
    await rm(path)
    await symlink(join(f.dataDir, 'target'), path)
    await expect(f.open()).rejects.toThrow()
  })
})
describe('provider calendar boundaries', () => {
  it('respects DST, half-hour offsets and reset days beyond a short month', () => {
    const calendar = quotaCalendar('America/New_York', 1)
    expect(calendar.at(Date.UTC(2026, 2, 8, 5)).nextDayAt - Date.UTC(2026, 2, 8, 5)).toBe(23 * 3600_000)
    expect(quotaCalendar('Asia/Kolkata', 1).at(Date.UTC(2026, 9, 1)).nextDayAt).toBe(Date.UTC(2026, 9, 1, 18, 30))
    const short = quotaCalendar('UTC', 31).at(Date.UTC(2026, 1, 28))
    expect(short.cycle).toBe(20260228)
    expect(short.nextResetAt).toBe(Date.UTC(2026, 2, 31))
  })
})
