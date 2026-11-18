import { shortcutMatches } from '../../workbenchShortcuts.ts'
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { Camera, Hand, Monitor, Moon, RotateCw, Smartphone, SquareDashedMousePointer, Sun, SunMoon, Tablet } from 'lucide-react'
import type { TerminalSummary } from '@latch/protocol'
import {
  Button,
  ConfirmDialog,
  Icon,
  IconButton,
  InlineNotice,
  Loading,
  Menu,
  PanelTabs,
  SegmentedControl,
  Spinner,
  type IconComponent,
  type MenuSection,
  type PanelTab,
  ChevronLeftGlyph,
  ChevronRightGlyph,
  CloseGlyph,
  GlobeGlyph,
  MessageGlyph,
  MoreGlyph,
  PlusGlyph,
  RefreshGlyph,
  Tooltip,
} from '@latch/ui'
import { AgentsGlyph } from '../../agents/AgentAvatar.tsx'
import { api, MessageError } from '../../core/api.ts'
import type {
  BrowserColorScheme,
  BrowserConsoleEntry,
  BrowserImage,
  BrowserNetworkEntry,
  BrowserPreset,
  BrowserRect,
  ShellBrowser,
} from '../../core/shell.ts'
import { VisibleText } from '../../components/VisibleText.tsx'
import {
  BROWSER_TAB_LIMIT,
  PICK_LIMIT,
  PRESETS,
  RETRY_EVERY_MS,
  RETRY_FOR_MS,
  SCHEMES,
  consoleLine,
  cropBox,
  pointInside,
  elementDraft,
  failedRequest,
  footerParts,
  hostLabel,
  imageName,
  isBlank,
  logsDraft,
  networkStatus,
  pageLabel,
  placeView,
  presetCaption,
  PHONE_BEZEL,
  safeAreaHint,
  readRecent,
  saveRecent,
  sizeLabel,
  tabTitle,
  troubleOf,
  withRecent,
} from './model.ts'
import { useBrowserTabs } from './useBrowserTabs.ts'
import { defineCopy, formatNumber, plural } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    partition: '这个项目的网页登录只在内存里，退出 Latch 即清除；它不是沙箱。',
    safeArea: '安全区示意',
    noElement: '那里没有可以选取的元素',
    pageChanged: '页面在选取时变了，只加入了截图',
    redacted: '加入的内容里有像密钥的文字，已隐藏',
    noScreenshot: '没有截到画面，请重试',
    viewport: '视口',
    fit: '适应面板',
    current: '当前',
    rotate: '旋转',
    pickSize: '先选一个尺寸',
    appearance: '外观',
    zoomValue: (percent: number) => `缩放 ${formatNumber(percent)}%`,
    zoom: '缩放',
    zoomIn: '放大',
    zoomOut: '缩小',
    actualSize: '实际大小',
    devTools: '开发者工具',
    systemBrowser: '在系统浏览器中打开',
    noPage: '这个标签还没有打开网页',
    clearData: '清除这个项目的浏览数据…',
    close: (value1: string | number) => `关闭 ${value1}`,
    browser: '浏览器',
    tabs: '浏览器标签',
    otherTabs: '其他会话的标签',
    closeOther: '关闭其他会话的标签',
    closeAll: '全部关闭',
    otherTabCount: (count: number) => `其他会话的标签 · ${formatNumber(count)}`,
    newTab: '新标签',
    tabLimit: (limit: number) => `最多 ${formatNumber(limit)} 个标签`,
    toolbar: '浏览器工具',
    back: '后退',
    forward: '前进',
    stop: '停止',
    reload: '重新载入',
    address: '地址',
    addressHint: '网址或 localhost 端口',
    viewportFit: '视口：适应面板',
    viewportSelected: (value1: string | number) => `视口：${value1}`,
    appearanceSelected: (value1: string | number) => `外观：${value1}`,
    screenshot: '截图',
    screenshotInfo: '截图放进草稿 · 发送后交给模型服务',
    noAttachment: '现在不能添加附件',
    selectElement: '选取元素',
    more: '更多',
    readingTabs: '正在读取标签…',
    waiting: (value1: string | number) => `等待 ${value1}…`,
    crashed: '页面崩溃了',
    connectFailed: (value1: string | number, value2: string | number) => `连不上 ${value1}（${value2}）`,
    selectAria: '选取元素：点按一个元素，⇧ 点按可多选，esc 结束',
    agentControl: 'Agent 正在操作',
    takeOver: '接手',
    personControl: '你在操作',
    handBack: '交还给 Agent',
    selectHelp: '选取元素 · 点按一个元素，⇧ 点按可多选，esc 结束',
    clearTitle: '清除这个项目的浏览数据？',
    clearMessage: '这个项目在浏览器里的登录、Cookie、存储与缓存都会清除。',
    clear: '清除',
    clearFailed: '没有清除，请重试',
    cleared: '已清除这个项目的浏览数据',
    noServices: '终端里的本地服务会列在这里',
    services: '本地服务',
    recent: '最近打开',
    noErrors: '没有可以加入的错误',
    noFailed: '没有失败的请求',
    logTypes: '控制台或网络',
    console: '控制台',
    network: '网络',
    addSelected: '把选中的条目加入草稿',
    lastErrors: '把最近 20 条错误加入草稿',
    lastFailed: '把最近 20 个失败的请求加入草稿',
    add: '加入对话',
    reading: '正在读取…',
    emptyConsole: '没有控制台消息',
    emptyRequests: '没有请求',
  },
  {
    partition: 'This project’s website logins live in memory and clear when Latch quits. The partition doesn’t provide sandboxing.',
    safeArea: 'Safe area guide',
    noElement: 'There’s no selectable element there',
    pageChanged: 'The page changed during selection. Only the screenshot was added.',
    redacted: 'Text resembling a secret key was hidden from the added content',
    noScreenshot: 'Couldn’t capture the screen. Try again.',
    viewport: 'Viewport',
    fit: 'Fit to panel',
    current: 'Current',
    rotate: 'Rotate',
    pickSize: 'Choose a size first',
    appearance: 'Appearance',
    zoomValue: (percent: number) => `Zoom ${formatNumber(percent)}%`,
    zoom: 'Zoom',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    actualSize: 'Actual size',
    devTools: 'Developer tools',
    systemBrowser: 'Open in system browser',
    noPage: 'This tab hasn’t opened a page yet',
    clearData: 'Clear browsing data for this project…',
    close: (value1: string | number) => `Close ${value1}`,
    browser: 'Browser',
    tabs: 'Browser tabs',
    otherTabs: 'Tabs from other sessions',
    closeOther: 'Close tabs from other sessions',
    closeAll: 'Close all',
    otherTabCount: (count: number) => `Tabs from other sessions · ${formatNumber(count)}`,
    newTab: 'New tab',
    tabLimit: (limit: number) => `Up to ${plural(limit, { one: '{n} tab', other: '{n} tabs' })}`,
    toolbar: 'Browser tools',
    back: 'Back',
    forward: 'Forward',
    stop: 'Stop',
    reload: 'Reload',
    address: 'Address',
    addressHint: 'URL or localhost port',
    viewportFit: 'Viewport: Fit to panel',
    viewportSelected: (value1: string | number) => `Viewport: ${value1}`,
    appearanceSelected: (value1: string | number) => `Appearance: ${value1}`,
    screenshot: 'Screenshot',
    screenshotInfo: 'Add a screenshot to the draft. It goes to the model service when sent.',
    noAttachment: 'Attachments aren’t available right now',
    selectElement: 'Select element',
    more: 'More',
    readingTabs: 'Reading tabs…',
    waiting: (value1: string | number) => `Waiting for ${value1}…`,
    crashed: 'The page crashed',
    connectFailed: (value1: string | number, value2: string | number) => `Couldn’t connect to ${value1} (${value2})`,
    selectAria: 'Select an element. Shift-click to select several. Press Esc to finish.',
    agentControl: 'Agent is in control',
    takeOver: 'Take over',
    personControl: 'You’re in control',
    handBack: 'Return control to agent',
    selectHelp: 'Select element · Shift-click for multiple · Esc to finish',
    clearTitle: 'Clear this project’s browsing data?',
    clearMessage: 'This clears website logins, cookies, storage and cache for this project.',
    clear: 'Clear',
    clearFailed: 'Couldn’t clear the data. Try again.',
    cleared: 'Browsing data cleared for this project',
    noServices: 'Local services started in a terminal will appear here',
    services: 'Local services',
    recent: 'Recently opened',
    noErrors: 'No errors to add',
    noFailed: 'No failed requests',
    logTypes: 'Console or network',
    console: 'Console',
    network: 'Network',
    addSelected: 'Add selected entries to the draft',
    lastErrors: 'Add the last 20 errors to the draft',
    lastFailed: 'Add the last 20 failed requests to the draft',
    add: 'Add to chat',
    reading: 'Reading…',
    emptyConsole: 'No console messages',
    emptyRequests: 'No requests',
  },
)

/** Below this the viewport and appearance menus fold into ⋯. */
const NARROW = 480
const HIT_EVERY_MS = 80
const LOGS_EVERY_MS = 1_000

const LoadingGlyph = (({ className }: { className?: string }) => <Spinner size={12} className={className} />) as unknown as IconComponent

const presetIcon = (preset: BrowserPreset): IconComponent =>
  preset === 'phone' || preset === 'phone-small' || preset === 'phone-large' || preset === 'android'
    ? Smartphone
    : preset === 'tablet'
      ? Tablet
      : preset === 'desktop'
        ? Monitor
        : GlobeGlyph
const schemeIcon = (scheme: BrowserColorScheme): IconComponent => (scheme === 'light' ? Sun : scheme === 'dark' ? Moon : SunMoon)

export interface BrowserPanelProps {
  shell: ShellBrowser
  sessionId: string
  projectId: string
  deviceId: string
  /** The tab is on screen: tabs are placed over the canvas only then. */
  shown: boolean
  /** The session has a terminal tab here: the blank page lists the local services its terminals announced. */
  terminals: boolean
  /**
   * A new tab to open: at an address (a local service the terminal announced), or blank (the right panel's 「+」);
   * `nonce` makes each request new.
   */
  request?: { url?: string; nonce: number } | undefined
  /** Puts text into the composer draft without sending; absent while the composer takes none. */
  onCompose?: ((text: string) => void) | undefined
  /** Puts images into the draft's attachments. */
  onAttach?: ((files: File[]) => void) | undefined
}

type Picked = { rect: BrowserRect; tag: string }

/**
 * Whether something of the page's lies over the canvas, where the tab's view would hide it: a menu, a dialog or a
 * popover over any part of it, or anything else (a page, a scrim) found above it at its middle or corners.
 */
/**
 * A tooltip is a hover's few words beside a control, not a layer the person works in: the view stays live under it (the
 * part over the canvas is drawn under the view), so a pointer resting on 加入对话 never freezes the tab, nor keeps the
 * Agent out of it.
 */
const TOOLTIP = '[role="tooltip"]'

export function overlayCovers(canvas: HTMLElement, doc: Pick<Document, 'elementFromPoint' | 'querySelectorAll'> = document): boolean {
  const area = canvas.getBoundingClientRect()
  if (area.width === 0 || area.height === 0) return false
  const inset = 12
  const points = [
    [area.left + area.width / 2, area.top + area.height / 2],
    [area.left + inset, area.top + inset],
    [area.right - inset, area.top + inset],
    [area.left + inset, area.bottom - inset],
    [area.right - inset, area.bottom - inset],
  ] as const
  for (const [x, y] of points) {
    const top = doc.elementFromPoint(x, y)
    if (top && !canvas.contains(top) && !top.closest(TOOLTIP)) return true
  }
  for (const element of doc.querySelectorAll<HTMLElement>(':popover-open, dialog[open]')) {
    if (canvas.contains(element) || element.matches(TOOLTIP)) continue
    const box = element.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) continue
    if (box.right > area.left && box.left < area.right && box.bottom > area.top && box.top < area.bottom) return true
  }
  return false
}

/** Follows the page's overlays: true while one covers the canvas. */
function useOverlay(canvas: React.RefObject<HTMLElement | null>, active: boolean): boolean {
  const [covered, setCovered] = useState(false)
  useEffect(() => {
    if (!active) {
      setCovered(false)
      return
    }
    let frame = 0
    const check = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (canvas.current) setCovered(overlayCovers(canvas.current))
      })
    }
    const observer = new MutationObserver(check)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'popover', 'class', 'style'],
    })
    document.addEventListener('toggle', check, true)
    window.addEventListener('resize', check)
    check()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('toggle', check, true)
      window.removeEventListener('resize', check)
    }
  }, [active, canvas])
  return covered
}

/** The canvas's rectangle in CSS pixels of the page, followed through resizes and the panel's slide. */
function useCanvasRect(canvas: React.RefObject<HTMLElement | null>, active: boolean): BrowserRect | null {
  const [rect, setRect] = useState<BrowserRect | null>(null)
  useLayoutEffect(() => {
    if (!active) {
      setRect(null)
      return
    }
    let frame = 0
    let until = 0
    const read = () => {
      const element = canvas.current
      if (!element) return
      const box = element.getBoundingClientRect()
      const next = { x: box.left, y: box.top, width: box.width, height: box.height }
      setRect(previous =>
        previous && previous.x === next.x && previous.y === next.y && previous.width === next.width && previous.height === next.height
          ? previous
          : next,
      )
    }
    // A slide or resize moves the canvas without changing its size: follow it frame by frame for a moment.
    const follow = () => {
      until = performance.now() + 450
      cancelAnimationFrame(frame)
      const step = () => {
        read()
        if (performance.now() < until) frame = requestAnimationFrame(step)
      }
      step()
    }
    const observer = new ResizeObserver(follow)
    if (canvas.current) observer.observe(canvas.current)
    observer.observe(document.documentElement)
    window.addEventListener('resize', follow)
    document.addEventListener('transitionrun', follow, true)
    document.addEventListener('transitionend', follow, true)
    follow()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', follow)
      document.removeEventListener('transitionrun', follow, true)
      document.removeEventListener('transitionend', follow, true)
    }
  }, [active, canvas])
  return rect
}

/** A point of the frozen frame, from its top-left corner in CSS pixels of the page. */
function pointOf(event: ReactMouseEvent<HTMLElement>) {
  const box = event.currentTarget.getBoundingClientRect()
  return { x: Math.max(0, event.clientX - box.left), y: Math.max(0, event.clientY - box.top) }
}

/**
 * The frame Latch draws around a preset's page, outside it: a plain line, and for a phone a rounded bezel whose inner
 * edge marks how far the top and bottom safe area reach into the page. The page itself is not told (no
 * `env(safe-area-inset-*)`); the native view covers anything drawn over it, so nothing is.
 */
function PresetFrame({
  rect,
  hint,
}: {
  rect: BrowserRect
  hint: { side: 'vertical' | 'horizontal'; start: number; end: number } | undefined
}) {
  if (!hint)
    return (
      <span
        className="browser-preset-frame"
        style={{ left: rect.x - 1, top: rect.y - 1, width: rect.width + 2, height: rect.height + 2 }}
      />
    )
  const vertical = hint.side === 'vertical'
  const mark = (at: 'start' | 'end', size: number) =>
    size > 0 ? (
      <span
        key={at}
        className="browser-safe-area"
        data-side={hint.side}
        data-at={at}
        style={
          vertical
            ? { height: size, [at === 'start' ? 'top' : 'bottom']: PHONE_BEZEL }
            : { width: size, [at === 'start' ? 'left' : 'right']: PHONE_BEZEL }
        }
      />
    ) : null
  return (
    <span
      className="browser-phone-frame"
      title={COPY.safeArea}
      style={{
        left: rect.x - PHONE_BEZEL,
        top: rect.y - PHONE_BEZEL,
        width: rect.width + PHONE_BEZEL * 2,
        height: rect.height + PHONE_BEZEL * 2,
      }}>
      {mark('start', hint.start)}
      {mark('end', hint.end)}
    </span>
  )
}

async function imageFile(image: BrowserImage, name: string): Promise<File> {
  return new File([image.data.slice().buffer], name, { type: 'image/png' })
}

/** A part of a frame as a PNG file, cut by the page from the frame it froze. */
async function cropFile(frame: BrowserImage, box: BrowserRect, name: string): Promise<File | undefined> {
  try {
    const bitmap = await createImageBitmap(new Blob([frame.data.slice().buffer], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = box.width
    canvas.height = box.height
    canvas.getContext('2d')?.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    return blob ? new File([blob], name, { type: 'image/png' }) : undefined
  } catch {
    return undefined
  }
}

function useObjectUrl(image: BrowserImage | null): string | undefined {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!image) {
      setUrl(undefined)
      return
    }
    const value = URL.createObjectURL(new Blob([image.data.slice().buffer], { type: 'image/png' }))
    setUrl(value)
    return () => URL.revokeObjectURL(value)
  }, [image])
  return url
}

/**
 * The 浏览器 tab: this session's preview tabs, which the desktop app's main process lays over the canvas. Only the
 * desktop app's own window on this Mac gets here (`latchShell.browser` version 2); the page never sees inside a tab,
 * only what main reports, and its own overlays stand in with the tab's last frame.
 */
export function BrowserPanel({ shell, sessionId, projectId, deviceId, shown, terminals, request, onCompose, onAttach }: BrowserPanelProps) {
  const id = useId()
  const sent = useRef(new Map<string, string>())
  // Main hid a tab: it is placed again from scratch.
  const browser = useBrowserTabs({ shell, sessionId, projectId, onHidden: tabId => sent.current.delete(tabId) })
  const { tabs, current } = browser
  const state = current?.state
  const section = useRef<HTMLElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [address, setAddress] = useState<string>()
  const [frame, setFrame] = useState<BrowserImage | null>(null)
  const [picking, setPicking] = useState(false)
  const [hover, setHover] = useState<Picked>()
  const [picked, setPicked] = useState<Picked[]>([])
  const [drawer, setDrawer] = useState(false)
  const [busy, setBusy] = useState<'capture' | 'pick'>()
  const [clearing, setClearing] = useState(false)
  const [recent, setRecent] = useState(() => readRecent(deviceId, projectId))
  const [services, setServices] = useState<string[]>([])
  const canvasRect = useCanvasRect(canvas, shown)
  const covered = useOverlay(canvas, shown && !!current)
  const blank = !current || isBlank(state)
  const trouble = troubleOf(current, now)
  const placed = canvasRect && state ? placeView(canvasRect, state.viewport.preset, state.viewport.rotated) : null
  /** The page shows in the view only while nothing of the page's own stands in for it. */
  const showsView = shown && !!current && !blank && trouble === null
  const freeze = showsView && (covered || picking)

  useEffect(() => {
    const element = section.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Each tab of this session goes where the panel says: the shown one over the canvas, the rest hidden.
  useEffect(() => {
    for (const tab of tabs) {
      const bounds = tab.tabId === current?.tabId && showsView && placed && placed.rect.width > 0 ? placed.rect : null
      const key = JSON.stringify(bounds)
      if (sent.current.get(tab.tabId) === key) continue
      sent.current.set(tab.tabId, key)
      void shell.setBounds(tab.tabId, bounds)
    }
  })
  // Main hears which session's panel is in sight: the Agent works only in a tab the person can see.
  useEffect(() => {
    if (!shell.showing) return
    void shell.showing(shown ? sessionId : null)
    return () => {
      if (shown) void shell.showing?.(null)
    }
  }, [shell, sessionId, shown])
  // The tabs stay with main when the panel goes (another session, a reload): hidden until a panel places them again.
  useEffect(() => {
    const placedTabs = sent.current
    return () => {
      for (const tabId of placedTabs.keys()) {
        void shell.setBounds(tabId, null)
        void shell.occlude(tabId, false)
      }
      placedTabs.clear()
    }
  }, [shell, sessionId])

  // An overlay of the page over the canvas, or 选取元素: the view hides and its last frame stands in.
  const frozenTab = useRef<string | undefined>(undefined)
  useEffect(() => {
    const tabId = current?.tabId
    if (freeze && tabId) {
      frozenTab.current = tabId
      let live = true
      void shell.occlude(tabId, true).then(answer => {
        if (live && answer.ok) setFrame(answer.image)
      })
      return () => {
        live = false
      }
    }
    const was = frozenTab.current
    frozenTab.current = undefined
    setFrame(null)
    if (was) void shell.occlude(was, false)
    return undefined
  }, [freeze, current?.tabId])

  // A local address that refuses the connection is a dev server starting: try again every two seconds for a minute.
  useEffect(() => {
    if (!shown || !current || current.refusedSince === undefined) return
    const left = current.refusedSince + RETRY_FOR_MS - Date.now()
    if (left <= 0) return
    const timer = setTimeout(
      () => {
        setNow(Date.now())
        if (!current.state.loading && Date.now() - (current.refusedSince ?? 0) < RETRY_FOR_MS) void shell.reload(current.tabId)
      },
      Math.min(RETRY_EVERY_MS, left),
    )
    return () => clearTimeout(timer)
  }, [shown, current, now])
  useEffect(() => {
    setNow(Date.now())
  }, [state])

  // The project's recent addresses on this device, as tabs load them.
  useEffect(() => {
    if (!state || state.loading || state.error !== null || isBlank(state)) return
    setRecent(previous => {
      const next = withRecent(previous, state.url)
      if (next.join('\n') !== previous.join('\n')) saveRecent(deviceId, projectId, next)
      return next
    })
  }, [state?.url, state?.loading, state?.error])

  // The blank page lists the local services this session's terminals announced.
  useEffect(() => {
    if (!shown || !blank || !terminals) return
    const controller = new AbortController()
    void api<{ terminals: TerminalSummary[] }>(`tasks/${encodeURIComponent(sessionId)}/terminals`, { signal: controller.signal })
      .then(answer => {
        const origins = answer.terminals.flatMap(terminal =>
          terminal.status === 'running' ? terminal.services.map(item => item.origin) : [],
        )
        setServices([...new Set(origins)])
      })
      .catch(() => {
        if (!controller.signal.aborted) setServices([])
      })
    return () => controller.abort()
  }, [shown, blank, terminals, sessionId])

  /** The address field, a service or a recent address: in the tab shown, else (or from the terminal) in a new tab. */
  const openAddress = async (text: string, fresh = false) => {
    if (current && !fresh) return browser.navigate(current.tabId, text)
    return browser.open(text)
  }

  // A local service the terminal asked to open.
  // Starts empty: the panel mounts after the terminal set the request it was opened for.
  const handled = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!request || handled.current === request.nonce || browser.listed !== 'ready') return
    handled.current = request.nonce
    if (request.url === undefined) {
      if (browser.total < BROWSER_TAB_LIMIT) void browser.open()
    } else void openAddress(request.url, true)
  }, [request, browser.listed])

  const stopPicking = () => {
    setPicking(false)
    setHover(undefined)
    setPicked([])
  }
  useEffect(() => {
    if (!showsView) stopPicking()
  }, [showsView, current?.tabId])

  // ⇧⌘S picks while the panel shows; Esc ends it.
  useEffect(() => {
    if (!shown) return
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && picking) {
        event.preventDefault()
        stopPicking()
        return
      }
      if (shortcutMatches(event, 'pick', true) && showsView && onCompose) {
        event.preventDefault()
        setPicking(value => !value)
      }
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [shown, picking, showsView, onCompose])

  const lastHit = useRef(0)
  const hit = (event: ReactMouseEvent<HTMLElement>) => {
    if (!current) return
    const time = performance.now()
    if (time - lastHit.current < HIT_EVERY_MS) return
    lastHit.current = time
    const tabId = current.tabId
    void shell.hitTest(tabId, pointOf(event)).then(answer => {
      if (answer.ok) setHover({ rect: answer.target.rect, tag: answer.target.tag })
    })
  }
  const pick = async (event: ReactMouseEvent<HTMLElement>) => {
    if (!current || !onCompose || busy) return
    const many = event.shiftKey
    const point = pointOf(event)
    setBusy('pick')
    try {
      const answer = await shell.annotate(current.tabId, point)
      if (!answer.ok) {
        browser.say(() => COPY.noElement)
        return
      }
      const { target } = answer
      const name = imageName('元素', target.url)
      // The words come from the live page at the click; the picture from the frozen frame. When the element the page
      // names no longer covers the point clicked on the frame, only the picture around the point goes in.
      const matches = pointInside(target.rect, point, 2)
      const area = matches ? target.rect : { x: point.x - 60, y: point.y - 30, width: 120, height: 60 }
      const box = frame && placed ? cropBox(area, frame, placed.rect.width) : null
      const crop =
        (frame && box ? await cropFile(frame, box, name) : undefined)
        ?? (matches && target.image ? await imageFile(target.image, name) : undefined)
      if (crop) onAttach?.([crop])
      if (!matches) {
        browser.say(() => COPY.pageChanged)
        stopPicking()
        return
      }
      const draft = elementDraft(target)
      onCompose(draft.text)
      const next = [...picked, { rect: target.rect, tag: target.tag }]
      if (draft.redacted) browser.say(() => COPY.redacted)
      if (many && next.length < PICK_LIMIT) setPicked(next)
      else stopPicking()
    } finally {
      setBusy(undefined)
    }
  }

  const screenshot = async () => {
    if (!current || !onAttach) return
    setBusy('capture')
    try {
      const answer = await shell.capture(current.tabId)
      if (!answer.ok) {
        browser.say(() => COPY.noScreenshot)
        return
      }
      onAttach([await imageFile(answer.image, imageName('截图', state?.url ?? ''))])
    } finally {
      setBusy(undefined)
    }
  }

  const submitAddress = (event: FormEvent) => {
    event.preventDefault()
    const text = (address ?? '').trim()
    if (!text) return
    void openAddress(text).then(ok => {
      if (ok) {
        setAddress(undefined)
        ;(document.activeElement as HTMLElement | null)?.blur()
      }
    })
  }

  const narrow = width > 0 && width < NARROW
  const preset = state?.viewport.preset ?? 'fit'
  const rotated = state?.viewport.rotated ?? false
  const scheme = state?.colorScheme ?? 'system'
  const full = browser.total >= BROWSER_TAB_LIMIT
  const viewportSection: MenuSection = {
    id: 'viewport',
    label: narrow ? COPY.viewport : undefined,
    items: [
      {
        id: 'fit',
        label: COPY.fit,
        checked: preset === 'fit',
        ...(narrow && preset === 'fit' ? { meta: COPY.current } : {}),
        onSelect: () => void setViewport('fit', false),
      },
      ...PRESETS.map(item => ({
        id: item.id,
        label: item.label,
        meta: narrow && preset === item.id ? COPY.current : `${item.width} × ${item.height}${item.ratio !== 1 ? ` @${item.ratio}x` : ''}`,
        checked: preset === item.id,
        onSelect: () => void setViewport(item.id, rotated),
      })),
    ],
  }
  const rotateSection: MenuSection = {
    id: 'rotate',
    items: [
      {
        id: 'rotate',
        label: COPY.rotate,
        icon: RotateCw,
        ...(preset === 'fit' ? { disabledReason: COPY.pickSize } : {}),
        onSelect: () => void setViewport(preset, !rotated),
      },
    ],
  }
  const schemeSection: MenuSection = {
    id: 'scheme',
    label: narrow ? COPY.appearance : undefined,
    items: SCHEMES.map(item => ({
      id: item.id,
      label: item.label,
      checked: scheme === item.id,
      ...(narrow && scheme === item.id ? { meta: COPY.current } : {}),
      onSelect: () => {
        if (current) void browser.colorScheme(current.tabId, item.id)
      },
    })),
  }
  const setViewport = async (next: BrowserPreset, turn: boolean) => {
    if (current) await browser.viewport(current.tabId, next, next === 'fit' ? false : turn)
  }
  const pageUrl = state && !isBlank(state) ? state.url : undefined
  const moreSections: MenuSection[] = [
    ...(narrow ? [viewportSection, rotateSection, schemeSection] : []),
    {
      id: 'zoom',
      label: state ? COPY.zoomValue(Math.round(state.zoom * 100)) : COPY.zoom,
      items: [
        { id: 'zoom-in', label: COPY.zoomIn, onSelect: () => current && void shell.zoom(current.tabId, 'in') },
        { id: 'zoom-out', label: COPY.zoomOut, onSelect: () => current && void shell.zoom(current.tabId, 'out') },
        { id: 'zoom-reset', label: COPY.actualSize, onSelect: () => current && void shell.zoom(current.tabId, 'reset') },
      ],
    },
    {
      id: 'tools',
      items: [
        { id: 'devtools', label: COPY.devTools, onSelect: () => current && void shell.devTools(current.tabId) },
        {
          id: 'external',
          label: COPY.systemBrowser,
          ...(pageUrl ? {} : { disabledReason: COPY.noPage }),
          onSelect: () => {
            if (pageUrl) window.open(pageUrl, '_blank', 'noopener,noreferrer')
          },
        },
        { id: 'clear', label: COPY.clearData, onSelect: () => setClearing(true) },
      ],
    },
  ]

  // The Agent's tabs, and those it acts in now, carry its mark; loading still spins.
  const panelTabs: Array<PanelTab<string>> = tabs.map(tab => ({
    value: tab.tabId,
    label: tabTitle(tab.state),
    icon: tab.state.loading ? LoadingGlyph : tab.state.opener === 'agent' || tab.state.control === 'agent' ? AgentsGlyph : GlobeGlyph,
    controls: id,
    closeLabel: COPY.close(tabTitle(tab.state)),
  }))
  const shownAddress = address ?? (state && !isBlank(state) ? state.url : '')
  const parts = footerParts(state?.logs)
  /** Who acts in the tab shown: the Agent, or the person who took it over. */
  const control = state?.control ?? null
  const viewRect = placed && canvasRect ? { ...placed.rect, x: placed.rect.x - canvasRect.x, y: placed.rect.y - canvasRect.y } : null
  const frameUrl = useObjectUrl(frame)

  return (
    <section ref={section} className="browser-panel" aria-label={COPY.browser} data-narrow={narrow ? '' : undefined}>
      <PanelTabs
        label={COPY.tabs}
        className="browser-tabs"
        value={current?.tabId ?? ''}
        tabs={panelTabs}
        onValueChange={browser.select}
        onClose={tabId => void browser.close(tabId)}
        actions={
          <>
            {browser.others.length > 0 && (
              <Menu
                label={COPY.otherTabs}
                align="end"
                sections={[
                  {
                    id: 'others',
                    label: COPY.closeOther,
                    items: browser.others.map(tab => ({
                      id: tab.tabId,
                      label: tabTitle(tab.state),
                      ...(hostLabel(tab.state.url) ? { meta: hostLabel(tab.state.url) } : {}),
                      icon: CloseGlyph,
                      onSelect: () => void browser.close(tab.tabId),
                    })),
                  },
                  {
                    id: 'all',
                    items: [
                      {
                        id: 'all',
                        label: COPY.closeAll,
                        onSelect: () => {
                          for (const tab of browser.others) void browser.close(tab.tabId)
                        },
                      },
                    ],
                  },
                ]}
                trigger={props => (
                  <Button {...props} size="xs" variant="ghost">
                    {COPY.otherTabCount(browser.others.length)}
                  </Button>
                )}
              />
            )}
            <IconButton
              size="xs"
              icon={PlusGlyph}
              label={COPY.newTab}
              {...(full ? { tooltip: COPY.tabLimit(BROWSER_TAB_LIMIT) } : {})}
              disabled={full}
              onClick={() => void browser.open()}
            />
          </>
        }
      />
      <div className="browser-toolbar" role="toolbar" aria-label={COPY.toolbar}>
        <IconButton
          size="xs"
          icon={ChevronLeftGlyph}
          label={COPY.back}
          disabled={!state?.canGoBack}
          onClick={() => current && void shell.back(current.tabId)}
        />
        <IconButton
          size="xs"
          icon={ChevronRightGlyph}
          label={COPY.forward}
          disabled={!state?.canGoForward}
          onClick={() => current && void shell.forward(current.tabId)}
        />
        {state?.loading ? (
          <IconButton size="xs" icon={CloseGlyph} label={COPY.stop} onClick={() => current && void shell.stop(current.tabId)} />
        ) : (
          <IconButton
            size="xs"
            icon={RefreshGlyph}
            label={COPY.reload}
            disabled={!pageUrl}
            onClick={() => current && void shell.reload(current.tabId)}
          />
        )}
        <form className="browser-address" onSubmit={submitAddress}>
          <input
            type="text"
            aria-label={COPY.address}
            placeholder={COPY.addressHint}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            value={shownAddress}
            onChange={event => {
              setAddress(event.target.value)
              browser.setFailure(undefined)
            }}
            onFocus={event => {
              setAddress(shownAddress)
              event.currentTarget.select()
            }}
            onBlur={() => setAddress(undefined)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                setAddress(undefined)
                event.currentTarget.blur()
              }
            }}
          />
        </form>
        {!narrow && (
          <>
            <Menu
              label={COPY.viewport}
              selection
              align="end"
              sections={[viewportSection]}
              trigger={props => (
                <IconButton
                  {...props}
                  size="xs"
                  icon={presetIcon(preset)}
                  label={preset === 'fit' ? COPY.viewportFit : COPY.viewportSelected(PRESETS.find(item => item.id === preset)?.label ?? '')}
                  pressed={preset !== 'fit'}
                  disabled={!current}
                />
              )}
            />
            {preset !== 'fit' && (
              <IconButton
                size="xs"
                icon={RotateCw}
                label={COPY.rotate}
                pressed={rotated}
                disabled={!current}
                onClick={() => void setViewport(preset, !rotated)}
              />
            )}
            <Menu
              label={COPY.appearance}
              selection
              align="end"
              sections={[schemeSection]}
              trigger={props => (
                <IconButton
                  {...props}
                  size="xs"
                  icon={schemeIcon(scheme)}
                  label={COPY.appearanceSelected(SCHEMES.find(item => item.id === scheme)?.label ?? '')}
                  pressed={scheme !== 'system'}
                  disabled={!current}
                />
              )}
            />
          </>
        )}
        <IconButton
          size="xs"
          icon={Camera}
          label={COPY.screenshot}
          tooltip={onAttach ? COPY.screenshotInfo : COPY.noAttachment}
          disabled={!showsView || !onAttach || busy === 'capture'}
          onClick={() => void screenshot()}
        />
        <IconButton
          size="xs"
          icon={SquareDashedMousePointer}
          label={COPY.selectElement}
          shortcut="⇧⌘S"
          pressed={picking}
          disabled={!showsView || !onCompose}
          onClick={() => setPicking(value => !value)}
        />
        <Menu
          label={COPY.more}
          align="end"
          sections={moreSections}
          trigger={props => <IconButton {...props} size="xs" icon={MoreGlyph} label={COPY.more} disabled={!current} />}
        />
      </div>
      {(browser.failure || browser.notice) && (
        <p className="browser-notice" role="status">
          {browser.failure ?? browser.notice}
        </p>
      )}
      <div
        ref={canvas}
        className="browser-canvas"
        id={id}
        role="tabpanel"
        aria-label={current ? tabTitle(state) : COPY.browser}
        data-preset={preset !== 'fit' && showsView ? '' : undefined}
        data-picking={picking ? '' : undefined}
        data-agent={control === 'agent' ? '' : undefined}>
        {browser.listed === 'loading' && tabs.length === 0 ? (
          <Loading label={COPY.readingTabs} />
        ) : blank ? (
          <BlankPage
            services={services}
            recent={recent}
            onOpen={url => {
              void openAddress(url)
            }}
          />
        ) : trouble ? (
          <div className="browser-trouble" role="status">
            {trouble.kind === 'waiting' ? (
              <span className="browser-waiting">
                <Spinner size={14} />
                <VisibleText text={COPY.waiting(trouble.host)} />
              </span>
            ) : (
              <InlineNotice
                tone="error"
                action={
                  <Button size="xs" icon={RefreshGlyph} onClick={() => current && void shell.reload(current.tabId)}>
                    {COPY.reload}
                  </Button>
                }>
                {trouble.kind === 'crashed' ? COPY.crashed : COPY.connectFailed(trouble.host, trouble.reason)}
              </InlineNotice>
            )}
          </div>
        ) : (
          <>
            {viewRect && placed?.size && <PresetFrame rect={viewRect} hint={safeAreaHint(preset, rotated, placed.scale)} />}
            {viewRect && placed?.size && (
              <span
                className="browser-caption"
                style={{ top: viewRect.y + viewRect.height + 4 + (safeAreaHint(preset, rotated, 1) ? PHONE_BEZEL : 0) }}>
                {presetCaption(placed.size, placed.scale, PRESETS.find(item => item.id === preset)?.ratio)}
              </span>
            )}
            {viewRect && frameUrl && (
              <img
                className="browser-frame"
                src={frameUrl}
                alt=""
                style={{ left: viewRect.x, top: viewRect.y, width: viewRect.width, height: viewRect.height }}
              />
            )}
            {viewRect && picking && (
              <div
                className="browser-pick"
                role="application"
                aria-label={COPY.selectAria}
                style={{ left: viewRect.x, top: viewRect.y, width: viewRect.width, height: viewRect.height }}
                onMouseMove={hit}
                onMouseLeave={() => setHover(undefined)}
                onClick={event => void pick(event)}>
                {[...picked, ...(hover ? [hover] : [])].map((item, index) => (
                  <span
                    key={index}
                    className="browser-pick-box"
                    data-hover={item === hover ? '' : undefined}
                    style={{ left: item.rect.x, top: item.rect.y, width: item.rect.width, height: item.rect.height }}
                  />
                ))}
                {busy === 'pick' && <Spinner size={14} className="browser-pick-busy" />}
              </div>
            )}
          </>
        )}
      </div>
      {drawer && current && !blank && (
        <BrowserDrawer
          shell={shell}
          tabId={current.tabId}
          page={pageLabel(state?.url ?? '') || hostLabel(state?.url ?? '')}
          onCompose={onCompose}
          onNotice={browser.say}
        />
      )}
      <footer className="browser-foot" data-control={control ?? undefined}>
        {control === 'agent' ? (
          <span className="browser-foot-agent" role="status">
            <Spinner size={12} />
            <span className="browser-foot-activity">{state?.activity || COPY.agentControl}</span>
            {browser.takeOver && current && (
              <Button size="xs" variant="secondary" icon={Hand} onClick={() => void browser.takeOver?.(current.tabId)}>
                {COPY.takeOver}
              </Button>
            )}
          </span>
        ) : control === 'person' ? (
          <span className="browser-foot-agent" role="status">
            <span className="browser-foot-activity">{COPY.personControl}</span>
            {browser.handBack && current && (
              <Button size="xs" variant="primary" icon={AgentsGlyph} onClick={() => void browser.handBack?.(current.tabId)}>
                {COPY.handBack}
              </Button>
            )}
          </span>
        ) : picking ? (
          <span className="browser-foot-pick">{COPY.selectHelp}</span>
        ) : (
          // Where the project's logins live is the foot's tooltip: it takes no room beside the page's state.
          <Tooltip content={COPY.partition}>
            <button
              type="button"
              className="browser-foot-logs"
              aria-expanded={drawer}
              disabled={!current || blank}
              onClick={() => setDrawer(value => !value)}>
              {parts.map((part, index) => (
                <span key={index} data-tone={part.tone} className={part.tone ? undefined : 'browser-foot-label'}>
                  {index > 0 && !part.tone && <span className="browser-foot-dot">·</span>}
                  {part.text}
                </span>
              ))}
            </button>
          </Tooltip>
        )}
        <span className="browser-space" />
      </footer>
      {clearing && (
        <ConfirmDialog
          title={COPY.clearTitle}
          message={COPY.clearMessage}
          confirmLabel={COPY.clear}
          onConfirm={async () => {
            const answer = await shell.clearData(projectId)
            if (!answer.ok) throw new MessageError(COPY.clearFailed)
            browser.say(() => COPY.cleared)
          }}
          onClose={() => setClearing(false)}
        />
      )}
    </section>
  )
}

/** The blank tab: the local services this session's terminals announced, then the project's recent addresses. */
function BlankPage({ services, recent, onOpen }: { services: string[]; recent: string[]; onOpen(url: string): void }) {
  const others = recent.filter(url => !services.some(service => url.startsWith(service)))
  if (services.length === 0 && others.length === 0) return <p className="browser-blank-empty">{COPY.noServices}</p>
  return (
    <div className="browser-blank">
      {services.length > 0 && (
        <div className="browser-blank-group">
          <h3>{COPY.services}</h3>
          {services.map(url => (
            <button key={url} type="button" className="browser-blank-row" onClick={() => onOpen(url)}>
              <Icon icon={GlobeGlyph} size={14} />
              <VisibleText text={hostLabel(url)} />
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="browser-blank-group">
          <h3>{COPY.recent}</h3>
          {others.map(url => (
            <button key={url} type="button" className="browser-blank-row" onClick={() => onOpen(url)}>
              <Icon icon={GlobeGlyph} size={14} />
              <VisibleText text={pageLabel(url)} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The 控制台 and 网络 drawer: main's lists, read again each second while it is open. */
function BrowserDrawer({
  shell,
  tabId,
  page,
  onCompose,
  onNotice,
}: {
  shell: ShellBrowser
  tabId: string
  page: string
  onCompose?: ((text: string) => void) | undefined
  onNotice(text: () => string): void
}) {
  const [kind, setKind] = useState<'console' | 'network'>('console')
  const [lists, setLists] = useState<{ console: BrowserConsoleEntry[]; network: BrowserNetworkEntry[] }>()
  const [selected, setSelected] = useState<number[]>([])
  useEffect(() => {
    let live = true
    const read = () =>
      void shell.logs(tabId).then(answer => {
        if (live && answer.ok) setLists({ console: answer.console, network: answer.network })
      })
    read()
    const timer = setInterval(read, LOGS_EVERY_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [shell, tabId])
  useEffect(() => setSelected([]), [kind, tabId])
  const rows = kind === 'console' ? (lists?.console.length ?? 0) : (lists?.network.length ?? 0)
  /** By main's sequence ID, so entries arriving meanwhile never shift what was chosen. */
  const toggle = (id: number) => setSelected(previous => (previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]))
  const add = () => {
    if (!lists || !onCompose) return
    const draft = logsDraft({ kind, page, console: lists.console, network: lists.network, selected })
    if (!draft) {
      onNotice(() => (kind === 'console' ? COPY.noErrors : COPY.noFailed))
      return
    }
    onCompose(draft.text)
    if (draft.redacted) onNotice(() => COPY.redacted)
    setSelected([])
  }
  return (
    <div className="browser-drawer">
      <div className="browser-drawer-head">
        <SegmentedControl
          label={COPY.logTypes}
          size="xs"
          value={kind}
          options={[
            { value: 'console', label: COPY.console },
            { value: 'network', label: COPY.network },
          ]}
          onValueChange={setKind}
        />
        <span className="browser-space" />
        {onCompose && (
          <Button
            size="xs"
            variant="ghost"
            icon={MessageGlyph}
            tooltip={selected.length ? COPY.addSelected : kind === 'console' ? COPY.lastErrors : COPY.lastFailed}
            onClick={add}>
            {COPY.add}
          </Button>
        )}
      </div>
      <div
        className="browser-drawer-list"
        role="listbox"
        aria-multiselectable="true"
        aria-label={kind === 'console' ? COPY.console : COPY.network}
        tabIndex={0}>
        {!lists ? (
          <Loading label={COPY.reading} />
        ) : rows === 0 ? (
          <p className="browser-drawer-empty">{kind === 'console' ? COPY.emptyConsole : COPY.emptyRequests}</p>
        ) : kind === 'console' ? (
          lists.console.map(entry => (
            <div
              key={entry.id}
              role="option"
              aria-selected={selected.includes(entry.id)}
              className="browser-log"
              data-level={entry.level}
              onClick={() => toggle(entry.id)}>
              <VisibleText text={consoleLine(entry)} />
            </div>
          ))
        ) : (
          lists.network.map(entry => (
            <div
              key={entry.id}
              role="option"
              aria-selected={selected.includes(entry.id)}
              className="browser-request"
              data-failed={failedRequest(entry) ? '' : undefined}
              onClick={() => toggle(entry.id)}>
              <span className="browser-request-method">{entry.method}</span>
              <span className="browser-request-url">
                <VisibleText text={entry.url} />
              </span>
              <span className="browser-request-status">{networkStatus(entry)}</span>
              <span className="browser-request-time">{entry.duration === null ? '—' : `${entry.duration} ms`}</span>
              <span className="browser-request-size">{sizeLabel(entry.size)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
