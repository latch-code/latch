import { useEffect, useState } from 'react'
import { isLoopbackHost, type AttentionItem, type AttentionKind, type ComputerSession, type ComputerSummary } from '@latch/protocol'
import { shellComputers, type ComputersView } from './shell.ts'
import { currentLocale, defineCopy, formatNumber } from './i18n.ts'

const COPY = defineCopy(
  {
    online: '在线',
    connecting: '正在连接',
    lastSeen: (time: string) => `离线 · 上次在线 ${time}`,
    offline: '离线',
    updating: '正在更新',
    restarting: '正在重启',
    stopped: '已停止',
    sleeping: '已休眠',
    removed: '已被移除',
    wrongComputer: '不是这台电脑',
    certificateUntrusted: '证书不受信任',
    certificateChanged: '证书变了',
    outdated: '版本较旧',
    connected: '已连接',
    reconnecting: '正在重连',
    stale: (count: number) => `离线前 ${count} 项`,
    local: '这台 Mac',
    loopback: '回环 HTTP',
    approval: '审批',
    question: '问题',
    stuck: '没有动静',
    noProject: '无项目',
  },
  {
    online: 'Online',
    connecting: 'Connecting',
    lastSeen: (time: string) => `Offline · Last seen ${time}`,
    offline: 'Offline',
    updating: 'Updating',
    restarting: 'Restarting',
    stopped: 'Stopped',
    sleeping: 'Asleep',
    removed: 'Removed',
    wrongComputer: 'Wrong computer',
    certificateUntrusted: 'Certificate not trusted',
    certificateChanged: 'Certificate changed',
    outdated: 'Out of date',
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    stale: (count: number) => `${formatNumber(count)} before going offline`,
    local: 'This Mac',
    loopback: 'Loopback HTTP',
    approval: 'Approval',
    question: 'Question',
    stuck: 'No activity',
    noProject: 'No project',
  },
)

/** A state colour for the status words: the tones of `StatusWord` in @latch/ui. */
type Tone = 'neutral' | 'waiting' | 'running' | 'failed' | 'done' | 'warn'

/** A clock time, 10:42, or empty for a time that does not parse. */
export function clockTime(iso: string | undefined): string {
  const at = iso ? new Date(iso) : undefined
  return at && Number.isFinite(at.getTime())
    ? at.toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit', hour12: false })
    : ''
}

/** A computer's state in words and tone: amber where it waits for the person, red where the connection is not safe. */
export function computerState(computer: Pick<ComputerSummary, 'state' | 'reason' | 'lastSeenAt'>): { text: string; tone: Tone } {
  switch (computer.state) {
    case 'online':
      return { text: COPY.online, tone: 'neutral' }
    case 'connecting':
      return { text: COPY.connecting, tone: 'running' }
    case 'offline': {
      const seen = clockTime(computer.lastSeenAt)
      return { text: seen ? COPY.lastSeen(seen) : COPY.offline, tone: 'neutral' }
    }
    case 'stopping':
      return {
        text: computer.reason === 'update' ? COPY.updating : computer.reason === 'restart' ? COPY.restarting : COPY.stopped,
        tone: 'neutral',
      }
    case 'sleeping':
      return { text: COPY.sleeping, tone: 'neutral' }
    case 'revoked':
      return { text: COPY.removed, tone: 'warn' }
    case 'wrong-host':
      return { text: COPY.wrongComputer, tone: 'failed' }
    case 'cert-error':
      return { text: COPY.certificateUntrusted, tone: 'failed' }
    case 'cert-changed':
      return { text: COPY.certificateChanged, tone: 'warn' }
    case 'outdated':
      return { text: COPY.outdated, tone: 'warn' }
  }
}

/** This page's connection to its Host in a word, beside its live dot. */
export const CONNECTION_WORDS = {
  get connecting() {
    return COPY.connecting
  },
  get connected() {
    return COPY.connected
  },
  get reconnecting() {
    return COPY.reconnecting
  },
  get offline() {
    return COPY.offline
  },
} as const

/** One other computer in the computer popover: its state, what waits there, and whether its Latch is older. */
export interface OtherComputerRow {
  hostId: string
  name: string
  state: ComputerSummary['state']
  text: string
  count: number
  older: boolean
}

/**
 * The computers other than this page's own Host, in the list's order. A computer counts what waits there only while it
 * answers; one that went away says how much waited before it went. Versions compare against this Mac's Host, which only
 * this Mac's page knows (`reference`).
 */
export function otherComputerRows(
  view: ComputersView | undefined,
  hostId: string | undefined,
  reference: string | undefined,
): OtherComputerRow[] {
  if (!view) return []
  return view.computers.flatMap(computer => {
    if (computer.hostId === hostId) return []
    const live = computer.state === 'online'
    const waiting = computer.waiting?.length ?? 0
    const stale = !live && waiting > 0 ? COPY.stale(waiting) : undefined
    return [
      {
        hostId: computer.hostId,
        name: computer.local ? COPY.local : computer.name,
        state: computer.state,
        text: [computerState(computer).text, stale].filter(Boolean).join(' · '),
        count: live ? waiting : 0,
        older: !computer.local && olderVersion(computer.version, reference),
      },
    ]
  })
}

export function connectionTransport(
  location: Pick<Location, 'protocol' | 'hostname'>,
  { local, remote, hostId }: { local: boolean; remote: boolean; hostId: string | undefined },
): string {
  const { protocol, hostname } = location
  if (protocol === 'latch:') {
    if (local && hostname === 'app') return 'host.sock'
    return remote ? 'HTTPS' : ''
  }
  if (protocol === 'https:') return 'HTTPS'
  // The Host binds a dedicated localhost alias for this identity (apps/host/src/listeners.ts).
  const loopback = isLoopbackHost(hostname) || (hostId !== undefined && hostname === `h-${hostId}.localhost`)
  return protocol === 'http:' && loopback ? COPY.loopback : ''
}

/** The computers list of the desktop app, kept current by main's pushes; undefined outside it or until it arrives. */
export function useComputers(): ComputersView | undefined {
  const api = shellComputers()
  const [view, setView] = useState<ComputersView | undefined>()
  useEffect(() => {
    if (!api) return undefined
    let active = true
    void api
      .list()
      .then(next => {
        if (active && next) setView(next)
      })
      .catch(() => {})
    const stop = api.subscribe(next => {
      if (active) setView(next)
    })
    return () => {
      active = false
      stop()
    }
  }, [api])
  return view
}

/** What waits on one other computer, for 等你处理: live while it answers, otherwise what waited before it went. */
export interface OtherWaiting {
  computer: ComputerSummary
  items: AttentionItem[]
  live: boolean
}

/** The other computers with something waiting, in the list's order; this page's own Host is never one of them. */
export function otherWaiting(view: ComputersView | undefined, hostId: string | undefined): OtherWaiting[] {
  if (!view) return []
  return view.computers.flatMap(computer =>
    computer.local || computer.hostId === hostId || !computer.waiting?.length
      ? []
      : [{ computer, items: computer.waiting, live: computer.state === 'online' }],
  )
}

export const ATTENTION_WORDS: Record<AttentionKind, string> = {
  get approval() {
    return COPY.approval
  },
  get question() {
    return COPY.question
  },
  get stuck() {
    return COPY.stuck
  },
}

/** Whether version `a` is older than `b` (x.y.z, a pre-release before its release); unknown versions are not. */
export function olderVersion(a: string | undefined, b: string | undefined): boolean {
  const parse = (value: string | undefined) => {
    const match = value ? /^(\d+)\.(\d+)\.(\d+)(-.+)?$/u.exec(value) : null
    return match ? { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] !== undefined } : undefined
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return false
  for (let index = 0; index < 3; index++) {
    const difference = left.parts[index]! - right.parts[index]!
    if (difference !== 0) return difference < 0
  }
  return left.pre && !right.pre
}

/** One project of another computer in the unified list, with its sessions newest first; `id` null for 无项目. */
export interface OtherProject {
  id: string | null
  name: string
  sessions: ComputerSession[]
}
/** Another computer's part of the unified list: its sessions by project, live only while it answers. */
export interface OtherComputerList {
  hostId: string
  name: string
  state: ComputerSummary['state']
  /** 在线, or how it stands when it does not answer (离线 · 上次在线 10:42). */
  stateText: string
  /** What it lists answers now; otherwise these are the rows main read before it went. */
  live: boolean
  projects: OtherProject[]
  count: number
  /** Main keeps only the newest sessions of a computer; the rest are on that computer. */
  capped: boolean
}

/** How many sessions of one computer main keeps for the list (`SESSION_LIMIT` in apps/desktop/src/notifications.cjs). */
export const COMPUTER_SESSION_LIMIT = 60

/**
 * The unified list's other computers, in the list's order: each one's own sessions, composed here from what main read
 * from that computer alone. This page's own Host is never one of them, and nothing of one computer goes to another.
 * A computer whose sessions main never read (it has not answered since the app started) still has its row, empty.
 */
export function otherComputerLists(view: ComputersView | undefined, hostId: string | undefined): OtherComputerList[] {
  if (!view) return []
  return view.computers.flatMap(computer => {
    if (computer.local || computer.hostId === hostId) return []
    const sessions = computer.sessions ?? []
    const byProject = new Map<string, OtherProject>()
    for (const session of sessions) {
      const key = session.project ? `p:${session.project.id}` : 'none'
      let project = byProject.get(key)
      if (!project) {
        project = { id: session.project?.id ?? null, name: session.project?.name ?? COPY.noProject, sessions: [] }
        byProject.set(key, project)
      }
      project.sessions.push(session)
    }
    for (const project of byProject.values()) project.sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    // Projects by their newest session; 无项目 last, as on the computer's own page.
    const projects = [...byProject.values()].sort(
      (a, b) =>
        Number(a.id === null) - Number(b.id === null) || Date.parse(b.sessions[0]!.updatedAt) - Date.parse(a.sessions[0]!.updatedAt),
    )
    return [
      {
        hostId: computer.hostId,
        name: computer.name,
        state: computer.state,
        stateText: computerState(computer).text,
        live: computer.state === 'online',
        projects,
        count: sessions.length,
        capped: sessions.length >= COMPUTER_SESSION_LIMIT,
      },
    ]
  })
}

/** The computer choice on the start screen: shown only while more than one computer answers. */
export function startComputers(view: ComputersView | undefined): ComputerSummary[] {
  return view && view.computers.filter(computer => computer.local || computer.state === 'online').length > 1 ? view.computers : []
}
