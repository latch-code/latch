import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { CUSTOMIZATION_REVISION_LIMIT, DATA_KINDS, MEMORY_UNDO_DAYS, type AuditPage, type DataInventory } from '@latch/protocol'
import { ATTACHMENT_TTL } from '../src/attachments.ts'
import { AUDIT_DETAIL } from '../src/audit.ts'
import { AUDIT_FIELDS } from '../src/audit-fields.ts'
import { AUDIT_LABELS } from '../src/audit-labels.ts'
import { PRUNE_AFTER } from '../src/auth.ts'
import { MAX_RUNS } from '../src/automations.ts'
import { DEFAULT_LIMITS } from '../src/changes/engine.ts'
import { countSizes, dataKinds } from '../src/data-inventory.ts'
import { USAGE_KEEP_DAYS } from '../src/usage-log.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
const roots: string[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('设置 › 数据', () => {
  test('says each kind’s retention from the constants the stores use', () => {
    const retention = Object.fromEntries(dataKinds().map(kind => [kind.id, kind.retention]))
    expect(Object.keys(retention)).toEqual([...DATA_KINDS])
    expect(retention.usage).toContain(`${USAGE_KEEP_DAYS} 天`)
    expect(retention.devices).toContain(`${PRUNE_AFTER / 86_400_000} 天`)
    expect(retention.memory).toContain(`${MEMORY_UNDO_DAYS} 天`)
    expect(retention.snapshots).toContain(`最近 ${DEFAULT_LIMITS.turnsPerSession} 轮`)
    expect(retention.snapshots).toContain(`${DEFAULT_LIMITS.projectBytes / 1024 ** 3} GiB`)
    expect(retention.attachments).toContain(`${ATTACHMENT_TTL / 60_000} 分钟`)
    expect(retention.automations).toContain(`最近 ${MAX_RUNS} 次`)
    expect(retention.settings).toContain(`${CUSTOMIZATION_REVISION_LIMIT} 个修订`)
    // Nothing expires the audit log, sessions or the log file: said as such.
    expect(retention.audit).toBe('一直保留')
    expect(retention.sessions).toContain('一直保留')
    expect(retention.logs).toContain('一直保留')
    // Entry names never leave the data directory.
    for (const kind of dataKinds()) for (const entry of kind.entries) expect(entry).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  })

  test('counts sizes without following a link out of the data directory', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'latch-data-sizes-'))
    const outside = await mkdtemp(join(tmpdir(), 'latch-data-outside-'))
    roots.push(dataDir, outside)
    await writeFile(join(outside, 'big'), Buffer.alloc(1024 * 1024))
    await mkdir(join(dataDir, 'attachments'))
    await writeFile(join(dataDir, 'attachments', 'one'), Buffer.alloc(100))
    await symlink(outside, join(dataDir, 'attachments', 'escape'))
    await symlink(join(outside, 'big'), join(dataDir, 'audit'))
    const sizes = await countSizes(dataDir)
    expect(sizes.get('attachments')).toEqual({ bytes: 100, files: 1, truncated: false })
    expect(sizes.get('audit')).toEqual({ bytes: 0, files: 0, truncated: false })
  })

  test('only a device with admin and data scope all reads the inventory, counts it, or reads the audit log', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    const inventory = await owner.json<DataInventory>('data')
    expect(inventory.dataDir).toBe(host.dataDir)
    expect(inventory.sizedAt).toBeUndefined()
    const counted = await owner.json<DataInventory>('data/sizes', { method: 'POST', body: {} })
    expect(counted.sizedAt).toBeDefined()
    expect(counted.kinds.find(kind => kind.id === 'audit')?.bytes).toBeGreaterThan(0)
    // Counted once, then read as counted.
    expect((await owner.json<DataInventory>('data')).sizedAt).toBe(counted.sizedAt)

    const viewer = await host.enroll({ listener: 'loopback-tcp' })
    await owner.json(`devices/${viewer.id}`, { method: 'PATCH', body: { scopes: ['view', 'run'] } })
    const narrow = await host.enroll({ listener: 'loopback-tcp' })
    await owner.json(`devices/${narrow.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    for (const device of [viewer, narrow])
      for (const [path, init] of [
        ['data', undefined],
        ['data/sizes', { method: 'POST', body: {} }],
        ['audit/records', undefined],
      ] as const) {
        const response = await device.request(path, init)
        expect(response.status).toBe(403)
        expect(await response.text()).not.toContain(host.dataDir)
      }
  })
})

describe('审计记录', () => {
  test('names every action, newest first, filtered and paged; ids and hashes short, code-derived hashes never', async () => {
    expect(Object.keys(AUDIT_LABELS).sort()).toEqual(Object.keys(AUDIT_DETAIL).sort())
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix', name: '这台 Mac' })
    const phone = await host.enroll({ listener: 'loopback-tcp', name: '浏览器' })
    await owner.json(`devices/${phone.id}/name`, { method: 'PUT', body: { name: '我的浏览器' } }).catch(() => undefined)
    await owner.json('custom-agents/general/memories', { method: 'POST', body: { requestId: randomUUID(), content: '审计里不该出现的话' } })

    const page = await owner.json<AuditPage>('audit/records')
    expect(page.entries.length).toBeGreaterThan(2)
    expect(page.entries.map(entry => entry.seq)).toEqual(page.entries.map(entry => entry.seq).toSorted((a, b) => b - a))
    expect(page.actors.map(actor => actor.id)).toEqual(expect.arrayContaining([owner.id, phone.id]))
    const text = JSON.stringify(page)
    expect(text).not.toMatch(/[0-9a-f]{64}/u)
    expect(text).not.toContain('审计里不该出现的话')
    for (const entry of page.entries) {
      expect(entry.label).toBe(AUDIT_LABELS[entry.action as keyof typeof AUDIT_LABELS][1])
      for (const field of entry.fields)
        expect((AUDIT_FIELDS[entry.action as keyof typeof AUDIT_FIELDS] as Record<string, string>)[field.name]).not.toBe('hidden')
    }
    // Fields derived from secret material are never shown, not even shortened: a relay's profile hashes its
    // registration key, and the phone settings' before and after hash the profiles.
    const secretHash = (seed: string) => createHash('sha256').update(seed).digest('hex')
    const actor = { listener: 'host' as const }
    await host.host.security.audit.append({
      action: 'native.relay.add.requested',
      actor,
      detail: { base: secretHash('base'), profile: secretHash('profile') },
    })
    await host.host.security.audit.append({ action: 'native.relay.add.abandoned', actor, detail: { profile: secretHash('profile') } })
    await host.host.security.audit.append({
      action: 'native.config.changed',
      actor,
      detail: { before: secretHash('before'), after: secretHash('after'), lowering: false, direct: true, relayCount: 1 },
    })
    const relays = JSON.stringify(await owner.json<AuditPage>('audit/records?kind=devices'))
    for (const seed of ['base', 'profile', 'before', 'after']) expect(relays).not.toContain(secretHash(seed).slice(0, 8))
    expect(relays).toContain('"relayCount"')
    expect(relays).not.toMatch(/"name":"(?:profile|base|before|after)"/u)
    for (const action of Object.keys(AUDIT_DETAIL) as Array<keyof typeof AUDIT_FIELDS>) expect(AUDIT_FIELDS[action]).toBeDefined()

    const memory = page.entries.find(entry => entry.action === 'agent.changed')!
    expect(memory.actor).toMatchObject({ kind: 'device', name: '这台 Mac' })

    // By kind, by who, by time; and a page at a time.
    const devices = await owner.json<AuditPage>('audit/records?kind=devices')
    expect(devices.entries.length).toBeGreaterThan(0)
    expect(devices.entries.every(entry => entry.kind === 'devices')).toBe(true)
    const mine = await owner.json<AuditPage>(`audit/records?actor=${owner.id}`)
    expect(mine.entries.every(entry => entry.actor.kind === 'device' && entry.actor.name === '这台 Mac')).toBe(true)
    const future = await owner.json<AuditPage>(`audit/records?since=${new Date(Date.now() + 86_400_000).toISOString()}`)
    expect(future).toMatchObject({ entries: [] })
    expect(future.next).toBeUndefined()
    const first = await owner.json<AuditPage>('audit/records?limit=2')
    expect(first.entries).toHaveLength(2)
    expect(first.next).toBe(first.entries[1]!.seq)
    const second = await owner.json<AuditPage>(`audit/records?limit=2&before=${first.next}`)
    expect(second.entries[0]!.seq).toBeLessThan(first.entries[1]!.seq)
  })
})
