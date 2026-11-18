import { useEffect, useRef, useState } from 'react'
import { Eraser, Pause, Play, X } from 'lucide-react'
import { IconButton, StatusWord, ValuePicker } from '@latch/ui'
import type { SimulatorAppView, SimulatorLogEvents } from '@latch/protocol'
import { EventStreamParser } from '../../core/eventStream.ts'
import { appendLines } from './model.ts'
import { defineCopy, formatNumber, plural } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    dropped: (count: number) => `少 ${formatNumber(count)} 行`,
    all: '全部进程',
    yours: '你的',
    logs: '日志',
    filter: '只看这个 App 的日志',
    failed: '失败',
    retry: '重新读取日志',
    ended: '已结束',
    live: '实时',
    droppedTitle: '页面读得比设备写得慢时少显示的行',
    resume: '继续',
    pause: '暂停',
    resumeScroll: '继续滚动',
    pauseScroll: '暂停滚动 · 新行先留着',
    clear: '清空',
    close: '关闭日志',
    deviceLogs: '设备日志',
  },
  {
    dropped: (count: number) => plural(count, { one: '{n} line omitted', other: '{n} lines omitted' }),
    all: 'All processes',
    yours: 'Yours',
    logs: 'Logs',
    filter: 'Show logs only for this app',
    failed: 'Failed',
    retry: 'Reload logs',
    ended: 'Ended',
    live: 'Live',
    droppedTitle: 'Lines omitted when the device wrote faster than this page could read',
    resume: 'Resume',
    pause: 'Pause',
    resumeScroll: 'Resume scrolling',
    pauseScroll: 'Pause scrolling · New lines keep buffering',
    clear: 'Clear',
    close: 'Close logs',
    deviceLogs: 'Device logs',
  },
)

const ALL = '*'

/**
 * The device's log, read with fetch as a text/event-stream (`GET /simulators/:udid/logs`), shown only here and kept to
 * the newest thousand lines. Pausing stops the view, not the stream; nothing is saved.
 */
export function DeviceLogs({ udid, apps, onClose }: { udid: string; apps: readonly SimulatorAppView[]; onClose: () => void }) {
  const [app, setApp] = useState<string>(ALL)
  const [lines, setLines] = useState<string[]>([])
  const [dropped, setDropped] = useState(0)
  const [state, setState] = useState<'opening' | 'live' | 'ended' | 'failed'>('opening')
  const [reason, setReason] = useState<string>()
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  const held = useRef<string[]>([])
  const list = useRef<HTMLPreElement>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    pausedRef.current = paused
    if (!paused && held.current.length) {
      const waiting = held.current
      held.current = []
      setLines(kept => appendLines(kept, waiting))
    }
  }, [paused])

  useEffect(() => {
    const controller = new AbortController()
    setState('opening')
    setReason(undefined)
    setDropped(0)
    const query = app === ALL ? '' : `?app=${encodeURIComponent(app)}`
    void (async () => {
      try {
        const response = await fetch(`/link/api/simulators/${udid}/logs${query}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined
          setReason(body?.message ?? `HTTP ${response.status}`)
          setState('failed')
          return
        }
        setState('live')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        const parser = new EventStreamParser()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
            if (event.event === 'lines') {
              const frame = JSON.parse(event.data) as SimulatorLogEvents['lines']
              if (!Array.isArray(frame.lines)) continue
              const text = frame.lines.filter(line => typeof line === 'string')
              if (pausedRef.current) held.current = appendLines(held.current, text)
              else setLines(kept => appendLines(kept, text))
            } else if (event.event === 'dropped') {
              const frame = JSON.parse(event.data) as SimulatorLogEvents['dropped']
              if (typeof frame.count === 'number') setDropped(count => count + frame.count)
            } else if (event.event === 'closed') {
              setState('ended')
            }
          }
        }
        if (!controller.signal.aborted) setState('ended')
      } catch (error) {
        if (controller.signal.aborted) return
        setReason(error instanceof Error ? error.message : String(error))
        setState('failed')
      }
    })()
    return () => controller.abort()
  }, [udid, app, revision])

  // Follow the end unless the person scrolled up.
  useEffect(() => {
    const element = list.current
    if (!element || paused) return
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 48) element.scrollTop = element.scrollHeight
  }, [lines, paused])

  const appOptions = [
    { value: ALL, label: COPY.all },
    ...apps.map(item => ({ value: item.bundleId, label: item.name, meta: item.kind === 'user' ? COPY.yours : undefined })),
  ]

  return (
    <section className="sim-pane" aria-label={COPY.logs}>
      <div className="sim-pane-bar">
        <ValuePicker
          label={COPY.filter}
          size="xs"
          value={app}
          options={appOptions}
          searchable={appOptions.length > 12}
          onValueChange={value => {
            setLines([])
            held.current = []
            setApp(value)
          }}
        />
        {state === 'failed' ? (
          <StatusWord tone="failed" title={reason}>
            {COPY.failed}
          </StatusWord>
        ) : state === 'ended' ? (
          <button type="button" className="sim-pane-again" title={COPY.retry} onClick={() => setRevision(value => value + 1)}>
            <StatusWord tone="neutral">{COPY.ended}</StatusWord>
          </button>
        ) : state === 'live' ? (
          <StatusWord tone="running">{COPY.live}</StatusWord>
        ) : null}
        {dropped > 0 && (
          <span className="sim-pane-meta" title={COPY.droppedTitle}>
            {COPY.dropped(dropped)}
          </span>
        )}
        <span className="sim-spacer" />
        <IconButton
          size="xs"
          icon={paused ? Play : Pause}
          label={paused ? COPY.resume : COPY.pause}
          tooltip={paused ? COPY.resumeScroll : COPY.pauseScroll}
          pressed={paused}
          onClick={() => setPaused(value => !value)}
        />
        <IconButton
          size="xs"
          icon={Eraser}
          label={COPY.clear}
          onClick={() => {
            setLines([])
            held.current = []
            setDropped(0)
          }}
        />
        <IconButton size="xs" icon={X} label={COPY.close} onClick={onClose} />
      </div>
      <pre ref={list} className="sim-log" tabIndex={0} aria-label={COPY.deviceLogs} aria-live="off">
        {lines.join('\n')}
      </pre>
    </section>
  )
}
