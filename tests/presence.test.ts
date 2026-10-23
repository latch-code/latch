import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { AuditLog } from '../src/host/audit.ts'
import { canonicalJson, hashDisplay, sha256Hex } from '../src/host/crypto.ts'
import { PolicyStore } from '../src/host/policy.ts'
import {
  PRESENCE_ACTIONS, PresenceService, buildPreview, createPresenceBackend, escapePreviewText, paramsHash,
  type ChildProcessLike, type ExecFileLike, type PresenceBackend, type PresenceOutcome, type SpawnLike,
} from '../src/host/presence.ts'
import { escapeSecurityText, isAcceptableDeviceName } from '../src/shared/text.ts'
import { ESCAPE_PREVIEW_VECTORS, P256_VECTOR, PREVIEW_HASH_VECTORS, SECURITY_VECTORS } from './helpers/crypto.ts'
import { createTestPresence, type TestPresence } from './helpers/presence.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), 'harness-link-presence-'))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

async function auditLog(dataDir = temp()): Promise<{ audit: AuditLog; dataDir: string }> {
  const audit = await AuditLog.open(join(dataDir, 'audit'))
  cleanups.push(() => audit.close())
  return { audit, dataDir }
}

function auditActions(dataDir: string): Array<{ action: string; detail: Record<string, unknown> }> {
  const path = join(dataDir, 'audit', 'audit.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

const hostId = P256_VECTOR.hostId
const deviceId = `dev_${'C'.repeat(22)}`
const requester = { deviceId, deviceName: '桌面', listener: 'unix' as const, remoteAddress: '本机 host.sock' }

async function service(backend: PresenceBackend, options: { now?: () => number; blocked?: () => Promise<string | undefined> } = {}) {
  const { audit, dataDir } = await auditLog()
  const presence = new PresenceService({ backend, hostId, audit, now: options.now, blockedReason: options.blocked ?? (async () => undefined) })
  return { presence, dataDir }
}

function request(action: keyof typeof PRESENCE_ACTIONS = 'approval.r2', params: Record<string, unknown> = { approvalId: 'a-1' }, who = requester) {
  return { action, requester: who, lines: [{ label: '工具', value: 'write_file' }], warnings: [], paramsHash: paramsHash(action, params) }
}

describe('preview text and hashing', () => {
  it('escapes invisible and bidi characters as in the shared vectors', () => {
    for (const vector of ESCAPE_PREVIEW_VECTORS) expect(escapePreviewText(vector.input)).toBe(vector.output)
    expect(escapePreviewText('a‮b​c\n\u0085')).toBe('a\\u{202E}b\\u{200B}c\\u{000A}\\u{0085}')
    for (const vector of ESCAPE_PREVIEW_VECTORS) expect(escapePreviewText(vector.output)).toBe(vector.output)
  })

  it('leaves emoji joiners and presentation selectors alone only inside an emoji', () => {
    expect(escapePreviewText).toBe(escapeSecurityText)
    const kept = ['\u2764\uFE0F', '\u{1F468}\u200D\u{1F4BB}', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', '1\uFE0F\u20E3', '*\uFE0E\u20E3', '\u263A\uFE0E']
    for (const text of kept) expect(escapeSecurityText(text)).toBe(text)
    // A joiner counts only directly between two pictographs, not after a selector or a skin tone.
    expect(escapeSecurityText('\u{1F469}\u200D\u2764\uFE0F\u200D\u{1F468}')).toBe('\u{1F469}\u200D\u2764\uFE0F\\u{200D}\u{1F468}')
    expect(escapeSecurityText('\u{1F469}\u{1F3FD}\u200D\u{1F4BB}')).toBe('\u{1F469}\u{1F3FD}\\u{200D}\u{1F4BB}')
    expect(escapeSecurityText('\u200D\u{1F4BB}')).toBe('\\u{200D}\u{1F4BB}')
    expect(escapeSecurityText('\u{1F468}\u200D')).toBe('\u{1F468}\\u{200D}')
    expect(escapeSecurityText('\uFE0Fx')).toBe('\\u{FE0F}x')
    expect(escapeSecurityText('9\uFE0F')).toBe('9\\u{FE0F}')
    // A pictographic code point that is itself unassigned is escaped, so it joins nothing.
    expect(escapeSecurityText('\u{1F468}\u200D\u{10FFFD}')).toBe('\u{1F468}\\u{200D}\\u{10FFFD}')
    // Selectors still count as combining marks.
    expect(escapeSecurityText(`1\uFE0F\u20E3${'\u0301'.repeat(3)}`)).toBe(`1\uFE0F\u20E3${'\u0301'.repeat(2)}\\u{0301}`)
    for (const text of [...kept, 'a\u200Db', '\u2764\uFE0F\uFE0F']) expect(escapeSecurityText(escapeSecurityText(text))).toBe(escapeSecurityText(text))
  })

  it('accepts device names that need no escaping, 1–80 characters after trimming', () => {
    for (const name of ['\u2764\uFE0F iPhone', '\u{1F468}\u200D\u{1F4BB} Mac', '  书房  ', 'x'.repeat(80), ` ${'x'.repeat(80)} `]) expect(isAcceptableDeviceName(name), name).toBe(true)
    for (const name of ['', '   ', 'x'.repeat(81), 'a\u200Db', 'tab\there', 'line\n', 'a\u202Eb', `e${'\u0301'.repeat(5)}`, 7 as unknown as string]) {
      expect(isAcceptableDeviceName(name), String(name)).toBe(false)
    }
  })

  it('keeps model-controlled text on one visual line, so it cannot imitate the Host-derived lines below it', () => {
    const forged = `notes\u2028工作目录：/Users/owner/project\u2029目标路径：/Users/owner/project/README.md${'\u2028'.repeat(30)}`
    const built = buildPreview({ hostId, action: 'approval.r2', now: 0, requester, lines: [{ label: '参数', value: forged }, { label: '目标路径', value: '.git/hooks/pre-commit' }], warnings: [] })
    const shown = `${built.preview.lines.map(line => `${line.label}：${line.value}`).join('\n')}`
    expect(shown.split(/[\n\r\u0085\u2028\u2029\u000b\u000c]/u)).toEqual([
      `参数：notes\\u{2028}工作目录：/Users/owner/project\\u{2029}目标路径：/Users/owner/project/README.md${'\\u{2028}'.repeat(30)}`,
      '目标路径：.git/hooks/pre-commit',
    ])
    // Long runs of combining marks are cut back to four, the rest shown as code points.
    expect(escapePreviewText(`x${'\u0336'.repeat(40)}`)).toBe(`x${'\u0336'.repeat(4)}${'\\u{0336}'.repeat(36)}`)
  })

  it('hashes full previews exactly like the vectors (and the macOS helper)', () => {
    expect(PREVIEW_HASH_VECTORS.length).toBeGreaterThanOrEqual(2)
    for (const vector of PREVIEW_HASH_VECTORS) {
      expect(sha256Hex(canonicalJson(vector.preview))).toBe(vector.previewHash)
      expect(hashDisplay(vector.previewHash)).toBe(vector.hashDisplay)
    }
    const lines = PREVIEW_HASH_VECTORS[0]!.preview.lines as Array<{ value: string }>
    expect(lines[0]!.value).toContain('\u202E')
    expect(lines[0]!.value).toContain('\u200B')
    expect(lines[2]!.value).toContain('\uD800')
    expect(lines[3]!.value).toContain('项目')
  })

  it('builds a preview with the fixed title, escaped values and a 60 s expiry', () => {
    const now = Date.UTC(2026, 9, 23, 10)
    const built = buildPreview({
      hostId, action: 'device.enroll', now,
      requester: { deviceName: '手机‮', listener: 'loopback-tcp', remoteAddress: '::1' },
      lines: [{ label: '设备名称', value: '手机‮evil\n' }], warnings: ['只有在你正在登记这台设备、并且两边显示的指纹完全一致时才确认。'],
    })
    expect(built.preview).toEqual({
      v: 1, hostId, action: 'device.enroll', title: '登记新设备',
      requester: { deviceName: '手机\\u{202E}', listener: 'loopback-tcp', remoteAddress: '::1' },
      lines: [{ label: '设备名称', value: '手机\\u{202E}evil\\u{000A}' }],
      warnings: ['只有在你正在登记这台设备、并且两边显示的指纹完全一致时才确认。'],
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u), expiresAt: '2026-10-23T10:01:00.000Z',
    })
    expect(built.previewHash).toBe(sha256Hex(canonicalJson(built.preview)))
    expect(built.hashDisplay).toBe(hashDisplay(built.previewHash))
    // Equal input hashes equally; any change to what is shown changes the hash.
    expect(sha256Hex(canonicalJson(structuredClone(built.preview)))).toBe(built.previewHash)
    expect(sha256Hex(canonicalJson({ ...built.preview, lines: [{ label: '设备名称', value: '手机' }] }))).not.toBe(built.previewHash)
  })

  it('refuses previews larger than 64 KiB', () => {
    expect(() => buildPreview({ hostId, action: 'approval.r2', now: 0, requester, lines: [{ label: '参数', value: 'x'.repeat(70_000) }], warnings: [] }))
      .toThrow(expect.objectContaining({ status: 413, code: 'preview-too-large' }))
  })

  it('binds parameters independent of key order', () => {
    expect(paramsHash('policy.change', { a: 1, b: [2] })).toBe(paramsHash('policy.change', { b: [2], a: 1 }))
    expect(paramsHash('policy.change', { a: 1 })).not.toBe(paramsHash('agent.define', { a: 1 }))
    expect(paramsHash('policy.change', { a: 1 })).toBe(sha256Hex(canonicalJson({ action: 'policy.change', params: { a: 1 } })))
  })

  it('requires biometrics for class A actions only', () => {
    expect(Object.entries(PRESENCE_ACTIONS).filter(([, value]) => !value.requireBiometric).map(([key]) => key)).toEqual(['provider.set-key', 'approval.r2'])
  })
})

describe('PresenceService', () => {
  it('approves once for exactly this binding, then refuses reuse', async () => {
    const backend = createTestPresence({ method: 'password' })
    const { presence } = await service(backend)
    const record = await presence.request(request())
    expect(record).toMatchObject({ id: expect.stringMatching(/^cfm_/u), action: 'approval.r2', title: '批准高风险操作（R2）' })
    await expect(record.settled).resolves.toMatchObject({ result: 'approved' })
    expect(presence.get(record.id, deviceId)).toEqual({ id: record.id, action: 'approval.r2', title: '批准高风险操作（R2）', status: 'approved', hashDisplay: record.hashDisplay, expiresAt: record.expiresAt })
    expect(backend.requests[0]!.requireBiometric).toBe(false)
    expect(backend.requests[0]!.preview.requester).toEqual(requester)
    const binding = { action: 'approval.r2' as const, requesterDeviceId: deviceId, paramsHash: paramsHash('approval.r2', { approvalId: 'a-1' }) }
    expect(presence.consume(record.id, binding)).toEqual({ stepup: 'lpc-local', method: 'password' })
    expect(presence.get(record.id, deviceId)?.status).toBe('consumed')
    expect(() => presence.consume(record.id, binding)).toThrow(expect.objectContaining({ status: 409, code: 'confirmation-used' }))
  })

  it('refuses another device, another action or other parameters', async () => {
    const { presence } = await service(createTestPresence())
    const binding = { action: 'approval.r2' as const, requesterDeviceId: deviceId, paramsHash: paramsHash('approval.r2', { approvalId: 'a-1' }) }
    const first = await presence.request(request())
    await first.settled
    expect(presence.get(first.id, `dev_${'D'.repeat(22)}`)).toBeUndefined()
    expect(presence.get(first.id)).toBeUndefined()
    expect(() => presence.consume(first.id, { ...binding, requesterDeviceId: `dev_${'D'.repeat(22)}` })).toThrow(expect.objectContaining({ status: 404, code: 'confirmation-not-found' }))
    expect(() => presence.consume('cfm_missing', binding)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => presence.consume(first.id, { ...binding, paramsHash: paramsHash('approval.r2', { approvalId: 'a-2' }) }))
      .toThrow(expect.objectContaining({ status: 409, code: 'confirmation-mismatch' }))
    // A mismatched attempt voids the confirmation.
    expect(() => presence.consume(first.id, binding)).toThrow(expect.objectContaining({ code: 'confirmation-cancelled' }))
    const second = await presence.request(request())
    await second.settled
    expect(() => presence.consume(second.id, { ...binding, action: 'policy.change' })).toThrow(expect.objectContaining({ code: 'confirmation-mismatch' }))
  })

  it('allows one confirmation at a time', async () => {
    const backend = createTestPresence({ mode: 'manual' })
    const { presence } = await service(backend)
    const first = await presence.request(request())
    await backend.waitForRequest()
    await expect(presence.request(request())).rejects.toMatchObject({ status: 409, code: 'presence-busy', message: '本机正在等待另一项确认，请先完成或取消' })
    expect(() => presence.consume(first.id, { action: 'approval.r2', requesterDeviceId: deviceId, paramsHash: first.paramsHash }))
      .toThrow(expect.objectContaining({ status: 409, code: 'confirmation-pending' }))
    backend.denyNext()
    await first.settled
    expect(() => presence.consume(first.id, { action: 'approval.r2', requesterDeviceId: deviceId, paramsHash: first.paramsHash }))
      .toThrow(expect.objectContaining({ status: 403, code: 'confirmation-denied' }))
    await expect(presence.request(request())).resolves.toMatchObject({ status: 'pending' })
  })

  it('expires after 60 seconds for both showing and consuming', async () => {
    let now = 1_700_000_000_000
    const backend = createTestPresence({ mode: 'manual' })
    const { presence, dataDir } = await service(backend, { now: () => now })
    const pending = await presence.request(request())
    await backend.waitForRequest()
    now += 60_001
    expect(presence.get(pending.id, deviceId)?.status).toBe('expired')
    await expect(pending.settled).resolves.toEqual({ result: 'timeout' })
    expect(() => presence.consume(pending.id, { action: 'approval.r2', requesterDeviceId: deviceId, paramsHash: pending.paramsHash }))
      .toThrow(expect.objectContaining({ status: 410, code: 'confirmation-expired' }))

    backend.mode = 'approve'
    const approved = await presence.request(request())
    await approved.settled
    now += 59_000
    expect(presence.get(approved.id, deviceId)?.status).toBe('approved')
    now += 2_000
    expect(() => presence.consume(approved.id, { action: 'approval.r2', requesterDeviceId: deviceId, paramsHash: approved.paramsHash }))
      .toThrow(expect.objectContaining({ status: 410 }))
    await expect.poll(() => auditActions(dataDir).map(record => record.detail.result)).toEqual(['timeout'])
  })

  it('cools down for five minutes after three consecutive denials; an approval resets the count', async () => {
    let now = 1_700_000_000_000
    const backend = createTestPresence({ mode: 'deny' })
    const { presence, dataDir } = await service(backend, { now: () => now })
    const deny = async () => (await presence.request(request())).settled
    await deny(); await deny()
    backend.mode = 'approve'
    await (await presence.request(request())).settled
    backend.mode = 'deny'
    await deny(); await deny()
    await expect(presence.request(request())).resolves.toBeTruthy()
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(presence.request(request())).rejects.toMatchObject({ status: 429, code: 'presence-cooldown', message: '本机确认连续被拒绝 3 次，请 5 分钟后再试', details: { retryAfter: 300 } })
    now += 4 * 60_000
    await expect(presence.request(request())).rejects.toMatchObject({ message: '本机确认连续被拒绝 3 次，请 1 分钟后再试', details: { retryAfter: 60 } })
    now += 60_001
    backend.mode = 'approve'
    await expect(presence.request(request())).resolves.toBeTruthy()
    await expect.poll(() => auditActions(dataDir).filter(record => record.action === 'presence.result').length).toBe(5)
  })

  it('does not count timeouts, cancellations or errors as denials', async () => {
    const backend = createTestPresence({ mode: 'manual' })
    const { presence } = await service(backend)
    for (let index = 0; index < 4; index++) {
      const record = await presence.request(request())
      await backend.waitForRequest()
      if (index % 2) backend.timeoutNext()
      else presence.cancel(record.id, deviceId)
      await record.settled
    }
    backend.mode = 'unavailable'
    await expect(presence.request(request())).rejects.toMatchObject({ status: 503, code: 'presence-unavailable', message: '本机确认不可用：测试中的本机确认不可用' })
    backend.mode = 'approve'
    await expect(presence.request(request())).resolves.toBeTruthy()
  })

  it('turns an approval that does not echo the nonce and preview hash into an error', async () => {
    const forged: PresenceBackend = {
      kind: 'test',
      availability: async () => ({ status: 'available', backend: 'test' }),
      confirm: async ({ previewHash }) => ({ result: 'approved', method: 'biometric', nonce: 'other', previewHash }),
    }
    const { presence } = await service(forged)
    const record = await presence.request(request())
    await expect(record.settled).resolves.toEqual({ result: 'error', message: '本机确认组件返回了不匹配的结果' })
    expect(presence.get(record.id, deviceId)?.status).toBe('error')
  })

  it('cancels a pending confirmation and aborts the backend', async () => {
    const backend = createTestPresence({ mode: 'manual' })
    const { presence } = await service(backend)
    const record = await presence.request(request())
    await backend.waitForRequest()
    presence.cancel(record.id, `dev_${'D'.repeat(22)}`)
    expect(presence.get(record.id, deviceId)?.status).toBe('pending')
    presence.cancel(record.id, deviceId)
    await expect(record.settled).resolves.toEqual({ result: 'cancelled' })
    expect(presence.get(record.id, deviceId)?.status).toBe('cancelled')
    expect(() => backend.approveNext()).toThrow()
  })

  it('refuses new confirmations while unsandboxed execution runs', async () => {
    let blocked: string | undefined = 'L3 会话运行中'
    const { presence } = await service(createTestPresence(), { blocked: async () => blocked })
    await expect(presence.request(request())).rejects.toMatchObject({ status: 409, code: 'presence-blocked', message: '有完全访问会话正在运行，本机确认暂时只能用于拒绝。请等待其结束或取消后重试。' })
    blocked = undefined
    await expect(presence.request(request())).resolves.toBeTruthy()
  })

  it('binds anonymous host.sock requests to the anonymous requester', async () => {
    const backend: TestPresence = createTestPresence()
    const { presence } = await service(backend)
    const record = await presence.request(request('device.enroll', { enrollmentId: 'enr_x' }, { listener: 'unix', remoteAddress: '本机 host.sock' } as never))
    await record.settled
    expect(backend.requests[0]!.requireBiometric).toBe(true)
    expect(presence.get(record.id, deviceId)).toBeUndefined()
    expect(presence.consume(record.id, { action: 'device.enroll', paramsHash: paramsHash('device.enroll', { enrollmentId: 'enr_x' }) })).toMatchObject({ stepup: 'lpc-local' })
  })
})

describe('PresenceService fairness between enrollments and the owner', () => {
  const anonymous = { listener: 'loopback-tcp' as const, remoteAddress: '127.0.0.1' }
  const enrollRequest = () => request('device.enroll', { enrollmentId: 'enr_x' }, anonymous as never)

  it('lets the owner\'s desktop take the dialog back from a pending anonymous enrollment', async () => {
    const backend = createTestPresence({ mode: 'manual' })
    const { presence, dataDir } = await service(backend)
    const stranger = await presence.request(enrollRequest())
    await backend.waitForRequest()
    const owner = await presence.request(request())
    await expect(stranger.settled).resolves.toEqual({ result: 'cancelled' })
    expect(presence.get(stranger.id)?.status).toBe('cancelled')
    expect(presence.get(owner.id, deviceId)?.status).toBe('pending')
    await backend.waitForRequest()
    backend.approveNext()
    await expect(owner.settled).resolves.toMatchObject({ result: 'approved' })
    await expect.poll(() => auditActions(dataDir).map(record => record.detail.result)).toEqual(['cancelled'])
  })

  it('keeps one dialog at a time otherwise', async () => {
    const backend = createTestPresence({ mode: 'manual' })
    const { presence } = await service(backend)
    await presence.request(enrollRequest())
    await backend.waitForRequest()
    // Another enrollment, or a device that is not the desktop, still waits its turn.
    await expect(presence.request(enrollRequest())).rejects.toMatchObject({ status: 409, code: 'presence-busy' })
    const browser = { deviceId, deviceName: '浏览器', listener: 'loopback-tcp' as const, remoteAddress: '127.0.0.1' }
    await expect(presence.request(request('approval.r2', { approvalId: 'a-1' }, browser as never))).rejects.toMatchObject({ code: 'presence-busy' })
    // A device request is never pre-empted by an enrollment.
    const second = await service(createTestPresence({ mode: 'manual' }))
    await second.presence.request(request())
    await expect(second.presence.request(enrollRequest())).rejects.toMatchObject({ code: 'presence-busy' })
  })

  it('cools down only anonymous enrollments after their dialogs are dismissed', async () => {
    const backend = createTestPresence({ mode: 'deny' })
    const { presence } = await service(backend)
    for (let index = 0; index < 3; index++) await (await presence.request(enrollRequest())).settled
    await expect(presence.request(enrollRequest())).rejects.toMatchObject({ status: 429, code: 'presence-cooldown' })
    backend.mode = 'approve'
    await expect((await presence.request(request())).settled).resolves.toMatchObject({ result: 'approved' })
    await expect(presence.request(enrollRequest())).rejects.toMatchObject({ status: 429, code: 'presence-cooldown' })
  })

  it('still cools down everything after the owner\'s own requests are denied three times', async () => {
    const backend = createTestPresence({ mode: 'deny' })
    const { presence } = await service(backend)
    for (let index = 0; index < 3; index++) await (await presence.request(request())).settled
    await expect(presence.request(request())).rejects.toMatchObject({ status: 429, code: 'presence-cooldown' })
    await expect(presence.request(enrollRequest())).rejects.toMatchObject({ status: 429, code: 'presence-cooldown' })
  })
})

class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly received: Buffer[] = []
  killed: NodeJS.Signals | undefined
  constructor() {
    super()
    this.stdin.on('data', chunk => this.received.push(chunk))
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'))
    return true
  }
  reply(text: string): void {
    this.stdout.write(text)
    this.stdout.end()
    setTimeout(() => this.emit('exit', 0, null), 5)
  }
  input(): Record<string, unknown> { return JSON.parse(Buffer.concat(this.received).toString('utf8')) }
}

describe('macOS helper backend', () => {
  async function setup(options: { platform?: NodeJS.Platform; helper?: boolean; mode?: number; backend?: 'macos-helper' | 'none' } = {}) {
    const codeRoot = temp()
    const { audit, dataDir } = await auditLog()
    const policy = await PolicyStore.open({ dataDir, audit, platform: 'darwin' })
    if (options.backend === 'none') await policy.update({ ...policy.get(), presence: { backend: 'none', helperCdhash: null } }, { listener: 'cli', via: 'cli' }, 'offline')
    const helper = join(codeRoot, 'dist', 'native', 'latch-presence')
    if (options.helper !== false) {
      mkdirSync(join(codeRoot, 'dist', 'native'), { recursive: true })
      writeFileSync(helper, 'binary', { mode: 0o755 })
      chmodSync(helper, options.mode ?? 0o755)
    }
    const calls: string[][] = []
    const codesign = { verify: 0, requirement: 0, cdhash: 'b'.repeat(40) }
    const execFile: ExecFileLike = async (file, args) => {
      calls.push([file, ...args])
      expect(file).toBe('/usr/bin/codesign')
      if (args[0] === '-dvvv') return { code: 0, stdout: '', stderr: `Executable=${helper}\nCDHash=${codesign.cdhash}\n` }
      if (args.some(arg => arg.startsWith('-R='))) return { code: codesign.requirement, stdout: '', stderr: '' }
      return { code: codesign.verify, stdout: '', stderr: '' }
    }
    const children: FakeChild[] = []
    const spawns: Array<{ file: string; options: unknown }> = []
    const spawn: SpawnLike = (file, _args, spawnOptions) => {
      spawns.push({ file, options: spawnOptions })
      const child = new FakeChild()
      children.push(child)
      return child
    }
    const backend = createPresenceBackend({ platform: options.platform ?? 'darwin', codeRoot, policy, execFile, spawn })
    return { backend, policy, calls, codesign, children, spawns, helper, dataDir, audit, codeRoot, execFile, spawn }
  }

  const confirmInput = () => {
    const built = buildPreview({ hostId, action: 'device.enroll', now: Date.now(), requester, lines: [{ label: '设备名称', value: '手机' }], warnings: [] })
    return { ...built, requireBiometric: true }
  }

  it('is unavailable off macOS or when disabled by policy', async () => {
    await expect((await setup({ platform: 'linux' })).backend.availability()).resolves.toEqual({ status: 'unavailable', reason: 'platform', message: '此系统暂不支持本机确认（Touch ID 或登录密码）' })
    const disabled = await setup({ backend: 'none' })
    expect(disabled.backend.kind).toBe('none')
    await expect(disabled.backend.availability()).resolves.toMatchObject({ status: 'unavailable', reason: 'disabled' })
  })

  it('reports a missing helper, insecure file or bad signature', async () => {
    await expect((await setup({ helper: false })).backend.availability()).resolves.toEqual({
      status: 'unavailable', reason: 'helper-missing', message: '未找到本机确认组件。请运行 pnpm build:presence 后重启 Host。',
    })
    await expect((await setup({ mode: 0o775 })).backend.availability()).resolves.toMatchObject({ reason: 'helper-signature' })
    const unsigned = await setup()
    unsigned.codesign.verify = 1
    await expect(unsigned.backend.availability()).resolves.toMatchObject({ reason: 'helper-signature' })
    expect(unsigned.policy.get().presence.helperCdhash).toBeNull()
  })

  it('pins the cdhash on first use, then detects a different binary', async () => {
    const context = await setup()
    await expect(context.backend.availability()).resolves.toEqual({ status: 'available', backend: 'macos-helper' })
    expect(context.policy.get().presence.helperCdhash).toBe('b'.repeat(40))
    expect(context.calls).toContainEqual(['/usr/bin/codesign', '--verify', '--strict', `-R=cdhash H"${'b'.repeat(40)}"`, context.helper])
    context.codesign.requirement = 3
    const input = confirmInput()
    // Every confirm re-checks, never from the cache.
    await expect(context.backend.confirm({ ...input, signal: new AbortController().signal })).resolves.toEqual({
      result: 'error', message: '本机确认组件与登记的签名不一致。如果你重新构建了它，请停止 Host 后运行 pnpm latch presence repin。',
    })
    expect(context.children).toHaveLength(0)
    context.codesign.verify = 1
    await expect(context.backend.confirm({ ...input, signal: new AbortController().signal })).resolves.toMatchObject({ result: 'error' })
  })

  it('does not pin again on its own once an earlier pin was lost', async () => {
    const context = await setup()
    await expect(context.backend.availability()).resolves.toEqual({ status: 'available', backend: 'macos-helper' })
    // policy.json reset outside Latch: the pin is gone, the audit log still records it.
    writeFileSync(join(context.dataDir, 'policy.json'), JSON.stringify({ ...context.policy.get(), presence: { backend: 'macos-helper', helperCdhash: null } }))
    const reopened = await PolicyStore.open({ dataDir: context.dataDir, audit: context.audit, platform: 'darwin' })
    const backend = createPresenceBackend({ platform: 'darwin', codeRoot: context.codeRoot, policy: reopened, execFile: context.execFile, spawn: context.spawn })
    // The helper itself is fine; only the pin is gone, so the fix is a repin, not a rebuild.
    await expect(backend.availability()).resolves.toEqual({
      status: 'unavailable', reason: 'cdhash-mismatch', message: '本机确认组件的登记签名已丢失（policy.json 被修改或删除）。请停止 Host 后运行 pnpm latch presence repin。',
    })
    expect(reopened.get().presence.helperCdhash).toBeNull()
  })

  it('sends the full preview to the helper with an empty environment and parses one result line', async () => {
    const context = await setup()
    const input = confirmInput()
    const pending = context.backend.confirm({ ...input, signal: new AbortController().signal })
    await expect.poll(() => context.children.length).toBe(1)
    const child = context.children[0]!
    await expect.poll(() => child.received.length).toBeGreaterThan(0)
    expect(context.spawns[0]).toEqual({ file: context.helper, options: { env: {}, cwd: '/', stdio: ['pipe', 'pipe', 'ignore'] } })
    expect(child.input()).toEqual({ v: 1, preview: input.preview, previewHash: input.previewHash, hashDisplay: input.hashDisplay, timeoutSeconds: 55, requireBiometric: true })
    child.reply(`${JSON.stringify({ v: 1, nonce: input.preview.nonce, previewHash: input.previewHash, result: 'approved', method: 'biometric' })}\n`)
    await expect(pending).resolves.toEqual({ result: 'approved', method: 'biometric', nonce: input.preview.nonce, previewHash: input.previewHash })
  })

  it.each<[string, string, PresenceOutcome]>([
    ['denied', '{"v":1,"nonce":"n","previewHash":"h","result":"denied"}\n', { result: 'denied' }],
    ['timeout', '{"v":1,"result":"timeout"}\n', { result: 'timeout' }],
    ['hash mismatch', '{"v":1,"result":"error","error":"preview-hash-mismatch"}\n', { result: 'error', message: '本机确认组件无法核对确认内容' }],
    ['malformed', 'not json\n', { result: 'error', message: '本机确认组件返回了无效结果' }],
    ['empty', '', { result: 'error', message: '本机确认组件返回了无效结果' }],
    ['unknown result', '{"v":1,"result":"maybe"}\n', { result: 'error', message: '本机确认组件返回了无效结果' }],
    ['wrong echo', '{"v":1,"nonce":"x","previewHash":"y","result":"approved","method":"biometric"}\n', { result: 'error', message: '本机确认组件返回了不匹配的结果' }],
  ])('maps helper output: %s', async (_name, output, expected) => {
    const context = await setup()
    const pending = context.backend.confirm({ ...confirmInput(), signal: new AbortController().signal })
    await expect.poll(() => context.children.length).toBe(1)
    context.children[0]!.reply(output)
    await expect(pending).resolves.toEqual(expected)
  })

  it('kills the helper on oversize output and on abort', async () => {
    const context = await setup()
    const oversize = context.backend.confirm({ ...confirmInput(), signal: new AbortController().signal })
    await expect.poll(() => context.children.length).toBe(1)
    context.children[0]!.stdout.write('x'.repeat(5000))
    await expect(oversize).resolves.toEqual({ result: 'error', message: '本机确认组件返回了无效结果' })
    expect(context.children[0]!.killed).toBe('SIGTERM')

    const controller = new AbortController()
    const aborted = context.backend.confirm({ ...confirmInput(), signal: controller.signal })
    await expect.poll(() => context.children.length).toBe(2)
    controller.abort()
    await expect(aborted).resolves.toEqual({ result: 'cancelled' })
    expect(context.children[1]!.killed).toBe('SIGTERM')
  })
})

describe('macOS helper self-test', () => {
  const helper = resolve('dist/native/latch-presence')
  // The only automated run of the real helper: no window, no LocalAuthentication.
  it.skipIf(process.platform !== 'darwin' || !existsSync(helper))('reproduces canonical JSON, preview hashes and display escaping byte for byte', async () => {
    const { stdout } = await promisify(execFile)(helper, ['--self-test', resolve('tests/vectors/security-v1.json')], { env: {}, cwd: '/', timeout: 10_000 })
    const result = JSON.parse(stdout.trim()) as {
      ok: boolean; canonicalJson: Array<{ ok: boolean; sha256: string }>; previewHash: Array<{ ok: boolean; previewHash: string; hashDisplay: string }>
      escapePreviewText: boolean[]
    }
    const canonical = [SECURITY_VECTORS.canonicalJson, ...SECURITY_VECTORS.canonicalJsonCases]
    expect(result.canonicalJson).toEqual(canonical.map(vector => ({ ok: true, sha256: vector.sha256 })))
    expect(result.previewHash).toEqual(PREVIEW_HASH_VECTORS.map(vector => ({ ok: true, previewHash: vector.previewHash, hashDisplay: vector.hashDisplay })))
    // The dialog escapes text exactly like the Host.
    expect(result.escapePreviewText).toEqual(ESCAPE_PREVIEW_VECTORS.map(() => true))
    expect(result.ok).toBe(true)
  })
})
