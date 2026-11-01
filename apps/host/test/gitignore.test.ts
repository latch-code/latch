import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isGitignored, parseGitignore, readIgnoreRules, type IgnoreRules } from '../src/files/gitignore.ts'

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
      expect(isGitignored(read, 'first', false)).toBe(true)
      expect(isGitignored(read, 'last', false)).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
