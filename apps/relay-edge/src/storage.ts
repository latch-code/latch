import { hex } from '@latch/link-wire'
import type { EdgeSql } from './platform.ts'

const DAY_MS = 86_400_000
/** Counts are reserved on disk this far ahead, so a restart can only over-count, never under-count. */
const RESERVATION = 10_000

function periods(now: number): { day: string; month: string } {
  const date = new Date(now)
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
  return { day: `${month}-${String(date.getUTCDate()).padStart(2, '0')}`, month }
}

/**
 * A spend cap in received WebSocket messages, the unit the platform bills (UTC days and months). It fails closed: until
 * the stored counters have been read, after any storage error and when the caps are missing, `over()` is true and the
 * node refuses new connections of every role.
 */
export class EdgeBudget {
  private readonly sql: EdgeSql
  private readonly caps: { day: number; month: number } | undefined
  private loaded = false
  private failed = false
  private current = periods(0)
  private used = { day: 0, month: 0 }
  private reserved = { day: 0, month: 0 }
  constructor(sql: EdgeSql, caps: { day: number; month: number } | undefined) {
    this.sql = sql
    this.caps = caps
  }
  load(now: number): void {
    try {
      this.sql.exec('CREATE TABLE IF NOT EXISTS budget (period TEXT PRIMARY KEY, used INTEGER NOT NULL)')
      this.current = periods(now)
      const read = (period: string) => Number(this.sql.exec('SELECT used FROM budget WHERE period = ?', period).toArray()[0]?.used ?? 0)
      const day = read(`d:${this.current.day}`),
        month = read(`m:${this.current.month}`)
      if (!Number.isSafeInteger(day) || !Number.isSafeInteger(month) || day < 0 || month < 0) throw new Error('Invalid budget')
      this.used = { day, month }
      this.reserved = { day, month }
      this.loaded = true
    } catch {
      this.failed = true
    }
  }
  over(): boolean {
    return !this.loaded || this.failed || !this.caps || this.used.day >= this.caps.day || this.used.month >= this.caps.month
  }
  /** One received message. Writes a reservation synchronously when the counted value reaches the stored one. */
  count(now: number): void {
    if (!this.loaded || this.failed) return
    this.roll(now)
    this.used.day++
    this.used.month++
    if (this.used.day > this.reserved.day || this.used.month > this.reserved.month) this.reserve()
  }
  /** The alarm's turn: start a new day or month, and drop rows older than the previous month. */
  roll(now: number): void {
    if (!this.loaded || this.failed) return
    const next = periods(now)
    if (next.day === this.current.day && next.month === this.current.month) return
    if (next.day !== this.current.day) this.used.day = this.reserved.day = 0
    if (next.month !== this.current.month) this.used.month = this.reserved.month = 0
    this.current = next
    try {
      this.sql.exec("DELETE FROM budget WHERE period < ? AND period LIKE 'd:%'", `d:${periods(now - 2 * DAY_MS).day}`)
      this.sql.exec("DELETE FROM budget WHERE period < ? AND period LIKE 'm:%'", `m:${periods(now - 40 * DAY_MS).month}`)
    } catch {
      this.failed = true
    }
  }
  private reserve(): void {
    try {
      const day = this.used.day + RESERVATION,
        month = this.used.month + RESERVATION
      this.sql.exec('INSERT OR REPLACE INTO budget (period, used) VALUES (?, ?)', `d:${this.current.day}`, day)
      this.sql.exec('INSERT OR REPLACE INTO budget (period, used) VALUES (?, ?)', `m:${this.current.month}`, month)
      this.reserved = { day, month }
    } catch {
      this.failed = true
    }
  }
  /** Seconds until the cap that is reached resets, for GOAWAY. */
  retryAfterMs(now: number): number {
    const date = new Date(now)
    const monthly = this.caps !== undefined && this.used.month >= this.caps.month
    const next = monthly
      ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
      : Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
    return Math.min(6 * 3600_000, Math.max(0, next - now))
  }
  snapshot(): { over: boolean; day: number; month: number; dailyCap: number | null; monthlyCap: number | null; healthy: boolean } {
    return {
      over: this.over(),
      day: this.used.day,
      month: this.used.month,
      dailyCap: this.caps?.day ?? null,
      monthlyCap: this.caps?.month ?? null,
      healthy: this.loaded && !this.failed,
    }
  }
}

/** DENY tags per route and pass day, in the object's SQLite storage; the relay core bounds their number. */
export class EdgeDenials {
  private readonly sql: EdgeSql
  constructor(sql: EdgeSql) {
    this.sql = sql
    sql.exec(
      'CREATE TABLE IF NOT EXISTS deny (route TEXT NOT NULL, day INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (route, day, tag))',
    )
  }
  get(route: Uint8Array, day: number): Promise<Uint8Array[]> {
    const rows = this.sql.exec('SELECT tag FROM deny WHERE route = ? AND day = ? LIMIT 8193', hex(route), day).toArray()
    return Promise.resolve(
      rows.map(row => {
        const text = String(row.tag)
        if (!/^[a-f0-9]{32}$/u.test(text)) throw new Error('Invalid denial state')
        return Uint8Array.from(text.match(/../gu)!, byte => Number.parseInt(byte, 16))
      }),
    )
  }
  add(route: Uint8Array, day: number, tags: readonly Uint8Array[]): Promise<number> {
    const key = hex(route)
    for (const tag of tags) this.sql.exec('INSERT OR IGNORE INTO deny (route, day, tag) VALUES (?, ?, ?)', key, day, hex(tag))
    return Promise.resolve(
      Number(this.sql.exec('SELECT COUNT(*) AS count FROM deny WHERE route = ? AND day = ?', key, day).toArray()[0]?.count),
    )
  }
  /** Passes end 15 minutes into the next day; a denial is useless after that. */
  sweep(today: number): void {
    this.sql.exec('DELETE FROM deny WHERE day < ?', today - 1)
  }
}
