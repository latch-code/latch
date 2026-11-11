import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readGitLayout } from '../src/branch-reader.ts'
import { attributeChange, commandLines, editsByFile } from '../src/changes/attribution.ts'
import { diffLines, splitText } from '../src/changes/diff.ts'
import { BlobIdCache, gitPairs } from '../src/changes/git-scope.ts'
import { GitError, GitReader, findGit } from '../src/changes/git.ts'
import { Contents, compareSides, describe as describePair, patchOf } from '../src/changes/sides.ts'
import { fileKey } from '../src/changes/walk.ts'
import { configHookGit } from './helpers/config-hooks.ts'

const git = findGit()
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function directory(prefix = 'latch-changes-git-') {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}

/** A repository made with Git itself, without reading the owner's configuration. */
async function repository() {
  const root = await directory()
  const run = (...args: string[]) =>
    execFileSync(git!, ['-c', 'user.name=Latch', '-c', 'user.email=latch@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      stdio: 'pipe',
    })
  run('init', '-q')
  return { root, run }
}

const options = () => ({ reader: new GitReader({ binary: git! }), ids: new BlobIdCache(), entryLimit: 1000, hashLimit: 1024 * 1024 })
const rows = async (scope: Awaited<ReturnType<typeof gitPairs>>) => {
  const reader = new GitReader({ binary: git! })
  const blobs = new Map<string, Buffer>()
  for (const [root, layout] of scope.repositories)
    for (const [oid, bytes] of await reader.blobs(
      layout,
      scope.pairs.filter(pair => pair.root === root && pair.before?.from === 'blob').map(pair => (pair.before as { oid: string }).oid),
      1024 * 1024,
    ))
      blobs.set(oid, bytes)
  const contents = new Contents({ blobs: oid => blobs.get(oid) }, 1024 * 1024)
  const listed = []
  for (const pair of scope.pairs) listed.push(describePair(pair, await compareSides(pair, contents)))
  return listed.toSorted((a, b) => a.path.localeCompare(b.path))
}

describe.skipIf(!git)('read-only Git scopes', () => {
  it('compares the work tree with HEAD itself, so a repository fsmonitor or clean filter never runs', async () => {
    const { root, run } = await repository()
    const marks = await directory('latch-changes-marks-')
    await writeFile(join(root, 'a.txt'), 'one\n')
    await writeFile(join(root, '.gitattributes'), '* filter=evil\n')
    run('add', '-A')
    run('commit', '-qm', 'init')
    const hook = join(marks, 'hook.sh')
    await writeFile(hook, `#!/bin/sh\ntouch '${join(marks, 'ran')}'\ncat\n`)
    await chmod(hook, 0o755)
    run('config', 'core.fsmonitor', hook)
    run('config', 'filter.evil.clean', hook)
    await writeFile(join(root, 'a.txt'), 'two\n')
    const scope = await gitPairs([{ id: 'main', path: root }], 'uncommitted', options())
    expect(await rows(scope)).toMatchObject([{ path: 'a.txt', status: 'M', add: 1, del: 1 }])
    expect(existsSync(join(marks, 'ran'))).toBe(false)
  })

  it('lists modified, deleted, staged, untracked, renamed and mode-changed files, and leaves out ignored ones', async () => {
    const { root, run } = await repository()
    await mkdir(join(root, 'src'))
    for (const [path, text] of [
      ['src/keep.ts', 'keep\n'],
      ['src/edit.ts', 'before\n'],
      ['src/gone.ts', 'gone\n'],
      ['src/moved.ts', 'moved content\n'],
      ['run.sh', 'echo\n'],
      ['.gitignore', 'ignored.log\n'],
    ])
      await writeFile(join(root, path!), text!)
    run('add', '-A')
    run('commit', '-qm', 'init')
    await writeFile(join(root, 'src/edit.ts'), 'after\n')
    await rm(join(root, 'src/gone.ts'))
    await rm(join(root, 'src/moved.ts'))
    await writeFile(join(root, 'src/renamed.ts'), 'moved content\n')
    await writeFile(join(root, 'staged.ts'), 'staged\n')
    run('add', 'staged.ts')
    await writeFile(join(root, 'new.ts'), 'new\n')
    await writeFile(join(root, 'ignored.log'), 'log\n')
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', 'dep.js'), 'dep\n')
    await chmod(join(root, 'run.sh'), 0o755)
    expect(
      (await rows(await gitPairs([{ id: 'main', path: root }], 'uncommitted', options()))).map(row => [
        row.path,
        row.status,
        row.oldPath ?? '',
        row.modeChanged ?? false,
      ]),
    ).toEqual([
      ['new.ts', 'A', '', false],
      ['run.sh', 'M', '', true],
      ['src/edit.ts', 'M', '', false],
      ['src/gone.ts', 'D', '', false],
      ['src/renamed.ts', 'R', 'src/moved.ts', false],
      ['staged.ts', 'A', '', false],
    ])
  })

  it('compares a branch with where it left main, and has no base on main itself or outside Git', async () => {
    const { root, run } = await repository()
    await writeFile(join(root, 'base.txt'), 'base\n')
    run('add', '-A')
    run('commit', '-qm', 'base')
    expect((await gitPairs([{ id: 'main', path: root }], 'base', options())).unavailable).toBe('no-base')
    run('checkout', '-qb', 'feature')
    await writeFile(join(root, 'feature.txt'), 'feature\n')
    run('add', '-A')
    run('commit', '-qm', 'feature')
    await writeFile(join(root, 'base.txt'), 'changed\n')
    const scope = await gitPairs([{ id: 'main', path: root }], 'base', options())
    expect(scope.base).toBe('main')
    expect((await rows(scope)).map(row => [row.path, row.status])).toEqual([
      ['base.txt', 'M'],
      ['feature.txt', 'A'],
    ])
    const plain = await directory()
    expect(await gitPairs([{ id: 'main', path: plain }], 'uncommitted', options())).toMatchObject({
      unavailable: 'not-git',
      notGit: ['main'],
    })
  })

  it('reads the layout it runs Git in from files only', async () => {
    const { root } = await repository()
    expect(await readGitLayout(root)).toEqual({ root, gitdir: join(root, '.git'), head: { branch: 'main' } })
  })
})

describe('a repository in the middle of something', () => {
  /** Two branches that both change `shared.txt`, on `main`. */
  async function diverged() {
    const repo = await repository()
    await writeFile(join(repo.root, 'shared.txt'), 'base\n')
    repo.run('add', '.')
    repo.run('commit', '-q', '-m', 'base')
    repo.run('checkout', '-q', '-b', 'side')
    await writeFile(join(repo.root, 'shared.txt'), 'side\n')
    repo.run('commit', '-q', '-am', 'side')
    repo.run('checkout', '-q', 'main')
    await writeFile(join(repo.root, 'shared.txt'), 'main\n')
    repo.run('commit', '-q', '-am', 'main')
    return repo
  }
  const fails = (run: () => unknown) => expect(run).toThrow()
  const listed = async (root: string) => {
    const scope = await gitPairs([{ id: 'default', path: root }], 'uncommitted', options())
    return { conflict: scope.conflict, rows: scope.pairs.map(pair => [pair.path, pair.conflicted]) }
  }

  it('says nothing about a clean repository', async () => {
    const repo = await diverged()
    expect(await listed(repo.root)).toEqual({ conflict: undefined, rows: [] })
  })

  it('names a merge and the files Git marks as unmerged', async () => {
    const repo = await diverged()
    fails(() => repo.run('merge', 'side'))
    expect(await listed(repo.root)).toEqual({ conflict: { operation: 'merge', files: 1 }, rows: [['shared.txt', true]] })
  })

  it('names a cherry-pick, a revert and a rebase', async () => {
    const pick = await diverged()
    fails(() => pick.run('cherry-pick', 'side'))
    expect((await listed(pick.root)).conflict).toEqual({ operation: 'cherry-pick', files: 1 })
    const back = await diverged()
    await writeFile(join(back.root, 'shared.txt'), 'later\n')
    back.run('commit', '-q', '-am', 'later')
    fails(() => back.run('revert', '--no-edit', 'HEAD~1'))
    expect((await listed(back.root)).conflict).toEqual({ operation: 'revert', files: 1 })
    const rebase = await diverged()
    fails(() => rebase.run('rebase', 'side'))
    expect((await listed(rebase.root)).conflict).toEqual({ operation: 'rebase', files: 1 })
  })

  it('names conflicted files with nothing under way, and an operation with none left to resolve', async () => {
    const stashed = await diverged()
    await writeFile(join(stashed.root, 'shared.txt'), 'mine\n')
    stashed.run('stash', 'push', '-q')
    stashed.run('checkout', '-q', 'side')
    fails(() => stashed.run('stash', 'pop', '-q'))
    expect((await listed(stashed.root)).conflict).toEqual({ operation: 'unmerged', files: 1 })
    const resolved = await diverged()
    fails(() => resolved.run('merge', 'side'))
    await writeFile(join(resolved.root, 'shared.txt'), 'both\n')
    resolved.run('add', '.')
    expect((await listed(resolved.root)).conflict).toEqual({ operation: 'merge', files: 0 })
  })
})

describe('the Git process', () => {
  it('gets fixed hardening arguments and an environment of PATH, HOME and Git switches only', async () => {
    const out = await directory()
    const fake = join(out, 'git')
    await writeFile(fake, `#!/bin/sh\nenv > '${join(out, 'env')}'\nprintf '%s\\n' "$@" > '${join(out, 'args')}'\n`)
    await chmod(fake, 0o755)
    const layout = { root: out, gitdir: join(out, '.git'), head: { branch: 'main' } }
    process.env.LATCH_CHANGES_PROBE = 'must-not-pass'
    try {
      await new GitReader({ binary: fake }).run(layout, ['ls-files', '-z'], { maxBytes: 100 })
    } finally {
      delete process.env.LATCH_CHANGES_PROBE
    }
    const env = (await readFile(join(out, 'env'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => line.split('=')[0])
    expect(env.filter(name => name !== 'PWD' && name !== 'SHLVL' && name !== '_').toSorted()).toEqual([
      'GIT_DIR',
      'GIT_NO_LAZY_FETCH',
      'GIT_OPTIONAL_LOCKS',
      'GIT_TERMINAL_PROMPT',
      'GIT_WORK_TREE',
      'HOME',
      'PATH',
    ])
    expect((await readFile(join(out, 'args'), 'utf8')).trim().split('\n')).toEqual([
      '--no-pager',
      '-c',
      'core.fsmonitor=',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'diff.external=',
      '-c',
      'protocol.allow=never',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'core.alternateRefsCommand=',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'tag.gpgSign=false',
      '-c',
      'core.editor=:',
      'ls-files',
      '-z',
    ])
  })

  it('stops a Git that prints too much or takes too long', async () => {
    const out = await directory()
    const noisy = join(out, 'noisy'),
      slow = join(out, 'slow')
    await writeFile(noisy, '#!/bin/sh\nyes x\n')
    await writeFile(slow, '#!/bin/sh\nsleep 5\n')
    await Promise.all([chmod(noisy, 0o755), chmod(slow, 0o755)])
    const layout = { root: out, gitdir: join(out, '.git'), head: { branch: 'main' } }
    await expect(new GitReader({ binary: noisy }).run(layout, [], { maxBytes: 1000 })).rejects.toEqual(new GitError('output-limit'))
    await expect(new GitReader({ binary: slow, timeoutMs: 100 }).run(layout, [], { maxBytes: 1000 })).rejects.toEqual(
      new GitError('timeout'),
    )
  })
})

describe('attributing a turn', () => {
  it('matches edits by absolute paths under either spelling of a folder, and by relative paths', () => {
    const byFile = editsByFile(
      [
        { path: '/real/project/src/a.ts', newText: 'a' },
        { path: '/given/project/src/b.ts', newText: 'b' },
        { path: 'src/c.ts', newText: 'c' },
        { path: '/elsewhere/d.ts', newText: 'd' },
        { path: '../escape.ts', newText: 'e' },
      ],
      [{ id: 'main', paths: ['/real/project', '/given/project'] }],
    )
    expect([...byFile.keys()].toSorted()).toEqual([fileKey('main', 'src/a.ts'), fileKey('main', 'src/b.ts'), fileKey('main', 'src/c.ts')])
  })

  it('tells the agent’s lines from a command’s in the same file', () => {
    const before = splitText('one\ntwo\nthree\n'),
      after = splitText('one\nTWO\nthree\nfrom-command\n')
    expect(attributeChange([], before, after)).toEqual({ by: 'command' })
    expect(attributeChange([{ path: 'f', newText: 'one\nTWO\nthree\nfrom-command\n' }], before, after)).toEqual({ by: 'agent' })
    const mixed = attributeChange([{ path: 'f', oldText: 'two\n', newText: 'TWO\n' }], before, after)
    expect(mixed.by).toBe('mixed')
    const ops = diffLines(before, after)
    const flagged = ops.filter((_, index) => commandLines(ops, mixed)[index]).map(op => op.text)
    expect(flagged).toEqual(['from-command'])
    expect(attributeChange([{ path: 'f', newText: 'x' }], undefined, after)).toEqual({ by: 'agent' })
  })
})

describe('listing a pair', () => {
  it('never shows secret-looking or secret content, marks binary and writes renames into the patch', async () => {
    const contents = new Contents({}, 1024)
    const blob = (oid: string) => ({ from: 'blob' as const, oid, mode: '100644', size: 4 })
    const blobs: Record<string, Uint8Array> = {
      [`${'a'.repeat(40)}`]: Buffer.from('one\n'),
      [`${'b'.repeat(40)}`]: Buffer.from([0x00, 0x01]),
      [`${'c'.repeat(40)}`]: Buffer.from(['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')),
    }
    const reading = new Contents({ blobs: oid => blobs[oid] }, 1024)
    expect(
      describePair(
        { root: 'main', path: '.env', before: blob('a'.repeat(40)) },
        await compareSides({ root: 'main', path: '.env', before: blob('a'.repeat(40)) }, contents),
      ),
    ).toMatchObject({ secret: true, status: 'D' })
    const binary = { root: 'main', path: 'x.bin', before: blob('b'.repeat(40)) }
    expect(describePair(binary, await compareSides(binary, reading))).toMatchObject({ binary: true })
    const key = { root: 'main', path: 'key.txt', before: blob('c'.repeat(40)) }
    const keyRow = describePair(key, await compareSides(key, reading))
    expect(keyRow).toMatchObject({ secret: true })
    expect(keyRow.add).toBeUndefined()
    const renamed = { root: 'main', path: 'new.txt', oldPath: 'old.txt', before: blob('a'.repeat(40)), after: blob('a'.repeat(40)) }
    expect(patchOf(renamed, await compareSides(renamed, reading), '')).toBe(
      'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n',
    )
  })
})

const hookGit = configHookGit()
describe.skipIf(!hookGit)('hooks from configuration (Git 2.54 and later)', () => {
  it('switches off every configured hook, from any scope, for every restricted Git process', async () => {
    const root = await directory()
    const repo = join(root, 'repo'),
      home = join(root, 'home'),
      marker = join(root, 'marker')
    await Promise.all([mkdir(repo), mkdir(home)])
    const run = (...args: string[]) =>
      execFileSync(hookGit!, args, { cwd: repo, env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' })
    run('init', '-q', '-b', 'main')
    await writeFile(join(repo, 'a.txt'), 'a\n')
    run('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'first')
    for (const [name, event] of [
      ['index', 'post-index-change'],
      ['refs', 'reference-transaction'],
    ])
      run('config', `hook.${name}.event`, event!, '--add')
    run('config', 'hook.index.command', `echo index >> '${marker}'`)
    run('config', 'hook.refs.command', `echo refs >> '${marker}'`)
    // The global scope too, where an `include` could bring one in.
    await writeFile(join(home, '.gitconfig'), `[hook "global"]\n\tevent = post-index-change\n\tcommand = echo global >> '${marker}'\n`)
    // Precondition: this Git does run them.
    run('add', 'a.txt')
    expect(existsSync(marker)).toBe(true)
    run('reset', '-q')
    await rm(marker)

    const layout = (await readGitLayout(repo))!
    const reader = new GitReader({ binary: hookGit!, home })
    await reader.run(layout, ['add', '--', 'a.txt'], { maxBytes: 1024 })
    await reader.run(layout, ['write-tree'], { maxBytes: 1024 })
    await reader.run(layout, ['update-ref', 'refs/heads/other', 'HEAD'], { maxBytes: 1024 })
    await reader.run(layout, ['reset', '-q', 'HEAD', '--', 'a.txt'], { maxBytes: 1024 })
    await reader.index(layout, 100)
    expect(existsSync(marker) ? await readFile(marker, 'utf8') : '').toBe('')

    // Odd names are switched off as well: empty, with quotes, spaces or dots.
    for (const section of ['[hook ""]', `[hook "a b'c\\"d"]`, '[hook "x.y"]', '[hook "UPPER"]']) {
      await writeFile(
        join(repo, '.git', 'config'),
        `${await readFile(join(repo, '.git', 'config'), 'utf8')}${section}\n\tevent = post-index-change\n\tcommand = echo odd >> '${marker}'\n`,
      )
      await reader.run(layout, ['add', '--', 'a.txt'], { maxBytes: 1024 })
      expect(existsSync(marker) ? await readFile(marker, 'utf8') : '', section).toBe('')
    }
    // A key under `hook.` of a shape the reader does not know refuses.
    const plain = await readFile(join(repo, '.git', 'config'), 'utf8')
    await writeFile(join(repo, '.git', 'config'), `${plain}[hook]\n\tcommand = echo bare >> '${marker}'\n`)
    await expect(reader.run(layout, ['add', '--', 'a.txt'], { maxBytes: 1024 })).rejects.toEqual(new GitError('unsafe-config'))
    await writeFile(join(repo, '.git', 'config'), plain)

    // A name the command line cannot carry stops the process before Git runs anything.
    await writeFile(
      join(repo, '.git', 'config'),
      `${await readFile(join(repo, '.git', 'config'), 'utf8')}[hook "a=b"]\n\tevent = post-index-change\n\tcommand = echo bad >> '${marker}'\n`,
    )
    await expect(reader.run(layout, ['add', '--', 'a.txt'], { maxBytes: 1024 })).rejects.toEqual(new GitError('unsafe-config'))
    expect(existsSync(marker)).toBe(false)
  })
})
