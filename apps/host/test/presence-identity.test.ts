import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuditLog } from '../src/audit.ts'
import { PolicyStore, defaultPolicy, parsePolicyFile } from '../src/policy.ts'
import { presenceIdentity } from '../src/presence-identity.ts'
import { createPresenceBackend, buildPreview, type ChildProcessLike, type ExecFileLike } from '../src/presence.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean()
})
const identity = presenceIdentity('ABCDE12345')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'latch-identity-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'dist/native'), { recursive: true })
  for (const name of ['latch-presence', 'latch-presence-launch'])
    await writeFile(join(root, 'dist/native', name), 'fixture', { mode: 0o700 })
  const audit = await AuditLog.open(join(root, 'audit'))
  cleanup.push(() => audit.close())
  const policy = await PolicyStore.open({ dataDir: root, audit, platform: 'darwin' })
  return { root, audit, policy }
}

describe('release presence identity', () => {
  it('requires explicit migration from a pinned development component, audits first, and refuses a different publisher', async () => {
    const { policy, root, audit } = await fixture()
    await policy.pinHelperCdhash('a'.repeat(40))
    await expect(policy.pinHelperIdentity(identity.hash)).rejects.toMatchObject({ code: 'presence-repin-required' })
    await policy.pinHelperIdentity(identity.hash, true)
    expect(policy.get().presence).toEqual({ backend: 'macos-helper', mode: 'identity', helperCdhash: null, identityHash: identity.hash })
    expect(audit.latest(['presence.helper.identity-pinned'])).toMatchObject({
      stepup: 'offline',
      detail: { identityHash: identity.hash, migration: true },
    })
    expect(JSON.parse(await readFile(join(root, 'policy.json'), 'utf8')).presence.mode).toBe('identity')
    await expect(policy.pinHelperIdentity(presenceIdentity('OTHER12345').hash, true)).rejects.toMatchObject({
      code: 'presence-identity-changed',
    })
    await expect(policy.pinHelperCdhash('b'.repeat(40))).rejects.toMatchObject({ code: 'presence-identity-required' })
  })

  it('never repins automatically after an identity record is removed from policy', async () => {
    const { root, policy, audit } = await fixture()
    await policy.pinHelperIdentity(identity.hash)
    await writeFile(join(root, 'policy.json'), JSON.stringify(defaultPolicy('darwin')))
    const reopened = await PolicyStore.open({ dataDir: root, audit, platform: 'darwin' })
    await expect(reopened.pinHelperIdentity(identity.hash)).rejects.toMatchObject({ code: 'presence-repin-required' })
    await expect(reopened.pinHelperCdhash('b'.repeat(40))).rejects.toMatchObject({ code: 'presence-identity-required' })
    await expect(createPresenceBackend({ platform: 'darwin', codeRoot: root, policy: reopened }).availability()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'helper-signature',
    })
    expect(reopened.get().presence.mode).not.toBe('identity')
    await reopened.pinHelperIdentity(identity.hash, true)
    expect(reopened.get().presence).toMatchObject({ mode: 'identity', identityHash: identity.hash })
    expect(audit.latest(['presence.helper.identity-pinned'])).toMatchObject({ stepup: 'offline' })
  })

  it('requires an offline repin when the policy has an identity and the audit has no previous pin', async () => {
    const { root, audit } = await fixture()
    const present = { backend: 'macos-helper', mode: 'identity', helperCdhash: null, identityHash: identity.hash }
    await writeFile(join(root, 'policy.json'), JSON.stringify({ ...defaultPolicy('darwin'), presence: present }))
    const reopened = await PolicyStore.open({ dataDir: root, audit, platform: 'darwin' })
    await expect(reopened.pinHelperIdentity(identity.hash)).rejects.toMatchObject({ code: 'presence-repin-required' })
    expect(reopened.get().presence).toEqual(present)
    expect(audit.latest(['presence.helper.identity-pinned'])).toBeUndefined()
    await expect(reopened.pinHelperCdhash('b'.repeat(40))).rejects.toMatchObject({ code: 'presence-identity-required' })

    await reopened.pinHelperIdentity(identity.hash, true)
    expect(audit.latest(['presence.helper.identity-pinned'])).toMatchObject({
      stepup: 'offline',
      detail: { identityHash: identity.hash, migration: true },
    })
    await expect(reopened.pinHelperIdentity(identity.hash)).resolves.toBeUndefined()
  })

  it('does not change trust when its audit fails', async () => {
    const { policy, audit } = await fixture()
    vi.spyOn(audit, 'append').mockRejectedValueOnce(new Error('disk full'))
    await expect(policy.pinHelperIdentity(identity.hash)).rejects.toThrow('disk full')
    expect(policy.get().presence.mode).not.toBe('identity')
  })

  it('rejects an identity rule supplied through policy and invalid mode combinations', () => {
    const base = defaultPolicy('darwin')
    for (const presence of [
      { ...base.presence, mode: 'identity' },
      { ...base.presence, identityHash: identity.hash },
      { ...base.presence, mode: 'identity', identityHash: identity.hash, teamId: identity.teamId },
      { ...base.presence, mode: 'identity', identityHash: identity.hash, helperCdhash: 'a'.repeat(40) },
    ])
      expect(parsePolicyFile({ ...base, presence }).success).toBe(false)
  })

  it('checks the helper and launcher against exact release requirements on every invocation before starting the launcher', async () => {
    const { root, policy } = await fixture()
    const execFile = vi.fn<ExecFileLike>().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn(() => true),
    }) as ChildProcessLike
    const spawn = vi.fn(() => child)
    const backend = createPresenceBackend({ platform: 'darwin', codeRoot: root, policy, identity, execFile, spawn })
    await expect(backend.availability()).resolves.toMatchObject({ status: 'available' })
    expect(execFile.mock.calls.map(call => call[1][2])).toEqual([`-R=${identity.requirement}`, `-R=${identity.launcherRequirement}`])
    const preview = buildPreview({
      hostId: 'a'.repeat(52),
      action: 'device.enroll',
      requester: { listener: 'unix', remoteAddress: '本机' },
      subject: { form: 'device.enroll-named', slots: { device: '桌面' } },
      lines: [],
      warnings: [],
      now: Date.now(),
    })
    const pending = backend.confirm({ ...preview, requireBiometric: true, signal: new AbortController().signal })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    expect(execFile).toHaveBeenCalledTimes(4)
    expect(spawn).toHaveBeenCalledWith(join(root, 'dist/native/latch-presence-launch'), [], {
      env: {},
      cwd: '/',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    child.stdout!.emit('data', Buffer.from('{"result":"cancelled"}\n'))
    ;(child as ChildProcessLike & EventEmitter).emit('exit', 0, null)
    await expect(pending).resolves.toEqual({ result: 'cancelled' })
    execFile.mockResolvedValue({ code: 1, stdout: '', stderr: '' })
    await expect(backend.confirm({ ...preview, requireBiometric: true, signal: new AbortController().signal })).resolves.toMatchObject({
      result: 'error',
    })
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
