import { hex } from '@latch/link-wire'
import type { EdgeSql } from './platform.ts'

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
