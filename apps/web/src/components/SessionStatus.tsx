import { useEffect, useRef, useState } from 'react'
import type { AppSnapshot, RunLive } from '@latch/protocol'
import { AlertGlyph, CheckGlyph, Icon, Spinner, StatusGlyph, StatusSlot, WaitingGlyph, type SlotStatus } from '@latch/ui'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { currentLocale, defineCopy, plural, useLocale } from '../core/i18n.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { useSteady } from '../hooks/useSteady.ts'
import { activityWords, rowMark, runningWords, silentWords, type RowStatus, type WaitKind } from '../sessions.ts'
import { runClock, runElapsed } from '../conversation.ts'
import { MarkTile } from './BrandTile.tsx'
import { personActivity, THOUGHT_WORDS } from '../agents/personWords.ts'

const COPY = defineCopy(
  {
    stopping: '正在停止',
    thinking: '思考中',
    waiting: '等你处理',
    failed: '失败',
    fresh: '有新内容',
    unknown: (count: number) => plural(count, { other: '{n} 条结果未知' }),
    stale: '状态未更新',
    lastConfirmed: (at: string) => `上次确认 ${at}`,
    separator: '，',
  },
  {
    stopping: 'Stopping',
    thinking: 'Thinking',
    waiting: 'Needs you',
    failed: 'Failed',
    fresh: 'New content',
    unknown: (count: number) => plural(count, { one: '{n} unknown outcome', other: '{n} unknown outcomes' }),
    stale: 'Status is out of date',
    lastConfirmed: (at: string) => `Last confirmed at ${at}`,
    separator: ', ',
  },
)

/**
 * The clock's leaf: only this re-renders each second, and the shared ticker stops while the page is hidden. A topic of
 * 我的 Agent says it as the helper does (在想, 在跑命令), never 在等模型.
 */
export function RunningWords({ live, person = false }: { live: RunLive | undefined; person?: boolean }) {
  useTicker('second')
  const words = runningWords(live, hostNow())
  const said = person ? personActivity(live)?.words : undefined
  return <>{said ? words.replace(activityWords(live), said) : words}</>
}

/**
 * The live turn before its words arrive, where they will be: a small grey turning ring and how long it has run. It says nothing of what the Harness waits on; a tool's own row says that when there is one.
 * 我的 Agent says what it is doing as a person does (在准备, 在想, 在跑命令), never 思考中.
 */
export function ThinkingLine({ live, person = false }: { live: RunLive | undefined; person?: boolean }) {
  useTicker('second')
  const ms = live && runElapsed(live, hostNow())
  return (
    <div className="thinking-line" role="status">
      <Spinner size={12} />
      <span>{person ? (personActivity(live)?.words ?? THOUGHT_WORDS.live) : COPY.thinking}</span>
      {ms !== undefined && <span className="thinking-clock">{runClock(ms)}</span>}
    </div>
  )
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
 * The sidebar row's leading icon: the session's Harness (the neutral glyph where it has none), with the row's state on
 * its top-right corner: the spinner while it runs, a flag while it waits on you, an alert when it failed, and a muted
 * check for a new answer. The row's accessible words name the Harness and the exact state.
 */
export function SessionRowGlyph({ status, mark }: { status: RowStatus; mark: string | undefined }) {
  const state = rowMark(status)
  return (
    <span
      className="session-row-glyph"
      data-tone={
        state === undefined || state === 'unread' ? 'neutral' : state === 'running' ? 'running' : state === 'failed' ? 'failed' : 'waiting'
      }>
      <MarkTile mark={mark} size={16} bare />
      {state !== undefined && (
        <span className="session-row-state" data-state={state} aria-hidden="true">
          {state === 'running' ? (
            <StatusGlyph running state={state} />
          ) : (
            <Icon icon={state === 'failed' ? AlertGlyph : state === 'unread' ? CheckGlyph : WaitingGlyph} size={12} />
          )}
        </span>
      )}
    </span>
  )
}

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
  person = false,
}: {
  status: RowStatus
  live: RunLive | undefined
  /** A topic of 我的 Agent: its running words are a person's. */
  person?: boolean
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
      running={shown.kind === 'stopping' ? COPY.stopping : <RunningWords live={live} person={person} />}
      attention={attention}
      ended={shown.kind === 'ended' ? shown.word : undefined}
      time={time}
      dateTime={dateTime}
    />
  )
}

/** The row's status for a screen reader, which the slot leaves out. */
export function statusLabel(status: RowStatus, live: RunLive | undefined, person = false): string {
  switch (status.kind) {
    case 'waiting':
      return COPY.waiting
    case 'silent':
      return silentWords(live, hostNow())
    case 'stopping':
      return COPY.stopping
    case 'running':
      return (person ? personActivity(live)?.words : undefined) ?? activityWords(live)
    case 'failed':
      return COPY.failed
    case 'unread':
      return COPY.fresh
    case 'ended':
      return [status.word, status.unknown > 0 && COPY.unknown(status.unknown), status.unread && COPY.fresh]
        .filter(Boolean)
        .join(COPY.separator)
    case 'frozen':
      return COPY.stale
    case 'read':
      return ''
  }
}

const timeOfDay = (at: number) => new Date(at).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * While the connection is down, 「上次确认 10:42」: the time of the last list that really came from the Host. Null while
 * connected. An idle connection still reads the list every 30 seconds, so this is that close.
 */
export function useLastConfirmed(connection: ConnectionStatus, snapshot: Pick<AppSnapshot, 'tasks'>): string | null {
  useLocale()
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
  return down ? COPY.lastConfirmed(timeOfDay(frozenAt ?? last.current)) : null
}
