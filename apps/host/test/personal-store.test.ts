import { chmod, link, mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { AuditLog } from '../src/audit.ts'
import { PersonalStore, type PersonalActor, type PersonalStoreOptions } from '../src/personal-store.ts'

const roots: string[] = []
const stores: PersonalStore[] = []
const audits: AuditLog[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) await store.close()
  for (const audit of audits.splice(0)) await audit.close()
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})
const actor: PersonalActor = { actor: { deviceId: 'dev_aaaaaaaaaaaaaaaaaaaaaa', listener: 'unix', via: 'http' }, authorize() {} }
const input = () => ({
  requestId: randomUUID(),
  name: '私有助理',
  role: '私人职责内容',
  harnessId: 'standard',
  mode: 'agent' as const,
  pluginIds: [],
})
async function fixture(options: Partial<PersonalStoreOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'latch-personal-store-'))
  roots.push(dir)
  const audit = await AuditLog.open(dir)
  audits.push(audit)
  const store = await PersonalStore.open(dir, { audit, ...options })
  stores.push(store)
  return { dir, store, audit, path: join(dir, 'personal', 'personal.json') }
}

test('persists isolated explicit memories with private modes and hash-only audit', async () => {
  const { dir, store, path } = await fixture()
  const first = (await store.createAssistant(input(), actor)).value
  const second = (await store.createAssistant(input(), actor)).value
  const memory = (await store.createMemory(first.id, { requestId: randomUUID(), content: '只属于第一助手的秘密偏好' }, actor)).value
  expect(store.memories(first.id)).toEqual([memory])
  expect(store.memories(second.id)).toEqual([])
  await expect(
    store.patchMemory(second.id, memory.id, { requestId: randomUUID(), baseRevision: 1, content: 'cross' }, actor),
  ).rejects.toMatchObject({ status: 404 })
  const reopened = await PersonalStore.open(dir, { audit: audits[0]! })
  stores.push(reopened)
  expect(reopened.memories(first.id)).toEqual([memory])
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect((await stat(join(dir, 'personal'))).mode & 0o777).toBe(0o700)
  const audit = await readFile(join(dir, 'audit.jsonl'), 'utf8')
  expect(audit).not.toContain('私人职责内容')
  expect(audit).not.toContain('私有助理')
  expect(audit).not.toContain(memory.content)
  expect(audit).toContain('personal.changed')
})

test('replays unknown acknowledgments across restart and never resurrects deleted identities', async () => {
  const { dir, store, audit } = await fixture()
  const request = input(),
    original = (await store.createAssistant(request, actor)).value
  const reopened = await PersonalStore.open(dir, { audit })
  stores.push(reopened)
  expect((await reopened.createAssistant(request, actor)).value.id).toBe(original.id)
  expect(reopened.assistants()).toHaveLength(1)
  await reopened.removeAssistant(original.id, randomUUID(), actor)
  await expect(reopened.createAssistant(request, actor)).rejects.toMatchObject({ status: 410 })
  expect(reopened.assistants()).toEqual([])
})

test('binds mutation identities to the device and rejects changed payloads', async () => {
  const { store } = await fixture(),
    request = input()
  const first = await store.createAssistant(request, actor)
  await expect(store.createAssistant({ ...request, role: 'changed' }, actor)).rejects.toMatchObject({ code: 'request-conflict' })
  const second = await store.createAssistant(request, { ...actor, actor: { ...actor.actor, deviceId: 'dev_bbbbbbbbbbbbbbbbbbbbbb' } })
  expect(first.value.id).not.toBe(second.value.id)
})

test('serializes optimistic edits without losing a competing revision', async () => {
  const { store } = await fixture(),
    assistant = (await store.createAssistant(input(), actor)).value
  const results = await Promise.allSettled(
    ['one', 'two'].map(role => store.patchAssistant(assistant.id, { requestId: randomUUID(), baseRevision: 1, role }, actor)),
  )
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(store.assistant(assistant.id).revision).toBe(2)
})

test('fails grants closed on audit errors but lets the user delete private data', async () => {
  const { store, audit } = await fixture(),
    assistant = (await store.createAssistant(input(), actor)).value
  vi.spyOn(audit, 'append').mockRejectedValue(new Error('disk unavailable'))
  await expect(store.createMemory(assistant.id, { requestId: randomUUID(), content: 'secret' }, actor)).rejects.toThrow('disk unavailable')
  expect(store.memories(assistant.id)).toEqual([])
  expect(await store.removeAssistant(assistant.id, randomUUID(), actor)).toMatchObject({ audited: false })
  expect(store.assistants()).toEqual([])
})

test('rechecks the actor after awaited auditing before publishing', async () => {
  const { store, audit } = await fixture()
  let allowed = true
  const caller: PersonalActor = {
    actor: actor.actor,
    authorize() {
      if (!allowed) throw Object.assign(new Error('revoked'), { status: 403 })
    },
  }
  const append = audit.append.bind(audit)
  vi.spyOn(audit, 'append').mockImplementation(async value => {
    const result = await append(value)
    allowed = false
    return result
  })
  await expect(store.createAssistant(input(), caller)).rejects.toMatchObject({ status: 403 })
  expect(store.assistants()).toEqual([])
})

test('retains the exact identity after a post-rename failure and blocks unrelated writes', async () => {
  let fail = true
  const { store, audit, path } = await fixture({
    atomicFs: {
      open,
      async rename(from, to) {
        await rename(from, to)
        if (fail) throw new Error('after rename')
      },
    },
  })
  const request = input()
  await expect(store.createAssistant(request, actor)).rejects.toMatchObject({ code: 'personal-write-unknown' })
  const durable = JSON.parse(await readFile(path, 'utf8')).assistants[0].id
  expect(() => store.assistants()).toThrow('修改结果尚未确认')
  await expect(store.createAssistant(input(), actor)).rejects.toMatchObject({ status: 503 })
  await expect(store.createAssistant({ ...request, role: 'changed' }, actor)).rejects.toMatchObject({ status: 409 })
  const append = vi.spyOn(audit, 'append')
  fail = false
  expect((await store.createAssistant(request, actor)).value.id).toBe(durable)
  expect(append).not.toHaveBeenCalled()
  expect(store.assistants()).toHaveLength(1)
})

test.each(['corrupt', 'unknown', 'wide', 'symlink', 'hardlink'] as const)('preserves and refuses %s private storage', async kind => {
  const { dir, path, audit, store } = await fixture()
  await store.close()
  if (kind === 'corrupt') await writeFile(path, '{broken')
  if (kind === 'unknown') {
    const state = JSON.parse(await readFile(path, 'utf8'))
    state.injected = true
    await writeFile(path, JSON.stringify(state))
  }
  if (kind === 'wide') await chmod(path, 0o644)
  if (kind === 'symlink') {
    await rename(path, `${path}.original`)
    await symlink(`${path}.original`, path)
  }
  if (kind === 'hardlink') await link(path, `${path}.alias`)
  await expect(PersonalStore.open(dir, { audit })).rejects.toMatchObject({ code: 'personal-invalid' })
  expect(await readFile(path, 'utf8')).not.toBe('')
})

test('validates actual group membership and daily time zones without activating a routine', async () => {
  const { store } = await fixture(),
    first = (await store.createAssistant(input(), actor)).value,
    second = (await store.createAssistant(input(), actor)).value
  await expect(
    store.createGroup(
      { requestId: randomUUID(), name: 'group', memberIds: [first.id], defaultAssistantId: second.id, maxRelays: 1, instructions: '' },
      actor,
    ),
  ).rejects.toMatchObject({ code: 'personal-group-members' })
  await expect(
    store.createRoutine(
      {
        requestId: randomUUID(),
        assistantId: first.id,
        name: 'daily',
        prompt: '整理今日事项',
        schedule: { kind: 'daily', time: '08:00', timeZone: 'unknown/zone' },
      },
      actor,
    ),
  ).rejects.toMatchObject({ code: 'personal-time-zone' })
  const routine = await store.createRoutine(
    {
      requestId: randomUUID(),
      assistantId: first.id,
      name: 'daily',
      prompt: '整理今日事项',
      schedule: { kind: 'daily', time: '08:00', timeZone: 'Asia/Shanghai' },
    },
    actor,
  )
  expect(routine.value).toMatchObject({ state: 'disabled', enabled: false })
})

test('reserves a device request on its original harness before execution and refuses to migrate an unknown result', async () => {
  const { dir, store, audit } = await fixture(),
    assistant = (await store.createAssistant(input(), actor)).value
  const rid = randomUUID(),
    payload = { prompt: 'private input' }
  const binding = (await store.beginSession(assistant.id, rid, payload, actor)).value
  await store.patchAssistant(assistant.id, { requestId: randomUUID(), baseRevision: 1, harnessId: 'other' }, actor)
  const restored = await PersonalStore.open(dir, { audit })
  stores.push(restored)
  const retried = await restored.beginSession(assistant.id, rid, payload, actor)
  expect(retried.value).toEqual(binding)
  expect(retried.value.harnessId).toBe('standard')
  expect(restored.definitionHash(assistant.id)).not.toBe(binding.definitionHash)
  await expect(restored.beginSession(assistant.id, rid, { prompt: 'changed' }, actor)).rejects.toMatchObject({ code: 'request-conflict' })
  await restored.removeAssistant(assistant.id, randomUUID(), actor)
  expect((await restored.beginSession(assistant.id, rid, payload, actor)).value).toEqual(binding)
})

test('lets the user clear a selected model and bounds the UTF-8 memory body a phone must retrieve', async () => {
  const { store } = await fixture()
  const assistant = (await store.createAssistant({ ...input(), model: { providerId: 'fixture', model: 'fixture' } }, actor)).value
  expect(
    (await store.patchAssistant(assistant.id, { requestId: randomUUID(), baseRevision: 1, model: null }, actor)).value.model,
  ).toBeUndefined()
  let limited = false
  for (let index = 0; index < 128; index++) {
    try {
      await store.createMemory(assistant.id, { requestId: randomUUID(), content: '界'.repeat(4000) }, actor)
    } catch (error) {
      expect(error).toMatchObject({ code: 'personal-storage-limit' })
      limited = true
      break
    }
  }
  expect(limited).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(store.memories(assistant.id)))).toBeLessThan(1_048_576)
})
