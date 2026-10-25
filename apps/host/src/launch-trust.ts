import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, writeFileAtomic } from '@latch/core/node-kit'

const FILE = 'launch-trust.json'
const LIMIT = 10_000
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const schema = z.object({ version: z.literal(1), launches: z.array(hash).max(LIMIT) }).strict()

/** A device's OS approval of this exact launch in these ordered project roots; a sheet still confirms each start. */
export function launchTrustKey(input: {
  deviceId: string
  harnessId: string
  launchHash: string
  projectId: string
  roots: readonly string[]
}): string {
  return sha256Hex(canonicalJson(input))
}

/** Only OS-approved launch hashes enter this private file. Missing or evicted entries require OS approval. */
export class LaunchTrust {
  private writes = Promise.resolve()
  private constructor(
    private readonly file: string,
    private entries: Set<string>,
  ) {}

  static async open(dataDir: string): Promise<LaunchTrust> {
    const file = join(dataDir, FILE)
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new LaunchTrust(file, new Set())
      throw new AppError(500, 'config-corrupt', '无法读取已验证的启动记录，原文件已保留。')
    }
    try {
      return new LaunchTrust(file, new Set(schema.parse(JSON.parse(source)).launches))
    } catch {
      throw new AppError(500, 'config-corrupt', '已验证的启动记录无效，原文件已保留。')
    }
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  remember(key: string): Promise<void> {
    const write = this.writes.then(async () => {
      if (this.entries.has(key)) return
      const next = new Set(this.entries)
      next.add(hash.parse(key))
      while (next.size > LIMIT) next.delete(next.values().next().value!)
      await writeFileAtomic(this.file, `${JSON.stringify({ version: 1, launches: [...next] })}\n`)
      this.entries = next
    })
    this.writes = write.catch(() => {})
    return write
  }
}
