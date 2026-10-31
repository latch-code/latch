import { homedir } from 'node:os'
import {
  escapeSecurityText,
  isNativeListener,
  type ListenerClass,
  type PermissionLevel,
  type PresenceAction,
  type PresenceReasonForm,
  type PresenceSubject,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson } from '@latch/core/node-kit'
import { policyDiff, type Policy } from './policy.ts'

/**
 * A literal, or a slot: escaped and cut to `max` grapheme clusters with 「…」 (at its start for `keep: 'end'`, so a path
 * keeps its file name and a host name its domain). A slot with a `lead` may be empty, and then neither it, its lead nor
 * its `trail` appears; every other slot must have text.
 */
type Segment = string | { slot: string; max: number; keep?: 'end'; lead?: string; trail?: string }

interface ReasonForm {
  actions: readonly PresenceAction[]
  segments: readonly Segment[]
}

const AGENT = { slot: 'agent', max: 16 } as const
/**
 * The saved project a session starts in, as a note: it names where the agent starts, never a limit on what it may reach.
 * A session without one leaves the note out.
 */
const PROJECT_NOTE = { slot: 'project', max: 16, lead: '（项目「', trail: '」）' } as const
const CHANGED_NOTE = { slot: 'project', max: 16, lead: '，项目「', trail: '」' } as const
/**
 * What a start runs: the resolved executable's absolute path (home as ~, keeping its end), or 插件 <id>@<version> for a
 * third-party plugin harness; then its arguments, and the names of the variables its definition sets, never their values.
 */
const COMMAND = [
  { slot: 'program', max: 52, keep: 'end' },
  { slot: 'args', max: 24, lead: ' ' },
  { slot: 'env', max: 24, lead: '，另设 ' },
] as const
const FULL_ACCESS = '读写这台 Mac 上的文件并运行命令'
/** A permission mode by the agent's own name for it. */
const MODE = { slot: 'mode', max: 24 } as const
const DEVICE = { slot: 'device', max: 20 } as const
const NAME = { slot: 'name', max: 20 } as const
const COUNT = { slot: 'count', max: 4 } as const
const LEVEL = { slot: 'level', max: 8 } as const
const DEVICE_CONNECTS = ['允许「', DEVICE, '」连接这台 Mac'] as const

/**
 * The fixed wording of every reason; the macOS helper holds the same table (`reasonForms` in LatchPresence.swift) and
 * the shared vectors pin both. Each sentence completes the system sheet's 「“Latch”正在尝试…」 and every slot has its own
 * length, so text a device, an admin, a model or an agent chose cannot push the Host's facts out; fixed text is never
 * cut. Any change to a fixed part changes the helper's signature and needs `pnpm latch presence repin`: what can change
 * without one (a mode's or a tool's name, a project's) is slot text the Host fills in.
 */
export const REASON_FORMS: Readonly<Record<PresenceReasonForm, ReasonForm>> = {
  'approval.write': { actions: ['approval.r2'], segments: ['允许写入 ', { slot: 'path', max: 40, keep: 'end' }] },
  'approval.tool': { actions: ['approval.r2'], segments: ['允许运行 ', { slot: 'tool', max: 24 }, { slot: 'input', max: 40, lead: '：' }] },
  'start.first': { actions: ['task.start-l3'], segments: ['允许 ', AGENT, ` ${FULL_ACCESS}`, PROJECT_NOTE, '：', ...COMMAND] },
  'start.first-mode': {
    actions: ['task.start-l3'],
    segments: ['允许 ', AGENT, ' 以「', MODE, `」${FULL_ACCESS}`, PROJECT_NOTE, '：', ...COMMAND],
  },
  'start.changed': {
    actions: ['task.start-l3'],
    segments: ['再次允许 ', AGENT, ` ${FULL_ACCESS}（启动方式已变化`, CHANGED_NOTE, '）：', ...COMMAND],
  },
  'start.changed-mode': {
    actions: ['task.start-l3'],
    segments: ['再次允许 ', AGENT, ' 以「', MODE, `」${FULL_ACCESS}（启动方式已变化`, CHANGED_NOTE, '）：', ...COMMAND],
  },
  'mode.widen': { actions: ['task.mode-widen'], segments: ['允许「', { slot: 'session', max: 20 }, '」改用「', MODE, '」'] },
  /** A wider mode chosen before the session exists, for a start that needs no confirmation of its own. */
  'mode.widen-draft': { actions: ['task.mode-widen'], segments: ['允许 ', AGENT, ' 改用「', MODE, '」', PROJECT_NOTE] },
  'agent.probe': { actions: ['agent.probe'], segments: ['试运行 ', AGENT, '，不发送内容'] },
  'automation.grant': { actions: ['automation.grant'], segments: ['允许自动化「', NAME, '」按时用 ', AGENT, ` ${FULL_ACCESS}`] },
  /** A device that is not pairing as a phone, by the name it gave: the desktop app, a browser on any listener. */
  'device.enroll-named': { actions: ['device.enroll'], segments: DEVICE_CONNECTS },
  'device.enroll-native': { actions: ['device.enroll-native'], segments: DEVICE_CONNECTS },
  'device.grant': { actions: ['device.grant'], segments: ['为「', DEVICE, '」增加权限：', { slot: 'change', max: 40 }] },
  /** A model-service address, or one address a policy change adds: either way Latch may then connect to it. */
  'origin.confirm': {
    actions: ['provider.confirm-origin', 'policy.change'],
    segments: ['允许 Latch 连接 ', { slot: 'target', max: 48, keep: 'end' }],
  },
  'policy.egress-many': { actions: ['policy.change'], segments: ['允许 Latch 连接 ', COUNT, ' 个新地址'] },
  'policy.remote-start': { actions: ['policy.change'], segments: ['允许手机和浏览器在这台 Mac 上开始新会话'] },
  'policy.relay': { actions: ['policy.change'], segments: ['允许 Latch 使用中继「', { slot: 'relay', max: 24 }, '」'] },
  'policy.feishu': { actions: ['policy.change'], segments: ['允许飞书用户「', NAME, '」使用这台 Mac 上的 Latch'] },
  'policy.local': { actions: ['policy.change'], segments: ['把在这台 Mac 上开始的会话上限放宽到', LEVEL] },
  'policy.remote': { actions: ['policy.change'], segments: ['把从手机和浏览器开始的会话上限放宽到', LEVEL] },
  'policy.remote-agents': { actions: ['policy.change'], segments: ['允许手机和浏览器使用更多 Agent'] },
  'policy.remote-projects': { actions: ['policy.change'], segments: ['允许手机和浏览器使用更多项目'] },
  'policy.several': { actions: ['policy.change'], segments: ['放宽这台 Mac 的安全设置：', COUNT, ' 项更改'] },
  'plugin.package.apply': { actions: ['plugin.package.apply'], segments: ['应用插件「', { slot: 'plugin', max: 24 }, '」'] },
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' })

function clip(text: string, max: number, keepEnd: boolean): string {
  const clusters = Array.from(graphemes.segment(text), part => part.segment)
  if (clusters.length <= max) return text
  const kept = keepEnd ? clusters.slice(clusters.length - (max - 1)) : clusters.slice(0, max - 1)
  return keepEnd ? `…${kept.join('')}` : `${kept.join('')}…`
}

function invalid(): AppError {
  return new AppError(500, 'preview-invalid', '确认内容无效')
}

function slotNames(form: ReasonForm): string[] {
  return form.segments.flatMap(segment => (typeof segment === 'object' ? [segment.slot] : []))
}

/** The slot names a form fills, in order. */
export function reasonSlots(form: PresenceReasonForm): string[] {
  return slotNames(REASON_FORMS[form])
}

/**
 * The sentence the macOS system sheet shows for a confirmation. The helper rebuilds it from the same subject and
 * refuses the confirmation on any byte difference, so what Touch ID approves is always this fixed wording.
 */
export function presenceReason(action: PresenceAction, subject: PresenceSubject): string {
  const form = Object.hasOwn(REASON_FORMS, subject.form) ? REASON_FORMS[subject.form] : undefined
  if (!form || !form.actions.includes(action)) throw invalid()
  const names = slotNames(form)
  const given = Object.keys(subject.slots)
  if (given.length !== names.length || !names.every(name => Object.hasOwn(subject.slots, name))) throw invalid()
  let reason = ''
  for (const segment of form.segments) {
    if (typeof segment === 'string') {
      reason += segment
      continue
    }
    const value = subject.slots[segment.slot]
    if (typeof value !== 'string' || (value === '' && segment.lead === undefined)) throw invalid()
    if (value === '') continue
    reason += `${segment.lead ?? ''}${clip(escapeSecurityText(value), segment.max, segment.keep === 'end')}${segment.trail ?? ''}`
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

/** The `env` slot: the variable names a definition sets, sorted; never their values. */
export function envNamesText(env: Readonly<Record<string, string>> | readonly string[]): string {
  return [...(Array.isArray(env) ? env : Object.keys(env))].sort().join('、')
}

/**
 * Who asks to enroll, as the sheet names them: by the name the device gave, on every listener. A loopback peer may arrive
 * through a forwarded port, so the sheet never says where it is.
 */
export function enrollmentSubject(listener: ListenerClass, name: string): PresenceSubject {
  return { form: isNativeListener(listener) ? 'device.enroll-native' : 'device.enroll-named', slots: { device: name } }
}

const LEVEL_TITLES: Record<PermissionLevel, string> = { L0: '只读', L1: '逐项询问', L2: '自动编辑', L3: '完全访问' }

/** What a raising policy change grants, as one sentence when it is a single kind of change. */
export function policySubject(previous: Policy, next: Policy): PresenceSubject {
  const paths = policyDiff(previous, next).map(line => line.path)
  const only = (...allowed: string[]) => paths.length > 0 && paths.every(path => allowed.includes(path))
  if (only('hostEgressAllow')) {
    const added = next.hostEgressAllow.filter(entry => !previous.hostEgressAllow.includes(entry))
    if (added.length === 1) return { form: 'origin.confirm', slots: { target: added[0]! } }
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
