import { createPublicKey, verify as nodeVerify, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Approval, AppSnapshot, ConfirmationTicket, CurrentDevice, DeviceScope, HostCatalog, HostView } from '@latch/protocol'
import { sha256Hex } from '@latch/core/node-kit'
import { SECURITY_VECTORS_FILE } from '@latch/testkit'
import { hashDisplay as hostHashDisplay } from '@latch/host/crypto'
import { api, ApiError, ApiTimeoutError, ClientError, isUncertain, setAuthHooks } from '../src/core/api.ts'
import { choiceKind, DecisionRequests, settledOutcome } from '../src/core/approvalDecision.ts'
import {
  keepDismissed,
  readDismissal,
  rollbackDismissed,
  verifyCheckpoint,
  writeDismissal,
  type CheckpointStorage,
} from '../src/core/auditCheckpoint.ts'
import { resolveChoice, startBlock } from '../src/composerChoice.ts'
import {
  ConfirmationError,
  withConfirmation,
  type ConfirmationActions,
  type ConfirmationPresenter,
  type ConfirmationView,
} from '../src/core/confirmations.ts'
import { contentHash, hashable, hashDisplay } from '../src/core/contentHash.ts'
import {
  createRenewer,
  CredentialNotKeptError,
  MissingDeviceKeyError,
  PENDING_WINDOW_MS,
  RenewalBackoff,
  RenewalScheduler,
  type RenewalDeps,
} from '../src/core/credentials.ts'
import {
  base32,
  base64url,
  base64urlDecode,
  deviceFingerprint,
  enrollSigningText,
  renewSigningText,
  signText,
} from '../src/core/deviceKey.ts'
import { defaultDeviceName, enrolledStep, enrollmentName, infoFailureStep, retryWithoutAdmin } from '../src/core/enrollment.ts'
import { backoffDelay, connectEventStream, EventStreamParser, type StreamEvent } from '../src/core/eventStream.ts'
import { approvalActions, composerGate, deviceAccess, harnessGate, L3_READ_ONLY, LEGACY_HOST_TEXT } from '../src/core/permissions.ts'
import {
  describeFailure,
  ENROLLMENT_REASON_TEXT,
  isCatalogCode,
  isSessionStopCode,
  safeTarget,
  SESSION_STOP_TEXT,
} from '../src/core/securityCopy.ts'
import type { LatchShell } from '../src/core/shell.ts'
import { settingsSections } from '../src/settings/SettingsPage.tsx'
import { authStateFor, renewalFailureOf } from '../src/core/useHarness.ts'

interface Vectors {
  base32: { cases: Array<{ utf8: string; base32: string }> }
  p256: { jwk: JsonWebKey; privateJwk: JsonWebKey; spki: string; fingerprint: string }
  canonicalJson: { output: string; sha256: string }
  hashDisplay: Array<{ hex: string; display: string }>
  signing: {
    enroll: { example: { hostId: string; enrollmentId: string; nonce: string; text: string; signature: string } }
    renew: { example: { hostId: string; deviceId: string; nonce: string; text: string; signature: string } }
  }
}
/** The same conformance file the Host's tests and future native clients use. */
const vectors: Vectors = JSON.parse(readFileSync(SECURITY_VECTORS_FILE, 'utf8'))
const subtle = webcrypto.subtle as unknown as SubtleCrypto

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('shared security vectors (browser algorithms)', () => {
  it('encodes base32 like the Host', () => {
    for (const { utf8, base32: expected } of vectors.base32.cases) expect(base32(new TextEncoder().encode(utf8))).toBe(expected)
  })

  it('derives the device fingerprint from the SPKI with WebCrypto', async () => {
    const spki = base64urlDecode(vectors.p256.spki)
    expect(base64url(spki)).toBe(vectors.p256.spki)
    expect(await deviceFingerprint(spki, subtle)).toBe(vectors.p256.fingerprint)
  })

  it('shows a content hash exactly like the Host: SHA-256 of the UTF-8 text, first 16 hex characters in groups of four', async () => {
    expect(vectors.hashDisplay.length).toBeGreaterThan(0)
    for (const { hex, display } of vectors.hashDisplay) expect(hashDisplay(hex)).toBe(display)
    expect(() => hashDisplay('ABCDEF0123456789')).toThrow(TypeError)
    expect(await contentHash(vectors.canonicalJson.output, subtle)).toBe(hashDisplay(vectors.canonicalJson.sha256))
    for (const text of ['写入 a.ts\r\n', '👨‍💻 \u202E', 'lone \uD800 surrogate', ''])
      expect(await contentHash(text, subtle)).toBe(hostHashDisplay(sha256Hex(text)))
  })

  it('leaves the content hash out without WebCrypto, when the digest fails and for a clipped diff side', async () => {
    expect(await contentHash('no webcrypto here', null)).toBeUndefined()
    const failing = {
      digest: async () => {
        throw new Error('unavailable')
      },
    } as unknown as SubtleCrypto
    expect(await contentHash('digest fails here', failing)).toBeUndefined()
    expect(hashable('x', null)).toBe(false)
    expect(hashable('x', subtle)).toBe(true)
    expect(hashable('long\n…（内容过长，已截断）', subtle)).toBe(false)
  })

  it('builds the exact enroll and renew texts', () => {
    const { enroll, renew } = vectors.signing
    expect(enrollSigningText(enroll.example.hostId, enroll.example.enrollmentId, enroll.example.nonce)).toBe(enroll.example.text)
    expect(renewSigningText(renew.example.hostId, renew.example.deviceId, renew.example.nonce)).toBe(renew.example.text)
  })

  it('verifies the example signatures and signs in the P1363 form the Host verifies', async () => {
    const publicKey = await subtle.importKey('jwk', vectors.p256.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    for (const { example } of [vectors.signing.enroll, vectors.signing.renew]) {
      const ok = await subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        new Uint8Array(base64urlDecode(example.signature)),
        new TextEncoder().encode(example.text),
      )
      expect(ok).toBe(true)
    }
    const privateKey = await subtle.importKey('jwk', vectors.p256.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    const text = vectors.signing.enroll.example.text
    const signature = await signText(privateKey, text, subtle)
    expect(base64urlDecode(signature)).toHaveLength(64)
    const nodeKey = createPublicKey({ key: Buffer.from(vectors.p256.spki, 'base64url'), format: 'der', type: 'spki' })
    expect(nodeVerify('sha256', Buffer.from(text), { key: nodeKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(
      true,
    )
  })
})

describe('event stream parser', () => {
  const feedAll = (chunks: string[]) => {
    const parser = new EventStreamParser()
    return chunks.flatMap(chunk => parser.feed(chunk))
  }

  it('handles LF, CRLF and CR line ends, also when split across chunks', () => {
    const expected: StreamEvent[] = [
      { event: 'refresh', data: '{"a":1}' },
      { event: 'task-state', data: 'x' },
    ]
    expect(feedAll(['event: refresh\ndata: {"a":1}\n\nevent: task-state\ndata: x\n\n'])).toEqual(expected)
    expect(feedAll(['event: refresh\r\ndata: {"a":1}\r', '\n\r', '\nevent: task-state\r\ndata: x\r\n\r\n'])).toEqual(expected)
    expect(feedAll(['event: refresh\rdata: {"a":1}\r\revent: task-state\rdata: x\r\r'])).toEqual(expected)
    const text = 'event: refresh\r\ndata: {"a":1}\r\n\r\nevent: task-state\r\ndata: x\r\n\r\n'
    expect(feedAll([...text])).toEqual(expected)
  })

  it('joins multi-line data, skips comments and heartbeats, keeps ids and strips one leading space', () => {
    expect(feedAll([':heartbeat\n\n', 'id: 7\ndata:  two\ndata:lines\n', ': inside\n\n'])).toEqual([
      { event: 'message', data: ' two\nlines', id: '7' },
    ])
  })

  it('ignores a byte-order mark, events without data and a trailing partial frame', () => {
    expect(feedAll(['﻿event: refresh\n\nevent: refresh\ndata: 1\n\n', 'data: partial'])).toEqual([{ event: 'refresh', data: '1' }])
  })

  it('backs off from 1 s to 15 s', () => {
    expect([0, 1, 2, 3, 4, 5].map(attempt => backoffDelay(attempt))).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000])
  })
})

describe('fetch-based event stream connection', () => {
  function body(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    })
  }

  it('renews on 401 renewal-required and reconnects at once, then delivers frames', async () => {
    const responses = [
      new Response(JSON.stringify({ error: 'renewal-required', message: 'x' }), { status: 401 }),
      new Response(body('event: refresh\ndata: {"r":1}\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ]
    const fetchMock = vi.fn(async () => responses.shift() ?? new Promise<Response>(() => {}))
    const events: StreamEvent[] = []
    const unauthorized: string[] = []
    const opened = vi.fn()
    const connection = connectEventStream(
      '/link/api/events',
      {
        onOpen: opened,
        onEvent: event => {
          events.push(event)
        },
        onError: () => {},
        onUnauthorized: code => {
          unauthorized.push(code)
          return 'renewed'
        },
      },
      { fetch: fetchMock as unknown as typeof fetch, initialDelayMs: 60_000 },
    )
    await vi.waitFor(() => {
      expect(events).toEqual([{ event: 'refresh', data: '{"r":1}' }])
    })
    expect(unauthorized).toEqual(['renewal-required'])
    expect(opened).toHaveBeenCalledTimes(1)
    connection.close()
    expect(connection.open).toBe(false)
  })

  const renewalRequired = () => new Response(JSON.stringify({ error: 'renewal-required', message: 'x' }), { status: 401 })

  it('backs off after a renewal that failed instead of reconnecting at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchMock = vi.fn(async () => renewalRequired())
    const connection = connectEventStream(
      '/link/api/events',
      { onOpen: () => {}, onEvent: () => {}, onError: () => {}, onUnauthorized: () => 'retry' },
      { fetch: fetchMock as unknown as typeof fetch },
    )
    const calls = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms)
      return fetchMock.mock.calls.length
    }
    expect(await calls(0)).toBe(1)
    expect(await calls(999)).toBe(1)
    expect(await calls(1)).toBe(2)
    expect(await calls(1999)).toBe(2)
    expect(await calls(1)).toBe(3)
    expect(await calls(3999)).toBe(3)
    expect(await calls(1)).toBe(4)
    connection.close()
  })

  it('reconnects at once only once per renewal while the Host keeps asking for one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchMock = vi.fn(async () => renewalRequired())
    const connection = connectEventStream(
      '/link/api/events',
      { onOpen: () => {}, onEvent: () => {}, onError: () => {}, onUnauthorized: () => 'renewed' },
      { fetch: fetchMock as unknown as typeof fetch },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    connection.close()
  })

  it('drops the connection on suspend, ignores frames that arrive after it, and connects again only on reconnect', async () => {
    let push!: (text: string) => void
    const live = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          push = text => {
            try {
              controller.enqueue(new TextEncoder().encode(text))
            } catch {
              /* cancelled */
            }
          }
        },
      })
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const stream = live()
      init.signal?.addEventListener('abort', () => {
        void stream.cancel().catch(() => {})
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const events: StreamEvent[] = []
    const connection = connectEventStream(
      '/link/api/events',
      {
        onOpen: () => {},
        onEvent: event => {
          events.push(event)
        },
        onError: () => {},
        onUnauthorized: () => 'retry',
      },
      { fetch: fetchMock as unknown as typeof fetch, initialDelayMs: 1 },
    )
    await vi.waitFor(() => {
      expect(connection.open).toBe(true)
    })
    push('event: refresh\ndata: 1\n\n')
    await vi.waitFor(() => {
      expect(events).toHaveLength(1)
    })
    connection.suspend()
    expect(connection.open).toBe(false)
    push('event: refresh\ndata: 2\n\n')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(events).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    connection.reconnect()
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
    await vi.waitFor(() => {
      expect(connection.open).toBe(true)
    })
    push('event: refresh\ndata: 3\n\n')
    await vi.waitFor(() => {
      expect(events.map(event => event.data)).toEqual(['1', '3'])
    })
    connection.close()
  })

  it('stops when the handler answers stop', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'device-revoked', message: 'x' }), { status: 401 }))
    const errors = vi.fn()
    connectEventStream(
      '/link/api/events',
      { onOpen: () => {}, onEvent: () => {}, onError: errors, onUnauthorized: () => 'stop' },
      { fetch: fetchMock as unknown as typeof fetch, initialDelayMs: 1 },
    )
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errors).not.toHaveBeenCalled()
  })
})

const device = (extra: Partial<CurrentDevice> = {}): CurrentDevice => ({
  id: 'dev_a',
  name: '我的浏览器',
  status: 'active',
  listener: 'loopback-tcp',
  scopes: ['view', 'run', 'approve:standard'],
  dataScope: 'work',
  fingerprint: 'ABCD EFGH IJKL MNOP QRST',
  createdAt: '',
  lastSeenAt: '',
  credentialExpiresAt: '',
  pairedBy: { method: 'lpc' },
  current: true,
  renewAfter: '2100-01-01T00:00:00.000Z',
  ...extra,
})
const desktop: LatchShell = { kind: 'electron', devMode: true, platform: 'darwin' }
const allScopes: DeviceScope[] = ['view', 'run', 'approve:standard', 'approve:elevated', 'admin', 'secrets']
const approval = (extra: Partial<Approval> = {}): Approval => ({
  id: 'ap',
  sessionId: 's',
  toolName: 'write_file',
  reason: '',
  requestedAt: '',
  ...extra,
  options: extra.options ?? [
    { id: 'allow_once', label: '允许一次', kind: 'allow_once' },
    { id: 'allow_always', label: '本会话始终允许', kind: 'allow_always' },
    { id: 'reject_once', label: '拒绝', kind: 'reject_once' },
  ],
})
const labels = (gate: ReturnType<typeof approvalActions>) => gate.options.map(option => option.label)

describe('approval gating', () => {
  it.each([
    ['R1 with approve:standard', approval({ risk: 'R1' }), device(), null, ['允许一次', '本会话始终允许', '拒绝'], undefined, '待批准'],
    [
      'R1 without approve:standard',
      approval({ risk: 'R1' }),
      device({ scopes: ['view', 'run'] }),
      null,
      ['拒绝'],
      '此设备没有「批准普通操作」权限',
      '待批准',
    ],
    [
      'R2 from a browser',
      approval({ risk: 'R2' }),
      device({ scopes: allScopes }),
      null,
      ['拒绝'],
      '高风险操作只能在执行端电脑上用 Latch 桌面端批准',
      '高风险',
    ],
    [
      'R2 on the desktop without the scope',
      approval({ risk: 'R2' }),
      device({ listener: 'unix', scopes: ['view', 'run', 'approve:standard'] }),
      desktop,
      ['拒绝'],
      '此设备没有「批准高风险操作」权限',
      '高风险',
    ],
    [
      'R2 on the desktop with the scope',
      approval({ risk: 'R2' }),
      device({ listener: 'unix', scopes: allScopes }),
      desktop,
      ['拒绝', '在本机允许'],
      undefined,
      '高风险',
    ],
    [
      'missing risk is treated as R2',
      approval({}),
      device({ scopes: allScopes }),
      null,
      ['拒绝'],
      '高风险操作只能在执行端电脑上用 Latch 桌面端批准',
      '高风险',
    ],
    [
      'advisory from a browser',
      approval({ risk: 'R2', advisory: true }),
      device({ scopes: allScopes }),
      null,
      ['拒绝'],
      '只有执行端电脑上的 Latch 桌面端可以回应完全访问会话的询问',
      '仅提示',
    ],
    [
      'advisory on the desktop',
      approval({ risk: 'R2', advisory: true }),
      device({ listener: 'unix', scopes: ['view', 'run'] }),
      desktop,
      ['拒绝', '允许一次'],
      undefined,
      '仅提示',
    ],
    [
      'a unix device outside the desktop shell is not local',
      approval({ risk: 'R2' }),
      device({ listener: 'unix', scopes: allScopes }),
      null,
      ['拒绝'],
      '高风险操作只能在执行端电脑上用 Latch 桌面端批准',
      '高风险',
    ],
  ] as const)('%s', (_name, item, current, shell, buttons, hint, badge) => {
    const gate = approvalActions(item, current, shell)
    expect(labels(gate)).toEqual(buttons)
    expect(gate.hint).toBe(hint)
    expect(gate.badge?.label).toBe(badge)
  })

  it('keeps every offered option on a Host of the previous build, and falls back to allow/reject without options', () => {
    expect(labels(approvalActions(approval({}), null, null))).toEqual(['允许一次', '本会话始终允许', '拒绝'])
    const plain = approvalActions({ id: 'a', sessionId: 's', toolName: 't', reason: '', requestedAt: '' }, null, null)
    expect(plain.explicit).toBe(false)
    expect(labels(plain)).toEqual(['拒绝', '允许一次'])
  })

  it('explains advisory prompts', () => {
    expect(approvalActions(approval({ advisory: true }), device(), null).note).toContain('拒绝会转达给它，但不能阻止它执行其他操作')
  })
})

const hostView: HostView = {
  hostId: 'h'.repeat(52),
  devMode: true,
  presence: { status: 'available' },
  tls: null,
  policy: { localMaxLevel: 'L2', remoteMaxLevel: 'L1', allowL3: true },
}
const snapshotOf = (current: CurrentDevice, extra: Partial<AppSnapshot> = {}): AppSnapshot => ({
  instanceId: 'i',
  device: current,
  host: hostView,
  tasks: [],
  approvals: [],
  demo: false,
  hostName: 'h',
  ...extra,
})
const catalog: HostCatalog = {
  harnesses: [
    { id: 'codex', name: 'Codex', source: 'acp', status: 'ready', modes: ['agent'], models: 'agent', level: 'L3' },
    { id: 'standard', name: 'Standard', source: 'builtin', status: 'ready', modes: ['chat', 'agent'], models: 'host', level: 'L1' },
  ],
  providers: [{ id: 'p', name: 'P', kind: 'openai-compatible', models: ['m'], defaultModel: 'm' }],
  workspaces: [{ id: 'default', name: 'app', path: '/w' }],
  defaults: { harnessId: 'codex', mode: 'agent', workspaceId: 'default' },
}

describe('session and harness gating', () => {
  it('makes L3 sessions read-only for every device but the desktop shell', () => {
    const browser = deviceAccess(snapshotOf(device()), null)
    const local = deviceAccess(snapshotOf(device({ listener: 'unix', scopes: allScopes })), desktop)
    expect(composerGate({ summary: { level: 'L3' }, access: browser })).toEqual({ kind: 'read-only', text: L3_READ_ONLY })
    expect(composerGate({ summary: { level: 'L3' }, access: local })).toEqual({ kind: 'open' })
    expect(composerGate({ summary: { level: 'L1' }, access: browser })).toEqual({ kind: 'open' })
    expect(composerGate({ summary: { level: 'L3', permissionDrift: true }, access: local })).toEqual({ kind: 'stopped' })
    expect(
      composerGate({ summary: { level: 'L1' }, access: deviceAccess(snapshotOf(device({ status: 'review', scopes: ['view'] })), null) })
        .kind,
    ).toBe('read-only')
  })

  it('offers full-access harnesses only on the desktop and picks a startable default elsewhere', () => {
    const browser = deviceAccess(snapshotOf(device()), null)
    expect(harnessGate(catalog.harnesses[0]!, browser)).toEqual({ allowed: false, reason: '仅本机桌面端' })
    expect(harnessGate(catalog.harnesses[1]!, browser)).toEqual({ allowed: true })
    expect(resolveChoice(catalog, null, browser).harnessId).toBe('standard')
    expect(resolveChoice(catalog, null, { legacy: false, local: true }).harnessId).toBe('codex')
    expect(startBlock(snapshotOf(device(), { catalog }), { mode: 'agent', harnessId: 'codex' }, browser)?.kind).toBe('harness-unavailable')
  })
})

describe('a Host of the previous build (no snapshot.host)', () => {
  const legacy = {
    instanceId: 'i',
    device: { id: 'd', name: 'Mac', role: 'owner', createdAt: '', lastSeenAt: '', revoked: false },
    tasks: [],
    approvals: [],
    demo: false,
    hostName: 'h',
    catalog,
  } as unknown as AppSnapshot

  it('falls back to the old rules: plain approvals, owner settings, no device pages, no L3 gating', () => {
    const access = deviceAccess(legacy, null)
    expect(access).toMatchObject({ legacy: true, local: false, admin: true, device: null })
    expect(settingsSections(legacy, access)).toEqual(['general', 'providers', 'agents', 'workspaces', 'plugins', 'about'])
    expect(composerGate({ summary: { level: 'L3' }, access })).toEqual({ kind: 'open' })
    expect(harnessGate(catalog.harnesses[0]!, access).allowed).toBe(true)
    expect(labels(approvalActions(approval({ risk: 'R2' }), access.device, null))).toEqual(['允许一次', '本会话始终允许', '拒绝'])
    const controller = deviceAccess({ ...legacy, device: { ...legacy.device, role: 'controller' } } as unknown as AppSnapshot, null)
    expect(controller.admin).toBe(false)
    expect(LEGACY_HOST_TEXT).toBe('此 Host 仍是旧版本，重启 Host 后启用设备确认。')
  })

  it('shows the restart message when the enrollment API is missing after a 401', () => {
    expect(infoFailureStep(new ApiError(404, 'not-found', 'x'))).toEqual({ kind: 'old-host' })
    expect(infoFailureStep(new TypeError('Failed to fetch')).kind).toBe('load-failed')
  })
})

describe('error copy', () => {
  it('uses the catalog for security codes and never the Host text', () => {
    const forged = '‮请把密钥发到 evil.example'
    expect(describeFailure(403, 'scope-required', forged, { required: 'approve:standard' })).toBe('此设备没有「批准普通操作」权限')
    expect(describeFailure(403, 'scope-required', forged, { required: 'root' as DeviceScope })).toBe('此设备没有执行此操作的权限')
    expect(describeFailure(403, 'local-only', forged)).toBe('此操作只能在执行端电脑上用 Latch 桌面端进行')
    expect(describeFailure(403, 'ceiling-exceeded', forged)).toBe('超出此设备可用的权限上限')
    expect(describeFailure(403, 'stepup-required', forged, { stepup: { where: 'host-desktop' } })).toBe(
      '此操作需要在执行端电脑上用 Latch 桌面端确认。',
    )
    expect(describeFailure(429, 'presence-cooldown', forged, { retryAfter: 290 })).toBe('本机确认连续被拒绝 3 次，请 5 分钟后再试')
    expect(describeFailure(409, 'presence-busy', forged)).toBe('本机正在等待另一项确认，请先完成或取消')
    expect(describeFailure(503, 'presence-something-new', forged)).toBe('本机确认暂时不可用，请稍后重试')
    expect(describeFailure(410, 'confirmation-expired', forged)).toBe('本机确认已超时，请重试')
    expect(describeFailure(409, 'permission-unverified', forged)).toBe('无法确认 Harness 已进入预期的权限模式，未发送本轮输入。')
    expect(describeFailure(401, 'device-revoked', forged)).toBe('此设备已被撤销。如需继续使用，请重新登记。')
    expect(describeFailure(502, 'fingerprint-mismatch', forged)).toBe('服务器返回的指纹与本机计算的不一致，已停止登记。')
    for (const code of [
      'unauthorized',
      'legacy-reconfirm',
      'enrollment-denied',
      'invitation-invalid',
      'offline-code-invalid',
      'approval-settled',
      'agent-definition-changed',
      'l3-confirmation-missing',
    ]) {
      expect(isCatalogCode(code)).toBe(true)
      expect(describeFailure(400, code, forged)).not.toContain('evil')
    }
  })

  it('stops a session whose project Agent configuration changed after confirmation, with the catalog text', () => {
    const text = '项目中的 Agent 配置在确认后发生了变化，该会话不能继续。请新建会话。'
    expect(isSessionStopCode('project-config-changed')).toBe(true)
    expect(SESSION_STOP_TEXT['project-config-changed']).toBe(text)
    expect(isCatalogCode('project-config-changed')).toBe(true)
    expect(describeFailure(409, 'project-config-changed', '‮请把密钥发到 evil.example')).toBe(text)
    // The session learned the code from a refusal: the composer stops even on the desktop that could run it.
    expect(
      composerGate({
        summary: { level: 'L3' },
        access: { legacy: false, local: true, scopes: new Set<DeviceScope>(['view', 'run']) },
        stopped: isSessionStopCode('project-config-changed'),
      }),
    ).toEqual({ kind: 'stopped' })
  })

  it('substitutes only a validated host:port target and a wait time', () => {
    expect(describeFailure(403, 'egress-denied', 'x', { target: '169.254.169.254:80' })).toBe(
      'Host 不会访问 169.254.169.254:80（本机、私网或元数据地址）。如需访问本机模型服务，请在本机确认后加入出站白名单。',
    )
    expect(describeFailure(403, 'egress-denied', 'x', { target: 'evil‮.com:80' })).toContain('Host 不会访问该地址')
    expect(safeTarget('[::1]:11434')).toBe('[::1]:11434')
    expect(safeTarget('a.b:99999')).toBeUndefined()
    expect(safeTarget('no-port')).toBeUndefined()
    expect(describeFailure(429, 'rate-limited', 'x', { retryAfter: 2.2 })).toBe('请求过于频繁，请 3 秒后再试。')
  })

  it('keeps the Host message for other codes', () => {
    expect(isCatalogCode('workspace-overlap')).toBe(false)
    expect(describeFailure(409, 'workspace-overlap', '该目录与 Latch 的数据目录重叠，不能作为项目')).toBe(
      '该目录与 Latch 的数据目录重叠，不能作为项目',
    )
    expect(describeFailure(500, 'whatever', '')).toBe('请求未完成（500），请重试。')
  })

  it('maps 401 codes to the enrollment page and keeps the legacy name', () => {
    expect(authStateFor(new ApiError(401, 'legacy-reconfirm', 'x', { legacyName: '旧电脑' }), null)).toEqual({
      reason: 'legacy-reconfirm',
      legacyName: '旧电脑',
    })
    expect(authStateFor(new ApiError(401, 'credential-expired', 'x'), null)).toEqual({ reason: 'credential-expired' })
    expect(authStateFor(new ApiError(401, 'renewal-required', 'x'), 'key-missing')).toEqual({ reason: 'key-missing' })
    expect(authStateFor(new ApiError(401, 'something-else', 'x'), null)).toEqual({ reason: 'unauthorized' })
  })

  it('keeps only causes that need re-enrollment from a failed renewal, so a transient failure never signs out with an old reason', () => {
    for (const transient of [
      new TypeError('network'),
      new ApiTimeoutError(),
      new ApiError(500, 'internal-error', 'x'),
      new ApiError(503, 'audit-unavailable', 'x'),
      new ApiError(429, 'rate-limited', 'x'),
      new ApiError(409, 'credential-rotated', 'x'),
    ]) {
      expect(renewalFailureOf(transient)).toBeNull()
    }
    expect(renewalFailureOf(new MissingDeviceKeyError())).toBe('key-missing')
    for (const code of ['device-revoked', 'credential-expired', 'listener-mismatch'] as const)
      expect(renewalFailureOf(new ApiError(401, code, 'x'))).toBe(code)
    expect(renewalFailureOf(new ApiError(401, 'unauthorized', 'x'))).toBe('unauthorized')
    expect(renewalFailureOf(new ApiError(401, 'device-revoked', 'x'))).toBe('device-revoked')
    expect(renewalFailureOf(new ApiError(401, 'invalid-signature', 'x'))).toBe('unauthorized')
    expect(authStateFor(new ApiError(401, 'renewal-required', 'x'), renewalFailureOf(new MissingDeviceKeyError()))).toEqual({
      reason: 'key-missing',
    })
  })

  it('leaves the completing step when the first snapshot after enrollment fails', () => {
    expect(enrolledStep({ status: 'connected' })).toBeNull()
    expect(enrolledStep({ status: 'credential-not-stored' })).toEqual({ kind: 'form' })
    expect(enrolledStep({ status: 'failed', message: '连接暂时不可用' })).toEqual({ kind: 'confirm-failed', message: '连接暂时不可用' })
  })

  it('accepts emoji device names and refuses names the confirmation preview would have to escape', () => {
    expect(enrollmentName(' ❤️ iPhone ')).toBe('❤️ iPhone')
    expect(enrollmentName('👨‍💻 Mac')).toBe('👨‍💻 Mac')
    expect(enrollmentName('Mac\u202Ekoob')).toBeNull()
    expect(enrollmentName('a\u200Bb')).toBeNull()
    expect(enrollmentName('line\nbreak')).toBeNull()
    expect(enrollmentName('   ')).toBe(defaultDeviceName())
    // The old device name is reused only when it passes the same rule.
    expect(enrollmentName('', '👨‍💻 旧电脑')).toBe('👨‍💻 旧电脑')
    expect(enrollmentName('', 'x\u202Eevil')).toBe(defaultDeviceName())
    expect(defaultDeviceName('a'.repeat(81))).toBe(defaultDeviceName())
  })

  it('retries enrollment without admin only for scope refusals with an invitation', () => {
    expect(retryWithoutAdmin(new ApiError(400, 'scope-not-grantable', 'x'), true, true)).toBe(true)
    expect(retryWithoutAdmin(new ApiError(403, 'invitation-invalid', 'x'), true, true)).toBe(false)
    expect(retryWithoutAdmin(new ApiError(400, 'scope-not-grantable', 'x'), true, false)).toBe(false)
    expect(retryWithoutAdmin(new ApiError(400, 'scope-not-grantable', 'x'), false, true)).toBe(false)
  })
})

describe('api()', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('renews once on 401 renewal-required and retries the request; other 401s are reported', async () => {
    const replies = [
      json(401, { error: 'renewal-required', message: 'x' }),
      json(200, { ok: true }),
      json(401, { error: 'device-revoked', message: 'x' }),
    ]
    const fetchMock = vi.fn(async () => replies.shift()!)
    vi.stubGlobal('fetch', fetchMock)
    const renew = vi.fn(async () => true)
    const unauthorized = vi.fn()
    const remove = setAuthHooks({ renew, unauthorized })
    try {
      expect(await api('snapshot')).toEqual({ ok: true })
      expect(renew).toHaveBeenCalledTimes(1)
      await expect(api('snapshot')).rejects.toMatchObject({
        status: 401,
        code: 'device-revoked',
        message: '此设备已被撤销。如需继续使用，请重新登记。',
      })
      expect(unauthorized).toHaveBeenCalledTimes(1)
    } finally {
      remove()
    }
  })

  it('sends a confirmation header and keeps error details', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)['x-latch-confirmation']).toBe('cfm_x')
      return json(403, { error: 'scope-required', message: 'server', required: 'admin' })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(api('policy', { method: 'PATCH', body: {}, confirmation: 'cfm_x' })).rejects.toMatchObject({
      code: 'scope-required',
      message: '此设备没有「管理此 Host」权限',
      details: { required: 'admin' },
    })
  })

  it('takes a 2xx status as the answer without reading the body when asked to', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('connection reset'))
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(broken, { status: 200 })),
    )
    await expect(api('credentials/renew', { method: 'POST', body: {}, discardBody: true })).resolves.toBeUndefined()
  })

  it('treats refusals and local confirmation outcomes as definitive', () => {
    expect(isUncertain(new ApiError(503, 'audit-unavailable', 'x'))).toBe(false)
    expect(isUncertain(new ApiError(502, 'request-failed', 'x'))).toBe(true)
    expect(isUncertain(new ApiTimeoutError())).toBe(true)
    expect(isUncertain(new ConfirmationError('x', 'denied', true))).toBe(false)
    expect(isUncertain(new ClientError('x', 'y', { definitive: false }))).toBe(true)
  })
})

describe('local confirmation', () => {
  const ticket = (status: ConfirmationTicket['status']): ConfirmationTicket => ({
    id: 'cfm_1',
    action: 'approval.r2',
    title: '批准高风险操作（R2）',
    status,
    hashDisplay: 'a1b2-c3d4-e5f6-0718',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const stepup = () =>
    new ApiError(403, 'stepup-required', '需要在本机确认', { stepup: { where: 'this-device' }, confirmation: ticket('pending') })
  function presenter() {
    const views: ConfirmationView['phase'][] = []
    const shown: ConfirmationView[] = []
    let actions: ConfirmationActions | undefined
    const value: ConfirmationPresenter = {
      show: (view, next) => {
        views.push(view.phase)
        shown.push(view)
        actions = next
      },
      close: () => {
        views.push('closed' as never)
      },
    }
    return {
      value,
      views,
      shown,
      cancel: () => actions?.cancel(),
      dismiss: () => actions?.dismiss(),
    }
  }
  const instant = () => Promise.resolve()

  it('polls until approved, then resends with the ticket id', async () => {
    const statuses: ConfirmationTicket['status'][] = ['pending', 'approved']
    const fake = vi.fn(async (path: string) => {
      expect(path).toBe('confirmations/cfm_1')
      return { confirmation: ticket(statuses.shift()!) }
    })
    const sends: Array<string | undefined> = []
    const ui = presenter()
    const result = await withConfirmation(
      async confirmation => {
        sends.push(confirmation)
        if (!confirmation) throw stepup()
        return 'done'
      },
      { presenter: ui.value, api: fake as never, sleep: instant },
    )
    expect(result).toBe('done')
    expect(sends).toEqual([undefined, 'cfm_1'])
    expect(ui.views).toEqual(['waiting', 'waiting', 'sending', 'closed'])
  })

  it.each([
    ['denied', '操作没有执行。本机确认没有通过。'],
    ['expired', '操作没有执行。60 秒内没有完成确认。'],
    ['error', '操作没有执行。本机确认没有完成。'],
  ] as const)('stops on %s and keeps the dialog with the message', async (status, message) => {
    const ui = presenter()
    const sends = vi.fn(async (confirmation?: string) => {
      if (!confirmation) throw stepup()
      return 'never'
    })
    // The call settles at once, so whatever asked is ready again; the outcome stays shown until it is closed, and the
    // request is not sent again.
    const error = await withConfirmation(sends, {
      presenter: ui.value,
      api: (async () => ({ confirmation: ticket(status) })) as never,
      sleep: instant,
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ConfirmationError)
    expect(error).toMatchObject({ message, reason: status, handled: true })
    expect(sends).toHaveBeenCalledTimes(1)
    expect(ui.views.at(-1)).toBe('failed')
    expect(ui.shown.at(-1)).toMatchObject({ phase: 'failed', message, reason: status })
    ui.dismiss()
    expect(ui.views.at(-1)).toBe('closed')
  })

  it.each([
    ['cooldown', new ApiError(429, 'presence-cooldown', 'x', { retryAfter: 240 })],
    ['busy', new ApiError(409, 'presence-busy', 'x')],
    ['blocked', new ApiError(409, 'presence-blocked', 'x')],
  ] as const)('explains a Host that cannot start a confirmation (%s) in the dialog, not the form', async (reason, refusal) => {
    const ui = presenter()
    const error = await withConfirmation(
      async () => {
        throw refusal
      },
      { presenter: ui.value },
    ).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ConfirmationError)
    expect(error).toMatchObject({ reason, handled: true })
    const view = ui.shown.at(-1)
    expect(view).toMatchObject({ phase: 'paused', reason })
    if (reason === 'cooldown') expect(view?.phase === 'paused' && view.until! - Date.now()).toBeGreaterThan(230_000)
    ui.dismiss()
    expect(ui.views.at(-1)).toBe('closed')
  })

  it('cancels the ticket on the Host when the dialog is cancelled', async () => {
    const ui = presenter()
    const calls: string[] = []
    const fake = vi.fn(async (path: string, options?: { method?: string }) => {
      calls.push(`${options?.method ?? 'GET'} ${path}`)
      return { confirmation: ticket('pending') }
    })
    let wake: (() => void) | undefined
    const sleep = (_ms: number, signal: AbortSignal) =>
      new Promise<void>(resolve => {
        wake = resolve
        signal.addEventListener('abort', () => resolve())
      })
    const pending = withConfirmation(
      async confirmation => {
        if (!confirmation) throw stepup()
        return 'never'
      },
      { presenter: ui.value, api: fake as never, sleep },
    )
    await vi.waitFor(() => {
      expect(wake).toBeDefined()
    })
    ui.cancel()
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
    expect(calls).toContain('DELETE confirmations/cfm_1')
    expect(ui.views.at(-1)).toBe('closed')
  })

  it('reports the host-desktop rule without a dialog and passes other errors through', async () => {
    const ui = presenter()
    await expect(
      withConfirmation(
        async () => {
          throw new ApiError(403, 'stepup-required', 'x', { stepup: { where: 'host-desktop' } })
        },
        { presenter: ui.value },
      ),
    ).rejects.toMatchObject({ message: '此操作需要在执行端电脑上用 Latch 桌面端确认。', reason: 'host-desktop' })
    await expect(
      withConfirmation(
        async () => {
          throw new ApiError(403, 'local-only', 'x')
        },
        { presenter: ui.value },
      ),
    ).rejects.toMatchObject({ code: 'local-only' })
    expect(ui.views).toEqual([])
  })

  it('shows a mismatch on the resend as a failed confirmation', async () => {
    const ui = presenter()
    const send = async (confirmation?: string) => {
      if (!confirmation) throw stepup()
      throw new ApiError(409, 'confirmation-mismatch', 'server text')
    }
    await expect(
      withConfirmation(send, { presenter: ui.value, api: (async () => ({ confirmation: ticket('approved') })) as never, sleep: instant }),
    ).rejects.toMatchObject({ message: '确认内容与本次请求不一致，请重新确认', handled: true })
    expect(ui.views.at(-1)).toBe('failed')
  })
})

describe('credential renewal', () => {
  const key = { hostId: 'h', deviceId: 'dev_a', privateKey: {} as CryptoKey, publicKeySpki: 'x', createdAt: '' }
  function fakeHost(options: { rotateConflict?: boolean } = {}) {
    let renewAfter = 0
    const calls: string[] = []
    const api = vi.fn(async (path: string) => {
      calls.push(path)
      await new Promise(resolve => setTimeout(resolve, 5))
      if (path === 'snapshot') {
        if (renewAfter <= Date.now()) throw new ApiError(401, 'renewal-required', 'x')
        return { device: { renewAfter: new Date(renewAfter).toISOString() } }
      }
      if (path === 'credentials/challenge') return { nonce: 'n', expiresAt: '' }
      if (path === 'credentials/renew') {
        if (options.rotateConflict) throw new ApiError(409, 'credential-rotated', 'x')
        renewAfter = Date.now() + 86_400_000
        return {}
      }
      throw new Error(`unexpected ${path}`)
    })
    return { api, calls }
  }
  /** Web Locks stand-in: one holder per name at a time. */
  function fakeLocks() {
    const tails = new Map<string, Promise<unknown>>()
    return {
      request: (name: string, callback: () => Promise<unknown>) => {
        const run = (tails.get(name) ?? Promise.resolve()).then(callback, callback)
        tails.set(
          name,
          run.catch(() => {}),
        )
        return run
      },
    } as unknown as RenewalDeps['locks']
  }
  const deps = (api: RenewalDeps['api'], locks?: RenewalDeps['locks'], loadKey: RenewalDeps['loadKey'] = async () => key): RenewalDeps => ({
    api,
    locks,
    loadKey,
    sign: async (_key, text) => {
      expect(text).toBe('latch-renew-v1\nh\ndev_a\nn')
      return 'sig'
    },
    now: () => Date.now(),
  })

  it('runs one renewal for concurrent callers in a tab', async () => {
    const host = fakeHost()
    const renewer = createRenewer(deps(host.api as never))
    const results = await Promise.all([
      renewer.renew({ hostId: 'h', deviceId: 'dev_a' }),
      renewer.renew({ hostId: 'h', deviceId: 'dev_a' }),
      renewer.renew({ hostId: 'h' }),
    ])
    expect(results).toEqual(['renewed', 'renewed', 'renewed'])
    expect(host.calls.filter(path => path === 'credentials/renew')).toHaveLength(1)
  })

  it('serializes tabs with Web Locks; the waiting tab re-reads the snapshot and does not rotate again', async () => {
    const host = fakeHost()
    const locks = fakeLocks()
    const tabA = createRenewer(deps(host.api as never, locks))
    const tabB = createRenewer(deps(host.api as never, locks))
    expect(await Promise.all([tabA.renew({ hostId: 'h', deviceId: 'dev_a' }), tabB.renew({ hostId: 'h', deviceId: 'dev_a' })])).toEqual([
      'renewed',
      'not-due',
    ])
    expect(host.calls.filter(path => path === 'credentials/renew')).toHaveLength(1)
  })

  /**
   * A Host that keeps the current credential until the renewed one is first presented: a renew stores a pending
   * credential, its first use promotes it and starts a 60 s grace for the replaced one, and a replaced credential used
   * after that grace revokes the device. `outcomes` decides how each renew request ends; the browser's cookie changes
   * only when an answer arrives, and not at all for `not-stored` (a 2xx whose cookie the browser drops). `now` lets a
   * test drive the Host clock with fake timers; `advance` moves it further.
   */
  function pendingHost(
    outcomes: Array<'ok' | 'lost-before' | 'lost-after' | 'failed-500' | 'expired' | 'not-stored'>,
    now: () => number = () => 1_000_000,
  ) {
    let offset = 0
    const clock = () => now() + offset
    let issued = 0
    let cookie = 'cred-0'
    const state = {
      current: 'cred-0',
      rotatedAt: clock() - 86_400_001,
      pending: null as string | null,
      previous: [] as Array<{ value: string; graceUntil: number }>,
      revoked: false,
    }
    const nonces = new Set<string>()
    const sent: Array<{ path: string; nonce?: string; discardBody?: boolean }> = []
    const authenticate = (renewal: boolean) => {
      if (state.revoked) throw new ApiError(401, 'device-revoked', 'x')
      if (cookie === state.pending) {
        state.previous.push({ value: state.current, graceUntil: clock() + 60_000 })
        state.current = cookie
        state.rotatedAt = clock()
        state.pending = null
      }
      if (cookie === state.current) {
        if (!renewal && clock() - state.rotatedAt > 86_400_000) throw new ApiError(401, 'renewal-required', 'x')
        return
      }
      const previous = state.previous.find(entry => entry.value === cookie)
      if (!previous) throw new ApiError(401, 'unauthorized', 'x')
      if (clock() > previous.graceUntil) {
        state.revoked = true
        throw new ApiError(401, 'device-revoked', 'x')
      }
      if (renewal) throw new ApiError(409, 'credential-rotated', 'x')
    }
    const api = vi.fn(async (path: string, request: { body?: { nonce?: string }; discardBody?: boolean } = {}) => {
      sent.push({
        path,
        ...(request.body?.nonce ? { nonce: request.body.nonce } : {}),
        ...(request.discardBody ? { discardBody: true } : {}),
      })
      if (path === 'snapshot') {
        authenticate(false)
        return { device: { renewAfter: new Date(state.rotatedAt + 86_400_000).toISOString() } }
      }
      if (path === 'credentials/challenge') {
        authenticate(true)
        const nonce = `n${++issued}`
        nonces.add(nonce)
        return { nonce, expiresAt: '' }
      }
      const outcome = outcomes.shift() ?? 'ok'
      if (outcome === 'lost-before') throw new TypeError('network')
      authenticate(true)
      if (!nonces.delete(request.body?.nonce ?? '') || outcome === 'expired') throw new ApiError(401, 'invalid-signature', 'x')
      if (outcome === 'failed-500') throw new ApiError(500, 'internal-error', 'x')
      state.pending = `cred-${issued}`
      if (outcome === 'lost-after') throw new ApiTimeoutError()
      if (outcome !== 'not-stored') cookie = state.pending
      return undefined
    })
    const renewer = createRenewer({ api: api as never, loadKey: async () => key, sign: async (_key, text) => `sig:${text}`, now: clock })
    return {
      renewer,
      state,
      sent,
      cookie: () => cookie,
      advance: (ms: number) => {
        offset += ms
      },
      /** An ordinary request with whatever cookie the browser holds. */
      request: () => {
        authenticate(false)
      },
      renews: () => sent.filter(call => call.path === 'credentials/renew'),
    }
  }

  it.each(['lost-after', 'lost-before', 'failed-500'] as const)(
    'keeps the current credential when a renew ends without an answer (%s) and leaves the retry to the caller',
    async outcome => {
      const host = pendingHost([outcome])
      const failure = await host.renewer.renew({ hostId: 'h', deviceId: 'dev_a' }).catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(Error)
      // A transient cause: the page keeps the credential and reconnects instead of returning to enrollment.
      expect(renewalFailureOf(failure)).toBeNull()
      expect(host.renews()).toHaveLength(1)
      expect(host.cookie()).toBe('cred-0')
      expect(host.state.current).toBe('cred-0')
    },
  )

  it('renews again with the same credential long after a lost answer; the unused credential is replaced and nothing is revoked', async () => {
    const host = pendingHost(['lost-after', 'ok'])
    await expect(host.renewer.renew({ hostId: 'h', deviceId: 'dev_a' })).rejects.toBeInstanceOf(ApiTimeoutError)
    expect(host.state.pending).toBe('cred-1')
    // Well past the 60 s that a rotated-out credential used to be accepted for.
    host.advance(5 * 60_000)
    expect(await host.renewer.renew({ hostId: 'h', deviceId: 'dev_a' })).toBe('renewed')
    expect(host.cookie()).toBe('cred-2')
    host.request()
    expect(host.state).toMatchObject({ current: 'cred-2', pending: null, revoked: false })
    expect(host.renews().map(call => call.nonce)).toEqual(['n1', 'n2'])
    expect(host.renews().every(call => call.discardBody)).toBe(true)
  })

  it('retries an expired or forgotten challenge once with a fresh one', async () => {
    const host = pendingHost(['expired', 'ok'])
    expect(await host.renewer.renew({ hostId: 'h', deviceId: 'dev_a' })).toBe('renewed')
    expect(host.renews().map(call => call.nonce)).toEqual(['n1', 'n2'])
    const twice = pendingHost(['expired', 'expired'])
    await expect(twice.renewer.renew({ hostId: 'h', deviceId: 'dev_a' })).rejects.toMatchObject({ status: 401, code: 'invalid-signature' })
  })

  it('paces renewal after transient failures and lets every trigger in between share the wait', () => {
    let now = 0
    const backoff = new RenewalBackoff(() => now)
    expect(backoff.wait()).toBe(0)
    expect([1, 2, 3, 4, 5, 6].map(() => backoff.failed())).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
    expect(backoff.wait()).toBe(30_000)
    now += 29_000
    expect(backoff.wait()).toBe(1_000)
    now += 1_000
    expect(backoff.wait()).toBe(0)
    backoff.reset()
    expect(backoff.failed()).toBe(2_000)
  })

  it('counts one backoff step per failed attempt, however many requests were waiting on it', async () => {
    vi.useFakeTimers()
    const renew = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new TypeError('network'))
          }, 5)
        }),
    )
    const retry = vi.fn()
    const scheduler = new RenewalScheduler({ renew, retry, now: () => Date.now() })
    // The snapshot, another request and the event stream hit renewal-required together.
    const answers = Promise.all([scheduler.renew({ hostId: 'h' }), scheduler.renew({ hostId: 'h' }), scheduler.renew({ hostId: 'h' })])
    await vi.advanceTimersByTimeAsync(5)
    expect(await answers).toEqual([false, false, false])
    expect(renew).toHaveBeenCalledTimes(1)
    expect(scheduler.failure).toBeNull()
    // A trigger during the wait shares it.
    expect(await scheduler.renew({ hostId: 'h' })).toBe(false)
    // The failure came 5 ms in; the first wait is 2 s from then.
    await vi.advanceTimersByTimeAsync(1_999)
    expect(retry).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(retry).toHaveBeenCalledTimes(1)
    // The retry starts at once, and its failure is the second step.
    const second = scheduler.renew({ hostId: 'h' })
    await vi.advanceTimersByTimeAsync(5)
    expect(await second).toBe(false)
    expect(renew).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(retry).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(retry).toHaveBeenCalledTimes(2)
  })

  it('schedules nothing after sign-out, also for an attempt that was still running', async () => {
    vi.useFakeTimers()
    const retry = vi.fn()
    const scheduler = new RenewalScheduler({
      renew: () =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new TypeError('network'))
          }, 5)
        }),
      retry,
    })
    const running = scheduler.renew({ hostId: 'h' })
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await running).toBe(false)
    expect(retry).not.toHaveBeenCalled()
    expect(scheduler.failure).toBeNull()
  })

  const identity = { hostId: 'h', deviceId: 'dev_a' }

  it('does not renew again while the browser still presents the replaced credential, and gives up after the pending window', async () => {
    const host = pendingHost(['not-stored'])
    expect(await host.renewer.renew(identity)).toBe('renewed')
    expect(host.cookie()).toBe('cred-0')
    expect(host.state.pending).toBe('cred-1')
    const early = await host.renewer.renew(identity).catch((cause: unknown) => cause)
    expect(early).toBeInstanceOf(CredentialNotKeptError)
    expect(renewalFailureOf(early)).toBeNull()
    // The Host still accepts the pending credential at exactly 10 minutes.
    host.advance(PENDING_WINDOW_MS)
    expect(renewalFailureOf(await host.renewer.renew(identity).catch((cause: unknown) => cause))).toBeNull()
    host.advance(1)
    const late = await host.renewer.renew(identity).catch((cause: unknown) => cause)
    expect(renewalFailureOf(late)).toBe('renewal-not-stored')
    expect(authStateFor(new ApiError(401, 'renewal-required', 'x'), renewalFailureOf(late))).toEqual({ reason: 'renewal-not-stored' })
    expect(ENROLLMENT_REASON_TEXT['renewal-not-stored']).toContain('没有保存新的凭据')
    expect(host.renews()).toHaveLength(1)
    expect(host.state).toMatchObject({ current: 'cred-0', revoked: false })
  })

  it('paces the checks for a renewed cookie the browser did not store and leaves for enrollment after the pending window', async () => {
    vi.useFakeTimers({ now: 1_000_000_000 })
    const host = pendingHost(['not-stored'], () => Date.now())
    const retries: number[] = []
    const scheduler: RenewalScheduler = new RenewalScheduler({
      renew: id => host.renewer.renew(id),
      now: () => Date.now(),
      retry: () => {
        retries.push(Date.now())
        void scheduler.renew(identity)
      },
    })
    const start = Date.now()
    expect(await scheduler.renew(identity)).toBe(true)
    // The request retried after the renewal still presents the old credential and asks again.
    expect(await scheduler.renew(identity)).toBe(false)
    // Requests and event-stream reconnects keep asking every second; they wait for the scheduled retry.
    for (let second = 0; second < 15 * 60 && scheduler.failure === null; second++) {
      void scheduler.renew(identity)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(scheduler.failure).toBe('renewal-not-stored')
    expect(host.renews()).toHaveLength(1)
    expect(host.sent.filter(call => call.path === 'snapshot')).toHaveLength(retries.length + 2)
    const gaps = retries.map((at, index) => at - (index === 0 ? start : retries[index - 1]!))
    expect(gaps.slice(0, 6)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
    expect(Math.max(...gaps)).toBe(30_000)
    expect(retries.at(-1)! - start).toBeGreaterThan(PENDING_WINDOW_MS)
    expect(retries.at(-1)! - start).toBeLessThanOrEqual(PENDING_WINDOW_MS + 30_000)
  })

  it('renews as usual a day after a renewal whose cookie was stored', async () => {
    const host = pendingHost(['ok', 'ok'])
    expect(await host.renewer.renew(identity)).toBe('renewed')
    host.request()
    host.advance(86_400_001)
    expect(await host.renewer.renew(identity)).toBe('renewed')
    expect(host.renews()).toHaveLength(2)
    host.request()
    expect(host.state).toMatchObject({ current: 'cred-2', revoked: false })
  })

  it('treats credential-rotated as another tab having renewed, and a missing key as re-enrollment', async () => {
    expect(await createRenewer(deps(fakeHost({ rotateConflict: true }).api as never)).renew({ hostId: 'h', deviceId: 'dev_a' })).toBe(
      'rotated',
    )
    // The other tab's credential was promoted between this tab's snapshot and its challenge.
    const challengeConflict = vi.fn(async (path: string) => {
      if (path === 'snapshot') throw new ApiError(401, 'renewal-required', 'x')
      throw new ApiError(409, 'credential-rotated', 'x')
    })
    expect(await createRenewer(deps(challengeConflict as never)).renew({ hostId: 'h', deviceId: 'dev_a' })).toBe('rotated')
    expect(challengeConflict.mock.calls.map(([path]) => path)).toEqual(['snapshot', 'credentials/challenge'])
    await expect(
      createRenewer(deps(fakeHost().api as never, undefined, async () => undefined)).renew({ hostId: 'h', deviceId: 'dev_a' }),
    ).rejects.toBeInstanceOf(MissingDeviceKeyError)
  })
})

describe('approval decisions (idempotent retries)', () => {
  it('reuses one requestId while the same choice is retried after an unknown outcome', () => {
    let next = 0
    const requests = new DecisionRequests(() => `req-${++next}`)
    const first = requests.idFor('ap', 'allow', 'allow_once')
    requests.settle('ap', new ApiTimeoutError())
    expect(requests.idFor('ap', 'allow', 'allow_once')).toBe(first)
    requests.settle('ap', new ApiError(502, 'request-failed', 'x'))
    expect(requests.idFor('ap', 'allow', 'allow_once')).toBe(first)
    expect(requests.idFor('ap', 'reject', 'reject_once')).not.toBe(first)
    requests.settle('ap', new ApiError(403, 'local-only', 'x'))
    const fresh = requests.idFor('ap', 'reject', 'reject_once')
    requests.settle('ap')
    expect(requests.idFor('ap', 'reject', 'reject_once')).not.toBe(fresh)
  })

  it('reads 409 approval-settled receipts', () => {
    const settled = (decidedBy: unknown) => new ApiError(409, 'approval-settled', 'x', { decidedBy } as never)
    const allow = { decision: 'allow' as const, optionKind: 'allow_once' as const }
    expect(settledOutcome(settled({ kind: 'device', self: true, decision: 'allow', at: '' }), allow)).toEqual({ applied: true })
    expect(settledOutcome(settled({ kind: 'device', self: false, deviceName: '我的手机', decision: 'reject', at: '' }), allow)).toEqual({
      applied: false,
      message: '已由「我的手机」处理',
      conflict: false,
    })
    expect(settledOutcome(settled({ kind: 'device', self: false, deviceName: 'x\u202Eevil', decision: 'reject', at: '' }), allow)).toEqual({
      applied: false,
      message: '该审批已结束',
      conflict: false,
    })
    expect(settledOutcome(settled({ kind: 'device', self: false, deviceName: '👨‍💻 Mac', decision: 'reject', at: '' }), allow)).toEqual({
      applied: false,
      message: '已由「👨‍💻 Mac」处理',
      conflict: false,
    })
    expect(settledOutcome(settled({ kind: 'device', self: false, deviceName: 'a\u200Bb', decision: 'reject', at: '' }), allow)).toEqual({
      applied: false,
      message: '该审批已结束',
      conflict: false,
    })
    expect(settledOutcome(settled({ kind: 'system' }), allow)).toEqual({ applied: false, message: '该审批已结束', conflict: false })
    expect(settledOutcome(new ApiError(403, 'local-only', 'x'), allow)).toBeUndefined()
  })

  it('never reports a changed choice as applied when this device had already decided otherwise', () => {
    const settled = (decidedBy: unknown) => new ApiError(409, 'approval-settled', 'x', { decidedBy } as never)
    expect(
      settledOutcome(settled({ kind: 'device', self: true, decision: 'allow', at: '' }), { decision: 'reject', optionKind: 'reject_once' }),
    ).toEqual({ applied: false, message: '此设备此前已选择「允许」，本次「拒绝」未生效。', conflict: true })
    expect(
      settledOutcome(settled({ kind: 'device', self: true, decision: 'reject', at: '' }), { decision: 'allow', optionKind: 'allow_once' }),
    ).toEqual({ applied: false, message: '此设备此前已选择「拒绝」，本次「允许」未生效。', conflict: true })
    // A Host that does not name the recorded option confirms only a plain once-choice.
    expect(
      settledOutcome(settled({ kind: 'device', self: true, decision: 'allow', at: '' }), { decision: 'allow', optionKind: 'allow_always' }),
    ).toEqual({ applied: false, message: '此设备此前已选择「允许」。', conflict: false })
    expect(settledOutcome(settled({ kind: 'device', self: true, decision: 'allow', at: '' }), { decision: 'allow' })).toEqual({
      applied: false,
      message: '此设备此前已选择「允许」。',
      conflict: false,
    })
    expect(settledOutcome(settled({ kind: 'device', self: true, at: '' }), { decision: 'reject', optionKind: 'reject_once' })).toEqual({
      applied: false,
      message: '该审批已结束',
      conflict: true,
    })
    let next = 0
    const requests = new DecisionRequests(() => `req-${++next}`)
    const first = requests.idFor('ap', 'allow', 'allow_once')
    requests.settle('ap', new ApiTimeoutError())
    expect(requests.idFor('ap', 'reject', 'reject_once')).not.toBe(first)
  })

  it('treats a receipt naming the same decision and option kind as applied, and a different kind as not taking effect', () => {
    const settled = (decidedBy: unknown) => new ApiError(409, 'approval-settled', 'x', { decidedBy } as never)
    const record = (optionKind: string) => settled({ kind: 'device', self: true, deviceName: 'Mac', decision: 'allow', optionKind, at: '' })
    expect(settledOutcome(record('allow_always'), { decision: 'allow', optionKind: 'allow_always' })).toEqual({ applied: true })
    expect(settledOutcome(record('allow_once'), { decision: 'allow', optionKind: 'allow_once' })).toEqual({ applied: true })
    expect(settledOutcome(record('allow_once'), { decision: 'allow', optionKind: 'allow_always' })).toEqual({
      applied: false,
      message: '此设备此前已选择「允许一次」，本次「始终允许」未生效。',
      conflict: true,
    })
    expect(settledOutcome(record('allow_always'), { decision: 'allow', optionKind: 'allow_once' })).toEqual({
      applied: false,
      message: '此设备此前已选择「始终允许」，本次「允许一次」未生效。',
      conflict: true,
    })
    expect(settledOutcome(record('something-new'), { decision: 'allow', optionKind: 'allow_once' })).toEqual({
      applied: false,
      message: '此设备此前已选择「允许」，本次「允许一次」未生效。',
      conflict: true,
    })
    // The kind the Host records: the chosen option's, or the once-kind for a plain decision.
    const options = [
      { id: 'proceed_always', label: 'Always', kind: 'allow_always' as const },
      { id: 'no', label: 'No', kind: 'reject_once' as const },
    ]
    expect(choiceKind({ options }, 'allow', 'proceed_always')).toBe('allow_always')
    expect(choiceKind({ options }, 'reject', 'no')).toBe('reject_once')
    expect(choiceKind({}, 'allow', undefined)).toBe('allow_once')
    expect(choiceKind({ options }, 'allow', 'missing')).toBeUndefined()
  })
})

describe('audit checkpoint', () => {
  const hash = (char: string) => char.repeat(64)
  function memory(initial: Record<string, string> = {}): CheckpointStorage & { data: Record<string, string> } {
    const data = { ...initial }
    return {
      data,
      getItem: key => data[key] ?? null,
      setItem: (key, value) => {
        data[key] = value
      },
    }
  }
  const fakeApi = (head: { seq: number; hash: string }, at: Record<number, string>) =>
    (async (path: string) => {
      if (path === 'audit/head') return head
      const seq = Number(new URLSearchParams(path.split('?')[1]).get('seq'))
      if (!(seq in at)) throw new ApiError(404, 'not-found', 'x')
      return { seq, hash: at[seq] }
    }) as never

  it('stores the head and accepts a log that grew from it', async () => {
    const storage = memory()
    expect((await verifyCheckpoint('h', { api: fakeApi({ seq: 5, hash: hash('a') }, {}), storage })).result).toBe('ok')
    expect(JSON.parse(storage.data['latch.audit.h']!)).toEqual({ seq: 5, hash: hash('a') })
    expect((await verifyCheckpoint('h', { api: fakeApi({ seq: 9, hash: hash('b') }, { 5: hash('a') }), storage })).result).toBe('ok')
    expect(JSON.parse(storage.data['latch.audit.h']!).seq).toBe(9)
  })

  it('does not report a rollback when another tab stores a newer checkpoint during the check, and never moves it back', async () => {
    const storage = memory({ 'latch.audit.h': JSON.stringify({ seq: 10, hash: hash('a') }) })
    const api = (async (path: string) => {
      if (path === 'audit/head') {
        // The head is answered at seq 10; another tab verifies a later head and stores it before this tab continues.
        storage.setItem('latch.audit.h', JSON.stringify({ seq: 11, hash: hash('b') }))
        return { seq: 10, hash: hash('a') }
      }
      return { seq: 10, hash: hash('a') }
    }) as never
    expect((await verifyCheckpoint('h', { api, storage })).result).toBe('ok')
    expect(JSON.parse(storage.data['latch.audit.h']!)).toEqual({ seq: 11, hash: hash('b') })
  })

  it.each([
    ['a different hash at the stored position', { seq: 9, hash: hash('b') }, { 5: hash('c') }],
    ['a missing record', { seq: 9, hash: hash('b') }, {}],
    ['a shorter log', { seq: 3, hash: hash('b') }, { 5: hash('a') }],
  ])('reports %s as a rollback and keeps the evidence', async (_name, head, at) => {
    const storage = memory({ 'latch.audit.h': JSON.stringify({ seq: 5, hash: hash('a') }) })
    expect((await verifyCheckpoint('h', { api: fakeApi(head, at), storage })).result).toBe('rollback')
    expect(JSON.parse(storage.data['latch.audit.h']!)).toEqual({ seq: 5, hash: hash('a') })
  })

  it('hides a dismissed rollback only while the Host log still extends what was dismissed', async () => {
    const storage = memory({ 'latch.audit.h': JSON.stringify({ seq: 5, hash: hash('a') }) })
    const session = memory({ 'latch.audit.dismissed.h': '1' })
    // A dismissal stored by an earlier build carries no checkpoint and hides nothing.
    expect(readDismissal('h', session)).toBeNull()
    const first = await verifyCheckpoint('h', { api: fakeApi({ seq: 9, hash: hash('b') }, { 5: hash('c'), 9: hash('b') }), storage })
    expect(first.result).toBe('rollback')
    if (first.result !== 'rollback') return
    expect(await rollbackDismissed(first, readDismissal('h', session), fakeApi(first.head, {}))).toBe(false)
    writeDismissal('h', { stored: first.stored, head: first.head }, session)
    const dismissal = readDismissal('h', session)
    const check = async (head: { seq: number; hash: string }, at: Record<number, string>) => {
      const outcome = await verifyCheckpoint('h', { api: fakeApi(head, at), storage })
      return rollbackDismissed(outcome, dismissal, fakeApi(head, at))
    }
    // The same mismatch, also after the Host appended more records.
    expect(await check({ seq: 9, hash: hash('b') }, { 5: hash('c'), 9: hash('b') })).toBe(true)
    expect(await check({ seq: 12, hash: hash('d') }, { 5: hash('c'), 9: hash('b') })).toBe(true)
    // A later, different rollback: the dismissed head was replaced, cut off, or the record is gone.
    expect(await check({ seq: 12, hash: hash('d') }, { 5: hash('c'), 9: hash('e') })).toBe(false)
    expect(await check({ seq: 7, hash: hash('f') }, { 5: hash('c') })).toBe(false)
    expect(await check({ seq: 12, hash: hash('d') }, { 5: hash('c') })).toBe(false)
    // A dismissal made against another stored checkpoint does not carry over.
    const other = memory({ 'latch.audit.h': JSON.stringify({ seq: 4, hash: hash('a') }) })
    const outcome = await verifyCheckpoint('h', {
      api: fakeApi({ seq: 9, hash: hash('b') }, { 4: hash('c'), 9: hash('b') }),
      storage: other,
    })
    expect(await rollbackDismissed(outcome, dismissal, fakeApi({ seq: 9, hash: hash('b') }, { 9: hash('b') }))).toBe(false)
  })

  it('moves a dismissal along with the records this tab has seen, so a later rollback of seen records shows again', async () => {
    const storage = memory({ 'latch.audit.h': JSON.stringify({ seq: 5, hash: hash('a') }) })
    const session = memory()
    // The record at seq 5 was replaced; the banner is dismissed while the Host's head is at seq 10.
    const first = await verifyCheckpoint('h', { api: fakeApi({ seq: 10, hash: hash('b') }, { 5: hash('c'), 10: hash('b') }), storage })
    if (first.result !== 'rollback') throw new Error('expected a rollback')
    writeDismissal('h', { stored: first.stored, head: first.head }, session)
    const check = async (head: { seq: number; hash: string }, at: Record<number, string>) => {
      const api = fakeApi(head, at)
      return keepDismissed('h', await verifyCheckpoint('h', { api, storage }), session, api)
    }
    // A later check sees the log at seq 20 with seq 10 unchanged: the same rollback, and seq 20 is now the reference.
    expect(await check({ seq: 20, hash: hash('d') }, { 5: hash('c'), 10: hash('b'), 20: hash('d') })).toBe(true)
    expect(readDismissal('h', session)).toEqual({ stored: { seq: 5, hash: hash('a') }, head: { seq: 20, hash: hash('d') } })
    // Records up to seq 20 are then replaced and the log grows to 25; seq 10 still matches, seq 20 does not.
    expect(await check({ seq: 25, hash: hash('f') }, { 5: hash('c'), 10: hash('b'), 20: hash('e'), 25: hash('f') })).toBe(false)
    // Cut back to a length between the head seen at dismissal and the newest head seen since.
    expect(await check({ seq: 15, hash: hash('g') }, { 5: hash('c'), 10: hash('b'), 15: hash('g') })).toBe(false)
    expect(readDismissal('h', session)?.head).toEqual({ seq: 20, hash: hash('d') })
  })

  it('keeps the dismissal reference at the newest head when two checks finish out of order', async () => {
    const storage = memory({ 'latch.audit.h': JSON.stringify({ seq: 5, hash: hash('a') }) })
    const session = memory()
    const first = await verifyCheckpoint('h', { api: fakeApi({ seq: 10, hash: hash('b') }, { 5: hash('c'), 10: hash('b') }), storage })
    if (first.result !== 'rollback') throw new Error('expected a rollback')
    writeDismissal('h', { stored: first.stored, head: first.head }, session)
    let release!: () => void
    const slow = new Promise<void>(resolve => {
      release = resolve
    })
    const log = { 5: hash('c'), 10: hash('b'), 20: hash('d'), 25: hash('e') }
    const delayed = (head: { seq: number; hash: string }) =>
      (async (path: string) => {
        if (path.includes('seq=10')) await slow
        return (fakeApi(head, log) as (path: string) => Promise<unknown>)(path)
      }) as never
    const api1 = delayed({ seq: 20, hash: hash('d') })
    const check1 = keepDismissed('h', await verifyCheckpoint('h', { api: api1, storage }), session, api1)
    const api2 = fakeApi({ seq: 25, hash: hash('e') }, log)
    expect(await keepDismissed('h', await verifyCheckpoint('h', { api: api2, storage }), session, api2)).toBe(true)
    release()
    expect(await check1).toBe(true)
    expect(readDismissal('h', session)?.head.seq).toBe(25)
    // Records this tab has seen (up to 25) are replaced: the banner shows again.
    const api3 = fakeApi({ seq: 30, hash: hash('g') }, { 5: hash('c'), 10: hash('b'), 20: hash('d'), 25: hash('f'), 30: hash('g') })
    expect(await keepDismissed('h', await verifyCheckpoint('h', { api: api3, storage }), session, api3)).toBe(false)
  })
})
