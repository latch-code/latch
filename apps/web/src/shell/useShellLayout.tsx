import { requestLeave } from '../preview/editDrafts.ts'
import { requestBoard } from '../board/requests.ts'
import { readsProjectFiles, type AppSnapshot, type BoardGroup, type TerminalTarget } from '@latch/protocol'
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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type RefObject,
} from 'react'
import type { SearchHit } from '@latch/protocol'
import { useAuditCheckpoint } from '../core/auditCheckpoint.ts'
import { usesDrawer, useCoarsePointer, useViewport, useWindowHeight, useWindowWidth } from '../breakpoints.ts'
import { findHarness, projectFor, usesDemoModel } from '../composerChoice.ts'
import { setSessionOpener } from '../core/blocking.ts'
import { ArchiveUndo } from '../components/ArchiveUndo.tsx'
import { basename } from '../format.ts'
import { readPreferences, setPreference, switchWorkView, toggleWorkView, usePreferences } from '../preferences.ts'
import { shortcutWorksOnPage, workbenchShortcut, type TerminalPaneAction } from '../workbenchShortcuts.ts'
import { frameShortcutAllowed } from '../plugin-pages/model.ts'
import { conversationShown } from '../composer/useArmed.ts'
import {
  RIGHT_PANEL_DEFAULT,
  RIGHT_PANEL_MIN,
  CONVERSATION_MIN,
  rightPanelMax,
  DOCK_DEFAULT,
  DOCK_MIN,
  SIDEBAR_SNAP_MS,
  changesPanelWidth,
  clampDockHeight,
  clampRightPanel,
  clampSidebar,
  dockMax,
  placeRightPanel,
  TABLET_RAIL,
  sidebarAfterDrag,
  sidebarMax,
} from './panelLayout.ts'
import { backRoute, initialRoute, readHomeShown, useSpaces, writeHomeShown } from './spaces.ts'
import { visibleEntries, type AgentPageTarget, type AppTarget, type MyAgentTarget, type ShellEntry, type ShellRoute } from './routes.ts'
import { useAgentRemoval, useDelegation } from '../agents/useAgentWrites.ts'
import { openAgent, topicOwner, type ProfileSection } from '../agents/chat.ts'
import type { SchedulePrefill } from '../agents/activity.ts'
import { askDelegateFocus } from '../agents/delegateFocus.ts'
import { readsAgents } from '../agents/model.ts'
import { defaultAddressee, rosterRows, rosterTopics } from '../agents/roster.ts'
import { useSessionHandoffs } from '../handoffs/useHandoffs.ts'
import { writeFailure } from '../handoffs/model.ts'
import { api, newRequestId, setErrorComputer } from '../core/api.ts'
import type { Handoff } from '@latch/protocol'

import type { PaletteLevel } from '../palette/model.ts'
import { projectOf, listedSessions, readFolded, shelvesKey, spaceOf, steppedSession, type SessionFilter } from '../sessions.ts'
import { connectionWords, hostNoticeCopy } from '../core/hostState.ts'
import { computerLabel } from '../core/securityCopy.ts'
import { hostIsOlder, oldHostWords } from '../core/build.ts'
import { hostLine, useShellLifecycle } from '../core/shellLifecycle.ts'
import { currentShell, shellBrowser, shellFolders } from '../core/shell.ts'
import { useDrawer } from '../hooks/useDrawer.ts'
import { useEndedSessionTabs } from '../panel/browser/useBrowserTabs.ts'
import { useRevealedLogin } from '../panel/terminal/loginRuns.ts'
import { terminalPath } from '../panel/terminal/model.ts'
import { useStableCallback } from '../hooks/useStableCallback.ts'
import { useBackLayer } from '../hooks/backStack.ts'
import { usePhoneReview } from '../phone-review/usePhoneReview.ts'
import { usePromptTemplates } from '../hooks/usePromptTemplates.ts'
import { useSessionSearch } from '../hooks/useSessionSearch.ts'
import { SessionSearchResults } from '../components/SessionSearchResults.tsx'
import { ArchiveBatch } from '../components/ArchiveBatch.tsx'
import { offersPluginPanel, surfaceKey, type PanelSurface } from '../components/SessionPanels.tsx'
import {
  closePanelTab,
  freshPanelMemory,
  openPanelTab,
  panelChoices,
  shownPanelTabs,
  usePanelTabs,
  type PanelKey,
} from '../panel/panelTabs.ts'
import { EASING, MOTION, motionAllowed, usePresence, type ResizePhase, EnterGlyph } from '@latch/ui'
import { popWait } from './popWait.ts'
import { settingsSections, type SettingsSection } from '../settings/SettingsPage.tsx'
import { useSessionController, type SessionSelectionIntent } from './useSessionController.ts'
import type { ChangesLink, ChangesTarget } from '../conversation/changesLink.ts'
import { useFrozenAt } from '../conversation/useFrozenAt.ts'
import { overlayDismissed } from '../escapeGrace.ts'
import { toggleUsage } from '../usage/surface.ts'

type Harness = ReturnType<typeof useHarness>

/** What the workbench keys read of a key press. */
const stroke = (event: KeyboardEvent) => ({
  code: event.code,
  key: event.key,
  metaKey: event.metaKey,
  ctrlKey: event.ctrlKey,
  altKey: event.altKey,
  shiftKey: event.shiftKey,
  isComposing: event.isComposing,
})

/**
 * Gives the input the keys on the next frame, once the page that holds it is drawn, unless something took focus in that
 * frame: a control opened by its key at once (⌥⇧1 right after ⌥N) keeps its menu, and Escape still reaches it.
 */
function focusNextFrame(target: RefObject<HTMLElement | null>) {
  const before = document.activeElement
  requestAnimationFrame(() => {
    const now = document.activeElement
    if (now !== before && now !== null && now !== document.body && now !== target.current) return
    target.current?.focus({ preventScroll: true })
  })
}

/** Everything the signed-in shell holds beside the open session: its columns, its pages, its keys and its lists. */
export function useShellLayout({ harness, snapshot }: { harness: Harness; snapshot: AppSnapshot }) {
  const { selectedId, refresh, resync, connection } = harness
  const viewport = useViewport()
  const phone = viewport === 'phone'
  const [storedRoute, updateRoute] = useState<ShellRoute>(() =>
    initialRoute(
      snapshot.device.id,
      snapshot.catalog?.features?.customAgents === true,
      !phone,
      selectedId !== null,
      readHomeShown(snapshot.device.id),
    ),
  )
  // Code without an open session is its start screen: 新会话 is its input, not a page of its own. A phone keeps its list.
  const route = useMemo<ShellRoute>(
    () =>
      !phone && storedRoute.entry === 'sessions' && !storedRoute.start && selectedId === null
        ? { ...storedRoute, start: true }
        : storedRoute,
    [phone, storedRoute, selectedId],
  )
  const routeRef = useRef(route)
  const [settings, setSettings] = useState<Pick<ShellRoute, 'section' | 'projectId' | 'agent'> | null>(null)
  const closeSettings = useCallback(() => setSettings(null), [])
  routeRef.current = route
  // Where Code was left: its start screen or the open session. A page over it (设置, 应用) returns there, and a reload of
  // this tab finds the start screen again when that was what showed.
  const codePlace = useRef<Pick<ShellRoute, 'start'>>({})
  if (route.entry === 'sessions') codePlace.current = route.start ? { start: true } : {}
  const homeShown = route.entry === 'sessions' ? route.start === true : codePlace.current.start === true
  const preferences = usePreferences()
  /** 看板 covers 对话, which stays mounted under it; a page, a session or 设置 opened from anywhere comes back to 对话. */
  const board = preferences.workView === 'board'
  const leaveBoard = () => {
    if (readPreferences().workView === 'board') setPreference('workView', 'chat')
  }
  /** The start screen's count line: 看板, with that group in view. */
  const askBoardGroup = (group: BoardGroup) => {
    switchWorkView('board')
    requestBoard({ kind: 'group', group })
  }
  /** ⌘N and 新会话 while 看板 is in front open its 新建, which holds the one new-session input then. */
  const askBoardNew = () => {
    requestBoard({ kind: 'new' })
  }
  useEffect(() => {
    writeHomeShown(snapshot.device.id, homeShown)
  }, [snapshot.device.id, homeShown])
  const parkInput = useRef<() => boolean>(() => true)
  const setRoute: Dispatch<SetStateAction<ShellRoute>> = useCallback(next => {
    const target = typeof next === 'function' ? next(routeRef.current) : next
    if (!!target.start !== !!routeRef.current.start && !parkInput.current()) return
    // 我的 Agent and 应用 are pages of 对话.
    if (target.entry !== 'sessions') leaveBoard()
    routeRef.current = target
    updateRoute(target)
  }, [])
  const session = useSessionController({
    harness,
    snapshot,
    inputTarget: route.start ? 'new' : 'session',
    onBeforeSelect: id => {
      // A session opens in 对话, from a card, a notification, the palette or a key alike.
      if (id !== null) leaveBoard()
      clearTimeout(popTimer.current)
      setPopping(false)
      setPushed(id !== null)
      drawer.setOpen(false)
      setInfoPage(false)
      setFileExpanded(false)
      if (id !== null) updateRoute({ entry: 'sessions' })
    },
    onForegroundSent: () => {
      // A late receipt may settle the input, but must not undo an explicit navigation away from it.
      if (routeRef.current.entry !== 'sessions') return
      updateRoute({ entry: 'sessions' })
      setFilter('all')
      setSearch('')
      setPhoneSearching(false)
      setPushed(true)
    },
  })
  parkInput.current = session.parkInputDraft
  const {
    openNotified,
    archivedLast,
    undoArchive,
    forgetArchive,
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
    gate,
    askProject,
  } = session

  const conversationEpoch = `${harness.resyncs}:${selectedId ?? ''}`
  const coarse = useCoarsePointer()
  const drawerMode = usesDrawer(viewport)
  // From 1024px the sidebar can be dragged wider or narrower, or shut.
  const sidebarColumn = viewport === 'laptop' || viewport === 'desktop'
  const windowWidth = useWindowWidth()
  const windowHeight = useWindowHeight()
  /** A drag in progress, and whether it is past the snap point; the width under the pointer goes straight to the page. */
  const [sidebarDrag, setSidebarDrag] = useState<{ collapsed: boolean } | null>(null)
  /** The panel as a page in the conversation's place: on phones, and on tablets too narrow for the column. */
  const [infoPage, setInfoPage] = useState(false)
  /** Phones: the search row under the list's header. */
  const [phoneSearching, setPhoneSearching] = useState(false)
  /** Phones: the open session slides back to the list; it is let go once the slide ends. */
  const [popping, setPopping] = useState(false)
  /** Phones: the open session was pushed over the list while the person watched (not restored with the page). */
  const [pushed, setPushed] = useState(false)
  const popTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** The right panel's edge is being dragged; its width goes straight to the page. */
  const [inspectorDrag, setInspectorDrag] = useState(false)
  const [dockDrag, setDockDrag] = useState(false)
  const appShell = useRef<HTMLDivElement>(null)
  const titlebar = useRef<HTMLDivElement>(null)
  const terminalDock = useRef<HTMLElement>(null)
  /** The open terminal panel's pane keys (split, next and previous pane); set by the panel while it is mounted. */
  const terminalKeys = useRef<((action: TerminalPaneAction) => void) | null>(null)
  const terminalToggle = useRef<HTMLButtonElement>(null)
  /** The current entry, its section, and where a page puts its title. */
  // A wide window opens where this device was last; a session the page restores keeps its own place.
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
  /** The home's input, which starts a session; the open session's own input stays mounted under the home. */
  const homeComposerRef = useRef<HTMLTextAreaElement>(null)
  /** The home with its input focused, for what has already let go of the open session (a fork, a pending start). */
  const showHome = useStableCallback(() => {
    drawer.setOpen(false)
    if (!routeRef.current.start || routeRef.current.entry !== 'sessions') {
      routeRef.current = { entry: 'sessions', start: true }
      updateRoute(routeRef.current)
    }
    focusNextFrame(homeComposerRef)
  })
  const seenProjectRequest = useRef(session.projectAsk.request)
  useEffect(() => {
    if (seenProjectRequest.current === session.projectAsk.request) return
    seenProjectRequest.current = session.projectAsk.request
    // The project list opens from the home's input, so a phone on its session list goes there first.
    if (phone && session.inputId === null && !routeRef.current.start) showHome()
  }, [phone, session.inputId, session.projectAsk.request])
  useEffect(() => {
    if (route.start) focusNextFrame(homeComposerRef)
  }, [route.start])
  const searchRef = useRef<HTMLInputElement>(null)
  const [commandMode, setCommandMode] = useState<PaletteLevel>('root')
  const [commandOpen, setCommandOpen] = useState(false)
  /** The shortcuts over the session (⌘/), which stays open and running under it. */
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  /** Pressing ⌘F with the bar open goes back to its field. */
  const [findFocus, setFindFocus] = useState(0)
  const [search, setSearch] = useState('')
  const promptTemplates = usePromptTemplates(snapshot.catalog?.features?.promptTemplates === true, snapshot.catalog?.promptTemplatesVersion)
  const contentSearch = useSessionSearch(search, snapshot.catalog?.features?.search === true)
  const [searchTarget, setSearchTarget] = useState<SearchHit | null>(null)
  const [filter, setFilter] = useState<SessionFilter>('all')
  /** 我的 Agent's list: 已归档 or not, and whether 最近委托 shows 全部; the keys step through what it shows. */
  const [agentsFilter, setAgentsFilter] = useState<SessionFilter>('all')
  const [agentsExpanded, setAgentsExpanded] = useState(false)
  const entries = visibleEntries(
    settingsSections(snapshot, access),
    phone,
    snapshot.catalog?.features?.customAgents === true,
    snapshot.apps?.some(page => page.status !== 'disabled') === true,
  )
  /** The delegation this device sent from 我的 Agent and has no answer for; kept apart from the new session's draft. */
  const delegation = useDelegation(snapshot, refresh, text => {
    setToast({ text, tone: 'error' })
  })
  const agentRemovals = useAgentRemoval(snapshot, readsAgents(snapshot) && access.scopes.has('view') && access.scopes.has('run'), refresh)
  // Back on the conversation (from a page, or a tab shown again): its approval cards arm again before they take a press.
  const conversationVisible = route.entry === 'sessions' && !route.start && !board
  const wasConversationVisible = useRef(conversationVisible)
  const settingsOpen = settings !== null && entries.includes('settings')
  const wereSettingsOpen = useRef(settingsOpen)
  useLayoutEffect(() => {
    if (wereSettingsOpen.current && !settingsOpen) {
      conversationShown()
      overlayDismissed()
    }
    wereSettingsOpen.current = settingsOpen
  }, [settingsOpen])
  useLayoutEffect(() => {
    if (conversationVisible && !wasConversationVisible.current) conversationShown()
    wasConversationVisible.current = conversationVisible
  }, [conversationVisible])
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === 'visible') conversationShown()
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
  const entriesKey = entries.join()
  // An entry this device can no longer use closes at once.
  useLayoutEffect(() => {
    if (!entries.includes(route.entry)) setRoute({ entry: 'sessions' })
    if (!entries.includes('settings')) closeSettings()
  }, [closeSettings, entriesKey, route.entry])
  const panelToggle = useRef<HTMLButtonElement>(null)
  /** Where focus was when the panel was opened from the keyboard: closing it brings focus back there. */
  const panelReturn = useRef<HTMLElement | null>(null)
  const infoPageRef = useRef<HTMLElement>(null)
  const infoBack = useRef<HTMLButtonElement>(null)
  // The page opens with focus on its way back.
  useEffect(() => {
    if (infoPage) infoBack.current?.focus({ preventScroll: true })
  }, [infoPage])
  const lifecycle = useShellLifecycle()
  const audit = useAuditCheckpoint(host?.hostId, connection === 'connected')
  const draftHarnessId = choice.harnessId ?? catalog?.defaults.harnessId
  const draftFileContext: FileContext | null =
    choice.workspaceId && choice.workspaceId !== 'default' && draftHarnessId
      ? { kind: 'workspace', workspaceId: choice.workspaceId, harnessId: draftHarnessId }
      : null
  const fileContext: FileContext | null = selectedId ? { kind: 'session', sessionId: selectedId } : draftFileContext
  const fileAuthority = JSON.stringify([snapshot.device.dataScope, access.scopes.has('view'), catalog?.features?.filePreview])
  const savedFileTabs = useFileTabs(snapshot.device.id, fileContext, fileAuthority)
  const draftFileTabs = savedFileTabs.forContext(draftFileContext)
  const [draftFilesOpen, setDraftFilesOpen] = useState(false)
  const draftFileKey = draftFileContext ? fileContextKey(draftFileContext) : ''
  useEffect(() => {
    setDraftFilesOpen(false)
  }, [draftFileKey, fileAuthority, route.start])
  const previewAllowed =
    catalog?.features?.filePreview
    && access.scopes.has('view')
    && (fileContext?.kind !== 'workspace' || readsProjectFiles(snapshot.device.dataScope))
  const fileTabs = previewAllowed ? savedFileTabs : { ...savedFileTabs, tabs: [], active: undefined }
  const [fileExpanded, setFileExpanded] = useState(false)
  /** The file a shut panel was showing: opening it again goes back to it. */
  const lastFile = useRef<string | undefined>(undefined)
  /** Set when the empty panel was asked for; one that merely mounted (a session switch, a reload) leaves focus alone. */
  const emptyAsked = useRef(false)
  const canBrowseFiles =
    catalog?.features?.fileTree === true
    && readsProjectFiles(snapshot.device.dataScope)
    && access.scopes.has('view')
    && fileContext !== null
  const canBrowseDraftFiles =
    catalog?.features?.fileTree === true
    && catalog.features.filePreview === true
    && readsProjectFiles(snapshot.device.dataScope)
    && access.scopes.has('view')
    && draftFileContext !== null
  const contextKey = fileContext ? fileContextKey(fileContext) : ''
  // A device without the data scope still gets the tab: it says why there is nothing to read, instead of a toggle that vanished.
  const canViewChanges = catalog?.features?.changes === true && access.scopes.has('view') && !!summary && summary.mode !== 'chat'
  // Like 改动, a device without the data scope keeps the tab: it says the list is locked, and a commit and a push still work.
  const canDeliver = catalog?.features?.gitDelivery === true && access.scopes.has('view') && !!summary && summary.mode !== 'chat'
  const hasTerminal =
    catalog?.features?.terminal === true && access.local && access.scopes.has('run') && snapshot.device.dataScope === 'all'
  const sessionTerminal = hasTerminal && !!summary && !summary.archived && !summary.personal
  const workspaceId = choice.workspaceId ?? catalog?.defaults.workspaceId ?? 'default'
  const terminalWorkspace = catalog?.workspaces.find(item => item.id === workspaceId)
  const terminalTarget: TerminalTarget | undefined = !hasTerminal
    ? undefined
    : route.start || selectedId === null
      ? { workspaceId }
      : sessionTerminal && summary.id === selectedId
        ? { sessionId: summary.id }
        : undefined
  const terminalKey = terminalTarget && terminalPath(terminalTarget)
  const terminalUnavailable =
    terminalTarget?.workspaceId === undefined
      ? undefined
      : (terminalWorkspace?.unavailable ?? (terminalWorkspace ? undefined : '找不到所选项目的文件夹'))
  const terminalLocation = terminalTarget?.workspaceId !== undefined ? terminalWorkspace?.name : summary?.cwd && basename(summary.cwd)
  const canTerminal = terminalTarget !== undefined && !phone && route.entry === 'sessions'
  const dockWanted = canTerminal && preferences.dockOpen
  const [terminalIntent, setTerminalIntent] = useState<string>()
  useLayoutEffect(() => {
    setTerminalIntent(undefined)
  }, [terminalKey, route.entry])
  const dockHeight = clampDockHeight(preferences.dockHeight ?? DOCK_DEFAULT, windowHeight)
  const dockLimit = dockMax(windowHeight)
  // Only the desktop app's own window on this Mac (`latchShell.browser` version 2), for a live session of a project.
  const browserShell = shellBrowser()
  const browserProject =
    summary && catalog && access.local && !summary.archived && !summary.personal ? projectOf(summary, catalog.workspaces) : undefined
  // Anywhere else (a phone, a browser, another computer), the session's tabs on the Mac as a read-only list.
  const browserList =
    browserShell === null
    && catalog?.features?.browserTabs === true
    && !!summary
    && !summary.archived
    && !summary.personal
    && projectOf(summary, catalog.workspaces) !== undefined
  const canBrowser = (browserShell !== null && browserProject !== undefined) || browserList
  // This Mac's simulators: the Host offers them only on host.sock to a device allowed what the terminal is; not on a phone.
  const canDevice = catalog?.features?.simulators === true && !phone && !!summary && !summary.archived
  /** The session's terminals may stand in the right panel instead of the dock (not on a phone, which has neither). */
  const panelTerminal = canTerminal && !!summary && terminalTarget?.sessionId === summary.id
  const offeredPanels = summary ? (catalog?.uiPanels ?? []).filter(panel => offersPluginPanel(panel, summary)) : []
  const panelAvailable = (key: PanelKey): boolean =>
    key === 'overview'
      ? !!summary && spaceOf(summary) === 'code'
      : key === 'changes'
        ? canViewChanges
        : key === 'delivery'
          ? canDeliver
          : key === 'browser'
            ? canBrowser
            : key === 'device'
              ? canDevice
              : key === 'terminal'
                ? panelTerminal
                : key === 'files'
                  ? canBrowseFiles
                  : offeredPanels.some(panel => `plugin:${panel.id}` === key)
  const panelChoiceList = panelChoices({
    browser: canBrowser,
    device: canDevice,
    terminal: panelTerminal,
    files: canBrowseFiles,
    changes: canViewChanges,
    delivery: canDeliver,
    overview: panelAvailable('overview'),
    plugins: offeredPanels.map(panel => ({ id: panel.id, title: panel.title })),
  })
  // The right panel's tabs and the selected one, remembered per session (or project files) on this device.
  const panelStore = usePanelTabs(snapshot.device.id, contextKey)
  const panelFresh = freshPanelMemory(panelAvailable('overview'))
  const panelMemory = panelStore.memory ?? panelFresh
  const panelShown = shownPanelTabs(panelMemory, panelAvailable)
  const changePanel = (next: (memory: typeof panelMemory) => typeof panelMemory) => {
    panelStore.change(panelFresh, next)
  }
  /** The terminals stand in the panel while it has their tab; the dock then stays empty. */
  const terminalInPanel = panelTerminal && panelMemory.tabs.includes('terminal')
  /** Set by showing a surface, cleared by shutting the panel: an overlay panel opens only when asked for. */
  const [surfaceShown, setSurfaceShown] = useState(false)
  /** What the panel shows when a file is not over it. */
  const panelSelected = fileTabs.active ? undefined : panelShown.active
  const selectedShown = (key: PanelKey) => surfaceShown && panelSelected === key
  const changesOpen = selectedShown('changes')
  const deliveryOpen = selectedShown('delivery')
  const browserOpen = selectedShown('browser')
  const filesOpen = selectedShown('files')
  const terminalPanelOpen = selectedShown('terminal')
  const pluginPanel = panelSelected?.startsWith('plugin:') && surfaceShown ? panelSelected.slice(7) : undefined
  const filesVisible = !!fileTabs.active || filesOpen
  const terminalOpen = dockWanted && !terminalInPanel
  useLayoutEffect(() => {
    if (!terminalOpen || dockLimit < DOCK_MIN) setDockDrag(false)
  }, [terminalOpen, dockLimit])
  useEndedSessionTabs(browserShell, snapshot, snapshot.device.dataScope === 'all' && snapshot.device.scopes.includes('view'))
  /** A local service the terminal asked to open in the 浏览器 tab. */
  const [browserRequest, setBrowserRequest] = useState<{ url?: string; nonce: number }>()
  /** Another terminal asked for from 「+」 while the terminals already stand in the panel. */
  const [terminalRequest, setTerminalRequest] = useState(0)
  const [changesTarget, setChangesTarget] = useState<ChangesPanelTarget>()
  const [changesTotals, setChangesTotals] = useState<ChangeTotals>()
  /**
   * The profile of the Agent in view, opened from its face or name (or a link to one of its sections): on wide windows
   * in the right panel's place, in turn with the panel's surfaces; on phones in a bottom sheet.
   */
  const [profile, setProfile] = useState<{ owner: string; section?: ProfileSection; nonce: number; prefill?: SchedulePrefill } | null>(null)
  const profileOwner =
    route.entry === 'agents'
      ? route.myAgent?.id !== 'new'
        ? route.myAgent?.id
        : undefined
      : route.entry === 'sessions'
        ? topicOwner(summary)
        : undefined
  const profileShown = profile !== null && profile.owner === profileOwner ? profile : null
  // Another Agent in view lets the profile go: it opens again only when asked for.
  useEffect(() => {
    if (profile && profileOwner !== undefined && profile.owner !== profileOwner) setProfile(null)
  }, [profile, profileOwner])
  /** The profile stands in the right panel's column beside a topic. */
  const profileColumn = profileShown !== null && route.entry === 'sessions' && !phone
  useLayoutEffect(() => {
    setSurfaceShown(false)
    lastFile.current = undefined
    emptyAsked.current = false
    setInfoPage(false)
    setFileExpanded(false)
    setBrowserRequest(undefined)
    setChangesTarget(undefined)
    setChangesTotals(undefined)
  }, [contextKey, fileAuthority])
  const storedSidebar = preferences.sidebar.width ?? 264
  const sidebarWidth = clampSidebar(storedSidebar, windowWidth)
  const sidebarCollapsed = sidebarShut
  // What stands left of the conversation: the open sidebar, or a tablet's rail.
  const panelLeft = sidebarColumn && !sidebarCollapsed ? sidebarWidth : viewport === 'tablet' ? TABLET_RAIL : 0
  const homeInspector = route.start === true && !phone && canBrowseDraftFiles
  const homeInspectorOpen = homeInspector && draftFilesOpen
  const showingChanges = panelSelected === 'changes'
  const panelWidth =
    preferences.rightPanel.width
    ?? (homeInspector
      ? undefined
      : showingChanges
        ? changesPanelWidth(windowWidth, panelLeft, preferences.diffTree ?? (changesTotals?.files ?? 0) >= TREE_FROM_FILES)
        : !fileTabs.active && (panelSelected === undefined || panelSelected === 'overview')
          ? 400
          : undefined)
  const placed = placeRightPanel({
    windowWidth,
    ...(panelWidth !== undefined ? { width: panelWidth } : {}),
    left: panelLeft,
  })
  const placement = homeInspector
    ? placed
    : !summary && !filesVisible
      ? null
      : !profileColumn && (!!fileTabs.active || panelSelected !== undefined) && fileExpanded
        ? { kind: 'page' as const }
        : profileColumn && placed.kind === 'page'
          ? null
          : placed
  const pageMode = placement?.kind === 'page'
  const hasRememberedSurface =
    !!summary
    && (!entries.includes('agents')
      || spaceOf(summary) === 'code'
      || (canBrowseFiles && summary.mode !== 'chat')
      || canViewChanges
      || canDeliver
      || canBrowser
      || catalog?.uiPanels?.some(panel => offersPluginPanel(panel, summary)) === true)
  const columnOpen =
    placement !== null
    && placement.kind !== 'page'
    && !(findOpen && placement.kind === 'sheet')
    && (route.start === true
      ? homeInspectorOpen
      : profileColumn
        || filesVisible
        || changesOpen
        || deliveryOpen
        || browserOpen
        // A saved layout opens real surfaces on wide windows; a tablet overlay or an empty launcher needs an explicit action.
        // A helper's chat opens it only on a tab this session kept: its conversation is the page, not a launcher beside it.
        || (!!summary
          && preferences.rightPanel.open
          && (infoPage
            || (hasRememberedSurface
              && placement.kind === 'column'
              && (spaceOf(summary) !== 'agents' || !!fileTabs.active || panelSelected !== undefined)))))
  const inspectorWidth = placement !== null && placement.kind !== 'page' ? placement.width : RIGHT_PANEL_DEFAULT
  // Beside the conversation the panel widens only as far as the conversation keeps its minimum.
  const inspectorMax =
    placement?.kind === 'column'
      ? Math.max(RIGHT_PANEL_MIN, Math.min(rightPanelMax(windowWidth), windowWidth - panelLeft - CONVERSATION_MIN))
      : rightPanelMax(windowWidth)
  const drawer = useDrawer({
    enabled: drawerMode && !board,
    navigation,
    inertWhenOpen: [
      { ref: main, base: route.entry !== 'sessions' || route.start === true || board },
      { ref: titlebar, base: false },
      { ref: terminalDock, base: !terminalOpen || board },
    ],
    shut: sidebarCollapsed || board,
  })
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
      if (route.start) {
        if (
          !canBrowseDraftFiles
          || !draftFileContext
          || draftFileContext.kind !== 'workspace'
          || target.workspaceId !== draftFileContext.workspaceId
          || target.harnessId !== draftFileContext.harnessId
        )
          return
        draftFileTabs.open(target)
        setDraftFilesOpen(true)
        return
      }
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
  // Measure the document's prospective panel, not the narrower overview currently on screen.
  const documentPlacement = placeRightPanel({
    windowWidth,
    left: panelLeft,
    ...(preferences.rightPanel.width !== undefined ? { width: preferences.rightPanel.width } : {}),
  })
  useAutoOpenOutputs({
    detail: current,
    available:
      snapshot.catalog?.features?.filePreview === true
      && sidebarColumn
      && documentPlacement.kind !== 'page'
      && conversationVisible
      && !fileExpanded,
    width: documentPlacement.kind !== 'page' ? documentPlacement.width : 0,
    onOpen: openFile,
    onOffer: offerFile,
  })
  /**
   * 新会话 is the home with its input focused. It starts where the person is: in the open session's project, else as last
   * chosen. Without an intent the open session stays open under the home, with its draft, attachments and reading
   * position; an explicit action (a fork, a continuation) lets go of it and may replace the home's draft atomically.
   */
  const startNewDraft = (intent?: SessionSelectionIntent, afterSelect?: () => void) => {
    const project = session.inputId === null ? undefined : projectFor(catalog, summary)
    const arrived = () => {
      submission.setFork(null)
      if (project) submission.updateChoice({ workspaceId: project })
      afterSelect?.()
      focusNextFrame(homeComposerRef)
    }
    if (intent) {
      // choose has already parked the source input; do not save its old render again while changing the route.
      choose(
        null,
        () => {
          showHome()
          arrived()
        },
        intent,
      )
      return
    }
    drawer.setOpen(false)
    if (!routeRef.current.start || routeRef.current.entry !== 'sessions') {
      setRoute({ entry: 'sessions', start: true })
      // A draft too large to park keeps the person where they are.
      if (!routeRef.current.start) return
    }
    arrived()
  }
  /** 新会话: the start screen's input. Under 看板 it moves 对话 there without showing it (看板's 新建 hosts that input). */
  const startNew = () => startNewDraft()
  /**
   * Phones: the open session slides back to the list (180ms), then is let go, and focus lands on its row; at once without
   * motion, or when the browser has already drawn the way back (its own edge swipe).
   */
  const back = (instant = false): void => {
    const id = selectedId
    // Keep the page in place while its unsaved editor asks; only an accepted leave starts the exit animation.
    if (id !== null && requestLeave(id, () => back(instant))) return
    // A conversation in 我的 Agent goes back to its list, not to Code's list it is not on.
    const away = backRoute(summary, entries.includes('agents'))
    const arrive = () => {
      choose(null)
      if (away) {
        setRoute(away)
        return
      }
      requestAnimationFrame(() => {
        if (id !== null) document.querySelector<HTMLElement>(`#session-navigation [data-task-id="${CSS.escape(id)}"]`)?.focus()
      })
    }
    const wait = away ? 0 : popWait(instant)
    if (wait === 0) {
      arrive()
      return
    }
    setPopping(true)
    clearTimeout(popTimer.current)
    popTimer.current = setTimeout(arrive, wait)
  }
  // The confirmation dock opens the session that holds a confirmation back, from settings too.
  useEffect(
    () =>
      setSessionOpener(id => {
        setRoute({ entry: 'sessions' })
        choose(id, closeSettings)
      }),
    [choose, closeSettings],
  )
  const openSettings = (section?: SettingsSection) => {
    leaveBoard()
    setSettings(section ? { section } : {})
  }
  /** 会话 returns to the last open session. 设置 covers the current route without changing it. */
  const goEntry = (entry: ShellEntry) => {
    if (entry === 'settings') {
      openSettings()
      return
    }
    drawer.setOpen(false)
    setRoute(entry === 'sessions' && routeRef.current.entry !== 'sessions' ? { entry, ...codePlace.current } : { entry })
  }
  /** Code and 我的 Agent: which one the shell is in, and the way to the other. */
  const {
    space,
    goSpace: moveSpace,
    waits,
  } = useSpaces({
    snapshot,
    agents: entries.includes('agents'),
    route,
    setRoute,
    selectedId,
    selected: summary,
    choose,
    leave: () => {
      drawer.setOpen(false)
    },
  })
  const goSpace = (target: 'code' | 'agents') => {
    const before = document.activeElement
    const fromSwitch = before instanceof HTMLElement && before.closest('.space-switch, .space-buttons, .phone-tabs')
    moveSpace(target)
    if (!fromSwitch) return
    requestAnimationFrame(() => {
      if (document.activeElement !== before && document.activeElement !== document.body) return
      const control = [
        ...document.querySelectorAll<HTMLElement>(
          '.space-switch [aria-checked="true"], .space-buttons [aria-pressed="true"], .phone-tabs [aria-current="page"]',
        ),
      ].find(element => element.checkVisibility({ visibilityProperty: true }) && !element.closest('[inert]'))
      control?.focus({ preventScroll: true })
    })
  }
  // Moving between Code and 我的 Agent fades the arriving page in; 对话 ⇄ 看板 cross-fades the whole window
  // (`switchWorkView`) and unmounts nothing of 对话.
  const shownSpace = useRef(space)
  useLayoutEffect(() => {
    if (shownSpace.current === space) return
    shownSpace.current = space
    const frame = appShell.current
    if (!frame || !motionAllowed()) return
    const target = frame.querySelector<HTMLElement>(
      route.entry === 'agents' ? '.agents-page' : route.start ? '.workbench-home' : '.workspace-view',
    )
    if (!target) return
    frame.dataset.layoutChanging = ''
    const animation = target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.micro, easing: EASING.micro })
    void animation.finished
      .catch(() => {})
      .then(() => {
        if (shownSpace.current === space) delete frame.dataset.layoutChanging
      })
  }, [space, route.entry, route.start])
  // 对话 ⇄ 看板 keeps the focus where it can stay. Focus that stood on what the other view hides (a sidebar row, a card)
  // has nowhere to stay: it lands on the view itself, never on the document.
  const shownView = useRef(preferences.workView)
  const layoutFocus = useRef<Element | null>(null)
  useEffect(() => {
    const focused = (event: FocusEvent) => {
      layoutFocus.current = event.target instanceof Element ? event.target : null
    }
    const left = (event: FocusEvent) => {
      if (event.relatedTarget === null && document.hasFocus()) layoutFocus.current = null
    }
    layoutFocus.current = document.activeElement
    document.addEventListener('focusin', focused)
    document.addEventListener('focusout', left)
    return () => {
      document.removeEventListener('focusin', focused)
      document.removeEventListener('focusout', left)
    }
  }, [])
  useLayoutEffect(() => {
    if (shownView.current === preferences.workView) return
    shownView.current = preferences.workView
    const before = layoutFocus.current
    const frame = appShell.current
    if (!frame || !(before instanceof HTMLElement) || before === document.body || document.querySelector('dialog[open]')) return
    const lost = !before.isConnected || !before.checkVisibility({ visibilityProperty: true }) || before.closest('[inert]') !== null
    if (!lost) {
      if (document.activeElement !== before) before.focus({ preventScroll: true })
      return
    }
    const page = frame.querySelector<HTMLElement>(
      preferences.workView === 'board'
        ? '.board-surface'
        : route.entry === 'agents'
          ? '.agents-page'
          : route.entry === 'apps'
            ? '.apps-page'
            : route.start
              ? '.workbench-home'
              : 'main.workspace',
    )
    if (!page) return
    // The page is a region, not a control: it takes the keys without joining the tab order or drawing a ring.
    if (!page.hasAttribute('tabindex')) page.tabIndex = -1
    page.dataset.layoutFocus = ''
    page.focus({ preventScroll: true })
  }, [preferences.workView, route.entry, route.start])
  /**
   * A place chosen by its key or the menu bar: once it is drawn, focus lands on its primary (新会话 or 委托…) where that is
   * in sight, else on the place's own button, so it never drops to the page.
   */
  const keyToSpace = (target: 'code' | 'agents') => {
    if (target === 'agents' && !entries.includes('agents')) return
    goSpace(target)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const shown = (selector: string) =>
          [...document.querySelectorAll<HTMLElement>(selector)].find(element => element.checkVisibility() && !element.closest('[inert]'))
        const primary = shown('[data-space-primary]') ?? shown('.space-switch [aria-checked="true"], .space-buttons [aria-pressed="true"]')
        primary?.focus({ preventScroll: true })
      }),
    )
  }
  // The desktop app's menu bar goes to a place as the keys do; the page says it can only where the Host has 我的 Agent.
  const showSpace = useStableCallback(keyToSpace)
  const spacesHere = entries.includes('agents')
  useEffect(() => (spacesHere ? currentShell()?.spaces?.onShow(showSpace) : undefined), [showSpace, spacesHere])
  /** The sessions the keys step through: the place's own, as its list draws them; all of them where there is one place. */
  const listSpace = entries.includes('agents')
    ? space === 'agents'
      ? { space, filter: agentsFilter, expanded: agentsExpanded }
      : { space }
    : {}
  /**
   * The rows the keys step through. In 我的 Agent they are the roster's: each Agent's topics in turn; under 已归档, the
   * archived ones.
   */
  const steppedRows = () => {
    if (entries.includes('agents') && space === 'agents' && agentsFilter !== 'archived')
      return rosterTopics(rosterRows(snapshot, { general: readsAgents(snapshot) }))
    return listedSessions(snapshot.tasks, catalog?.workspaces, {
      filter,
      search,
      folded: readFolded(shelvesKey(snapshot.device.id)),
      projectTree: !phone,
      ...listSpace,
    })
  }
  /**
   * The key of 新会话 in 我的 Agent: the chat of the Agent last spoken with (else 通用), its input ready. Its chat opens as
   * any opening of it does, a new one or the one the Host keeps.
   */
  const delegate = () => {
    askDelegateFocus()
    openMyAgent({ id: defaultAddressee(rosterRows(snapshot, { general: snapshot.device.dataScope === 'all' })) })
  }
  /**
   * 我的 Agent opens its Host-selected chat. The first-message page also holds this device's unconfirmed receipt.
   */
  const openMyAgent = (target?: MyAgentTarget) => {
    drawer.setOpen(false)
    const opening = openAgent(target, snapshot)
    const owner = opening.kind === 'topic' ? opening.owner : opening.target?.id !== 'new' ? opening.target?.id : undefined
    if (owner && opening.section) setProfile(previous => ({ owner, section: opening.section, nonce: (previous?.nonce ?? 0) + 1 }))
    if (opening.kind === 'topic' && (target?.tab || delegation.pending?.customAgentId !== opening.owner)) {
      if (opening.sessionId !== selectedId) choose(opening.sessionId)
      setRoute({ entry: 'sessions' })
      return
    }
    const page = opening.kind === 'topic' ? { id: opening.owner } : opening.target
    setRoute({ entry: 'agents', ...(page ? { myAgent: page } : {}) })
  }
  /**
   * The profile of the Agent in view, at a section; again on the same section brings it back to the top. `prefill` opens
   * the schedule editor filled in from a schedule proposal.
   */
  const openProfile = (owner: string, section?: ProfileSection, prefill?: SchedulePrefill) => {
    setProfile(previous => ({ owner, ...(section ? { section } : {}), ...(prefill ? { prefill } : {}), nonce: (previous?.nonce ?? 0) + 1 }))
  }
  /** Closing gives focus back to the face that opened it. */
  const closeProfile = () => {
    setProfile(null)
    requestAnimationFrame(() => {
      const face = [...document.querySelectorAll<HTMLElement>('.agent-frame-who')].find(
        button => button.checkVisibility() && !button.closest('[inert]'),
      )
      face?.focus({ preventScroll: true })
    })
  }
  const toggleProfile = (owner: string) => {
    if (profileShown) closeProfile()
    else openProfile(owner)
  }
  /** 全部话题: every topic of 我的 Agent grouped by its Agent; `archived` opens it on the archived ones. */
  const openAgentTopics = (archived = false) => {
    drawer.setOpen(false)
    setAgentsFilter(archived ? 'archived' : 'all')
    setRoute({ entry: 'agents', topics: true })
  }
  /** 应用, at a page or at the list. */
  const openApp = (target?: AppTarget) => {
    drawer.setOpen(false)
    setRoute({ entry: 'apps', ...(target ? { app: target } : {}) })
  }
  const openProjectSettings = (projectId: string) => {
    setSettings({ section: 'workspaces', projectId })
  }
  const openAgentPage = (target: AgentPageTarget) => {
    setSettings({ section: 'engines', agent: target })
  }
  /** The start screen keeps its input underneath search; the phone's list has its own field. */
  const openSearch = () => {
    if (!phone || route.start || board) {
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
      && !route.start
      && !board
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

  // 「检查更新…」 in the desktop app's menu: Settings › 关于 shows the update area (main has started the check).
  const showAbout = useRef(() => {})
  showAbout.current = () => {
    if (!document.querySelector('dialog:modal:not(.settings-overlay)')) openSettings('about')
  }
  useEffect(() => currentShell()?.updates?.onShow?.(() => showAbout.current()), [])
  // The desktop app reads the Host itself, so its notification can be ahead of this page, even about a session the page
  // already lists: go as soon as the session is known, and keep looking for its request until the page has read again.
  const [notified, setNotified] = useState<{ id: string; read: boolean; arrived: boolean } | null>(null)
  useEffect(() => {
    const open = (id: string) => {
      setNotified({ id, read: false, arrived: false })
      void refresh().finally(() => {
        setNotified(previous => (previous?.id === id ? { ...previous, read: true } : previous))
      })
    }
    const shell = currentShell()
    // Another computer's window: main asks it to open a session of its own Host (from this Mac's 等你处理 or a notification).
    const stops = [shell?.notifications?.subscribe(open), shell?.computers?.subscribeSession?.(open)]
    return () => {
      for (const stop of stops) stop?.()
    }
  }, [refresh])
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
    requestAnimationFrame(() => (route.start ? homeComposerRef : composerRef).current?.focus())
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
  const newChoicesLocked =
    submission.pending !== null
    || submission.sending
    || attachmentDraft.preparing
    || (route.start ? session.homeComposerState.gate : gate).kind !== 'open'
  // The open column stands beside the conversation, which keeps its minimum width between the two.
  const inspectorBeside = columnOpen && placement?.kind === 'column' ? inspectorWidth : 0
  const sidebarLimit = sidebarMax(windowWidth, inspectorBeside)
  const setSidebarShut = (shut: boolean) => {
    saveSidebar({ collapsed: shut })
  }
  /** A tablet's drawer is the session list, which a page entry does not show. */
  const toggleSidebar = () => {
    if (board) return
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
  /** The panel is on screen: beside the conversation, over it, or as its page. */
  const panelVisible = columnOpen || (pageMode && infoPage)
  const showingTab = (key: PanelKey) => panelVisible && panelSelected === key
  /** Shows one surface of the panel, opening the panel if it is shut; a tab not yet open joins the strip. */
  const showSurface = (surface: PanelSurface) => {
    setProfile(null)
    emptyAsked.current = surface.kind === 'empty'
    const key = surfaceKey(surface)
    if (key) changePanel(memory => openPanelTab(memory, key))
    fileTabs.select(surface.kind === 'file' ? surface.id : undefined)
    setSurfaceShown(true)
    setFileExpanded(false)
    setColumnOpen(true)
    setInfoPage(true)
  }
  const emptyTakesFocus = () => {
    const asked = emptyAsked.current
    emptyAsked.current = false
    return asked
  }
  /** What the panel shows now, or would show once opened again. */
  const shownSurface = (): PanelSurface => {
    if (fileTabs.active) return { kind: 'file', id: fileTabs.active.id }
    const file = lastFile.current && fileTabs.tabs.find(tab => tab.id === lastFile.current)
    if (file) return { kind: 'file', id: file.id }
    if (panelShown.active === undefined) return { kind: 'empty' }
    return panelShown.active.startsWith('plugin:')
      ? { kind: 'plugin', id: panelShown.active.slice(7) }
      : ({ kind: panelShown.active } as PanelSurface)
  }
  /** Shuts the panel; its tabs and the selected one stay for the next opening. */
  const closePanel = () => {
    setProfile(null)
    lastFile.current = fileTabs.active?.id
    setSurfaceShown(false)
    fileTabs.select(undefined)
    setFileExpanded(false)
    setColumnOpen(false)
    setInfoPage(false)
    const back = panelReturn.current
    panelReturn.current = null
    requestAnimationFrame(() => (back?.isConnected ? back : panelToggle.current)?.focus({ preventScroll: true }))
  }
  /** Closes one tab; the panel stays open on its neighbour, or on the choices once none is left. */
  const closePanelTabKey = (key: PanelKey) => {
    changePanel(memory => closePanelTab(memory, key))
    if (key === 'terminal') setTerminalIntent(undefined)
  }
  const openChangesTab = (target?: Omit<ChangesPanelTarget, 'nonce'>) => {
    if (!canViewChanges) return
    showSurface({ kind: 'changes' })
    if (target) setChangesTarget(previous => ({ ...target, nonce: (previous?.nonce ?? 0) + 1 }))
  }
  const closeTerminal = () => {
    setTerminalIntent(undefined)
    setPreference('dockOpen', false)
    requestAnimationFrame(() => terminalToggle.current?.focus({ preventScroll: true }))
  }
  const focusTerminalScreen = (place: HTMLElement | null) =>
    place?.querySelector<HTMLElement>('.terminal-pane[data-focused]:not([hidden]) .xterm-helper-textarea')?.focus()
  const openTerminal = () => {
    if (!canTerminal) return
    setTerminalIntent(terminalKey)
    if (terminalInPanel) {
      if (showingTab('terminal')) focusTerminalScreen(document.querySelector('.session-panel-terminal'))
      else showSurface({ kind: 'terminal' })
    } else if (!terminalOpen) setPreference('dockOpen', true)
    else focusTerminalScreen(terminalDock.current)
  }
  /** A command is to be typed into the session's terminal (or its login shown): where the terminals stand comes forward. */
  const revealTerminal = (asked = false) => {
    if (!canTerminal) return
    if (asked) setTerminalIntent(terminalKey)
    if (terminalInPanel) {
      if (!showingTab('terminal')) showSurface({ kind: 'terminal' })
    } else if (!terminalOpen) setPreference('dockOpen', true)
  }
  const toggleTerminal = () => {
    if (terminalInPanel ? showingTab('terminal') : terminalOpen) {
      if (terminalInPanel) closePanel()
      else closeTerminal()
    } else openTerminal()
  }
  /** The session's terminals leave the dock for a tab of the right panel, or go back to the dock. */
  const moveTerminal = (to: 'panel' | 'dock') => {
    if (!panelTerminal) return
    setTerminalIntent(terminalKey)
    if (to === 'panel') {
      setPreference('dockOpen', false)
      showSurface({ kind: 'terminal' })
    } else {
      changePanel(memory => closePanelTab(memory, 'terminal'))
      setPreference('dockOpen', true)
    }
  }
  /** 「+」 and the empty panel: opens a tab, or focuses the one open; the browser and the terminal add a page or a shell. */
  const choosePanel = (key: PanelKey) => {
    if (key === 'terminal') {
      if (terminalInPanel) setTerminalRequest(previous => previous + 1)
      else setPreference('dockOpen', false)
      setTerminalIntent(terminalKey)
    }
    if (key === 'browser' && browserShell && panelMemory.tabs.includes('browser'))
      setBrowserRequest(previous => ({ nonce: (previous?.nonce ?? 0) + 1 }))
    if (key === 'changes') {
      openChangesTab()
      return
    }
    showSurface(key.startsWith('plugin:') ? { kind: 'plugin', id: key.slice(7) } : ({ kind: key } as PanelSurface))
  }
  /** The 「+」 menu, from its key: the panel opens first when it is shut. */
  const panelAdd = useRef<HTMLButtonElement>(null)
  const openPanelMenu = () => {
    if (!summary && !canBrowseFiles) return
    const press = () => panelAdd.current?.click()
    if (panelVisible) press()
    else {
      showSurface(shownSurface())
      requestAnimationFrame(() => requestAnimationFrame(press))
    }
  }
  const resizeTerminal = (raw: number, step: ResizePhase) => {
    const height = clampDockHeight(raw, windowHeight)
    if (step === 'drag') {
      if (!dockDrag) setDockDrag(true)
      appShell.current?.style.setProperty('--dock-height', `${height}px`)
      return
    }
    setDockDrag(false)
    if (height >= DOCK_MIN) setPreference('dockHeight', height)
  }
  const resetTerminal = () => setPreference('dockHeight', undefined)
  // A Harness's login started from the visible session brings its dock forward once for each start.
  const revealedLogin = useRevealedLogin(canTerminal ? terminalTarget?.sessionId : undefined)?.nonce
  const shownLogin = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (revealedLogin === undefined || shownLogin.current === revealedLogin) return
    shownLogin.current = revealedLogin
    revealTerminal(true)
  })
  const toggleBrowser = () => {
    if (showingTab('browser')) closePanel()
    else if (canBrowser) showSurface({ kind: 'browser' })
  }
  /** A local service from the terminal: in the 浏览器 tab where there is one. */
  const openInBrowser = (url: string) => {
    if (!canBrowser || !browserShell) return false
    setBrowserRequest(previous => ({ url, nonce: (previous?.nonce ?? 0) + 1 }))
    showSurface({ kind: 'browser' })
    return true
  }
  const toggleChanges = () => {
    if (showingTab('changes')) closePanel()
    else openChangesTab()
  }
  /** `keyboard`: opened from a key, so focus moves into the panel's strip and returns on close. */
  const togglePanel = (keyboard = false) => {
    const opening = !(columnOpen || (pageMode && infoPage)) || profileColumn
    if (keyboard && opening && !pageMode) {
      panelReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>('.inspector-column [role="tab"][aria-selected="true"], .inspector-column [role="tab"]')
            ?.focus({ preventScroll: true }),
        ),
      )
    }
    if (homeInspector) {
      setDraftFilesOpen(!homeInspectorOpen)
      if (homeInspectorOpen) requestAnimationFrame(() => panelToggle.current?.focus({ preventScroll: true }))
      return
    }
    if (!summary && canBrowseFiles && !filesVisible) {
      showSurface({ kind: 'files' })
      return
    }
    // The profile stands in the panel's place: the toggle brings the panel back in its stead.
    if (profileColumn || !(columnOpen || (pageMode && infoPage))) showSurface(shownSurface())
    else closePanel()
  }
  const workbenchKeys = useStableCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    const focused = event.target instanceof Element ? event.target : null
    const typing = focused?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') != null
    const action = workbenchShortcut({ ...stroke(event), typing }, currentShell() !== null)
    if (!action) return
    const paneKey = typeof action === 'object' && (action.kind === 'terminal-split' || action.kind === 'terminal-pane')
    // 看板 has no session list, panel, terminal or input of its own: their keys wait for 对话.
    if (
      board
      && (action === 'sidebar'
        || action === 'side-panel'
        || action === 'panel-add'
        || action === 'terminal'
        || action === 'changes'
        || action === 'browser'
        || action === 'files'
        || action === 'close-file'
        || action === 'compose'
        || action === 'file-search'
        || paneKey
        || (typeof action === 'object' && action.kind === 'control'))
    )
      return
    const dialogs = document.querySelectorAll('dialog[open]')
    const only = dialogs.length === 1 ? dialogs[0]! : null
    // An open dialog keeps the keys, but for the one key of what it is: ⌘/ closes the shortcuts it opened.
    const passes =
      (action === 'shortcuts' && only?.classList.contains('shortcuts-overlay'))
      || (action === 'usage' && only?.classList.contains('usage-surface'))
    if (dialogs.length && !passes) return
    // The home's input is the new session's: its four controls and its project's files keep their keys there.
    const homeInputKey =
      route.entry === 'sessions'
      && route.start === true
      && ((typeof action === 'object' && action.kind === 'control')
        || action === 'files'
        || action === 'terminal'
        || paneKey
        || action === 'side-panel')
    if ((route.entry !== 'sessions' || route.start || board) && !shortcutWorksOnPage(action) && !homeInputKey) return
    if (typeof action === 'object') {
      // Held outside a field, or where the layout makes no character of it, the key is the app's even where it finds nothing.
      event.preventDefault()
      if (action.kind === 'space') {
        keyToSpace(action.space)
        return
      }
      if (action.kind === 'session') {
        const target = steppedRows()[action.index - 1]
        if (target && target.id !== selectedId) choose(target.id)
        return
      }
      if (action.kind === 'terminal-split' || action.kind === 'terminal-pane') {
        if (terminalOpen) terminalKeys.current?.(action)
        return
      }
      // A key opens the control's own menu, as a click would; it never picks a value. Phones have no keys for it.
      if (phone) return
      const trigger = [...document.querySelectorAll<HTMLElement>(`[data-composer-control="${action.control}"]`)]
        .find(control => control.getClientRects().length > 0 && !control.closest('[inert]'))
        ?.querySelector<HTMLButtonElement>('button')
      if (trigger && !trigger.disabled && trigger.getAttribute('aria-disabled') !== 'true') trigger.click()
      return
    }
    if (action === 'close-file') {
      if (fileTabs.active) {
        event.preventDefault()
        fileTabs.close(fileTabs.active.id, () => setFileExpanded(false))
      }
      return
    }
    if (action === 'files') {
      if (route.start) {
        if (canBrowseDraftFiles) {
          event.preventDefault()
          browseFiles()
        }
        return
      }
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
      if (route.start) homeComposerRef.current?.focus()
      else if (phone && selectedId === null) showHome()
      else if (pageMode && infoPage) {
        setInfoPage(false)
        requestAnimationFrame(() => composerRef.current?.focus())
      } else composerRef.current?.focus()
      return
    }
    if (action === 'file-search') {
      if (catalog?.features?.fileSearch && readsProjectFiles(snapshot.device.dataScope) && fileContext) {
        event.preventDefault()
        setCommandMode('files')
        setCommandOpen(true)
      }
      return
    }
    event.preventDefault()
    if (action === 'view') {
      toggleWorkView()
      return
    }
    if (action === 'new') {
      // 看板 starts a session from its own 新建, which holds the one new-session input while it is open.
      if (board) askBoardNew()
      else if (space === 'agents') delegate()
      else if (routeRef.current.entry === 'sessions' && routeRef.current.start) {
        drawer.setOpen(false)
        if (!homeComposerRef.current?.closest('.composer')?.querySelector(':popover-open:not([role="tooltip"])'))
          focusNextFrame(homeComposerRef)
      } else startNewDraft()
      return
    }
    if (action === 'sidebar') {
      toggleSidebar()
      return
    }
    if (action === 'side-panel') {
      if (summary || canBrowseFiles || homeInspector) togglePanel(true)
      return
    }
    if (action === 'panel-add') {
      if (!homeInspector && !profileColumn) openPanelMenu()
      return
    }
    if (action === 'changes') {
      if (canViewChanges) toggleChanges()
      return
    }
    if (action === 'terminal') {
      if (canTerminal) toggleTerminal()
      return
    }
    if (action === 'browser') {
      if (canBrowser) toggleBrowser()
      return
    }
    if (action === 'settings') {
      if (entries.includes('settings')) goEntry('settings')
      return
    }
    if (action === 'shortcuts') {
      if (!phone) setShortcutsOpen(open => !open)
      return
    }
    if (action === 'usage') {
      if (access.scopes.has('view')) toggleUsage()
      return
    }
    const target = steppedSession(steppedRows(), selectedId, action === 'next' ? 1 : -1)
    if (target) choose(target.id)
  })
  useEffect(() => {
    window.addEventListener('keydown', workbenchKeys)
    return () => window.removeEventListener('keydown', workbenchKeys)
  }, [workbenchKeys])
  /**
   * A Cmd/Ctrl key pressed in a plugin page's frame: only the shell's own navigation shortcuts hear it. It is never
   * dispatched in the page, so no other listener (an approval's Esc, an undo) can be reached from a frame.
   */
  const frameShortcut = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { ...init, cancelable: true })
    // Never a command that focuses a field (新会话, the input, the palette, find): what the person types next would go
    // into the shell instead of the page.
    if (frameShortcutAllowed(workbenchShortcut({ ...stroke(event), typing: false }, currentShell() !== null))) workbenchKeys(event)
  }
  // A phone has no keys, so nothing it could close the shortcuts with: a window narrowed to one lets them go.
  useEffect(() => {
    if (phone) setShortcutsOpen(false)
  }, [phone])
  const resizeInspector = (raw: number, step: ResizePhase) => {
    const width = Math.min(clampRightPanel(raw, windowWidth), inspectorMax)
    if (step === 'drag') {
      if (!inspectorDrag) setInspectorDrag(true)
      // A sheet stands out of the grid, so its track stays shut until the drop places it.
      if (placed.kind === 'column') appShell.current?.style.setProperty('--inspector-width', `${width}px`)
      appShell.current?.style.setProperty('--inspector-open-width', `${width}px`)
      return
    }
    setInspectorDrag(false)
    // Resizing is an explicit open intent, including when the chosen width turns the column into a sheet.
    setInfoPage(true)
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
  // A session whose Harness was removed names none rather than the default one.
  const topHarness = harnessInfo ?? (summary ? undefined : findHarness(catalog, undefined))
  const savedProject = summary && catalog ? projectOf(summary, catalog.workspaces) : undefined
  const project = savedProject ? savedProject.name || basename(savedProject.path) : undefined
  // The demo label follows what this session (or the new-session choice) actually runs on.
  const demo =
    selectedId === null
      ? usesDemoModel(snapshot, choice.harnessId, choice.model?.providerId)
      : summary !== undefined && usesDemoModel(snapshot, summary.harnessId, summary.providerId)
  const frozenAt = useFrozenAt(connection)
  const changesTabReads = canViewChanges && readsProjectFiles(snapshot.device.dataScope)
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
  // The title, its ⋯ and the sidebar row draw the one session menu; 同步最新状态 lives in the connection's notice.
  const titleMenu = summary ? sessionMenu(summary) : []
  const handoffs = useSessionHandoffs({
    sessionId: selectedId,
    summaries: snapshot.handoffs,
    enabled: catalog?.features?.handoffs === true,
  })
  /** 结束交接: the target of a started handoff closes it; a close without an answer is retried with the same request. */
  const closing = useRef(new Map<string, string>())
  const incoming = handoffs.handoffs.find(item => item.targetSessionId === selectedId && item.status === 'started')
  const closeHandoff = async (handoff: Handoff) => {
    const requestId = closing.current.get(handoff.id) ?? newRequestId()
    closing.current.set(handoff.id, requestId)
    try {
      handoffs.merge(await api<Handoff>(`handoffs/${encodeURIComponent(handoff.id)}/withdraw`, { method: 'POST', body: { requestId } }))
      closing.current.delete(handoff.id)
      setToast({ text: '交接已结束', tone: 'ok' })
    } catch (error) {
      const outcome = writeFailure(error)
      if (outcome.kind !== 'unknown') closing.current.delete(handoff.id)
      setToast({
        text: outcome.kind === 'unknown' ? '结束交接的结果未知，再点一次会重试同一请求' : outcome.message,
        tone: 'error',
      })
    }
  }
  const topMenu =
    incoming && access.scopes.has('run')
      ? [
          ...titleMenu,
          {
            id: 'handoff',
            items: [
              {
                id: 'close-handoff',
                label: '结束交接',
                leading: <EnterGlyph size={14} />,
                onSelect: () => {
                  void closeHandoff(incoming)
                },
              },
            ],
          },
        ]
      : titleMenu
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
  const computer = computerLabel(access.local, snapshot.hostName)
  useEffect(() => {
    setErrorComputer(computer)
  }, [computer])
  // The Host started before this page was built: it may lack what the page calls (core/build.ts).
  const oldHost = hostIsOlder(snapshot.build) ? oldHostWords(computer) : null
  const notice = harness.hostNotice ? hostNoticeCopy(harness.hostNotice, computer) : null
  // The title and 重试 say it; only a reason of the Host's own, or how it comes back, adds a line.
  const { title: connectionTitle, text: connectionText } = connectionWords(connection, notice, hostProblem, harness.failure, computer)
  const devMode = host?.devMode === true
  const level = current?.permission?.level ?? summary?.level

  const browseFiles = () => {
    if (route.start) {
      if (canBrowseDraftFiles) {
        draftFileTabs.select(undefined)
        setDraftFilesOpen(true)
      }
      return
    }
    if (!canBrowseFiles) return
    if (showingTab('files')) closePanel()
    else showSurface({ kind: 'files' })
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
  const returnToFileInput = () => {
    if (draftFilesOpen && route.start) {
      setDraftFilesOpen(false)
      requestAnimationFrame(() => homeComposerRef.current?.focus())
      return
    }
    if (placement?.kind === 'sheet') closePanel()
    else if (pageMode) setInfoPage(false)
    requestAnimationFrame(() => composerRef.current?.focus())
  }
  const mentionFile = (mention: FileMention) => {
    if (!mentionChoice.enabled || fileMentions.length >= 32) return
    submission.setDraft(previous => `${previous.trimEnd()}${previous.trim() ? ' ' : ''}${mentionMarker(mention)} `)
    setFileMentions(previous => [...previous.filter(ref => ref.root !== mention.root || ref.path !== mention.path), mention])
    returnToFileInput()
  }
  const quoteFile = (quote: FileQuote) => {
    const fromDraft = draftFilesOpen && route.start
    const context = fromDraft ? draftFileContext : fileContext
    if (
      !context
      || quote.contextKey !== fileContextKey(context)
      || (!fromDraft && active)
      || submission.pending
      || submission.sending
      || (fromDraft ? session.homeComposerState.gate : gate).kind !== 'open'
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
    returnToFileInput()
  }
  const workspaceForFiles =
    fileContext?.kind === 'workspace' ? catalog?.workspaces.find(item => item.id === fileContext.workspaceId) : undefined
  /** Phones: a session is pushed over the list, which stays beneath it, inert, until the session slides away. */
  const phoneSession = phone && (selectedId !== null || (infoPage && filesVisible))
  /** Phones: a session's changes pushed over the list from its row's 「复核 N 处改动」. */
  const phoneReview = usePhoneReview({ phone: phone && selectedId === null, snapshot, isUnread: session.unread, setSeen: session.setSeen })
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
    if (panelSelected === 'changes') setFileExpanded(false)
    if (phone && selectedId === null) {
      lastFile.current = fileTabs.active?.id
      fileTabs.select(undefined)
      setSurfaceShown(false)
      showHome()
    }
    panelToggle.current?.focus({ preventScroll: true })
  }
  // A pushed page holds a place in the browser's history, so the platform's back returns to the page under it.
  useBackLayer(phone && conversationVisible && selectedId !== null && !popping, instant => {
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
    board,
    showChat: leaveBoard,
    askBoardGroup,
    askBoardNew,
    entries,
    goEntry,
    phoneBackLabel: '返回会话列表',
    space,
    goSpace,
    waits,
    delegate,
    titleSlot,
    setTitleSlot,
    appShell,
    titlebar,
    sidebarColumn,
    sidebarToggle,
    resetInspector,
    harness,
    snapshot,
    selectedId,
    refresh,
    resync,
    connection,
    phoneSession,
    phoneReview,
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
    showHome,
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
    homeComposerRef,
    searchRef,
    commandMode,
    setCommandMode,
    commandOpen,
    setCommandOpen,
    shortcutsOpen,
    setShortcutsOpen,
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
    agentsFilter,
    setAgentsFilter,
    agentsExpanded,
    setAgentsExpanded,
    panelToggle,
    infoPageRef,
    infoBack,
    lifecycle,
    audit,
    fileContext,
    fileAuthority,
    savedFileTabs,
    draftFileContext,
    draftFileTabs,
    draftFilesOpen: draftFilesOpen && route.start === true && canBrowseDraftFiles,
    setDraftFilesOpen,
    canBrowseDraftFiles,
    previewAllowed,
    fileTabs,
    fileExpanded,
    setFileExpanded,
    filesOpen,
    canViewChanges,
    changesOpen,
    canDeliver,
    deliveryOpen,
    canTerminal,
    terminalOpen,
    terminalTarget,
    terminalKey,
    terminalUnavailable,
    terminalLocation,
    terminalRequested: terminalKey !== undefined && terminalIntent === terminalKey,
    terminalDock,
    terminalKeys,
    terminalToggle,
    closeTerminal,
    openTerminal,
    revealTerminal,
    dockHeight,
    dockLimit,
    dockDrag,
    resizeTerminal,
    resetTerminal,
    sessionTerminal,
    homeInspector,
    homeInspectorOpen,
    toggleTerminal,
    browserShell,
    browserProject,
    canBrowser,
    browserList,
    browserOpen,
    toggleBrowser,
    browserRequest,
    openInBrowser,
    showSurface,
    emptyTakesFocus,
    closePanel,
    panelShown,
    panelSelected,
    panelVisible,
    panelChoiceList,
    panelAvailable,
    choosePanel,
    closePanelTabKey,
    panelAdd,
    terminalInPanel,
    terminalRequest,
    moveTerminal,
    panelTerminal,
    openChanges,
    toggleChanges,
    openChangesTab,
    changesTarget,
    changesTotals,
    setChangesTotals,
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
    startNewDraft,
    back,
    openSettings,
    settings: settingsOpen ? settings : null,
    closeSettings,
    openAgentPage,
    openMyAgent,
    openAgentTopics,
    profileOwner,
    profileShown,
    profileColumn,
    openProfile,
    closeProfile,
    toggleProfile,
    openApp,
    frameShortcut,
    delegation,
    agentRemovals,
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
    inspectorBeside,
    sidebarLimit,
    sidebarWidth,
    setSidebarShut,
    toggleSidebar,
    resizeSidebar,
    setColumnOpen,
    togglePanel,
    inspectorMax,
    conversationWidth: windowWidth - panelLeft - (columnOpen && placement?.kind === 'column' ? inspectorWidth : 0),
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
    titleMenu,
    topMenu,
    handoffs,
    canStart,
    startIn,
    connectionProblem,
    frozenAt,
    changesLink,
    shellHost,
    hostProblem,
    computer,
    notice,
    connectionTitle,
    connectionText,
    oldHost,
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
