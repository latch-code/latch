import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHunkDiff, GitLineRange } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { diffLines, splitText } from '../src/changes/diff.ts'
import {
  LINE_LIMIT,
  RANGE_LIMIT,
  SelectionError,
  applySelection,
  expandRanges,
  gitGuessesBinary,
  readWorktreeFile,
  validRanges,
} from '../src/changes/git-hunks.ts'
import { readGitLayout } from '../src/branch-reader.ts'
import { GitError, GitReader, findGit } from '../src/changes/git.ts'
import { IndexMovedError, setIndexBlob } from '../src/changes/git-status.ts'
import { GitDelivery, type DeliveryAuditEvent, type DeliveryCaller, type GitDeliveryOptions } from '../src/git-delivery.ts'
import { SessionMetaStore } from '../src/session-meta.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const SLOW = { timeout: 30_000 }

/** A repository with one commit and an empty home; hooks and filters that leave a mark when they run. */
/**
 * A git that waits before each write, so a one-millisecond stage timeout always ends it before it writes, however late
 * a busy machine runs the timer; the restricted runner ends its whole process group.
 */
async function slowGit(root: string): Promise<string> {
  const path = join(root, 'slow-git')
  await writeFile(path, `#!/bin/sh\ncase " $* " in *" hash-object "*|*" update-index "*) sleep 5 ;; esac\nexec '${findGit()!}' "$@"\n`)
  await chmod(path, 0o755)
  return path
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'latch-git-hunks-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'),
    home = join(root, 'home'),
    marks = join(root, 'marks'),
    dataDir = join(root, 'data')
  await Promise.all([mkdir(repo), mkdir(home), mkdir(marks), mkdir(dataDir)])
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && name !== 'GIT_CONFIG_NOSYSTEM') delete env[name]
  const raw = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const git = (...args: string[]) =>
    raw(...args)
      .toString('utf8')
      .trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Tester')
  git('config', 'user.email', 'tester@example.invalid')
  const write = (path: string, content: string | Buffer) => writeFile(join(repo, path), content)
  const commit = async (files: Record<string, string | Buffer>, message = 'commit') => {
    for (const [path, content] of Object.entries(files)) await write(path, content)
    git('add', '-A')
    git('commit', '-q', '-m', message)
  }
  // Hooks that would run on an index write or a commit, were they not switched off.
  for (const name of ['post-index-change', 'pre-commit']) {
    await writeFile(join(repo, '.git', 'hooks', name), `#!/bin/sh\necho ran >> '${join(marks, name)}'\n`)
    await chmod(join(repo, '.git', 'hooks', name), 0o755)
  }
  const store = await SessionMetaStore.open(dataDir)
  const delivery = (options: { timeouts?: { stage?: number }; receipts?: GitDeliveryOptions['receipts']; git?: string } = {}) =>
    new GitDelivery({
      receipts: options.receipts ?? store,
      ...(options.git ? { git: options.git } : {}),
      home,
      hostEnv: { HOME: home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: root },
      shell: async () => ({ file: '/bin/sh', argv: ['-sh'] }),
      log: () => {},
      ...(options.timeouts ? { timeouts: options.timeouts } : {}),
    })
  const caller = (overrides: Partial<DeliveryCaller> = {}) => {
    const audits: DeliveryAuditEvent[] = [],
      results: unknown[] = []
    return {
      sessionId: 'session-1',
      deviceId: 'dev_test',
      folder: repo,
      authorize: async () => {},
      audit: async (event: DeliveryAuditEvent) => {
        audits.push(event)
      },
      result: async (event: unknown) => {
        results.push(event)
      },
      audits,
      results,
      ...overrides,
    }
  }
  return {
    root,
    repo,
    marks,
    git,
    raw,
    write,
    commit,
    delivery,
    caller,
    home,
    store,
    /** The receipts as a Host started again reads them from disk. */
    restarted: async () => delivery({ receipts: await SessionMetaStore.open(dataDir) }),
    /** Receipts that keep the start of a write and lose its end, as a Host stopped right after Git ran leaves them. */
    endsLost: (): GitDeliveryOptions['receipts'] => ({
      git: (...args) => store.git(...args),
      recordGit: async (sessionId, receipt) => {
        if (receipt.state !== 'pending') throw new Error('stopped before the end was written')
        await store.recordGit(sessionId, receipt)
      },
    }),
    marked: (name: string) => existsSync(join(marks, name)),
    /** The test's own Git runs the hooks: what counts is what runs after this. */
    async unmark() {
      await rm(marks, { recursive: true, force: true })
      await mkdir(marks)
    },
    /** The file as the index holds it, byte for byte. */
    staged: (path: string) => raw('cat-file', 'blob', `:${path}`),
  }
}

/** A file's lines as a request reads them; a file that goes whole has nothing to read against. */
async function read(delivery: GitDelivery, repo: string, view: 'unstaged' | 'staged', path: string) {
  const diff = await delivery.hunkDiff(repo, view, path)
  return { ...diff, base: diff.base ?? {} }
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

/** The numbers of a diff's changed lines, as a request names them. */
function changed(diff: GitHunkDiff): { old: number[]; new: number[] } {
  const lines = diff.hunks!.flatMap(hunk => hunk.lines)
  return {
    old: lines.flatMap(line => (line.kind === 'remove' ? [line.oldLine!] : [])),
    new: lines.flatMap(line => (line.kind === 'add' ? [line.newLine!] : [])),
  }
}
const each = (lines: number[]): GitLineRange[] => lines.map(line => [line, line])
const picked = (old: number[], fresh: number[]) => ({ old: new Set(old), new: new Set(fresh) })

function select(before: string, after: string, old: number[], fresh: number[], direction: 'stage' | 'unstage' = 'stage'): string {
  const a = splitText(before),
    b = splitText(after)
  return applySelection(diffLines(a, b), a, b, picked(old, fresh), direction).text
}

describe('the index content built from picked lines', () => {
  it('stages only the picked additions, removals or both', () => {
    const before = 'one\ntwo\nthree\nfour\n',
      after = 'one\nTWO\nthree\nfour\nfive\n'
    // An added line alone: the removal it replaces stays in the index.
    expect(select(before, after, [], [2])).toBe('one\ntwo\nTWO\nthree\nfour\n')
    // A removed line alone.
    expect(select(before, after, [2], [])).toBe('one\nthree\nfour\n')
    // Both halves of one change, and not the other change.
    expect(select(before, after, [2], [2])).toBe('one\nTWO\nthree\nfour\n')
    expect(select(before, after, [], [5])).toBe('one\ntwo\nthree\nfour\nfive\n')
    expect(select(before, after, [2], [2, 5])).toBe(after)
  })

  it('unstages the picked lines back towards HEAD and leaves the rest staged', () => {
    const head = 'one\ntwo\nthree\n',
      index = 'one\nTWO\nthree\nfour\n'
    expect(select(head, index, [], [4], 'unstage')).toBe('one\nTWO\nthree\n')
    expect(select(head, index, [2], [2], 'unstage')).toBe('one\ntwo\nthree\nfour\n')
    expect(select(head, index, [2], [], 'unstage')).toBe('one\ntwo\nTWO\nthree\nfour\n')
    expect(select(head, index, [2], [2, 4], 'unstage')).toBe(head)
  })

  it('keeps a missing final newline where it belongs and never joins two lines', () => {
    // The index's last line has no newline; the file adds one and a line after it.
    expect(select('a\nb', 'a\nb\nc\n', [], [3])).toBe('a\nb\nc\n')
    expect(select('a\nb', 'a\nb\nc\n', [2], [2])).toBe('a\nb\n')
    // The file's last line has none: staged whole it stays without, staged before a kept line it gains one.
    expect(select('a\nb\n', 'a\nb\nc', [], [3])).toBe('a\nb\nc')
    expect(select('a\nb\n', 'a\nx', [], [2])).toBe('a\nb\nx')
    expect(select('a\nb\n', 'a\nx', [2], [])).toBe('a\n')
    expect(select('a\r\nb', 'a\r\nb\r\nc\r\n', [], [3])).toBe('a\r\nb\r\nc\r\n')
  })

  it('treats adjacent changes line by line, CRLF endings byte for byte', () => {
    const before = 'a\r\nb\r\nc\r\nd\r\n',
      after = 'A\r\nB\r\nc\r\nD\r\n'
    expect(select(before, after, [1], [1])).toBe('A\r\nb\r\nc\r\nd\r\n')
    expect(select(before, after, [2, 4], [2, 4])).toBe('a\r\nB\r\nc\r\nD\r\n')
    expect(select(before, after, [1, 2], [])).toBe('c\r\nd\r\n')
  })

  it('refuses an empty selection and lines that are not changes', () => {
    const before = splitText('one\ntwo\n'),
      after = splitText('one\nTWO\n')
    const ops = diffLines(before, after)
    expect(() => applySelection(ops, before, after, picked([], []), 'stage')).toThrow(SelectionError)
    // Line 1 is context on both sides: a request naming it was read against another version.
    expect(() => applySelection(ops, before, after, picked([1], []), 'stage')).toThrow(/not-a-change/u)
    expect(() => applySelection(ops, before, after, picked([], [1]), 'stage')).toThrow(/not-a-change/u)
    expect(expandRanges([[2, 1]], 5)).toBeUndefined()
    expect(expandRanges([[1, 6]], 5)).toBeUndefined()
    expect([
      ...expandRanges(
        [
          [1, 2],
          [4, 5],
        ],
        5,
      )!,
    ]).toEqual([1, 2, 4, 5])
  })

  it('takes only rising, disjoint ranges of a bounded number of lines, judged before any is walked', () => {
    expect(validRanges(undefined)).toBe(true)
    expect(
      validRanges([
        [1, 1],
        [2, 9],
      ]),
    ).toBe(true)
    // Out of order, overlapping, touching the same line twice, upside down, not whole numbers.
    expect(
      validRanges([
        [4, 5],
        [1, 2],
      ]),
    ).toBe(false)
    expect(
      validRanges([
        [1, 3],
        [3, 4],
      ]),
    ).toBe(false)
    expect(
      validRanges([
        [2, 2],
        [2, 2],
      ]),
    ).toBe(false)
    expect(validRanges([[3, 2]])).toBe(false)
    expect(validRanges([[0, 2]])).toBe(false)
    expect(validRanges([[1.5, 2]])).toBe(false)
    // One huge range is refused on its numbers: nothing is expanded.
    expect(validRanges([[1, LINE_LIMIT]])).toBe(true)
    expect(validRanges([[1, LINE_LIMIT + 1]])).toBe(false)
    expect(validRanges([[1, Number.MAX_SAFE_INTEGER]])).toBe(false)
    expect(expandRanges([[1, Number.MAX_SAFE_INTEGER]], 5)).toBeUndefined()
    expect(
      validRanges([
        [1, LINE_LIMIT - 1],
        [LINE_LIMIT + 5, LINE_LIMIT + 6],
      ]),
    ).toBe(false)
    expect(validRanges(Array.from({ length: RANGE_LIMIT }, (_, index) => [index * 2 + 1, index * 2 + 1] as [number, number]))).toBe(true)
    expect(validRanges(Array.from({ length: RANGE_LIMIT + 1 }, (_, index) => [index * 2 + 1, index * 2 + 1] as [number, number]))).toBe(
      false,
    )
  })

  it("guesses binary as Git's text=auto does", () => {
    const bytes = (text: string) => Buffer.from(text, 'latin1')
    expect(gitGuessesBinary(bytes('plain text\r\nwith both\n'))).toBe(false)
    expect(gitGuessesBinary(bytes('tab\tescape\u001bform\u000cback\u0008\n'))).toBe(false)
    expect(gitGuessesBinary(bytes('a lone\rcarriage return\n'))).toBe(true)
    expect(gitGuessesBinary(bytes('nul\u0000byte'))).toBe(true)
    expect(gitGuessesBinary(bytes(`${'\u0001'.repeat(4)}${'x'.repeat(200)}\n`))).toBe(true)
    expect(gitGuessesBinary(bytes(`\u0001${'x'.repeat(400)}\n`))).toBe(false)
  })
})

describe('staging by line in a real repository', () => {
  it(
    'stages picked lines through the restricted Git: no hook runs, the file is untouched, the audit record comes first',
    SLOW,
    async () => {
      const f = await fixture()
      await f.commit({ 'a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n' })
      const edited = 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\neleven\n'
      await f.write('a.txt', edited)
      const delivery = f.delivery(),
        caller = f.caller()
      await f.unmark()
      const diff = await read(delivery, f.repo, 'unstaged', 'a.txt')
      expect(diff).toMatchObject({ view: 'unstaged', path: 'a.txt', add: 3, del: 2 })
      expect(diff.base.worktree).toMatch(/^[0-9a-f]{64}$/u)
      expect(diff.base.index).toBe(f.git('rev-parse', ':a.txt'))
      expect(changed(diff)).toEqual({ old: [1, 10], new: [1, 10, 11] })
      const result = await delivery.stageLines(caller, 'stage', {
        requestId: randomUUID(),
        path: 'a.txt',
        base: diff.base,
        old: [[1, 1]],
        new: [[1, 1]],
      })
      expect(result).toEqual({ lines: 2 })
      expect(f.staged('a.txt').toString()).toBe('ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n')
      expect(await readFile(join(f.repo, 'a.txt'), 'utf8')).toBe(edited)
      expect(caller.audits).toEqual([
        {
          action: 'git.stage',
          detail: { sessionId: 'session-1', requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u), files: 1, lines: 2, filtered: false },
        },
      ])
      expect(caller.results).toEqual([{ operation: 'stage', outcome: 'done' }])
      expect(f.marked('post-index-change')).toBe(false)
      // What is left unstaged is exactly the other change, and the staged view shows the first.
      const rest = await read(delivery, f.repo, 'unstaged', 'a.txt')
      expect(changed(rest)).toEqual({ old: [10], new: [10, 11] })
      const staged = await read(delivery, f.repo, 'staged', 'a.txt')
      expect(changed(staged)).toEqual({ old: [1], new: [1] })
      // Unstaging the added half alone puts nothing back but takes that line out.
      expect(
        await delivery.stageLines(f.caller(), 'unstage', { requestId: randomUUID(), path: 'a.txt', base: staged.base, new: [[1, 1]] }),
      ).toEqual({ lines: 1 })
      expect(f.staged('a.txt').toString()).toBe('two\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n')
      expect(await readFile(join(f.repo, 'a.txt'), 'utf8')).toBe(edited)
      expect(f.marked('post-index-change')).toBe(false)
    },
  )

  it('writes nothing when the audit record or the caller check fails', SLOW, async () => {
    const f = await fixture()
    await f.commit({ 'a.txt': 'one\n' })
    await f.write('a.txt', 'two\n')
    const delivery = f.delivery()
    const diff = await read(delivery, f.repo, 'unstaged', 'a.txt')
    const before = f.git('rev-parse', ':a.txt')
    const objects = () => f.git('count-objects', '-v')
    const count = objects()
    const body = { path: 'a.txt', base: diff.base, old: each([1]), new: each([1]) }
    const audit = f.caller({
      audit: async () => {
        throw new AppError(503, 'audit-unavailable', '审计没有写入')
      },
    })
    expect((await failure(delivery.stageLines(audit, 'stage', { requestId: randomUUID(), ...body }))).code).toBe('audit-unavailable')
    const denied = f.caller({
      authorize: async () => {
        throw new AppError(409, 'git-turn-running', '运行中')
      },
    })
    expect((await failure(delivery.stageLines(denied, 'stage', { requestId: randomUUID(), ...body }))).code).toBe('git-turn-running')
    expect(denied.audits).toEqual([])
    expect(f.git('rev-parse', ':a.txt')).toBe(before)
    // Not even the blob was written.
    expect(objects()).toBe(count)
  })

  it.each(['audit', 'receipt', 'index read'] as const)('refuses a line write when authority is lost during the $0', SLOW, async gate => {
    const f = await fixture()
    await f.commit({ 'a.txt': 'one\n' })
    await f.write('a.txt', 'two\n')
    const diff = await read(f.delivery(), f.repo, 'unstaged', 'a.txt')
    const input = { requestId: randomUUID(), path: 'a.txt', base: diff.base, old: each([1]), new: each([1]) }
    const before = f.git('rev-parse', ':a.txt')
    const objects = f.git('count-objects', '-v')
    let allowed = true
    const refusal =
      gate === 'index read' ? new AppError(409, 'git-turn-running', '有一轮正在运行') : new AppError(403, 'file-scope', '数据范围已收紧')
    const caller = f.caller({
      authorize: async () => {
        if (!allowed) throw refusal
      },
      audit: async event => {
        caller.audits.push(event)
        if (gate === 'audit') allowed = false
      },
    })
    const receipts: GitDeliveryOptions['receipts'] = {
      git: (...args) => f.store.git(...args),
      async recordGit(sessionId, receipt) {
        await f.store.recordGit(sessionId, receipt)
        if (gate === 'receipt' && receipt.state === 'pending') allowed = false
      },
    }
    const run = GitReader.prototype.run
    let blobWritten = false
    const reader = vi.spyOn(GitReader.prototype, 'run').mockImplementation(async function (this: GitReader, layout, args, options) {
      const result = await run.call(this, layout, args, options)
      if (args.includes('hash-object') && args.includes('-w')) blobWritten = true
      if (gate === 'index read' && blobWritten && args[0] === 'ls-files') allowed = false
      return result
    })
    try {
      await expect(f.delivery({ receipts }).stageLines(caller, 'stage', input)).rejects.toMatchObject({
        status: refusal.status,
        code: refusal.code,
      })
      expect(f.git('rev-parse', ':a.txt')).toBe(before)
      if (gate !== 'index read') expect(f.git('count-objects', '-v')).toBe(objects)
      expect(f.staged('a.txt').toString()).toBe('one\n')
      expect(await readFile(join(f.repo, 'a.txt'), 'utf8')).toBe('two\n')
      expect(caller.audits).toHaveLength(1)
      expect(caller.results).toEqual([{ operation: 'stage', outcome: 'failed', code: 'git-stage-failed' }])
      expect(f.store.git('session-1', 'dev_test', input.requestId)?.state).toBe('failed')
    } finally {
      reader.mockRestore()
    }
    // When authorized again, retrying the same request only returns its recorded result.
    await expect((await f.restarted()).stageLines(f.caller(), 'stage', input)).rejects.toMatchObject({
      code: 'git-stage-failed',
      details: { replay: true },
    })
    expect(f.git('rev-parse', ':a.txt')).toBe(before)
  })

  it('answers 409 with what changed, and never overwrites a file or an index entry it did not read', SLOW, async () => {
    const f = await fixture()
    await f.commit({ 'a.txt': 'one\ntwo\n' })
    await f.write('a.txt', 'ONE\ntwo\nthree\n')
    const delivery = f.delivery()
    const diff = await read(delivery, f.repo, 'unstaged', 'a.txt')
    const body = { path: 'a.txt', base: diff.base, new: each([3]) }
    // The file changed after it was read.
    await f.write('a.txt', 'ONE\ntwo\nthree\nfour\n')
    const worktree = await failure(delivery.stageLines(f.caller(), 'stage', { requestId: randomUUID(), ...body }))
    expect(worktree).toMatchObject({ status: 409, code: 'git-file-changed', details: { changed: 'worktree' } })
    // The index entry changed (someone staged the file in a terminal), the file is as it was read.
    await f.write('a.txt', 'ONE\ntwo\nthree\n')
    const index = f.git('rev-parse', ':a.txt')
    await f.write('other.txt', 'x\n')
    f.git('update-index', '--cacheinfo', `100644,${f.git('hash-object', '-w', 'other.txt')},a.txt`)
    const moved = f.git('rev-parse', ':a.txt')
    expect(moved).not.toBe(index)
    const changedIndex = await failure(delivery.stageLines(f.caller(), 'stage', { requestId: randomUUID(), ...body }))
    expect(changedIndex).toMatchObject({ status: 409, code: 'git-file-changed', details: { changed: 'index' } })
    await f.write('a.txt', 'different\n')
    const both = await failure(delivery.stageLines(f.caller(), 'stage', { requestId: randomUUID(), ...body }))
    expect(both.details).toMatchObject({ changed: 'both' })
    expect(f.git('rev-parse', ':a.txt')).toBe(moved)
    // Unstaging names HEAD's and the index's versions.
    const staged = await read(delivery, f.repo, 'staged', 'a.txt')
    f.git('update-index', '--cacheinfo', `100644,${index},a.txt`)
    const stale = await failure(
      delivery.stageLines(f.caller(), 'unstage', { requestId: randomUUID(), path: 'a.txt', base: staged.base, old: each([1]) }),
    )
    expect(stale).toMatchObject({ status: 409, code: 'git-file-changed', details: { changed: 'index' } })
  })

  it(
    'refuses lines that are not changes of the file as it is, an empty selection, and a reused request with other lines',
    SLOW,
    async () => {
      const f = await fixture()
      await f.commit({ 'a.txt': 'one\ntwo\n' })
      await f.write('a.txt', 'one\nTWO\n')
      const delivery = f.delivery()
      const diff = await read(delivery, f.repo, 'unstaged', 'a.txt')
      const send = (extra: object, requestId = randomUUID()) =>
        failure(delivery.stageLines(f.caller(), 'stage', { requestId, path: 'a.txt', base: diff.base, ...extra }))
      expect(await send({})).toMatchObject({ status: 400, code: 'git-selection-invalid' })
      expect(await send({ new: each([1]) })).toMatchObject({ status: 409, code: 'git-selection-invalid' })
      expect(await send({ old: [[1, 9]] })).toMatchObject({ status: 400, code: 'git-selection-invalid' })
      for (const path of ['../a.txt', '.git/config', 'a\\b', '/etc/passwd'])
        expect(
          (await failure(delivery.stageLines(f.caller(), 'stage', { requestId: randomUUID(), path, base: diff.base, new: each([2]) })))
            .code,
        ).toBe('git-paths-invalid')
      expect(f.git('diff', '--cached', '--name-only')).toBe('')
      // The same request twice at once is one write; with other lines it is refused.
      const requestId = randomUUID()
      const caller = f.caller()
      const input = { requestId, path: 'a.txt', base: diff.base, new: each([2]) }
      const first = delivery.stageLines(caller, 'stage', input)
      expect((await failure(delivery.stageLines(caller, 'stage', { ...input, old: each([2]) }))).code).toBe('request-conflict')
      expect(await Promise.all([first, delivery.stageLines(caller, 'stage', input)])).toEqual([{ lines: 1 }, { lines: 1 }])
      expect(caller.audits).toHaveLength(1)
    },
  )

  it('keeps the result unknown on a timeout; the same request then writes once and is answered from its receipt', SLOW, async () => {
    const f = await fixture()
    await f.commit({ 'a.txt': 'one\ntwo\n' })
    await f.write('a.txt', 'ONE\ntwo\nthree\n')
    const diff = await read(f.delivery(), f.repo, 'unstaged', 'a.txt')
    const input = { requestId: randomUUID(), path: 'a.txt', base: diff.base, old: each([1]), new: each([1]) }
    const slow = f.caller()
    const lost = await failure(f.delivery({ timeouts: { stage: 1 }, git: await slowGit(f.root) }).stageLines(slow, 'stage', input))
    expect(lost).toMatchObject({ status: 504, code: 'git-result-unknown', details: { retry: true } })
    expect(slow.results).toEqual([{ operation: 'stage', outcome: 'unknown' }])
    expect(f.store.git('session-1', 'dev_test', input.requestId)).toMatchObject({
      operation: 'stage',
      state: 'unknown',
      preIndex: diff.base.index,
    })
    // The index still holds what the write would have replaced: it did not land, so the retry runs it, audited again.
    const retry = f.caller()
    expect(await (await f.restarted()).stageLines(retry, 'stage', input)).toEqual({ lines: 2 })
    expect(retry.audits).toHaveLength(1)
    expect(f.staged('a.txt').toString()).toBe('ONE\ntwo\n')
    // Its receipt answers from then on, whatever happens to the file or the index: no Git, no audit.
    f.git('add', 'a.txt')
    await f.write('a.txt', 'something else\n')
    const again = f.caller()
    expect(await (await f.restarted()).stageLines(again, 'stage', input)).toEqual({ lines: 2, replay: true })
    expect(again.audits).toEqual([])
    expect(again.results).toEqual([])
    // The same request for the other operation, or with other lines, is not that request.
    expect((await failure(f.delivery().stageLines(f.caller(), 'unstage', input))).code).toBe('request-conflict')
    expect((await failure(f.delivery().stageLines(f.caller(), 'stage', { ...input, old: [] }))).code).toBe('request-conflict')
  })

  it('finds a write that landed after its end went unrecorded, even once the file has changed', SLOW, async () => {
    const f = await fixture()
    await f.commit({ 'a.txt': 'one\ntwo\n' })
    await f.write('a.txt', 'ONE\ntwo\nthree\n')
    const diff = await read(f.delivery(), f.repo, 'unstaged', 'a.txt')
    const input = { requestId: randomUUID(), path: 'a.txt', base: diff.base, old: each([1]), new: each([1]) }
    // The write lands; the Host stops before it records the end, and the answer never reaches the page.
    await f.delivery({ receipts: f.endsLost() }).stageLines(f.caller(), 'stage', input)
    expect(f.staged('a.txt').toString()).toBe('ONE\ntwo\n')
    expect(f.store.git('session-1', 'dev_test', input.requestId)?.state).toBe('pending')
    const landed = f.git('rev-parse', ':a.txt')
    // The file changes afterwards: the request's versions are gone, and the write still happened.
    await f.write('a.txt', 'ONE\ntwo\nthree\nfour\n')
    const retry = f.caller()
    expect(await (await f.restarted()).stageLines(retry, 'stage', input)).toEqual({ lines: 2, replay: true })
    expect(retry.audits).toEqual([])
    expect(retry.results).toEqual([{ operation: 'stage', outcome: 'done' }])
    expect(f.git('rev-parse', ':a.txt')).toBe(landed)
    // The end is on record now: the next retry is answered without a look at the repository.
    const later = f.caller()
    expect(await (await f.restarted()).stageLines(later, 'stage', input)).toEqual({ lines: 2, replay: true })
    expect(later.results).toEqual([])
  })

  it('never writes twice: a write that landed and was unstaged from another device is answered, not repeated', SLOW, async () => {
    const f = await fixture()
    await f.commit({ 'a.txt': 'one\ntwo\n' })
    await f.write('a.txt', 'ONE\ntwo\nthree\n')
    const delivery = f.delivery()
    const diff = await read(delivery, f.repo, 'unstaged', 'a.txt')
    const input = { requestId: randomUUID(), path: 'a.txt', base: diff.base, old: each([1]), new: each([1]) }
    expect(await delivery.stageLines(f.caller(), 'stage', input)).toEqual({ lines: 2 })
    // Another device takes the same lines back out: the index is again what the request was read against.
    const staged = await read(delivery, f.repo, 'staged', 'a.txt')
    await delivery.stageLines(f.caller({ deviceId: 'dev_other' }), 'unstage', {
      requestId: randomUUID(),
      path: 'a.txt',
      base: staged.base,
      old: each([1]),
      new: each([1]),
    })
    expect(f.git('rev-parse', ':a.txt')).toBe(diff.base.index)
    // The first device's answer was lost and it retries. Everything matches the request, and it must not run again.
    const retry = f.caller()
    expect(await (await f.restarted()).stageLines(retry, 'stage', input)).toEqual({ lines: 2, replay: true })
    expect(retry.audits).toEqual([])
    expect(f.git('rev-parse', ':a.txt')).toBe(diff.base.index)
    expect(f.git('diff', '--cached', '--name-only')).toBe('')
  })

  it('stays unknown while an open receipt and the index cannot tell, and says "not written" only with evidence', SLOW, async () => {
    const f = await fixture()
    await f.commit({ 'a.txt': 'one\ntwo\n', 'b.txt': 'one\ntwo\n' })
    await f.write('a.txt', 'ONE\ntwo\nthree\n')
    await f.write('b.txt', 'ONE\ntwo\nthree\n')
    const first = await read(f.delivery(), f.repo, 'unstaged', 'a.txt')
    const landed = { requestId: randomUUID(), path: 'a.txt', base: first.base, old: each([1]), new: each([1]) }
    await f.delivery({ receipts: f.endsLost() }).stageLines(f.caller(), 'stage', landed)
    // It landed, and then the whole file was staged in a terminal: the index is neither side of the write.
    f.git('add', 'a.txt')
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = f.caller()
      const answer = await failure((await f.restarted()).stageLines(retry, 'stage', landed))
      expect(answer).toMatchObject({ status: 504, code: 'git-result-unknown' })
      expect(retry.audits).toEqual([])
    }
    expect(f.store.git('session-1', 'dev_test', landed.requestId)?.state).toBe('pending')
    // An attempt that timed out before it wrote: the index still holds the entry it would have replaced.
    const second = await read(f.delivery(), f.repo, 'unstaged', 'b.txt')
    const unwritten = { requestId: randomUUID(), path: 'b.txt', base: second.base, old: each([1]), new: each([1]) }
    const timedOut = f.delivery({ timeouts: { stage: 1 }, git: await slowGit(f.root) })
    expect((await failure(timedOut.stageLines(f.caller(), 'stage', unwritten))).code).toBe('git-result-unknown')
    await f.write('b.txt', 'ONE\ntwo\nthree\nfour\n')
    // Now the Host knows it wrote nothing, and may say the file changed; the receipt keeps that answer.
    const told = await failure((await f.restarted()).stageLines(f.caller(), 'stage', unwritten))
    expect(told).toMatchObject({ status: 409, code: 'git-file-changed', details: { changed: 'worktree' } })
    const replayed = await failure((await f.restarted()).stageLines(f.caller(), 'stage', unwritten))
    expect(replayed).toMatchObject({ status: 409, code: 'git-file-changed', details: { replay: true } })
    expect(f.git('rev-parse', ':b.txt')).toBe(second.base.index)
  })

  it('reads the file again after the audit record, and ends every audited write with its result', SLOW, async () => {
    const f = await fixture()
    await f.commit({ 'a.txt': 'one\ntwo\n' })
    await f.write('a.txt', 'ONE\ntwo\nthree\n')
    const delivery = f.delivery()
    const diff = await read(delivery, f.repo, 'unstaged', 'a.txt')
    const body = { path: 'a.txt', base: diff.base, new: each([3]) }
    const before = f.git('rev-parse', ':a.txt')
    // The file changes while the audit record is being written.
    const edited = f.caller({
      audit: async event => {
        edited.audits.push(event)
        await f.write('a.txt', 'ONE\ntwo\nthree\nfour\n')
      },
    })
    const first = { requestId: randomUUID(), ...body }
    expect(await failure(delivery.stageLines(edited, 'stage', first))).toMatchObject({
      code: 'git-file-changed',
      details: { changed: 'worktree' },
    })
    expect(edited.audits).toHaveLength(1)
    expect(edited.results).toEqual([{ operation: 'stage', outcome: 'failed', code: 'git-file-changed' }])
    expect(f.git('rev-parse', ':a.txt')).toBe(before)
    // Nothing started, so there is no receipt: the same request is judged afresh.
    expect(f.store.git('session-1', 'dev_test', first.requestId)).toBeUndefined()
    // The index entry changes while the audit record is being written.
    await f.write('a.txt', 'ONE\ntwo\nthree\n')
    const moved = f.caller({
      audit: async event => {
        moved.audits.push(event)
        f.git('add', 'a.txt')
      },
    })
    expect(await failure(delivery.stageLines(moved, 'stage', { requestId: randomUUID(), ...body }))).toMatchObject({
      code: 'git-file-changed',
      details: { changed: 'index' },
    })
    expect(moved.results).toEqual([{ operation: 'stage', outcome: 'failed', code: 'git-file-changed' }])
    // A receipt that cannot be saved: nothing runs, and the audited write is closed as failed.
    f.git('reset', '-q')
    const unsaved = f.caller()
    const refusing: GitDeliveryOptions['receipts'] = {
      git: () => undefined,
      recordGit: async () => {
        throw new Error('disk full')
      },
    }
    expect(
      (await failure(f.delivery({ receipts: refusing }).stageLines(unsaved, 'stage', { requestId: randomUUID(), ...body }))).code,
    ).toBe('git-receipt-unsaved')
    expect(unsaved.results).toEqual([{ operation: 'stage', outcome: 'failed', code: 'git-stage-failed' }])
    expect(f.git('diff', '--cached', '--name-only')).toBe('')
  })

  it('replaces the index entry only when Git names the blob as built and the entry is still the one read', SLOW, async () => {
    const f = await fixture()
    await f.commit({ 'a.txt': 'one\n' })
    const authorize = async () => {}
    const git = new GitReader({ binary: findGit()!, home: f.home })
    const layout = (await readGitLayout(f.repo))!
    const before = f.git('rev-parse', ':a.txt')
    const content = 'two\n'
    await writeFile(join(f.root, 'content'), content)
    const built = f.git('hash-object', join(f.root, 'content'))
    await f.unmark()
    // The Host computed another ID than Git gives the content: nothing enters the index.
    await expect(
      setIndexBlob(git, layout, { path: 'a.txt', mode: '100644', oid: before }, before, content, 10_000, authorize),
    ).rejects.toBeInstanceOf(GitError)
    expect(f.git('rev-parse', ':a.txt')).toBe(before)
    // The entry is not the one the write was planned against (the last look, right before `update-index`).
    await expect(
      setIndexBlob(git, layout, { path: 'a.txt', mode: '100644', oid: built }, built, content, 10_000, authorize),
    ).rejects.toBeInstanceOf(IndexMovedError)
    await expect(
      setIndexBlob(git, layout, { path: 'a.txt', mode: '100755', oid: built }, before, content, 10_000, authorize),
    ).rejects.toBeInstanceOf(IndexMovedError)
    expect(f.git('rev-parse', ':a.txt')).toBe(before)
    await setIndexBlob(git, layout, { path: 'a.txt', mode: '100644', oid: built }, before, content, 10_000, authorize)
    expect(f.staged('a.txt').toString()).toBe(content)
    expect(f.marked('post-index-change')).toBe(false)
  })

  it('reads a path literally: a glob or pathspec magic in a name reaches no other file', SLOW, async () => {
    const f = await fixture()
    await f.commit({ 'a.txt': 'one\n', '*.txt': 'star\n', 'b.txt': 'one\n' })
    await f.write('a.txt', 'one\ntwo\n')
    await f.write('b.txt', 'one\ntwo\n')
    await f.write('*.txt', 'star\nmore\n')
    const delivery = f.delivery()
    const star = await read(delivery, f.repo, 'unstaged', '*.txt')
    expect(star.hunks!.flatMap(hunk => hunk.lines).map(line => line.text)).toEqual(['star', 'more'])
    expect(star.base.index).toBe(f.git('rev-parse', ':*.txt'))
    await delivery.stageLines(f.caller(), 'stage', { requestId: randomUUID(), path: '*.txt', base: star.base, new: each([2]) })
    expect(f.git('diff', '--cached', '--name-only')).toBe('*.txt')
    // Pathspec magic is a file name here, and there is no such file.
    for (const path of [':(glob)*.txt', ':(top)a.txt', ':/a.txt', ':!b.txt']) {
      const diff = await delivery.hunkDiff(f.repo, 'unstaged', path)
      expect(diff, path).toEqual({ view: 'unstaged', path, whole: 'new' })
      expect(
        (await failure(delivery.stageLines(f.caller(), 'stage', { requestId: randomUUID(), path, base: {}, new: each([1]) }))).code,
      ).toBe('git-file-whole')
    }
    expect(f.git('diff', '--cached', '--name-only')).toBe('*.txt')
    // History reads take the path the same way.
    expect((await delivery.history(f.repo, { path: '*.txt' })).commits).toHaveLength(1)
    expect((await delivery.history(f.repo, { path: ':(glob)*.txt' })).commits).toEqual([])
  })

  it('never reads through a link: a folder swapped for one reads as no file, and a file is read up to the limit', SLOW, async () => {
    const f = await fixture()
    await f.commit({ 'plain.txt': 'one\n' })
    await mkdir(join(f.repo, 'dir'))
    await f.commit({ 'dir/f.txt': 'one\n' })
    // The folder becomes a link to one outside the repository that holds a file of the same name.
    const outside = join(f.root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'f.txt'), 'outside secret\n')
    await rm(join(f.repo, 'dir'), { recursive: true })
    await symlink(outside, join(f.repo, 'dir'))
    const delivery = f.delivery()
    expect(await failure(delivery.hunkDiff(f.repo, 'unstaged', 'dir/f.txt'))).toMatchObject({ status: 400, code: 'git-paths-invalid' })
    const refused = await failure(
      delivery.stageLines(f.caller(), 'stage', { requestId: randomUUID(), path: 'dir/f.txt', base: {}, new: each([1]) }),
    )
    expect(refused).toMatchObject({ status: 400, code: 'git-paths-invalid' })
    // Were the folder swapped after that check, the read itself still finds no file there.
    expect(await readWorktreeFile(f.repo, 'dir/f.txt')).toBeUndefined()
    expect(f.git('rev-parse', ':dir/f.txt')).toBe(f.git('rev-parse', 'HEAD:dir/f.txt'))
    // The repository reached through a link is still the repository.
    const alias = join(f.root, 'alias')
    await symlink(f.repo, alias)
    expect((await readWorktreeFile(alias, 'plain.txt'))?.bytes?.toString()).toBe('one\n')
    // One byte over the limit is not read into the answer.
    await f.write('plain.txt', 'x'.repeat(1024 * 1024))
    expect((await readWorktreeFile(f.repo, 'plain.txt'))?.bytes).toHaveLength(1024 * 1024)
    await f.write('plain.txt', 'x'.repeat(1024 * 1024 + 1))
    expect(await readWorktreeFile(f.repo, 'plain.txt')).toEqual({ mode: '100644' })
  })

  it('stages CRLF files byte for byte, and as LF where Git converts them', SLOW, async () => {
    const f = await fixture()
    await f.commit({ 'crlf.txt': 'one\r\ntwo\r\n', 'auto.txt': 'one\ntwo\n', 'mixed.txt': 'one\ntwo\n' })
    const delivery = f.delivery()
    await f.write('crlf.txt', 'one\r\nTWO\r\nthree\r\n')
    let diff = await read(delivery, f.repo, 'unstaged', 'crlf.txt')
    expect(diff.hunks!.flatMap(hunk => hunk.lines).map(line => line.text)).toEqual(['one', 'two', 'TWO', 'three'])
    await delivery.stageLines(f.caller(), 'stage', { requestId: randomUUID(), path: 'crlf.txt', base: diff.base, new: each([3]) })
    expect(f.staged('crlf.txt').toString()).toBe('one\r\ntwo\r\nthree\r\n')
    // With core.autocrlf the work tree has CRLF and the index LF: only the real change shows, and it is staged as LF.
    f.git('config', 'core.autocrlf', 'true')
    await f.write('auto.txt', 'one\r\nTWO\r\nthree\r\n')
    diff = await read(delivery, f.repo, 'unstaged', 'auto.txt')
    expect(changed(diff)).toEqual({ old: [2], new: [2, 3] })
    await delivery.stageLines(f.caller(), 'stage', { requestId: randomUUID(), path: 'auto.txt', base: diff.base, new: each([3]) })
    expect(f.staged('auto.txt').toString()).toBe('one\ntwo\nthree\n')
    // Line endings Git's conversion would not treat uniformly: whole or not at all.
    await f.write('mixed.txt', 'one\r\ntwo\rTWO\n')
    diff = await read(delivery, f.repo, 'unstaged', 'mixed.txt')
    // Under Git's guess (core.autocrlf) a lone CR makes the file binary; with `text` set it is converted regardless.
    expect(diff).toMatchObject({ whole: 'binary' })
    expect(diff.hunks).toBeUndefined()
    await f.write('.gitattributes', 'mixed.txt text\n')
    expect((await delivery.hunkDiff(f.repo, 'unstaged', 'mixed.txt')).whole).toBe('converted')
  })

  it('never runs a filter: a filtered file is whole, another file of the same repository is staged by line', SLOW, async () => {
    const f = await fixture()
    await f.commit({ 'plain.txt': 'one\n', 'big.bin': 'one\n', '.gitattributes': '*.bin filter=mark\n' })
    f.git('config', 'filter.mark.clean', `sh -c 'echo ran >> "${join(f.marks, 'clean')}"; cat'`)
    f.git('config', 'filter.mark.smudge', `sh -c 'echo ran >> "${join(f.marks, 'smudge')}"; cat'`)
    await f.write('plain.txt', 'one\ntwo\n')
    await f.write('big.bin', 'one\ntwo\n')
    const delivery = f.delivery()
    const filtered = await read(delivery, f.repo, 'unstaged', 'big.bin')
    expect(filtered).toMatchObject({ whole: 'filtered' })
    const refused = await failure(
      delivery.stageLines(f.caller(), 'stage', { requestId: randomUUID(), path: 'big.bin', base: filtered.base, new: each([2]) }),
    )
    expect(refused).toMatchObject({ status: 409, code: 'git-file-whole', details: { whole: 'filtered' } })
    const plain = await read(delivery, f.repo, 'unstaged', 'plain.txt')
    const caller = f.caller()
    await delivery.stageLines(caller, 'stage', { requestId: randomUUID(), path: 'plain.txt', base: plain.base, new: each([2]) })
    expect(f.staged('plain.txt').toString()).toBe('one\ntwo\n')
    expect(caller.audits[0]?.detail).toMatchObject({ filtered: false, lines: 1 })
    expect(f.marked('clean')).toBe(false)
    expect(f.marked('smudge')).toBe(false)
    // The attribute may come from a folder's own .gitattributes or from the repository's info/attributes.
    await mkdir(join(f.repo, 'sub'))
    await f.commit({
      'sub/data.txt': 'one\n',
      'sub/.gitattributes': 'data.txt filter=mark\n',
      'local.txt': 'one\n',
      'sub/free.txt': 'one\n',
    })
    await mkdir(join(f.repo, '.git', 'info'), { recursive: true })
    await writeFile(join(f.repo, '.git', 'info', 'attributes'), 'local.txt filter=mark\n')
    for (const path of ['sub/data.txt', 'local.txt', 'sub/free.txt']) await f.write(path, 'one\ntwo\n')
    await f.unmark()
    expect((await delivery.hunkDiff(f.repo, 'unstaged', 'sub/data.txt')).whole).toBe('filtered')
    expect((await delivery.hunkDiff(f.repo, 'unstaged', 'local.txt')).whole).toBe('filtered')
    expect((await delivery.hunkDiff(f.repo, 'unstaged', 'sub/free.txt')).whole).toBeUndefined()
    expect(f.marked('clean')).toBe(false)
  })

  it('says which files are whole: binary, large, new, deleted, renamed, mode, link, submodule, conflicted, secret', SLOW, async () => {
    const f = await fixture()
    await f.commit({
      'bin.dat': Buffer.from([0, 1, 2, 3]),
      'large.txt': 'x\n',
      'gone.txt': 'one\n',
      'old-name.txt': 'same\n',
      'mode.sh': 'echo\n',
      'link.txt': 'one\n',
      '.env': 'A=1\n',
      'same.txt': 'one\n',
    })
    await f.write('bin.dat', Buffer.from([0, 9, 9, 9]))
    await f.write('large.txt', `${'y'.repeat(1024 * 1024)}\n`)
    await rm(join(f.repo, 'gone.txt'))
    f.git('mv', 'old-name.txt', 'new-name.txt')
    await chmod(join(f.repo, 'mode.sh'), 0o755)
    await f.write('mode.sh', 'echo hi\n')
    await rm(join(f.repo, 'link.txt'))
    await symlink('same.txt', join(f.repo, 'link.txt'))
    await f.write('.env', 'A=2\n')
    await f.write('fresh.txt', 'new\n')
    f.git('update-index', '--add', '--cacheinfo', `160000,${f.git('rev-parse', 'HEAD')},sub`)
    const delivery = f.delivery()
    const whole = async (path: string, view: 'unstaged' | 'staged' = 'unstaged') => {
      const diff = await delivery.hunkDiff(f.repo, view, path)
      expect(diff.hunks).toBeUndefined()
      // Nothing of a whole file's content leaves, not even its hash.
      expect(Object.keys(diff).toSorted()).toEqual(['path', 'view', 'whole'])
      return diff.whole
    }
    expect(await whole('bin.dat')).toBe('binary')
    expect(await whole('large.txt')).toBe('large')
    expect(await whole('gone.txt')).toBe('deleted')
    expect(await whole('fresh.txt')).toBe('new')
    expect(await whole('mode.sh')).toBe('mode')
    expect(await whole('link.txt')).toBe('link')
    expect(await whole('.env')).toBe('secret')
    expect(await whole('same.txt')).toBe('unchanged')
    expect(await whole('sub')).toBe('submodule')
    // A rename is a deletion and a new file: each side is whole.
    expect(await whole('old-name.txt', 'staged')).toBe('deleted')
    expect(await whole('new-name.txt', 'staged')).toBe('new')
    for (const path of ['bin.dat', 'gone.txt', 'fresh.txt', 'mode.sh', '.env']) {
      const diff = await read(delivery, f.repo, 'unstaged', path)
      const refused = await failure(
        delivery.stageLines(f.caller(), 'stage', { requestId: randomUUID(), path, base: diff.base, new: each([1]) }),
      )
      expect(refused, path).toMatchObject({ status: 409, code: 'git-file-whole' })
    }
    // Promised with `git add -N`: nothing is staged yet, so there are no lines to tell apart.
    await f.write('promised.txt', 'one\ntwo\n')
    f.git('add', '-N', 'promised.txt')
    expect(await whole('promised.txt')).toBe('new')
    // More lines than a page shows with the whole file as context.
    await f.write('same.txt', 'line\n'.repeat(20_001))
    expect(await whole('same.txt')).toBe('large')
    await f.write('same.txt', 'one\n')
    // Without core.fileMode the executable bit is not a change: the lines can be picked, and the index keeps its mode.
    f.git('config', 'core.fileMode', 'false')
    const moded = await read(delivery, f.repo, 'unstaged', 'mode.sh')
    expect(moded.whole).toBeUndefined()
    await delivery.stageLines(f.caller(), 'stage', {
      requestId: randomUUID(),
      path: 'mode.sh',
      base: moded.base,
      old: each([1]),
      new: each([1]),
    })
    expect(f.git('ls-files', '-s', 'mode.sh')).toMatch(/^100644 /u)
    f.git('config', 'core.fileMode', 'true')
    // Content Git's own guess takes for binary under text=auto is stored as it is: whole.
    await f.write('.gitattributes', '* text=auto\n')
    await f.write('gone.txt', `${'\u0001'.repeat(8)}text\r\nmore\r\n`)
    expect(await whole('gone.txt')).toBe('binary')
    await rm(join(f.repo, '.gitattributes'))
    // A conflicted file, from a merge that stopped.
    f.git('reset', '-q', '--hard')
    f.git('checkout', '-q', '-b', 'side')
    await f.commit({ 'same.txt': 'side\n' })
    f.git('checkout', '-q', 'main')
    await f.commit({ 'same.txt': 'main\n' })
    expect(() => f.git('merge', 'side')).toThrow()
    expect(await whole('same.txt')).toBe('conflicted')
    const conflicted = await failure(
      delivery.stageLines(f.caller(), 'stage', { requestId: randomUUID(), path: 'same.txt', base: {}, new: each([1]) }),
    )
    // A repository in the middle of a merge takes no delivery write at all.
    expect(conflicted.code).toBe('git-operation-in-progress')
  })
})

describe('history views', () => {
  it("lists the branch's commits, a file's history, a commit's files and the comparison with main, bounded", SLOW, async () => {
    const f = await fixture()
    await f.commit({ 'a.txt': 'one\n', 'keep.txt': 'k\n' }, 'base commit')
    f.git('checkout', '-q', '-b', 'feature')
    await f.commit({ 'a.txt': 'one\ntwo\n' }, 'add two')
    await f.commit({ 'b.txt': 'b\n', '.env': 'TOKEN=1\n', 'bin.dat': Buffer.from([0, 1]) }, 'add b sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    await f.commit({ 'a.txt': 'one\ntwo\nthree\n' }, 'add three')
    const delivery = f.delivery()
    await f.unmark()
    const history = await delivery.history(f.repo)
    expect(history).toMatchObject({ range: 'base', base: 'main', head: f.git('rev-parse', 'HEAD') })
    expect(history.commits.map(commit => commit.subject)).toEqual(['add three', expect.stringMatching(/^add b /u), 'add two'])
    expect(JSON.stringify(history)).not.toContain('sk-ant-AAAA')
    expect(history.commits[0]).toMatchObject({ author: 'Tester', sha: f.git('rev-parse', 'HEAD') })
    // One file's history follows HEAD's line past the base.
    const file = await delivery.history(f.repo, { path: 'a.txt' })
    expect(file.range).toBe('file')
    expect(file.commits.map(commit => commit.subject)).toEqual(['add three', 'add two', 'base commit'])
    // A commit against its first parent.
    const middle = history.commits[1]!.sha
    const commit = await delivery.treeDiff(f.repo, { sha: middle })
    expect(commit.parent).toBe(history.commits[2]!.sha)
    expect(commit.files).toEqual([
      { path: '.env', status: 'A' },
      { path: 'b.txt', status: 'A', add: 1, del: 0 },
      { path: 'bin.dat', status: 'A', binary: true },
    ])
    expect(commit.totals.files).toBe(3)
    const shown = await delivery.treeFile(f.repo, { sha: history.commits[0]!.sha, path: 'a.txt' })
    expect(shown.file).toEqual({ path: 'a.txt', status: 'M', add: 1, del: 0 })
    expect(shown.hunks!.flatMap(hunk => hunk.lines).map(line => `${line.kind}:${line.text}`)).toEqual([
      'context:one',
      'context:two',
      'add:three',
    ])
    expect(await delivery.treeFile(f.repo, { sha: middle, path: '.env' })).toMatchObject({ hidden: 'secret' })
    expect((await delivery.treeFile(f.repo, { sha: middle, path: '.env' })).hunks).toBeUndefined()
    expect(await delivery.treeFile(f.repo, { sha: middle, path: 'bin.dat' })).toMatchObject({ hidden: 'binary' })
    expect(Object.keys(commit).toSorted()).toEqual(['files', 'parent', 'sha', 'totals'])
    // A file with more lines than the whole-file context holds is not shown, like one over the size limit.
    await f.commit({ 'long.txt': 'line\n'.repeat(20_001) }, 'long')
    const long = await delivery.treeFile(f.repo, { sha: f.git('rev-parse', 'HEAD'), path: 'long.txt' })
    expect(long).toMatchObject({ hidden: 'large' })
    expect(long.hunks).toBeUndefined()
    f.git('reset', '-q', '--hard', 'HEAD^')
    await f.unmark()
    // The branch against where it left main: committed files only.
    await f.write('a.txt', 'uncommitted\n')
    const compare = await delivery.treeDiff(f.repo)
    expect(compare).toMatchObject({ base: 'main', sha: f.git('rev-parse', 'HEAD'), parent: f.git('rev-parse', 'main') })
    expect(compare.files!.map(entry => entry.path)).toEqual(['.env', 'a.txt', 'b.txt', 'bin.dat'])
    const compared = await delivery.treeFile(f.repo, { path: 'a.txt' })
    expect(compared.file).toMatchObject({ add: 2, del: 0 })
    // No hook ran for any of it.
    expect(f.marked('post-index-change')).toBe(false)
    // Only commits HEAD reaches, and only files they changed.
    f.git('checkout', '-q', '--', 'a.txt')
    f.git('checkout', '-q', '-b', 'elsewhere', 'main')
    await f.commit({ 'c.txt': 'c\n' }, 'elsewhere')
    const stray = f.git('rev-parse', 'HEAD')
    f.git('checkout', '-q', 'feature')
    for (const base of [stray, 'elsewhere']) {
      expect(await delivery.treeDiff(f.repo, { base })).toMatchObject({ parent: stray, sha: f.git('rev-parse', 'HEAD') })
      expect(await delivery.treeFile(f.repo, { base, path: 'c.txt' })).toMatchObject({ file: { status: 'D' } })
    }
    for (const base of ['HEAD~1', 'main^{tree}', '--all']) {
      expect(await failure(delivery.treeDiff(f.repo, { base }))).toMatchObject({ code: 'git-compare-base' })
    }
    f.git('branch', '-D', 'elsewhere')
    expect(await failure(delivery.treeDiff(f.repo, { base: stray }))).toMatchObject({ code: 'git-compare-base' })
    f.git('update-ref', 'refs/remotes/origin/review', stray)
    expect(await delivery.treeDiff(f.repo, { base: 'origin/review' })).toMatchObject({ base: 'origin/review', parent: stray })
    expect(await delivery.treeDiff(f.repo, { base: stray })).toMatchObject({ parent: stray })
    expect(await failure(delivery.treeDiff(f.repo, { sha: stray }))).toMatchObject({
      status: 404,
      code: 'git-commit-not-found',
    })
    expect((await failure(delivery.treeFile(f.repo, { sha: middle, path: 'a.txt' }))).code).toBe('git-commit-not-found')
    expect((await failure(delivery.treeFile(f.repo, { sha: middle, path: '../x' }))).code).toBe('git-paths-invalid')
    f.git('checkout', '-q', 'main')
    expect(await failure(delivery.treeDiff(f.repo))).toMatchObject({ status: 409, code: 'git-no-base' })
  })

  it('stops at 50 commits and says there are more', SLOW, async () => {
    const f = await fixture()
    await f.commit({ 'a.txt': '0\n' }, 'first')
    for (let index = 1; index <= 52; index++) {
      await f.write('a.txt', `${index}\n`)
      f.git('commit', '-q', '-am', `change ${index}`)
    }
    const history = await f.delivery().history(f.repo)
    expect(history).toMatchObject({ range: 'recent', more: true })
    expect(history.commits).toHaveLength(50)
    expect(history.commits[0]?.subject).toBe('change 52')
  })
})
