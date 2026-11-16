import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { Columns2, MessageSquarePlus, RotateCcw, Rows2, SquareActivity } from 'lucide-react'
import { TERMINALS_PER_SESSION, type TerminalSize, type TerminalSummary, type TerminalTarget } from '@latch/protocol'
import {
  Button,
  CloseGlyph,
  ConfirmDialog,
  CopyGlyph,
  Icon,
  IconButton,
  InlineNotice,
  Loading,
  Menu,
  PanelTabs,
  ResizeHandle,
  Spinner,
  Tooltip,
  motionAllowed,
  watchMotion,
  writeClipboard,
  type MenuItem,
  type PanelTab,
  GlobeGlyph,
  PlusGlyph,
  TerminalGlyph,
} from '@latch/ui'
import { errorMessage, MessageError } from '../../core/api.ts'
import { readStorage } from '../../core/storageKeys.ts'
import { VisibleText } from '../../components/VisibleText.tsx'
import { isTerminalPaneKey, shortcutKeys, type TerminalPaneAction } from '../../workbenchShortcuts.ts'
import { draftText, endedText, keyLeavesTerminal, serviceLabel, tabLabel, tabName, type TerminalTab } from './model.ts'
import {
  evenPanes,
  paneMinShare,
  paneTabs,
  parseLayout,
  reconcile,
  replacePane,
  resizePanes,
  siblingPane,
  splitFits,
  splitKind,
  splitPane,
  stepPane,
  tabOf,
  type PaneArea,
  type PaneLayout,
  type PaneTab,
  type SplitDirection,
} from './panes.ts'
import { TerminalLink } from './link.ts'
import { loginRuns, useRevealedLogin } from './loginRuns.ts'
import { terminalTheme } from './theme.ts'
import { useTerminals } from './useTerminals.ts'
import { useTerminalFill, type ScreenHandle } from './useTerminalFill.ts'

/** The terminal's one fine print, on the foot's label: what the shell is, and that Latch's checks do not apply in it. */
const ACCOUNT_NOTE = '以你的账户运行的登录 shell，和「终端」App 相同，不是沙箱：Latch 的审批、路径检查与出站策略都不适用于其中的命令。'

/** The line height of the terminal role (--lh-term over --fs-term), as xterm's multiple of the font's own height. */
const LINE_HEIGHT = 1.2
/** The padding around the screen (terminal.css): 8 above and below, 12 on each side. */
const PAD = { x: 24, y: 16 }
const RESIZE_SETTLE_MS = 120

export interface TerminalPanelProps {
  target: TerminalTarget
  /** The dock is on screen. */
  shown: boolean
  /** The person explicitly opened the dock for this target: the screen takes focus. */
  requested: boolean
  /**
   * The dock: while it is on screen a terminal runs, so an empty list starts one, and closing the last one closes the
   * dock. A dialog that types a command in opens its own.
   */
  openWhenShown?: boolean
  /** The dock's last terminal was closed: the dock shuts (its toggle opens it again). There is no button for it here. */
  onCollapse?: () => void
  unavailable?: string
  location?: string
  /** Puts text into the session's composer draft without sending it; absent while the composer takes none. */
  onCompose?: ((text: string) => void) | undefined
  /** Opens a local service in the 浏览器 tab (the desktop app); ⌘-click still goes to the system browser. */
  onOpenService?: ((origin: string) => void) | undefined
  /** Takes the commands asked for this place (`fills.ts`) and types them in at a prompt. */
  fillPlace?: string | undefined
  /** A command was asked for: the surface comes into view. */
  onFillReveal?: (() => void) | undefined
  /** Where this device keeps which terminals share a tab (`paneStorageKey`); without it the layout lasts the page. */
  layoutKey?: string | undefined
  /** The workbench's pane keys reach this panel through it while it is mounted. */
  paneKeys?: RefObject<((action: TerminalPaneAction) => void) | null> | undefined
}

/** The terminal font's cell, as xterm lays it out. */
function cellOf(element: HTMLElement): { width: number; height: number } {
  const { fontFamily, fontSize } = terminalTheme(element)
  const context = document.createElement('canvas').getContext('2d')
  let width = fontSize * 0.6
  if (context) {
    context.font = `${fontSize}px ${fontFamily}`
    width = context.measureText('W').width || width
  }
  return { width, height: Math.round(fontSize * LINE_HEIGHT * 1.2) }
}

/** The size a new terminal opens at: what fits the box (the screen area, or the half of a pane it splits). */
function measuredSize(element: HTMLElement | null, box?: { width: number; height: number }): TerminalSize {
  if (!element || element.clientWidth === 0) return { cols: 80, rows: 24 }
  const { width, height } = box ?? { width: element.clientWidth, height: element.clientHeight }
  const cell = cellOf(element)
  return {
    cols: Math.max(20, Math.min(1000, Math.floor((width - PAD.x) / cell.width))),
    rows: Math.max(5, Math.min(1000, Math.floor((height - PAD.y) / cell.height))),
  }
}

/** The terminal glyph, or the running mark while a program runs in it; an ended terminal says so in its foot. */
const tabIcon = (summaries: readonly TerminalSummary[]) =>
  summaries.some(summary => summary.status === 'running' && summary.busy) ? SquareActivity : TerminalGlyph

const SPLIT = {
  row: { label: '左右分屏', icon: Columns2, shortcut: 'terminal-split' },
  column: { label: '上下分屏', icon: Rows2, shortcut: 'terminal-split-down' },
} as const

const readLayout = (key: string | undefined): PaneLayout => (key ? parseLayout(readStorage('localStorage', key)) : [])

/** Where pane `index` of a tab stands, in shares of the screen area. */
function paneBox(tab: PaneTab, index: number): CSSProperties {
  const start = tab.sizes.slice(0, index).reduce((sum, size) => sum + size, 0)
  const size = tab.sizes[index] ?? 1
  const along = { start: `${start * 100}%`, size: `${size * 100}%` }
  return tab.direction === 'row'
    ? { left: along.start, width: along.size, top: 0, height: '100%' }
    : { top: along.start, height: along.size, left: 0, width: '100%' }
}

/**
 * The target's terminals, each a shell in the folder the Host chose. Hiding the dock keeps its screens and streams. A
 * tab shows one terminal or 2–4 of them as panes in one direction; which terminals share a tab is this device's layout
 * (`panes.ts`), kept under `layoutKey`.
 */
export function TerminalPanel({
  target,
  shown,
  requested,
  openWhenShown = false,
  onCollapse,
  unavailable,
  location,
  onCompose,
  onOpenService,
  fillPlace,
  onFillReveal,
  layoutKey,
  paneKeys,
}: TerminalPanelProps) {
  const id = useId()
  const screens = useRef<HTMLDivElement>(null)
  const usableCompose = useRef<typeof onCompose>(undefined)
  useLayoutEffect(() => {
    usableCompose.current = shown ? onCompose : undefined
    return () => {
      usableCompose.current = undefined
    }
  }, [shown, onCompose])
  const [layout, setLayout] = useState<PaneLayout>(() => readLayout(layoutKey))
  /** Terminals 重新打开 is replacing: their pane keeps its place until the new one takes it. */
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set())
  const [area, setArea] = useState<PaneArea>({ width: 0, height: 0, cell: { width: 7.5, height: 18 }, pad: PAD })
  const entries = useRef<PaneTab[]>([])
  const terminals = useTerminals({
    target,
    shown,
    autoOpen: (requested || openWhenShown) && !unavailable,
    size: () => measuredSize(screens.current),
    successor: closing => siblingPane(entries.current, closing),
  })
  const { tabs, active, read, opening, failure, list, setActive } = terminals
  const fill = useTerminalFill({
    place: fillPlace,
    tabs,
    active,
    read,
    unavailable,
    open: terminals.open,
    close: terminals.close,
    setActive,
    onReveal: onFillReveal,
  })
  const handles = useRef(new Map<string, ScreenHandle>())
  const current = tabs.find(tab => tab.id === active)
  const [selection, setSelection] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<{ ids: string[]; name: string; program?: string }>()
  const [notice, setNotice] = useState<{ tone: 'warn' | 'error'; text: string }>()
  const [attaching, setAttaching] = useState(false)
  const [connection, setConnection] = useState<Record<string, 'live' | 'reconnecting'>>({})
  const [focusScreen, setFocusScreen] = useState(false)

  // The area's size decides whether a split shows (`splitFits`); every pane fits itself to its own box.
  useLayoutEffect(() => {
    const element = screens.current
    if (!element) return undefined
    const measure = () => {
      const width = element.clientWidth
      const height = element.clientHeight
      setArea(previous =>
        previous.width === width && previous.height === height && width > 0
          ? previous
          : { width, height, cell: width > 0 ? cellOf(element) : previous.cell, pad: PAD },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Panes whose terminal the Host no longer lists leave, once the list is read; the layout is kept per target and device.
  const live = tabs.map(tab => tab.id).join('\n')
  useEffect(() => {
    if (read.kind !== 'ready') return
    setLayout(previous => reconcile(previous, new Set(live ? live.split('\n') : []), replacing))
  }, [read.kind, live, replacing])
  useEffect(() => {
    if (!layoutKey || read.kind !== 'ready') return
    try {
      if (layout.length) localStorage.setItem(layoutKey, JSON.stringify(layout))
      else localStorage.removeItem(layoutKey)
    } catch {
      /* Storage full or off: the layout lives as long as the page. */
    }
  }, [layout, layoutKey, read.kind])

  const paneTabsNow = paneTabs(tabs, layout, group => splitFits(area, group.direction, group.panes.length), replacing)
  entries.current = paneTabsNow
  const currentTab = tabOf(paneTabsNow, active)
  /** The pane each tab had focused, so selecting the tab again goes back to it. */
  const remembered = useRef(new Map<string, string>())
  useEffect(() => {
    if (currentTab && active) remembered.current.set(currentTab.key, active)
  }, [currentTab, active])

  // A Harness's login was started for this session: its terminal joins the tabs and comes to the front.
  const revealed = useRevealedLogin(target.sessionId)
  const revealedId = revealed?.terminalId
  const revealedNonce = revealed?.nonce
  useEffect(() => {
    if (revealedId === undefined) return
    void list().then(() => {
      setActive(revealedId)
    })
  }, [revealedId, revealedNonce, list, setActive])
  const updated = (summary: TerminalSummary) => {
    terminals.updated(summary)
    if (summary.login) loginRuns.report(summary)
  }
  /** Terminals 重新打开 replaces: the old one ending is not the dock emptying. */
  const reopening = useRef(new Set<string>())
  /** Terminals that went: the dock with nothing left in it closes, rather than showing an empty screen. */
  const left = (ids: readonly string[]) => {
    const gone = ids.filter(item => {
      loginRuns.gone(item)
      return !reopening.current.delete(item)
    })
    if (openWhenShown && gone.length > 0 && tabs.length > 0 && tabs.every(tab => gone.includes(tab.id))) onCollapse?.()
  }
  const gone = (item: string) => {
    terminals.gone(item)
    left([item])
  }

  /** Closes terminals; those still running a program are asked about once, together, under `name`. */
  const close = async (ids: readonly string[], name: string) => {
    const closed: string[] = []
    const busy: string[] = []
    let program: string | undefined
    for (const item of ids) {
      const result = await terminals.close(item)
      if (result.kind === 'closed') closed.push(item)
      else if (result.kind === 'busy') {
        busy.push(item)
        program ??= result.program
      } else terminals.setFailure(result.text)
    }
    // Only the ones that went count: a confirmation still to come keeps the dock open.
    if (busy.length === 0) left(closed)
    else {
      for (const item of closed) loginRuns.gone(item)
      setConfirm({ ids: busy, name, ...(program ? { program } : {}) })
    }
  }
  const paneTabName = (tab: PaneTab) => {
    const first = tabs.find(item => item.id === tab.key)
    const name = first ? tabName(first) : '终端'
    return tab.panes.length > 1 ? `${name} · ${tab.panes.length}` : name
  }
  const terminalName = (item: string) => {
    const tab = tabs.find(entry => entry.id === item)
    return tab ? tabName(tab) : '终端'
  }

  const attach = async (item: string | undefined = current?.id) => {
    const tab = tabs.find(entry => entry.id === item)
    if (!tab || !onCompose) return
    setAttaching(true)
    setNotice(undefined)
    try {
      const extract = await terminals.extract(tab.id, selection[tab.id] ?? '')
      if (!extract.text.trim()) {
        setNotice({ tone: 'warn', text: '没有可以加入的输出' })
        return
      }
      usableCompose.current?.(draftText(tabLabel(tab.number), extract))
      if (extract.mayContainSecret) setNotice({ tone: 'warn', text: '加入的内容可能含密钥，发送前检查草稿' })
    } catch (cause) {
      setNotice({ tone: 'error', text: errorMessage(cause) })
    } finally {
      setAttaching(false)
    }
  }

  const full = tabs.length >= TERMINALS_PER_SESSION
  const limitNote = `每个${target.workspaceId === undefined ? '会话' : '项目'}最多 ${TERMINALS_PER_SESSION} 个终端`
  const blocked = opening || Boolean(unavailable) || read.kind !== 'ready'
  /** Why splitting `at` this way cannot happen now; undefined when it can. */
  const splitRefusal = (at: string | undefined, direction: SplitDirection): string | undefined => {
    if (full) return limitNote
    if (at === undefined || blocked) return '现在不能分屏'
    if (splitKind(layout, at, direction) === 'crossed') return '一个标签的窗格只排一个方向'
    return undefined
  }
  /** A new terminal beside `at`, in its tab; a tab of four gets a new tab instead. */
  const split = (direction: SplitDirection, at: string | undefined = active) => {
    if (at === undefined || splitRefusal(at, direction) !== undefined) return
    setFocusScreen(true)
    if (splitKind(layout, at, direction) === 'full') {
      void terminals.open()
      return
    }
    const pane = screens.current?.querySelector<HTMLElement>(`.terminal-pane[data-pane="${CSS.escape(at)}"]`)
    const box = pane && pane.clientWidth > 0 ? pane : screens.current
    const size = box
      ? measuredSize(box, {
          width: direction === 'row' ? box.clientWidth / 2 : box.clientWidth,
          height: direction === 'column' ? box.clientHeight / 2 : box.clientHeight,
        })
      : undefined
    void terminals.open(undefined, {
      ...(size ? { size } : {}),
      placed: added => setLayout(previous => splitPane(previous, at, added, direction)),
    })
  }
  const focusPane = (item: string | undefined) => {
    if (item === undefined) return
    setActive(item)
    requestAnimationFrame(() => handles.current.get(item)?.focus())
  }
  useEffect(() => {
    if (!paneKeys) return undefined
    const keys = (action: TerminalPaneAction) => {
      if (action.kind === 'terminal-split') split(action.direction)
      else focusPane(stepPane(entries.current, active, action.step))
    }
    paneKeys.current = keys
    return () => {
      if (paneKeys.current === keys) paneKeys.current = null
    }
  })

  const reopen = (tab: TerminalTab) => {
    reopening.current.add(tab.id)
    setReplacing(previous => new Set(previous).add(tab.id))
    void terminals
      .reopen(tab, added => setLayout(previous => replacePane(previous, tab.id, added)))
      .finally(() =>
        setReplacing(previous => {
          const next = new Set(previous)
          next.delete(tab.id)
          return next
        }),
      )
  }

  const splitItems = (at: string | undefined): MenuItem[] =>
    (['row', 'column'] as const).map(direction => {
      const refusal = splitRefusal(at, direction)
      const keys = shortcutKeys(SPLIT[direction].shortcut, true)
      return {
        id: `split-${direction}`,
        label: SPLIT[direction].label,
        icon: SPLIT[direction].icon,
        ...(keys ? { meta: keys } : {}),
        ...(refusal ? { disabledReason: refusal } : {}),
        onSelect: () => split(direction, at),
      }
    })

  const panelTabs: Array<PanelTab<string>> = paneTabsNow.map(tab => {
    const name = paneTabName(tab)
    const focused = tab.panes.includes(active ?? '') ? active : (remembered.current.get(tab.key) ?? tab.key)
    return {
      value: tab.key,
      label: name,
      icon: tabIcon(tab.panes.flatMap(item => tabs.find(entry => entry.id === item)?.summary ?? [])),
      controls: id,
      closeLabel: `关闭${name}`,
      menu: splitItems(focused),
    }
  })
  const splitShown = (currentTab?.panes.length ?? 0) > 1
  // In a split, how a shell ended is said in its own pane; the foot keeps the focused pane's shell and folder.
  const ended = current && !splitShown ? endedText(current.summary) : undefined
  const services = current?.summary.status === 'running' ? current.summary.services : []
  /** Every terminal's place: its tab's pane, or a pane kept for a terminal being replaced. */
  const placed = [...tabs.map(tab => tab.id), ...[...replacing].filter(item => !tabs.some(tab => tab.id === item))]

  return (
    <section className="terminal-panel" aria-label="终端" data-secure="">
      <PanelTabs
        label="终端"
        className="terminal-tabs"
        value={currentTab?.key ?? ''}
        tabs={panelTabs}
        onValueChange={value => {
          const tab = paneTabsNow.find(item => item.key === value)
          if (!tab) return
          const pane = remembered.current.get(tab.key)
          setFocusScreen(true)
          terminals.setActive(pane && tab.panes.includes(pane) ? pane : tab.key)
        }}
        onClose={value => {
          const tab = paneTabsNow.find(item => item.key === value)
          if (tab) void close(tab.panes, paneTabName(tab))
        }}
        actions={
          <>
            {!current && location && (
              <span className="terminal-location">
                <VisibleText text={location} />
              </span>
            )}
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
            {onCompose && current && !current.summary.login && (
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
            {(['row', 'column'] as const).map(direction => {
              const refusal = splitRefusal(active, direction)
              const keys = shortcutKeys(SPLIT[direction].shortcut, true)
              return (
                <IconButton
                  key={direction}
                  size="xs"
                  icon={SPLIT[direction].icon}
                  label={SPLIT[direction].label}
                  {...(keys && !refusal ? { shortcut: keys } : {})}
                  {...(refusal && active !== undefined && !blocked ? { tooltip: refusal } : {})}
                  disabled={refusal !== undefined}
                  onClick={() => split(direction)}
                />
              )
            })}
            <IconButton
              size="xs"
              icon={PlusGlyph}
              label="新终端"
              {...(full ? { tooltip: limitNote } : {})}
              disabled={full || blocked}
              onClick={() => {
                setFocusScreen(true)
                void terminals.open()
              }}
            />
          </>
        }
      />
      {notice && (
        <InlineNotice tone={notice.tone} className="terminal-notice" onClose={() => setNotice(undefined)}>
          {notice.text}
        </InlineNotice>
      )}
      {failure && tabs.length > 0 && (
        <InlineNotice tone="error" className="terminal-notice" onClose={() => terminals.setFailure(undefined)}>
          {failure}
        </InlineNotice>
      )}
      <div
        className="terminal-screens"
        ref={screens}
        id={id}
        role="tabpanel"
        aria-label={currentTab ? paneTabName(currentTab) : '终端'}
        data-split={splitShown ? currentTab!.direction : undefined}>
        {placed.map(item => {
          const tab = tabs.find(entry => entry.id === item)
          const owner = tabOf(paneTabsNow, item)
          const index = owner?.panes.indexOf(item) ?? 0
          const visible = shown && owner !== undefined && owner === currentTab
          const multiple = (owner?.panes.length ?? 0) > 1
          const focused = item === active
          const paneEnded = tab ? endedText(tab.summary) : undefined
          return (
            <div
              key={item}
              id={`${id}-pane-${item}`}
              className="terminal-pane"
              data-pane={item}
              data-focused={visible && focused ? '' : undefined}
              data-split={multiple ? '' : undefined}
              data-after={multiple && index > 0 ? owner!.direction : undefined}
              data-ended={paneEnded ? '' : undefined}
              hidden={!visible}
              style={owner ? paneBox(owner, index) : undefined}
              onFocusCapture={() => {
                if (tab && !focused) setActive(item)
              }}
              onPointerDownCapture={() => {
                if (tab && !focused) setActive(item)
              }}>
              {tab && (
                <TerminalScreen
                  target={target}
                  tab={tab}
                  visible={visible}
                  focusOnShow={(requested || focusScreen) && focused}
                  onSummary={updated}
                  onClosed={() => gone(tab.id)}
                  onSelection={text => setSelection(previous => ({ ...previous, [tab.id]: text }))}
                  onConnection={state => setConnection(previous => ({ ...previous, [tab.id]: state }))}
                  onInputFailed={text => setNotice({ tone: 'error', text })}
                  onHandle={handle => {
                    if (handle) handles.current.set(tab.id, handle)
                    else handles.current.delete(tab.id)
                    fill.screen(tab.id, handle)
                  }}
                />
              )}
              {tab && visible && (
                <Menu
                  label={terminalName(item)}
                  context={() => document.getElementById(`${id}-pane-${item}`)}
                  sections={[
                    {
                      id: 'output',
                      items: [
                        ...(selection[item]
                          ? [{ id: 'copy', label: '复制', icon: CopyGlyph, onSelect: () => void writeClipboard(selection[item]!) }]
                          : []),
                        ...(onCompose && !tab.summary.login
                          ? [{ id: 'attach', label: '加入对话', icon: MessageSquarePlus, onSelect: () => void attach(item) }]
                          : []),
                      ],
                    },
                    { id: 'split', items: splitItems(item) },
                    {
                      id: 'close',
                      items: [{ id: 'close', label: '关闭', icon: CloseGlyph, onSelect: () => void close([item], terminalName(item)) }],
                    },
                  ].filter(section => section.items.length > 0)}
                />
              )}
              {tab && multiple && (
                <div className="terminal-pane-head">
                  <span className="terminal-pane-name">{terminalName(item)}</span>
                  {paneEnded && (
                    <>
                      <span className="terminal-ended" role="status">
                        {paneEnded}
                      </span>
                      {!tab.summary.login && (
                        <Button size="xs" variant="primary" icon={RotateCcw} loading={opening} onClick={() => reopen(tab)}>
                          重新打开
                        </Button>
                      )}
                    </>
                  )}
                  <span className="terminal-space" />
                  <IconButton
                    size="xs"
                    className="terminal-pane-close"
                    icon={CloseGlyph}
                    label={`关闭${terminalName(item)}`}
                    tabIndex={-1}
                    onClick={() => void close([item], terminalName(item))}
                  />
                </div>
              )}
            </div>
          )
        })}
        {currentTab
          && currentTab.panes.length > 1
          && currentTab.panes.slice(0, -1).map((item, index) => {
            const total = currentTab.direction === 'row' ? area.width : area.height
            const least = paneMinShare(area, currentTab.direction)
            const start = currentTab.sizes.slice(0, index + 1).reduce((sum, size) => sum + size, 0)
            const pair = currentTab.sizes[index]! + currentTab.sizes[index + 1]!
            return (
              <ResizeHandle
                key={`${currentTab.key}-${item}`}
                className="terminal-pane-resize"
                label={currentTab.direction === 'row' ? '调整窗格宽度' : '调整窗格高度'}
                orientation={currentTab.direction === 'row' ? 'vertical' : 'horizontal'}
                value={Math.round((currentTab.sizes[index] ?? 0) * total)}
                min={Math.round(least * total)}
                max={Math.round((pair - least) * total)}
                style={
                  currentTab.direction === 'row'
                    ? { left: `calc(${start * 100}% - 3px)`, top: 0, bottom: 0 }
                    : { top: `calc(${start * 100}% - 3px)`, left: 0, right: 0 }
                }
                onResize={size =>
                  setLayout(previous => resizePanes(previous, item, currentTab.panes.indexOf(item), total > 0 ? size / total : 0.5, least))
                }
                onReset={() => setLayout(previous => evenPanes(previous, item))}
              />
            )
          })}
        {tabs.length === 0 && (
          <div className="terminal-empty">
            {/* Only a reason a terminal cannot start, with its one action; never a bare button to start one. */}
            {unavailable ? (
              <InlineNotice tone="warn">{unavailable}</InlineNotice>
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
            ) : failure && !opening ? (
              <InlineNotice
                tone="error"
                action={
                  <Button
                    size="xs"
                    onClick={() => {
                      setFocusScreen(true)
                      void terminals.open()
                    }}>
                    重试
                  </Button>
                }>
                {failure}
              </InlineNotice>
            ) : (
              <Loading label="正在打开终端…" />
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
              {/* A login is started again from the row that offers it, never as a plain shell under the Harness's name. */}
              {!current.summary.login && (
                <Button size="xs" variant="primary" icon={RotateCcw} loading={opening} onClick={() => reopen(current)}>
                  重新打开
                </Button>
              )}
            </>
          ) : (
            <span className="terminal-facts">
              {/* Whose account it runs as is the label's tooltip, on hover and focus; it takes no room in the foot. */}
              <Tooltip content={ACCOUNT_NOTE}>
                <span className="terminal-where" tabIndex={0}>
                  <VisibleText text={`${current.summary.shell} · ${current.summary.folder}`} />
                </span>
              </Tooltip>
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
        </footer>
      )}
      {confirm && (
        <ConfirmDialog
          title={`关闭${confirm.name}？`}
          message={confirm.program ? `「${confirm.program}」还在运行，关闭会结束它。` : '终端里还有程序在运行，关闭会结束它。'}
          confirmLabel="关闭终端"
          danger
          onConfirm={async () => {
            const done: string[] = []
            for (const item of confirm.ids) {
              const result = await terminals.close(item, true)
              if (result.kind === 'failed') {
                left(done)
                throw new MessageError(result.text)
              }
              done.push(item)
            }
            left(done)
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
export function TerminalScreen({
  target,
  tab,
  visible,
  focusOnShow = true,
  onSummary,
  onClosed,
  onSelection,
  onConnection,
  onInputFailed,
  onHandle,
}: {
  target: TerminalTarget
  tab: TerminalTab
  visible: boolean
  focusOnShow?: boolean
  onSummary(summary: TerminalSummary): void
  onClosed(): void
  onSelection(text: string): void
  onConnection(state: 'live' | 'reconnecting'): void
  onInputFailed(text: string): void
  /** Typing in for the person, once xterm is ready; null when the screen goes. */
  onHandle?: ((handle: ScreenHandle | null) => void) | undefined
}) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<{ terminal: Terminal; fit: FitAddon; link: TerminalLink } | null>(null)
  const [ready, setReady] = useState(false)
  const handlers = useRef({ onSummary, onClosed, onSelection, onConnection, onInputFailed, onHandle })
  handlers.current = { onSummary, onClosed, onSelection, onConnection, onInputFailed, onHandle }
  const summary = useRef(tab.summary)
  summary.current = tab.summary
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const { sessionId, workspaceId } = target

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
      const cursorBlink = () => summary.current.status === 'running' && motionAllowed()
      const terminal = new Terminal({
        fontFamily,
        fontSize,
        lineHeight: LINE_HEIGHT,
        cursorBlink: cursorBlink(),
        minimumContrastRatio: 4.5,
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
      const link = new TerminalLink(workspaceId === undefined ? { sessionId } : { workspaceId }, tab.id, {
        write: bytes => new Promise<void>(resolve => terminal.write(bytes, resolve)),
        reset: () => terminal.reset(),
        summary: next => handlers.current.onSummary(next),
        closed: () => handlers.current.onClosed(),
        connection: state => handlers.current.onConnection(state),
        inputFailed: text => handlers.current.onInputFailed(text),
      })
      term.current = { terminal, fit, link }
      // ⌘\ and the pane keys are the workbench's: xterm never encodes them for the shell.
      terminal.attachCustomKeyEventHandler(event => event.type !== 'keydown' || !isTerminalPaneKey(event))
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
      const unwatchMotion = watchMotion(() => {
        terminal.options.cursorBlink = cursorBlink()
      })
      cleanup.push(() => {
        handlers.current.onHandle?.(null)
        unwatchMotion()
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
      handlers.current.onHandle?.({ paste: data => link.sendWhole(data), focus: () => terminal.focus() })
      setReady(true)
    })
    return () => {
      disposed = true
      clearTimeout(settle.current)
      for (const step of cleanup) step()
      term.current = null
    }
  }, [sessionId, workspaceId, tab.id, layout])

  // The Host's word on size and state: a screen that is not the owner follows it; an ended one takes no more input.
  useEffect(() => {
    const current = term.current
    if (!current) return
    current.terminal.options.disableStdin = tab.summary.status !== 'running'
    current.terminal.options.cursorBlink = tab.summary.status === 'running' && motionAllowed()
    layout()
  }, [ready, tab.summary.status, tab.summary.cols, tab.summary.rows, tab.summary.sizeOwner, layout])

  useEffect(() => {
    if (!visible || !ready) return
    layout()
    if (focusOnShow) term.current?.terminal.focus()
  }, [visible, ready, layout, focusOnShow])

  return <div className="terminal-screen" ref={host} hidden={!visible} data-terminal-id={tab.id} data-status={tab.summary.status} />
}
