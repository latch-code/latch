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
    expect(await t.service().base(t.root)).toEqual({ branch: 'main', commit: head })
    t.run('checkout', '-q', '--detach')
    expect(await t.service().base(t.root)).toEqual({ commit: head })
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
