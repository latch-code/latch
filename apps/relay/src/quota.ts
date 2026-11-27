import { createHash } from 'node:crypto'
import { readFile, opendir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { quotaCalendar } from './calendar.ts'
import { readPrivate, writePrivate } from './private-store.ts'
export interface QuotaConfig {
  monthlyBytes: number
  resetDay: number
  timezone: string
  count: 'in+out' | 'out'
  /** `'relay'` meters bytes forwarded by this relay process (calibrated at 0 on creation); `'iface'` meters a Linux NIC. */
  source?: 'iface' | 'relay'
  iface?: string
  burstBytes: number
  stopRatio: 0.85 | 0.9
}
export interface NetworkCounter {
  boot: string
  rx: number
  tx: number
}
export interface QuotaSnapshot {
  monthlyBytes: number
  monthlyUsed: number
  dailyBudget: number
  dailyUsed: number
  dailyRemaining: number
  rate: number
  burstBytes: number
  daysRemaining: number
  resetAt: number
  dayEndsAt: number
  projectedMonthlyBytes: number
  usedRatio: number
  warning: boolean
  healthy: boolean
  mode: 'normal' | 'paced' | 'day-exhausted' | 'monthly-protection' | 'admission-stopped' | 'evicting' | 'unavailable'
  admission: boolean
  calibrated: boolean
}
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const schema = z
  .object({
    version: z.literal(1),
    calibrated: z.boolean(),
    iface: z.string().max(32),
    count: z.enum(['in+out', 'out']),
    boot: z.string().regex(/^[a-f0-9]{64}$/u),
    rx: integer,
    tx: integer,
    at: integer,
    cycle: integer,
    day: integer,
    monthlyUsed: integer,
    dailyUsed: integer,
    dailyBudget: integer,
  })
  .strict()
type Ledger = z.infer<typeof schema>
async function readLinuxNetworkCounter(iface: string): Promise<NetworkCounter> {
  if (!/^[a-zA-Z0-9_.:-]{1,15}$/u.test(iface) || ['lo', '.', '..'].includes(iface)) throw new Error('Invalid metered network interface')
  const [boot, rx, tx] = await Promise.all([
    readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    readFile(`/sys/class/net/${iface}/statistics/rx_bytes`, 'utf8'),
    readFile(`/sys/class/net/${iface}/statistics/tx_bytes`, 'utf8'),
  ])
  const count = (value: string) => {
    if (!/^\d+\n?$/u.test(value)) throw new Error('Invalid network counter')
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Network counter limit')
    return n
  }
  if (!/^[a-f0-9-]{36}\n?$/u.test(boot)) throw new Error('Invalid network boot marker')
  return { boot: createHash('sha256').update(boot.trim()).digest('hex'), rx: count(rx), tx: count(tx) }
}
/** One sample/second, one aggregate atomic ledger; forwarding only reads a cached snapshot. */
export class QuotaMeter {
  private state!: Ledger
  private period!: ReturnType<ReturnType<typeof quotaCalendar>['at']>
  private readonly config: QuotaConfig
  private readonly path: string
  private readonly counter: () => Promise<NetworkCounter>
  private readonly now: () => number
  private readonly calendar: ReturnType<typeof quotaCalendar>
  private queue: Promise<void> = Promise.resolve()
  private healthy = true
  private sampling?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private constructor(input: { dataDir: string; config: QuotaConfig; counter?: () => Promise<NetworkCounter>; now?: () => number }) {
    this.config = input.config
    this.path = join(input.dataDir, 'quota.json')
    this.counter =
      input.counter
      ?? (() => {
        if (!input.config.iface) throw new Error('Network counter callback required for relay-level quota')
        return readLinuxNetworkCounter(input.config.iface)
      })
    this.now = input.now ?? Date.now
    this.calendar = quotaCalendar(this.config.timezone, this.config.resetDay)
  }
  static async open(input: {
    dataDir: string
    config: QuotaConfig
    counter?: () => Promise<NetworkCounter>
    now?: () => number
  }): Promise<QuotaMeter> {
    const meter = new QuotaMeter(input),
      config = input.config,
      source = config.source ?? 'iface',
      ledgerIface = source === 'relay' ? 'relay' : (config.iface ?? '')
    if (
      !Number.isSafeInteger(config.monthlyBytes)
      || config.monthlyBytes <= 0
      || !Number.isInteger(config.resetDay)
      || config.resetDay < 1
      || config.resetDay > 31
      || !Number.isSafeInteger(config.burstBytes)
      || config.burstBytes <= 0
      || !['in+out', 'out'].includes(config.count)
      || (source === 'iface' && (!/^[a-zA-Z0-9_.:-]{1,15}$/u.test(ledgerIface) || ['lo', '.', '..', 'relay'].includes(ledgerIface)))
      || (source === 'relay' && config.iface !== undefined)
      || ![0.85, 0.9].includes(config.stopRatio)
    )
      throw new Error('Invalid quota configuration')
    const directory = await opendir(input.dataDir)
    for await (const entry of directory)
      if (/^quota\.json\.[a-f0-9]{16}\.tmp$/u.test(entry.name) && entry.isFile()) await unlink(join(input.dataDir, entry.name))
    const saved = await readPrivate(meter.path, 8192),
      raw = await meter.counter(),
      now = meter.now(),
      at = meter.calendar.at(now)
    if (![raw.rx, raw.tx].every(value => Number.isSafeInteger(value) && value >= 0) || !/^[a-f0-9]{64}$/u.test(raw.boot))
      throw new Error('Invalid network counter')
    meter.period = at
    if (saved !== undefined) {
      meter.state = schema.parse(JSON.parse(saved) as unknown)
      if (meter.state.iface !== ledgerIface || meter.state.count !== config.count)
        throw new Error('Quota counter configuration changed; calibrate explicitly')
      await meter.sample()
    } else {
      meter.state = {
        version: 1,
        calibrated: source === 'relay',
        iface: ledgerIface,
        count: config.count,
        boot: raw.boot,
        rx: raw.rx,
        tx: raw.tx,
        at: now,
        cycle: at.cycle,
        day: at.day,
        monthlyUsed: 0,
        dailyUsed: 0,
        dailyBudget: Math.floor((config.monthlyBytes * 0.99) / at.daysRemaining),
      }
      await writePrivate(meter.path, `${JSON.stringify(meter.state)}\n`)
    }
    return meter
  }
  sample(): Promise<void> {
    if (this.sampling) return this.sampling
    const work = this.queue
      .then(async () => {
        const raw = await this.counter(),
          now = this.now(),
          at = this.calendar.at(now),
          previous = this.state
        if (
          ![raw.rx, raw.tx].every(value => Number.isSafeInteger(value) && value >= 0)
          || !/^[a-f0-9]{64}$/u.test(raw.boot)
          || now < previous.at
        )
          throw new Error('Invalid counter clock')
        const delta = (current: number, old: number) => (raw.boot !== previous.boot || current < old ? current : current - old)
        const bytes = delta(raw.tx, previous.tx) + (this.config.count === 'in+out' ? delta(raw.rx, previous.rx) : 0)
        if (!Number.isSafeInteger(bytes)) throw new Error('Network counter overflow')
        const sameCycle = at.cycle === previous.cycle,
          sameDay = sameCycle && at.day === previous.day
        const monthlyUsed = (sameCycle ? previous.monthlyUsed : 0) + bytes,
          dailyUsed = (sameDay ? previous.dailyUsed : 0) + bytes
        const next: Ledger = {
          ...previous,
          ...raw,
          at: now,
          cycle: at.cycle,
          day: at.day,
          monthlyUsed,
          dailyUsed,
          dailyBudget: sameDay
            ? previous.dailyBudget
            : Math.max(0, Math.floor((this.config.monthlyBytes * 0.99 - monthlyUsed + dailyUsed) / at.daysRemaining)),
        }
        schema.parse(next)
        await writePrivate(this.path, `${JSON.stringify(next)}\n`)
        this.state = next
        this.period = at
        this.healthy = true
      })
      .catch(() => {
        this.healthy = false
        throw new Error('Quota accounting unavailable')
      })
    this.queue = work.catch(() => {})
    this.sampling = work.finally(() => {
      this.sampling = undefined
    })
    return this.sampling
  }
  snapshot(): QuotaSnapshot {
    const now = this.now(),
      at = this.period,
      state = this.state,
      ratio = state.monthlyUsed / this.config.monthlyBytes
    const remaining = Math.max(
      0,
      Math.min(state.dailyBudget - state.dailyUsed, Math.floor(this.config.monthlyBytes * 0.99) - state.monthlyUsed),
    )
    const healthy = this.healthy && now - state.at <= 2 * 1000 && now < at.nextDayAt
    const calibrated = state.calibrated
    const elapsed = Math.max(1, (now - at.dayStartedAt) / 1000)
    const projected = Math.ceil(state.monthlyUsed + (state.dailyUsed / elapsed) * Math.max(0, (at.nextResetAt - now) / 1000))
    const calendarStop = ratio >= this.config.stopRatio && at.calendarProgress >= this.config.stopRatio
    const evicting = ratio >= 0.97 && at.calendarProgress >= 0.97
    const mode =
      !healthy || !calibrated
        ? 'unavailable'
        : ratio >= 0.99
          ? 'monthly-protection'
          : evicting
            ? 'evicting'
            : calendarStop
              ? 'admission-stopped'
              : remaining <= 0
                ? 'day-exhausted'
                : state.dailyUsed > (state.dailyBudget * (now - at.dayStartedAt)) / Math.max(1, at.nextDayAt - at.dayStartedAt)
                  ? 'paced'
                  : 'normal'

    return {
      monthlyBytes: this.config.monthlyBytes,
      monthlyUsed: state.monthlyUsed,
      dailyBudget: state.dailyBudget,
      dailyUsed: state.dailyUsed,
      dailyRemaining: remaining,
      rate: healthy && calibrated ? remaining / Math.max(1, (at.nextDayAt - now) / 1000) : 0,
      burstBytes: this.config.burstBytes,
      daysRemaining: at.daysRemaining,
      resetAt: at.nextResetAt,
      dayEndsAt: at.nextDayAt,
      projectedMonthlyBytes: projected,
      usedRatio: ratio,
      warning: ratio >= 0.7 || projected > this.config.monthlyBytes * 0.99,
      healthy,
      calibrated,
      mode,
      admission: healthy && calibrated && remaining > 0 && !calendarStop,
    }
  }
  async setUsed(bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return Promise.reject(new Error('Invalid quota calibration'))
    await this.sample()
    const work = this.queue.then(async () => {
      const at = this.period,
        next = {
          ...this.state,
          monthlyUsed: bytes,
          calibrated: true,
          dailyBudget: Math.max(0, Math.floor((this.config.monthlyBytes * 0.99 - bytes + this.state.dailyUsed) / at.daysRemaining)),
        }
      await writePrivate(this.path, `${JSON.stringify(next)}\n`)
      this.state = next
    })
    this.queue = work.catch(() => {
      this.healthy = false
    })
    return work.catch(() => {
      this.healthy = false
      throw new Error('Quota calibration unavailable')
    })
  }
  start(): void {
    this.timer ??= setInterval(() => {
      void this.sample().catch(() => {})
    }, 1000)
    this.timer.unref()
  }
  async close(): Promise<void> {
    clearInterval(this.timer)
    await this.sample()
    await this.queue
  }
}
