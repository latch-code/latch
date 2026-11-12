import { useEffect, useState } from 'react'
import type { AttentionItem, AttentionKind, ComputerSummary } from '@latch/protocol'
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
