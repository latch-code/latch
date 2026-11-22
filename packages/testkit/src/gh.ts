import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The stand-in for the GitHub CLI; `installFakeGh` puts a `gh` that runs it on a PATH of its own. */
export const FAKE_GH: string = fileURLToPath(new URL('../fixtures/fake-gh.mjs', import.meta.url))

/** A check of `statusCheckRollup` as `gh pr view --json` prints it. */
export type FakeGhCheck =
  | {
      __typename: 'CheckRun'
      name: string
      workflowName?: string
      status: string
      conclusion: string
      startedAt?: string
      completedAt?: string
      detailsUrl?: string
    }
  | { __typename: 'StatusContext'; context: string; state: string; startedAt?: string }

export interface FakeGhPr {
  number: number
  url: string
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  reviewDecision: string
  headRefName: string
  baseRefName: string
  headRefOid: string | null
  isCrossRepository: boolean
  statusCheckRollup: FakeGhCheck[]
  reviews: Array<{ author: { login: string }; state: string; body: string; submittedAt: string }>
  comments: Array<{ author: { login: string }; body: string; createdAt: string }>
  lineComments: Array<{ user: { login: string }; path: string; line: number; body: string; created_at: string }>
}

export interface FakeGhState {
  loggedIn: boolean
  /** `github.com/<owner>/<name>`: the only repository it answers for. */
  repo: string
  defaultBranch: string
  prs: FakeGhPr[]
  nextNumber: number
  /** Failed jobs' `--log-failed` output, by job ID. */
  logs: Record<string, string>
  /** The commit a created pull request's head is at. */
  headSha?: string
  /** `pr create` makes the pull request, then waits this long before it answers (to outlast a Host's time limit). */
  createDelayMs?: number
  /** `pr create` fails with this on standard error. */
  createFails?: string
  /** GitHub Enterprise Server hosts `gh auth status --hostname` says it is logged in to (github.com always). */
  hosts?: string[]
  /** Of those, the ones whose login no longer works. */
  expiredHosts?: string[]
}

export interface FakeGh {
  /** A shell for the Host's delivery runner: `/bin/sh`, not a login shell, with only this `gh` and the system on PATH. */
  shell: () => Promise<{ file: string; argv: string[] }>
  state(): Promise<FakeGhState>
  update(change: (state: FakeGhState) => void): Promise<void>
  /** Each call's arguments, in order. */
  calls(): Promise<string[][]>
  /** Token reads or token-like variables it saw; a test expects none. */
  violations(): Promise<string[]>
  /** The pull request bodies `pr create` read from its `--body-file`. */
  bodies(): Promise<string[]>
  /**
   * Makes `gh` missing (as on a computer without it), or puts it back. Its place on the PATH answers as a shell does for
   * an unknown command, so a `gh` the system keeps in `/usr/bin` (as Linux packages do) is never reached instead.
   */
  setMissing(missing: boolean): Promise<void>
}

/**
 * A fake `gh` under `root`: `root/bin/gh` runs `FAKE_GH` with its state in `root/state`, and `root/shell/sh` is a shell
 * whose PATH starts there and holds nothing else of the user's, so no real `gh` can be found by mistake.
 */
export async function installFakeGh(
  root: string,
  initial: Partial<FakeGhState> = {},
  /** Variables the shell exports before anything else runs, as a login profile would. */
  profile: Record<string, string> = {},
): Promise<FakeGh> {
  const bin = join(root, 'bin'),
    stateDir = join(root, 'state'),
    shellDir = join(root, 'shell')
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(stateDir, { recursive: true }), mkdir(shellDir, { recursive: true })])
  const state: FakeGhState = {
    loggedIn: true,
    repo: 'github.com/acme/widgets',
    defaultBranch: 'main',
    prs: [],
    nextNumber: 1,
    logs: {},
    ...initial,
  }
  const statePath = join(stateDir, 'state.json')
  await writeFile(statePath, JSON.stringify(state, null, 2))
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
  const gh = join(bin, 'gh')
  await writeFile(gh, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FAKE_GH)} ${quote(stateDir)} "$@"\n`)
  await chmod(gh, 0o755)
  const shell = join(shellDir, 'sh')
  const exports = Object.entries(profile)
    .map(([name, value]) => `${name}=${quote(value)}; export ${name}\n`)
    .join('')
  await writeFile(shell, `#!/bin/sh\nPATH=${quote(`${bin}:/usr/bin:/bin`)}; export PATH\n${exports}exec /bin/sh "$@"\n`)
  await chmod(shell, 0o755)
  const lines = async (name: string) => {
    const path = join(stateDir, name)
    if (!existsSync(path)) return []
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean)
  }
  return {
    shell: async () => ({ file: shell, argv: ['sh'] }),
    state: async () => JSON.parse(await readFile(statePath, 'utf8')) as FakeGhState,
    async update(change) {
      const current = JSON.parse(await readFile(statePath, 'utf8')) as FakeGhState
      change(current)
      await writeFile(statePath, JSON.stringify(current, null, 2))
    },
    calls: async () => (await lines('calls.jsonl')).map(line => (JSON.parse(line) as { args: string[] }).args),
    violations: () => lines('violations.log'),
    bodies: async () => (await lines('bodies.log')).map(line => JSON.parse(line) as string),
    async setMissing(missing) {
      const off = join(bin, 'gh.off')
      if (missing && !existsSync(off)) {
        await rename(gh, off)
        await writeFile(gh, '#!/bin/sh\necho "sh: gh: not found" >&2\nexit 127\n')
        await chmod(gh, 0o755)
      }
      if (!missing && existsSync(off)) {
        await rm(gh, { force: true })
        await rename(off, gh)
      }
    },
  }
}
