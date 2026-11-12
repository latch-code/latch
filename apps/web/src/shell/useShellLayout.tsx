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
import type { SearchHit } from '@latch/protocol'
import { useAuditCheckpoint } from '../core/auditCheckpoint.ts'
import { usesDrawer, useCoarsePointer, useViewport, useWindowWidth } from '../breakpoints.ts'
import { findHarness, projectFor, usesDemoModel } from '../composerChoice.ts'
import { setSessionOpener } from '../core/blocking.ts'
import { ArchiveUndo } from '../components/ArchiveUndo.tsx'
import { basename } from '../format.ts'
import { setPreference, usePreferences } from '../preferences.ts'
import { shortcutWorksOnPage, workbenchShortcut } from '../workbenchShortcuts.ts'
import { frameShortcutAllowed } from '../plugin-pages/model.ts'
import { conversationShown } from '../composer/useArmed.ts'
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
import { backRoute, initialRoute, useSpaces } from './spaces.ts'
import { visibleEntries, type AgentPageTarget, type AppTarget, type MyAgentTarget, type ShellEntry, type ShellRoute } from './routes.ts'
import { useDelegation } from '../agents/useAgentWrites.ts'
import { openAgent, topicOwner, type ProfileSection } from '../agents/chat.ts'
import { useSessionHandoffs } from '../handoffs/useHandoffs.ts'
import { writeFailure } from '../handoffs/model.ts'
import { api, newRequestId } from '../core/api.ts'
import type { Handoff } from '@latch/protocol'

import type { PaletteLevel } from '../palette/model.ts'
import { projectOf, listedSessions, readFolded, shelvesKey, steppedSession, type SessionFilter } from '../sessions.ts'
import { connectionWords, hostNoticeCopy } from '../core/hostState.ts'
import { computerLabel } from '../core/securityCopy.ts'
import { hostLine, useShellLifecycle } from '../core/shellLifecycle.ts'
import { currentShell, shellFolders } from '../core/shell.ts'
import { useDrawer } from '../hooks/useDrawer.ts'
import { useStableCallback } from '../hooks/useStableCallback.ts'
import { useBackLayer } from '../hooks/backStack.ts'
import { usePhoneReview } from '../phone-review/usePhoneReview.ts'
import { usePromptTemplates } from '../hooks/usePromptTemplates.ts'
import { useSessionSearch } from '../hooks/useSessionSearch.ts'
import { SessionSearchResults } from '../components/SessionSearchResults.tsx'
import { ArchiveBatch } from '../components/ArchiveBatch.tsx'
import type { PanelSurface } from '../components/SessionPanels.tsx'
import { MOTION, usePresence, type ResizePhase, EnterGlyph } from '@latch/ui'
import { settingsSections, type SettingsSection } from '../settings/SettingsPage.tsx'
import { useSessionController } from './useSessionController.ts'
import type { ChangesLink, ChangesTarget } from '../conversation/changesLink.ts'
import { useFrozenAt } from '../conversation/useFrozenAt.ts'

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
  // A wide window opens where this device was last; a session the page restores keeps its own place.
  const [route, setRoute] = useState<ShellRoute>(() =>
    initialRoute(snapshot.device.id, snapshot.catalog?.features?.customAgents === true, !phone, selectedId !== null),
  )
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
  // Back on the conversation (from a page, or a tab shown again): its approval cards arm again before they take a press.
  const shownEntry = useRef(route.entry)
  useLayoutEffect(() => {
    if (route.entry === 'sessions' && shownEntry.current !== 'sessions') conversationShown()
    shownEntry.current = route.entry
  }, [route.entry])
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
  const draftHarnessId = choice.harnessId ?? catalog?.defaults.harnessId
  const fileContext: FileContext | null = selectedId
    ? { kind: 'session', sessionId: selectedId }
    : choice.workspaceId && choice.workspaceId !== 'default' && draftHarnessId
      ? { kind: 'workspace', workspaceId: choice.workspaceId, harnessId: draftHarnessId }
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
  // Like 改动, a device without the data scope keeps the tab: it says the list is locked, and a commit and a push still work.
  const canDeliver = catalog?.features?.gitDelivery === true && access.scopes.has('view') && !!summary && summary.mode !== 'chat'
  const [deliveryWanted, setDeliveryWanted] = useState(false)
  const deliveryOpen = deliveryWanted && canDeliver
  // Only where the Host offers one (this Mac, a device with run and the full data scope); nowhere else is there a tab.
  const canTerminal = catalog?.features?.terminal === true && !!summary && !summary.archived && !summary.personal
  const [terminalWanted, setTerminalWanted] = useState(false)
  const terminalOpen = terminalWanted && canTerminal
  const [changesTarget, setChangesTarget] = useState<ChangesPanelTarget>()
  const [changesTotals, setChangesTotals] = useState<ChangeTotals>()
  /**
   * The profile of the Agent in view, opened from its face or name (or a link to one of its sections): on wide windows
   * in the right panel's place, in turn with the panel's surfaces; on phones in a bottom sheet.
   */
  const [profile, setProfile] = useState<{ owner: string; section?: ProfileSection; nonce: number } | null>(null)
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
    setFilesOpen(false)
    setPluginPanel(undefined)
    lastSurface.current = { kind: 'launcher' }
    launcherAsked.current = false
    setInfoPage(false)
    setFileExpanded(false)
    setChangesWanted(false)
    setDeliveryWanted(false)
    setTerminalWanted(false)
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
      : !profileColumn && (filesVisible || changesOpen || deliveryOpen || terminalOpen || pluginPanel !== undefined) && fileExpanded
        ? { kind: 'page' as const }
        : profileColumn && placed.kind === 'page'
          ? null
          : placed
  const pageMode = placement?.kind === 'page'
  const columnOpen =
    placement !== null
    && placement.kind !== 'page'
    && (profileColumn || filesVisible || changesOpen || deliveryOpen || terminalOpen || (!!summary && preferences.rightPanel.open))
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
    focusNextFrame(composerRef)
  }
  /**
   * Phones: the open session slides back to the list (180ms), then is let go, and focus lands on its row; at once without
   * motion, or when the browser has already drawn the way back (its own edge swipe).
   */
  const back = (instant = false) => {
    const id = selectedId
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
    if (instant || away || !matchMedia('(prefers-reduced-motion: no-preference)').matches) {
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
    setRoute({ entry: 'settings', ...(section ? { section } : {}) })
  }
  /** 设置 at the sidebar's foot, a tab or the way back. 会话 returns to the last open session. */
  const goEntry = (entry: ShellEntry) => {
    setNewSheet(false)
    drawer.setOpen(false)
    setRoute({ entry })
  }
  /** Code and 我的 Agent: which one the shell is in, and the way to the other. */
  const { space, goSpace, waits } = useSpaces({
    snapshot,
    agents: entries.includes('agents'),
    route,
    setRoute,
    selectedId,
    selected: summary,
    choose,
    leave: () => {
      setNewSheet(false)
      drawer.setOpen(false)
    },
  })
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
   * 委托…, 我的 Agent's primary: the sidebar's row opens its choice of Agent; with the sidebar out of sight, the list page
   * offers the same choice.
   */
  const delegate = () => {
    const trigger = [...document.querySelectorAll<HTMLButtonElement>('[data-delegate-trigger]')].find(
      button => button.checkVisibility() && !button.closest('[inert]'),
    )
    if (trigger) trigger.click()
    else openMyAgent()
  }
  /**
   * 我的 Agent: the list, the form for a new Agent, or a conversation with an Agent. A conversation opens on its current
   * topic, or on a new topic when it has none or one is asked for; a link to a section of the old tabs also opens the
   * profile there.
   */
  const openMyAgent = (target?: MyAgentTarget) => {
    drawer.setOpen(false)
    setNewSheet(false)
    const opening = openAgent(target, snapshot.tasks)
    const owner = opening.kind === 'topic' ? opening.owner : opening.target?.topic === 'new' ? opening.target.id : undefined
    if (owner && opening.section) setProfile(previous => ({ owner, section: opening.section, nonce: (previous?.nonce ?? 0) + 1 }))
    if (opening.kind === 'topic') {
      if (opening.sessionId !== selectedId) choose(opening.sessionId)
      setRoute({ entry: 'sessions' })
      return
    }
    setRoute({ entry: 'agents', ...(opening.target ? { myAgent: opening.target } : {}) })
  }
  /** The profile of the Agent in view, at a section; again on the same section brings it back to the top. */
  const openProfile = (owner: string, section?: ProfileSection) => {
    setProfile(previous => ({ owner, ...(section ? { section } : {}), nonce: (previous?.nonce ?? 0) + 1 }))
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
  /** 应用, at a page or at the list. */
  const openApp = (target?: AppTarget) => {
    drawer.setOpen(false)
    setNewSheet(false)
    setRoute({ entry: 'apps', ...(target ? { app: target } : {}) })
  }
  const openProjectSettings = (projectId: string) => {
    drawer.setOpen(false)
    setNewSheet(false)
    setRoute({ entry: 'settings', section: 'workspaces', projectId })
  }
  const openAgentPage = (target: AgentPageTarget) => {
    drawer.setOpen(false)
    setNewSheet(false)
    setRoute({ entry: 'settings', section: 'engines', agent: target })
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

  // 「检查更新…」 in the desktop app's menu: Settings › 关于 shows the update area (main has started the check).
  const showAbout = useRef(openSettings)
  showAbout.current = openSettings
  useEffect(() => currentShell()?.updates?.onShow?.(() => showAbout.current('about')), [])
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
    setProfile(null)
    launcherAsked.current = surface.kind === 'launcher'
    setChangesWanted(surface.kind === 'changes')
    setDeliveryWanted(surface.kind === 'delivery')
    setTerminalWanted(surface.kind === 'terminal')
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
        : deliveryOpen
          ? { kind: 'delivery' }
          : terminalOpen
            ? { kind: 'terminal' }
            : filesOpen
              ? { kind: 'files' }
              : pluginPanel !== undefined
                ? { kind: 'plugin', id: pluginPanel }
                : { kind: 'launcher' }
  const closePanel = () => {
    setProfile(null)
    lastSurface.current = shownSurface()
    setChangesWanted(false)
    setDeliveryWanted(false)
    setTerminalWanted(false)
    setFilesOpen(false)
    fileTabs.select(undefined)
    setFileExpanded(false)
    setColumnOpen(false)
    setInfoPage(false)
    requestAnimationFrame(() => panelToggle.current?.focus({ preventScroll: true }))
  }
  const openChangesTab = (target?: Omit<ChangesPanelTarget, 'nonce'>) => {
    if (!canViewChanges) return
    setProfile(null)
    setChangesWanted(true)
    setDeliveryWanted(false)
    setTerminalWanted(false)
    setFilesOpen(false)
    fileTabs.select(undefined)
    setInfoPage(true)
    if (target) setChangesTarget(previous => ({ ...target, nonce: (previous?.nonce ?? 0) + 1 }))
  }
  const toggleTerminal = () => {
    if (terminalOpen && !fileTabs.active && (!pageMode || infoPage)) closePanel()
    else if (canTerminal) showSurface({ kind: 'terminal' })
  }
  const toggleChanges = () => {
    if (changesOpen && !fileTabs.active && (!pageMode || infoPage)) closePanel()
    else openChangesTab()
  }
  const togglePanel = () => {
    if (profileColumn) {
      // The profile stands in the panel's place: the toggle brings the panel back in its stead.
      const shown = shownSurface()
      showSurface(shown.kind === 'launcher' ? lastSurface.current : shown)
      return
    }
    if (columnOpen || (pageMode && infoPage)) closePanel()
    else {
      // A page sent back (Esc, the platform's back, sending from it) still holds its surface; only closePanel lets go of it.
      const shown = shownSurface()
      showSurface(shown.kind === 'launcher' ? lastSurface.current : shown)
    }
  }
  const workbenchKeys = useStableCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    const focused = event.target instanceof Element ? event.target : null
    const typing = focused?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') != null
    const action = workbenchShortcut({ ...stroke(event), typing }, currentShell() !== null)
    if (!action) return
    const dialogs = document.querySelectorAll('dialog[open]')
    const only = dialogs.length === 1 ? dialogs[0]! : null
    // An open dialog keeps the keys, but for the one key of what it is: ⌘/ closes the shortcuts it opened.
    const passes =
      (action === 'files' && only?.classList.contains('new-session-sheet'))
      || (action === 'shortcuts' && only?.classList.contains('shortcuts-overlay'))
    if (dialogs.length && !passes) return
    if (route.entry !== 'sessions' && !shortcutWorksOnPage(action)) return
    if (typeof action === 'object') {
      // Held outside a field, or where the layout makes no character of it, the key is the app's even where it finds nothing.
      event.preventDefault()
      if (action.kind === 'space') {
        keyToSpace(action.space)
        return
      }
      if (action.kind === 'session') {
        const folded = readFolded(shelvesKey(snapshot.device.id))
        const target = listedSessions(snapshot.tasks, catalog?.workspaces, { filter, search, folded, ...listSpace })[action.index - 1]
        if (target && target.id !== selectedId) choose(target.id)
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
      if (space === 'agents') delegate()
      else startNew()
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
    if (action === 'terminal') {
      if (canTerminal) toggleTerminal()
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
    const folded = readFolded(shelvesKey(snapshot.device.id))
    const ordered = listedSessions(snapshot.tasks, catalog?.workspaces, { filter, search, folded, ...listSpace })
    const target = steppedSession(ordered, selectedId, action === 'next' ? 1 : -1)
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
  const notice = harness.hostNotice ? hostNoticeCopy(harness.hostNotice, computer) : null
  // The title and 重试 say it; only a reason of the Host's own, or how it comes back, adds a line.
  const { title: connectionTitle, text: connectionText } = connectionWords(connection, notice, hostProblem, harness.failure, computer)
  const devMode = host?.devMode === true
  const level = current?.permission?.level ?? summary?.level

  const browseFiles = () => {
    if (!canBrowseFiles) return
    setChangesWanted(false)
    setDeliveryWanted(false)
    setTerminalWanted(false)
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
    previewAllowed,
    fileTabs,
    fileExpanded,
    setFileExpanded,
    filesOpen,
    setFilesOpen,
    canViewChanges,
    changesOpen,
    canDeliver,
    deliveryOpen,
    canTerminal,
    terminalOpen,
    toggleTerminal,
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
    openAgentPage,
    openMyAgent,
    profileOwner,
    profileShown,
    profileColumn,
    openProfile,
    closeProfile,
    toggleProfile,
    openApp,
    frameShortcut,
    delegation,
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
