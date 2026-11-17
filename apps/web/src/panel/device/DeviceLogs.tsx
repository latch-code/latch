import { useEffect, useRef, useState } from 'react'
import { Eraser, Pause, Play, X } from 'lucide-react'
import { IconButton, StatusWord, ValuePicker } from '@latch/ui'
import type { SimulatorAppView, SimulatorLogEvents } from '@latch/protocol'
import { EventStreamParser } from '../../core/eventStream.ts'
import { appendLines } from './model.ts'

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
    { value: ALL, label: '全部进程' },
    ...apps.map(item => ({ value: item.bundleId, label: item.name, meta: item.kind === 'user' ? '你的' : undefined })),
  ]

  return (
    <section className="sim-pane" aria-label="日志">
      <div className="sim-pane-bar">
        <ValuePicker
          label="只看这个 App 的日志"
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
            失败
          </StatusWord>
        ) : state === 'ended' ? (
          <button type="button" className="sim-pane-again" title="重新读取日志" onClick={() => setRevision(value => value + 1)}>
            <StatusWord tone="neutral">已结束</StatusWord>
          </button>
        ) : state === 'live' ? (
          <StatusWord tone="running">实时</StatusWord>
        ) : null}
        {dropped > 0 && (
          <span className="sim-pane-meta" title="页面读得比设备写得慢时少显示的行">
            少 {dropped} 行
          </span>
        )}
        <span className="sim-spacer" />
        <IconButton
          size="xs"
          icon={paused ? Play : Pause}
          label={paused ? '继续' : '暂停'}
          tooltip={paused ? '继续滚动' : '暂停滚动 · 新行先留着'}
          pressed={paused}
          onClick={() => setPaused(value => !value)}
        />
        <IconButton
          size="xs"
          icon={Eraser}
          label="清空"
          onClick={() => {
            setLines([])
            held.current = []
            setDropped(0)
          }}
        />
        <IconButton size="xs" icon={X} label="关闭日志" onClick={onClose} />
      </div>
      <pre ref={list} className="sim-log" tabIndex={0} aria-label="设备日志" aria-live="off">
        {lines.join('\n')}
      </pre>
    </section>
  )
}
