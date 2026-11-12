// The build records of page drafts: one private file per plugin under `plugin-packages/builds/`, holding each kept
// revision's latest build with its diagnostics and the bundles it made. The applied page's module is served from here,
// and a bundle whose bytes no longer match its hash is never served.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { PluginBuild } from '@latch/protocol'
import { writeFileAtomic } from '@latch/core/node-kit'
import { privateDirectory, readPrivate } from './app-data.ts'
import type { BuildOutcome } from './app-build.ts'

const hex = z.string().regex(/^[a-f0-9]{64}$/u)
const pageId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)
const diagnosticSchema = z.strictObject({
  tool: z.enum(['esbuild', 'tsc', 'build']),
  file: z.string().max(512).optional(),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
  message: z.string().max(4000),
})
const buildSchema = z.strictObject({
  id: z.string().regex(/^bld_[A-Za-z0-9_-]{16}$/u),
  revision: hex,
  status: z.enum(['ok', 'failed', 'timeout']),
  at: z.string().max(40),
  durationMs: z.number().int().min(0),
  typeChecked: z.boolean(),
  diagnostics: z.array(diagnosticSchema).max(100),
  modules: z.array(z.strictObject({ appId: pageId, bundleHash: hex, bytes: z.number().int().min(0), code: z.string() })).max(4),
})
const fileSchema = z.strictObject({ version: z.literal(1), builds: z.array(buildSchema).max(32) })
type Stored = z.infer<typeof buildSchema>
/** Builds kept per plugin besides the revisions still in use (the draft, the applied one and the rollback targets). */
const SPARE = 2
/** Plugins whose builds stay in memory. */
const CACHED = 8
const FILE_LIMIT = 80 * 1024 * 1024
/** What a write may leave on disk, under `FILE_LIMIT`. */
export const STORE_BUDGET = FILE_LIMIT - 1024 * 1024

export function describeBuild(build: Stored): PluginBuild {
  return {
    id: build.id,
    revision: build.revision,
    status: build.status,
    at: build.at,
    durationMs: build.durationMs,
    typeChecked: build.typeChecked,
    diagnostics: build.diagnostics.map(item => ({ ...item })),
    modules: build.modules.map(({ appId, bundleHash, bytes }) => ({ appId, bundleHash, bytes })),
  }
}

export class AppBuilds {
  private readonly cache = new Map<string, Stored[]>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly directory: string,
    private readonly now: () => number = Date.now,
    /** Tests only: a smaller bound for the file. */
    private readonly budget = STORE_BUDGET,
  ) {}

  static async open(dataDir: string, now?: () => number): Promise<AppBuilds> {
    const directory = join(dataDir, 'plugin-packages', 'builds')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await privateDirectory(directory)
    return new AppBuilds(directory, now)
  }

  private async load(pluginId: string): Promise<Stored[]> {
    const known = this.cache.get(pluginId)
    if (known) {
      this.cache.delete(pluginId)
      this.cache.set(pluginId, known)
      return known
    }
    let builds: Stored[] = []
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readPrivate(join(this.directory, `${pluginId}.json`), FILE_LIMIT)))
      // A bundle whose bytes do not match its hash is dropped with its build: it is never served.
      if (parsed.success)
        builds = parsed.data.builds.filter(build =>
          build.modules.every(module => createHash('sha256').update(module.code).digest('hex') === module.bundleHash),
        )
    } catch {
      builds = []
    }
    this.cache.set(pluginId, builds)
    while (this.cache.size > CACHED) this.cache.delete(this.cache.keys().next().value!)
    return builds
  }

  /** The latest build of `revision`. */
  async latest(pluginId: string, revision: string): Promise<PluginBuild | undefined> {
    const found = (await this.load(pluginId)).find(build => build.revision === revision)
    return found ? describeBuild(found) : undefined
  }

  /** The newest successful build of any kept revision: what the draft's preview shows while a newer build fails. */
  async latestOk(pluginId: string): Promise<PluginBuild | undefined> {
    const found = (await this.load(pluginId))
      .filter(build => build.status === 'ok')
      .toSorted((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0]
    return found ? describeBuild(found) : undefined
  }

  /** The bundle of one page of a successful build of `revision`. */
  async module(pluginId: string, revision: string, appId: string): Promise<{ hash: string; bytes: Buffer } | undefined> {
    const build = (await this.load(pluginId)).find(item => item.revision === revision)
    const module = build?.status === 'ok' ? build.modules.find(item => item.appId === appId) : undefined
    return module ? { hash: module.bundleHash, bytes: Buffer.from(module.code, 'utf8') } : undefined
  }

  /** Any kept successful bundle with this hash: what the preview loads. */
  async bundle(pluginId: string, hash: string): Promise<Buffer | undefined> {
    for (const build of await this.load(pluginId))
      if (build.status === 'ok') {
        const module = build.modules.find(item => item.bundleHash === hash)
        if (module) return Buffer.from(module.code, 'utf8')
      }
    return undefined
  }

  /**
   * Records a build of `revision`; it replaces that revision's earlier one. `keep` are the revisions still in use, whose
   * builds stay; of the rest only the newest few do.
   */
  record(
    pluginId: string,
    revision: string,
    outcome: BuildOutcome,
    keep: ReadonlySet<string>,
    protect: ReadonlySet<string> = keep,
  ): Promise<PluginBuild> {
    const run = this.queue.then(async () => {
      const build = buildSchema.parse({
        id: `bld_${randomBytes(12).toString('base64url')}`,
        revision,
        status: outcome.status,
        at: new Date(this.now()).toISOString(),
        durationMs: Math.max(0, Math.round(outcome.durationMs)),
        typeChecked: outcome.typeChecked,
        diagnostics: outcome.diagnostics,
        modules: outcome.modules.map(module => ({
          appId: module.appId,
          bundleHash: module.hash,
          bytes: Buffer.byteLength(module.code),
          code: module.code,
        })),
      })
      const earlier = (await this.load(pluginId)).filter(item => item.revision !== revision)
      const kept = earlier.filter(item => keep.has(item.revision))
      // The last good preview stays while newer builds fail.
      const good =
        build.status === 'ok'
          ? undefined
          : earlier.filter(item => item.status === 'ok' && !keep.has(item.revision)).toSorted((a, b) => (a.at < b.at ? 1 : -1))[0]
      const spare = earlier.filter(item => !keep.has(item.revision) && item !== good).slice(0, SPARE)
      const builds = [build, ...kept, ...(good ? [good] : []), ...spare].slice(0, 32)
      // The file never outgrows what `load` reads back: the spare builds go first, then the last good preview, then
      // rollback targets, newest kept longest; the draft's and the applied revision's builds always stay.
      const size = (list: Stored[]) => Buffer.byteLength(JSON.stringify({ version: 1, builds: list })) + 1
      while (size(builds) > this.budget) {
        const index = builds.findLastIndex(item => item !== build && !protect.has(item.revision))
        if (index < 0) break
        builds.splice(index, 1)
      }
      await writeFileAtomic(join(this.directory, `${pluginId}.json`), JSON.stringify({ version: 1, builds }) + '\n')
      this.cache.set(pluginId, builds)
      return describeBuild(build)
    })
    this.queue = run.catch(() => {})
    return run
  }

  async remove(pluginId: string): Promise<void> {
    const run = this.queue.then(async () => {
      this.cache.delete(pluginId)
      await rm(join(this.directory, `${pluginId}.json`), { force: true })
    })
    this.queue = run.catch(() => {})
    await run
  }
}
