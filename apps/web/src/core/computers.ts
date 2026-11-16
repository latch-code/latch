import { useEffect, useState } from 'react'
import { isLoopbackHost, type AttentionItem, type AttentionKind, type ComputerSummary } from '@latch/protocol'
import { shellComputers, type ComputersView } from './shell.ts'

/** A state colour for the status words: the tones of `StatusWord` in @latch/ui. */
type Tone = 'neutral' | 'waiting' | 'running' | 'failed' | 'done' | 'warn'

/** A clock time, 10:42, or empty for a time that does not parse. */
export function clockTime(iso: string | undefined): string {
  const at = iso ? new Date(iso) : undefined
  return at && Number.isFinite(at.getTime()) ? at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''
}

/** A computer's state in words and tone: amber where it waits for the person, red where the connection is not safe. */
export function computerState(computer: Pick<ComputerSummary, 'state' | 'reason' | 'lastSeenAt'>): { text: string; tone: Tone } {
  switch (computer.state) {
    case 'online':
      return { text: '在线', tone: 'neutral' }
    case 'connecting':
      return { text: '正在连接', tone: 'running' }
    case 'offline': {
      const seen = clockTime(computer.lastSeenAt)
      return { text: seen ? `离线 · 上次在线 ${seen}` : '离线', tone: 'neutral' }
    }
    case 'stopping':
      return {
        text: computer.reason === 'update' ? '正在更新' : computer.reason === 'restart' ? '正在重启' : '已停止',
        tone: 'neutral',
      }
    case 'sleeping':
      return { text: '已休眠', tone: 'neutral' }
    case 'revoked':
      return { text: '已被移除', tone: 'warn' }
    case 'wrong-host':
      return { text: '不是这台电脑', tone: 'failed' }
    case 'cert-error':
      return { text: '证书不受信任', tone: 'failed' }
    case 'cert-changed':
      return { text: '证书变了', tone: 'warn' }
    case 'outdated':
      return { text: '版本较旧', tone: 'warn' }
  }
}

/** This page's connection to its Host in a word, beside its live dot. */
export const CONNECTION_WORDS = { connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', offline: '离线' } as const

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
    const stale = !live && waiting > 0 ? `离线前 ${waiting} 项` : undefined
    return [
      {
        hostId: computer.hostId,
        name: computer.local ? '这台 Mac' : computer.name,
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
  return protocol === 'http:' && loopback ? '回环 HTTP' : ''
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
  approval: '审批',
  question: '问题',
  stuck: '没有动静',
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
