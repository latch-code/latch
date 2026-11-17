import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitCloneState } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { findGit } from '../src/changes/git.ts'
import { GitClones, parseCloneUrl, progressOf, type CloneHooks } from '../src/git-clone.ts'
import { RepositoryHolds } from '../src/git-delivery.ts'
import { configHookGit } from './helpers/config-hooks.ts'
import { installFakeSsh } from './helpers/fake-ssh.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SLOW = { timeout: 30_000 }
const GIT = findGit()!

function refused(text: string): AppError {
  try {
    parseCloneUrl(text)
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error(`expected ${text} to be refused`)
}

describe('clone addresses', () => {
  it('takes https and ssh addresses and names the folder after them', () => {
    expect(parseCloneUrl('https://github.com/acme/widgets.git')).toEqual({
      url: 'https://github.com/acme/widgets.git',
      transport: 'https',
      host: 'github.com',
      name: 'widgets',
    })
    expect(parseCloneUrl('  git@GitHub.com:acme/widgets.git ')).toMatchObject({ transport: 'ssh', host: 'github.com', name: 'widgets' })
    expect(parseCloneUrl('ssh://git@example.test:2222/srv/tools/')).toMatchObject({ transport: 'ssh', name: 'tools' })
    expect(parseCloneUrl('example.test:team/app')).toMatchObject({ transport: 'ssh', name: 'app' })
  })

  it('refuses local paths, other transports, options and anything shaped to slip past, without repeating the address', () => {
    const local = ['/tmp/remote.git', './remote.git', '../remote.git', 'remote.git', 'file:///tmp/remote.git', 'FILE:///tmp/remote.git']
    const other = [
      'git://example.test/x.git',
      'http://example.test/x.git',
      'ext::sh -c touch% /tmp/pwned',
      'ext::sh',
      'fd::3',
      'hg::https://example.test/x',
      'persistent-https://example.test/x',
      'git+ssh://example.test/x',
    ]
    const shaped = [
      '-uhack',
      '--upload-pack=touch /tmp/pwned',
      'example.test:-oProxyCommand=x',
      '-oProxyCommand=x:repo',
      'https://example.test/x.git?ref=main',
      'https://example.test/x.git#main',
      'https://example.test/../x',
      'https://example.test/a/../../x',
      'https://-example.test/x',
      'https://example.test:99999/x',
      'https://example.test/x y',
      'https://example.test/x\nhttps://evil.test/y',
      'https://example.test',
      'https://example.test/',
      'https://exa_mple.test/x',
      '',
    ]
    for (const url of [...local, ...other, ...shaped]) {
      const error = refused(url)
      expect([url, error.code]).toEqual([url, 'clone-url-invalid'])
      if (url) expect(error.message).not.toContain(url)
    }
  })

  it('refuses credentials in the address as such: a password, or any user name in https where a token goes', () => {
    for (const url of [
      'https://user:secret@github.com/acme/x.git',
      'https://ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/acme/x.git',
      'https://user@github.com/acme/x.git',
      'ssh://git:secret@example.test/x.git',
      'git:secret@example.test:x.git',
    ]) {
      const error = refused(url)
      expect([url, error.code]).toEqual([url, 'clone-url-credentials'])
      expect(error.message).not.toContain('secret')
      expect(error.message).not.toContain('ghp_')
    }
  })

  it('reads progress from Git’s standard error', () => {
    expect(progressOf("Cloning into '.'...\nReceiving objects:  45% (9/20)\r")).toEqual({ phase: 'receiving', percent: 45 })
    expect(progressOf('Resolving deltas: 100% (3/3), done.\n')).toEqual({ phase: 'resolving', percent: 100 })
    expect(progressOf('Updating files:  50% (1/2)\r')).toEqual({ phase: 'checkout', percent: 50 })
    expect(progressOf('warning: something\n')).toBeUndefined()
  })
})

/**
 * A bare repository served by a stand-in `ssh` (it runs `git upload-pack` on it), on a shell whose PATH starts with it:
 * the clone goes through the ssh transport exactly as it would to a host, without a network. Hooks, a template and a
 * filter in your configuration write a marker if they ever run.
 */
async function fixture(options: { git?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-git-clone-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home'),
    served = join(root, 'served'),
    marks = join(root, 'marks'),
    parent = join(root, 'projects')
  await Promise.all([home, served, marks, parent].map(dir => mkdir(dir)))
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && name !== 'GIT_CONFIG_NOSYSTEM') delete env[name]
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString('utf8')
      .trim()
  const work = join(root, 'work')
  await mkdir(work)
  gitIn(work, 'init', '-q', '-b', 'main')
  gitIn(work, 'config', 'user.name', 'Tester')
  gitIn(work, 'config', 'user.email', 'tester@example.invalid')
  await writeFile(join(work, 'readme.txt'), 'hello\n')
  await writeFile(join(work, '.gitattributes'), '*.txt filter=mark\n')
  gitIn(work, 'add', '.')
  gitIn(work, 'commit', '-q', '-m', 'first')
  gitIn(served, 'init', '-q', '--bare', '-b', 'main', 'remote.git')
  gitIn(work, 'push', '-q', join(served, 'remote.git'), 'main')
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
  const mark = (name: string) => `#!/bin/sh\necho ran >> ${quote(join(marks, name))}\n`
  // Hooks in the remote, which serving it must not run.
  for (const name of ['post-update', 'pre-receive', 'reference-transaction']) {
    await writeFile(join(served, 'remote.git', 'hooks', name), mark(`remote-${name}`))
    await chmod(join(served, 'remote.git', 'hooks', name), 0o755)
  }
  // Your configuration: a template with a hook, a hooks directory, a hook by configuration and a filter driver.
  const template = join(home, 'template')
  await mkdir(join(template, 'hooks'), { recursive: true })
  await writeFile(join(template, 'hooks', 'post-checkout'), mark('template-post-checkout'))
  await chmod(join(template, 'hooks', 'post-checkout'), 0o755)
  await mkdir(join(home, 'hooks'))
  await writeFile(join(home, 'hooks', 'post-checkout'), mark('global-post-checkout'))
  await chmod(join(home, 'hooks', 'post-checkout'), 0o755)
  gitIn(home, 'config', '--global', 'init.templateDir', template)
  gitIn(home, 'config', '--global', 'core.hooksPath', join(home, 'hooks'))
  await writeFile(join(home, 'config-hook'), mark('config-post-checkout'))
  await chmod(join(home, 'config-hook'), 0o755)
  gitIn(home, 'config', '--global', 'hook.mark.command', join(home, 'config-hook'))
  gitIn(home, 'config', '--global', 'hook.mark.event', 'post-checkout')
  gitIn(home, 'config', '--global', 'filter.mark.smudge', `sh -c 'echo ran >> ${join(marks, 'smudge')}; cat'`)
  gitIn(home, 'config', '--global', 'filter.mark.clean', 'cat')
  gitIn(home, 'config', '--global', 'filter.mark.required', 'true')
  const fake = await installFakeSsh({ root, served, marks, git: GIT })
  const hang = fake.hang
  const audits: unknown[] = [],
    results: unknown[] = [],
    registered: string[] = []
  const hooks = (overrides: Partial<CloneHooks> = {}): CloneHooks => ({
    check: async () => {},
    audit: async detail => {
      audits.push(detail)
    },
    result: async detail => {
      results.push(detail)
    },
    register: async folder => {
      registered.push(folder)
      return 'widgets'
    },
    ...overrides,
  })
  const clones = new GitClones({
    ...(options.git ? { git: options.git } : {}),
    holds: new RepositoryHolds(),
    hostEnv: { HOME: home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: root },
    shell: fake.shell,
    log: () => {},
  })
  cleanups.push(() => clones.close())
  const settled = async (state: GitCloneState) => {
    let current = state
    for (let i = 0; i < 200 && current.state === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      current = clones.get('dev_test', state.id)
    }
    return current
  }
  const marked = async () => (await readdir(marks)).filter(name => name !== 'ssh-calls')
  return { root, home, marks, parent, hang, clones, hooks, audits, results, registered, settled, marked, gitIn }
}

describe('clone', () => {
  it('clones over ssh into a new folder that becomes a project, running no hook, template or filter', SLOW, async () => {
    const f = await fixture()
    const address = parseCloneUrl('git@example.test:remote.git')
    const started = await f.clones.start({ deviceId: 'dev_test', address, parent: f.parent, hooks: f.hooks() })
    expect(started).toMatchObject({ state: 'running', name: 'remote' })
    const done = await f.settled(started)
    expect(done).toMatchObject({ state: 'done', workspaceId: 'widgets' })
    const folder = join(f.parent, 'remote')
    expect(f.registered).toEqual([folder])
    // The filter did not run: the file is what the repository holds.
    expect(await readFile(join(folder, 'readme.txt'), 'utf8')).toBe('hello\n')
    expect(f.gitIn(folder, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(existsSync(join(folder, '.git', 'hooks'))).toBe(false)
    expect(await f.marked()).toEqual([])
    expect(f.audits).toEqual([
      {
        cloneHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        transport: 'ssh',
        urlHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        hostHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        pathHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    ])
    expect(JSON.stringify([f.audits, f.results])).not.toContain('example.test')
    expect(f.results).toEqual([{ cloneHash: expect.any(String), outcome: 'done', workspaceId: 'widgets' }])
    // Another device does not see it.
    expect(() => f.clones.get('dev_other', started.id)).toThrow(AppError)
  })

  it('cancels by ending the process, and removes the folder it made and nothing else', SLOW, async () => {
    const f = await fixture()
    await writeFile(f.hang, '')
    await mkdir(join(f.parent, 'keep'))
    await writeFile(join(f.parent, 'keep', 'file.txt'), 'mine\n')
    const started = await f.clones.start({
      deviceId: 'dev_test',
      address: parseCloneUrl('git@example.test:remote.git'),
      parent: f.parent,
      hooks: f.hooks(),
    })
    const folder = join(f.parent, 'remote')
    expect(existsSync(folder)).toBe(true)
    // Git is waiting on the stand-in ssh.
    await expect.poll(async () => existsSync(join(f.marks, 'ssh-calls')), { timeout: 10_000 }).toBe(true)
    const cancelled = await f.clones.cancel('dev_test', started.id)
    expect(cancelled).toMatchObject({ state: 'cancelled', code: 'clone-cancelled' })
    expect(existsSync(folder)).toBe(false)
    expect(await readFile(join(f.parent, 'keep', 'file.txt'), 'utf8')).toBe('mine\n')
    expect(await readdir(f.parent)).toEqual(['keep'])
    expect(f.registered).toEqual([])
    expect(f.results).toEqual([{ cloneHash: expect.any(String), outcome: 'cancelled', code: 'clone-cancelled', removed: true }])
    // The process group is gone: nothing writes there any more.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(existsSync(folder)).toBe(false)
  })

  for (const swap of ['directory', 'link'] as const)
    it(`deletes nothing when the folder it made was swapped for a ${swap} during the clone`, SLOW, async () => {
      const f = await fixture()
      await writeFile(f.hang, '')
      const started = await f.clones.start({
        deviceId: 'dev_test',
        address: parseCloneUrl('git@example.test:remote.git'),
        parent: f.parent,
        hooks: f.hooks(),
      })
      await expect.poll(async () => existsSync(join(f.marks, 'ssh-calls')), { timeout: 10_000 }).toBe(true)
      const folder = join(f.parent, 'remote')
      // Someone else's folder now stands where the clone's was.
      await rename(folder, join(f.root, 'moved-away'))
      const elsewhere = join(f.root, 'elsewhere')
      await mkdir(elsewhere)
      await writeFile(join(elsewhere, 'keep.txt'), 'keep\n')
      if (swap === 'directory') {
        await mkdir(folder)
        await writeFile(join(folder, 'keep.txt'), 'keep\n')
      } else await symlink(elsewhere, folder)
      expect(await f.clones.cancel('dev_test', started.id)).toMatchObject({ state: 'cancelled' })
      expect(await readFile(join(folder, 'keep.txt'), 'utf8')).toBe('keep\n')
      expect(await readFile(join(elsewhere, 'keep.txt'), 'utf8')).toBe('keep\n')
      expect(f.results).toEqual([{ cloneHash: expect.any(String), outcome: 'cancelled', code: 'clone-cancelled', removed: false }])
    })

  it('never takes a folder that exists, and runs nothing when the check or the audit refuses', SLOW, async () => {
    const f = await fixture()
    await mkdir(join(f.parent, 'remote'))
    await writeFile(join(f.parent, 'remote', 'mine.txt'), 'mine\n')
    const address = parseCloneUrl('git@example.test:remote.git')
    await expect(f.clones.start({ deviceId: 'dev_test', address, parent: f.parent, hooks: f.hooks() })).rejects.toMatchObject({
      code: 'clone-folder-exists',
    })
    expect(await readFile(join(f.parent, 'remote', 'mine.txt'), 'utf8')).toBe('mine\n')
    await rm(join(f.parent, 'remote'), { recursive: true })
    const audit = f.hooks({
      audit: async () => {
        throw new AppError(503, 'audit-unavailable', '审计没有写入')
      },
    })
    await expect(f.clones.start({ deviceId: 'dev_test', address, parent: f.parent, hooks: audit })).rejects.toMatchObject({
      code: 'audit-unavailable',
    })
    const check = f.hooks({
      check: async () => {
        throw new AppError(409, 'workspace-folders-refused', '选择的文件夹都没有加入')
      },
    })
    await expect(f.clones.start({ deviceId: 'dev_test', address, parent: f.parent, hooks: check })).rejects.toMatchObject({
      code: 'workspace-folders-refused',
    })
    expect(await readdir(f.parent)).toEqual([])
    expect(existsSync(join(f.marks, 'ssh-calls'))).toBe(false)
    // A file is not a place to clone into.
    await writeFile(join(f.root, 'file'), '')
    await expect(f.clones.start({ deviceId: 'dev_test', address, parent: join(f.root, 'file'), hooks: f.hooks() })).rejects.toMatchObject({
      code: 'workspace-invalid',
    })
  })

  it('removes the folder of a clone that failed and says why', SLOW, async () => {
    const f = await fixture()
    const started = await f.clones.start({
      deviceId: 'dev_test',
      address: parseCloneUrl('git@example.test:missing.git'),
      parent: f.parent,
      hooks: f.hooks(),
    })
    const done = await f.settled(started)
    expect(done.state).toBe('failed')
    expect(['clone-not-found-remote', 'clone-unreachable', 'clone-failed']).toContain(done.code)
    expect(await readdir(f.parent)).toEqual([])
    expect(f.results).toEqual([expect.objectContaining({ outcome: 'failed', removed: true })])
  })

  it('takes one clone at a time', SLOW, async () => {
    const f = await fixture()
    await writeFile(f.hang, '')
    const address = parseCloneUrl('git@example.test:remote.git')
    const first = await f.clones.start({ deviceId: 'dev_test', address, parent: f.parent, hooks: f.hooks() })
    await expect(
      f.clones.start({ deviceId: 'dev_test', address: parseCloneUrl('git@example.test:other.git'), parent: f.parent, hooks: f.hooks() }),
    ).rejects.toMatchObject({ code: 'clone-busy' })
    await f.clones.cancel('dev_test', first.id)
  })
})

const hookGit = configHookGit()
describe.skipIf(!hookGit)('clone with hooks from configuration (Git 2.54 and later)', () => {
  it('runs none of your configured hooks, which this Git otherwise runs on a clone', SLOW, async () => {
    const f = await fixture({ git: hookGit! })
    // The fixture's global `hook.mark` runs on post-checkout with this Git: a plain clone sets it off.
    const plain = join(f.root, 'plain')
    execFileSync(hookGit!, ['-c', 'protocol.file.allow=always', 'clone', '-q', join(f.root, 'served', 'remote.git'), plain], {
      env: { HOME: f.home, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'ignore',
    })
    expect(await f.marked()).toContain('config-post-checkout')
    await rm(f.marks, { recursive: true, force: true })
    await mkdir(f.marks)
    const started = await f.clones.start({
      deviceId: 'dev_test',
      address: parseCloneUrl('git@example.test:remote.git'),
      parent: f.parent,
      hooks: f.hooks(),
    })
    expect(await f.settled(started)).toMatchObject({ state: 'done' })
    expect(await f.marked()).toEqual([])
  })
})
