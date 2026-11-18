import { createPublicKey, verify as nodeVerify, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isSecurityErrorCode, looksSecret } from '@latch/protocol'
import type { Approval, AppSnapshot, ConfirmationTicket, CurrentDevice, DeviceScope, HostCatalog, HostView } from '@latch/protocol'
import { sha256Hex } from '@latch/core/node-kit'
import { SECURITY_VECTORS_FILE, testHarness } from '@latch/testkit'
import { hashDisplay as hostHashDisplay } from '@latch/host/crypto'
import { ApiError, ApiTimeoutError } from '../src/core/api.ts'
import { choiceKind, DecisionRequests, rejectionNoteFor, retryApprovalOption, settledOutcome } from '../src/core/approvalDecision.ts'
import { cancelAnswer, CancelRequests } from '../src/core/cancelRequest.ts'
import {
  activeFullAccess,
  blockedDetail,
  keepWhileAway,
  namedSession,
  openSession,
  setSessionOpener,
  shownTitle,
  stillBlocking,
} from '../src/core/blocking.ts'
import { dropProviderDraft, keepProviderDraft, peekProviderDraft } from '../src/settings/providerDraft.ts'
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
  blockedDetails,
  confirmationStore,
  ConfirmationError,
  withConfirmation,
  type ConfirmationActions,
  type ConfirmationPresenter,
  type ConfirmationView,
} from '../src/core/confirmations.ts'
import { contentHash, hashable, hashDisplay } from '../src/core/contentHash.ts'
import { MissingDeviceKeyError } from '../src/core/credentials.ts'
import {
  base32,
  base64url,
  base64urlDecode,
  deviceFingerprint,
  enrollSigningText,
  renewSigningText,
  signText,
} from '../src/core/deviceKey.ts'
import {
  browserDeviceName,
  defaultDeviceName,
  enrolledStep,
  enrollmentName,
  infoFailureStep,
  requestedScopes,
} from '../src/core/enrollment.ts'
import { approvalActions, composerGate, DEVICE_PERMISSION_COPY, deviceAccess, modeRows, sessionReadOnly } from '../src/core/permissions.ts'
import {
  BLOCKED_COPY,
  computerName,
  CONFIRMATION_RESULT_TEXT,
  DEVICES_COPY,
  describeFailure,
  ENROLLMENT_COPY,
  FILE_COPY,
  HOST_TEXT_MAX,
  isCatalogCode,
  MODEL_MENU_COPY,
  PROVIDER_COPY,
  SETTINGS_ADMIN_HIDDEN,
  SETUP_COPY,
  isSessionStopCode,
  safeTarget,
  SESSION_STOP_TEXT,
  stopLocksInput,
} from '../src/core/securityCopy.ts'
import type { LatchShell } from '../src/core/shell.ts'
import { setLocale } from '../src/core/i18n.ts'
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

const hostView: HostView = {
  hostId: 'h'.repeat(52),
  devMode: true,
  presence: { status: 'available' },
  tls: null,
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
  harnesses: [testHarness('codex', { kind: 'agent', label: 'Codex' }), testHarness('standard', { kind: 'builtin', label: 'Standard' })],
  providers: [{ id: 'p', name: 'P', kind: 'openai-compatible', models: ['m'], defaultModel: 'm' }],
  workspaces: [{ id: 'default', name: 'app', path: '/w' }],
  defaults: { harnessId: 'codex', mode: 'agent', workspaceId: 'default' },
}

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

describe('approval gating', () => {
  it.each([
    ['R1 with approve:standard', approval({ risk: 'R1' }), device(), ['允许一次', '本会话始终允许', '拒绝'], undefined, '等你处理'],
    [
      'R1 without approve:standard',
      approval({ risk: 'R1' }),
      device({ scopes: ['view', 'run'] }),
      ['拒绝'],
      '这台设备不能允许这一步',
      '等你处理',
    ],
    [
      'R2 with the scope, from any device',
      approval({ risk: 'R2' }),
      device({ scopes: allScopes }),
      ['拒绝', '允许一次'],
      undefined,
      '高风险',
    ],
    [
      'R2 without the scope',
      approval({ risk: 'R2' }),
      device({ scopes: ['view', 'run', 'approve:standard'] }),
      ['拒绝'],
      '这台设备不能允许这一步',
      '高风险',
    ],
    ['missing risk is treated as R2', approval({}), device({ scopes: ['view', 'run'] }), ['拒绝'], '这台设备不能允许这一步', '高风险'],
    [
      'advisory with run, from any device',
      approval({ risk: 'R2', advisory: true }),
      device({ scopes: ['view', 'run'] }),
      ['拒绝', '允许一次'],
      undefined,
      '仅提示',
    ],
    [
      'advisory without run',
      approval({ risk: 'R2', advisory: true }),
      device({ scopes: ['view'] }),
      ['拒绝'],
      '这台设备不能允许这一步',
      '仅提示',
    ],
  ] as const)('%s', (_name, item, current, buttons, hint, badge) => {
    const gate = approvalActions(item, current)
    expect(labels(gate)).toEqual(buttons)
    expect(gate.hint).toBe(hint)
    expect(gate.badge?.label).toBe(badge)
  })

  it('keeps every offered option on a Host of the previous build, and falls back to allow/reject without options', () => {
    expect(labels(approvalActions(approval({}), null))).toEqual(['允许一次', '本会话始终允许', '拒绝'])
    const plain = approvalActions({ id: 'a', sessionId: 's', toolName: 't', reason: '', requestedAt: '' }, null)
    expect(plain.explicit).toBe(false)
    expect(labels(plain)).toEqual(['拒绝', '允许一次'])
  })

  it('names the Host’s reason after 高风险, and only 高风险 for no reason or a code this page does not know', () => {
    const label = (extra: Partial<Approval>) => approvalActions(approval({ risk: 'R2', ...extra }), device()).badge?.label
    expect(label({ riskReason: 'code-root' })).toBe('高风险 · Latch 自己的代码')
    expect(label({ riskReason: 'protected-path' })).toBe('高风险 · 受保护的文件')
    expect(label({ riskReason: 'outside-workspace' })).toBe('高风险 · 在项目文件夹之外')
    expect(label({ riskReason: 'unresolved-path' })).toBe('高风险 · 不是项目里的相对路径')
    expect(label({ riskReason: 'unlisted-tool' })).toBe('高风险 · Latch 不认识的工具')
    expect(label({ riskReason: 'unparsable-arguments' })).toBe('高风险 · 参数无法解析')
    for (const unknown of ['toString', '__proto__', 'some-new-reason', 42, '']) {
      expect(label({ riskReason: unknown as Approval['riskReason'] })).toBe('高风险')
    }
    // An agent's question keeps its own pill whatever a reason says.
    expect(label({ advisory: true, riskReason: 'code-root' })).toBe('仅提示')
  })

  it('explains advisory prompts', () => {
    const advisory = approvalActions(approval({ advisory: true }), device()).note
    expect(advisory?.label).toBe('拒绝只会转达，拦不住它')
    expect(advisory?.detail).toContain('拒绝会转达给它，但不能阻止它执行其他操作')
  })
})

describe('session and harness gating', () => {
  it('opens a session to any device with the scope, whatever its Harness; only a stopped session or a missing scope closes it', () => {
    const browser = deviceAccess(snapshotOf(device()), null)
    expect(composerGate({ summary: {}, access: browser })).toEqual({ kind: 'open' })
    expect(composerGate({ summary: { permissionDrift: true }, access: browser })).toEqual({ kind: 'stopped' })
    expect(composerGate({ summary: {}, access: deviceAccess(snapshotOf(device({ status: 'review', scopes: ['view'] })), null) }).kind).toBe(
      'read-only',
    )
  })

  it('opens a session an assistant ran only to be read, on every device', () => {
    const summary = { personal: { assistantId: 'asst_1' } }
    for (const access of [deviceAccess(snapshotOf(device()), null), deviceAccess(snapshotOf(device({ scopes: ['view'] })), null)])
      expect(composerGate({ summary, access })).toEqual({ kind: 'read-only', text: '这个会话来自已移除的 Agent，只能查看' })
  })

  it('reads a session whose worktree was removed on every device, with the reason behind its Hint', () => {
    const summary = { worktree: { branch: 'latch/x', removed: true as const } }
    for (const access of [deviceAccess(snapshotOf(device()), null), deviceAccess(snapshotOf(device({ scopes: ['view'] })), null)]) {
      const gate = composerGate({ summary, access })
      expect(gate).toMatchObject({ kind: 'read-only', text: '只能查看', reason: expect.stringContaining('工作树已移除') })
    }
    expect(sessionReadOnly({ worktree: { branch: 'latch/x' } })).toBeUndefined()
    expect(sessionReadOnly(summary)?.reason).toContain('撤销本轮')
  })
})

describe('the 权限 rows', () => {
  const option = (currentValue: string) => ({
    currentValue,
    options: [
      { value: 'read', name: '只读', description: 'Codex 只看不改' },
      { value: 'auto', name: '自动' },
      { value: 'full', name: '完全访问' },
    ],
  })
  it('offers every row at once on any device', () => {
    const rows = modeRows(option('auto'))
    expect(rows.map(row => [row.value, row.current, row.disabledReason])).toEqual([
      ['read', false, undefined],
      ['auto', true, undefined],
      ['full', false, undefined],
    ])
    expect(rows[0]?.description).toBe('Codex 只看不改')
  })

  it('leaves the current row alone and disables the rest with the reason a session is locked', () => {
    const rows = modeRows(option('auto'), '这台设备不能发送消息')
    expect(rows.map(row => row.disabledReason)).toEqual(['这台设备不能发送消息', undefined, '这台设备不能发送消息'])
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
    expect(settingsSections(legacy, access)).toEqual(['general', 'providers', 'engines', 'workspaces', 'plugins', 'shortcuts', 'about'])
    expect(composerGate({ summary: {}, access })).toEqual({ kind: 'open' })
    expect(labels(approvalActions(approval({ risk: 'R2' }), access.device))).toEqual(['允许一次', '本会话始终允许', '拒绝'])
    const controller = deviceAccess({ ...legacy, device: { ...legacy.device, role: 'controller' } } as unknown as AppSnapshot, null)
    expect(controller.admin).toBe(false)
    expect(DEVICE_PERMISSION_COPY.legacyHost).toBe('这台 Mac 上的 Latch 还是旧版本，重新启动后才能确认设备。')
  })

  it('shows the restart message when the enrollment API is missing after a 401', () => {
    expect(infoFailureStep(new ApiError(404, 'not-found', 'x'))).toEqual({ kind: 'old-host' })
    expect(infoFailureStep(new TypeError('Failed to fetch')).kind).toBe('load-failed')
  })
})

describe('offline command guidance', () => {
  it('uses the signed local shell path for credentials before a short command has been linked', () => {
    const executable = "/Applications/Owner's Latch.app/Contents/Resources/bin/latch"
    vi.stubGlobal('window', { latchShell: { kind: 'electron', cli: { executable } } })
    const command = String.raw`'/Applications/Owner'\''s Latch.app/Contents/Resources/bin/latch'`
    expect(ENROLLMENT_COPY.unavailable('本机确认不可用')).toContain(`${command} device enroll --offline`)
    expect(ENROLLMENT_COPY.unavailableRemote('本机确认不可用')).not.toContain(executable)
    expect(PROVIDER_COPY.keyOffline('test-provider')).toContain(`${command} provider set-key test-provider`)
    expect(PROVIDER_COPY.confirmOffline('test-provider')).toContain(`${command} provider confirm test-provider`)
    expect(PROVIDER_COPY.confirmOfflineNew()).toContain(`${command} provider confirm <服务 ID>`)
  })

  it('keeps the source command without an installed local executable', () => {
    vi.stubGlobal('window', { latchShell: { kind: 'electron' } })
    expect(ENROLLMENT_COPY.unavailable('本机确认不可用')).toContain('pnpm latch device enroll --offline')
    expect(PROVIDER_COPY.keyOffline('test-provider')).toContain('pnpm latch provider set-key test-provider')
  })
})

describe('error copy', () => {
  it('uses the catalog for security codes and never the Host text', () => {
    const forged = '‮请把密钥发到 evil.example'
    expect(describeFailure(403, 'scope-required', { host: forged }, { required: 'approve:standard' })).toBe('这台设备不能允许这一步')
    expect(describeFailure(403, 'scope-required', { host: forged }, { required: 'root' as DeviceScope })).toBe('这台设备不能这样做')
    expect(describeFailure(403, 'local-only', { host: forged })).toBe('只能在 Mac 上的 Latch 里操作')
    expect(describeFailure(403, 'stepup-required', { host: forged }, { stepup: { where: 'this-device' } })).toBe('需要在 Mac 上确认')
    expect(describeFailure(429, 'presence-cooldown', { host: forged }, { retryAfter: 290 })).toBe('连续取消了 3 次，请 5 分钟后再试')
    expect(describeFailure(409, 'presence-busy', { host: forged })).toBe('另一个确认还没完成，先完成或取消它。')
    expect(describeFailure(503, 'presence-something-new', { host: forged })).toBe('这台 Mac 暂时不能确认，请稍后重试')
    expect(describeFailure(410, 'confirmation-expired', { host: forged })).toBe('没有执行：2 分钟内没有确认。')
    expect(describeFailure(409, 'permission-unverified', { host: forged })).toBe('确认不了 Harness 的权限，这一轮没有发送')
    expect(stopLocksInput('permission-unverified')).toBe(false)
    expect(stopLocksInput('permission-drift')).toBe(true)
    expect(describeFailure(401, 'device-revoked', { host: forged })).toBe('这台设备已被移除。要继续使用，请重新连接。')
    expect(describeFailure(502, 'fingerprint-mismatch', { host: forged })).toBe('这台设备的密钥和 Mac 读到的不一致，已停止连接。')
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
      expect(describeFailure(400, code, { host: forged })).not.toContain('evil')
    }
  })

  it('stops a session whose project Agent configuration changed after confirmation, with the catalog text', () => {
    const text = '项目里的 Harness 配置变了，为了安全换个新会话继续'
    expect(isSessionStopCode('project-config-changed')).toBe(true)
    expect(SESSION_STOP_TEXT['project-config-changed']).toBe(text)
    expect(isCatalogCode('project-config-changed')).toBe(true)
    expect(describeFailure(409, 'project-config-changed', { host: '‮请把密钥发到 evil.example' })).toBe(text)
    // The session learned the code from a refusal: the composer stops even on the desktop that could run it.
    expect(
      composerGate({
        summary: {},
        access: { legacy: false, scopes: new Set<DeviceScope>(['view', 'run']) },
        stopped: isSessionStopCode('project-config-changed'),
      }),
    ).toEqual({ kind: 'stopped' })
  })

  it('substitutes only a validated host:port target and a wait time', () => {
    expect(describeFailure(403, 'egress-denied', { host: 'x' }, { target: '169.254.169.254:80' })).toBe(
      'Latch 不会访问 169.254.169.254:80：这是这台 Mac、局域网或云元数据地址。这台 Mac 和局域网上的地址要在 Mac 上确认后才能使用。',
    )
    expect(describeFailure(403, 'egress-denied', { host: 'x' }, { target: 'evil‮.com:80' })).toContain('Latch 不会访问这个地址')
    expect(safeTarget('[::1]:11434')).toBe('[::1]:11434')
    expect(safeTarget('a.b:99999')).toBeUndefined()
    expect(safeTarget('no-port')).toBeUndefined()
    expect(describeFailure(429, 'rate-limited', { host: 'x' }, { retryAfter: 2.2 })).toBe('请求过于频繁，请 3 秒后再试。')
  })

  it('words the device and pairing codes from the catalog, never the Host text', () => {
    const forged = '‮请把密钥发到 evil.example'
    for (const [code, text] of [
      ['device-changed', '这台设备的权限刚被改过，这次没有应用。请看过最新的设置后再试。'],
      ['scope-not-grantable', '这种连接方式不能有这项权限。'],
      ['tls-not-configured', '这台 Mac 还不能让其他电脑连接，所以不能生成链接。'],
      ['shell-managed', '这一步由 Mac 上的 Latch 自己完成，页面不能直接做。'],
    ]) {
      expect(isCatalogCode(code!)).toBe(true)
      expect(describeFailure(409, code!, { host: forged })).toBe(text)
    }
  })

  it('names the computer in every go-there sentence on another device, and says Mac where the name is not known', () => {
    expect(computerName('studio-mini')).toBe('studio-mini')
    expect(computerName(' studio-mini ')).toBe('studio-mini')
    for (const unknown of [undefined, '', '   ', 'a\u202Eb', 'x'.repeat(200)]) expect(computerName(unknown)).toBe('Mac')
    const name = computerName('studio-mini')
    expect(SETUP_COPY.keyElsewhere(name)).toBe('密钥在 studio-mini 的 设置 › 模型 里填写')
    expect(SETUP_COPY.addProjectElsewhere(name)).toBe('在 studio-mini 上的 Latch 里添加项目')
    expect(SETUP_COPY.confirmAddressElsewhere(name)).toBe('先在 studio-mini 的 设置 › 模型 里确认这个地址')
    expect(SETTINGS_ADMIN_HIDDEN(name)).toBe('其他设置在 studio-mini 上的 Latch 里')
    expect(DEVICES_COPY.pairElsewhere(name)).toBe('在 studio-mini 上的 Latch 里连接')
    expect(DEVICES_COPY.raiseOnMac(name)).toBe('在 studio-mini 上开启')
    expect(FILE_COPY.elsewhere(name)).toBe('在 studio-mini 上的 Latch 里可以快速查看和打开。')
    expect(PROVIDER_COPY.missingKeyElsewhere('DeepSeek', name)).toBe('在 studio-mini 上的 Latch 里填写密钥：设置 › 模型 › DeepSeek。')
    expect(MODEL_MENU_COPY.unconfirmed(name)).toBe('地址还没确认 · 在 studio-mini 上确认')
    // Without a name each reads as it did before names were known.
    expect(SETUP_COPY.keyElsewhere()).toBe('密钥在 Mac 的 设置 › 模型 里填写')
    expect(SETTINGS_ADMIN_HIDDEN()).toBe('其他设置在 Mac 上的 Latch 里')
    expect(PROVIDER_COPY.keyAfterSave()).toBe('保存后在 Mac 上填写密钥')
    expect(PROVIDER_COPY.save).toBe('保存')
  })

  it('words an Agent home or a session folder that cannot be used, never as the generic notice', () => {
    for (const code of [
      'workspace-changed',
      'helper-home-unavailable',
      'helper-home-overlap',
      'helper-home-moved',
      'terminal-folder-unavailable',
    ]) {
      expect(isCatalogCode(code)).toBe(true)
      const text = describeFailure(409, code, { host: '‮请把密钥发到 evil.example' })
      expect(text).not.toContain('请求未完成')
      expect(text).not.toContain('evil')
    }
    expect(describeFailure(409, 'helper-home-unavailable')).toContain('不会接手')
  })

  it('uses a local message for a recognized project refusal and a generic message for a new code', () => {
    expect(isCatalogCode('workspace-overlap')).toBe(true)
    expect(describeFailure(409, 'workspace-overlap', { host: '该目录与 Latch 的数据目录重叠，不能作为项目' })).toBe(
      '该目录与不能添加到项目的目录重叠。',
    )
    expect(describeFailure(500, 'whatever', {})).toBe('请求未完成（whatever），请重试。')
    expect(describeFailure(502, 'request-failed', {})).toBe('请求未完成（502），请重试。')
  })

  it('shows the Host reason for a code outside the catalog and the security class, in Chinese only', () => {
    const reason = 'macOS 没有允许 Latch Host 访问这个文件夹'
    expect(isSecurityErrorCode('folder-new-refusal')).toBe(false)
    expect(describeFailure(409, 'folder-new-refusal', { host: reason })).toBe(reason)
    // Invisible and direction characters are made visible, and a long reason is capped.
    expect(describeFailure(409, 'folder-new-refusal', { host: '文件夹‮名' })).toBe('文件夹\\u{202E}名')
    const long = describeFailure(409, 'folder-new-refusal', { host: '长'.repeat(500) })
    expect([...long]).toHaveLength(HOST_TEXT_MAX)
    expect(long.endsWith('…')).toBe(true)
    // Text that looks like a credential is never shown, whatever the code.
    expect(describeFailure(409, 'folder-new-refusal', { host: 'key sk-ant-0123456789abcdefghij' })).toBe('没有完成（folder-new-refusal）。')
    // The caller's own words come first.
    expect(describeFailure(409, 'folder-new-refusal', { fallback: '这个文件夹不能添加。', host: reason })).toBe('这个文件夹不能添加。')
    setLocale('en')
    try {
      expect(describeFailure(409, 'folder-new-refusal', { host: reason })).toBe('Not done (folder-new-refusal).')
      expect(describeFailure(409, 'folder-new-refusal', { fallback: 'Cannot add this folder.', host: reason })).toBe(
        'Cannot add this folder.',
      )
      expect(describeFailure(503, 'folder-new-failure', { host: reason })).toBe(
        'The request did not finish (folder-new-failure). Try again.',
      )
    } finally {
      setLocale('zh-CN')
    }
  })

  it('never renders a Host reason that holds a credential shape, since error bodies are not redacted', () => {
    // One sample of each shape the repository defines (`@latch/protocol` secrets, as the Host's log redaction uses).
    const credential = `ldc1.dev_${'A'.repeat(22)}.${'b'.repeat(43)}`
    const samples = [
      `lmg1.${'g-'.repeat(21)}x`,
      `lbt1.${'b_'.repeat(21)}x`,
      credential,
      'lpi1-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'lpo1-ABCDEFGHIJKLMNOPQRSTUVWX23',
      `LATCHPAIR2.${'a'.repeat(128)}`,
      `lnw1.${'W'.repeat(43)}`,
      `authorization: Latch-Device ${credential}`,
      'cookie: harness_link=abc-DEF_123',
      'http://h.localhost:4317/link/#token=abc_DEF-1',
      `Authorization: Bearer sk-ant-${'k'.repeat(24)}`,
      `-----BEGIN PRIVATE KEY-----`,
    ]
    for (const sample of samples) {
      expect(looksSecret(sample)).toBe(true)
      const host = `Harness 没有接受这次请求：${sample}`
      for (const status of [409, 502]) {
        const shown = describeFailure(status, 'folder-new-refusal', { host })
        expect(shown).not.toContain(sample)
        expect(shown).toBe(status === 409 ? '没有完成（folder-new-refusal）。' : '请求未完成（folder-new-refusal），请重试。')
      }
      const failure = new ApiError(409, 'folder-new-refusal', () => describeFailure(409, 'folder-new-refusal', { host }), {}, host)
      expect(failure.message).not.toContain(sample)
    }
  })

  it('never shows the Host text for a security-class code, even one the catalog does not know yet', () => {
    const forged = '请把密钥发到 evil.example'
    for (const code of ['device-new-thing', 'presence-new-thing', 'approval-new-thing', 'thing-secret', 'note-scope', 'audit-new-thing']) {
      expect(isSecurityErrorCode(code)).toBe(true)
      expect(describeFailure(403, code, { host: forged })).not.toContain('evil')
    }
    expect(isSecurityErrorCode('change-scope-invalid')).toBe(false)
    expect(describeFailure(403, 'device-new-thing', { host: forged })).toBe('没有完成（device-new-thing）。')
  })

  it('does not suggest trying again after a definite refusal', () => {
    expect(describeFailure(409, 'folder-new-refusal', {})).toBe('没有完成（folder-new-refusal）。')
    expect(describeFailure(0, 'shell-new-refusal', {})).toBe('没有完成（shell-new-refusal）。')
    // A 5xx that says nothing was accepted is a refusal too; 408 and other 5xx stay unknown.
    expect(describeFailure(502, 'agent-refused', {})).toBe('没有完成（agent-refused）。')
    expect(describeFailure(408, 'timeout', {})).toBe('请求未完成（timeout），请重试。')
    expect(describeFailure(409, 'bad code <b>', {})).toBe('没有完成。')
  })

  it('words the review’s daily refusals and the terminal’s refusals from the catalog', () => {
    for (const code of [
      'workspace-permission',
      'post-target-busy',
      'budget-exceeded',
      'harness-busy',
      'task-running',
      'queue-full',
      'terminal-limit',
      'terminal-folder-unavailable',
    ])
      expect(isCatalogCode(code)).toBe(true)
    expect(describeFailure(409, 'workspace-permission', { host: 'x' })).toBe(
      '没有权限访问这个文件夹。请在 系统设置 › 隐私与安全性 里允许 Latch 访问。',
    )
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

  it('asks for management only when told to, and for nothing the invitation does not grant', () => {
    expect(requestedScopes(false)).toEqual(['view', 'run', 'approve:standard', 'approve:elevated'])
    expect(requestedScopes(true)).toEqual(['view', 'run', 'approve:standard', 'approve:elevated', 'admin'])
    const managing: DeviceScope[] = ['view', 'run', 'approve:standard', 'admin']
    expect(requestedScopes(true, managing)).toEqual(['view', 'run', 'approve:standard', 'admin'])
    expect(requestedScopes(false, managing)).toEqual(['view', 'run', 'approve:standard'])
    expect(requestedScopes(true, ['view', 'run'])).toEqual(['view', 'run'])
  })

  it('names a browser so the system sheet says which one asked, within the rule for device names', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
    const cases: Array<[string, number, string]> = [
      [`${mac}Chrome/126.0.0.0 Safari/537.36`, 0, 'Mac 上的 Chrome'],
      [`${mac}Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0`, 0, 'Mac 上的 Edge'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0', 0, 'Mac 上的 Firefox'],
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
        5,
        'iPhone 上的 Safari',
      ],
      // iPadOS Safari introduces itself as a Mac; only the touch points tell.
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5, 'iPad 上的 Safari'],
      ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36', 5, 'Android 上的 Chrome'],
      ['unknown', 0, '浏览器'],
    ]
    for (const [agent, touch, name] of cases) {
      expect(browserDeviceName(agent, touch)).toBe(name)
      expect(enrollmentName(name)).toBe(name)
    }
  })
})

describe('local confirmation', () => {
  const ticket = (status: ConfirmationTicket['status']): ConfirmationTicket => ({
    id: 'cfm_1',
    action: 'policy.change',
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
    ['denied', '没有执行：确认没有通过。'],
    ['expired', '没有执行：2 分钟内没有确认。'],
    ['error', '没有执行：确认没有完成，请重试。'],
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

  it('says a denied confirmation did not run', async () => {
    const error = await withConfirmation(
      async (confirmation?: string) => {
        if (!confirmation) throw stepup()
        return 'never'
      },
      {
        presenter: presenter().value,
        api: (async () => ({ confirmation: ticket('denied') })) as never,
        sleep: instant,
      },
    ).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ message: '没有执行：确认没有通过。', reason: 'denied' })
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

  it('keeps a confirmation with its active card and cancels it if the card disappears', async () => {
    const calls: string[] = []
    const pending = () =>
      withConfirmation(
        async confirmation => {
          if (!confirmation) throw stepup()
          return 'never'
        },
        {
          api: (async (path: string, options?: { method?: string }) => {
            calls.push(`${options?.method ?? 'GET'} ${path}`)
            return { confirmation: ticket('pending') }
          }) as never,
          sleep: (_ms, signal) =>
            new Promise<void>(resolve => {
              signal.addEventListener('abort', () => resolve(), { once: true })
            }),
        },
      )
    // A request with no place to show its confirmation is cancelled, never polled or retried.
    await expect(pending()).rejects.toMatchObject({ reason: 'cancelled', handled: false })
    expect(calls).toContain('DELETE confirmations/cfm_1')
    expect(confirmationStore.get()).toBeNull()
    confirmationStore.host('composer', true)
    confirmationStore.host('inspector', true, 1)
    confirmationStore.host('dialog', true)
    const running = pending().catch((cause: unknown) => cause)
    await vi.waitFor(() => expect(confirmationStore.get()?.host).toBe('inspector'))
    confirmationStore.host('inspector', false, 1)
    expect(confirmationStore.get()?.host).toBe('inspector')
    confirmationStore.unhost('inspector')
    expect(confirmationStore.get()).toBeNull()
    await expect(running).resolves.toMatchObject({ reason: 'cancelled' })
    const refused = withConfirmation(async () => {
      throw new ApiError(409, 'presence-busy', 'x')
    }).catch(() => undefined)
    await refused
    expect(confirmationStore.get()).toMatchObject({ host: 'dialog', view: { phase: 'paused', reason: 'busy' } })
    confirmationStore.unhost('dialog')
    expect(confirmationStore.get()).toBeNull()
    confirmationStore.unhost('composer')
  })

  it('names the open ticket until the request goes out again with it', async () => {
    const seen: Array<string | null> = []
    const statuses: ConfirmationTicket['status'][] = ['approved']
    await withConfirmation(
      async confirmation => {
        if (!confirmation) throw stepup()
        expect(seen).toEqual([ticket('pending').id, null])
        return 'done'
      },
      {
        presenter: { show: () => {}, close: () => {} },
        api: (async () => ({ confirmation: ticket(statuses.shift() ?? 'approved') })) as never,
        sleep: async () => {},
        onTicket: id => seen.push(id),
      },
    )
    expect(seen).toHaveLength(2)
  })

  it('keeps the store usable as a presenter by callers that wrap it, one flow per show after a close', async () => {
    const seen: boolean[] = []
    const wrapping: ConfirmationPresenter = {
      show: (view, actions) => {
        confirmationStore.show(view, actions)
        seen.push(view.phase === 'waiting')
      },
      close: () => {
        confirmationStore.close()
        seen.push(false)
      },
    }
    confirmationStore.host('page', true)
    const statuses: ConfirmationTicket['status'][] = ['approved']
    await withConfirmation(
      async confirmation => {
        if (!confirmation) throw stepup()
        expect(confirmationStore.get()).toMatchObject({ host: 'page', view: { phase: 'sending' } })
        return 'done'
      },
      {
        presenter: wrapping,
        api: (async () => ({ confirmation: ticket(statuses.shift() ?? 'approved') })) as never,
        sleep: async () => {},
      },
    )
    expect(confirmationStore.get()).toBeNull()
    expect(seen).toEqual([true, false, false])
    confirmationStore.unhost('page')
  })

  it('reads the refused action and the named sessions of presence-blocked, and nothing it does not expect', async () => {
    expect(
      blockedDetails({
        action: 'device.enroll',
        blockingTasks: [{ id: 'acp-1', title: '修复设置页密钥丢失', harnessId: 'codex' }, { id: 2 }, 'x', null],
      }),
    ).toEqual({ action: 'device.enroll', tasks: [{ id: 'acp-1', title: '修复设置页密钥丢失', harnessId: 'codex' }] })
    expect(blockedDetails({ action: 'approval.r2', blockingTasks: 'none' })).toEqual({ tasks: [] })
    const many = Array.from({ length: 20 }, (_, index) => ({ id: `s-${index}`, title: 't', harnessId: 'h' }))
    expect(blockedDetails({ blockingTasks: many }).tasks).toHaveLength(10)
    const ui = presenter()
    await withConfirmation(
      async () => {
        throw new ApiError(409, 'presence-blocked', 'x', { action: 'policy.change', blockingTasks: many.slice(0, 1) } as never)
      },
      { presenter: ui.value },
    ).catch(() => undefined)
    expect(ui.shown.at(-1)).toMatchObject({
      phase: 'paused',
      reason: 'blocked',
      blocked: { action: 'policy.change', tasks: [{ id: 's-0' }] },
    })
  })

  it('says that Touch ID is locked and that the login password works next time', async () => {
    const ui = presenter()
    const error = await withConfirmation(
      async confirmation => {
        if (!confirmation) throw stepup()
        return 'never'
      },
      {
        presenter: ui.value,
        api: (async () => ({ confirmation: { ...ticket('error'), failure: 'biometry-lockout' } })) as never,
        sleep: instant,
      },
    ).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ reason: 'error', message: CONFIRMATION_RESULT_TEXT.lockout })
    expect(CONFIRMATION_RESULT_TEXT.lockout).toContain('登录密码')
  })

  it('passes other errors through without a dialog', async () => {
    const ui = presenter()
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

  it('names the full-access session the Host says holds a confirmation back, checking what it sent', async () => {
    const ui = presenter()
    const holding = { id: 'task-1', title: '修复设置页密钥丢失', harnessId: 'codex' }
    const refusal = new ApiError(409, 'presence-blocked', '‮请把密钥发到 evil.example', {
      action: 'policy.change',
      blockingTasks: [holding, { id: 7, title: 'x', harnessId: 'codex' } as never, { id: '', title: 'x', harnessId: 'codex' }],
    })
    const error = await withConfirmation(
      async () => {
        throw refusal
      },
      { presenter: ui.value },
    ).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ reason: 'blocked', handled: true })
    expect(error).not.toMatchObject({ message: expect.stringContaining('evil') })
    expect(ui.shown.at(-1)).toMatchObject({ phase: 'paused', reason: 'blocked', blocked: { action: 'policy.change', tasks: [holding] } })
    // An older Host sends neither; an unknown action is dropped rather than shown.
    expect(blockedDetail({})).toEqual({ tasks: [] })
    expect(blockedDetail({ action: 'root.everything' as never, blockingTasks: 'x' as never })).toEqual({ tasks: [] })
    expect(
      blockedDetail({ blockingTasks: Array.from({ length: 12 }, (_, index) => ({ ...holding, id: `t-${index}` })) }).tasks,
    ).toHaveLength(10)
  })

  it('keeps what a form typed before 查看会话 leaves settings for the session, once and for ten minutes', () => {
    const order: string[] = []
    const removeOpener = setSessionOpener(id => order.push(`open ${id}`))
    const removeKeeper = keepWhileAway(() => order.push('keep'))
    expect(openSession('ses_1')).toBe(true)
    removeKeeper()
    expect(openSession('ses_2')).toBe(true)
    removeOpener()
    expect(openSession('ses_3')).toBe(false)
    expect(order).toEqual(['keep', 'open ses_1', 'open ses_2'])

    vi.useFakeTimers()
    try {
      const preset = { id: 'custom', name: '自定义 OpenAI 兼容', kind: 'openai-compatible' as const, baseURL: '', requiresKey: false }
      const models = ['lab-model']
      keepProviderDraft({
        preset,
        name: '实验室',
        kind: 'openai-compatible',
        baseURL: 'https://lab.example/v1',
        apiKey: 'sk-typed',
        models,
        defaultModel: 'lab-model',
      })
      models.push('changed later')
      expect(peekProviderDraft('custom')).toMatchObject({ name: '实验室', apiKey: 'sk-typed', models: ['lab-model'] })
      expect(peekProviderDraft('ollama')).toBeUndefined()
      dropProviderDraft()
      expect(peekProviderDraft()).toBeUndefined()
      keepProviderDraft({ preset, name: '实验室', kind: 'openai-compatible', baseURL: '', apiKey: '', models: [], defaultModel: '' })
      vi.advanceTimersByTime(10 * 60_000)
      expect(peekProviderDraft()).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says in one sentence which session holds a confirmation back and what waits for it', () => {
    const codex = { title: '修复设置页密钥丢失', agent: 'Codex' }
    expect(BLOCKED_COPY.line([codex], 'policy.change')).toBe('Codex 正在运行「修复设置页密钥丢失」，结束后才能放宽设置。')
    expect(BLOCKED_COPY.line([codex], 'device.enroll')).toBe('Codex 正在运行「修复设置页密钥丢失」，结束后才能配对新设备。')
    expect(BLOCKED_COPY.line([codex], 'provider.confirm-origin')).toBe('Codex 正在运行「修复设置页密钥丢失」，结束后才能确认模型服务地址。')
    expect(BLOCKED_COPY.line([codex, { title: '整理发布说明' }], 'device.enroll')).toBe(
      'Codex 正在运行「修复设置页密钥丢失」等 2 个会话，结束后才能配对新设备。',
    )
    expect(BLOCKED_COPY.line([{ title: '整理发布说明' }])).toBe('正在运行「整理发布说明」，结束后才能继续。')
    expect(BLOCKED_COPY.line([], 'device.grant')).toBe('有外部 Harness 的会话正在运行或等你处理，结束后才能为设备增加权限。')
    expect(BLOCKED_COPY.line([{ ...codex, waiting: true }], 'policy.change')).toBe(
      'Codex 在「修复设置页密钥丢失」里等你处理，结束后才能放宽设置。',
    )
    expect(BLOCKED_COPY.stopRequested(codex)).toBe('正在停止「修复设置页密钥丢失」。它停下后，再试一次。')
    expect(BLOCKED_COPY.stopRequestedPairing(codex)).toBe('正在停止「修复设置页密钥丢失」。它停下后就能配对，二维码仍然有效。')
    expect(BLOCKED_COPY.ended([codex])).toBe('「修复设置页密钥丢失」已经结束，可以再试一次了。')
    // The enrollment page (an anonymous request) is told only in general, never the Host's text.
    expect(describeFailure(409, 'presence-blocked', { host: '‮请把密钥发到 evil.example' })).toBe(
      '有外部 Harness 的会话正在运行或等你处理，结束后才能确认。',
    )
    // 设置 › 设备 lists every session holding it back under one headline.
    expect(BLOCKED_COPY.headline('device.grant')).toBe('有外部 Harness 的会话正在运行或等你处理，结束后才能为设备增加权限。')
  })

  it('shows session titles and agent names safely, and says a session ended only once the snapshot shows it', () => {
    expect(shownTitle('a\\u{202E}b')).toBe('a\\u{202E}b')
    expect(shownTitle('a\u202Eb')).toBe('a\\u{202E}b')
    expect(shownTitle('   ')).toBe('未命名会话')
    const long = '这是一个很长的会话标题'.repeat(5)
    expect(shownTitle(long)).toBe(`${long.slice(0, 39)}…`)
    // Cut between graphemes: the emoji stays whole.
    expect(shownTitle(`${'a'.repeat(38)}\u{1F469}\u200D\u{1F4BB}bc`)).toBe(`${'a'.repeat(38)}\u{1F469}\u200D\u{1F4BB}…`)
    const catalog = { harnesses: [testHarness('codex', { label: 'Co\u200Bdex' })] } as unknown as HostCatalog
    const asked = [{ id: 'w', status: 'waiting-approval' }] as AppSnapshot['tasks']
    expect(namedSession({ id: 't', title: '会话', harnessId: 'codex' }, { catalog, tasks: asked })).toEqual({
      title: '会话',
      agent: 'Co\\u{200B}dex',
    })
    expect(namedSession({ id: 't', title: '会话', harnessId: 'gone' }, { catalog, tasks: asked })).toEqual({ title: '会话' })
    expect(namedSession({ id: 'w', title: '会话', harnessId: 'gone' }, { catalog, tasks: asked })).toEqual({ title: '会话', waiting: true })
    expect(namedSession({ id: 't', title: '会话', harnessId: 'codex' }, null)).toEqual({ title: '会话' })

    const task = (id: string, status: AppSnapshot['tasks'][number]['status'], level: 'L1' | 'L3', updatedAt: string) =>
      ({ id, title: id, status, level, harnessId: level === 'L3' ? 'codex' : 'standard', updatedAt }) as AppSnapshot['tasks'][number]
    const tasks = [
      task('older', 'running', 'L3', '2026-10-25T08:00:00.000Z'),
      task('builtin', 'running', 'L1', '2026-10-25T10:00:00.000Z'),
      task('newer', 'running', 'L3', '2026-10-25T09:00:00.000Z'),
      task('asking', 'waiting-approval', 'L3', '2026-10-25T07:00:00.000Z'),
      task('done', 'idle', 'L3', '2026-10-25T11:00:00.000Z'),
    ]
    expect(activeFullAccess({ tasks }).map(item => item.id)).toEqual(['asking', 'newer', 'older'])
    const named = [
      { id: 'done', title: 'done', harnessId: 'codex' },
      { id: 'newer', title: 'newer', harnessId: 'codex' },
      { id: 'unlisted', title: 'unlisted', harnessId: 'codex' },
    ]
    expect(stillBlocking(named, { tasks }).map(item => item.id)).toEqual(['newer', 'unlisted'])
    expect(stillBlocking(named, null)).toEqual(named)
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

describe('approval decisions (idempotent retries)', () => {
  it('looks up only the original decision, option and note when retrying', () => {
    let next = 0
    const requests = new DecisionRequests(() => `req-${++next}`)
    const first = requests.idFor('ap', 'reject', 'reject_once', '先给我看计划')
    expect(requests.retryId('ap', 'reject', 'reject_once', '先给我看计划')).toBe(first)
    expect(requests.retryId('ap', 'reject', 'reject_once', '换一条')).toBeUndefined()
    expect(requests.retryId('ap', 'reject', undefined, '先给我看计划')).toBeUndefined()
    expect(requests.retryId('ap', 'allow', 'allow_once')).toBeUndefined()
    expect(next).toBe(1)
    requests.settle('ap')
    expect(requests.retryId('ap', 'reject', 'reject_once', '先给我看计划')).toBeUndefined()
  })

  it('cannot replace a missing approval option with a different scope', () => {
    const once = { id: 'once', kind: 'allow_once', label: '允许一次' } as const
    const original = { decision: 'allow', optionId: 'always' } as const
    expect(retryApprovalOption({ explicit: true, options: [once] }, original)).toBeUndefined()
    expect(retryApprovalOption({ explicit: false, options: [once] }, original)).toBeUndefined()
    expect(retryApprovalOption({ explicit: false, options: [once] }, { ...original, optionId: undefined })).toBe(once)
  })

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

  it('reuses one stop request per run while its outcome is unknown, and starts a new one for another run', () => {
    let next = 0
    const requests = new CancelRequests(() => `stop-${++next}`)
    const first = requests.bodyFor('s', 'run-1')
    expect(first).toEqual({ requestId: 'stop-1', runId: 'run-1' })
    requests.settle('s', new ApiTimeoutError())
    expect(requests.bodyFor('s', 'run-1')).toEqual(first)
    requests.settle('s', new ApiError(503, 'request-failed', 'x'))
    expect(requests.bodyFor('s', 'run-1')).toEqual(first)
    expect(requests.bodyFor('s', 'run-2')).toEqual({ requestId: 'stop-2', runId: 'run-2' })
    requests.settle('s', new ApiError(404, 'task-not-found', 'x'))
    expect(requests.bodyFor('s', 'run-2')).toEqual({ requestId: 'stop-3', runId: 'run-2' })
    requests.settle('s')
    expect(requests.bodyFor('s', undefined)).toEqual({ requestId: 'stop-4' })
    expect(requests.bodyFor('other', undefined)).toEqual({ requestId: 'stop-5' })
  })

  it('reads whether a stop stopped its run, found it ended, or found a later run', () => {
    const at = '2026-10-25T08:00:00.000Z'
    expect(cancelAnswer({ accepted: true, receipt: { sessionId: 's', outcome: 'stopped', status: 'cancelled', at } })).toBe('stopped')
    expect(cancelAnswer({ accepted: true, receipt: { sessionId: 's', outcome: 'ended', status: 'idle', at } })).toBe('ended')
    expect(cancelAnswer({ accepted: true, receipt: { sessionId: 's', outcome: 'ended', at } })).toBe('newer')
    // An older Host answers without a receipt.
    expect(cancelAnswer({ accepted: true })).toBeUndefined()
    expect(cancelAnswer({ accepted: true, receipt: { outcome: 'other' } })).toBeUndefined()
    expect(cancelAnswer(null)).toBeUndefined()
  })

  it('gives a rejection with a different note its own requestId and the same note the same one', () => {
    let next = 0
    const requests = new DecisionRequests(() => `req-${++next}`)
    const first = requests.idFor('ap', 'reject', undefined, '先给我看计划')
    requests.settle('ap', new ApiTimeoutError())
    expect(requests.idFor('ap', 'reject', undefined, '先给我看计划')).toBe(first)
    expect(requests.idFor('ap', 'reject', undefined, '改写到 docs/')).not.toBe(first)
  })

  it('checks 「告诉 Harness 改做什么」 as the Host does, and leaves an agent’s ask to the next message', () => {
    expect(rejectionNoteFor('  先给我看计划\r\n再写  ')).toEqual({ note: '先给我看计划\n再写' })
    expect(rejectionNoteFor('   ')).toEqual({})
    const problem = '说明最多 500 个字，不能包含控制字符、不可见字符或改变文字方向的字符'
    expect(rejectionNoteFor('x'.repeat(501))).toEqual({ problem })
    expect(rejectionNoteFor('改写\u202E到 docs/')).toEqual({ problem })
    expect(rejectionNoteFor('改写\u0007')).toEqual({ problem })
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
