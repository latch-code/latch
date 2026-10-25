import { AppError } from '@latch/sdk'

/** Per-device parallelism and a remote byte budget, independent of the route request-rate bucket. */
export class FileReadQuota {
  private readonly entries = new Map<string, { active: number; bytes: number; since: number }>()
  constructor(private readonly now: () => number) {}

  begin(deviceId: string, local: boolean): { consume(bytes: number): void; release(): void } {
    const time = this.now()
    for (const [id, entry] of this.entries) if (entry.active === 0 && time - entry.since >= 60_000) this.entries.delete(id)
    const entry = this.entries.get(deviceId) ?? { active: 0, bytes: 0, since: time }
    if (this.entries.size >= 4096 && !this.entries.has(deviceId)) throw new AppError(429, 'rate-limited', '文件读取繁忙，请稍后再试')
    if (entry.active >= 8) throw new AppError(429, 'rate-limited', '同时读取的文件过多，请稍后再试')
    entry.active++
    this.entries.set(deviceId, entry)
    let released = false
    return {
      consume: bytes => {
        const now = this.now()
        if (now - entry.since >= 60_000) {
          entry.since = now
          entry.bytes = 0
        }
        if (!local && entry.bytes + bytes > 200 * 1024 * 1024)
          throw new AppError(429, 'rate-limited', '这台设备的文件读取量已达每分钟上限，请稍后再试')
        entry.bytes += bytes
      },
      release: () => {
        if (!released) {
          released = true
          entry.active--
        }
      },
    }
  }
}
