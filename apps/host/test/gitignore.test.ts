import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ignoreVerdict, isGitignored, matchBudget, parseGitignore, readIgnoreRules, type IgnoreRules } from '../src/files/gitignore.ts'
import { grepFiles } from '../src/files/grep.ts'
import { ProtectedPaths } from '../src/files/resolve.ts'
import { FileSearchIndex, searchFiles } from '../src/files/search.ts'

const rules = (text: string, base = '', parent?: IgnoreRules): IgnoreRules => ({
  base,
  patterns: parseGitignore(text),
  ...(parent ? { parent } : {}),
})

describe('gitignore matching', () => {
  it.each([
    ['target/', 'target', true, true],
    ['target/', 'target', false, false],
    ['target/', 'a/target', true, true],
    ['/target', 'a/target', true, false],
    ['/target', 'target', false, true],
    ['a/b', 'a/b', false, true],
    ['a/b', 'x/a/b', false, false],
    ['*.log', 'x/y/z.log', false, true],
    ['*.log', 'z.logs', false, false],
    ['file?.txt', 'file1.txt', false, true],
    ['file?.txt', 'file10.txt', false, false],
    ['[a-c]x', 'bx', false, true],
    ['[a-c]x', 'dx', false, false],
    ['[!a-c]x', 'dx', false, true],
    ['[unclosed', '[unclosed', false, true],
    ['**/logs', 'a/b/logs', true, true],
    ['**/logs', 'logs', true, true],
    ['logs/**', 'logs', true, false],
    ['logs/**', 'logs/a/b', false, true],
    ['a/**/b', 'a/b', false, true],
    ['a/**/b', 'a/x/y/b', false, true],
    ['a/*', 'a/b/c', false, false],
    ['\\#name', '#name', false, true],
    ['\\!name', '!name', false, true],
    ['# comment', '# comment', false, false],
    ['trailing   ', 'trailing', false, true],
    ['with\\ ', 'with ', false, true],
    ['*a*b*c*', 'xaxbxcx', false, true],
  ])('%s against %s (directory %s) is %s', (pattern, path, directory, expected) => {
    expect(isGitignored(rules(pattern), path, directory)).toBe(expected)
  })

  it('lets the last line and then the deepest file decide', () => {
    expect(isGitignored(rules('*.log\n!keep.log'), 'keep.log', false)).toBe(false)
    expect(isGitignored(rules('!keep.log\n*.log'), 'keep.log', false)).toBe(true)
    const top = rules('local.ts')
    expect(isGitignored(rules('!local.ts', 'app', top), 'app/local.ts', false)).toBe(false)
    expect(isGitignored(rules('other', 'app', top), 'app/local.ts', false)).toBe(true)
    expect(isGitignored(rules('/x.ts', 'app'), 'app/x.ts', false)).toBe(true)
    expect(isGitignored(rules('/x.ts', 'app'), 'app/deep/x.ts', false)).toBe(false)
  })

  it('stays linear on a pathological pattern and caps what it keeps', () => {
    const started = performance.now()
    expect(isGitignored(rules(`${'*a'.repeat(200)}b`), 'a'.repeat(255), false)).toBe(false)
    expect(performance.now() - started).toBeLessThan(200)
    expect(parseGitignore('x\n'.repeat(5000))).toHaveLength(1000)
    expect(parseGitignore(`${'y'.repeat(2000)}\nz`)).toHaveLength(1)
  })

  it('does not follow a symlinked .gitignore and reads only up to the cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-gitignore-'))
    try {
      expect(await readIgnoreRules(directory, '', undefined)).toBeUndefined()
      await writeFile(join(directory, 'elsewhere'), 'secret-pattern\n')
      await symlink(join(directory, 'elsewhere'), join(directory, '.gitignore'))
      expect(await readIgnoreRules(directory, '', undefined)).toBeUndefined()
      await rm(join(directory, '.gitignore'))
      await writeFile(join(directory, '.gitignore'), `first\n${'#'.repeat(70 * 1024)}\nlast\n`)
      const read = await readIgnoreRules(directory, '', undefined)
      expect(ignoreVerdict(read, 'first', false)).toBe('ignored')
      // Read only in part: what the unread lines would say is unknown, so an unmatched name is undecided, not kept.
      expect(ignoreVerdict(read, 'last', false)).toBe('undecided')
      expect(isGitignored(read, 'last', false)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('gitignore rules from the repository, bounded', () => {
  it('keeps ordinary rules exactly: negation, anchoring, directory-only, ** and levels', () => {
    const top = rules('*.log\n!keep.log\n/build\ncache/\ndocs/**/*.tmp\n**/secret-dir')
    expect(ignoreVerdict(top, 'a/b/x.log', false)).toBe('ignored')
    expect(ignoreVerdict(top, 'keep.log', false)).toBe('kept')
    expect(ignoreVerdict(top, 'build', true)).toBe('ignored')
    expect(ignoreVerdict(top, 'src/build', true)).toBe('kept')
    expect(ignoreVerdict(top, 'cache', true)).toBe('ignored')
    expect(ignoreVerdict(top, 'cache', false)).toBe('kept')
    expect(ignoreVerdict(top, 'docs/a/b/c.tmp', false)).toBe('ignored')
    expect(ignoreVerdict(top, 'docs/c.tmp', false)).toBe('ignored')
    expect(ignoreVerdict(top, 'x/y/secret-dir', true)).toBe('ignored')
    const nested = rules('!x.log', 'app', top)
    expect(ignoreVerdict(nested, 'app/x.log', false)).toBe('kept')
    expect(ignoreVerdict(nested, 'app/y.log', false)).toBe('ignored')
  })

  it('stops a costly check at its budget and calls the entry undecided, which counts as ignored', () => {
    const heavy = rules(`${'*'.concat('a'.repeat(62), 'b')}\n`.repeat(1000))
    const budget = matchBudget()
    const started = performance.now()
    expect(ignoreVerdict(heavy, 'a'.repeat(255), false, budget)).toBe('undecided')
    expect(performance.now() - started).toBeLessThan(50)
    expect(isGitignored(heavy, 'a'.repeat(255), false, budget)).toBe(true)
    // A spent walk budget decides nothing more, cheaply.
    budget.walk = 0
    expect(ignoreVerdict(rules('*.log'), 'x.txt', false, budget)).toBe('undecided')
    // Past the deadline, likewise.
    expect(ignoreVerdict(heavy, 'a'.repeat(10), false, matchBudget(performance.now() - 1))).toBe('undecided')
  })

  it('leaves out over-long and over-complex patterns, and marks the file as not kept whole', () => {
    expect(parseGitignore(`${'a/'.repeat(40)}b\nz`)).toHaveLength(1)
    expect(parseGitignore('**/a/**/b/**/c/**/d/**/e\nz')).toHaveLength(1)
  })
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

/** Runs `work` with a 10 ms timer on the event loop and reports the longest gap between its ticks. */
async function longestGap(work: () => Promise<unknown>) {
  let last = performance.now(),
    gap = 0
  const timer = setInterval(() => {
    const now = performance.now()
    gap = Math.max(gap, now - last)
    last = now
  }, 10)
  const started = performance.now()
  try {
    await work()
  } finally {
    clearInterval(timer)
  }
  gap = Math.max(gap, performance.now() - last)
  return { gap, ms: performance.now() - started }
}

/** The reviewer's shapes of a crafted repository. */
async function crafted(shape: 'root' | 'globstar' | 'chain') {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'latch-ignore-')))
  cleanups.push(() => rm(parent, { recursive: true, force: true }))
  const root = join(parent, 'repo')
  await mkdir(join(root, '.git'), { recursive: true })
  if (shape === 'root') {
    await writeFile(join(root, '.gitignore'), `${'*'.concat('a'.repeat(62), 'b')}\n`.repeat(1000))
    for (let index = 0; index < 64; index++) await writeFile(join(root, `${'a'.repeat(250)}${String(index).padStart(3, '0')}`), 'needle\n')
  } else if (shape === 'globstar') {
    let at = root
    for (let level = 0; level < 4; level++) {
      await writeFile(join(at, '.gitignore'), `**/${'*a'.repeat(28)}b\n`.repeat(1000))
      at = join(at, `${String(level)}${'a'.repeat(219)}`)
      await mkdir(at)
    }
    for (let index = 0; index < 40; index++) await writeFile(join(at, `${'a'.repeat(30)}${index}`), 'needle\n')
  } else {
    let at = root
    for (let level = 0; level < 30; level++) {
      await writeFile(join(at, '.gitignore'), `${'*a'.repeat(30)}b\n`.repeat(900))
      at = join(at, `${String(level).padStart(2, '0')}${'a'.repeat(26)}`)
      await mkdir(at)
      for (let index = 0; index < 4; index++) await writeFile(join(at, `${'a'.repeat(26)}${index}`), 'needle\n')
    }
  }
  return { id: 'default', path: root }
}

describe.each(['root', 'globstar', 'chain'] as const)('a crafted repository (%s) never holds the event loop', shape => {
  const guard = new ProtectedPaths([])
  it('content search', async () => {
    const root = await crafted(shape)
    const { gap, ms } = await longestGap(() =>
      grepFiles(
        [root],
        guard,
        { q: 'needle', caseSensitive: false, wholeWord: false },
        () => false,
        () => {},
      ),
    )
    expect(gap).toBeLessThan(100)
    expect(ms).toBeLessThan(3500)
  })
  it('name search, fresh and through the index', async () => {
    const root = await crafted(shape)
    const fresh = await longestGap(() => searchFiles([root], guard, 'aaa', 50, () => false))
    expect(fresh.gap).toBeLessThan(100)
    expect(fresh.ms).toBeLessThan(4500)
    const index = new FileSearchIndex()
    cleanups.push(() => index.close())
    const indexed = await longestGap(() => index.search([root], guard, 'identity', 'aaa', 50, () => false))
    expect(indexed.gap).toBeLessThan(100)
    expect(indexed.ms).toBeLessThan(4500)
  })
})
