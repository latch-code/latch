import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { MessageSquarePlus, RotateCcw, SquareActivity, SquareX } from 'lucide-react'
import { TERMINALS_PER_SESSION, type TerminalSize, type TerminalSummary } from '@latch/protocol'
import {
  Button,
  ConfirmDialog,
  Hint,
  Icon,
  IconButton,
  InlineNotice,
  Loading,
  PanelTabs,
  Spinner,
  Tooltip,
  type PanelTab,
  GlobeGlyph,
  ShieldGlyph,
  PlusGlyph,
  TerminalGlyph,
} from '@latch/ui'
import { errorMessage, MessageError } from '../../core/api.ts'
import { VisibleText } from '../../components/VisibleText.tsx'
import { draftText, endedText, keyLeavesTerminal, serviceLabel, tabLabel, type TerminalTab } from './model.ts'
import { TerminalLink } from './link.ts'
import { terminalTheme } from './theme.ts'
import { useTerminals } from './useTerminals.ts'

/** The line height of the terminal role (--lh-term over --fs-term), as xterm's multiple of the font's own height. */
const LINE_HEIGHT = 1.2
/** The padding around the screen (terminal.css): 8 above and below, 12 on each side. */
const PAD = { x: 24, y: 16 }
const RESIZE_SETTLE_MS = 120

export interface TerminalPanelProps {
  sessionId: string
  /** The tab is on screen: the list is read, and a terminal opened, only once it is. */
  shown: boolean
  /** Puts text into the session's composer draft without sending it; absent while the composer takes none. */
  onCompose?: ((text: string) => void) | undefined
  /** Opens a local service in the 浏览器 tab (the desktop app); ⌘-click still goes to the system browser. */
  onOpenService?: ((origin: string) => void) | undefined
}

/** The size a new terminal opens at: what fits the screen area, by the terminal font's cell. */
function measuredSize(element: HTMLElement | null): TerminalSize {
  if (!element || element.clientWidth === 0) return { cols: 80, rows: 24 }
  const { fontFamily, fontSize } = terminalTheme(element)
  const context = document.createElement('canvas').getContext('2d')
  let width = fontSize * 0.6
  if (context) {
    context.font = `${fontSize}px ${fontFamily}`
    width = context.measureText('W').width || width
  }
  const height = Math.round(fontSize * LINE_HEIGHT * 1.2)
  return {
    cols: Math.max(20, Math.min(1000, Math.floor((element.clientWidth - PAD.x) / width))),
    rows: Math.max(5, Math.min(1000, Math.floor((element.clientHeight - PAD.y) / height))),
  }
}

const tabIcon = (summary: TerminalSummary) => (summary.status !== 'running' ? SquareX : summary.busy ? SquareActivity : TerminalGlyph)

/**
 * The 终端 tab: the session's terminals, 终端 1, 2…, each a login shell in the session's folder that the Host chose. The
 * screen follows the Host's stream; the bar holds the local services the output announced and 「加入对话」. Only this Mac
 * gets here (the Host offers `catalog.features.terminal` nowhere else).
 */
export function TerminalPanel({ sessionId, shown, onCompose, onOpenService }: TerminalPanelProps) {
  const id = useId()
  const screens = useRef<HTMLDivElement>(null)
  const terminals = useTerminals({ sessionId, shown, size: () => measuredSize(screens.current) })
  const { tabs, active, read, opening, failure } = terminals
  const current = tabs.find(tab => tab.id === active)
  const [selection, setSelection] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<{ tab: TerminalTab; program?: string }>()
  const [notice, setNotice] = useState<{ tone: 'warn' | 'error'; text: string }>()
  const [attaching, setAttaching] = useState(false)
  const [connection, setConnection] = useState<Record<string, 'live' | 'reconnecting'>>({})

  const close = async (tab: TerminalTab) => {
    const result = await terminals.close(tab.id)
    if (result.kind === 'busy') setConfirm({ tab, ...(result.program ? { program: result.program } : {}) })
    else if (result.kind === 'failed') terminals.setFailure(result.text)
  }

  const attach = async () => {
    if (!current || !onCompose) return
    setAttaching(true)
    setNotice(undefined)
    try {
      const extract = await terminals.extract(current.id, selection[current.id] ?? '')
      if (!extract.text.trim()) {
        setNotice({ tone: 'warn', text: '没有可以加入的输出' })
        return
      }
      onCompose(draftText(tabLabel(current.number), extract))
      if (extract.mayContainSecret) setNotice({ tone: 'warn', text: '加入的内容可能含密钥，发送前检查草稿' })
    } catch (cause) {
      setNotice({ tone: 'error', text: errorMessage(cause) })
    } finally {
      setAttaching(false)
    }
  }

  const panelTabs: Array<PanelTab<string>> = tabs.map(tab => ({
    value: tab.id,
    label: tabLabel(tab.number),
    icon: tabIcon(tab.summary),
    controls: id,
    closeLabel: `关闭${tabLabel(tab.number)}`,
  }))
  const ended = current ? endedText(current.summary) : undefined
  const full = tabs.length >= TERMINALS_PER_SESSION
  const services = current?.summary.status === 'running' ? current.summary.services : []

  return (
    <section className="terminal-panel" aria-label="终端">
      <PanelTabs
        label="终端"
        className="terminal-tabs"
        value={active ?? ''}
        tabs={panelTabs}
        onValueChange={terminals.setActive}
        onClose={value => {
          const tab = tabs.find(item => item.id === value)
          if (tab) void close(tab)
        }}
        actions={
          <>
            {services.map(service => (
              <Tooltip
                key={service.origin}
                content={onOpenService ? `在浏览器标签里打开 ${service.origin} · ⌘ 点按用系统浏览器` : `在浏览器中打开 ${service.origin}`}>
                <a
                  className="terminal-service"
                  href={service.origin}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={event => {
                    if (!onOpenService || event.metaKey || event.ctrlKey) return
                    event.preventDefault()
                    onOpenService(service.origin)
                  }}>
                  <Icon icon={GlobeGlyph} size={12} />
                  {serviceLabel(service)}
                </a>
              </Tooltip>
            ))}
            {onCompose && current && (
              <Button
                size="xs"
                variant="ghost"
                icon={MessageSquarePlus}
                loading={attaching}
                tooltip={selection[current.id] ? '把选中的输出加入草稿' : '把最近的输出加入草稿'}
                onClick={() => void attach()}>
                加入对话
              </Button>
            )}
            <IconButton
              size="xs"
              icon={PlusGlyph}
              label="新终端"
              {...(full ? { tooltip: `每个会话最多 ${TERMINALS_PER_SESSION} 个终端` } : {})}
              disabled={full || opening}
              onClick={() => void terminals.open()}
            />
          </>
        }
      />
      {notice && (
        <InlineNotice tone={notice.tone} className="terminal-notice" onClose={() => setNotice(undefined)}>
          {notice.text}
        </InlineNotice>
      )}
      {failure && (
        <InlineNotice tone="error" className="terminal-notice" onClose={() => terminals.setFailure(undefined)}>
          {failure}
        </InlineNotice>
      )}
      <div className="terminal-screens" ref={screens} id={id} role="tabpanel" aria-label={current ? tabLabel(current.number) : '终端'}>
        {tabs.map(tab => (
          <TerminalScreen
            key={tab.id}
            sessionId={sessionId}
            tab={tab}
            visible={shown && tab.id === active}
            onSummary={terminals.updated}
            onClosed={() => terminals.gone(tab.id)}
            onSelection={text => setSelection(previous => ({ ...previous, [tab.id]: text }))}
            onConnection={state => setConnection(previous => ({ ...previous, [tab.id]: state }))}
            onInputFailed={text => setNotice({ tone: 'error', text })}
          />
        ))}
        {tabs.length === 0 && (
          <div className="terminal-empty">
            {read.kind === 'loading' || opening ? (
              <Loading label="正在打开终端…" />
            ) : read.kind === 'failed' ? (
              <InlineNotice
                tone="error"
                action={
                  <Button size="xs" onClick={() => void terminals.list()}>
                    重试
                  </Button>
                }>
                {read.text}
              </InlineNotice>
            ) : (
              <Button size="sm" icon={TerminalGlyph} onClick={() => void terminals.open()}>
                打开终端
              </Button>
            )}
          </div>
        )}
      </div>
      {current && (
        <footer className="terminal-foot" data-ended={ended ? '' : undefined}>
          {ended ? (
            <>
              <span className="terminal-ended" role="status">
                {ended}
              </span>
              <Button size="xs" variant="primary" icon={RotateCcw} loading={opening} onClick={() => void terminals.reopen(current)}>
                重新打开
              </Button>
            </>
          ) : (
            <span className="terminal-facts">
              <VisibleText text={`${current.summary.shell} · ${current.summary.folder}`} />
              {current.summary.busy && (
                <span className="terminal-running">
                  <Spinner size={12} />
                  <VisibleText text={current.summary.foreground ?? '程序运行中'} />
                </span>
              )}
              {connection[current.id] === 'reconnecting' && <span className="terminal-reconnecting">正在重新连接…</span>}
            </span>
          )}
          <span className="terminal-space" />
          <Hint className="terminal-hint" lead={<Icon icon={ShieldGlyph} size={12} />} label="你的账户，不是沙箱">
            终端是这台 Mac 上以你的账户运行的登录 shell，和「终端」App 相同。Latch 的审批、路径检查与出站策略都不适用于其中的命令。
          </Hint>
        </footer>
      )}
      {confirm && (
        <ConfirmDialog
          title={`关闭${tabLabel(confirm.tab.number)}？`}
          message={confirm.program ? `「${confirm.program}」还在运行，关闭会结束它。` : '终端里还有程序在运行，关闭会结束它。'}
          confirmLabel="关闭终端"
          danger
          onConfirm={async () => {
            const result = await terminals.close(confirm.tab.id, true)
            if (result.kind === 'failed') throw new MessageError(result.text)
          }}
          onClose={() => setConfirm(undefined)}
        />
      )}
    </section>
  )
}

/** Keys stay in the terminal, but ⌘ chords: the workbench's window and document listeners never see the rest. */
function keepKeys(event: KeyboardEvent) {
  if (!keyLeavesTerminal(event)) event.stopPropagation()
}

/** Loads xterm and its stylesheet once, when the first terminal shows. */
let xtermModules: Promise<[typeof import('@xterm/xterm'), typeof import('@xterm/addon-fit')]> | undefined
const loadXterm = () =>
  (xtermModules ??= Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')]).then(
    ([xterm, fit]) => [xterm, fit] as [typeof import('@xterm/xterm'), typeof import('@xterm/addon-fit')],
  ))

/**
 * One terminal's screen. It keeps its stream while hidden, so switching tabs shows the output at once. The device that
 * opened the terminal sizes it to the area; any other shows it at the Host's size.
 */
function TerminalScreen({
  sessionId,
  tab,
  visible,
  onSummary,
  onClosed,
  onSelection,
  onConnection,
  onInputFailed,
}: {
  sessionId: string
  tab: TerminalTab
  visible: boolean
  onSummary(summary: TerminalSummary): void
  onClosed(): void
  onSelection(text: string): void
  onConnection(state: 'live' | 'reconnecting'): void
  onInputFailed(text: string): void
}) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<{ terminal: Terminal; fit: FitAddon; link: TerminalLink } | null>(null)
  const [ready, setReady] = useState(false)
  const handlers = useRef({ onSummary, onClosed, onSelection, onConnection, onInputFailed })
  handlers.current = { onSummary, onClosed, onSelection, onConnection, onInputFailed }
  const summary = useRef(tab.summary)
  summary.current = tab.summary
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  /** Sizes the screen: to the area for the owner (and tells the Host), to the Host's size for anyone else. */
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const layout = useCallback(() => {
    const current = term.current
    const element = host.current
    if (!current || !element || !visibleRef.current || element.clientWidth === 0 || element.clientHeight === 0) return
    const { terminal, fit, link } = current
    const { sizeOwner, cols, rows, status } = summary.current
    if (!sizeOwner || status !== 'running') {
      if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows)
      return
    }
    fit.fit()
    clearTimeout(settle.current)
    settle.current = setTimeout(() => {
      if (terminal.cols === summary.current.cols && terminal.rows === summary.current.rows) return
      void link.resize(terminal.cols, terminal.rows).then(next => {
        if (next) handlers.current.onSummary(next)
      })
    }, RESIZE_SETTLE_MS)
  }, [])

  useEffect(() => {
    let disposed = false
    const cleanup: Array<() => void> = []
    void loadXterm().then(([{ Terminal }, { FitAddon }]) => {
      const element = host.current
      if (disposed || !element) return
      const { fontFamily, fontSize, ...theme } = terminalTheme(element)
      const terminal = new Terminal({
        fontFamily,
        fontSize,
        lineHeight: LINE_HEIGHT,
        cursorBlink: true,
        scrollback: 5000,
        cols: summary.current.cols,
        rows: summary.current.rows,
        theme,
        disableStdin: summary.current.status !== 'running',
        rightClickSelectsWord: true,
        allowProposedApi: false,
      })
      const fit = new FitAddon()
      terminal.loadAddon(fit)
      terminal.open(element)
      const link = new TerminalLink(sessionId, tab.id, {
        write: bytes => new Promise<void>(resolve => terminal.write(bytes, resolve)),
        reset: () => terminal.reset(),
        summary: next => handlers.current.onSummary(next),
        closed: () => handlers.current.onClosed(),
        connection: state => handlers.current.onConnection(state),
        inputFailed: text => handlers.current.onInputFailed(text),
      })
      term.current = { terminal, fit, link }
      const typed = terminal.onData(data => link.send(data))
      // Mouse reports in the X10 encoding: one character per byte.
      const binary = terminal.onBinary(data =>
        link.send(String.fromCharCode(...[...data].map(character => character.charCodeAt(0) & 0xff))),
      )
      const selected = terminal.onSelectionChange(() => handlers.current.onSelection(terminal.getSelection()))
      element.addEventListener('keydown', keepKeys)
      const observer = new ResizeObserver(() => layout())
      observer.observe(element)
      const retheme = () => {
        const { fontFamily: family, fontSize: size, ...next } = terminalTheme(element)
        terminal.options.theme = next
        terminal.options.fontFamily = family
        terminal.options.fontSize = size
        layout()
      }
      const scheme = matchMedia('(prefers-color-scheme: dark)')
      scheme.addEventListener('change', retheme)
      const attributes = new MutationObserver(retheme)
      attributes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
      cleanup.push(() => {
        typed.dispose()
        binary.dispose()
        selected.dispose()
        element.removeEventListener('keydown', keepKeys)
        observer.disconnect()
        scheme.removeEventListener('change', retheme)
        attributes.disconnect()
        link.close()
        terminal.dispose()
      })
      link.start()
      setReady(true)
    })
    return () => {
      disposed = true
      clearTimeout(settle.current)
      for (const step of cleanup) step()
      term.current = null
    }
  }, [sessionId, tab.id, layout])

  // The Host's word on size and state: a screen that is not the owner follows it; an ended one takes no more input.
  useEffect(() => {
    const current = term.current
    if (!current) return
    current.terminal.options.disableStdin = tab.summary.status !== 'running'
    current.terminal.options.cursorBlink = tab.summary.status === 'running'
    layout()
  }, [ready, tab.summary.status, tab.summary.cols, tab.summary.rows, tab.summary.sizeOwner, layout])

  useEffect(() => {
    if (!visible || !ready) return
    layout()
    term.current?.terminal.focus()
  }, [visible, ready, layout])

  return <div className="terminal-screen" ref={host} hidden={!visible} data-terminal-id={tab.id} data-status={tab.summary.status} />
}
