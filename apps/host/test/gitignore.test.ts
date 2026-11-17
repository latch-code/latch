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

  it('parses in one pass: an unclosed [ is a literal, a set over the cap leaves its line out', () => {
    const started = performance.now()
    expect(parseGitignore(`${'['.repeat(1023)}\n`.repeat(63))).toHaveLength(63)
    expect(parseGitignore(`${'[a'.repeat(511)}\n`.repeat(64))).toHaveLength(64)
    expect(performance.now() - started).toBeLessThan(50)
    expect(isGitignored(rules('[[a'), '[[a', false)).toBe(true)
    expect(isGitignored(rules('x[ab'), 'x[ab', false)).toBe(true)
    const wide = rules(`*[${'b'.repeat(1021)}]\nkeep`)
    expect(wide.patterns).toHaveLength(1)
    expect(ignoreVerdict({ ...wide, partial: true }, 'other', false)).toBe('undecided')
    expect(ignoreVerdict(rules('[a-cx-z]'), 'y', false)).toBe('ignored')
    expect(ignoreVerdict(rules('[a-cx-z]'), 'm', false)).toBe('kept')
  })

  it('never keeps an entry on a ! line when that level or a deeper one is not whole', () => {
    const dropped = `${'a/'.repeat(40)}x.txt`
    const partial = (text: string, base = '', parent?: IgnoreRules): IgnoreRules => ({
      base,
      patterns: parseGitignore(text),
      partial: true,
      ...(parent ? { parent } : {}),
    })
    expect(ignoreVerdict(partial(`*.txt\n!x.txt\n${dropped}`), 'x.txt', false)).toBe('undecided')
    expect(ignoreVerdict(partial('*.txt\n!x.txt\n**/a/**/b/**/c/**/d/**/x.txt'), 'x.txt', false)).toBe('undecided')
    expect(ignoreVerdict(partial('other', 'app', rules('!x.txt')), 'app/x.txt', false)).toBe('undecided')
    // Whole levels decide as before.
    expect(ignoreVerdict(rules('other', 'app', rules('!x.txt')), 'app/x.txt', false)).toBe('kept')
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

/** Runs `work` with a 1 ms timer on the event loop and reports the longest gap between its ticks. */
async function longestGap(work: () => Promise<unknown>) {
  let last = performance.now(),
    gap = 0
  const timer = setInterval(() => {
    const now = performance.now()
    gap = Math.max(gap, now - last)
    last = now
  }, 1)
  const started = performance.now()
  try {
    await work()
  } finally {
    clearInterval(timer)
  }
  gap = Math.max(gap, performance.now() - last)
  return { gap, ms: performance.now() - started }
}

/** A set at the cap, all ranges: each set test costs every range, the most one step can cost. */
const WIDE_SET = `[${Array.from({ length: 64 }, (_, index) => `${String.fromCharCode(0x4e00 + 2 * index)}-${String.fromCharCode(0x4e01 + 2 * index)}`).join('')}]`
type Shape = 'root' | 'globstar' | 'chain' | 'sets' | 'wide-sets' | 'brackets' | 'open-sets'

/** Crafted repositories: the shapes of the reviews, kept small on disk. */
async function crafted(shape: Shape) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'latch-ignore-')))
  cleanups.push(() => rm(parent, { recursive: true, force: true }))
  const root = join(parent, 'repo')
  await mkdir(join(root, '.git'), { recursive: true })
  const files = async (at: string, count: number, name: (index: number) => string) => {
    for (let index = 0; index < count; index++) await writeFile(join(at, name(index)), 'needle\n')
  }
  if (shape === 'root') {
    await writeFile(join(root, '.gitignore'), `${'*'.concat('a'.repeat(62), 'b')}\n`.repeat(1000))
    await files(root, 64, index => `${'a'.repeat(250)}${String(index).padStart(3, '0')}`)
  } else if (shape === 'globstar') {
    let at = root
    for (let level = 0; level < 4; level++) {
      await writeFile(join(at, '.gitignore'), `**/${'*a'.repeat(28)}b\n`.repeat(1000))
      at = join(at, `${String(level)}${'a'.repeat(219)}`)
      await mkdir(at)
    }
    await files(at, 40, index => `${'a'.repeat(30)}${index}`)
  } else if (shape === 'chain') {
    let at = root
    for (let level = 0; level < 30; level++) {
      await writeFile(join(at, '.gitignore'), `${'*a'.repeat(30)}b\n`.repeat(900))
      at = join(at, `${String(level).padStart(2, '0')}${'a'.repeat(26)}`)
      await mkdir(at)
      await files(at, 4, index => `${'a'.repeat(26)}${index}`)
    }
  } else if (shape === 'sets' || shape === 'wide-sets') {
    // 32 nested d/ levels, each ignore file one-byte sets of 1,021 items (or sets at the cap) and `!d`; CJK and emoji names.
    const line = shape === 'sets' ? `*[${'b'.repeat(1021)}]` : `*${WIDE_SET}${WIDE_SET}`
    let at = root
    for (let level = 0; level < 32; level++) {
      await writeFile(join(at, '.gitignore'), `${`${line}\n`.repeat(shape === 'sets' ? 61 : 300)}.gitignore\n!d\n`)
      at = join(at, 'd')
      await mkdir(at)
    }
    await files(at, 20, index => `${'😀'.repeat(61)}${index}`)
    await files(at, 20, index => `${'漢'.repeat(80)}${index}`)
  } else if (shape === 'brackets') {
    await writeFile(join(root, '.gitignore'), `${'['.repeat(1023)}\n`.repeat(63))
    await files(root, 40, index => `${'a'.repeat(200)}${index}`)
  } else {
    await writeFile(join(root, '.gitignore'), `${'[a'.repeat(511)}\n`.repeat(64))
    await files(root, 40, index => `${'a'.repeat(200)}${index}`)
  }
  return { id: 'default', path: root }
}

describe.each(['root', 'globstar', 'chain', 'sets', 'wide-sets', 'brackets', 'open-sets'] as const)(
  'a crafted repository (%s) never holds the event loop',
  shape => {
    const guard = new ProtectedPaths([])
    // The invariant is ~25 ms on this machine; the assertion leaves room for a loaded test runner.
    const GAP = 60
    it('content search, listing through the index as the route does', async () => {
      const root = await crafted(shape)
      const index = new FileSearchIndex()
      cleanups.push(() => index.close())
      const { gap, ms } = await longestGap(() =>
        grepFiles(
          [root],
          guard,
          { q: 'needle', caseSensitive: false, wholeWord: false },
          () => false,
          () => {},
          undefined,
          {
            list: (folder, late, check) => index.files(folder, guard, 'identity', late, check),
          },
        ),
      )
      expect(gap).toBeLessThan(GAP)
      expect(ms).toBeLessThan(6500)
    })
    it('name search, fresh and through the index', async () => {
      const root = await crafted(shape)
      const fresh = await longestGap(() => searchFiles([root], guard, 'aaa', 50, () => false))
      expect(fresh.gap).toBeLessThan(GAP)
      expect(fresh.ms).toBeLessThan(4500)
      const index = new FileSearchIndex()
      cleanups.push(() => index.close())
      const indexed = await longestGap(() => index.search([root], guard, 'identity', 'aaa', 50, () => false))
      expect(indexed.gap).toBeLessThan(GAP)
      expect(indexed.ms).toBeLessThan(4500)
    })
  },
)
