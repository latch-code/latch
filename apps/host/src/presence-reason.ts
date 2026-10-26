import { homedir } from 'node:os'
import {
  escapeSecurityText,
  type PermissionLevel,
  type PresenceAction,
  type PresenceReasonForm,
  type PresenceSubject,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson } from '@latch/core/node-kit'
import { policyDiff, type Policy } from './policy.ts'

/**
 * A literal; a slot, escaped and cut to `max` grapheme clusters with 「…」 (at its start for `keep: 'end'`, so a path
 * keeps its file name and a host name its domain); or text added only when one of the slots `cut` was cut. A slot with
 * a `lead` may be empty, and then neither it, its lead nor its `trail` appears; every other slot must have text.
 */
type Segment =
  | string
  | { slot: string; max: number; keep?: 'end'; lead?: string; trail?: string }
  | { cut: readonly string[]; text: string }

interface ReasonForm {
  actions: readonly PresenceAction[]
  segments: readonly Segment[]
}

const HARNESS = { slot: 'harness', max: 16 } as const
/**
 * Where a session runs: a saved project by its name, or, for a session without one, the Host's words for its folder
 * (`folder`). Exactly one of the two has text; the other is empty and leaves nothing.
 */
const PROJECT = { slot: 'project', max: 16, lead: '（在「', trail: '」）' } as const
const FOLDER = { slot: 'folder', max: 16, lead: '（在', trail: '）' } as const
/** The resolved executable's absolute path (home as ~), keeping its end: the file name and the folders nearest it. */
const PROGRAM = { slot: 'program', max: 52, keep: 'end' } as const
const ARGS = { slot: 'args', max: 24, lead: ' ' } as const
/** The names of the environment variables a definition sets; never their values. */
const ENV = { slot: 'env', max: 24, lead: '，另设 ' } as const
const FULL_COMMAND = { cut: ['program', 'args', 'env'], text: '；完整命令见 Latch 里的确认详情' } as const
const COMMAND = [PROGRAM, ARGS, ENV, FULL_COMMAND] as const
const WHY = { slot: 'why', max: 16 } as const
const TARGET = { slot: 'target', max: 48, keep: 'end' } as const

/**
 * The fixed wording of every reason; the macOS helper holds the same table (`reasonForms` in LatchPresence.swift) and
 * the shared vectors pin both. Each sentence completes the system sheet's 「“…”正在尝试…」 and every slot has its own
 * length, so text a device, an admin or a model chose cannot push the Host's facts out; fixed text is never cut. Any
 * change to a fixed part changes the helper's signature and needs `pnpm latch presence repin`: what can change without
 * one (a tool's or a mode's display name, the words for a session's folder) is slot text the Host fills in.
 */
export const REASON_FORMS: Readonly<Record<PresenceReasonForm, ReasonForm>> = {
  'plugin.package.apply': {
    actions: ['plugin.package.apply'],
    segments: ['应用插件「', { slot: 'plugin', max: 24 }, '」，允许其可信代码访问 Host 进程或当前页面'],
  },
  'agent.probe': { actions: ['agent.probe'], segments: ['测试启动 ', HARNESS, '（不发送提示词）：', ...COMMAND] },
  'approval.write': { actions: ['approval.r2'], segments: ['批准写入 ', { slot: 'path', max: 40, keep: 'end' }, '（', WHY, '）'] },
  'approval.tool': {
    actions: ['approval.r2'],
    segments: [
      '批准运行工具 ',
      { slot: 'tool', max: 24 },
      '（',
      WHY,
      '）',
      { slot: 'input', max: 40, lead: '：' },
      { cut: ['input'], text: '；完整参数见 Latch 里的确认详情' },
    ],
  },
  'key.save': {
    actions: ['provider.set-key'],
    segments: ['保存 ', { slot: 'provider', max: 24 }, ' 的密钥，只发往 ', { slot: 'origin', max: 48, keep: 'end' }],
  },
  'key.origin': {
    actions: ['provider.set-key', 'policy.change', 'provider.confirm-origin'],
    segments: ['保存 ', { slot: 'provider', max: 24 }, ' 并允许 Host 访问 ', TARGET],
  },
  'origin.confirm': { actions: ['provider.confirm-origin'], segments: ['允许 Host 访问模型服务地址 ', TARGET] },
  'policy.egress': { actions: ['policy.change'], segments: ['允许 Host 访问 ', { slot: 'target', max: 64, keep: 'end' }] },
  'policy.egress-many': { actions: ['policy.change'], segments: ['允许 Host 访问 ', { slot: 'count', max: 4 }, ' 个新地址'] },
  'policy.local': { actions: ['policy.change'], segments: ['把在这台电脑上发起的上限放宽到', { slot: 'level', max: 8 }] },
  'policy.native-input': { actions: ['policy.change'], segments: ['恢复所有原生手机的输入权限'] },
  'policy.native-link': {
    actions: ['policy.change'],
    segments: ['更改手机连接：', { slot: 'direct', max: 48 }, '，', { slot: 'count', max: 1 }, ' 个中继节点；新中继可看到连接时间与 IP'],
  },
  'policy.remote': { actions: ['policy.change'], segments: ['把从手机和其他电脑发起的上限放宽到', { slot: 'level', max: 8 }] },
  'policy.remote-start': { actions: ['policy.change'], segments: ['允许其他设备在这台电脑上新建会话'] },
  'policy.remote-agents': { actions: ['policy.change'], segments: ['允许其他设备使用更多 Agent'] },
  'policy.remote-projects': { actions: ['policy.change'], segments: ['允许其他设备使用更多项目'] },
  'policy.several': { actions: ['policy.change'], segments: ['放宽本机安全策略：', { slot: 'count', max: 4 }, ' 项更改'] },
  'start.first': { actions: ['task.start-l3'], segments: ['首次以完全访问启动 ', HARNESS, PROJECT, FOLDER, '：', ...COMMAND] },
  'start.first-custom': {
    actions: ['task.start-l3'],
    segments: ['首次以完全访问启动 ', HARNESS, PROJECT, FOLDER, '：自定义命令 ', ...COMMAND],
  },
  'start.changed': { actions: ['task.start-l3'], segments: ['以完全访问启动 ', HARNESS, PROJECT, FOLDER, '，命令已变化：', ...COMMAND] },
  'start.changed-custom': {
    actions: ['task.start-l3'],
    segments: ['以完全访问启动 ', HARNESS, PROJECT, FOLDER, '，命令已变化：自定义命令 ', ...COMMAND],
  },
  'start.project-config': {
    actions: ['task.start-l3'],
    segments: ['开启完全访问会话：', HARNESS, PROJECT, FOLDER, '，项目配置与以前启动时不同'],
  },
  'start.first-plugin': {
    actions: ['task.start-l3'],
    segments: ['首次以完全访问启动 ', HARNESS, PROJECT, FOLDER, '：插件 ', { slot: 'plugin', max: 40 }],
  },
  'start.changed-plugin': {
    actions: ['task.start-l3'],
    segments: ['以完全访问启动 ', HARNESS, PROJECT, FOLDER, '，插件已变化：', { slot: 'plugin', max: 40 }],
  },
  'start.repeat': { actions: ['task.start-l3'], segments: ['开启完全访问会话：', HARNESS, PROJECT, FOLDER] },
  'mode.widen': {
    actions: ['task.mode-widen'],
    segments: ['把会话「', { slot: 'session', max: 20 }, '」的权限模式放宽到 ', { slot: 'mode', max: 24 }],
  },
  'device.enroll-native': {
    actions: ['device.enroll-native'],
    segments: ['配对原生设备「', { slot: 'device', max: 20 }, '」，已在此 Mac 输入手机核对码，指纹 ', { slot: 'fingerprint', max: 24 }],
  },
  'device.enroll': {
    actions: ['device.enroll'],
    segments: ['允许指纹 ', { slot: 'fingerprint', max: 24 }, ' 的新设备「', { slot: 'device', max: 20 }, '」连接'],
  },
  'device.grant': {
    actions: ['device.grant'],
    segments: ['为设备「', { slot: 'device', max: 20 }, '」增加权限：', { slot: 'change', max: 40 }],
  },
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' })

function clip(text: string, max: number, keepEnd: boolean): { text: string; cut: boolean } {
  const clusters = Array.from(graphemes.segment(text), part => part.segment)
  if (clusters.length <= max) return { text, cut: false }
  const kept = keepEnd ? clusters.slice(clusters.length - (max - 1)) : clusters.slice(0, max - 1)
  return { text: keepEnd ? `…${kept.join('')}` : `${kept.join('')}…`, cut: true }
}

function invalid(): AppError {
  return new AppError(500, 'preview-invalid', '确认内容无效')
}

/** The slot names a form fills, in order. */
export function reasonSlots(form: PresenceReasonForm): string[] {
  return REASON_FORMS[form].segments.flatMap(segment => (typeof segment === 'object' && 'slot' in segment ? [segment.slot] : []))
}

/**
 * The sentence the macOS system sheet shows for a confirmation. The helper rebuilds it from the same subject and
 * refuses the confirmation on any byte difference, so what Touch ID approves is always this fixed wording.
 */
export function presenceReason(action: PresenceAction, subject: PresenceSubject): string {
  const form = Object.hasOwn(REASON_FORMS, subject.form) ? REASON_FORMS[subject.form] : undefined
  if (!form || !form.actions.includes(action)) throw invalid()
  const names = reasonSlots(subject.form)
  const given = Object.keys(subject.slots)
  if (given.length !== names.length || !names.every(name => Object.hasOwn(subject.slots, name))) throw invalid()
  const cut = new Set<string>()
  let reason = ''
  for (const segment of form.segments) {
    if (typeof segment === 'string') {
      reason += segment
    } else if ('slot' in segment) {
      const value = subject.slots[segment.slot]
      if (typeof value !== 'string' || (value === '' && segment.lead === undefined)) throw invalid()
      if (value === '') continue
      const clipped = clip(escapeSecurityText(value), segment.max, segment.keep === 'end')
      if (clipped.cut) cut.add(segment.slot)
      reason += `${segment.lead ?? ''}${clipped.text}${segment.trail ?? ''}`
    } else if (segment.cut.some(name => cut.has(name))) {
      reason += segment.text
    }
  }
  return reason
}

// ---- Subjects ---------------------------------------------------------------------------------

const SAFE_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/u

/** The `program` slot: an executable's absolute path, with the home directory written as ~. */
export function programText(path: string, home: string = homedir()): string {
  if (home && home !== '/' && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`
  return path
}

/** The `args` slot: each argument as written, quoted as JSON unless it is plainly one word; empty without any. */
export function argumentsText(args: readonly string[]): string {
  return args.map(arg => (SAFE_ARGUMENT.test(arg) ? arg : JSON.stringify(arg))).join(' ')
}

/**
 * The `input` slot of a tool approval: the model's arguments as canonical JSON (one line: JSON escapes line breaks), or
 * the raw text when they do not parse; empty for a call without arguments.
 */
export function toolInputText(args: Readonly<Record<string, unknown>> | undefined, raw: string | undefined): string {
  if (args === undefined) return raw ?? ''
  return Object.keys(args).length === 0 ? '' : canonicalJson(args)
}

/** The `env` slot: the variable names a definition sets, sorted; empty when it sets none. */
export function envNamesText(env: Readonly<Record<string, string>> | readonly string[]): string {
  return [...(Array.isArray(env) ? env : Object.keys(env))].sort().join('、')
}

const LEVEL_TITLES: Record<PermissionLevel, string> = { L0: '只读', L1: '逐项询问', L2: '自动编辑', L3: '完全访问' }

/** What a raising policy change grants, as one sentence when it is a single kind of change. */
export function policySubject(previous: Policy, next: Policy): PresenceSubject {
  const paths = policyDiff(previous, next).map(line => line.path)
  const only = (...allowed: string[]) => paths.length > 0 && paths.every(path => allowed.includes(path))
  if (only('hostEgressAllow')) {
    const added = next.hostEgressAllow.filter(entry => !previous.hostEgressAllow.includes(entry))
    if (added.length === 1) return { form: 'policy.egress', slots: { target: added[0]! } }
    if (added.length > 1) return { form: 'policy.egress-many', slots: { count: String(added.length) } }
  }
  if (only('local.maxLevel', 'local.allowL3')) {
    const raisedToFull = next.local.allowL3 && !previous.local.allowL3
    return { form: 'policy.local', slots: { level: LEVEL_TITLES[raisedToFull ? 'L3' : next.local.maxLevel] } }
  }
  if (only('remote.maxLevel')) return { form: 'policy.remote', slots: { level: LEVEL_TITLES[next.remote.maxLevel] } }
  if (only('remote.allowRemoteStart')) return { form: 'policy.remote-start', slots: {} }
  if (only('remote.harnesses')) return { form: 'policy.remote-agents', slots: {} }
  if (only('remote.workspaces')) return { form: 'policy.remote-projects', slots: {} }
  return { form: 'policy.several', slots: { count: String(paths.length) } }
}
