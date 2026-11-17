import {
  escapeSecurityText,
  isNativeListener,
  type ListenerClass,
  type PresenceAction,
  type PresenceReasonForm,
  type PresenceSubject,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { policyDiff, type Policy } from './policy.ts'

/**
 * A literal, or a slot: escaped and cut to `max` grapheme clusters with 「…」 (at its start for `keep: 'end'`, so a host
 * name keeps its domain). A slot must have text.
 */
type Segment = string | { slot: string; max: number; keep?: 'end' }

interface ReasonForm {
  actions: readonly PresenceAction[]
  segments: readonly Segment[]
}

const DEVICE = { slot: 'device', max: 20 } as const
const COUNT = { slot: 'count', max: 4 } as const
const DEVICE_CONNECTS = ['允许「', DEVICE, '」连接这台 Mac'] as const

/**
 * The fixed wording of every reason; the macOS helper holds the same table (`reasonForms` in LatchPresence.swift) and
 * the shared vectors pin both. Each sentence completes the system sheet's 「“Latch”正在尝试…」 and every slot has its own
 * length, so text a device, an admin, a model or an agent chose cannot push the Host's facts out; fixed text is never
 * cut. Any change to a fixed part changes the helper's signature and needs `pnpm latch presence repin`.
 */
export const REASON_FORMS: Readonly<Record<PresenceReasonForm, ReasonForm>> = {
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
  'policy.several': { actions: ['policy.change'], segments: ['放宽这台 Mac 的安全设置：', COUNT, ' 项更改'] },
  'plugin.package.apply': { actions: ['plugin.package.apply'], segments: ['应用插件「', { slot: 'plugin', max: 24 }, '」'] },
  /**
   * A package with pages, whenever their capabilities need the confirmation: what they may do is on the sheet itself.
   * The Host writes the capabilities slot (`capabilitySummary`), never longer than its limit, so it is never cut. The
   * list comes first: whatever a plugin's name says can only follow the real one.
   */
  'plugin.package.apply-pages': {
    actions: ['plugin.package.apply'],
    segments: ['让插件页面可以：', { slot: 'capabilities', max: 48 }, '（插件「', { slot: 'plugin', max: 16 }, '」）'],
  },
  /**
   * The absolute path the Host found for a local MCP server's command, before the name a person chose, so the name can
   * only follow the real program. The path keeps its end: the program's own name.
   */
  'mcp.server.apply': {
    actions: ['mcp.server.apply'],
    segments: ['让 Agent 运行 ', { slot: 'command', max: 40, keep: 'end' }, '（MCP 服务器「', { slot: 'server', max: 16 }, '」）'],
  },
  /**
   * The same for a package runner or an interpreter (`npx`, `uvx`, `node`, `python` …): the package or script its first
   * argument names follows the program, so the sheet says what really runs.
   */
  'mcp.server.apply-runner': {
    actions: ['mcp.server.apply'],
    segments: [
      '让 Agent 运行 ',
      { slot: 'command', max: 12, keep: 'end' },
      ' ',
      { slot: 'target', max: 32 },
      '（',
      { slot: 'hash', max: 4 },
      '，MCP「',
      { slot: 'server', max: 10 },
      '」）',
    ],
  },
  /**
   * A remote MCP server: the `host:port` the Host will connect to with the server's request headers, before the name a
   * person chose. Like a model service's address, it keeps its end: the domain.
   */
  'mcp.server.apply-remote': {
    actions: ['mcp.server.apply'],
    segments: ['让 Latch 连接 ', { slot: 'target', max: 40, keep: 'end' }, '（MCP 服务器「', { slot: 'server', max: 16 }, '」）'],
  },
  /**
   * Adding a relay of either kind: its first address keeps its end (the domain), then how many addresses the Host will
   * dial for it and the short hash of the key it must prove (`relayKeyHash`), so a page cannot slip in more addresses or
   * another key under a harmless-looking sheet.
   */
  'relay.add': {
    actions: ['policy.change'],
    segments: ['添加中继 ', { slot: 'target', max: 32, keep: 'end' }, '（', COUNT, ' 个地址，密钥 ', { slot: 'hash', max: 8 }, '）'],
  },
  /** The same for a Harness definition: the command as the Host resolved it, then the definition's name. */
  'harness.command.apply': {
    actions: ['harness.command.apply'],
    segments: ['让 Harness 运行 ', { slot: 'command', max: 40, keep: 'end' }, '（「', { slot: 'harness', max: 16 }, '」）'],
  },
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
 * A slot's text cut in its middle to `max` grapheme clusters (escaped first), so both ends of a long package name or
 * path stay on the sheet: `@modelcon…/server-github`. The Host fills the slot with it, so the sheet never cuts it again.
 */
export function middleSlot(text: string, max: number): string {
  const clusters = Array.from(graphemes.segment(escapeSecurityText(text)), part => part.segment)
  if (clusters.length <= max) return clusters.join('')
  const head = Math.floor((max - 1) / 2)
  return `${clusters.slice(0, head).join('')}…${clusters.slice(clusters.length - (max - 1 - head)).join('')}`
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
    if (typeof value !== 'string' || value === '') throw invalid()
    reason += clip(escapeSecurityText(value), segment.max, segment.keep === 'end')
  }
  return reason
}

// ---- Subjects ---------------------------------------------------------------------------------

/**
 * Who asks to enroll, as the sheet names them: by the name the device gave, on every listener. A loopback peer may arrive
 * through a forwarded port, so the sheet never says where it is.
 */
export function enrollmentSubject(listener: ListenerClass, name: string): PresenceSubject {
  return { form: isNativeListener(listener) ? 'device.enroll-native' : 'device.enroll-named', slots: { device: name } }
}

/** What a raising policy change grants, as one sentence when it is a single kind of change. */
export function policySubject(previous: Policy, next: Policy): PresenceSubject {
  const paths = policyDiff(previous, next).map(line => line.path)
  const only = (...allowed: string[]) => paths.length > 0 && paths.every(path => allowed.includes(path))
  if (only('hostEgressAllow')) {
    const added = next.hostEgressAllow.filter(entry => !previous.hostEgressAllow.includes(entry))
    if (added.length === 1) return { form: 'origin.confirm', slots: { target: added[0]! } }
    if (added.length > 1) return { form: 'policy.egress-many', slots: { count: String(added.length) } }
  }
  return { form: 'policy.several', slots: { count: String(paths.length) } }
}
