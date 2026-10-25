import type { PermissionLevel } from '@latch/protocol'
import { api, auditFailed, ClientError } from './api.ts'
import { withConfirmation } from './confirmations.ts'

/**
 * The Host's permission ceilings as Settings › 电脑 shows and changes them through `PATCH /link/api/policy`. Display
 * only: the Host decides again whether a change lowers (any admin device) or raises (the desktop app on host.sock plus
 * a local confirmation), and refuses everything else.
 */

/** The levels a ceiling stores; 完全访问 is the separate switch `local.allowL3`. */
export type StandardLevel = 'L0' | 'L1' | 'L2'

/** The parts of `GET /link/api/policy` this page reads and writes. */
export interface PolicyView {
  local: { maxLevel: StandardLevel; allowL3: boolean }
  remote: { maxLevel: StandardLevel; allowRemoteStart: boolean; harnesses: string[] | null; workspaces: string[] | null }
  hostEgressAllow: string[]
  /** Model-service addresses confirmed on this computer; absent from Hosts before confirmed addresses. */
  confirmedAddresses?: string[]
}

/** The body of `PATCH /link/api/policy`: only the fields that change. */
export interface PolicyPatch {
  local?: { maxLevel?: StandardLevel; allowL3?: boolean }
  remote?: { maxLevel?: StandardLevel; allowRemoteStart?: boolean; harnesses?: string[] | null; workspaces?: string[] | null }
  hostEgressAllow?: { add?: string[]; remove?: string[] }
  /** Removing only: an address is confirmed by saving a model service there. */
  confirmedAddresses?: { remove: string[] }
}

export type RemoteList = 'harnesses' | 'workspaces'

const RANK: Record<PermissionLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 }
const isStandard = (value: unknown): value is StandardLevel => value === 'L0' || value === 'L1' || value === 'L2'
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isList = (value: unknown): value is string[] | null =>
  value === null || (Array.isArray(value) && value.every(item => typeof item === 'string'))

/** Reads the response's `policy`; anything that does not have the fields this page needs is null. */
export function parsePolicy(value: unknown): PolicyView | null {
  if (!isRecord(value)) return null
  const { local: l, remote: r, hostEgressAllow, confirmedAddresses } = value
  if (!isRecord(l) || !isRecord(r)) return null
  if (!isStandard(l.maxLevel) || typeof l.allowL3 !== 'boolean') return null
  if (!isStandard(r.maxLevel) || typeof r.allowRemoteStart !== 'boolean' || !isList(r.harnesses) || !isList(r.workspaces)) return null
  if (!Array.isArray(hostEgressAllow) || !hostEgressAllow.every(item => typeof item === 'string')) return null
  const origins =
    Array.isArray(confirmedAddresses) && confirmedAddresses.every(item => typeof item === 'string') ? [...confirmedAddresses] : undefined
  return {
    local: { maxLevel: l.maxLevel, allowL3: l.allowL3 },
    remote: {
      maxLevel: r.maxLevel,
      allowRemoteStart: r.allowRemoteStart,
      harnesses: r.harnesses === null ? null : [...r.harnesses],
      workspaces: r.workspaces === null ? null : [...r.workspaces],
    },
    hostEgressAllow: [...hostEgressAllow],
    ...(origins ? { confirmedAddresses: origins } : {}),
  }
}

/**
 * 在这台电脑上发起 is one ladder over two stored fields: 完全访问 while full-access sessions are allowed, otherwise
 * the built-in harness's ceiling.
 */
export function localLadder(local: PolicyView['local']): PermissionLevel {
  return local.allowL3 ? 'L3' : local.maxLevel
}

/**
 * One request, and so one confirmation, for both fields: 完全访问 allows full-access sessions and keeps the built-in
 * harness at no less than 逐项询问; any lower step turns full access off and sets the built-in ceiling.
 */
export function localLadderPatch(local: PolicyView['local'], chosen: PermissionLevel): PolicyPatch {
  if (chosen === 'L3') return { local: { maxLevel: RANK[local.maxLevel] >= RANK.L1 ? local.maxLevel : 'L1', allowL3: true } }
  return { local: { maxLevel: chosen, allowL3: false } }
}

/** 从手机和其他电脑发起 never reaches 完全访问: full-access sessions start only in the desktop app. */
export function remoteLadderPatch(chosen: StandardLevel): PolicyPatch {
  return { remote: { maxLevel: chosen } }
}

/** All harnesses or projects (null, which includes ones added later), or exactly the listed IDs. */
export function remoteListPatch(field: RemoteList, value: string[] | null): PolicyPatch {
  return { remote: { [field]: value === null ? null : [...new Set(value)] } }
}

/** Adds or removes one ID from a listed set; with every ID allowed (null) the caller turns that off first. */
export function toggledList(current: string[], id: string, included: boolean): string[] {
  return included ? [...new Set([...current, id])] : current.filter(item => item !== id)
}

/** The policy after the patch, as the Host applies it (the egress list removes first, then adds). */
export function applyPatch(policy: PolicyView, patch: PolicyPatch): PolicyView {
  const next: PolicyView = {
    local: { ...policy.local, ...patch.local },
    remote: { ...policy.remote, ...patch.remote },
    hostEgressAllow: [...policy.hostEgressAllow],
    ...(policy.confirmedAddresses ? { confirmedAddresses: [...policy.confirmedAddresses] } : {}),
  }
  if (patch.confirmedAddresses && next.confirmedAddresses) {
    const removed = new Set(patch.confirmedAddresses.remove)
    next.confirmedAddresses = next.confirmedAddresses.filter(origin => !removed.has(origin))
  }
  if (patch.hostEgressAllow) {
    const removed = new Set(patch.hostEgressAllow.remove ?? [])
    next.hostEgressAllow = [
      ...new Set([...next.hostEgressAllow.filter(entry => !removed.has(entry)), ...(patch.hostEgressAllow.add ?? [])]),
    ]
  }
  return next
}

const subset = (next: readonly string[], previous: readonly string[]) => next.every(item => previous.includes(item))
/** null allows everything, so a list is narrower than null and null is never narrower than a list. */
const narrower = (previous: string[] | null, next: string[] | null) =>
  next === null ? previous === null : previous === null || subset(next, previous)

/**
 * Whether the patch widens anything, as the Host judges it: a raised level, full access or remote starts turned on, a
 * list that gains an ID or becomes unrestricted, or an added egress entry. Widening needs the desktop app and a local
 * confirmation; a patch that only narrows works from any admin device.
 */
export function widens(policy: PolicyView, patch: PolicyPatch): boolean {
  const next = applyPatch(policy, patch)
  return (
    RANK[next.local.maxLevel] > RANK[policy.local.maxLevel]
    || (next.local.allowL3 && !policy.local.allowL3)
    || RANK[next.remote.maxLevel] > RANK[policy.remote.maxLevel]
    || (next.remote.allowRemoteStart && !policy.remote.allowRemoteStart)
    || !narrower(policy.remote.harnesses, next.remote.harnesses)
    || !narrower(policy.remote.workspaces, next.remote.workspaces)
    || !subset(next.hostEgressAllow, policy.hostEgressAllow)
    || !subset(next.confirmedAddresses ?? [], policy.confirmedAddresses ?? [])
  )
}

/** Exact `host:port` as the Host accepts it: a lowercase host name or IPv4, a bracketed IPv6, an explicit port. */
export function isEgressTarget(value: string): boolean {
  if (value.length < 3 || value.length > 260) return false
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):([1-9][0-9]{0,4})$/u.exec(value)
  if (!match || Number(match[2]) > 65_535) return false
  const host = match[1] ?? ''
  if (host.startsWith('[')) return host.length > 2 && host.includes(':')
  return host.length <= 253 && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
}

/** Lowercase and trimmed, as the Host stores it. */
export const normalizeEgressTarget = (value: string) => value.trim().toLowerCase()

// ---- Requests ------------------------------------------------------------------------------------------------------

export interface PolicyState {
  policy: PolicyView
  /** Set after a change the Host applied without writing its audit log (`x-latch-audit: failed`). */
  auditFailed: boolean
}

function policyOf(body: unknown): PolicyView {
  const policy = isRecord(body) ? parsePolicy(body.policy) : null
  if (policy === null) throw new ClientError('执行端返回的安全策略无法识别，请刷新后重试。', 'policy-unreadable')
  return policy
}

/** `GET /link/api/policy` (needs 管理此 Host). */
export async function readPolicy(): Promise<PolicyView> {
  return policyOf(await api<unknown>('policy'))
}

/**
 * Sends one change. A raise comes back as `stepup-required` and goes through the local confirmation, which resends
 * the identical body; a lowering applies at once.
 */
export async function changePolicy(patch: PolicyPatch): Promise<PolicyState> {
  let failed = false
  const body = await withConfirmation(confirmation =>
    api<unknown>('policy', {
      method: 'PATCH',
      body: patch,
      ...(confirmation ? { confirmation } : {}),
      onHeaders: headers => {
        failed = auditFailed(headers)
      },
    }),
  )
  return { policy: policyOf(body), auditFailed: failed }
}

// ---- Copy ----------------------------------------------------------------------------------------------------------

export const LEVEL_TITLES: Record<PermissionLevel, string> = { L0: '只读', L1: '逐项询问', L2: '自动编辑', L3: '完全访问' }

/** What each step of a ceiling allows, in one line. 自动编辑 has no behaviour of its own yet, and says so. */
export const LEVEL_EFFECTS: Record<PermissionLevel, string> = {
  L0: '只能查看、拒绝和停止会话',
  L1: '改文件、运行命令前先问你',
  L2: '尚未实现，目前按逐项询问执行',
  L3: '允许 Agent 成员不经询问改动整台电脑',
}

export const CEILING_COPY = {
  localTitle: '在这台电脑上发起',
  localScope: '在这台电脑上发起的会话',
  /** Full access allowed: each full-access session is still confirmed on its own when it starts. */
  localNote: '在 Latch 桌面端发起；每个完全访问的会话仍要单独确认',
  /** Full access off: the agents (all full access) cannot start here. */
  agentsBlocked: 'Agent 成员（完全访问）不能在这台电脑上发起会话',
  /** 只读 with full access off: nothing can start, only what runs can be looked at, rejected and stopped. */
  viewOnly: '只能查看、拒绝和停止会话',
  remoteTitle: '从手机和其他电脑发起',
  remoteScope: '从手机和其他电脑发起的会话',
  remoteNote: '也包括这台电脑上的浏览器',
  /** Shown under a stored 自动编辑, which runs like 逐项询问 today. */
  automaticNote: '自动编辑尚未实现，目前按逐项询问执行',
  /** Full access is allowed while the built-in ceiling stays 只读 (possible only by editing the file). */
  builtinBlocked: '完全访问已允许；Latch 内置会话的上限为只读，不能发起',
  remoteFullAccess: '完全访问会话只能在这台电脑的 Latch 桌面端发起',
  raiseHere: '调高要在这台电脑上验证身份',
  raiseOnDesktop: '只能在这台电脑的 Latch 桌面端调高',
  turnOnOnDesktop: '只能在这台电脑的 Latch 桌面端开启',
  addOnDesktop: '只能在这台电脑的 Latch 桌面端添加',
  presenceMissing: '本机确认不可用，不能在这里调高',
  caption: '调高上限要在这台电脑上的 Latch 桌面端验证身份。高风险操作只能在这台电脑上批准。',
  /** Under a list page: what adding to it takes. */
  listCaption: '加入 Agent 或改为全部要在这台电脑的 Latch 桌面端验证身份',
  listCaptionProjects: '加入项目或改为全部要在这台电脑的 Latch 桌面端验证身份',
  readOnly: '只有能管理此 Host 的设备可以修改上限。',
  remoteStartTitle: '允许其他设备在这里新建会话',
  remoteStartNote: '关闭后只能查看、批准或停止已有会话',
  harnessesTitle: '其他设备可用的 Agent',
  workspacesTitle: '其他设备可用的项目',
  /** Under those two headings: who the lists hold back (a browser on loopback is one of them, as in remoteNote). */
  harnessesNote:
    '手机、这台电脑上的浏览器和其他电脑只能用这里允许的 Agent 发起或继续会话。完全访问的会话只能在这台电脑的 Latch 桌面端发起。',
  workspacesNote: '手机、这台电脑上的浏览器和其他电脑只能在这里允许的项目中发起或继续会话。',
} as const

/**
 * The consequence of 在这台电脑上发起 as the Host stores it, in one sentence. Full access allowed: each full-access
 * session is still confirmed when it starts (or, under 只读, only agents can start). Full access off: agents cannot
 * start here, and under 只读 nothing can; a stored 自动编辑 says that it runs as 逐项询问 too.
 */
export function localNote(local: PolicyView['local']): string {
  if (local.allowL3) return local.maxLevel === 'L0' ? CEILING_COPY.builtinBlocked : CEILING_COPY.localNote
  if (local.maxLevel === 'L0') return CEILING_COPY.viewOnly
  if (local.maxLevel === 'L2') return `${CEILING_COPY.automaticNote}；${CEILING_COPY.agentsBlocked}`
  return CEILING_COPY.agentsBlocked
}

/** The consequence of 从手机和其他电脑发起: who it covers, what 只读 leaves, or that 自动编辑 runs as 逐项询问. */
export function remoteNote(level: StandardLevel): string {
  if (level === 'L0') return `${CEILING_COPY.viewOnly}；${CEILING_COPY.remoteNote}`
  if (level === 'L2') return CEILING_COPY.automaticNote
  return CEILING_COPY.remoteNote
}
