import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '@latch/core/node-kit'
import { findGit } from '../src/changes/git.ts'
import { WORKTREE_BRANCH, WORKTREE_NAME, Worktrees, type WorktreeOptions } from '../src/worktrees.ts'
import { configHookGit } from './helpers/config-hooks.ts'

const git = findGit()
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function directory(prefix = 'latch-worktrees-') {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanup.push(async () => {
    // A failed case can leave folders the test made read-only.
    await chmodTree(path).catch(() => {})
    await rm(path, { recursive: true, force: true })
  })
  return path
}

async function chmodTree(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return
  await chmod(path, info.isDirectory() ? 0o755 : 0o644)
  if (info.isDirectory()) for (const entry of await readdir(path)) await chmodTree(join(path, entry))
}

/** A repository made with Git itself, without reading the owner's configuration. */
async function setup() {
  const base = await directory()
  const root = join(base, 'project')
  const home = join(base, 'home')
  const marks = join(base, 'marks')
  const data = join(base, 'data')
  for (const path of [root, home, marks, data]) await mkdir(path)
  const run = (...args: string[]) =>
    execFileSync(git!, ['-c', 'user.name=Latch', '-c', 'user.email=latch@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0' },
      stdio: 'pipe',
    }).toString('utf8')
  run('init', '-q')
  await writeFile(join(root, 'a.txt'), 'one\n')
  run('add', '-A')
  run('commit', '-qm', 'init')
  /** A script that leaves `marks/<name>` behind if anything ever runs it, and passes its input through. */
  const trap = async (name: string) => {
    const path = join(marks, `${name}.sh`)
    await writeFile(path, `#!/bin/sh\ntouch '${join(marks, name)}'\ncat\n`)
    await chmod(path, 0o755)
    return path
  }
  const ran = async () => (await readdir(marks)).filter(name => !name.endsWith('.sh'))
  const worktreeRoot = join(base, 'worktrees')
  const service = (options: Partial<WorktreeOptions> = {}) =>
    new Worktrees({ root: worktreeRoot, dataDir: data, git: git!, home, log: () => {}, ...options })
  const branches = () => run('for-each-ref', '--format=%(refname)', 'refs/heads').trim().split('\n')
  const registered = () =>
    run('worktree', 'list', '--porcelain')
      .split('\n')
      .filter(line => line.startsWith('worktree '))
  return { base, root, home, marks, data, run, trap, ran, worktreeRoot, service, branches, registered }
}

/** Nothing of a refused or rolled-back start is left: no branch, no registration, no folder. */
async function nothingLeft(t: Awaited<ReturnType<typeof setup>>) {
  expect(t.branches()).toEqual(['refs/heads/main'])
  expect(t.registered()).toEqual([`worktree ${t.root}`])
  expect(existsSync(join(t.root, '.git', 'worktrees')) ? await readdir(join(t.root, '.git', 'worktrees')) : []).toEqual([])
  const buckets = existsSync(t.worktreeRoot) ? (await readdir(t.worktreeRoot)).filter(name => name !== '.metadata_never_index') : []
  expect(buckets).toEqual([])
}

/** A wrapper around Git that fails, or prints something else, for the commands `match` picks. */
async function wrapper(base: string, match: string, body: string) {
  const path = join(base, `git-${Math.random().toString(16).slice(2)}.sh`)
  await writeFile(path, `#!/bin/sh\ncase " $* " in\n  *'${match}'*) ${body} ;;\nesac\nexec '${git}' "$@"\n`)
  await chmod(path, 0o755)
  return path
}

describe.skipIf(!git)('worktrees', () => {
  it('makes a worktree on a new latch/ branch from HEAD, outside the repository, leaving the source as it was', async () => {
    const t = await setup()
    await writeFile(join(t.root, 'a.txt'), 'uncommitted\n')
    await writeFile(join(t.root, 'new.txt'), 'untracked\n')
    const head = t.run('rev-parse', 'HEAD').trim()
    const made = await t.service({ clock: () => new Date(2026, 10, 8, 9).getTime(), suffix: () => '0a9f' }).create({
      source: t.root,
      requestId: 'request-0001',
    })
    expect(made).toEqual({
      path: join(t.worktreeRoot, `project-${sha256Hex(t.root).slice(0, 8)}`, '20261108-0a9f'),
      branch: 'latch/20261108-0a9f',
      base: head,
      copied: 0,
      unfiltered: 0,
    })
    expect(WORKTREE_BRANCH.test(made.branch) && WORKTREE_NAME.test(basename(made.path))).toBe(true)
    expect(await readFile(join(made.path, 'a.txt'), 'utf8')).toBe('one\n')
    expect(existsSync(join(made.path, 'new.txt'))).toBe(false)
    expect(t.run('rev-parse', 'refs/heads/latch/20261108-0a9f').trim()).toBe(head)
    expect(t.registered()).toEqual([`worktree ${t.root}`, `worktree ${made.path}`])
    // The source keeps its branch, index and changes.
    expect(t.run('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main')
    expect(t.run('status', '--porcelain', '--untracked-files=all')).toBe(' M a.txt\n?? new.txt\n')
    expect(await readFile(join(t.root, 'a.txt'), 'utf8')).toBe('uncommitted\n')
    // The new worktree has nothing to commit.
    expect(
      execFileSync(git!, ['-C', made.path, 'status', '--porcelain'], { env: { PATH: '/usr/bin:/bin', HOME: t.home } }).toString(),
    ).toBe('')
    expect(existsSync(join(t.worktreeRoot, '.metadata_never_index'))).toBe(process.platform === 'darwin')
    expect((await lstat(t.worktreeRoot)).mode & 0o777).toBe(0o700)
  })

  it('gives a retried request the same worktree and another request a new one; a taken name is never reused', async () => {
    const t = await setup()
    const suffixes = ['aaaa', 'aaaa', 'bbbb']
    const worktrees = t.service({ suffix: () => suffixes.shift() ?? 'cccc' })
    const [first, again] = await Promise.all([
      worktrees.create({ source: t.root, requestId: 'request-0001' }),
      worktrees.create({ source: t.root, requestId: 'request-0001' }),
    ])
    expect(again).toEqual(first)
    const second = await worktrees.create({ source: t.root, requestId: 'request-0002' })
    expect(second.path).not.toBe(first.path)
    expect(basename(second.path)).toMatch(/-bbbb$/u)
  })

  it('trusts only a worktree with its marker: bound once to the session created in it', async () => {
    const t = await setup()
    const worktrees = t.service()
    const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    expect(await worktrees.sessionOf(made.path)).toBeUndefined()
    await expect(worktrees.bind(made.path, 'request-0002', 'session-1')).rejects.toMatchObject({ code: 'worktree-unmarked' })
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    expect(await worktrees.sessionOf(made.path)).toBe('session-1')
    await expect(worktrees.bind(made.path, 'request-0001', 'session-2')).rejects.toMatchObject({ code: 'worktree-owned' })
    // A new Host process reads the same marker.
    expect(await t.service().sessionOf(made.path)).toBe('session-1')

    // A worktree someone else added at a path of the same shape is not Latch's.
    const other = join(dirname(made.path), '20260101-0000')
    t.run('worktree', 'add', '-q', '-b', 'mine', other)
    expect(await worktrees.sessionOf(other)).toBeUndefined()
    await expect(worktrees.bind(other, 'request-0003', 'session-3')).rejects.toMatchObject({ code: 'worktree-unmarked' })
    expect(await worktrees.sessionOf(t.root)).toBeUndefined()
    // A damaged marker is not trusted either.
    const marker = join(t.root, '.git', 'worktrees', basename(made.path), 'latch-session.json')
    await writeFile(marker, '{"version":1,"sessionId":"session-1"}\n')
    expect(await worktrees.sessionOf(made.path)).toBeUndefined()
  })

  it('never runs a hook, fsmonitor or filter the repository, an include or the global configuration names', async () => {
    const t = await setup()
    const hooks = join(t.base, 'hooks')
    await mkdir(hooks)
    for (const hook of ['post-checkout', 'reference-transaction', 'post-index-change', 'post-merge']) {
      const script = await t.trap(hook)
      await writeFile(join(hooks, hook), `#!/bin/sh\nexec '${script}'\n`)
      await chmod(join(hooks, hook), 0o755)
      await writeFile(join(t.root, '.git', 'hooks', hook), `#!/bin/sh\nexec '${script}'\n`)
      await chmod(join(t.root, '.git', 'hooks', hook), 0o755)
    }
    t.run('config', 'core.hooksPath', hooks)
    t.run('config', 'core.fsmonitor', await t.trap('fsmonitor'))
    for (const kind of ['clean', 'smudge', 'process']) t.run('config', `filter.local.${kind}`, await t.trap(`local-${kind}`))
    t.run('config', 'filter.local.required', 'true')
    t.run('config', 'filter.some.dotted.name.smudge', await t.trap('dotted'))
    const included = join(t.base, 'included.gitconfig')
    await writeFile(included, `[filter "included"]\n\tsmudge = ${await t.trap('included')}\n\trequired = true\n`)
    t.run('config', 'include.path', included)
    await writeFile(
      join(t.home, '.gitconfig'),
      `[filter "global"]\n\tsmudge = ${await t.trap('global')}\n\tprocess = ${await t.trap('global-process')}\n`,
    )
    const attributes = join(t.base, 'attributes')
    await writeFile(attributes, '*.md filter=global\n')
    t.run('config', 'core.attributesFile', attributes)
    await writeFile(join(t.root, '.git', 'info', 'attributes'), '*.cfg filter=included\n')
    await writeFile(join(t.root, '.gitattributes'), '*.txt filter=local\n*.dat filter=some.dotted.name\n*.bin filter=global\n')
    for (const [name, text] of [
      ['b.txt', 'local\n'],
      ['c.dat', 'dotted\n'],
      ['d.bin', 'global\n'],
      ['e.cfg', 'included\n'],
      ['f.md', 'attributes file\n'],
    ])
      await writeFile(join(t.root, name), text)
    // Committed with every filter off, so the setup itself runs none.
    const off = ['local', 'some.dotted.name', 'included', 'global'].flatMap(name => [
      '-c',
      `filter.${name}.clean=`,
      '-c',
      `filter.${name}.process=`,
      '-c',
      `filter.${name}.required=false`,
    ])
    t.run('-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', ...off, 'add', '-A')
    t.run('-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', ...off, 'commit', '-qm', 'attributes')
    expect(await t.ran()).toEqual([])

    const made = await t.service().create({ source: t.root, requestId: 'request-0001' })
    expect(await t.ran()).toEqual([])
    for (const [name, text] of [
      ['b.txt', 'local\n'],
      ['c.dat', 'dotted\n'],
      ['d.bin', 'global\n'],
      ['e.cfg', 'included\n'],
    ])
      expect(await readFile(join(made.path, name), 'utf8')).toBe(text)
    // a.txt, b.txt, c.dat and d.bin by the tree's attributes, e.cfg by info/attributes; core.attributesFile is not read.
    expect(made.unfiltered).toBe(5)
  })

  it('leaves Git LFS files as pointers without running git-lfs', async () => {
    const t = await setup()
    await writeFile(
      join(t.home, '.gitconfig'),
      `[filter "lfs"]\n\tsmudge = ${await t.trap('lfs-smudge')}\n\tprocess = ${await t.trap('lfs-process')}\n\trequired = true\n`,
    )
    await writeFile(join(t.root, '.gitattributes'), '*.psd filter=lfs diff=lfs merge=lfs -text\n')
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 12\n'
    await writeFile(join(t.root, 'art.psd'), pointer)
    t.run('add', '-A')
    t.run('commit', '-qm', 'lfs')
    const made = await t.service().create({ source: t.root, requestId: 'request-0001' })
    expect(await readFile(join(made.path, 'art.psd'), 'utf8')).toBe(pointer)
    expect(made.unfiltered).toBe(1)
    expect(await t.ran()).toEqual([])
  })

  it('never runs a filter that only configuration seen from the new branch names', async () => {
    // From the source on main this driver does not exist; on latch/ the owner's global includeIf brings it in.
    const t = await setup()
    const included = join(t.base, 'branch.gitconfig')
    await writeFile(
      included,
      `[filter "branchonly"]\n\tsmudge = ${await t.trap('branch-only')}\n\tprocess = ${await t.trap('branch-only-process')}\n`,
    )
    await writeFile(join(t.home, '.gitconfig'), `[includeIf "onbranch:latch/**"]\n\tpath = ${included}\n`)
    await writeFile(join(t.root, '.gitattributes'), '* filter=branchonly\n')
    t.run('add', '-A')
    t.run('commit', '-qm', 'attributes')
    const made = await t.service().create({ source: t.root, requestId: 'request-0001' })
    expect(await t.ran()).toEqual([])
    expect(await readFile(join(made.path, 'a.txt'), 'utf8')).toBe('one\n')
    // a.txt and .gitattributes itself.
    expect(made.unfiltered).toBe(2)
  })

  it('takes nothing from the Host environment: inherited GIT_ variables name another repository, hooks and fsmonitor', async () => {
    const t = await setup()
    const other = await setup()
    const hooks = join(t.base, 'env-hooks')
    await mkdir(hooks)
    await writeFile(join(hooks, 'post-checkout'), `#!/bin/sh\nexec '${await t.trap('env-hook')}'\n`)
    await chmod(join(hooks, 'post-checkout'), 0o755)
    const inherited: Record<string, string> = {
      GIT_DIR: join(other.root, '.git'),
      GIT_WORK_TREE: other.root,
      GIT_COMMON_DIR: join(other.root, '.git'),
      GIT_INDEX_FILE: join(t.base, 'stray-index'),
      GIT_OBJECT_DIRECTORY: join(t.base, 'stray-objects'),
      GIT_CONFIG_PARAMETERS: `'core.hooksPath'='${hooks}'`,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: await t.trap('env-fsmonitor'),
      GIT_CONFIG_GLOBAL: join(t.base, 'stray-global'),
      GIT_EXEC_PATH: join(t.base, 'stray-exec'),
      GIT_LFS_SKIP_SMUDGE: '0',
    }
    await writeFile(inherited.GIT_CONFIG_GLOBAL!, `[filter "local"]\n\tsmudge = ${await t.trap('env-global')}\n`)
    const saved = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]))
    Object.assign(process.env, inherited)
    try {
      const made = await t.service().create({ source: t.root, requestId: 'request-0001' })
      expect(await readFile(join(made.path, 'a.txt'), 'utf8')).toBe('one\n')
      expect(t.registered()).toHaveLength(2)
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    expect(other.branches()).toEqual(['refs/heads/main'])
    expect(other.registered()).toEqual([`worktree ${other.root}`])
    expect(existsSync(join(t.base, 'stray-index'))).toBe(false)
    expect(await t.ran()).toEqual([])
  })

  describe('refuses, saying why and what to change, and writes nothing', () => {
    it('a filter driver whose name has = in it', async () => {
      const t = await setup()
      t.run('config', 'filter.a=b.smudge', await t.trap('equals'))
      await expect(t.service().create({ source: t.root, requestId: 'request-0001' })).rejects.toMatchObject({
        status: 409,
        code: 'worktree-filter-name',
        message: expect.stringContaining('改名或删除'),
      })
      await nothingLeft(t)
    })

    it('a filter driver whose name has a newline in it', async () => {
      // Git itself refuses to write one; a Git that lists one is refused all the same.
      const t = await setup()
      const binary = await wrapper(t.base, ' --list ', `printf 'local\\000filter.a\\nb.smudge\\000'; exit 0`)
      await expect(t.service({ git: binary }).create({ source: t.root, requestId: 'request-0001' })).rejects.toMatchObject({
        code: 'worktree-filter-name',
      })
      await nothingLeft(t)
    })

    it('includeIf in the repository configuration', async () => {
      const t = await setup()
      t.run('config', 'includeIf.onbranch:latch/**.path', join(t.base, 'never-read.gitconfig'))
      await expect(t.service().create({ source: t.root, requestId: 'request-0001' })).rejects.toMatchObject({
        code: 'worktree-include-if',
        message: expect.stringContaining('~/.gitconfig'),
      })
      await nothingLeft(t)
    })

    it('an LFS key that points at a program', async () => {
      for (const [key, value] of [
        ['lfs.customtransfer.mine.path', '/bin/sh'],
        ['lfs.extension.mine.smudge', '/bin/sh'],
      ] as const) {
        const t = await setup()
        t.run('config', key, value)
        await expect(t.service().create({ source: t.root, requestId: 'request-0001' })).rejects.toMatchObject({
          code: 'worktree-lfs-program',
        })
        await nothingLeft(t)
      }
    })

    it('a symlink as the worktree folder, a folder in it, or a parent', async () => {
      const t = await setup()
      const real = join(t.base, 'real')
      await mkdir(real)
      await symlink(real, t.worktreeRoot)
      await expect(t.service().create({ source: t.root, requestId: 'request-0001' })).rejects.toMatchObject({
        code: 'worktree-symlink',
        message: expect.stringContaining(t.worktreeRoot),
      })
      await expect(
        t.service({ root: join(t.worktreeRoot, 'below') }).create({ source: t.root, requestId: 'request-0002' }),
      ).rejects.toMatchObject({
        code: 'worktree-symlink',
      })
      expect(await readdir(real)).toEqual([])
      await rm(t.worktreeRoot)
      // The repository's own folder in the worktree folder.
      await mkdir(t.worktreeRoot)
      await symlink(real, join(t.worktreeRoot, `project-${sha256Hex(t.root).slice(0, 8)}`))
      await expect(t.service().create({ source: t.root, requestId: 'request-0003' })).rejects.toMatchObject({ code: 'worktree-symlink' })
      expect(await readdir(real)).toEqual([])
      expect(t.branches()).toEqual(['refs/heads/main'])
      expect(t.registered()).toEqual([`worktree ${t.root}`])
    })

    it('a worktree folder inside the repository or overlapping the Host data directory or a Latch directory', async () => {
      const t = await setup()
      await expect(
        t.service({ root: join(t.root, 'worktrees') }).create({ source: t.root, requestId: 'request-0001' }),
      ).rejects.toMatchObject({
        code: 'worktree-location',
      })
      await expect(
        t.service({ root: join(t.data, 'worktrees') }).create({ source: t.root, requestId: 'request-0002' }),
      ).rejects.toMatchObject({
        code: 'worktree-location',
      })
      await expect(t.service({ root: t.base }).create({ source: t.root, requestId: 'request-0003' })).rejects.toMatchObject({
        code: 'worktree-location',
      })
      const code = join(t.base, 'outer', 'latch')
      for (const root of [join(code, 'worktrees'), dirname(code)])
        await expect(t.service({ root, avoid: [code] }).base(t.root)).rejects.toMatchObject({
          code: 'worktree-location',
          message: expect.stringContaining('Latch 自己的目录'),
        })
      expect(t.branches()).toEqual(['refs/heads/main'])
      expect(t.registered()).toEqual([`worktree ${t.root}`])
    })

    it('a folder that is not the top of a repository, a repository with no commit, or no Git', async () => {
      const t = await setup()
      await mkdir(join(t.root, 'sub'))
      await expect(t.service().create({ source: join(t.root, 'sub'), requestId: 'request-0001' })).rejects.toMatchObject({
        code: 'worktree-not-repository',
      })
      const empty = join(t.base, 'empty')
      await mkdir(empty)
      execFileSync(git!, ['init', '-q'], { cwd: empty, env: { PATH: '/usr/bin:/bin', HOME: t.home, GIT_CONFIG_NOSYSTEM: '1' } })
      await expect(t.service().create({ source: empty, requestId: 'request-0002' })).rejects.toMatchObject({ code: 'worktree-no-commit' })
      await expect(
        new Worktrees({ root: t.worktreeRoot, dataDir: t.data, git: join(t.base, 'missing-git'), log: () => {} }).create({
          source: t.root,
          requestId: 'request-0003',
        }),
      ).rejects.toMatchObject({ code: 'worktree-no-git' })
      await nothingLeft(t)
    })
  })

  describe('rolls back every step when one fails', () => {
    it('when the checkout fails', async () => {
      const t = await setup()
      const logs: string[] = []
      const binary = await wrapper(t.base, ' reset ', 'exit 1')
      await expect(
        t.service({ git: binary, log: text => logs.push(text) }).create({ source: t.root, requestId: 'request-0001' }),
      ).rejects.toMatchObject({
        status: 500,
        code: 'worktree-failed',
        message: expect.stringContaining('已撤销'),
      })
      await nothingLeft(t)
      expect(logs).toEqual([])
    })

    it('when git worktree add reports a failure after making the branch and the worktree', async () => {
      const t = await setup()
      const binary = await wrapper(t.base, ' worktree add ', `'${git}' "$@"; exit 1`)
      await expect(t.service({ git: binary }).create({ source: t.root, requestId: 'request-0001' })).rejects.toMatchObject({
        code: 'worktree-failed',
        message: expect.stringContaining('git worktree add'),
      })
      await nothingLeft(t)
    })

    it('when configuration seen only from the new worktree names a filter it cannot empty', async () => {
      // Global includeIf is the owner's own and allowed; on the new branch it pulls in a driver Latch refuses.
      const t = await setup()
      const included = join(t.base, 'branch.gitconfig')
      await writeFile(included, `[filter "x=y"]\n\tsmudge = ${await t.trap('branch-filter')}\n`)
      await writeFile(join(t.home, '.gitconfig'), `[includeIf "onbranch:latch/**"]\n\tpath = ${included}\n`)
      await writeFile(join(t.root, '.gitattributes'), '* filter=x=y\n')
      t.run('add', '-A')
      t.run('commit', '-qm', 'attributes')
      await expect(t.service().create({ source: t.root, requestId: 'request-0001' })).rejects.toMatchObject({
        code: 'worktree-filter-name',
      })
      await nothingLeft(t)
      expect(await t.ran()).toEqual([])
    })

    it('when a file .worktreeinclude lists cannot be read', async () => {
      const t = await setup()
      await writeFile(join(t.root, '.gitignore'), '.env\n')
      await writeFile(join(t.root, '.worktreeinclude'), '.env\n')
      t.run('add', '-A')
      t.run('commit', '-qm', 'ignore')
      await writeFile(join(t.root, '.env'), 'SECRET=1\n')
      await chmod(join(t.root, '.env'), 0o000)
      await expect(t.service().create({ source: t.root, requestId: 'request-0001' })).rejects.toMatchObject({
        code: 'worktree-failed',
        message: expect.stringContaining('.env'),
      })
      await nothingLeft(t)
    })

    it('and says so when the rollback itself cannot finish', async () => {
      const t = await setup()
      const logs: string[] = []
      // The checkout fails, then so does removing the branch.
      const both = join(t.base, 'both.sh')
      await writeFile(both, `#!/bin/sh\ncase " $* " in\n  *' reset '*|*' update-ref '*) exit 1 ;;\nesac\nexec '${git}' "$@"\n`)
      await chmod(both, 0o755)
      const error = await t
        .service({ git: both, log: text => logs.push(text) })
        .create({ source: t.root, requestId: 'request-0001' })
        .catch(e => e)
      expect(error).toMatchObject({ code: 'worktree-rollback-failed' })
      expect(error.message).toMatch(/latch\/\d{8}-[0-9a-f]{4}/u)
      expect(logs).toHaveLength(1)
      // The worktree itself is gone; only the branch is left, named in the message.
      expect(t.registered()).toEqual([`worktree ${t.root}`])
      expect(t.branches()).toHaveLength(2)
    })
  })

  it('copies the ignored files .worktreeinclude matches, keeps existing ones and never follows a link', async () => {
    const t = await setup()
    await writeFile(join(t.root, '.gitignore'), '.env\n.env.*\nsecrets/\nlocal.json\nbuild/\n')
    await writeFile(
      join(t.root, '.worktreeinclude'),
      '# local settings\n.env\n.env.*\nsecrets/*.json\n!secrets/skip.json\nlocal.json\na.txt\nnotes.env\n',
    )
    await writeFile(join(t.root, 'local.json'), '{"committed":true}\n')
    t.run('add', '-A')
    t.run('add', '-f', 'local.json')
    t.run('commit', '-qm', 'settings')
    // Untracked again in the source, so it is listed; the new worktree has it from the commit.
    t.run('rm', '-q', '--cached', 'local.json')
    await writeFile(join(t.root, 'local.json'), '{"mine":true}\n')
    await writeFile(join(t.root, '.env'), 'TOKEN=1\n')
    await chmod(join(t.root, '.env'), 0o600)
    await mkdir(join(t.root, 'secrets'))
    await writeFile(join(t.root, 'secrets', 'a.json'), '{}\n')
    await chmod(join(t.root, 'secrets', 'a.json'), 0o755)
    await writeFile(join(t.root, 'secrets', 'skip.json'), '{}\n')
    await writeFile(join(t.root, 'notes.env'), 'not ignored\n')
    const outside = join(t.base, 'outside.txt')
    await writeFile(outside, 'outside\n')
    await symlink(outside, join(t.root, '.env.link'))
    await mkdir(join(t.root, 'build'))
    await symlink(t.base, join(t.root, 'build', 'up'))

    const made = await t.service().create({ source: t.root, requestId: 'request-0001' })
    expect(made.copied).toBe(2)
    expect(await readFile(join(made.path, '.env'), 'utf8')).toBe('TOKEN=1\n')
    expect((await lstat(join(made.path, '.env'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(made.path, 'secrets', 'a.json'), 'utf8')).toBe('{}\n')
    expect((await lstat(join(made.path, 'secrets', 'a.json'))).mode & 0o111).not.toBe(0)
    expect(existsSync(join(made.path, 'secrets', 'skip.json'))).toBe(false)
    expect(existsSync(join(made.path, 'notes.env'))).toBe(false)
    expect(existsSync(join(made.path, '.env.link'))).toBe(false)
    expect(existsSync(join(made.path, 'build'))).toBe(false)
    expect(await readFile(join(made.path, 'local.json'), 'utf8')).toBe('{"committed":true}\n')
    expect(await readFile(join(made.path, 'a.txt'), 'utf8')).toBe('one\n')
  })

  it('says where a worktree would start, or refuses as a start would, without writing anything', async () => {
    const t = await setup()
    const head = t.run('rev-parse', 'HEAD').trim()
    expect(await t.service().base(t.root)).toEqual({
      branch: 'main',
      commit: head,
      branches: [{ name: 'main', commit: head, checkedOut: true }],
    })
    t.run('checkout', '-q', '--detach')
    expect(await t.service().base(t.root)).toEqual({ commit: head, branches: [{ name: 'main', commit: head }] })
    t.run('config', 'includeIf.gitdir:/nowhere/.path', '/nowhere')
    await expect(t.service().base(t.root)).rejects.toMatchObject({ code: 'worktree-include-if' })
    await expect(t.service().base(join(t.base, 'home'))).rejects.toMatchObject({ code: 'worktree-not-repository' })
    await nothingLeft(t)
  })

  it('finds the worktree an earlier Host process made for a retried request', async () => {
    const t = await setup()
    const made = await t.service({ suffix: () => 'aaaa' }).create({ source: t.root, requestId: 'request-0001' })
    const again = await t.service({ suffix: () => 'bbbb' }).create({ source: t.root, requestId: 'request-0001' })
    expect(again).toEqual({ path: made.path, branch: made.branch, base: '', copied: 0 })
    expect(t.registered()).toHaveLength(2)
  })

  it('lists a worktree as starting until its session owns it, and keeps trusting it on another branch or none', async () => {
    const t = await setup()
    const worktrees = t.service()
    const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    expect(worktrees.starting()).toEqual([made.path])
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    expect(worktrees.starting()).toEqual([])
    const inside = (...args: string[]) => execFileSync(git!, ['-C', made.path, ...args], { env: { PATH: '/usr/bin:/bin', HOME: t.home } })
    inside('checkout', '-q', '-b', 'feature')
    expect(await worktrees.sessionOf(made.path)).toBe('session-1')
    inside('checkout', '-q', '--detach')
    expect(await worktrees.sessionOf(made.path)).toBe('session-1')
  })

  describe('discards the worktree of a start that did not happen', () => {
    it('with its branch, while nothing was done in it', async () => {
      const t = await setup()
      const worktrees = t.service()
      const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
      expect(await worktrees.discard(made, 'request-0001')).toBe(true)
      expect(worktrees.starting()).toEqual([])
      await nothingLeft(t)
      // The same request then gets a new one.
      const next = await worktrees.create({ source: t.root, requestId: 'request-0001' })
      expect(existsSync(next.path)).toBe(true)
    })

    it('never once a file in it changed, a session owns it, or another request made it', async () => {
      const t = await setup()
      const worktrees = t.service()
      const changed = await worktrees.create({ source: t.root, requestId: 'request-0001' })
      await writeFile(join(changed.path, 'a.txt'), 'changed\n')
      expect(await worktrees.discard(changed, 'request-0001')).toBe(false)
      const added = await worktrees.create({ source: t.root, requestId: 'request-0002' })
      await writeFile(join(added.path, 'new.txt'), 'new\n')
      expect(await worktrees.discard(added, 'request-0002')).toBe(false)
      const owned = await worktrees.create({ source: t.root, requestId: 'request-0003' })
      await worktrees.bind(owned.path, 'request-0003', 'session-3')
      expect(await worktrees.discard(owned, 'request-0003')).toBe(false)
      const other = await worktrees.create({ source: t.root, requestId: 'request-0004' })
      expect(await worktrees.discard(other, 'request-0005')).toBe(false)
      for (const kept of [changed, added, owned, other]) expect(existsSync(kept.path)).toBe(true)
      expect(t.branches()).toHaveLength(5)
    })

    it('keeping its branch when it moved on', async () => {
      const t = await setup()
      const worktrees = t.service()
      const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
      t.run('update-ref', `refs/heads/${made.branch}`, t.run('commit-tree', '-m', 'other', `${made.base}^{tree}`).trim())
      // The worktree's files still match its index, so Git lets it go; the branch names other work now.
      expect(await worktrees.discard(made, 'request-0001')).toBe(true)
      expect(existsSync(made.path)).toBe(false)
      expect(t.branches()).toContain(`refs/heads/${made.branch}`)
    })
  })
})

const hookGit = configHookGit()
describe.skipIf(!hookGit)('hooks from configuration (Git 2.54 and later)', () => {
  it('never runs one, including one only configuration seen from the new branch names', async () => {
    const t = await setup()
    t.run('config', 'hook.refs.event', 'reference-transaction')
    t.run('config', 'hook.refs.command', await t.trap('refs-hook'))
    t.run('config', 'hook.index.event', 'post-index-change')
    t.run('config', 'hook.index.command', await t.trap('index-hook'))
    const included = join(t.base, 'branch.gitconfig')
    await writeFile(
      included,
      `[hook "branch"]\n\tevent = post-checkout\n\tevent = post-index-change\n\tcommand = ${await t.trap('branch-hook')}\n`,
    )
    await writeFile(join(t.home, '.gitconfig'), `[includeIf "onbranch:latch/**"]\n\tpath = ${included}\n`)
    const made = await t.service({ git: hookGit! }).create({ source: t.root, requestId: 'request-0001' })
    expect(await readFile(join(made.path, 'a.txt'), 'utf8')).toBe('one\n')
    expect(await t.ran()).toEqual([])
  })

  it('refuses a hook whose name has = in it, and writes nothing', async () => {
    const t = await setup()
    await writeFile(
      join(t.root, '.git', 'config'),
      `${await readFile(join(t.root, '.git', 'config'), 'utf8')}[hook "a=b"]\n\tevent = reference-transaction\n\tcommand = ${await t.trap('equals-hook')}\n`,
    )
    await expect(t.service({ git: hookGit! }).create({ source: t.root, requestId: 'request-0001' })).rejects.toMatchObject({
      status: 409,
      code: 'worktree-hook-name',
    })
    await nothingLeft(t)
    expect(await t.ran()).toEqual([])
  })
})

describe.skipIf(!git)('worktree start points', () => {
  /** A second branch one commit past main, and the commit IDs of both. */
  async function branched(t: Awaited<ReturnType<typeof setup>>) {
    const main = t.run('rev-parse', 'HEAD').trim()
    t.run('checkout', '-q', '-b', 'feature/x')
    await writeFile(join(t.root, 'b.txt'), 'two\n')
    t.run('add', '-A')
    t.run('commit', '-qm', 'two')
    const feature = t.run('rev-parse', 'HEAD').trim()
    t.run('checkout', '-q', 'main')
    return { main, feature }
  }

  it('starts a new latch/ branch from another local branch or a commit, and lists the branches with the checked-out one marked', async () => {
    const t = await setup()
    const { main, feature } = await branched(t)
    const worktrees = t.service()
    const base = await worktrees.base(t.root)
    expect(base.branches?.map(item => [item.name, item.checkedOut === true]).toSorted()).toEqual([
      ['feature/x', false],
      ['main', true],
    ])
    const fromBranch = await worktrees.create({ source: t.root, requestId: 'request-0001', start: { from: 'commit', ref: 'feature/x' } })
    expect(fromBranch.base).toBe(feature)
    expect(fromBranch.branch).toMatch(WORKTREE_BRANCH)
    expect(await readFile(join(fromBranch.path, 'b.txt'), 'utf8')).toBe('two\n')
    const fromCommit = await worktrees.create({
      source: t.root,
      requestId: 'request-0002',
      start: { from: 'commit', ref: main.slice(0, 9) },
    })
    expect(fromCommit.base).toBe(main)
    expect(existsSync(join(fromCommit.path, 'b.txt'))).toBe(false)
    // The branches they came from are untouched.
    expect(t.run('rev-parse', 'refs/heads/feature/x').trim()).toBe(feature)
  })

  it('refuses a name outside the fixed rule or Git’s, and a start point that is not there, writing nothing', async () => {
    const t = await setup()
    const worktrees = t.service()
    for (const ref of ['-x', 'refs/heads/main', 'HEAD', 'a..b', 'a b', 'x.lock', 'origin/main~1'])
      await expect(
        worktrees.create({ source: t.root, requestId: `request-${ref.length}0000`, start: { from: 'branch', branch: ref } }),
      ).rejects.toMatchObject({
        code: 'worktree-branch-name',
      })
    await expect(
      worktrees.create({ source: t.root, requestId: 'request-1001', start: { from: 'commit', ref: 'nope' } }),
    ).rejects.toMatchObject({
      code: 'worktree-start-missing',
    })
    await expect(
      worktrees.create({ source: t.root, requestId: 'request-1002', start: { from: 'commit', ref: 'deadbeef00' } }),
    ).rejects.toMatchObject({
      code: 'worktree-start-missing',
    })
    await expect(
      worktrees.create({ source: t.root, requestId: 'request-1003', start: { from: 'branch', branch: 'gone' } }),
    ).rejects.toMatchObject({
      code: 'worktree-branch-missing',
    })
    await nothingLeft(t)
  })

  it('checks out an existing branch, refuses one checked out elsewhere, and never deletes it', async () => {
    const t = await setup()
    const { feature } = await branched(t)
    const worktrees = t.service()
    await expect(
      worktrees.create({ source: t.root, requestId: 'request-0001', start: { from: 'branch', branch: 'main' } }),
    ).rejects.toMatchObject({
      code: 'worktree-branch-checked-out',
      message: expect.stringContaining(t.root),
    })
    const made = await worktrees.create({ source: t.root, requestId: 'request-0002', start: { from: 'branch', branch: 'feature/x' } })
    expect(made).toMatchObject({ branch: 'feature/x', base: feature, existingBranch: true })
    expect(t.run('-C', made.path, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/feature/x')
    // The same request gets the same one, also from a new Host process.
    expect(await worktrees.create({ source: t.root, requestId: 'request-0002', start: { from: 'branch', branch: 'feature/x' } })).toEqual(
      made,
    )
    // A second checkout of it is refused while this one holds it.
    await expect(
      worktrees.create({ source: t.root, requestId: 'request-0003', start: { from: 'branch', branch: 'feature/x' } }),
    ).rejects.toMatchObject({
      code: 'worktree-branch-checked-out',
    })
    // A start that did not happen removes the worktree and keeps the branch, though it still names the commit it started at.
    expect(await worktrees.discard(made, 'request-0002')).toBe(true)
    expect(t.run('rev-parse', 'refs/heads/feature/x').trim()).toBe(feature)
    expect(existsSync(made.path)).toBe(false)
  })

  it('reuses a leftover worktree of the project, not one its session holds, with the same answer for a retry', async () => {
    const t = await setup()
    const worktrees = t.service()
    const first = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    await worktrees.bind(first.path, 'request-0001', 'session-1')
    await writeFile(join(first.path, 'work.txt'), 'in progress\n')
    const name = basename(first.path)
    const held = async (sessionId?: string) => (sessionId === 'session-1' ? 'held by session-1' : undefined)
    await expect(
      worktrees.create({ source: t.root, requestId: 'request-0002', start: { from: 'reuse', name }, held }),
    ).rejects.toMatchObject({ code: 'worktree-reuse-held', message: 'held by session-1' })
    const reused = await worktrees.create({
      source: t.root,
      requestId: 'request-0003',
      start: { from: 'reuse', name },
      held: async () => undefined,
    })
    expect(reused).toMatchObject({ path: first.path, branch: first.branch, reused: true })
    expect(await readFile(join(first.path, 'work.txt'), 'utf8')).toBe('in progress\n')
    expect(await worktrees.sessionOf(first.path)).toBeUndefined()
    expect(worktrees.starting()).toContain(first.path)
    // A new Host process gets it again for the same request, and nobody else does.
    expect(await t.service().create({ source: t.root, requestId: 'request-0003', start: { from: 'reuse', name } })).toMatchObject({
      path: first.path,
    })
    await expect(worktrees.create({ source: t.root, requestId: 'request-0004', start: { from: 'reuse', name } })).rejects.toMatchObject({
      code: 'worktree-reuse-busy',
    })
    await worktrees.bind(first.path, 'request-0003', 'session-2')
    expect(await worktrees.sessionOf(first.path)).toBe('session-2')
    // A failed start never removes a reused worktree.
    expect(await worktrees.discard(reused, 'request-0003')).toBe(false)
    expect(existsSync(first.path)).toBe(true)
    // Only Latch's, of this project, with a valid marker.
    await expect(
      worktrees.create({ source: t.root, requestId: 'request-0005', start: { from: 'reuse', name: '20200101-0000' } }),
    ).rejects.toMatchObject({
      code: 'worktree-reuse-unknown',
    })
    const other = join(dirname(first.path), '20200101-0000')
    t.run('worktree', 'add', '-q', '-b', 'mine', other)
    await expect(
      worktrees.create({ source: t.root, requestId: 'request-0006', start: { from: 'reuse', name: '20200101-0000' } }),
    ).rejects.toMatchObject({
      code: 'worktree-reuse-unknown',
    })
    expect((await worktrees.list(t.root)).map(entry => [entry.name, entry.sessionId])).toEqual([[name, 'session-2']])
  })
})

/** What the person confirms in the dialog: how many files go, and the digest of the listing they saw. */
async function confirmed(worktrees: Worktrees, path: string) {
  const facts = await worktrees.inventory(path)
  return { discard: facts.files + facts.ignored, digest: facts.digest }
}

describe.skipIf(!git)('removing a worktree', () => {
  const noAudit = async () => {}

  it('removes a clean one without --force and deletes its merged branch with -d', async () => {
    const t = await setup()
    const worktrees = t.service()
    const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    expect(await worktrees.inventory(made.path)).toEqual({
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      name: basename(made.path),
      branch: made.branch,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      files: 0,
      ignored: 0,
      insertions: 0,
      deletions: 0,
      unpushed: 0,
      ownBranch: true,
      merged: { into: 'default', ref: 'main' },
    })
    const audits: unknown[] = []
    const removed = await worktrees.remove(made.path, { deleteBranch: true, audit: async facts => void audits.push(facts) })
    expect(removed).toMatchObject({ branch: 'deleted', branchName: made.branch })
    expect(audits).toHaveLength(1)
    await nothingLeft(t)
  })

  it('refuses uncommitted files until the count is confirmed, then forces; an unmerged branch stays', async () => {
    const t = await setup()
    const worktrees = t.service()
    const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    const inside = (...args: string[]) => t.run('-C', made.path, ...args)
    await writeFile(join(made.path, 'c.txt'), 'committed\n')
    inside('add', 'c.txt')
    inside('commit', '-qm', 'agent work')
    await writeFile(join(made.path, 'a.txt'), 'one\nchanged\n')
    await writeFile(join(made.path, 'staged.txt'), 'staged\n')
    inside('add', 'staged.txt')
    await writeFile(join(made.path, 'new.txt'), 'untracked\n')
    const facts = await worktrees.inventory(made.path)
    expect(facts).toMatchObject({
      staged: 1,
      unstaged: 1,
      untracked: 1,
      files: 3,
      insertions: 2,
      deletions: 0,
      unpushed: 1,
      ownBranch: true,
    })
    await expect(worktrees.remove(made.path, { audit: noAudit })).rejects.toMatchObject({ code: 'worktree-dirty', details: { files: 3 } })
    await expect(worktrees.remove(made.path, { discard: 2, audit: noAudit })).rejects.toMatchObject({ code: 'worktree-dirty' })
    expect(existsSync(join(made.path, 'new.txt'))).toBe(true)
    const removed = await worktrees.remove(made.path, { ...(await confirmed(worktrees, made.path)), deleteBranch: true, audit: noAudit })
    expect(removed).toMatchObject({ branch: 'kept', branchName: made.branch })
    expect(existsSync(made.path)).toBe(false)
    expect(t.branches()).toContain(`refs/heads/${made.branch}`)
    expect(t.registered()).toEqual([`worktree ${t.root}`])
  })

  it('writes nothing when the audit record fails, and runs no hook or filter the repository names', async () => {
    const t = await setup()
    const worktrees = t.service()
    const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    await writeFile(join(t.root, '.git', 'hooks', 'reference-transaction'), `#!/bin/sh\nexec '${await t.trap('hook')}'\n`)
    await chmod(join(t.root, '.git', 'hooks', 'reference-transaction'), 0o755)
    t.run('config', 'filter.local.clean', await t.trap('clean'))
    t.run('config', 'filter.local.required', 'true')
    t.run('config', 'core.fsmonitor', await t.trap('fsmonitor'))
    await writeFile(join(made.path, '.gitattributes'), '*.txt filter=local\n')
    await writeFile(join(made.path, 'a.txt'), 'changed\n')
    await expect(
      worktrees.remove(made.path, {
        ...(await confirmed(worktrees, made.path)),
        audit: async () => {
          throw new Error('audit down')
        },
      }),
    ).rejects.toThrow('audit down')
    expect(existsSync(join(made.path, 'a.txt'))).toBe(true)
    expect(t.registered()).toHaveLength(2)
    await worktrees.remove(made.path, { ...(await confirmed(worktrees, made.path)), audit: noAudit })
    expect(existsSync(made.path)).toBe(false)
    expect(await t.ran()).toEqual([])
  })

  it('never touches a worktree Latch did not make, an existing branch it checked out, or one being made', async () => {
    const t = await setup()
    const worktrees = t.service()
    const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    const other = join(dirname(made.path), '20200101-0000')
    t.run('worktree', 'add', '-q', '-b', 'mine', other)
    await expect(worktrees.inventory(other)).rejects.toMatchObject({ code: 'worktree-not-found' })
    await expect(worktrees.remove(other, { audit: noAudit })).rejects.toMatchObject({ code: 'worktree-not-found' })
    await expect(worktrees.remove(t.root, { audit: noAudit })).rejects.toMatchObject({ code: 'worktree-not-found' })
    expect(existsSync(other)).toBe(true)
    // Still being made into a session: refused.
    await expect(worktrees.remove(made.path, { audit: noAudit })).rejects.toMatchObject({ code: 'worktree-busy' })
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    await worktrees.remove(made.path, { audit: noAudit })

    t.run('branch', 'kept-branch')
    const checkedOut = await worktrees.create({
      source: t.root,
      requestId: 'request-0002',
      start: { from: 'branch', branch: 'kept-branch' },
    })
    await worktrees.bind(checkedOut.path, 'request-0002', 'session-2')
    expect((await worktrees.inventory(checkedOut.path)).ownBranch).toBe(false)
    expect(await worktrees.remove(checkedOut.path, { audit: noAudit })).toMatchObject({ branch: 'none' })
    expect(t.branches()).toContain('refs/heads/kept-branch')
  })

  it('counts ignored files into the confirmation, so an edited .env copied by .worktreeinclude is never deleted unasked', async () => {
    const t = await setup()
    await writeFile(join(t.root, '.gitignore'), '.env\n')
    await writeFile(join(t.root, '.worktreeinclude'), '.env\n')
    t.run('add', '.gitignore', '.worktreeinclude')
    t.run('commit', '-qm', 'ignore')
    await writeFile(join(t.root, '.env'), 'A=1\n')
    const worktrees = t.service()
    const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    await writeFile(join(made.path, '.env'), 'A=edited\n')
    expect(await worktrees.inventory(made.path)).toMatchObject({ files: 0, ignored: 1, ignoredExample: '.env' })
    // Git would delete it without --force: Latch asks first.
    await expect(worktrees.remove(made.path, { audit: noAudit })).rejects.toMatchObject({ code: 'worktree-dirty', details: { files: 1 } })
    expect(await readFile(join(made.path, '.env'), 'utf8')).toBe('A=edited\n')
    await worktrees.remove(made.path, { ...(await confirmed(worktrees, made.path)), audit: noAudit })
    expect(existsSync(made.path)).toBe(false)
  })

  it('refuses while an untracked or ignored folder is another repository, naming it', async () => {
    const t = await setup()
    await writeFile(join(t.root, '.gitignore'), 'vendor/\n')
    t.run('add', '.gitignore')
    t.run('commit', '-qm', 'ignore')
    const worktrees = t.service()
    const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    for (const folder of ['vendor/lib', 'tools/own']) {
      await mkdir(join(made.path, folder), { recursive: true })
      t.run('-C', join(made.path, folder), 'init', '-q')
      await writeFile(join(made.path, folder, 'f'), 'x')
      t.run('-C', join(made.path, folder), 'add', 'f')
      t.run('-C', join(made.path, folder), 'commit', '-qm', 'nested work')
    }
    const facts = await worktrees.inventory(made.path)
    expect(['vendor/lib', 'tools/own']).toContain(facts.nested)
    await expect(worktrees.remove(made.path, { discard: facts.files + facts.ignored, audit: noAudit })).rejects.toMatchObject({
      code: 'worktree-nested-repository',
    })
    expect(existsSync(join(made.path, 'vendor', 'lib', '.git'))).toBe(true)
    await rm(join(made.path, 'tools'), { recursive: true })
    expect((await worktrees.inventory(made.path)).nested).toBe('vendor/lib')
    await rm(join(made.path, 'vendor'), { recursive: true })
    await worktrees.remove(made.path, { audit: noAudit })
  })

  it('refuses while a submodule is checked out in it', async () => {
    const t = await setup()
    const sub = join(t.base, 'sub')
    await mkdir(sub)
    t.run('-C', sub, 'init', '-q')
    await writeFile(join(sub, 's.txt'), 's\n')
    t.run('-C', sub, 'add', 's.txt')
    t.run('-C', sub, 'commit', '-qm', 'sub')
    const worktrees = t.service()
    const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    t.run('-C', made.path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'lib')
    await writeFile(join(made.path, 'lib', 's.txt'), 'changed\n')
    const facts = await worktrees.inventory(made.path)
    expect(facts.submodules).toBe(1)
    await expect(worktrees.remove(made.path, { discard: facts.files + facts.ignored, audit: noAudit })).rejects.toMatchObject({
      code: 'worktree-submodules',
    })
    expect(await readFile(join(made.path, 'lib', 's.txt'), 'utf8')).toBe('changed\n')
  })

  describe('the branch matches what the dialog said', () => {
    /** A worktree whose branch has one commit of its own. */
    async function withCommit(t: Awaited<ReturnType<typeof setup>>, worktrees: Worktrees) {
      const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
      await worktrees.bind(made.path, 'request-0001', 'session-1')
      await writeFile(join(made.path, 'c.txt'), 'work\n')
      t.run('-C', made.path, 'add', 'c.txt')
      t.run('-C', made.path, 'commit', '-qm', 'agent work')
      return { made, tip: t.run('-C', made.path, 'rev-parse', 'HEAD').trim() }
    }

    it('keeps a branch pushed to its remote but not merged, even when asked to delete', async () => {
      const t = await setup()
      const remote = join(t.base, 'remote.git')
      t.run('init', '-q', '--bare', remote)
      t.run('remote', 'add', 'origin', remote)
      t.run('push', '-q', 'origin', 'main')
      t.run('remote', 'set-head', 'origin', 'main')
      const worktrees = t.service()
      const { made, tip } = await withCommit(t, worktrees)
      t.run('-C', made.path, 'push', '-q', '-u', 'origin', made.branch)
      const facts = await worktrees.inventory(made.path)
      expect(facts).toMatchObject({ ownBranch: true, upstream: `origin/${made.branch}`, ahead: 0 })
      expect(facts.merged).toBeUndefined()
      expect(await worktrees.remove(made.path, { deleteBranch: true, audit: noAudit })).toMatchObject({ branch: 'kept' })
      expect(t.run('rev-parse', `refs/heads/${made.branch}`).trim()).toBe(tip)
    })

    it('keeps a local-only branch whose commits are also on another unmerged branch', async () => {
      const t = await setup()
      const worktrees = t.service()
      const { made, tip } = await withCommit(t, worktrees)
      t.run('branch', 'other', made.branch)
      expect((await worktrees.inventory(made.path)).merged).toBeUndefined()
      expect(await worktrees.remove(made.path, { deleteBranch: true, audit: noAudit })).toMatchObject({ branch: 'kept' })
      expect(t.run('rev-parse', `refs/heads/${made.branch}`).trim()).toBe(tip)
    })

    it('deletes a merged branch only when the dialog said so', async () => {
      const t = await setup()
      const worktrees = t.service()
      const { made } = await withCommit(t, worktrees)
      t.run('merge', '-q', '--ff-only', made.branch)
      expect((await worktrees.inventory(made.path)).merged).toEqual({ into: 'default', ref: 'main' })
      expect(await worktrees.remove(made.path, { deleteBranch: true, audit: noAudit })).toMatchObject({ branch: 'deleted' })
      expect(t.branches()).toEqual(['refs/heads/main'])
    })

    it('keeps a merged branch when the dialog did not say it goes', async () => {
      const t = await setup()
      const worktrees = t.service()
      const { made } = await withCommit(t, worktrees)
      t.run('merge', '-q', '--ff-only', made.branch)
      expect(await worktrees.remove(made.path, { audit: noAudit })).toMatchObject({ branch: 'kept' })
      expect(t.branches()).toContain(`refs/heads/${made.branch}`)
    })

    it('never counts a remote HEAD that names the branch itself, as a first push to an empty repository makes it', async () => {
      const t = await setup()
      const remote = join(t.base, 'empty.git')
      t.run('init', '-q', '--bare', remote)
      t.run('remote', 'add', 'origin', remote)
      const worktrees = t.service()
      const { made, tip } = await withCommit(t, worktrees)
      t.run('-C', made.path, 'push', '-q', '-u', 'origin', made.branch)
      t.run('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${made.branch}`)
      // A remote whose name holds a slash: refs/remotes/a/HEAD naming a/b's copy of the branch.
      t.run('update-ref', `refs/remotes/a/b/${made.branch}`, tip)
      t.run('symbolic-ref', 'refs/remotes/a/HEAD', `refs/remotes/a/b/${made.branch}`)
      expect((await worktrees.inventory(made.path)).merged).toBeUndefined()
      expect(await worktrees.remove(made.path, { deleteBranch: true, audit: noAudit })).toMatchObject({ branch: 'kept' })
      expect(t.run('rev-parse', `refs/heads/${made.branch}`).trim()).toBe(tip)
    })

    it('takes exactly main, master or init.defaultBranch, not a branch under main/', async () => {
      const t = await setup()
      const worktrees = t.service()
      const { made, tip } = await withCommit(t, worktrees)
      t.run('branch', '-m', 'main', 'trunk')
      t.run('branch', 'main/wip', tip)
      expect((await worktrees.inventory(made.path)).merged).toBeUndefined()
      t.run('config', 'init.defaultBranch', 'trunk')
      t.run('merge', '-q', '--ff-only', made.branch)
      expect((await worktrees.inventory(made.path)).merged).toEqual({ into: 'default', ref: 'trunk' })
    })

    it('deletes a branch with no commits of its own past where it started, and keeps one with commits', async () => {
      const t = await setup()
      t.run('checkout', '-q', '-b', 'feature/x')
      await writeFile(join(t.root, 'f.txt'), 'feature\n')
      t.run('add', 'f.txt')
      t.run('commit', '-qm', 'feature')
      t.run('checkout', '-q', 'main')
      const worktrees = t.service()
      const start = { from: 'commit' as const, ref: 'feature/x' }
      const idle = await worktrees.create({ source: t.root, requestId: 'request-0001', start })
      await worktrees.bind(idle.path, 'request-0001', 'session-1')
      expect((await worktrees.inventory(idle.path)).merged).toEqual({ into: 'start' })
      expect(await worktrees.remove(idle.path, { deleteBranch: true, audit: noAudit })).toMatchObject({ branch: 'deleted' })
      const busy = await worktrees.create({ source: t.root, requestId: 'request-0002', start })
      await worktrees.bind(busy.path, 'request-0002', 'session-2')
      await writeFile(join(busy.path, 'c.txt'), 'work\n')
      t.run('-C', busy.path, 'add', 'c.txt')
      t.run('-C', busy.path, 'commit', '-qm', 'agent work')
      expect((await worktrees.inventory(busy.path)).merged).toBeUndefined()
      expect(await worktrees.remove(busy.path, { deleteBranch: true, audit: noAudit })).toMatchObject({ branch: 'kept' })
    })

    it('refuses to delete a branch that is a symbolic ref, and never deletes what it points at', async () => {
      const t = await setup()
      const worktrees = t.service()
      const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
      await worktrees.bind(made.path, 'request-0001', 'session-1')
      const main = t.run('rev-parse', 'refs/heads/main').trim()
      t.run('symbolic-ref', `refs/heads/${made.branch}`, 'refs/heads/main')
      expect(await worktrees.remove(made.path, { deleteBranch: true, audit: noAudit })).toMatchObject({ branch: 'kept' })
      expect(t.run('rev-parse', 'refs/heads/main').trim()).toBe(main)
      expect(t.run('symbolic-ref', `refs/heads/${made.branch}`).trim()).toBe('refs/heads/main')
    })

    it('never deletes what the branch points at when it turns symbolic just before the delete', async () => {
      const t = await setup()
      const main = t.run('rev-parse', 'refs/heads/main').trim()
      // Another branch than the one the delete verifies: only --no-deref keeps the delete from following the link to it.
      t.run('branch', 'keepme', main)
      const turning = await wrapper(
        t.base,
        '--stdin',
        `'${git}' -C '${t.root}' symbolic-ref "refs/heads/$(cat '${t.base}/branch')" refs/heads/keepme`,
      )
      const worktrees = t.service({ git: turning })
      const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
      await writeFile(join(t.base, 'branch'), made.branch)
      await worktrees.bind(made.path, 'request-0001', 'session-1')
      await worktrees.remove(made.path, { deleteBranch: true, audit: noAudit })
      expect(t.run('rev-parse', 'refs/heads/main').trim()).toBe(main)
      expect(t.run('rev-parse', 'refs/heads/keepme').trim()).toBe(main)
    })

    it('keeps a branch whose marker claims a later start, or whose start no ref holds any more', async () => {
      const t = await setup()
      const worktrees = t.service()
      const { made, tip } = await withCommit(t, worktrees)
      const marker = join(t.root, '.git', 'worktrees', basename(made.path), 'latch-session.json')
      await writeFile(marker, JSON.stringify({ ...JSON.parse(await readFile(marker, 'utf8')), base: tip }))
      expect((await worktrees.inventory(made.path)).merged).toBeUndefined()
      expect(await worktrees.remove(made.path, { deleteBranch: true, audit: noAudit })).toMatchObject({ branch: 'kept' })
      expect(t.run('rev-parse', `refs/heads/${made.branch}`).trim()).toBe(tip)

      t.run('checkout', '-q', '-b', 'feature/gone')
      await writeFile(join(t.root, 'g.txt'), 'only here\n')
      t.run('add', 'g.txt')
      t.run('commit', '-qm', 'unpushed feature')
      t.run('checkout', '-q', 'main')
      const orphan = await worktrees.create({ source: t.root, requestId: 'request-0009', start: { from: 'commit', ref: 'feature/gone' } })
      await worktrees.bind(orphan.path, 'request-0009', 'session-9')
      t.run('branch', '-D', 'feature/gone')
      expect((await worktrees.inventory(orphan.path)).merged).toBeUndefined()
      expect(await worktrees.remove(orphan.path, { deleteBranch: true, audit: noAudit })).toMatchObject({ branch: 'kept' })
      expect(t.branches()).toContain(`refs/heads/${orphan.branch}`)
    })

    it('keeps the branch when the default branch moves between the check and the delete', async () => {
      const t = await setup()
      const other = t.run('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'elsewhere').trim()
      const moving = await wrapper(t.base, '--stdin', `'${git}' -C '${t.root}' update-ref refs/heads/main ${other}`)
      const worktrees = t.service({ git: moving })
      const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
      await worktrees.bind(made.path, 'request-0001', 'session-1')
      expect((await worktrees.inventory(made.path)).merged).toEqual({ into: 'default', ref: 'main' })
      expect(await worktrees.remove(made.path, { deleteBranch: true, audit: noAudit })).toMatchObject({ branch: 'kept' })
      expect(t.branches()).toContain(`refs/heads/${made.branch}`)
      expect(t.run('rev-parse', 'refs/heads/main').trim()).toBe(other)
    })

    it('keeps the unmerged branch of a worktree left on a detached HEAD', async () => {
      const t = await setup()
      const worktrees = t.service()
      const { made, tip } = await withCommit(t, worktrees)
      t.run('-C', made.path, 'checkout', '-q', '--detach')
      t.run('branch', 'other', made.branch)
      const facts = await worktrees.inventory(made.path)
      expect(facts.branch).toBeUndefined()
      expect(facts).toMatchObject({ ownBranch: true })
      expect(facts.merged).toBeUndefined()
      expect(await worktrees.remove(made.path, { deleteBranch: true, audit: noAudit })).toMatchObject({ branch: 'kept' })
      expect(t.run('rev-parse', `refs/heads/${made.branch}`).trim()).toBe(tip)
    })
  })

  it('keeps a branch whose commits only a detached HEAD in the project folder reaches', async () => {
    const t = await setup()
    const worktrees = t.service()
    const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    await writeFile(join(made.path, 'c.txt'), 'work\n')
    t.run('-C', made.path, 'add', 'c.txt')
    t.run('-C', made.path, 'commit', '-qm', 'agent work')
    const tip = t.run('-C', made.path, 'rev-parse', 'HEAD').trim()
    // The project folder sits on that commit, detached: `branch -d` would call the branch merged.
    t.run('checkout', '-q', '--detach', tip)
    expect(await worktrees.remove(made.path, { deleteBranch: true, audit: noAudit })).toMatchObject({ branch: 'kept' })
    expect(t.run('rev-parse', `refs/heads/${made.branch}`).trim()).toBe(tip)
  })

  it('counts the files under an ignored folder and names it, and refuses, naming the folder, past the scan limit', async () => {
    const t = await setup()
    await writeFile(join(t.root, '.gitignore'), '.env\ndata/\nbig/\nvendor/\n')
    t.run('add', '.gitignore')
    t.run('commit', '-qm', 'ignore')
    const worktrees = t.service({ scanLimit: 100 })
    const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    await mkdir(join(made.path, 'data'))
    for (let i = 0; i < 50; i++) await writeFile(join(made.path, 'data', `rec${i}.db`), 'user data')
    await writeFile(join(made.path, '.env'), 'A=1\n')
    expect(await worktrees.inventory(made.path)).toMatchObject({ ignored: 51, ignoredFolders: [{ path: 'data/', files: 50 }] })
    // Past the limit, even with a repository further on, nothing goes unchecked.
    await mkdir(join(made.path, 'big'))
    for (let i = 0; i < 120; i++) await writeFile(join(made.path, 'big', `f${i}`), '')
    await mkdir(join(made.path, 'vendor', 'lib'), { recursive: true })
    t.run('-C', join(made.path, 'vendor', 'lib'), 'init', '-q')
    const facts = await worktrees.inventory(made.path)
    expect(facts.tooLarge).toBeDefined()
    await expect(worktrees.remove(made.path, { ...(await confirmed(worktrees, made.path)), audit: noAudit })).rejects.toMatchObject({
      code: 'worktree-too-large',
      details: { folder: facts.tooLarge },
    })
    expect(existsSync(join(made.path, 'vendor', 'lib', '.git'))).toBe(true)
  })

  it('binds the confirmation to the files shown: a swap with the same count is refused as changed', async () => {
    const t = await setup()
    const worktrees = t.service()
    const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    await writeFile(join(made.path, 'notes.txt'), 'shown\n')
    const shown = await confirmed(worktrees, made.path)
    await rm(join(made.path, 'notes.txt'))
    await writeFile(join(made.path, 'other.txt'), 'appeared after the dialog opened\n')
    await expect(worktrees.remove(made.path, { ...shown, audit: noAudit })).rejects.toMatchObject({ code: 'worktree-changed' })
    expect(existsSync(join(made.path, 'other.txt'))).toBe(true)
    await worktrees.remove(made.path, { ...(await confirmed(worktrees, made.path)), audit: noAudit })
    expect(existsSync(made.path)).toBe(false)
  })

  /** A repository with one commit, to add as a submodule. */
  async function subRepository(t: Awaited<ReturnType<typeof setup>>, name: string) {
    const sub = join(t.base, name)
    await mkdir(sub)
    t.run('-C', sub, 'init', '-q')
    await writeFile(join(sub, 's.txt'), 's\n')
    t.run('-C', sub, 'add', 's.txt')
    t.run('-C', sub, 'commit', '-qm', 'sub')
    return sub
  }

  it('refuses while a deinitialised submodule’s clone holds a reflog-only commit, and never deletes it itself', async () => {
    const t = await setup()
    const sub = await subRepository(t, 'sub')
    const worktrees = t.service()
    const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    t.run('-C', made.path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'mod')
    t.run('-C', made.path, 'commit', '-qm', 'add submodule')
    const inside = join(made.path, 'mod')
    t.run('-C', inside, 'checkout', '-q', '--detach')
    t.run('-C', inside, 'commit', '-q', '--allow-empty', '-m', 'work only the reflog keeps')
    const lost = t.run('-C', inside, 'rev-parse', 'HEAD').trim()
    t.run('-C', inside, 'checkout', '-q', '--detach', 'HEAD~1')
    t.run('-C', made.path, 'submodule', 'deinit', '-q', '--all', '-f')
    const facts = await worktrees.inventory(made.path)
    expect(facts.submodules).toBeUndefined()
    const modules = facts.submoduleData!.path
    const clone = join(modules, 'mod')
    expect(t.run('--git-dir', clone, 'rev-list', '--all').split('\n')).not.toContain(lost)
    expect(t.run('--git-dir', clone, 'rev-list', '--reflog').split('\n')).toContain(lost)
    await expect(
      worktrees.remove(made.path, { discard: facts.files + facts.ignored, digest: facts.digest, audit: noAudit }),
    ).rejects.toMatchObject({
      code: 'worktree-submodule-data',
      details: { folder: modules },
    })
    // The commit is still there to recover.
    expect(t.run('--git-dir', clone, 'cat-file', '-t', lost).trim()).toBe('commit')
    // Once the person has checked and deleted the clones, removal goes through.
    await rm(modules, { recursive: true, force: true })
    await worktrees.remove(made.path, { ...(await confirmed(worktrees, made.path)), audit: noAudit })
    expect(existsSync(made.path)).toBe(false)
  })

  it('refuses while a nested submodule’s clone remains', async () => {
    const t = await setup()
    const inner = await subRepository(t, 'inner')
    const outer = await subRepository(t, 'outer')
    // Only the worktree needs clones. In the source repositories Git needs the gitlinks and their URLs.
    for (const [parent, child, name] of [
      [outer, inner, 'inner'],
      [t.root, outer, 'mod'],
    ] as const) {
      const head = t.run('-C', child, 'rev-parse', 'HEAD').trim()
      t.run('-C', parent, 'config', '-f', '.gitmodules', `submodule.${name}.path`, name)
      t.run('-C', parent, 'config', '-f', '.gitmodules', `submodule.${name}.url`, child)
      t.run('-C', parent, 'add', '.gitmodules')
      t.run('-C', parent, 'update-index', '--add', '--cacheinfo', `160000,${head},${name}`)
      t.run('-C', parent, 'commit', '-qm', 'add submodule')
    }
    const worktrees = t.service()
    const made = await worktrees.create({ source: t.root, requestId: 'request-0001' })
    await worktrees.bind(made.path, 'request-0001', 'session-1')
    t.run('-C', made.path, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init', '--recursive')
    t.run('-C', made.path, 'submodule', 'deinit', '-q', '--all', '-f')
    const facts = await worktrees.inventory(made.path)
    expect(existsSync(join(facts.submoduleData!.path, 'mod', 'modules', 'inner'))).toBe(true)
    await expect(
      worktrees.remove(made.path, { discard: facts.files + facts.ignored, digest: facts.digest, audit: noAudit }),
    ).rejects.toMatchObject({
      code: 'worktree-submodule-data',
    })
    expect(existsSync(join(facts.submoduleData!.path, 'mod', 'modules', 'inner'))).toBe(true)
  })
})
