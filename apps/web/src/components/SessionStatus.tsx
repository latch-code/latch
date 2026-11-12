import { useEffect, useRef, useState } from 'react'
import type { AppSnapshot, RunLive } from '@latch/protocol'
import { StatusSlot, type SlotStatus } from '@latch/ui'
import { hostNow, useTicker } from '../core/hostClock.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { useSteady } from '../hooks/useSteady.ts'
import { activityWords, runningWords, silentWords, type RowStatus, type WaitKind } from '../sessions.ts'

/** The clock's leaf: only this re-renders each second, and the shared ticker stops while the page is hidden. */
function RunningWords({ live }: { live: RunLive | undefined }) {
  useTicker('second')
  return <>{runningWords(live, hostNow())}</>
}

function SilentWords({ live }: { live: RunLive | undefined }) {
  useTicker('second')
  return <>{silentWords(live, hostNow())}</>
}

/** What a row in 等你处理 waits on, on its second line; silence counts its minutes there. */
export function WaitWords({ wait, live }: { wait: WaitKind; live: RunLive | undefined }) {
  return wait.kind === 'silent' ? <SilentWords live={live} /> : <>{wait.words}</>
}

const SLOT: Record<RowStatus['kind'], SlotStatus> = {
  waiting: 'waiting',
  silent: 'attention',
  stopping: 'running',
  running: 'running',
  failed: 'failed',
  unread: 'unread',
  ended: 'ended',
  frozen: 'none',
  read: 'time',
}

const statusKey = (status: RowStatus) => (status.kind === 'ended' ? `ended:${status.word}:${status.unknown}` : status.kind)

/**
 * A session row's status slot. The words come from what the Host last said and change at most once a second. In
 * 等你处理 the shelf says that the row waits and its second line says on what, so the slot shows the time.
 */
export function SessionStatus({
  status,
  live,
  inWaitingShelf,
  time,
  dateTime,
  className,
}: {
  status: RowStatus
  live: RunLive | undefined
  inWaitingShelf: boolean
  time: string
  dateTime: string
  className?: string
}) {
  const shown = useSteady(status, statusKey(status))
  const shelved = inWaitingShelf && (shown.kind === 'waiting' || shown.kind === 'silent')
  const attention = shown.kind === 'ended' ? shown.word : <SilentWords live={live} />
  return (
    <StatusSlot
      className={className}
      status={shelved ? 'time' : shown.kind === 'ended' && shown.unknown > 0 ? 'attention' : SLOT[shown.kind]}
      running={shown.kind === 'stopping' ? '正在停止' : <RunningWords live={live} />}
      attention={attention}
      ended={shown.kind === 'ended' ? shown.word : undefined}
      time={time}
      dateTime={dateTime}
    />
  )
}

/** The row's status for a screen reader, which the slot leaves out. */
export function statusLabel(status: RowStatus, live: RunLive | undefined): string {
  switch (status.kind) {
    case 'waiting':
      return '等你处理'
    case 'silent':
      return silentWords(live, hostNow())
    case 'stopping':
      return '正在停止'
    case 'running':
      return activityWords(live)
    case 'failed':
      return '失败'
    case 'unread':
      return '有新内容'
    case 'ended':
      return [status.word, status.unknown > 0 && `${status.unknown} 条结果未知`, status.unread && '有新内容'].filter(Boolean).join('，')
    case 'frozen':
      return '状态未更新'
    case 'read':
      return ''
  }
}

const timeOfDay = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * While the connection is down, 「上次确认 10:42」: the time of the last list that really came from the Host. Null while
 * connected. An idle connection still reads the list every 30 seconds, so this is that close.
 */
export function useLastConfirmed(connection: ConnectionStatus, snapshot: Pick<AppSnapshot, 'tasks'>): string | null {
  const down = connection === 'reconnecting' || connection === 'offline'
  const last = useRef(Date.now())
  const [frozenAt, setFrozenAt] = useState<number | null>(null)
  useEffect(() => {
    if (down) setFrozenAt(last.current)
    else {
      last.current = Date.now()
      setFrozenAt(null)
    }
  }, [down, snapshot])
  return down ? `上次确认 ${timeOfDay(frozenAt ?? last.current)}` : null
}
