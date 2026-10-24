import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { addedLines, changedFiles, openRepository, outermost, treeDirectories } from '../scripts/repository.ts'

const run = promisify(execFile)
/** Commits in the test repositories: no hooks, no signing, a fixed author. */
const GIT_OPTIONS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'user.name=Test',
  '-c',
  'user.email=test@example.invalid',
]

describe('repository listing', () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  /** A git repository in a temp directory; the user's git configuration and hooks stay out of its commits. */
  async function repo(files: Record<string, string>): Promise<{ dir: string; git: (...args: string[]) => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), 'latch-repository-'))
    root = dir
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    const git = async (...args: string[]) => {
      await run('git', [...GIT_OPTIONS, ...args], { cwd: dir, env })
    }
    await git('init', '-q')
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(dir, path, '..'), { recursive: true })
      await writeFile(join(dir, path), text)
    }
    await git('add', '-A')
    await git('commit', '-q', '-m', 'base')
    return { dir, git }
  }

  it('lists tracked and untracked files without the ignored ones, links as files, and says which paths git ignores', async () => {
    const { dir } = await repo({ '.gitignore': '/dist/\n*.log\n', 'src/a.ts': 'a\n', 'docs/x.md': 'x\n' })
    await mkdir(join(dir, 'dist'), { recursive: true })
    await writeFile(join(dir, 'dist/out.js'), 'out\n')
    await writeFile(join(dir, 'debug.log'), 'log\n')
    await writeFile(join(dir, 'src/b.ts'), 'b\n')
    await rm(join(dir, 'docs/x.md'))
    await mkdir(join(dir, 'links'))
    await symlink('../src', join(dir, 'links/src'))
    const repository = await openRepository(dir)
    expect([...repository.files].toSorted()).toEqual(['.gitignore', 'links/src', 'src/a.ts', 'src/b.ts'])
    expect([...repository.dirs].toSorted()).toEqual(['links', 'src'])
    expect(await repository.link('links/src')).toBe('../src')
    expect(await repository.link('src/a.ts')).toBeUndefined()
    expect([...(await repository.ignored(['dist/out.js', 'dist/never', 'src/a.ts', 'x.log']))].toSorted()).toEqual([
      'dist/never',
      'dist/out.js',
      'x.log',
    ])
    expect(await repository.ignored([])).toEqual(new Set())
  })

  it('lists the changes against a base, renames with both paths, and the lines each change adds', async () => {
    const { dir, git } = await repo({ 'keep.ts': 'one\ntwo\n', 'old/name.ts': 'moved\nfile\nwith\nlines\n', 'gone.ts': 'bye\n' })
    await writeFile(join(dir, 'keep.ts'), 'one\nTWO\nthree\n')
    await mkdir(join(dir, 'new'))
    await git('mv', 'old/name.ts', 'new/name.ts')
    await rm(join(dir, 'gone.ts'))
    await writeFile(join(dir, 'fresh.ts'), 'first\nsecond\n')
    const changes = await changedFiles(dir)
    expect(changes.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      { status: 'A', path: 'fresh.ts' },
      { status: 'D', path: 'gone.ts' },
      { status: 'M', path: 'keep.ts' },
      { status: 'R', path: 'new/name.ts', from: 'old/name.ts' },
    ])
    const added = await addedLines(dir, changes)
    expect(Object.fromEntries([...added].toSorted(([a], [b]) => a.localeCompare(b)))).toEqual({
      'fresh.ts': ['first', 'second', ''],
      'keep.ts': ['TWO', 'three'],
    })
    expect([...(await treeDirectories(dir))]).toEqual(['old'])
    expect(outermost(['a', 'a/b', 'c/d', 'c/d/e', 'f'])).toEqual(['a', 'c/d', 'f'])
  })
})
