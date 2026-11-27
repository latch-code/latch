/**
 * Whether DeepSeek Harness's own composition of its `acp` profile leaves given plugins as its official bundles ship them.
 * `dsh --profile acp --dump-config` prints the composed plugin tree and exits without mounting a plugin; each entry
 * follows a `# == <layer>` comment, with `, patched by <layer>[, <layer>…]` when a later layer changed it, where a bundle
 * is named by its package and a file by its absolute path (0.2.2-rc.1, seen in throwaway homes). That covers what a scan
 * of patch files for words cannot: a bundle's own patches, several patch files, other extensions, and the profile's
 * bundle list. It does not evaluate `!!js` or read `.env` files; callers check those as before. A plugin a person adds
 * for something unrelated keeps the verdict (`judgeDshDump`), so one extra layer does not hide the balance, the turn's
 * tokens or real deletion; all three callers ask about plugins only the official bundles may provide or patch.
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
 * What a plugin a person added may not mention for the plugins asked about to stay as shipped: an address, a key or
 * credential, the session store, or code the loader evaluates (`!!js`).
 */
const REACHES_ROUTE = /baseURL|apiKey|DEEPSEEK|credential|persist|session|!!js/iu

/**
 * The verdict from a dump: none of `ids` comes from, or was patched by, anything but an official bundle, and every
 * entry a person's layer (or another bundle) adds stays away from them: its id is not one of them, and its lines name
 * none of them nor an address, key, credential, session store or evaluated code (`REACHES_ROUTE`). A plugin someone
 * added for something else (hooks for a status display, say) leaves the key's route and the session store as DeepSeek
 * Harness ships them; one that could reach them is `changed`. An entry that is not where the dump's own shape puts
 * it, or a missing one of `ids`, is `changed`.
 */
export function judgeDshDump(dump: string, ids: readonly string[]): DshConfigVerdict {
  let layer: { official: boolean; patchedBy: string[] } | undefined
  // Reading what a layer other than an official bundle wrote: its lines are checked as they come.
  let added = false
  const seen = new Set<string>()
  const named = (line: string) => ids.some(id => line.includes(id))
  for (const line of dump.split('\n')) {
    const comment = /^# == (.+)$/u.exec(line)
    if (comment) {
      const [origin, patched] = comment[1]!.split(/, patched by /u, 2) as [string, string | undefined]
      layer = { official: OFFICIAL.has(origin.trim()), patchedBy: patched ? patched.split(/,\s*/u).map(item => item.trim()) : [] }
      added = !layer.official
      continue
    }
    const entry = /^- id: (\S+)\s*$/u.exec(line)
    if (entry) {
      if (!layer) return 'changed'
      const id = entry[1]!.replace(/^['"]|['"]$/gu, '')
      added = !layer.official
      if (added) {
        if (ids.includes(id) || named(line) || REACHES_ROUTE.test(line)) return 'changed'
        continue
      }
      if (!ids.includes(id)) continue
      if (layer.patchedBy.some(item => !OFFICIAL.has(item))) return 'changed'
      seen.add(id)
      continue
    }
    if (added && (named(line) || REACHES_ROUTE.test(line))) return 'changed'
  }
  return ids.every(id => seen.has(id)) ? 'official' : 'changed'
}

/** The dump's standard output, or undefined when it did not exit 0 in time within the bound. */
async function dump(command: string, home: string, path: string | undefined, accountDirectory?: string): Promise<string | undefined> {
  const cwd = await mkdtemp(join(tmpdir(), 'latch-dsh-config-'))
  try {
    return await new Promise<string | undefined>(resolve => {
      const child = spawn(command, ['--profile', 'acp', '--dump-config'], {
        cwd,
        env: {
          HOME: home,
          ...(path ? { PATH: path } : {}),
          ...(accountDirectory ? { DSH_HOME: accountDirectory } : {}),
          DSH_TELEMETRY_DISABLED: '1',
        },
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
async function inputsKey(directory: string): Promise<string> {
  const files = [
    join(directory, 'cordis.patch.yml'),
    join(directory, 'profiles', 'acp', 'cordis.patch.yml'),
    join(directory, 'profiles', 'acp', 'package.json'),
    join(directory, 'profiles', 'acp', 'node_modules'),
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
export function dshConfigCheck(input: { home: string; path?: () => string | undefined; accountDirectory?: string | undefined }) {
  const cache = new Map<string, { at: number; key: string; verdict: DshConfigVerdict }>()
  return async (command: string, ids: readonly string[]): Promise<DshConfigVerdict> => {
    const cacheKey = `${command}\n${[...ids].sort().join(',')}`
    const key = await inputsKey(input.accountDirectory ?? join(input.home, '.dsh'))
    const kept = cache.get(cacheKey)
    if (kept && kept.key === key && Date.now() - kept.at < CACHE_MS) return kept.verdict
    const output = await dump(command, input.home, input.path?.(), input.accountDirectory)
    const verdict = output === undefined ? 'changed' : judgeDshDump(output, ids)
    cache.set(cacheKey, { at: Date.now(), key, verdict })
    return verdict
  }
}
