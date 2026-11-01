import type { AppSnapshot } from '@latch/protocol'
import type { useHarness } from '../core/useHarness.ts'
import { mentionMarker } from '../fileMentions.ts'
import type { ChangeTotals, FileMention } from '@latch/protocol'
import type { ChangesTarget as ChangesPanelTarget } from '../panel/changes/ChangesPanel.tsx'
import { TREE_FROM_FILES } from '../panel/changes/model.ts'
import { useFileTabs } from '../preview/useFileTabs.ts'
import { quoteDraft, type FileQuote } from '../preview/quote.ts'
import { fileContextKey } from '../preview/fileContext.ts'
import { useAutoOpenOutputs } from '../hooks/useAutoOpenOutputs.ts'
import type { ContextFileOpenTarget, FileContext } from '@latch/protocol'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { RefreshCw } from 'lucide-react'
import type { SearchHit } from '@latch/protocol'
import { useAuditCheckpoint } from '../core/auditCheckpoint.ts'
import { usesDrawer, useCoarsePointer, useViewport, useWindowWidth } from '../breakpoints.ts'
import { projectFor, usesDemoModel } from '../composerChoice.ts'
import { setSessionOpener } from '../core/blocking.ts'
import { ArchiveUndo } from '../components/ArchiveUndo.tsx'
import { basename } from '../format.ts'
import { setPreference, usePreferences } from '../preferences.ts'
import { shortcutWorksOnPage, workbenchShortcut } from '../workbenchShortcuts.ts'
import {
  RIGHT_PANEL_DEFAULT,
  SIDEBAR_DEFAULT,
  SIDEBAR_SNAP_MS,
  changesPanelWidth,
  clampRightPanel,
  clampSidebar,
  placeRightPanel,
  sidebarAfterDrag,
  sidebarMax,
} from './panelLayout.ts'
import { entryOfSection, routeAtWidth, visibleEntries, type AgentPageTarget, type ShellEntry, type ShellRoute } from './routes.ts'
import type { PaletteLevel } from '../palette/model.ts'
import { projectOf, listedSessions, readFolded, shelvesKey, steppedSession, type SessionFilter } from '../sessions.ts'
import { hostNoticeCopy } from '../core/hostState.ts'
import { hostLine, useShellLifecycle } from '../core/shellLifecycle.ts'
import { currentShell, shellFolders } from '../core/shell.ts'
import { useDrawer } from '../hooks/useDrawer.ts'
import { useStableCallback } from '../hooks/useStableCallback.ts'
import { useBackLayer } from '../hooks/backStack.ts'
import { usePromptTemplates } from '../hooks/usePromptTemplates.ts'
import { useSessionSearch } from '../hooks/useSessionSearch.ts'
import { SessionSearchResults } from '../components/SessionSearchResults.tsx'
import { ArchiveBatch } from '../components/ArchiveBatch.tsx'
import type { PanelSurface } from '../components/SessionPanels.tsx'
import { type MenuSection } from '../components/overlays.tsx'
import { MOTION, usePresence, type ResizePhase } from '@latch/ui'
import { settingsSections, type SettingsSection } from '../settings/SettingsPage.tsx'
import { useSessionController } from './useSessionController.ts'
import type { ChangesLink, ChangesTarget } from '../conversation/changesLink.ts'
import { useFrozenAt } from '../conversation/useFrozenAt.ts'

type Harness = ReturnType<typeof useHarness>

/** Everything the signed-in shell holds beside the open session: its columns, its pages, its keys and its lists. */
export function useShellLayout({ harness, snapshot }: { harness: Harness; snapshot: AppSnapshot }) {
  const { selectedId, refresh, resync, connection } = harness
  const session = useSessionController({
    harness,
    snapshot,
    onBeforeSelect: id => {
      clearTimeout(popTimer.current)
      setPopping(false)
      setPushed(id !== null)
      drawer.setOpen(false)
      setInfoPage(false)
      setFileExpanded(false)
      if (id !== null) setRoute({ entry: 'sessions' })
    },
    onForegroundSent: () => {
      setFilter('all')
      setSearch('')
      setNewSheet(false)
      setPhoneSearching(false)
      setPushed(true)
    },
  })
  const {
    openNotified,
    archivedLast,
    undoArchive,
    forgetArchive,
    personalDraft,
    setPersonalDraft,
    current,
    summary,
    composerRef,
    setToast,
    configFeedback,
    workspaceChanged,
    catalog,
    host,
    access,
    owner,
    active,
    harnessInfo,
    reading,
    submission,
    choice,
    attachmentDraft,
    fileMentions,
    setFileMentions,
    quoteSnapshots,
    mentionChoice,
    choose,
    reveal,
    sessionMenu,
    block,
    gate,
    presenceDown,
    askProject,
  } = session

  const conversationEpoch = `${harness.resyncs}:${selectedId ?? ''}`
  const viewport = useViewport()
  const coarse = useCoarsePointer()
  const preferences = usePreferences()
  const phone = viewport === 'phone'
  const drawerMode = usesDrawer(viewport)
  // From 1024px the sidebar can be dragged wider or narrower, or shut.
  const sidebarColumn = viewport === 'laptop' || viewport === 'desktop'
  const windowWidth = useWindowWidth()
  /** A drag in progress, and whether it is past the snap point; the width under the pointer goes straight to the page. */
  const [sidebarDrag, setSidebarDrag] = useState<{ collapsed: boolean } | null>(null)
  /** The panel as a page in the conversation's place: on phones, and on tablets too narrow for the column. */
  const [infoPage, setInfoPage] = useState(false)
  /** Phones: the new-session sheet over the session list. */
  const [newSheet, setNewSheet] = useState(false)
  /** Phones: the search row under the list's header. */
  const [phoneSearching, setPhoneSearching] = useState(false)
  /** Phones: the open session slides back to the list; it is let go once the slide ends. */
  const [popping, setPopping] = useState(false)
  /** Phones: the open session was pushed over the list while the person watched (not restored with the page). */
  const [pushed, setPushed] = useState(false)
  const popTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** The right panel's edge is being dragged; its width goes straight to the page. */
  const [inspectorDrag, setInspectorDrag] = useState(false)
  const appShell = useRef<HTMLDivElement>(null)
  const titlebar = useRef<HTMLDivElement>(null)
  /** The current entry, its section, and where a page puts its title. */
  const [chosenRoute, setRoute] = useState<ShellRoute>({ entry: 'sessions' })
  const route = routeAtWidth(chosenRoute, phone)
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null)
  /** Shut by the person (its button, a drag past the snap point, the keyboard), as opposed to shut for the column. */
  const sidebarShut = sidebarColumn && (sidebarDrag !== null ? sidebarDrag.collapsed : preferences.sidebar.collapsed)
  /**
   * A drag that has just snapped the column shut, or pulled it open again: for one track transition the column slides
   * instead of following the pointer. Each snap restarts the window.
   */
  const [sidebarSnapping, setSidebarSnapping] = useState(false)
  const snapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const snapSidebar = () => {
    setSidebarSnapping(true)
    clearTimeout(snapTimer.current)
    snapTimer.current = setTimeout(() => {
      setSidebarSnapping(false)
    }, SIDEBAR_SNAP_MS)
  }
  useEffect(
    () => () => {
      clearTimeout(snapTimer.current)
      clearTimeout(popTimer.current)
    },
    [],
  )
  const navigation = useRef<HTMLElement>(null)
  const main = useRef<HTMLElement>(null)
  const sidebarToggle = useRef<HTMLButtonElement>(null)
  /** The new-session page's 「添加 Agent」 tile, which the line under the input opens as well. */
  const setupTrigger = useRef<HTMLButtonElement>(null)
  /** The input of the phone's new-session sheet, apart from the open session's. */
  const sheetComposerRef = useRef<HTMLTextAreaElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [commandMode, setCommandMode] = useState<PaletteLevel>('root')
  const [commandOpen, setCommandOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  /** Pressing ⌘F with the bar open goes back to its field. */
  const [findFocus, setFindFocus] = useState(0)
  const [search, setSearch] = useState('')
  const promptTemplates = usePromptTemplates(snapshot.catalog?.features?.promptTemplates === true, snapshot.catalog?.promptTemplatesVersion)
  const contentSearch = useSessionSearch(search, snapshot.catalog?.features?.search === true)
  const [searchTarget, setSearchTarget] = useState<SearchHit | null>(null)
  const [filter, setFilter] = useState<SessionFilter>('all')
  const entries = visibleEntries(settingsSections(snapshot, access), phone)
  const entriesKey = entries.join()
  // An entry this device can no longer use closes at once.
  useLayoutEffect(() => {
    if (!entries.includes(route.entry)) setRoute({ entry: 'sessions' })
  }, [entriesKey, route.entry])
  const panelToggle = useRef<HTMLButtonElement>(null)
  const infoPageRef = useRef<HTMLElement>(null)
  const infoBack = useRef<HTMLButtonElement>(null)
  // The page opens with focus on its way back.
  useEffect(() => {
    if (infoPage) infoBack.current?.focus({ preventScroll: true })
  }, [infoPage])
  const lifecycle = useShellLifecycle()
  const audit = useAuditCheckpoint(host?.hostId, connection === 'connected')
  const fileContext: FileContext | null = selectedId
    ? { kind: 'session', sessionId: selectedId }
    : !personalDraft && choice.workspaceId && choice.workspaceId !== 'default'
      ? { kind: 'workspace', workspaceId: choice.workspaceId, harnessId: choice.harnessId ?? catalog?.defaults.harnessId ?? 'standard' }
      : null
  const fileAuthority = JSON.stringify([snapshot.device.dataScope, access.scopes.has('view'), catalog?.features?.filePreview])
  const savedFileTabs = useFileTabs(snapshot.device.id, fileContext, fileAuthority)
  const previewAllowed =
    catalog?.features?.filePreview
    && access.scopes.has('view')
    && (fileContext?.kind !== 'workspace' || snapshot.device.dataScope === 'all')
  const fileTabs = previewAllowed ? savedFileTabs : { ...savedFileTabs, tabs: [], active: undefined }
  const [fileExpanded, setFileExpanded] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [pluginPanel, setPluginPanel] = useState<string>()
  /** What ⌥⌘B brings back: the panel keeps its place while it is shut. */
  const lastSurface = useRef<PanelSurface>({ kind: 'launcher' })
  /** Set when the launcher was asked for; a launcher that merely mounted (a session switch, a reload) leaves focus alone. */
  const launcherAsked = useRef(false)
  const canBrowseFiles =
    catalog?.features?.fileTree === true && snapshot.device.dataScope === 'all' && access.scopes.has('view') && fileContext !== null
  const filesVisible = !!fileTabs.active || (filesOpen && canBrowseFiles)
  const contextKey = fileContext ? fileContextKey(fileContext) : ''
  // A device without the data scope still gets the tab: it says why there is nothing to read, instead of a toggle that vanished.
  const canViewChanges = catalog?.features?.changes === true && access.scopes.has('view') && !!summary && summary.mode !== 'chat'
  const [changesWanted, setChangesWanted] = useState(false)
  const changesOpen = changesWanted && canViewChanges
  const [changesTarget, setChangesTarget] = useState<ChangesPanelTarget>()
  const [changesTotals, setChangesTotals] = useState<ChangeTotals>()
  useLayoutEffect(() => {
    setFilesOpen(false)
    setPluginPanel(undefined)
    lastSurface.current = { kind: 'launcher' }
    launcherAsked.current = false
    setInfoPage(false)
    setFileExpanded(false)
    setChangesWanted(false)
    setChangesTarget(undefined)
    setChangesTotals(undefined)
  }, [contextKey, fileAuthority])
  const storedSidebar = preferences.sidebar.width ?? SIDEBAR_DEFAULT
  const sidebarWidth = clampSidebar(storedSidebar, windowWidth)
  const sidebarCollapsed = sidebarShut
  const panelLeft = sidebarColumn && !sidebarCollapsed ? sidebarWidth : 0
  const showingChanges = changesOpen && !fileTabs.active
  const panelWidth =
    preferences.rightPanel.width
    ?? (showingChanges
      ? changesPanelWidth(windowWidth, panelLeft, preferences.diffTree ?? (changesTotals?.files ?? 0) >= TREE_FROM_FILES)
      : undefined)
  const placed = placeRightPanel({
    windowWidth,
    ...(panelWidth !== undefined ? { width: panelWidth } : {}),
    left: panelLeft,
  })
  const placement =
    !summary && !filesVisible
      ? null
      : (filesVisible || changesOpen || pluginPanel !== undefined) && fileExpanded
        ? { kind: 'page' as const }
        : placed
  const pageMode = placement?.kind === 'page'
  const columnOpen =
    placement !== null && placement.kind !== 'page' && (filesVisible || changesOpen || (!!summary && preferences.rightPanel.open))
  const inspectorWidth = placement !== null && placement.kind !== 'page' ? placement.width : RIGHT_PANEL_DEFAULT
  const drawer = useDrawer({ enabled: drawerMode, navigation, inertWhenOpen: [main, titlebar], shut: sidebarCollapsed })
  /** Where focus goes once the sidebar has opened or shut: after the drawer hook made the column usable or inert. */
  const focusAfterToggle = useRef<{ target: RefObject<HTMLElement | null>; shut: boolean } | null>(null)
  useEffect(() => {
    const pending = focusAfterToggle.current
    if (pending?.shut !== sidebarCollapsed) return
    focusAfterToggle.current = null
    pending.target.current?.focus({ preventScroll: true })
  }, [sidebarCollapsed])
  const saveSidebar = (patch: { width?: number | null; collapsed?: boolean }) => {
    const { width, ...rest } = preferences.sidebar
    const next = patch.width === null ? undefined : (patch.width ?? width)
    setPreference('sidebar', {
      ...rest,
      ...(next !== undefined ? { width: next } : {}),
      collapsed: patch.collapsed ?? preferences.sidebar.collapsed,
    })
  }
  const openFile = useStableCallback((target: ContextFileOpenTarget, options?: { focus: false }) => {
    if (snapshot.catalog?.features?.filePreview !== true) return
    if (
      options?.focus === false
      && document.activeElement instanceof HTMLElement
      && document.activeElement.closest('.file-preview')
      && document.activeElement.closest('input,textarea,select,[contenteditable="true"]')
    )
      return
    if (!('sessionId' in target)) {
      if (
        !fileContext
        || fileContext.kind !== 'workspace'
        || target.workspaceId !== fileContext.workspaceId
        || target.harnessId !== fileContext.harnessId
      )
        return
      setRoute({ entry: 'sessions' })
      fileTabs.open(target)
      setInfoPage(true)
      return
    }
    setRoute({ entry: 'sessions' })
    if (target.sessionId !== selectedId) choose(target.sessionId)
    const task = current?.summary.id === target.sessionId ? current.summary : snapshot.tasks.find(item => item.id === target.sessionId)
    const roots = task?.folders?.length ? task.folders : task?.cwd ? [{ id: 'default', path: task.cwd }] : []
    const root = target.rootId
      ? roots.find(root => root.id === target.rootId)
      : (roots.find(root => target.reference.startsWith(`${root.path}/`)) ?? roots[0])
    const reference = root && target.reference.startsWith(`${root.path}/`) ? target.reference.slice(root.path.length + 1) : target.reference
    fileTabs.open({ ...target, reference, ...(root ? { rootId: root.id } : {}) })
    setInfoPage(true)
  })
  const offerFile = useStableCallback((target: ContextFileOpenTarget) => {
    fileTabs.offer(target)
  })
  // A wide window opens it where the panel opens, beside the conversation or as a sheet over it.
  useAutoOpenOutputs({
    detail: current,
    available:
      snapshot.catalog?.features?.filePreview === true
      && sidebarColumn
      && placed.kind !== 'page'
      && route.entry === 'sessions'
      && !fileExpanded,
    width: placed.kind !== 'page' ? placed.width : 0,
    onOpen: openFile,
    onOffer: offerFile,
  })
  /** A new session starts where the person is: in the open session's project, else as last chosen. */
  const startNew = () => {
    setPersonalDraft(null)
    setRoute({ entry: 'sessions' })
    submission.setFork(null)
    const project = selectedId === null ? undefined : projectFor(catalog, summary)
    // A phone keeps its list under the sheet, and what was being drafted there stays for the next time it opens.
    if (phone) {
      if (selectedId !== null) choose(null)
      if (project) submission.updateChoice({ workspaceId: project })
      setNewSheet(true)
      return
    }
    choose(null)
    if (project) submission.updateChoice({ workspaceId: project })
    requestAnimationFrame(() => {
      composerRef.current?.focus({ preventScroll: true })
    })
  }
  /**
   * Phones: the open session slides back to the list (180ms), then is let go, and focus lands on its row; at once without
   * motion, or when the browser has already drawn the way back (its own edge swipe).
   */
  const back = (instant = false) => {
    const id = selectedId
    const arrive = () => {
      choose(null)
      requestAnimationFrame(() => {
        if (id !== null) document.querySelector<HTMLElement>(`#session-navigation [data-task-id="${CSS.escape(id)}"]`)?.focus()
      })
    }
    if (instant || !matchMedia('(prefers-reduced-motion: no-preference)').matches) {
      arrive()
      return
    }
    setPopping(true)
    clearTimeout(popTimer.current)
    popTimer.current = setTimeout(arrive, MOTION.pushExit)
  }
  // The confirmation dock opens the session that holds a confirmation back, from settings too.
  useEffect(
    () =>
      setSessionOpener(id => {
        setRoute({ entry: 'sessions' })
        choose(id)
      }),
    [choose],
  )
  const openSettings = (section?: SettingsSection) => {
    drawer.setOpen(false)
    setNewSheet(false)
    setRoute(section ? { entry: entryOfSection(section, phone), section } : { entry: 'settings' })
  }
  /** A foot icon, a tab or the way back. 会话 returns to the last open session. */
  const goEntry = (entry: ShellEntry) => {
    setNewSheet(false)
    drawer.setOpen(false)
    setRoute({ entry })
  }
  const canPersonal = settingsSections(snapshot, access).includes('assistants')
  const openPersonal = canPersonal
    ? () => {
        openSettings('assistants')
      }
    : undefined
  const openProjectSettings = (projectId: string) => {
    drawer.setOpen(false)
    setNewSheet(false)
    setRoute({ entry: entryOfSection('workspaces', phone), section: 'workspaces', projectId })
  }
  const openAgentPage = (target: AgentPageTarget) => {
    drawer.setOpen(false)
    setNewSheet(false)
    setRoute({ entry: entryOfSection('engines', phone), section: 'engines', agent: target })
  }
  /** The palette searches, except on a phone, which keeps its search under the title. */
  const openSearch = () => {
    if (!phone) {
      setCommandMode('root')
      setCommandOpen(true)
      return
    }
    if (selectedId !== null) choose(null)
    setRoute({ entry: 'sessions' })
    setPhoneSearching(true)
    requestAnimationFrame(() => {
      searchRef.current?.focus({ preventScroll: true })
    })
  }

  const searchShortcut = useStableCallback((event: KeyboardEvent) => {
    if (
      event.key.toLowerCase() === 'f'
      && (event.metaKey || event.ctrlKey)
      && selectedId !== null
      && route.entry === 'sessions'
      && !document.querySelector('dialog[open]')
    ) {
      event.preventDefault()
      setFindOpen(true)
      setFindFocus(value => value + 1)
      return
    }
    if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
    // The same keys put away the palette they opened; nothing opens over another dialog.
    if (commandOpen) {
      event.preventDefault()
      closePalette()
      return
    }
    if (document.querySelector('dialog[open]')) return
    event.preventDefault()
    setCommandMode('root')
    setCommandOpen(true)
  })
  useEffect(() => {
    window.addEventListener('keydown', searchShortcut)
    return () => {
      window.removeEventListener('keydown', searchShortcut)
    }
  }, [searchShortcut])

  // The desktop app reads the Host itself, so its notification can be ahead of this page, even about a session the page
  // already lists: go as soon as the session is known, and keep looking for its request until the page has read again.
  const [notified, setNotified] = useState<{ id: string; read: boolean; arrived: boolean } | null>(null)
  useEffect(
    () =>
      currentShell()?.notifications?.subscribe(id => {
        setNotified({ id, read: false, arrived: false })
        void refresh().finally(() => {
          setNotified(previous => (previous?.id === id ? { ...previous, read: true } : previous))
        })
      }),
    [refresh],
  )
  useEffect(() => {
    if (notified === null || !snapshot.tasks.some(task => task.id === notified.id)) return
    const done = openNotified(notified.id, !notified.arrived)
    // Unchanged once it has arrived: a new object here would run this again at once, for as long as the page's read takes,
    // and each run would put this session back over a newer click.
    if (done || notified.read) setNotified(null)
    else if (!notified.arrived) setNotified({ ...notified, arrived: true })
  }, [notified, snapshot.tasks, snapshot.approvals, openNotified])
  const manageProviders = owner
    ? () => {
        openSettings('providers')
      }
    : undefined
  /** A project or 不选项目 from the list: the person was on their way to sending, so the input takes the keys again. */
  const chooseProject = (workspaceId: string) => {
    submission.updateChoice({ workspaceId, projectSkipped: workspaceId === 'default' })
    requestAnimationFrame(() => (phone ? sheetComposerRef : composerRef).current?.focus())
  }
  const folders = shellFolders()
  const pickProject =
    folders && access.local && owner && catalog
      ? async (start: boolean) => {
          const result = await folders.pick()
          if (result.status !== 'added') {
            if (result.status === 'failed') setToast({ text: '没有打开文件夹。请在设置 › 项目中重试。', tone: 'error' })
            if (result.status === 'busy') setToast({ text: '另一个系统对话框还没结束。', tone: 'error' })
            return
          }
          const added = result.added[0]
          const refused = result.refused[0]
          await refresh()
          if (added) {
            if (start) startNew()
            chooseProject(added.workspaceId)
          }
          // Said where it was chosen, at once, rather than when sending fails later.
          if (refused) {
            const refusal = `没有打开 ${basename(refused.path)}：${refused.message ?? 'Latch 拒绝了这个文件夹。'}`
            // The list that says so stands on the new-session page; over a session it would say nothing.
            if (selectedId === null) askProject(refusal)
            else setToast({ text: refusal, tone: 'error' })
          }
        }
      : undefined
  const createProject = pickProject
    ? () => {
        void pickProject(false)
      }
    : undefined
  const createProjectAndStart = pickProject
    ? () => {
        void pickProject(true)
      }
    : undefined
  const newChoicesLocked = submission.pending !== null || submission.sending || attachmentDraft.preparing || gate.kind !== 'open'
  const sheetCanStart =
    selectedId === null
    && gate.kind === 'open'
    && block === null
    && !presenceDown
    && !newChoicesLocked
    && (submission.draft.trim().length > 0 || attachmentDraft.items.length > 0)
  // The open column stands beside the conversation, which keeps its minimum width between the two.
  const inspectorBeside = columnOpen && placement?.kind === 'column' ? inspectorWidth : 0
  const sidebarLimit = sidebarMax(windowWidth, inspectorBeside)
  const setSidebarShut = (shut: boolean) => {
    saveSidebar({ collapsed: shut })
  }
  /** A tablet's drawer is the session list, which a page entry does not show. */
  const toggleSidebar = () => {
    if (!drawerMode) setSidebarShut(!sidebarCollapsed)
    else if (route.entry === 'sessions') drawer.setOpen(!drawer.open)
  }
  const resizeSidebar = (raw: number, step: ResizePhase) => {
    const next = sidebarAfterDrag(raw, windowWidth, inspectorBeside)
    if (step === 'drag') {
      // Passing the snap point either way slides the column; widths in between follow the pointer without a render.
      if (next.collapsed !== sidebarCollapsed) snapSidebar()
      if (sidebarDrag?.collapsed !== next.collapsed) setSidebarDrag({ collapsed: next.collapsed })
      // At the crossing the page's own render starts the slide; a write now would land before the track can transition.
      if (!next.collapsed && !sidebarCollapsed) {
        appShell.current?.style.setProperty('--sidebar-width', `${next.width}px`)
        appShell.current?.style.setProperty('--sidebar-open-width', `${next.width}px`)
      }
      return
    }
    setSidebarDrag(null)
    saveSidebar(next.collapsed ? { collapsed: true } : { width: next.width, collapsed: false })
  }
  const setColumnOpen = (open: boolean) => {
    setPreference('rightPanel', { ...preferences.rightPanel, open })
  }
  /** Shows one surface of the panel, opening the panel if it is shut. */
  const showSurface = (surface: PanelSurface) => {
    launcherAsked.current = surface.kind === 'launcher'
    setChangesWanted(surface.kind === 'changes')
    setFilesOpen(surface.kind === 'files')
    setPluginPanel(surface.kind === 'plugin' ? surface.id : undefined)
    fileTabs.select(surface.kind === 'file' ? surface.id : undefined)
    setFileExpanded(false)
    setColumnOpen(true)
    setInfoPage(true)
    if (phone) setNewSheet(false)
  }
  const launcherTakesFocus = () => {
    const asked = launcherAsked.current
    launcherAsked.current = false
    return asked
  }
  const shownSurface = (): PanelSurface =>
    fileTabs.active
      ? { kind: 'file', id: fileTabs.active.id }
      : changesOpen
        ? { kind: 'changes' }
        : filesOpen
          ? { kind: 'files' }
          : pluginPanel !== undefined
            ? { kind: 'plugin', id: pluginPanel }
            : { kind: 'launcher' }
  const closePanel = () => {
    lastSurface.current = shownSurface()
    setChangesWanted(false)
    setFilesOpen(false)
    fileTabs.select(undefined)
    setFileExpanded(false)
    setColumnOpen(false)
    setInfoPage(false)
    requestAnimationFrame(() => panelToggle.current?.focus({ preventScroll: true }))
  }
  const openChangesTab = (target?: Omit<ChangesPanelTarget, 'nonce'>) => {
    if (!canViewChanges) return
    setChangesWanted(true)
    setFilesOpen(false)
    fileTabs.select(undefined)
    setInfoPage(true)
    if (target) setChangesTarget(previous => ({ ...target, nonce: (previous?.nonce ?? 0) + 1 }))
  }
  const toggleChanges = () => {
    if (changesOpen && !fileTabs.active && (!pageMode || infoPage)) closePanel()
    else openChangesTab()
  }
  const togglePanel = () => {
    if (columnOpen || (pageMode && infoPage)) closePanel()
    else {
      // A page sent back (Esc, the platform's back, sending from it) still holds its surface; only closePanel lets go of it.
      const shown = shownSurface()
      showSurface(shown.kind === 'launcher' ? lastSurface.current : shown)
    }
  }
  const workbenchKeys = useStableCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    const action = workbenchShortcut(event, currentShell() !== null)
    if (!action) return
    const dialogs = document.querySelectorAll('dialog[open]')
    if (dialogs.length && !(action === 'files' && dialogs.length === 1 && dialogs[0]!.classList.contains('new-session-sheet'))) return
    if (route.entry !== 'sessions' && !shortcutWorksOnPage(action)) return
    if (action === 'close-file') {
      if (fileTabs.active) {
        event.preventDefault()
        fileTabs.close(fileTabs.active.id)
        setFileExpanded(false)
      }
      return
    }
    if (action === 'files') {
      if (fileTabs.tabs.length) {
        event.preventDefault()
        const index = fileTabs.tabs.findIndex(tab => tab.id === fileTabs.active?.id)
        fileTabs.select(fileTabs.tabs[(index + 1) % fileTabs.tabs.length]!.id)
        setInfoPage(true)
      } else if (canBrowseFiles) {
        event.preventDefault()
        browseFiles()
      }
      return
    }
    if (action === 'compose') {
      event.preventDefault()
      if (phone && selectedId === null) {
        setNewSheet(true)
        requestAnimationFrame(() => sheetComposerRef.current?.focus())
      } else if (pageMode && infoPage) {
        setInfoPage(false)
        requestAnimationFrame(() => composerRef.current?.focus())
      } else composerRef.current?.focus()
      return
    }
    if (action === 'file-search') {
      if (catalog?.features?.fileSearch && snapshot.device.dataScope === 'all' && fileContext) {
        event.preventDefault()
        setCommandMode('files')
        setCommandOpen(true)
      }
      return
    }
    event.preventDefault()
    if (action === 'new') {
      startNew()
      return
    }
    if (action === 'sidebar') {
      toggleSidebar()
      return
    }
    if (action === 'side-panel') {
      if (summary || filesVisible) togglePanel()
      return
    }
    if (action === 'changes') {
      if (canViewChanges) toggleChanges()
      return
    }
    if (action === 'settings') {
      if (entries.includes('settings')) goEntry('settings')
      return
    }
    if (action === 'shortcuts') {
      if (settingsSections(snapshot, access).includes('shortcuts') && !phone) openSettings('shortcuts')
      return
    }
    const folded = readFolded(shelvesKey(snapshot.device.id))
    const ordered = listedSessions(snapshot.tasks, catalog?.workspaces, { filter, search, folded })
    const target = steppedSession(ordered, selectedId, action === 'next' ? 1 : -1)
    if (target) choose(target.id)
  })
  useEffect(() => {
    window.addEventListener('keydown', workbenchKeys)
    return () => window.removeEventListener('keydown', workbenchKeys)
  }, [workbenchKeys])
  const resizeInspector = (raw: number, step: ResizePhase) => {
    const width = clampRightPanel(raw, windowWidth)
    if (step === 'drag') {
      if (!inspectorDrag) setInspectorDrag(true)
      // A sheet stands out of the grid, so its track stays shut until the drop places it.
      if (placed.kind === 'column') appShell.current?.style.setProperty('--inspector-width', `${width}px`)
      appShell.current?.style.setProperty('--inspector-open-width', `${width}px`)
      return
    }
    setInspectorDrag(false)
    setPreference('rightPanel', { ...preferences.rightPanel, width })
  }
  const resetInspector = () => {
    const { width: _width, ...rest } = preferences.rightPanel
    setPreference('rightPanel', rest)
  }
  /**
   * Shows a row of the conversation: a row inside a closed disclosure (the folded process of a turn) is opened first,
   * as the browser's find would open it, and the reading position keeps the row in place while it opens.
   */
  const revealRow = (messageId: string, offset?: number) => {
    const row = document.querySelector(`.transcript [data-message-id="${CSS.escape(messageId)}"]`)
    for (let hidden = row?.closest('[hidden="until-found"]'); hidden; hidden = hidden.parentElement?.closest('[hidden="until-found"]')) {
      hidden.dispatchEvent(new Event('beforematch'))
    }
    requestAnimationFrame(() => {
      reveal(messageId, offset)
    })
  }
  useEffect(() => {
    if (!searchTarget || current?.summary.id !== searchTarget.sessionId) return
    const frame = requestAnimationFrame(() => {
      revealRow(searchTarget.messageId)
      const row = document.querySelector(`.transcript [data-message-id="${CSS.escape(searchTarget.messageId)}"]`)
      row?.setAttribute('data-search-target', '')
    })
    const timer = setTimeout(() => {
      document.querySelectorAll('[data-search-target]').forEach(row => row.removeAttribute('data-search-target'))
      setSearchTarget(null)
    }, 2500)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [searchTarget, current?.summary.id])
  const selectSearchHit = (hit: SearchHit) => {
    setSearchTarget(hit)
    choose(hit.sessionId)
    reading.show(hit.sessionId, hit.messageId)
  }
  const searchResults =
    search.trim() && catalog?.features?.search ? <SessionSearchResults state={contentSearch} onSelect={selectSearchHit} /> : undefined
  const archiveBatch =
    filter === 'archived' && catalog?.features?.sessionBatch && access.scopes.has('run') ? (
      <ArchiveBatch tasks={snapshot.tasks} onChanged={refresh} />
    ) : undefined
  const archiveUndo = archivedLast ? <ArchiveUndo key={archivedLast.id} onUndo={undoArchive} onExpire={forgetArchive} /> : undefined
  const findReveal = useStableCallback((messageId: string, offset?: number) => {
    revealRow(messageId, offset)
  })
  // Where the session runs: its harness (a Host without a catalog runs the built-in one) and its project's folder.
  const topHarness = harnessInfo ?? (snapshot.harness ? { ...snapshot.harness, source: 'builtin' as const } : undefined)
  const savedProject = summary && catalog ? projectOf(summary, catalog.workspaces) : undefined
  const project = savedProject ? savedProject.name || basename(savedProject.path) : undefined
  // The demo label follows what this session (or the new-session choice) actually runs on.
  const demo =
    selectedId === null
      ? usesDemoModel(snapshot, choice.harnessId, choice.model?.providerId)
      : summary !== undefined && usesDemoModel(snapshot, summary.harnessId, summary.providerId)
  const frozenAt = useFrozenAt(connection)
  const changesTabReads = canViewChanges && snapshot.device.dataScope === 'all'
  const openChanges = useStableCallback((target: ChangesTarget) => {
    if (changesTabReads) {
      openChangesTab({
        ...(target.turnId ? { turnId: target.turnId } : {}),
        ...(target.path ? { file: { path: target.path, ...(target.root ? { root: target.root } : {}) } } : {}),
      })
      return
    }
    if (selectedId === null || !target.path) return
    // The per-file history is built from the tools' own edits, so a file only a command changed opens as itself.
    const edited = current?.messages.some(message => message.tool?.diffs?.some(diff => diff.path === target.path))
    openFile({
      sessionId: selectedId,
      reference: target.path,
      ...(target.root ? { rootId: target.root } : {}),
      ...(edited ? { view: 'changes' as const } : {}),
    })
  })
  const shownChanges = fileTabs.active?.target.view === 'changes' ? fileTabs.active.target.reference : undefined
  const tabFile = changesOpen && !fileTabs.active ? changesTarget?.file : undefined
  const changesLink = useMemo<ChangesLink | null>(
    () =>
      catalog?.features?.filePreview || changesTabReads
        ? {
            open: openChanges,
            panelOpen: columnOpen,
            turns: changesTabReads,
            ...(tabFile ? { selected: tabFile } : shownChanges ? { selected: { path: shownChanges } } : {}),
          }
        : null,
    [catalog?.features?.filePreview, changesTabReads, openChanges, columnOpen, shownChanges, tabFile],
  )
  const syncSection: MenuSection = {
    id: 'sync',
    items: [
      {
        id: 'refresh',
        label: '同步最新状态',
        icon: RefreshCw,
        onSelect: () => {
          void resync()
        },
      },
    ],
  }
  const titleMenu = summary ? sessionMenu(summary) : []
  const topMenu: MenuSection[] = summary ? [...titleMenu, syncSection] : [syncSection]
  const canStart = catalog !== undefined && (access.legacy || access.scopes.has('run'))
  const startIn = canStart
    ? (workspaceId: string) => {
        startNew()
        submission.updateChoice({ workspaceId })
      }
    : undefined
  const startWithoutProject = canStart
    ? () => {
        startNew()
        submission.updateChoice({ workspaceId: 'default', projectSkipped: true })
      }
    : undefined
  const connectionProblem = harness.error || connection === 'reconnecting' || connection === 'offline'
  // What is known about why the Host does not answer: main's own view on the desktop, else the Host's announcement.
  const shellHost = lifecycle.view?.host
  const hostProblem = shellHost && shellHost.status !== 'running' ? hostLine(shellHost) : null
  const notice = harness.hostNotice ? hostNoticeCopy(harness.hostNotice) : null
  const connectionTitle = connection === 'offline' ? '当前设备已离线' : (hostProblem?.text ?? notice?.title ?? '连接已中断，正在重连…')
  const connectionText =
    connection === 'offline'
      ? '已读内容仍可查看；恢复连接后会同步最新状态。'
      : (notice?.body ?? (hostProblem ? '恢复后会同步最新状态。' : harness.error || '恢复后会同步最新状态。'))
  const devMode = host?.devMode === true
  const level = current?.permission?.level ?? summary?.level

  const commentOnLine = (mention: FileMention, line: number, text: string) => {
    const name = mention.path.split('/').at(-1)!
    const named = mentionChoice.enabled && fileMentions.length < 32
    const head = named ? mentionMarker(mention) : name
    submission.setDraft(previous => `${previous.trimEnd()}${previous.trim() ? '\n\n' : ''}${head} 第 ${line} 行：${text}\n`)
    if (named) setFileMentions(previous => [...previous.filter(ref => ref.root !== mention.root || ref.path !== mention.path), mention])
    if (pageMode) setInfoPage(false)
    composerRef.current?.focus()
  }
  const browseFiles = () => {
    if (!canBrowseFiles) return
    setChangesWanted(false)
    if (filesOpen && !fileTabs.active && (!pageMode || infoPage)) {
      setFilesOpen(false)
      setInfoPage(false)
      setColumnOpen(false)
      return
    }
    setFilesOpen(true)
    fileTabs.select(undefined)
    setInfoPage(true)
    setFileExpanded(false)
    if (phone) setNewSheet(false)
  }
  const searchFiles = () => {
    setCommandMode('files')
    setCommandOpen(true)
  }
  /**
   * On close, the keys go back to the composer unless what ran took them: the find bar, a dialog, or a page without a
   * composer. A touch screen keeps its keyboard down.
   */
  const closePalette = useStableCallback(() => {
    setCommandOpen(false)
    requestAnimationFrame(() => {
      const composer = composerRef.current
      if (coarse || !composer || composer.disabled || composer.offsetParent === null || composer.closest('[inert]')) return
      if (document.querySelector('dialog[open]') || document.activeElement?.closest('.find-bar')) return
      composer.focus({ preventScroll: true })
    })
  })
  const mentionFile = (mention: FileMention) => {
    if (!mentionChoice.enabled || fileMentions.length >= 32) return
    submission.setDraft(previous => `${previous.trimEnd()}${previous.trim() ? ' ' : ''}${mentionMarker(mention)} `)
    setFileMentions(previous => [...previous.filter(ref => ref.root !== mention.root || ref.path !== mention.path), mention])
    if (pageMode) setInfoPage(false)
    if (phone && selectedId === null) setNewSheet(true)
    requestAnimationFrame(() => (phone && selectedId === null ? sheetComposerRef : composerRef).current?.focus())
  }
  const quoteFile = (quote: FileQuote) => {
    if (
      !fileContext
      || quote.contextKey !== fileContextKey(fileContext)
      || active
      || submission.pending
      || submission.sending
      || gate.kind !== 'open'
    )
      return
    const mention =
      quote.file.source === 'attachment' || !mentionChoice.enabled ? undefined : { root: quote.file.root, path: quote.file.path }
    if (mention && fileMentions.length >= 32 && !fileMentions.some(ref => ref.root === mention.root && ref.path === mention.path)) return
    const formatted = quoteDraft(quote, mention && mentionMarker(mention))
    submission.setDraft(previous => previous.trimEnd() + (previous.trim() ? '\n\n' : '') + formatted.text)
    if (mention) setFileMentions(previous => [...previous.filter(ref => ref.root !== mention.root || ref.path !== mention.path), mention])
    for (const [key, value] of quoteSnapshots.current) if (!submission.draft.includes(value.marker)) quoteSnapshots.current.delete(key)
    if (quoteSnapshots.current.size >= 32) quoteSnapshots.current.delete(quoteSnapshots.current.keys().next().value!)
    quoteSnapshots.current.set(quote.contextKey + '\n' + quote.file.root + '\n' + quote.file.path, {
      etag: quote.file.etag,
      marker: formatted.marker,
    })
    if (pageMode) setInfoPage(false)
    if (phone && selectedId === null) setNewSheet(true)
    requestAnimationFrame(() => (phone && selectedId === null ? sheetComposerRef : composerRef).current?.focus())
  }
  const workspaceForFiles =
    fileContext?.kind === 'workspace' ? catalog?.workspaces.find(item => item.id === fileContext.workspaceId) : undefined
  /** Phones: a session is pushed over the list, which stays beneath it, inert, until the session slides away. */
  const phoneSession = phone && (selectedId !== null || (infoPage && filesVisible))
  const column = usePresence(columnOpen, MOTION.panelExit)
  // Which way the columns last moved: a fold takes the exit timing. Unchanged state keeps the last direction.
  const columns = useRef({ right: columnOpen, left: sidebarCollapsed, folding: false })
  if (columns.current.right !== columnOpen || columns.current.left !== sidebarCollapsed)
    columns.current = {
      right: columnOpen,
      left: sidebarCollapsed,
      folding: (columns.current.right && !columnOpen) || (!columns.current.left && sidebarCollapsed),
    }
  const folding = columns.current.folding
  const page = usePresence(pageMode && infoPage, MOTION.pushExit)
  const closeInfoPage = () => {
    setInfoPage(false)
    if (changesOpen) setFileExpanded(false)
    if (phone && selectedId === null) {
      lastSurface.current = shownSurface()
      fileTabs.select(undefined)
      setFilesOpen(false)
      setNewSheet(true)
    }
    panelToggle.current?.focus({ preventScroll: true })
  }
  // A pushed page holds a place in the browser's history, so the platform's back returns to the page under it.
  useBackLayer(phone && selectedId !== null && !popping, instant => {
    back(instant)
  })
  useBackLayer(pageMode && infoPage, closeInfoPage)
  // Phones: the list a session is pushed over can no longer hold focus (nor the sheet a new one started from, sliding
  // away), so the page takes it at its way back, as a settings page does; focus already on the page, or in a dialog
  // still open, stays where it is.
  useEffect(() => {
    if (!phone || selectedId === null || !pushed) return
    const focused = document.activeElement
    if (focused && (main.current?.contains(focused) || focused.closest('dialog[open]'))) return
    main.current?.querySelector<HTMLElement>('.topbar[data-phone] .topbar-back')?.focus({ preventScroll: true })
  }, [phone, selectedId, pushed, main])

  return {
    ...session,
    folding,
    route,
    setRoute,
    entries,
    goEntry,
    titleSlot,
    setTitleSlot,
    appShell,
    titlebar,
    sidebarColumn,
    sidebarToggle,
    resetInspector,
    canPersonal,
    harness,
    snapshot,
    selectedId,
    refresh,
    resync,
    connection,
    phoneSession,
    conversationEpoch,
    viewport,
    coarse,
    preferences,
    phone,
    drawerMode,
    windowWidth,
    sidebarDrag,
    setSidebarDrag,
    infoPage,
    setInfoPage,
    newSheet,
    setNewSheet,
    phoneSearching,
    setPhoneSearching,
    popping,
    setPopping,
    pushed,
    setPushed,
    popTimer,
    inspectorDrag,
    setInspectorDrag,
    sidebarShut,
    sidebarSnapping,
    setSidebarSnapping,
    snapTimer,
    snapSidebar,
    navigation,
    main,
    setupTrigger,
    sheetComposerRef,
    searchRef,
    commandMode,
    setCommandMode,
    commandOpen,
    setCommandOpen,
    closePalette,
    findOpen,
    setFindOpen,
    findFocus,
    search,
    setSearch,
    promptTemplates,
    contentSearch,
    searchTarget,
    setSearchTarget,
    filter,
    setFilter,
    panelToggle,
    infoPageRef,
    infoBack,
    lifecycle,
    audit,
    fileContext,
    fileAuthority,
    savedFileTabs,
    previewAllowed,
    fileTabs,
    fileExpanded,
    setFileExpanded,
    filesOpen,
    setFilesOpen,
    canViewChanges,
    changesOpen,
    showSurface,
    launcherTakesFocus,
    closePanel,
    pluginPanel,
    openChanges,
    toggleChanges,
    openChangesTab,
    changesTarget,
    changesTotals,
    setChangesTotals,
    commentOnLine,
    canBrowseFiles,
    filesVisible,
    contextKey,
    storedSidebar,
    placement,
    pageMode,
    columnOpen,
    inspectorWidth,
    sidebarCollapsed,
    drawer,
    focusAfterToggle,
    saveSidebar,
    openFile,
    startNew,
    back,
    openSettings,
    openPersonal,
    openAgentPage,
    openProjectSettings,
    openSearch,
    searchShortcut,
    manageProviders,
    folders,
    pickProject,
    createProject,
    chooseProject,
    createProjectAndStart,
    newChoicesLocked,
    sheetCanStart,
    inspectorBeside,
    sidebarLimit,
    sidebarWidth,
    setSidebarShut,
    toggleSidebar,
    resizeSidebar,
    setColumnOpen,
    togglePanel,
    workbenchKeys,
    resizeInspector,
    revealRow,
    selectSearchHit,
    searchResults,
    archiveBatch,
    archiveUndo,
    startWithoutProject,
    findReveal,
    topHarness,
    savedProject,
    project,
    demo,
    syncSection,
    titleMenu,
    topMenu,
    canStart,
    startIn,
    connectionProblem,
    frozenAt,
    changesLink,
    shellHost,
    hostProblem,
    notice,
    connectionTitle,
    connectionText,
    devMode,
    level,
    browseFiles,
    searchFiles,
    mentionFile,
    quoteFile,
    workspaceForFiles,
    column,
    page,
    closeInfoPage,
  }
}

export type ShellState = ReturnType<typeof useShellLayout>
