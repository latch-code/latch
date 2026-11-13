import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { AppError } from '@latch/sdk'
import { ConfigRequests } from '../src/config-requests.ts'
import { SessionMetaStore, SESSION_META_FILE, RECEIPTS_PER_DEVICE, RECEIPT_TTL_MS, type ConfigRecord } from '../src/session-meta.ts'

const paths: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true })
})
const actor = () => ({ deviceId: 'device-a', authorize: vi.fn(async () => {}) })
const input = () => ({ requestId: randomUUID(), configId: 'private-custom-field', value: 'PRIVATE CONFIG VALUE' })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'latch-config-receipts-'))
  paths.push(dir)
  const meta = await SessionMetaStore.open(dir),
    requests = new ConfigRequests(meta)
  return { dir, meta, requests, caller: actor() }
}

test('coalesces an in-flight identity, conflicts before side effects, and only returns durable applied receipts', async () => {
  const f = await fixture(),
    request = input()
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const execute = vi.fn(async (begin: () => Promise<void>) => {
    await begin()
    await gate
  })
  const first = f.requests.apply('task-a', f.caller, request, execute)
  await expect.poll(() => f.meta.config('task-a', f.caller.deviceId, request.requestId)?.state).toBe('pending')
  const duplicate = f.requests.apply('task-a', f.caller, request, execute)
  await expect(f.requests.apply('task-a', f.caller, { ...request, value: 'changed' }, execute)).rejects.toMatchObject({
    code: 'request-conflict',
  })
  expect(f.requests.state('task-a', 'device-b', request.requestId)).toBe('unknown')
  release()
  await Promise.all([first, duplicate])
  expect(execute).toHaveBeenCalledTimes(1)
  expect(f.requests.state('task-a', f.caller.deviceId, request.requestId)).toBe('applied')
  await f.requests.apply('task-a', f.caller, request, execute)
  expect(execute).toHaveBeenCalledTimes(1)
  const disk = await readFile(join(f.dir, SESSION_META_FILE), 'utf8')
  expect(disk).not.toContain(request.value)
  expect(disk).not.toContain(request.configId)
  const restored = new ConfigRequests(await SessionMetaStore.open(f.dir))
  await restored.apply('task-a', f.caller, request, execute)
  expect(execute).toHaveBeenCalledTimes(1)
})

test.each(['pending', 'applied'] as const)('never executes twice after %s receipt publication becomes unknown', async phase => {
  const f = await fixture(),
    request = input(),
    save = f.meta.recordConfig.bind(f.meta),
    calls = vi.fn()
  vi.spyOn(f.meta, 'recordConfig').mockImplementation(async (id, receipt) => {
    if (receipt.state === phase) {
      if (phase === 'applied') await save(id, receipt)
      throw new Error('fixture storage acknowledgement missing')
    }
    await save(id, receipt)
  })
  const execute = async (begin: () => Promise<void>) => {
    await begin()
    calls()
  }
  await expect(f.requests.apply('task-a', f.caller, request, execute)).rejects.toMatchObject({ code: 'config-outcome-unknown' })
  expect(calls).toHaveBeenCalledTimes(phase === 'pending' ? 0 : 1)
  expect(f.requests.state('task-a', f.caller.deviceId, request.requestId)).toBe('unknown')
  await expect(f.requests.apply('task-a', f.caller, request, execute)).rejects.toMatchObject({ code: 'config-outcome-unknown' })
  const restored = new ConfigRequests(await SessionMetaStore.open(f.dir))
  await expect(restored.apply('task-a', f.caller, request, execute)).rejects.toMatchObject({ code: 'config-outcome-unknown' })
  expect(calls).toHaveBeenCalledTimes(phase === 'pending' ? 0 : 1)
})

test('keeps timeouts unknown and local invalid requests failed, while a real confirmation challenge can continue with the same identity', async () => {
  const f = await fixture(),
    timed = input(),
    bad = input(),
    challenge = input()
  await expect(
    f.requests.apply('task-a', f.caller, timed, async begin => {
      await begin()
      throw new AppError(504, 'agent-timeout', 'timeout')
    }),
  ).rejects.toMatchObject({ code: 'config-outcome-unknown' })
  expect(f.requests.state('task-a', f.caller.deviceId, timed.requestId)).toBe('unknown')
  await expect(
    f.requests.apply('task-a', f.caller, bad, async () => {
      throw new AppError(400, 'config-value-invalid', 'invalid')
    }),
  ).rejects.toMatchObject({ code: 'config-value-invalid' })
  expect(f.requests.state('task-a', f.caller.deviceId, bad.requestId)).toBe('failed')
  await expect(
    f.requests.apply('task-a', f.caller, challenge, async () => {
      throw new AppError(403, 'stepup-required', 'confirm')
    }),
  ).rejects.toMatchObject({ code: 'stepup-required' })
  expect(f.meta.config('task-a', f.caller.deviceId, challenge.requestId)).toBeUndefined()
  await expect(f.requests.apply('task-a', f.caller, { ...challenge, value: 'new' }, async () => {})).rejects.toMatchObject({
    code: 'request-conflict',
  })
  await f.requests.apply('task-a', f.caller, challenge, async begin => {
    await begin()
  })
  expect(f.requests.state('task-a', f.caller.deviceId, challenge.requestId)).toBe('applied')
})

test('rechecks the waiting caller after an actual call settles and does not let a revoked reader retrieve applied authority', async () => {
  const f = await fixture(),
    request = input()
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let entered = false
  const result = f.requests.apply('task-a', f.caller, request, async begin => {
    await begin()
    entered = true
    await gate
  })
  await expect.poll(() => entered).toBe(true)
  f.caller.authorize.mockRejectedValue(new AppError(403, 'scope-required', 'revoked'))
  release()
  await expect(result).rejects.toMatchObject({ code: 'scope-required' })
  expect(f.meta.config('task-a', f.caller.deviceId, request.requestId)?.state).toBe('applied')
})

test('preserves pending and unknown identities through TTL, refuses capacity without evicting them, and fails closed on corrupt config receipts', async () => {
  const f = await fixture(),
    now = Date.now(),
    old = new Date(now - 2 * RECEIPT_TTL_MS).toISOString()
  const records: ConfigRecord[] = Array.from({ length: RECEIPTS_PER_DEVICE }, (_, i) => ({
    kind: 'config',
    deviceId: f.caller.deviceId,
    requestId: `request-${String(i).padStart(8, '0')}`,
    payloadHash: 'a'.repeat(64),
    state: i ? 'unknown' : 'pending',
    at: old,
  }))
  const source = JSON.stringify({ version: 1, sessions: [{ id: 'task-a', receipts: records }] })
  await writeFile(join(f.dir, SESSION_META_FILE), source, { mode: 0o600 })
  const meta = await SessionMetaStore.open(f.dir),
    restored = new ConfigRequests(meta)
  expect(restored.state('task-a', f.caller.deviceId, records[0]!.requestId)).toBe('unknown')
  const called = vi.fn()
  await expect(
    restored.apply('task-a', f.caller, input(), async begin => {
      await begin()
      called()
    }),
  ).rejects.toMatchObject({ code: 'config-outcome-unknown' })
  expect(called).not.toHaveBeenCalled()
  expect(meta.config('task-a', f.caller.deviceId, records[0]!.requestId)).toBeDefined()
  expect(await readFile(join(f.dir, SESSION_META_FILE), 'utf8')).toBe(source)
  await writeFile(
    join(f.dir, SESSION_META_FILE),
    JSON.stringify({ version: 1, sessions: [{ id: 'task-a', receipts: [{ ...records[0], value: 'do not accept extra value' }] }] }),
  )
  await expect(SessionMetaStore.open(f.dir)).rejects.toMatchObject({ code: 'config-corrupt' })
})

test.each(['pending', 'applied'] as const)('keeps %s publication failures unknown with a real blocked metadata directory', async phase => {
  const f = await fixture(),
    request = input(),
    backup = f.dir + '-saved',
    invoked = vi.fn()
  let blocked = false
  const block = async () => {
    await rename(f.dir, backup)
    await writeFile(f.dir, 'fixture blocked directory')
    blocked = true
  }
  try {
    if (phase === 'pending') await block()
    await expect(
      f.requests.apply('task-a', f.caller, request, async begin => {
        await begin()
        invoked()
        if (phase === 'applied') await block()
      }),
    ).rejects.toMatchObject({ code: 'config-outcome-unknown' })
    expect(f.meta.config('task-a', f.caller.deviceId, request.requestId)?.state).toBe('unknown')
    expect(f.requests.state('task-a', f.caller.deviceId, request.requestId)).toBe('unknown')
    expect(invoked).toHaveBeenCalledTimes(phase === 'pending' ? 0 : 1)
    await expect(
      f.requests.apply('task-a', f.caller, request, async () => {
        invoked()
      }),
    ).rejects.toMatchObject({ code: 'config-outcome-unknown' })
    expect(invoked).toHaveBeenCalledTimes(phase === 'pending' ? 0 : 1)
  } finally {
    if (blocked) {
      await rm(f.dir)
      await rename(backup, f.dir)
    }
  }
  const restored = new ConfigRequests(await SessionMetaStore.open(f.dir))
  expect(restored.state('task-a', f.caller.deviceId, request.requestId)).toBe('unknown')
  if (phase === 'applied')
    await expect(
      restored.apply('task-a', f.caller, request, async () => {
        invoked()
      }),
    ).rejects.toMatchObject({ code: 'config-outcome-unknown' })
  expect(invoked).toHaveBeenCalledTimes(phase === 'pending' ? 0 : 1)
})

test('bounds same-RID waiters without starting another execution', async () => {
  const f = await fixture(),
    request = input()
  let release!: () => void,
    entered = false
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    execute = vi.fn(async (begin: () => Promise<void>) => {
      await begin()
      entered = true
      await gate
    })
  const first = f.requests.apply('task-a', f.caller, request, execute)
  await expect.poll(() => entered).toBe(true)
  const waiting = Array.from({ length: 32 }, () => f.requests.apply('task-a', f.caller, request, execute))
  await expect(f.requests.apply('task-a', f.caller, request, execute)).rejects.toMatchObject({ code: 'config-requests-busy' })
  release()
  await Promise.all([first, ...waiting])
  expect(execute).toHaveBeenCalledTimes(1)
})

test.each(['not-sent', 'refused'] as const)('records a change the driver marks %s as failed, never unknown', async outcome => {
  const f = await fixture(),
    request = input()
  const execute = async (begin: () => Promise<void>) => {
    await begin()
    throw new AppError(502, 'agent-error', 'refused', { configOutcome: outcome })
  }
  await expect(f.requests.apply('task-a', f.caller, request, execute)).rejects.toMatchObject({ code: 'agent-error' })
  expect(f.requests.state('task-a', f.caller.deviceId, request.requestId)).toBe('failed')
})

test('核对 settles only an unknown receipt of the same content: applied when asked, failed only back at the prior value', async () => {
  const f = await fixture(),
    lost = (prior?: string) => async (begin: (context?: { prior?: string; auditSeq?: number }) => Promise<void>) => {
      await begin({ prior, auditSeq: 7 })
      throw new AppError(504, 'agent-timeout', 'no answer')
    }
  const applied = input(),
    failed = input(),
    neither = input(),
    unread = input(),
    legacy = input()
  for (const request of [applied, failed, neither, unread])
    await expect(f.requests.apply('task-a', f.caller, request, lost('OLD VALUE'))).rejects.toMatchObject({ code: 'config-outcome-unknown' })
  // Written before receipts kept the prior value: only a match settles it.
  await expect(f.requests.apply('task-a', f.caller, legacy, lost())).rejects.toMatchObject({ code: 'config-outcome-unknown' })
  const read = vi.fn(async () => ({ kind: 'read' as const, currentValue: `${applied.value}/high`, asked: true }))
  await expect(f.requests.check('task-a', f.caller, { ...applied, value: 'other' }, read)).rejects.toMatchObject({
    code: 'request-conflict',
  })
  expect(await f.requests.check('task-a', f.caller, applied, read)).toEqual({ state: 'applied', settled: true, auditSeq: 7 })
  const back = async () => ({ kind: 'read' as const, currentValue: 'OLD VALUE', asked: false })
  expect(await f.requests.check('task-a', f.caller, failed, back)).toEqual({ state: 'failed', settled: true, auditSeq: 7 })
  // Neither the asked nor the prior value (another device changed it meanwhile): still unknown.
  const elsewhere = async () => ({ kind: 'read' as const, currentValue: 'THIRD VALUE', asked: false })
  expect(await f.requests.check('task-a', f.caller, neither, elsewhere)).toMatchObject({ state: 'unknown', reason: 'neither' })
  expect(await f.requests.check('task-a', f.caller, unread, async () => ({ kind: 'busy', reason: 'subagents' }))).toMatchObject({
    state: 'unknown',
    reason: 'subagents',
  })
  expect(await f.requests.check('task-a', f.caller, legacy, back)).toMatchObject({ state: 'unknown', reason: 'neither' })
  expect(f.requests.state('task-a', f.caller.deviceId, unread.requestId)).toBe('unknown')
  // A settled receipt is answered without reading again, and another device has nothing to settle.
  expect(await f.requests.check('task-a', f.caller, applied, read)).toEqual({ state: 'applied', settled: false })
  expect((await f.requests.check('task-a', { ...actor(), deviceId: 'device-b' }, unread, read)).state).toBe('unknown')
  expect(read).toHaveBeenCalledTimes(1)
  // What survives a restart is the settled state; the disk holds hashes only.
  const restored = new ConfigRequests(await SessionMetaStore.open(f.dir))
  expect(restored.state('task-a', f.caller.deviceId, failed.requestId)).toBe('failed')
  expect(await readFile(join(f.dir, SESSION_META_FILE), 'utf8')).not.toContain('OLD VALUE')
})
