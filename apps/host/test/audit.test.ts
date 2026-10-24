import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { AuditLog, verifyAuditFile, type AuditFs } from '../src/audit.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'harness-link-audit-'))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return join(path, 'audit')
}

async function openLog(path: string, options?: Parameters<typeof AuditLog.open>[1]): Promise<AuditLog> {
  const log = await AuditLog.open(path, options)
  cleanups.push(() => log.close())
  return log
}

const hash = (text: string) => sha256Hex(text)
const deviceId = `dev_${'A'.repeat(22)}`

async function populated(): Promise<{ path: string; file: string; lines: string[] }> {
  const path = directory()
  const log = await openLog(path, { now: () => Date.UTC(2026, 9, 23, 10) })
  await log.append({
    action: 'host.started',
    actor: { listener: 'host', via: 'startup' },
    detail: { hostId: 'a'.repeat(52), version: '0.1.0', policyHash: hash('p'), settingsHash: hash('s'), devMode: true },
  })
  await log.append({
    action: 'device.revoked',
    actor: { deviceId, listener: 'loopback-tcp', via: 'http' },
    target: deviceId,
    detail: { deviceId, reason: 'manual', cascaded: 0 },
  })
  await log.append({ action: 'task.cancelled', actor: { listener: 'unix', via: 'cli' }, target: 'task-1', detail: { sessionId: 'task-1' } })
  await log.append({
    action: 'approval.decided',
    actor: { deviceId, listener: 'unix', via: 'http' },
    stepup: 'lpc-local',
    detail: {
      approvalId: 'a-1',
      sessionId: 'task-1',
      harnessId: 'standard',
      risk: 'R2',
      advisory: false,
      decision: 'allow',
      optionKind: 'allow_once',
      previewHash: hash('x'),
    },
  })
  const file = join(path, 'audit.jsonl')
  return { path, file, lines: readFileSync(file, 'utf8').trimEnd().split('\n') }
}

describe('audit chain', () => {
  it('writes a verifiable chain with private permissions', async () => {
    const { path, file, lines } = await populated()
    expect(lines).toHaveLength(4)
    const first = JSON.parse(lines[0]!)
    expect(first).toMatchObject({
      v: 1,
      seq: 1,
      at: '2026-10-23T10:00:00.000Z',
      actor: { listener: 'host', via: 'startup' },
      action: 'host.started',
      target: '',
      stepup: 'none',
      prev: '0'.repeat(64),
    })
    const { hash: recorded, ...body } = first
    expect(recorded).toBe(sha256Hex(canonicalJson(body)))
    expect(JSON.parse(lines[1]!).prev).toBe(recorded)
    const verified = await verifyAuditFile(file)
    expect(verified).toEqual({ ok: true, head: { seq: 4, hash: JSON.parse(lines[3]!).hash }, records: 4 })
    expect(statSync(path).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('continues the chain after reopening and answers checkpoints', async () => {
    const { path, lines } = await populated()
    const log = await openLog(path)
    expect(log.head()).toEqual({ seq: 4, hash: JSON.parse(lines[3]!).hash })
    expect(await log.hashAt(2)).toBe(JSON.parse(lines[1]!).hash)
    expect(await log.hashAt(5)).toBeUndefined()
    expect(await log.hashAt(0)).toBeUndefined()
    expect(log.latest(['device.revoked', 'task.cancelled'])?.seq).toBe(3)
    expect(log.latest(['policy.changed'])).toBeUndefined()
    const next = await log.append({ action: 'approval.stale', actor: { listener: 'host' }, detail: { approvalId: 'a-1' } })
    expect(next.seq).toBe(5)
    expect(await verifyAuditFile(join(path, 'audit.jsonl'))).toMatchObject({ ok: true, records: 5 })
  })

  it('detects a change to any single field of any line', async () => {
    const { path, file, lines } = await populated()
    const mutate = (value: unknown): unknown => {
      if (typeof value === 'boolean') return !value
      if (typeof value === 'number') return value + 1
      if (typeof value === 'string')
        return value.length && /^[0-9a-f]+$/u.test(value) ? `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}` : `${value}x`
      if (Array.isArray(value)) return [...value, 'x']
      if (value && typeof value === 'object') return { ...value, injected: 1 }
      return value
    }
    for (const [index, line] of lines.entries()) {
      const record = JSON.parse(line) as Record<string, unknown>
      for (const field of Object.keys(record)) {
        const changed = [...lines]
        changed[index] = JSON.stringify({ ...record, [field]: mutate(record[field]) })
        writeFileSync(file, `${changed.join('\n')}\n`)
        const result = await verifyAuditFile(file)
        expect(result.ok, `${field} on line ${index + 1}`).toBe(false)
        if (!result.ok) expect(result.line, `${field} on line ${index + 1}`).toBe(index + 1)
      }
      for (const field of Object.keys(record.detail as object)) {
        const changed = [...lines]
        const detail = record.detail as Record<string, unknown>
        changed[index] = JSON.stringify({ ...record, detail: { ...detail, [field]: mutate(detail[field]) } })
        writeFileSync(file, `${changed.join('\n')}\n`)
        const result = await verifyAuditFile(file)
        expect(result.ok ? 0 : result.line, `detail.${field} on line ${index + 1}`).toBe(index + 1)
      }
    }
    writeFileSync(file, `${lines.join('\n').replace('"listener":"host"', '"listener":"cli"')}\n`)
    await expect(AuditLog.open(path)).rejects.toMatchObject({
      status: 500,
      code: 'audit-chain-broken',
      message: '审计记录在第 1 行校验失败。原文件已保留；如需继续，请把 audit/audit.jsonl 移走后重启。',
    })
    // The broken file is left in place.
    expect(readFileSync(file, 'utf8')).toContain('"listener":"cli"')
  })

  it('detects deleted, swapped and forged lines', async () => {
    const { file, lines } = await populated()
    writeFileSync(file, `${[lines[0], lines[2], lines[3]].join('\n')}\n`)
    expect(await verifyAuditFile(file)).toEqual({ ok: false, line: 2, reason: 'seq' })
    writeFileSync(file, `${[lines[0], lines[2], lines[1], lines[3]].join('\n')}\n`)
    expect(await verifyAuditFile(file)).toEqual({ ok: false, line: 2, reason: 'seq' })
    const last = JSON.parse(lines[3]!)
    const forged = { ...last, seq: 5, prev: '1'.repeat(64) }
    const { hash: _ignored, ...body } = forged
    forged.hash = sha256Hex(canonicalJson(body))
    writeFileSync(file, `${[...lines, JSON.stringify(forged)].join('\n')}\n`)
    expect(await verifyAuditFile(file)).toEqual({ ok: false, line: 5, reason: 'prev' })
    writeFileSync(file, `${[...lines, '{not json'].join('\n')}\n`)
    expect(await verifyAuditFile(file)).toEqual({ ok: false, line: 5, reason: 'json' })
    writeFileSync(file, `${[lines[0], '', lines[1]].join('\n')}\n`)
    expect(await verifyAuditFile(file)).toEqual({ ok: false, line: 2, reason: 'json' })
  })

  it('moves a torn final line aside and audits its removal', async () => {
    const { path, file, lines } = await populated()
    const torn = '{"v":1,"seq":5,"at":"2026'
    appendFileSync(file, torn)
    expect(await verifyAuditFile(file)).toEqual({ ok: false, line: 5, reason: 'json' })
    const log = await openLog(path, { now: () => 1_700_000_000_000 })
    expect(log.head().seq).toBe(5)
    expect(readFileSync(join(path, 'audit.jsonl.torn-1700000000000'), 'utf8')).toBe(torn)
    const text = readFileSync(file, 'utf8')
    expect(text.startsWith(`${lines.join('\n')}\n`)).toBe(true)
    const record = JSON.parse(text.trimEnd().split('\n')[4]!)
    expect(record).toMatchObject({ seq: 5, action: 'audit.torn-tail-removed', detail: { bytes: Buffer.byteLength(torn) } })
    expect(await verifyAuditFile(file)).toMatchObject({ ok: true, records: 5 })
  })

  it('refuses the action when the append cannot be made durable, without moving the head', async () => {
    const path = directory()
    let failSync = 0
    const fs: AuditFs = {
      async open(file) {
        const handle = await open(file, 'a', 0o600)
        return {
          write: data => handle.write(data),
          sync: async () => {
            if (failSync > 0) {
              failSync -= 1
              throw Object.assign(new Error('EIO'), { code: 'EIO' })
            }
            await handle.sync()
          },
          truncate: length => handle.truncate(length),
          close: () => handle.close(),
        }
      },
    }
    const log = await openLog(path, { fs })
    await log.append({ action: 'task.cancelled', actor: { listener: 'host' }, detail: { sessionId: 's-1' } })
    const head = log.head()
    failSync = 1
    await expect(log.append({ action: 'task.cancelled', actor: { listener: 'host' }, detail: { sessionId: 's-2' } })).rejects.toMatchObject(
      { status: 503, code: 'audit-unavailable', message: '审计记录写入失败，操作未执行' },
    )
    expect(log.head()).toEqual(head)
    // The unacknowledged line was cut back, so the chain stays valid and later appends continue it.
    await log.append({ action: 'task.cancelled', actor: { listener: 'host' }, detail: { sessionId: 's-3' } })
    expect(await verifyAuditFile(join(path, 'audit.jsonl'))).toMatchObject({ ok: true, records: 2 })

    failSync = 2
    await expect(log.append({ action: 'task.cancelled', actor: { listener: 'host' }, detail: { sessionId: 's-4' } })).rejects.toMatchObject(
      { code: 'audit-unavailable' },
    )
    // Recovery failed too: every later append is refused until the Host restarts.
    await expect(log.append({ action: 'task.cancelled', actor: { listener: 'host' }, detail: { sessionId: 's-5' } })).rejects.toMatchObject(
      { code: 'audit-unavailable' },
    )
  })

  it('treats a short write as a failed append, so an acknowledged record is always complete', async () => {
    const path = directory()
    let short = false
    const fs: AuditFs = {
      async open(file) {
        const handle = await open(file, 'a', 0o600)
        return {
          // A disk that fills up mid-write reports a short count, not an error.
          write: async data => (short ? handle.write(data.subarray(0, data.length - 7)) : handle.write(data)),
          sync: () => handle.sync(),
          truncate: length => handle.truncate(length),
          close: () => handle.close(),
        }
      },
    }
    const log = await openLog(path, { fs })
    await log.append({ action: 'task.cancelled', actor: { listener: 'host' }, detail: { sessionId: 's-1' } })
    const head = log.head()
    short = true
    await expect(
      log.append({
        action: 'policy.changed',
        actor: { listener: 'host' },
        detail: { before: hash('a'), after: hash('b'), fields: ['remote.maxLevel'], lowering: false },
      }),
    ).rejects.toMatchObject({ status: 503, code: 'audit-unavailable' })
    expect(log.head()).toEqual(head)
    short = false
    await log.append({ action: 'task.cancelled', actor: { listener: 'host' }, detail: { sessionId: 's-2' } })
    const file = join(path, 'audit.jsonl')
    expect(readFileSync(file, 'utf8')).not.toContain('\u0000')
    expect(await verifyAuditFile(file)).toMatchObject({ ok: true, records: 2 })
    await log.close()
    cleanups.pop()
    const reopened = await openLog(path)
    expect(reopened.latest(['audit.torn-tail-removed'])).toBeUndefined()
    expect(readdirSync(path)).toEqual(['audit.jsonl'])
  })

  it('accepts the workspace and settings records and returns the last record of an action', async () => {
    const log = await openLog(directory())
    const actor = { listener: 'host' as const, via: 'startup' as const }
    const started = (settingsHash: string) => ({
      hostId: 'a'.repeat(52),
      version: '0.1.0',
      policyHash: hash('p'),
      settingsHash,
      devMode: true,
    })
    await log.append({ action: 'host.started', actor, detail: started(hash('s1')) })
    await log.append({ action: 'host.started', actor, detail: started(hash('s2')) })
    await log.append({ action: 'settings.changed', actor, detail: { before: hash('s2'), after: hash('s3') } })
    await log.append({ action: 'settings.changed-outside', actor, detail: { expected: hash('s3'), actual: hash('s4') } })
    await log.append({ action: 'settings.changed-outside', actor, detail: { expected: '', actual: hash('s4') } })
    for (const reason of ['overlap', 'code-root', 'protected', 'invalid'] as const) {
      await log.append({ action: 'workspace.disabled', actor, target: 'w-1', detail: { workspaceId: 'w-1', reason } })
    }
    await log.append({ action: 'device.revocations.torn-tail-removed', actor, detail: { bytes: 14 } })
    expect(log.lastOf('host.started')?.detail).toEqual(started(hash('s2')))
    expect(log.lastOf('workspace.disabled')).toMatchObject({ seq: 9, detail: { workspaceId: 'w-1', reason: 'invalid' } })
    expect(log.lastOf('policy.changed')).toBeUndefined()
    const invalid = expect.objectContaining({ code: 'audit-detail-invalid' })
    await expect(
      log.append({ action: 'workspace.disabled', actor, detail: { workspaceId: 'w-1', reason: 'other' } as never }),
    ).rejects.toEqual(invalid)
    await expect(
      log.append({ action: 'workspace.disabled', actor, detail: { workspaceId: '/Users/me/project', reason: 'overlap' } }),
    ).rejects.toEqual(invalid)
    await expect(log.append({ action: 'settings.changed-outside', actor, detail: { expected: 'x', actual: hash('s') } })).rejects.toEqual(
      invalid,
    )
  })

  it('accepts the credential issue and full-access intent records with their strict details', async () => {
    const log = await openLog(directory())
    const actor = { deviceId: `dev_${'a'.repeat(22)}`, listener: 'unix' as const, via: 'http' as const }
    await log.append({ action: 'device.credential.issued', actor, target: actor.deviceId, detail: { deviceId: actor.deviceId } })
    await log.append({
      action: 'task.l3.start-requested',
      actor,
      stepup: 'lpc-local',
      detail: { harnessId: 'codex', launchHash: hash('launch') },
    })
    expect(log.lastOf('task.l3.start-requested')).toMatchObject({
      seq: 2,
      stepup: 'lpc-local',
      detail: { harnessId: 'codex', launchHash: hash('launch') },
    })
    const invalid = expect.objectContaining({ code: 'audit-detail-invalid' })
    await expect(
      log.append({ action: 'device.credential.issued', actor, detail: { deviceId: actor.deviceId, credential: 'x' } as never }),
    ).rejects.toEqual(invalid)
    await expect(
      log.append({ action: 'task.l3.start-requested', actor, detail: { harnessId: 'codex', launchHash: 'abc' } }),
    ).rejects.toEqual(invalid)
    await expect(
      log.append({
        action: 'task.l3.start-requested',
        actor,
        detail: { harnessId: 'codex', launchHash: hash('launch'), sessionId: 's' } as never,
      }),
    ).rejects.toEqual(invalid)
  })

  it('rejects details with extra keys or values that are not ids, hashes, enums, booleans or counts', async () => {
    const log = await openLog(directory())
    const invalid = expect.objectContaining({ status: 500, code: 'audit-detail-invalid' })
    const actor = { listener: 'host' as const }
    await expect(log.append({ action: 'task.cancelled', actor, detail: { sessionId: 's', extra: 1 } as never })).rejects.toEqual(invalid)
    await expect(log.append({ action: 'task.cancelled', actor, detail: { sessionId: '/Users/me/secret' } })).rejects.toEqual(invalid)
    await expect(log.append({ action: 'task.cancelled', actor, detail: { sessionId: 'has space' } })).rejects.toEqual(invalid)
    await expect(log.append({ action: 'workspace.added', actor, detail: { workspaceId: 'w', pathHash: '/tmp/project' } })).rejects.toEqual(
      invalid,
    )
    await expect(log.append({ action: 'device.renamed', actor, detail: { deviceId: '我的手机' } })).rejects.toEqual(invalid)
    await expect(
      log.append({ action: 'device.revoked', actor, detail: { deviceId, reason: 'because', cascaded: 0 } as never }),
    ).rejects.toEqual(invalid)
    await expect(log.append({ action: 'task.cancelled', actor, target: '../etc', detail: { sessionId: 's' } })).rejects.toEqual(invalid)
    await expect(
      log.append({ action: 'task.cancelled', actor: { listener: 'host', name: 'x' } as never, detail: { sessionId: 's' } }),
    ).rejects.toEqual(invalid)
    await expect(log.append({ action: 'nope' as never, actor, detail: {} as never })).rejects.toEqual(invalid)
    expect(log.head().seq).toBe(0)
    await expect(log.append({ action: 'task.cancelled', actor, detail: { sessionId: 'task-1' } })).resolves.toMatchObject({ seq: 1 })
  })

  it('leaves no stray files behind on a clean run', async () => {
    const { path } = await populated()
    expect(readdirSync(path)).toEqual(['audit.jsonl'])
  })
})
