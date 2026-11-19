/**
 * Whether DeepSeek Harness's own composition of its `acp` profile leaves given plugins as its official bundles ship them.
 * `dsh --profile acp --dump-config` prints the composed plugin tree and exits without mounting a plugin; each entry
 * follows a `# == <layer>` comment, with `, patched by <layer>[, <layer>…]` when a later layer changed it, where a bundle
 * is named by its package and a file by its absolute path (0.2.2-rc.1, seen in throwaway homes). That covers what a scan
 * of patch files for words cannot: a bundle's own patches, several patch files, other extensions, and the profile's
 * bundle list. It does not evaluate `!!js` or read `.env` files; callers check those as before.
 *
 * Run by the Host only where the start script opts in (`cliQuota`, `cliUsage`, `cliStore`): the confirmed program, no
 * prompt, no session, in an empty private folder, at most 10 seconds and 1 MiB of output. Only the verdict leaves.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The layers DeepSeek Harness's `acp` profile is made of when nobody changed it. */
const OFFICIAL = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'])
const MAX_OUTPUT = 1024 * 1024
const TIMEOUT_MS = 10_000
const CACHE_MS = 5 * 60_000

/** What `--dump-config` says of the plugins asked about: `official`, or `changed` when anything is not certain. */
export type DshConfigVerdict = 'official' | 'changed'

/**
 * The verdict from a dump: every entry comes from an official bundle (a plugin a person inserted could do anything), and
 * none of `ids` was patched by anything but an official bundle. An entry that is not where the dump's own shape puts it,
 * or a missing one of `ids`, is `changed`.
 */
export function judgeDshDump(dump: string, ids: readonly string[]): DshConfigVerdict {
  let layer: { origin: string; patchedBy: string[] } | undefined
  const seen = new Set<string>()
  for (const line of dump.split('\n')) {
    const comment = /^# == (.+)$/u.exec(line)
    if (comment) {
      const [origin, patched] = comment[1]!.split(/, patched by /u, 2) as [string, string | undefined]
      layer = { origin: origin.trim(), patchedBy: patched ? patched.split(/,\s*/u).map(item => item.trim()) : [] }
      if (!OFFICIAL.has(layer.origin)) return 'changed'
      continue
    }
    const entry = /^- id: (\S+)\s*$/u.exec(line)
    if (!entry) continue
    if (!layer) return 'changed'
    const id = entry[1]!.replace(/^['"]|['"]$/gu, '')
    if (!ids.includes(id)) continue
    if (layer.patchedBy.some(item => !OFFICIAL.has(item))) return 'changed'
    seen.add(id)
  }
  return ids.every(id => seen.has(id)) ? 'official' : 'changed'
}

/** The dump's standard output, or undefined when it did not exit 0 in time within the bound. */
async function dump(command: string, home: string, path: string | undefined): Promise<string | undefined> {
  const cwd = await mkdtemp(join(tmpdir(), 'latch-dsh-config-'))
  try {
    return await new Promise<string | undefined>(resolve => {
      const child = spawn(command, ['--profile', 'acp', '--dump-config'], {
        cwd,
        env: { HOME: home, ...(path ? { PATH: path } : {}), DSH_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: false,
      })
      const chunks: Buffer[] = []
      let size = 0
      let done = false
      const finish = (value: string | undefined) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (child.exitCode === null) child.kill('SIGKILL')
        resolve(value)
      }
      const timer = setTimeout(() => finish(undefined), TIMEOUT_MS)
      timer.unref()
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > MAX_OUTPUT) finish(undefined)
        else chunks.push(chunk)
      })
      child.once('error', () => finish(undefined))
      child.once('close', code => finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : undefined))
    })
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

/** What the dump depends on that a person changes by hand: their patch layers and the profile's bundle list. */
async function inputsKey(home: string): Promise<string> {
  const files = [
    join(home, '.dsh', 'cordis.patch.yml'),
    join(home, '.dsh', 'profiles', 'acp', 'cordis.patch.yml'),
    join(home, '.dsh', 'profiles', 'acp', 'package.json'),
    join(home, '.dsh', 'profiles', 'acp', 'node_modules'),
  ]
  const parts = await Promise.all(
    files.map(file =>
      stat(file).then(
        info => `${info.mtimeMs}:${info.size}:${info.ino}`,
        () => '-',
      ),
    ),
  )
  return parts.join('|')
}

/**
 * Asks DeepSeek Harness's dump whether `ids` are as its official bundles ship them, and keeps the answer for five
 * minutes while the person's layers and the bundle list stay as they were. `command` is the confirmed program.
 */
export function dshConfigCheck(input: { home: string; path?: () => string | undefined }) {
  const cache = new Map<string, { at: number; key: string; verdict: DshConfigVerdict }>()
  return async (command: string, ids: readonly string[]): Promise<DshConfigVerdict> => {
    const cacheKey = `${command}\n${[...ids].sort().join(',')}`
    const key = await inputsKey(input.home)
    const kept = cache.get(cacheKey)
    if (kept && kept.key === key && Date.now() - kept.at < CACHE_MS) return kept.verdict
    const output = await dump(command, input.home, input.path?.())
    const verdict = output === undefined ? 'changed' : judgeDshDump(output, ids)
    cache.set(cacheKey, { at: Date.now(), key, verdict })
    return verdict
  }
}
