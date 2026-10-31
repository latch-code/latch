import { dropAttachments } from './components/AttachmentDrafts.tsx'
import { hasFileMention, mentionMarker } from './fileMentions.ts'
import type { FileMention } from '@latch/protocol'
import { useAttachments } from './hooks/useAttachments.ts'
import { useFileTabs } from './preview/useFileTabs.ts'
import { quoteDraft, type FileQuote } from './preview/quote.ts'
import { FileOpenContext, fileContextKey } from './preview/fileContext.ts'
import { placeFileColumn } from './preview/layout.ts'
import { useAutoOpenOutputs } from './hooks/useAutoOpenOutputs.ts'
import type { ContextFileOpenTarget, FileContext } from '@latch/protocol'
import { VisibleText } from './components/VisibleText.tsx'
import { projectScopeCaption } from './projects.tsx'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ChevronLeft, Info, RefreshCw, ShieldAlert, SquarePen, X } from 'lucide-react'
import type { Approval, AppSnapshot, ModelRef, TaskDetail, TaskSummary, SearchHit, PersonalAssistantSummary } from '@latch/protocol'
import { api, ApiError, errorMessage, inlineError, isUncertain } from './core/api.ts'
import { choiceKind, DecisionRequests, settledOutcome } from './core/approvalDecision.ts'
import { AUDIT_ROLLBACK_TEXT, useAuditCheckpoint } from './core/auditCheckpoint.ts'
import { cancelAnswer, CancelRequests } from './core/cancelRequest.ts'
import { ConfigRequests } from './core/configRequest.ts'
import { SessionDrafts } from './core/sessionDrafts.ts'
import type { SessionConfigFeedback } from './components/modelReasoning.ts'
import { WorkspaceRecovery } from './components/WorkspaceRecovery.tsx'
import { usesDrawer, useCoarsePointer, useViewport, useWindowWidth } from './breakpoints.ts'
import {
  entryKey,
  findHarness,
  findProvider,
  harnessName as harnessLabel,
  projectFor,
  sessionHarness,
  sessionModel,
  startBlock,
  usesDemoModel,
} from './composerChoice.ts'
import {
  clampInspector,
  INSPECTOR_DEFAULT,
  INSPECTOR_MIN,
  inspectorClassOf,
  inspectorMax,
  inspectorOpen,
  placeInspector,
} from './inspectorLayout.ts'
import { openSession, setSessionOpener } from './core/blocking.ts'
import { ConfirmationError, withConfirmation, type ConfirmationPresenter } from './core/confirmations.ts'
import { provideSessionLinks } from './core/sessionLinks.ts'
import { exportFileName, saveText, transcriptMarkdown } from './exportMarkdown.ts'
import { basename, isActive } from './format.ts'
import { approvalActions, composerGate, deviceAccess, harnessLevel, hostView, LEGACY_HOST_TEXT } from './core/permissions.ts'
import { setPreference, storageGet, storageSet, usePreferences } from './preferences.ts'
import { CODE_ROOT_COPY, DECISION_COPY, isSessionStopCode, SESSION_STOP_TEXT, type SessionStopCode } from './core/securityCopy.ts'
import { workbenchShortcut } from './workbenchShortcuts.ts'
import { sessionMenuSections } from './sessionMenu.ts'
import {
  SIDEBAR_MIN,
  SIDEBAR_SNAP_MS,
  clampSidebar,
  defaultSidebarWidth,
  sidebarAfterDrag,
  sidebarMax,
  widthClassOf,
} from './sidebarLayout.ts'
import {
  emptySeen,
  isUnread,
  markSeen,
  markUnread,
  projectOf,
  groupSessions,
  filterSessions,
  pruneSeen,
  readSeen,
  writeSeen,
  type SeenState,
  type SessionFilter,
} from './sessions.ts'
import type { useHarness } from './core/useHarness.ts'
import { useReadingPosition } from './core/useReadingPosition.ts'
import { hostNoticeCopy } from './core/hostState.ts'
import { hostLine, hostNeedsStart, keepAwakeLine, useShellLifecycle } from './core/shellLifecycle.ts'
import { ApprovalVisibilityContext, useApprovalVisibility, useApprovalsInView } from './hooks/useApprovalsInView.ts'
import { currentShell, shellFolders } from './core/shell.ts'
import { useDrawer } from './hooks/useDrawer.ts'
import { useRejectionNote } from './hooks/useRejectionNote.ts'
import { useStableCallback } from './hooks/useStableCallback.ts'
import { useRunClock } from './hooks/useRunClock.ts'
import { useSubmission } from './hooks/useSubmission.ts'
import { usePersonalName } from './hooks/usePersonalName.ts'
import { useSwitchFade } from './hooks/useSwitchFade.ts'
import { openLayer, useBackLayer } from './hooks/backStack.ts'
import { scopedTemplates, usePromptTemplates } from './hooks/usePromptTemplates.ts'
import { useSessionSearch } from './hooks/useSessionSearch.ts'
import { SessionSearchResults } from './components/SessionSearchResults.tsx'
import { GettingStarted } from './components/GettingStarted.tsx'
import { NotificationPrompt } from './components/NotificationPrompt.tsx'
import { KeyboardHelp } from './components/KeyboardHelp.tsx'
import { FindBar } from './components/FindBar.tsx'
import { CommandPalette } from './components/CommandPalette.tsx'
import { ArchiveBatch } from './components/ArchiveBatch.tsx'
import { Composer, type RunState } from './components/Composer.tsx'
import { InlineConfirm } from './components/InlineConfirm.tsx'
import { NewSessionControls, SessionControls } from './components/ComposerControls.tsx'
import { Inspector, type InfoBlock } from './components/Inspector.tsx'
import { SessionPanels } from './components/SessionPanels.tsx'
import { ContextRow, DemoSuggestions, NewSession, SetupCard } from './components/NewSession.tsx'
import { HarnessChoice } from './components/HarnessChoice.tsx'
import { NewSessionSheet } from './components/NewSessionSheet.tsx'
import { PhoneSessionList } from './components/PhoneSessionList.tsx'
import { ConfirmDialog, PromptDialog, type MenuSection } from './components/overlays.tsx'
import { ApprovalStatuses, type ApprovalStatus } from './components/ApprovalCard.tsx'
import { codeRootWorkspace } from './components/CodeRootNotice.tsx'
import { Rail, Sidebar } from './components/Sidebar.tsx'
import { TopBar } from './components/TopBar.tsx'
import { Banner } from './components/Banner.tsx'
import { JumpLatest } from './components/JumpLatest.tsx'
import { PromptQueue } from './components/PromptQueue.tsx'
import { Transcript } from './components/Transcript.tsx'
import { SendingMessage } from './components/SendingMessage.tsx'
import { sendingMessageFor } from './core/sendingMessage.ts'
import { isLive, toolRowId } from './conversation.ts'
import {
  Button,
  Collapse,
  Icon,
  IconButton,
  InlineNotice,
  LiveChanges,
  Loading,
  LayerHistory,
  MOTION,
  ResizeHandle,
  Toast,
  usePresence,
  type ResizePhase,
} from '@latch/ui'
import { SettingsPage, settingsSections, type SettingsSection } from './settings/SettingsPage.tsx'
import { PersonalPage } from './personal/PersonalPage.tsx'

type Harness = ReturnType<typeof useHarness>
type ToastMessage = { text: string; tone: 'ok' | 'error' }
/** Results of session actions belong to the session they were made in, not whichever is open when they settle. */
type ActionError = { sessionId: string; text: string }

const without = <T,>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => {
  const next = new Set(set)
  next.delete(value)
  return next
}

/** The signed-in shell. Mounted once per device identity, so per-device state starts fresh. */
export function Workspace({ harness, snapshot }: { harness: Harness; snapshot: AppSnapshot }) {
  const { selectedId, detail, select, refresh, resync, connection } = harness
  // One-shot indicators play only for changes seen as they happened: a resynchronized snapshot starts a new epoch, and
  // so does a switch of session for what shows the open session (the conversation and its details). The session list
  // lives across switches, so opening an unread session lets its row settle from the dot to the time.
  const conversationEpoch = `${harness.resyncs}:${selectedId ?? ''}`
  const viewport = useViewport()
  const coarse = useCoarsePointer()
  const preferences = usePreferences()
  const phone = viewport === 'phone'
  const drawerMode = usesDrawer(viewport)
  // From 1024px the sidebar can be dragged wider or narrower, or shut; per breakpoint class, on this device only.
  const widthClass = widthClassOf(viewport)
  const windowWidth = useWindowWidth()
  /** A drag in progress: the width under the pointer, or shut once it passed the snap point. */
  const [sidebarDrag, setSidebarDrag] = useState<{ width: number } | { collapsed: true } | null>(null)
  /** 会话信息 as a page in the conversation's place: on phones, and on tablets too narrow for the column. */
  const [infoPage, setInfoPage] = useState(false)
  /** Phones: the new-session sheet over the session list. */
  const [newSheet, setNewSheet] = useState(false)
  const [personalOpen, setPersonalOpen] = useState(false)
  const [personalDraft, setPersonalDraft] = useState<PersonalAssistantSummary | null>(null)
  /** Phones: the search row under the list's header. */
  const [phoneSearching, setPhoneSearching] = useState(false)
  /** Phones: the open session slides back to the list; it is let go once the slide ends. */
  const [popping, setPopping] = useState(false)
  /** Phones: the open session was pushed over the list while the person watched (not restored with the page). */
  const [pushed, setPushed] = useState(false)
  const popTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** The column's width under a drag of its edge. */
  const [inspectorDrag, setInspectorDrag] = useState<number | null>(null)
  /** Shut by the person (its button, a drag past the snap point, the keyboard), as opposed to shut for the column. */
  const sidebarShut =
    widthClass !== null && (sidebarDrag !== null ? 'collapsed' in sidebarDrag : preferences.sidebar.collapsed[widthClass] === true)
  const privateVisible = snapshot.device.dataScope === 'all' && snapshot.device.scopes.includes('view')
  const sessionDrafts = useRef(new SessionDrafts())
  const draftSessionId = useRef(selectedId)
  const draftDevice = useRef(snapshot.device.id)
  const privateDraftId = useRef<string | null>(null)
  const [personalGroupId, setPersonalGroupId] = useState<string | undefined>()
  useLayoutEffect(() => {
    if (!privateVisible) {
      setPersonalDraft(null)
      setPersonalOpen(false)
      setPersonalGroupId(undefined)
    }
  }, [privateVisible])
  const current = detail?.summary.id === selectedId && (!detail.summary.personal || privateVisible) ? detail : null
  const summary = current?.summary ?? snapshot.tasks.find(task => task.id === selectedId && (!task.personal || privateVisible))
  if (summary?.personal && selectedId) privateDraftId.current = selectedId
  else if (privateDraftId.current !== selectedId) privateDraftId.current = null
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
  const rail = useRef<HTMLElement>(null)
  const collapseButton = useRef<HTMLButtonElement>(null)
  const expandButton = useRef<HTMLButtonElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  /** The new-session page's 「添加 Agent」 tile, which the line under the input opens as well. */
  const addAgentTrigger = useRef<HTMLButtonElement>(null)
  const setupTrigger = useRef<HTMLButtonElement>(null)
  /** The input of the phone's new-session sheet, apart from the open session's. */
  const sheetComposerRef = useRef<HTMLTextAreaElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [keyboardHelp, setKeyboardHelp] = useState(false)
  const [commandMode, setCommandMode] = useState<'all' | 'files'>('all')
  const [commandOpen, setCommandOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [search, setSearch] = useState('')
  const promptTemplates = usePromptTemplates(snapshot.catalog?.features?.promptTemplates === true, snapshot.catalog?.promptTemplatesVersion)
  const contentSearch = useSessionSearch(search, snapshot.catalog?.features?.search === true)
  const [searchTarget, setSearchTarget] = useState<SearchHit | null>(null)
  const [filter, setFilter] = useState<SessionFilter>('all')
  const [settings, setSettings] = useState<{ section?: SettingsSection; projectId?: string } | null>(null)
  const inspectorToggle = useRef<HTMLButtonElement>(null)
  const infoPageRef = useRef<HTMLElement>(null)
  const infoBack = useRef<HTMLButtonElement>(null)
  // The page opens with focus on its way back.
  useEffect(() => {
    if (infoPage) infoBack.current?.focus({ preventScroll: true })
  }, [infoPage])
  const [renaming, setRenaming] = useState<TaskSummary | null>(null)
  const [deleting, setDeleting] = useState<TaskSummary | null>(null)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const [approvalBusy, setApprovalBusy] = useState<ReadonlyMap<string, string>>(new Map())
  const [approvalStatuses, setApprovalStatuses] = useState<ReadonlyMap<string, ApprovalStatus>>(new Map())
  const approvalFlights = useRef(new Set<string>())
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set())
  const [cancelUncertain, setCancelUncertain] = useState<ReadonlySet<string>>(new Set())
  // A stop whose answer never came is not known to be under way: only the bar above the input speaks of it.
  const stopping = useMemo(() => new Set([...cancelling].filter(id => !cancelUncertain.has(id))), [cancelling, cancelUncertain])
  const [configBusy, setConfigBusy] = useState<ReadonlyMap<string, string>>(new Map())
  const configRequests = useRef(new ConfigRequests())
  const [configFeedback, setConfigFeedback] = useState<ReadonlyMap<string, SessionConfigFeedback>>(new Map())
  const [recoveryProjects, setRecoveryProjects] = useState<ReadonlyMap<string, string>>(new Map())
  const [workspaceChanged, setWorkspaceChanged] = useState<ReadonlySet<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())
  /** Sessions that stopped accepting input, learned from the Host's refusal. */
  const [stopped, setStopped] = useState<ReadonlyMap<string, SessionStopCode>>(new Map())
  const decisions = useRef(new DecisionRequests())
  const cancels = useRef(new CancelRequests())

  const catalog = snapshot.catalog
  const shell = currentShell()
  const lifecycle = useShellLifecycle()
  const host = hostView(snapshot)
  const scopesKey = host
    ? `${snapshot.device.listener}:${snapshot.device.scopes.join(',')}:${snapshot.device.dataScope}:${snapshot.device.status}`
    : 'legacy'
  // Ignore last-seen churn, but invalidate every access boundary used by private editors.
  const access = useMemo(() => deviceAccess(snapshot, shell), [scopesKey, shell])
  const owner = access.admin
  const canQueue = summary?.personal
    ? !summary.personal.groupId && catalog?.features?.personalQueue === true
    : catalog?.features?.queue === true
  const gateFor = useCallback((approval: Approval) => approvalActions(approval, access.device, shell), [access, shell])
  const audit = useAuditCheckpoint(host?.hostId, connection === 'connected')
  const approvals = useMemo(
    () => current?.approvals ?? snapshot.approvals.filter(approval => approval.sessionId === selectedId),
    [current, snapshot.approvals, selectedId],
  )
  const active = isActive(summary?.status)
  const harnessInfo = sessionHarness(catalog, summary)
  const personalName = usePersonalName(summary?.personal?.assistantId, privateVisible, harness.refreshHints + harness.resyncs)
  // The built-in harness is 「Latch 内置」 wherever the page names it.
  const harnessName = summary?.personal
    ? (personalName ?? '个人助手')
    : harnessInfo
      ? harnessLabel(harnessInfo)
      : (snapshot.harness?.name ?? 'Latch')

  const reading = useReadingPosition({
    sessionId: selectedId,
    ready: current !== null,
    contentVersion: `${current?.cursor ?? 0}:${current?.liveText.length ?? 0}:${current?.liveReasoning?.length ?? 0}:${approvals.length}`,
  })
  // Fade the content, not the masked scroller: animating the latter can leave Chromium's hit-test region empty.
  useSwitchFade(reading.contentRef, current?.summary.id ?? null)
  // The bar above the input says approvals wait only while none of their cards is in view.
  const approvalVisibility = useApprovalVisibility()
  const approvalsInView = useApprovalsInView(approvalVisibility)
  const stopSession = (sessionId: string, cause: unknown) => {
    if (cause instanceof ApiError && cause.code === 'workspace-changed') {
      setWorkspaceChanged(previous => new Set(previous).add(sessionId))
      return true
    }
    if (cause instanceof ApiError && isSessionStopCode(cause.code)) {
      const code = cause.code
      setStopped(previous => new Map(previous).set(sessionId, code))
    }
  }
  const submission = useSubmission({
    snapshot,
    access,
    selectedId,
    assistantId: personalDraft?.id,
    select,
    refresh,
    onSent: (sessionId, sent, { foreground, consumedDraft }) => {
      if (consumedDraft && sent.sessionId !== undefined) sessionDrafts.current.remove(sent.sessionId)
      if (!foreground || sent.queue) return
      draftSessionId.current = sessionId
      if (sent.sessionId === undefined) setPreference('onboarding', 'hidden')
      setPersonalDraft(null)
      setFilter('all')
      setSearch('')
      setNewSheet(false)
      setPhoneSearching(false)
      setPushed(true)
      reading.show(sessionId)
    },
    onRefused: stopSession,
  })
  // A remote deletion clears selection without going through choose; never transfer that session's text to a new task.
  useLayoutEffect(() => {
    if (draftSessionId.current === selectedId) return
    if (draftSessionId.current !== null) sessionDrafts.current.remove(draftSessionId.current)
    draftSessionId.current = selectedId
    submission.setDraft(selectedId === null ? '' : sessionDrafts.current.read(selectedId, privateVisible))
  }, [selectedId])
  useLayoutEffect(() => {
    if (draftDevice.current !== snapshot.device.id) {
      sessionDrafts.current.clear()
      draftDevice.current = snapshot.device.id
      submission.setDraft('')
    } else if (!access.scopes.has('view')) {
      sessionDrafts.current.clear()
      submission.setDraft('')
    } else if (!privateVisible) {
      sessionDrafts.current.clearPrivate()
      if ((privateDraftId.current !== null && privateDraftId.current === selectedId) || personalDraft !== null) submission.setDraft('')
    }
  }, [snapshot.device.id, privateVisible, access.scopes.has('view')])
  const choice: typeof submission.choice = personalDraft
    ? { mode: personalDraft.mode, harnessId: personalDraft.harnessId, model: personalDraft.model }
    : submission.choice
  const fileContext: FileContext | null = selectedId
    ? { kind: 'session', sessionId: selectedId }
    : !personalDraft && choice.mode !== 'chat' && choice.workspaceId && choice.workspaceId !== 'default'
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
  const canBrowseFiles =
    catalog?.features?.fileTree === true && snapshot.device.dataScope === 'all' && access.scopes.has('view') && fileContext !== null
  const filesVisible = !!fileTabs.active || (filesOpen && canBrowseFiles)
  const contextKey = fileContext ? fileContextKey(fileContext) : ''
  useLayoutEffect(() => {
    setFilesOpen(false)
    setInfoPage(false)
    setFileExpanded(false)
  }, [contextKey, fileAuthority])
  const fileIsDocument = fileTabs.active?.file
    ? ['pptx', 'pdf', 'docx', 'xlsx', 'html'].includes(fileTabs.active.file.kind)
    : /\.(?:pptx|pdf|docx|xlsx|html?)$/iu.test(fileTabs.active?.target.reference ?? '')
  const fileWidthKey = `latch.file-width.${snapshot.device.id}.${widthClass ?? 'phone'}.${fileIsDocument ? 'document' : 'content'}`
  const fileStored = Number(storageGet(fileWidthKey))
  // 会话信息: a column beside the paper from 1024px (and on tablets wide enough), else a page in the conversation's place.
  const inspectorClass = inspectorClassOf(windowWidth)
  const storedSidebar = (widthClass ? preferences.sidebar.width[widthClass] : undefined) ?? defaultSidebarWidth(windowWidth)
  const inspectorStored = inspectorDrag ?? (widthClass ? preferences.inspector.width[widthClass] : undefined)
  const placement =
    !summary && !filesVisible
      ? null
      : filesVisible && !fileExpanded
        ? placeFileColumn(
            windowWidth,
            widthClass ? (sidebarShut ? 8 : clampSidebar(storedSidebar, windowWidth)) : 56,
            inspectorDrag ?? (fileStored >= 280 && fileStored <= 4096 ? fileStored : undefined),
            fileIsDocument,
          )
        : filesVisible && fileExpanded
          ? { kind: 'page' as const }
          : placeInspector({
              windowWidth,
              ...(inspectorStored !== undefined ? { width: inspectorStored } : {}),
              ...(widthClass !== null ? { sidebar: sidebarShut ? 8 : clampSidebar(storedSidebar, windowWidth) } : {}),
            })
  const pageMode = placement?.kind === 'page'
  const columnOpen = placement?.kind === 'column' && (filesVisible || (!!summary && inspectorOpen(preferences.inspector, windowWidth)))
  const inspectorWidth = placement?.kind === 'column' ? placement.width : INSPECTOR_DEFAULT
  // While the column is open on a window too narrow for both, the sidebar folds away; closing the column brings it back.
  const sidebarMakesRoom = columnOpen && placement?.kind === 'column' && placement.shutSidebar
  const sidebarCollapsed = sidebarShut || sidebarMakesRoom
  const drawer = useDrawer({ enabled: drawerMode, navigation, inertWhenOpen: [main, rail], shut: sidebarCollapsed })
  /** Where focus goes once the sidebar has opened or shut: after the drawer hook made the column usable or inert. */
  const focusAfterToggle = useRef<{ target: RefObject<HTMLElement | null>; shut: boolean } | null>(null)
  useEffect(() => {
    const pending = focusAfterToggle.current
    if (pending?.shut !== sidebarCollapsed) return
    focusAfterToggle.current = null
    pending.target.current?.focus({ preventScroll: true })
  }, [sidebarCollapsed])
  const saveSidebar = (patch: { width?: number | null; collapsed?: boolean }) => {
    if (widthClass === null) return
    const width = { ...preferences.sidebar.width }
    const collapsed = { ...preferences.sidebar.collapsed }
    if (patch.width === null) delete width[widthClass]
    else if (patch.width !== undefined) width[widthClass] = patch.width
    if (patch.collapsed === true) collapsed[widthClass] = true
    else if (patch.collapsed === false) delete collapsed[widthClass]
    setPreference('sidebar', { width, collapsed })
  }
  const attachmentDraft = useAttachments({
    enabled: catalog?.features?.attachments === true && access.scopes.has('run'),
    selection: {
      harnessId: selectedId === null ? (choice.harnessId ?? catalog?.defaults.harnessId ?? 'standard') : (summary?.harnessId ?? 'standard'),
      ...(selectedId === null && !personalDraft ? { workspaceId: choice.workspaceId ?? catalog?.defaults.workspaceId } : {}),
      ...((selectedId === null ? choice.model : summary?.personal ? sessionModel(summary) : (submission.override ?? sessionModel(summary)))
        ? {
            model:
              selectedId === null
                ? choice.model
                : summary?.personal
                  ? sessionModel(summary)
                  : (submission.override ?? sessionModel(summary)),
          }
        : {}),
    },
    ...(selectedId ? { sessionId: selectedId } : {}),
    draftScope: personalDraft?.id,
    locked: submission.sending || submission.pending !== null,
  })
  const [fileMentions, setFileMentions] = useState<FileMention[]>([])
  const quoteSnapshots = useRef(new Map<string, { etag: string; marker: string }>())
  const mentionScope =
    selectedId ?? `${personalDraft?.id ?? choice.workspaceId ?? ''}:${choice.harnessId ?? ''}:${choice.mode}:${snapshot.device.dataScope}`
  useLayoutEffect(() => {
    if (submission.pending === null) setFileMentions([])
  }, [mentionScope])
  const setSubmissionDraft = (text: string) => {
    submission.setDraft(text)
    setFileMentions(previous => previous.filter(ref => hasFileMention(text, ref)))
  }
  const mentionChoice = {
    enabled:
      catalog?.features?.fileMentions === true
      && snapshot.device.dataScope === 'all'
      && (selectedId !== null || !personalDraft)
      && (selectedId === null ? choice.mode === 'agent' : summary?.mode !== 'chat')
      && (selectedId === null ? findHarness(catalog, choice.harnessId)?.source : harnessInfo?.source) !== 'plugin',
    ...(selectedId ? { sessionId: selectedId } : {}),
    ...(choice.workspaceId && choice.workspaceId !== 'default' ? { workspaceId: choice.workspaceId } : {}),
    harnessId: (selectedId === null ? choice.harnessId : summary?.harnessId) ?? 'standard',
    refs: fileMentions.filter(ref => hasFileMention(submission.draft, ref)),
    onRefs: setFileMentions,
  }
  const sendDraft = async () => {
    if (active && (attachmentDraft.items.length > 0 || mentionChoice.refs.length > 0)) {
      submission.setError('排队暂不支持附件或文件引用，请等本轮结束再发送。')
      return
    }
    const ids = await attachmentDraft.wait()
    if (ids && (await submission.submit(undefined, undefined, active && canQueue, ids, mentionChoice.refs))) {
      attachmentDraft.clear()
      setFileMentions([])
    }
  }
  const retryDraft = async () => {
    if (submission.pending && (await submission.submit(submission.pending))) {
      attachmentDraft.clear()
      setFileMentions([])
    }
  }
  // A Host that records no run times: the time since this page saw the run start, or nothing.
  const pageRunElapsed = useRunClock(snapshot.tasks, selectedId)
  const sendingView = sendingMessageFor(snapshot, submission.sendingMessage, selectedId, current)
  const sendingBubble = sendingView ? <SendingMessage key={sendingView.submission.requestId} view={sendingView} /> : null

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 60_000)
    return () => {
      clearInterval(timer)
    }
  }, [])
  useEffect(() => {
    document.title = snapshot.approvals.length ? `(${snapshot.approvals.length}) Latch` : 'Latch'
  }, [snapshot.approvals.length])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => {
      setToast(null)
    }, 3500)
    return () => {
      clearTimeout(timer)
    }
  }, [toast])
  useEffect(() => {
    if (harness.removed) setToast({ text: '会话已被删除', tone: 'ok' })
  }, [harness.removed])

  // Per-device read markers; the selected session is read while it is open.
  const seenKey = `latch.seen.${location.origin}.${snapshot.device.id}`
  const [seen, setSeen] = useState<SeenState>(() => readSeen(seenKey) ?? emptySeen())
  useEffect(() => {
    if (current) setSeen(previous => markSeen(previous, current.summary.id, current.summary.updatedAt))
  }, [current?.summary.id, current?.summary.updatedAt])
  useEffect(() => {
    setSeen(previous => (Object.keys(previous.seen).length > snapshot.tasks.length + 50 ? pruneSeen(previous, snapshot.tasks) : previous))
  }, [snapshot.tasks])
  useEffect(() => {
    writeSeen(seenKey, seen)
  }, [seenKey, seen])
  const unread = useCallback((task: TaskSummary) => isUnread(task, seen), [seen])

  useEffect(() => {
    const running = (id: string) => snapshot.tasks.some(task => task.id === id && isActive(task.status))
    setCancelling(previous => {
      const next = new Set([...previous].filter(running))
      return next.size === previous.size ? previous : next
    })
    setCancelUncertain(previous => {
      const next = new Set([...previous].filter(running))
      return next.size === previous.size ? previous : next
    })
    // An approval the Host no longer lists was settled, by this device or another: nothing is left to retry or explain.
    setApprovalStatuses(previous => {
      const open = new Set(snapshot.approvals.map(approval => approval.id))
      const next = new Map([...previous].filter(([id]) => open.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [snapshot])

  const choose = useStableCallback((id: string | null) => {
    if (id !== selectedId || id === null) {
      if (selectedId !== null) {
        const personal = summary === undefined || Boolean(summary.personal) || privateDraftId.current === selectedId
        if (!privateVisible && personal) sessionDrafts.current.remove(selectedId)
        else if (!sessionDrafts.current.save(selectedId, submission.draft, personal)) {
          setToast({ text: '草稿超出临时缓存上限，请先复制或缩短内容后再切换。', tone: 'error' })
          return
        }
      }
      submission.setDraft(id === null ? '' : sessionDrafts.current.read(id, privateVisible))
      draftSessionId.current = id
    }
    setPersonalDraft(null)
    clearTimeout(popTimer.current)
    setPopping(false)
    setPushed(id !== null)
    select(id)
    drawer.setOpen(false)
    setInfoPage(false)
    setFileExpanded(false)
    submission.setError('')
    setActionError(previous => (previous?.sessionId === id ? previous : null))
  })
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
      fileTabs.open(target)
      setInfoPage(true)
      return
    }
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
  const documentPlacement = placeFileColumn(windowWidth, sidebarShut ? 8 : storedSidebar)
  useAutoOpenOutputs({
    detail: current,
    available: snapshot.catalog?.features?.filePreview === true && documentPlacement.kind === 'column' && !settings && !fileExpanded,
    width: documentPlacement.kind === 'column' ? documentPlacement.width : 0,
    onOpen: openFile,
  })
  const failAction = (sessionId: string, text: string) => {
    setActionError({ sessionId, text })
  }
  const clearAction = (sessionId: string) => {
    setActionError(previous => (previous?.sessionId === sessionId ? null : previous))
  }
  /** A new session starts where the person is: in the open session's project, else as last chosen. */
  const startNew = () => {
    setPersonalDraft(null)
    setPersonalOpen(false)
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
        setSettings(null)
        choose(id)
      }),
    [choose],
  )
  const openSettings = (section?: SettingsSection) => {
    drawer.setOpen(false)
    setNewSheet(false)
    setSettings(section ? { section } : {})
  }
  const openPersonal = catalog?.features?.personal
    ? () => {
        drawer.setOpen(false)
        setPersonalOpen(true)
      }
    : undefined
  const openProjectSettings = (projectId: string) => {
    drawer.setOpen(false)
    setNewSheet(false)
    setSettings({ section: 'workspaces', projectId })
  }
  // A confirmation refused for a running full-access session names it: 查看会话 opens it, 停止会话 stops it.
  const openBlocking = useStableCallback((id: string) => {
    openSession(id)
  })
  const stopBlocking = useStableCallback(async (id: string) => {
    await cancelSession(id)
  })
  useLayoutEffect(() => {
    provideSessionLinks({ open: openBlocking, stop: stopBlocking, snapshot })
    return () => {
      provideSessionLinks(null)
    }
  }, [openBlocking, stopBlocking, snapshot])
  const openSearch = () => {
    if (phone) {
      if (selectedId !== null) choose(null)
      setPhoneSearching(true)
      requestAnimationFrame(() => {
        searchRef.current?.focus({ preventScroll: true })
      })
    } else if (drawerMode) drawer.show(searchRef.current)
    else if (sidebarCollapsed) {
      // The search is in the shut column: open it, then focus the search once the column can take focus.
      focusAfterToggle.current = { target: searchRef, shut: false }
      saveSidebar({ collapsed: false })
    } else searchRef.current?.focus()
  }

  const searchShortcut = useStableCallback((event: KeyboardEvent) => {
    if (
      event.key.toLowerCase() === 'f'
      && (event.metaKey || event.ctrlKey)
      && selectedId !== null
      && !document.querySelector('dialog[open]')
    ) {
      event.preventDefault()
      setFindOpen(true)
      return
    }
    if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
    if (document.querySelector('dialog[open]')) return
    event.preventDefault()
    setCommandMode('all')
    setCommandOpen(true)
  })
  useEffect(() => {
    window.addEventListener('keydown', searchShortcut)
    return () => {
      window.removeEventListener('keydown', searchShortcut)
    }
  }, [searchShortcut])

  useEffect(
    () =>
      currentShell()?.notifications?.subscribe(id => {
        if (snapshot.tasks.some(task => task.id === id)) choose(id)
      }),
    [choose, snapshot.tasks],
  )
  const { reveal, jumpToLatest } = reading
  const revealApprovals = () => {
    const target = approvals[0]
    if (selectedId !== null) reading.show(selectedId, target && toolRowId(target))
  }

  const openApprovals = () => {
    const oldest = [...snapshot.approvals].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0]
    if (!oldest) return
    choose(oldest.sessionId)
    reading.show(oldest.sessionId, toolRowId(oldest))
  }

  const previousApprovals = useRef(new Set(snapshot.approvals.map(item => item.id)))
  const [approvalToast, setApprovalToast] = useState<{ sessionId: string; id: string } | null>(null)
  useEffect(() => {
    const other = snapshot.approvals.find(item => !previousApprovals.current.has(item.id) && item.sessionId !== selectedId)
    previousApprovals.current = new Set(snapshot.approvals.map(item => item.id))
    if (other) setApprovalToast({ sessionId: other.sessionId, id: other.id })
  }, [snapshot.approvals, selectedId])
  useEffect(() => {
    if (!approvalToast) return
    const timer = setTimeout(() => setApprovalToast(null), 6000)
    return () => clearTimeout(timer)
  }, [approvalToast])
  const approvalCursor = useRef<string | null>(null)
  const [approvalFocus, setApprovalFocus] = useState<string | null>(null)
  const nextApproval = useStableCallback(() => {
    const ordered = snapshot.approvals.toSorted((a, b) => a.requestedAt.localeCompare(b.requestedAt))
    if (!ordered.length) return
    const currentIndex = ordered.findIndex(item => item.id === approvalCursor.current)
    const target = ordered[(currentIndex + 1) % ordered.length]!
    approvalCursor.current = target.id
    setApprovalFocus(target.id)
    choose(target.sessionId)
    reading.show(target.sessionId, toolRowId(target))
  })
  const focusedApproval = snapshot.approvals.find(item => item.id === approvalFocus)
  const approvalFocusRow = focusedApproval && toolRowId(focusedApproval)
  const approvalFocusSession = focusedApproval?.sessionId
  useEffect(() => {
    if (!approvalFocusRow || current?.summary.id !== approvalFocusSession) return
    const frame = requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`.transcript [data-message-id="${CSS.escape(approvalFocusRow)}"]`)
      if (row) {
        row.tabIndex = -1
        row.focus({ preventScroll: true })
        row.setAttribute('data-approval-target', '')
      }
    })
    const timer = setTimeout(() => {
      document.querySelectorAll('[data-approval-target]').forEach(row => row.removeAttribute('data-approval-target'))
      setApprovalFocus(null)
    }, 2500)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [approvalFocusRow, approvalFocusSession, current?.summary.id])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        event.code === 'KeyA'
        && event.altKey
        && (currentShell() ? event.metaKey : event.shiftKey)
        && !document.querySelector('dialog[open]')
      ) {
        event.preventDefault()
        nextApproval()
      }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [nextApproval])
  // `note`: with a rejection of the built-in harness's approval, what to do instead (see `rejectionNoteFor`).
  const decide = useCallback(
    async (approval: Approval, decision: 'allow' | 'reject', optionId: string | undefined, note?: string) => {
      if (approvalFlights.current.has(approval.id)) return
      approvalFlights.current.add(approval.id)
      setApprovalBusy(previous => new Map(previous).set(approval.id, optionId ?? (decision === 'allow' ? 'allow_once' : 'reject_once')))
      clearAction(approval.sessionId)
      // One requestId per decision, reused when the same choice is retried after an unknown outcome.
      const requestId = decisions.current.idFor(approval.id, decision, optionId, note)
      const body = { decision, requestId, ...(optionId ? { optionId } : {}), ...(note && decision === 'reject' ? { note } : {}) }
      const mark = (status: ApprovalStatus) => {
        setApprovalStatuses(previous => {
          if (Object.keys(status).length === 0 && !previous.has(approval.id)) return previous
          const next = new Map(previous)
          if (Object.keys(status).length > 0) next.set(approval.id, status)
          else next.delete(approval.id)
          return next
        })
      }
      // The card is where this confirmation shows: its button waits, the line under the preview says what to do on
      // this computer, and a confirmation that did not pass or could not start leaves its reason in the card. Once
      // confirmed, the line says so until the card folds away; any other ending is settled below.
      const inCard: ConfirmationPresenter = {
        show: (view, actions) => {
          if (view.phase === 'waiting' || view.phase === 'sending')
            mark({ confirming: view.phase, ticket: view.ticket, cancel: actions.cancel })
          else mark({ failure: { text: view.message, tone: view.phase === 'failed' ? 'error' : 'warn' } })
        },
        close: () => {},
      }
      mark({})
      try {
        await withConfirmation(
          confirmation =>
            api<unknown>(`approvals/${encodeURIComponent(approval.id)}`, {
              method: 'POST',
              body,
              ...(confirmation ? { confirmation } : {}),
            }),
          { presenter: inCard },
        )
        decisions.current.settle(approval.id)
        await refresh()
      } catch (cause) {
        decisions.current.settle(approval.id, cause)
        const optionKind = choiceKind(approval, decision, optionId)
        const settled = settledOutcome(cause, { decision, ...(optionKind ? { optionKind } : {}) })
        const unknown = settled === undefined && isUncertain(cause)
        // An unknown outcome stays on the card, which offers to send the same choice again with the same requestId; a
        // reason the card already shows (a confirmation that did not pass) stays too; anything else clears it.
        if (unknown) mark({ uncertain: { decision, optionId, ...(note && decision === 'reject' ? { note } : {}) } })
        else if (!(cause instanceof ConfirmationError && cause.handled)) mark({})
        if (settled === undefined) {
          const text = unknown ? '' : inlineError(cause)
          if (text) failAction(approval.sessionId, text)
        } else if (!settled.applied && settled.conflict) failAction(approval.sessionId, settled.message)
        else if (!settled.applied) setToast({ text: settled.message, tone: 'ok' })
        await refresh()
      } finally {
        approvalFlights.current.delete(approval.id)
        setApprovalBusy(previous => {
          const next = new Map(previous)
          next.delete(approval.id)
          return next
        })
      }
    },
    [refresh],
  )

  const cancelSession = useStableCallback(async (id: string) => {
    if (cancelling.has(id) && !cancelUncertain.has(id)) return
    // The run on screen: a stop that arrives after it ended must not stop the next one.
    const runId = (current?.summary.id === id ? current.summary : snapshot.tasks.find(task => task.id === id))?.runId
    setCancelling(previous => new Set(previous).add(id))
    setCancelUncertain(previous => without(previous, id))
    clearAction(id)
    try {
      const answer = cancelAnswer(
        await api<unknown>(`tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: cancels.current.bodyFor(id, runId) }),
      )
      cancels.current.settle(id)
      if (answer === 'ended' || answer === 'newer') {
        setCancelling(previous => without(previous, id))
        setToast({ text: answer === 'newer' ? '要停止的那一轮已经结束，新的一轮仍在运行' : '这一轮已经结束，无需停止', tone: 'ok' })
      }
      await refresh()
    } catch (cause) {
      cancels.current.settle(id, cause)
      // An unknown outcome is said once, in the bar above the input with its 重试; it is not a failure.
      if (isUncertain(cause)) setCancelUncertain(previous => new Set(previous).add(id))
      else {
        failAction(id, errorMessage(cause))
        setCancelling(previous => without(previous, id))
      }
      throw cause
    }
  })

  const setConfig = async (configId: string, value: string) => {
    if (selectedId === null) return
    const id = selectedId
    const request = configRequests.current.begin(id, configId, value)
    if (!request) return
    setConfigBusy(previous => new Map(previous).set(id, configId))
    setConfigFeedback(previous => {
      const next = new Map(previous)
      next.delete(id)
      return next
    })
    clearAction(id)
    try {
      // Widening a full-access session's permission mode needs a local confirmation.
      await withConfirmation(confirmation =>
        api<unknown>(`tasks/${encodeURIComponent(id)}/config`, {
          method: 'POST',
          body: { configId, value, ...(catalog?.features?.configReceipts === true ? { requestId: request.requestId } : {}) },
          ...(confirmation ? { confirmation } : {}),
        }),
      )
      configRequests.current.settle(id, request)
      await refresh()
    } catch (cause) {
      configRequests.current.settle(id, request, cause)
      stopSession(id, cause)
      const text = inlineError(cause)
      setConfigFeedback(previous =>
        new Map(previous).set(id, {
          kind: isUncertain(cause) ? 'unknown' : 'failed',
          message: isUncertain(cause) ? '切换结果还未确认，请刷新设置查看结果。' : text || '设置未更改，请重新选择。',
        }),
      )
      if (text && !(cause instanceof ApiError && isSessionStopCode(cause.code))) failAction(id, text)
    } finally {
      setConfigBusy(previous => {
        const next = new Map(previous)
        next.delete(id)
        return next
      })
    }
  }

  const refreshConfig = async () => {
    if (selectedId === null) return
    const id = selectedId,
      request = configRequests.current.get(id)
    try {
      const next = await api<TaskDetail>(`tasks/${encodeURIComponent(id)}`)
      const receipt =
        request && catalog?.features?.configReceipts === true
          ? await api<{ state: string }>(`tasks/${encodeURIComponent(id)}/config-requests/${request.requestId}`)
          : undefined
      if (!request || configRequests.current.reconcile(id, request, next.config ?? [], receipt?.state))
        setConfigFeedback(previous => {
          const updated = new Map(previous)
          if (receipt?.state === 'failed') updated.set(id, { kind: 'failed', message: '设置未能切换，当前仍使用执行端显示的值。' })
          else updated.delete(id)
          return updated
        })
      await refresh()
    } catch (cause) {
      setToast({ text: errorMessage(cause), tone: 'error' })
    }
  }

  // A local action says nothing when it works: the row moving or folding away is the feedback. Failures are toasts.
  const patchTask = useStableCallback(async (task: TaskSummary, patch: { pinned?: boolean; archived?: boolean }) => {
    try {
      await api<unknown>(`tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: patch })
      await refresh()
    } catch (cause) {
      setToast({ text: errorMessage(cause), tone: 'error' })
    }
  })
  const exportTask = useStableCallback(async (task: TaskSummary) => {
    try {
      const data = task.id === current?.summary.id ? current : await api<TaskDetail>(`tasks/${encodeURIComponent(task.id)}`)
      await saveText(exportFileName(data.summary.title), transcriptMarkdown(data, { harness: sessionHarness(catalog, data.summary)?.name }))
    } catch (cause) {
      setToast({ text: errorMessage(cause), tone: 'error' })
    }
  })
  const manageable = catalog !== undefined
  const copyTask = useStableCallback(async (task: TaskSummary) => {
    try {
      const data = task.id === current?.summary.id ? current : await api<TaskDetail>(`tasks/${encodeURIComponent(task.id)}`)
      await navigator.clipboard.writeText(transcriptMarkdown(data))
      setToast({ text: '已复制 Markdown', tone: 'ok' })
    } catch (cause) {
      setToast({ text: errorMessage(cause), tone: 'error' })
    }
  })
  const sessionMenu = useCallback(
    (task: TaskSummary): MenuSection[] =>
      sessionMenuSections(
        task,
        {
          unread: () => {
            setSeen(previous => markUnread(previous, task.id))
          },
          copy: () => {
            void copyTask(task)
          },
          rename: () => {
            setRenaming(task)
          },
          pin: () => {
            void patchTask(task, { pinned: !task.pinned })
          },
          archive: () => {
            void patchTask(task, { archived: !task.archived })
          },
          export: () => {
            void exportTask(task)
          },
          remove: () => {
            setDeleting(task)
          },
        },
        manageable,
      ),
    [patchTask, exportTask, copyTask, manageable, setRenaming, setDeleting],
  )

  // Composer: new-session choices or the open session's next-turn settings.
  const block = selectedId === null ? startBlock(snapshot, choice, access) : null
  const chosenHarness = selectedId === null ? findHarness(catalog, choice.harnessId) : undefined
  const chosenScopeCaption =
    choice.mode === 'chat'
      ? undefined
      : projectScopeCaption(
          catalog?.workspaces.find(project => project.id === choice.workspaceId),
          chosenHarness,
        )
  const startsL3 = !access.legacy && chosenHarness !== undefined && harnessLevel(chosenHarness) === 'L3'
  const stopCode: SessionStopCode | undefined =
    selectedId === null ? undefined : summary?.permissionDrift || current?.permission?.drift ? 'permission-drift' : stopped.get(selectedId)
  const gate =
    selectedId === null
      ? access.legacy || access.scopes.has('run')
        ? { kind: 'open' as const }
        : { kind: 'read-only' as const, text: '此设备没有「发起和继续会话」权限' }
      : summary?.personal?.groupId
        ? { kind: 'read-only' as const, text: '这是群聊中的执行记录，请回到个人助手群聊继续。' }
        : composerGate({
            summary,
            permission: current?.permission,
            access,
            stopped: stopCode !== undefined,
          })
  const sessionBlock =
    selectedId === null
      ? undefined
      : workspaceChanged.has(selectedId)
        ? '选择一个项目继续，当前草稿会保留。'
        : harnessInfo?.status === 'unavailable'
          ? harnessInfo.statusMessage || `${harnessInfo.name} 暂不可用`
          : !catalog && snapshot.execution?.ready === false
            ? '当前模型接口不可用，请检查模型插件状态。'
            : undefined
  // 「告诉 Agent 改做什么」 after 拒绝: a Latch 内置 rejection waits for the note in the composer; an agent's goes at once.
  const rejection = useRejectionNote({
    selectedId,
    open: snapshot.approvals,
    active,
    mayType: selectedId !== null && gate.kind === 'open' && sessionBlock === undefined && submission.pending === null,
    hostTakesNote: host?.rejectionNote === true,
    decide: (approval, optionId, note) => {
      void decide(approval, 'reject', optionId, note)
    },
    focusComposer: () => {
      composerRef.current?.focus({ preventScroll: true })
    },
    keepText: text => {
      if (!submission.draft.trim()) submission.setDraft(text)
    },
  })
  const onDecide = useStableCallback(
    (approval: Approval, decision: 'allow' | 'reject', optionId: string | undefined, again?: { note?: string }) => {
      if (decision === 'reject' && again === undefined) rejection.reject(approval, optionId)
      else void decide(approval, decision, optionId, again?.note)
    },
  )
  const statuses = useMemo(
    () =>
      rejection.noting === undefined
        ? approvalStatuses
        : new Map(approvalStatuses).set(rejection.noting, { ...approvalStatuses.get(rejection.noting), noting: true as const }),
    [approvalStatuses, rejection.noting],
  )
  const noteComposer = rejection.composer
  // A new Agent session in a folder inside Latch's program directory: every write will ask on the Host's computer.
  const codeRootChoice =
    selectedId === null && !startsL3 && choice.mode !== 'chat'
      ? codeRootWorkspace(catalog?.workspaces, { id: choice.workspaceId })
      : undefined
  const currentModel = sessionModel(summary)
  const effectiveModel = submission.override ?? currentModel
  const mode = selectedId === null ? choice.mode : (summary?.mode ?? 'agent')
  const manageProviders = owner
    ? () => {
        openSettings('providers')
      }
    : undefined
  const phase = current?.activity?.phase
  const cancelState =
    selectedId !== null && cancelUncertain.has(selectedId)
      ? 'uncertain'
      : selectedId !== null && (cancelling.has(selectedId) || phase === 'cancelling')
        ? 'cancelling'
        : 'idle'
  const firstApproval = approvals[0]
  const run: RunState | undefined =
    selectedId !== null && active
      ? {
          id: selectedId + ':' + (summary?.runId ?? ''),
          ...(current?.plan?.length ? { plan: current.plan } : {}),
          approvals: approvals.length,
          approvalsInView: approvalsInView !== false,
          ...(firstApproval ? { approvalTitle: firstApproval.tool?.title || firstApproval.toolName } : {}),
          onRevealApprovals: revealApprovals,
          cancel: cancelState,
          onCancel: () => {
            if (selectedId !== null) void cancelSession(selectedId).catch(() => {})
          },
        }
      : undefined
  const fallbackElapsed = current?.runStartedAt === undefined ? pageRunElapsed : undefined
  const providerName = useCallback((id: string) => findProvider(catalog, id)?.name, [catalog])
  // Resending the latest turn is the same as typing its prompt again: only where this device may send now.
  const retry =
    selectedId !== null
    && !active
    && gate.kind === 'open'
    && sessionBlock === undefined
    && submission.pending === null
    && !submission.sending
      ? {
          fullAccess: (current?.permission?.level ?? summary?.level) === 'L3',
          onResend: (prompt: string) => {
            void submission.resend(prompt)
          },
        }
      : undefined
  const placeholder =
    submission.pending !== null
      ? '等待确认上一条提交…'
      : selectedId === null
        ? mode === 'chat'
          ? '写下问题或想法…'
          : '描述任务，以及你希望得到的结果…'
        : active
          ? catalog?.features?.queue
            ? '可以先写，本轮完成后自动发送…'
            : '可以先写，本轮结束后发送…'
          : mode === 'chat'
            ? '继续对话 · 不读写文件、不运行命令'
            : `回复 ${harnessInfo ? harnessLabel(harnessInfo) : harnessName}…`
  // Starting a full-access session takes the local confirmation: the send slot says so, and is blocked while this
  // computer cannot confirm.
  const presenceDown = startsL3 && host?.presence.status === 'unavailable'
  const startReason = presenceDown ? `本机确认不可用${host?.presence.message ? `：${host.presence.message}` : ''}` : undefined
  const folders = shellFolders()
  const pickProject =
    folders && access.local && owner && catalog
      ? async (start: boolean) => {
          const result = await folders.pick()
          if (result.status !== 'added') {
            if (result.status === 'failed') setToast({ text: '没有新建项目。请在设置 › 项目中重试。', tone: 'error' })
            if (result.status === 'busy') setToast({ text: '另一个系统对话框还没结束。', tone: 'error' })
            return
          }
          const added = result.added[0]
          const refused = result.refused[0]
          if (refused)
            setToast({ text: `没有加入 ${basename(refused.path)}：${refused.message ?? '执行端拒绝了这个文件夹。'}`, tone: 'error' })
          await refresh()
          if (added) {
            if (start) startNew()
            submission.updateChoice({ workspaceId: added.workspaceId })
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
  const onlyBuiltIn = catalog !== undefined && !catalog.harnesses.some(item => item.source !== 'builtin')
  const composer = (
    <Composer
      textareaRef={composerRef}
      lastPrompt={current?.messages.findLast(message => message.role === 'user')?.text}
      attachments={catalog?.features?.attachments === true && gate.kind === 'open' && !noteComposer ? attachmentDraft : undefined}
      fileMentions={mentionChoice}
      commands={current?.commands}
      templates={scopedTemplates(
        promptTemplates,
        selectedId === null
          ? (choice.workspaceId ?? catalog?.defaults.workspaceId)
          : summary && catalog
            ? projectOf(summary, catalog.workspaces)?.id
            : undefined,
        selectedId === null ? choice.harnessId : summary?.harnessId,
      )}
      variant={selectedId === null ? 'new' : 'session'}
      label={noteComposer?.kind === 'note' ? DECISION_COPY.noteLabel : selectedId === null ? '新会话消息' : '继续对话'}
      placeholder={submission.pending === null ? (noteComposer?.placeholder ?? placeholder) : placeholder}
      draft={noteComposer?.kind === 'note' ? noteComposer.draft : submission.draft}
      onDraft={noteComposer?.kind === 'note' ? noteComposer.onDraft : setSubmissionDraft}
      pending={submission.pending}
      sending={submission.sending}
      error={
        (noteComposer?.kind === 'note' ? noteComposer.error : '')
        || submission.error
        || (actionError?.sessionId === selectedId ? actionError.text : '')
      }
      onRetry={() => {
        void retryDraft()
      }}
      canSend={gate.kind === 'open' && (selectedId === null ? block === null && !presenceDown : sessionBlock === undefined)}
      blockReason={block?.message ?? sessionBlock ?? startReason}
      readOnly={gate.kind === 'read-only' ? gate.text : gate.kind === 'stopped' ? '该会话不再接受输入。' : undefined}
      {...(noteComposer ? { hint: noteComposer.hint } : {})}
      {...(noteComposer?.kind === 'note'
        ? { answer: { label: DECISION_COPY.noteSubmit, onSubmit: noteComposer.submit, onCancel: noteComposer.cancel } }
        : {})}
      below={
        selectedId === null && catalog && !personalDraft ? (
          <>
            <ContextRow
              hostName={snapshot.hostName}
              fullAccess={startsL3}
              onComputer={() => {
                openSettings('computer')
              }}
            />
            {/* Captions open under the row like disclosures, so the input and everything above it stay put. */}
            <Collapse open={codeRootChoice !== undefined}>
              <p className="composer-notice" data-tint="warn" role="note">
                <Icon icon={ShieldAlert} size={14} />
                {codeRootChoice && `${CODE_ROOT_COPY.notice}${codeRootChoice.id === 'default' ? CODE_ROOT_COPY.startDir : ''}`}
              </p>
            </Collapse>
            <Collapse open={chosenScopeCaption !== undefined}>
              <p className="composer-notice" role="note">
                <Icon icon={Info} size={14} />
                <VisibleText text={chosenScopeCaption ?? ''} />
              </p>
            </Collapse>
            <Collapse open={onlyBuiltIn && owner}>
              <button
                type="button"
                className="new-session-hint"
                onClick={() => {
                  // The same place the add tile opens: the presets, added in place.
                  addAgentTrigger.current?.click()
                }}>
                还可以添加 Codex、OpenCode 等 Agent
              </button>
            </Collapse>
          </>
        ) : undefined
      }
      confirmation={
        <InlineConfirm active={submission.sending || (selectedId !== null && configBusy.has(selectedId))} className="composer-confirm" />
      }
      onSubmit={() => {
        void sendDraft()
      }}
      sendKey={preferences.sendKey}
      coarse={coarse}
      run={run}
      queueable={canQueue && !noteComposer}
      queueTray={
        selectedId !== null && current?.queue ? (
          <PromptQueue
            key={selectedId}
            sessionId={selectedId}
            items={current.queue}
            canSend={gate.kind === 'open' && sessionBlock === undefined && !submission.pending}
            canRemove={access.scopes.has('run')}
            onChanged={refresh}
          />
        ) : undefined
      }
      inline={phone && selectedId !== null}
      controls={
        selectedId === null && personalDraft ? (
          <Button variant="ghost" onClick={() => setPersonalOpen(true)}>
            {personalDraft.name}
          </Button>
        ) : selectedId === null ? (
          <NewSessionControls
            phone={false}
            catalog={catalog}
            choice={choice}
            onChoice={submission.updateChoice}
            disabled={submission.pending !== null || submission.sending || gate.kind !== 'open'}
            onManageProviders={manageProviders}
            onManageWorkspaces={
              owner
                ? () => {
                    openSettings('workspaces')
                  }
                : undefined
            }
            onCreateProject={createProject}
            onProvidersChanged={() => {
              void refresh()
            }}
            access={access}
          />
        ) : (
          summary
          && !summary.personal && (
            <SessionControls
              catalog={catalog}
              summary={summary}
              harness={harnessInfo}
              model={effectiveModel}
              current={currentModel}
              onModel={model => {
                submission.setOverride(summary.id, model)
              }}
              config={current?.config ?? []}
              configBusy={configBusy.get(summary.id) ?? null}
              configFeedback={configFeedback.get(summary.id)}
              onConfigRefresh={refreshConfig}
              onConfig={setConfig}
              phone={phone}
              access={access}
              onManageProviders={manageProviders}
              onProvidersChanged={() => {
                void refresh()
              }}
              locked={gate.kind !== 'open'}
            />
          )
        )
      }
    />
  )

  // Phones: the new-session sheet holds its own input, whose 开始 is in the sheet's header.
  const newChoicesLocked = submission.pending !== null || submission.sending || attachmentDraft.preparing || gate.kind !== 'open'
  const sheetComposer = phone && (
    <Composer
      textareaRef={sheetComposerRef}
      fileMentions={mentionChoice}
      attachments={catalog?.features?.attachments === true && gate.kind === 'open' ? attachmentDraft : undefined}
      templates={scopedTemplates(promptTemplates, choice.workspaceId ?? catalog?.defaults.workspaceId, choice.harnessId)}
      variant="sheet"
      label="新会话消息"
      placeholder={placeholder}
      draft={submission.draft}
      onDraft={setSubmissionDraft}
      pending={submission.pending}
      sending={submission.sending}
      error={submission.error}
      onRetry={() => {
        void retryDraft()
      }}
      canSend={gate.kind === 'open' && block === null && !presenceDown}
      blockReason={block?.message ?? startReason}
      readOnly={gate.kind === 'read-only' ? gate.text : undefined}
      below={
        codeRootChoice ? (
          <p className="composer-notice" role="note">
            {CODE_ROOT_COPY.notice}
            {codeRootChoice.id === 'default' && CODE_ROOT_COPY.startDir}
          </p>
        ) : undefined
      }
      onSubmit={() => {
        void sendDraft()
      }}
      sendKey={preferences.sendKey}
      coarse={coarse}
      confirmation={<InlineConfirm active={submission.sending} rank={1} className="composer-confirm" />}
      controls={null}
    />
  )
  const sheetCanStart =
    selectedId === null
    && gate.kind === 'open'
    && block === null
    && !presenceDown
    && !newChoicesLocked
    && (submission.draft.trim().length > 0 || attachmentDraft.items.length > 0)

  // The open column stands beside the paper, which keeps its minimum width between the two columns.
  const inspectorBeside = columnOpen ? inspectorWidth : 0
  const sidebarLimit = sidebarMax(windowWidth, inspectorBeside)
  const sidebarWidth =
    sidebarDrag !== null && 'width' in sidebarDrag ? sidebarDrag.width : clampSidebar(storedSidebar, windowWidth, inspectorBeside)
  /** Shuts or opens the sidebar; from its own buttons, focus follows to the button that does the opposite. */
  const setSidebarShut = (shut: boolean, moveFocus: boolean) => {
    if (moveFocus) focusAfterToggle.current = { target: shut ? expandButton : collapseButton, shut }
    // The sidebar folded to make room for the column: opening it again closes the column.
    if (!shut && sidebarMakesRoom) setColumnOpen(false)
    saveSidebar({ collapsed: shut })
  }
  const resizeSidebar = (raw: number, step: ResizePhase) => {
    const next = sidebarAfterDrag(raw, windowWidth, inspectorBeside)
    if (step === 'drag') {
      // Passing the snap point either way slides the column; widths in between follow the pointer.
      if (next.collapsed !== sidebarCollapsed) snapSidebar()
      setSidebarDrag(next.collapsed ? { collapsed: true } : { width: next.width })
      return
    }
    setSidebarDrag(null)
    saveSidebar(next.collapsed ? { collapsed: true } : { width: next.width, collapsed: false })
  }
  const setColumnOpen = (open: boolean) => {
    if (inspectorClass === null) return
    setPreference('inspector', { ...preferences.inspector, open: { ...preferences.inspector.open, [inspectorClass]: open } })
  }
  const toggleInspector = () => {
    if (filesOpen) {
      setFilesOpen(false)
      fileTabs.select(undefined)
      setFileExpanded(false)
      setColumnOpen(true)
      setInfoPage(true)
      return
    }
    if (fileTabs.active) {
      fileTabs.select(undefined)
      setFileExpanded(false)
      setColumnOpen(true)
      return
    }
    if (pageMode) setInfoPage(!infoPage)
    else setColumnOpen(!columnOpen)
  }
  const workbenchKeys = useStableCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    const action = workbenchShortcut(event, currentShell() !== null)
    if (!action) return
    const dialogs = document.querySelectorAll('dialog[open]')
    if (dialogs.length && !(action === 'files' && dialogs.length === 1 && dialogs[0]!.classList.contains('new-session-sheet'))) return
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
      if (drawerMode) drawer.setOpen(!drawer.open)
      else setSidebarShut(!sidebarCollapsed, true)
      return
    }
    if (action === 'help') {
      setKeyboardHelp(true)
      return
    }
    const ordered = groupSessions(filterSessions(snapshot.tasks, filter, search), catalog?.workspaces).flatMap(group => group.tasks)
    const index = ordered.findIndex(task => task.id === selectedId)
    const target =
      typeof action === 'object' ? ordered[action.nth] : ordered[(index + (action === 'next' ? 1 : -1) + ordered.length) % ordered.length]
    if (target) choose(target.id)
  })
  useEffect(() => {
    window.addEventListener('keydown', workbenchKeys)
    return () => window.removeEventListener('keydown', workbenchKeys)
  }, [workbenchKeys])
  const toggleBlock = (id: InfoBlock, collapse: boolean) => {
    const collapsed = preferences.inspector.collapsed.filter(item => item !== id)
    setPreference('inspector', { ...preferences.inspector, collapsed: collapse ? [...collapsed, id] : collapsed })
  }
  const resizeInspector = (raw: number, step: ResizePhase) => {
    const width = clampInspector(raw, windowWidth, sidebarCollapsed ? 8 : sidebarWidth)
    if (step === 'drag') {
      setInspectorDrag(width)
      return
    }
    setInspectorDrag(null)
    if (widthClass !== null)
      setPreference('inspector', { ...preferences.inspector, width: { ...preferences.inspector.width, [widthClass]: width } })
  }
  /**
   * Shows a row of the conversation: a row inside a closed disclosure (the folded process of a turn) is opened first,
   * as the browser's find would open it, and the reading position keeps the row in place while it opens.
   */
  const revealRow = (messageId: string) => {
    const row = document.querySelector(`.transcript [data-message-id="${CSS.escape(messageId)}"]`)
    for (let hidden = row?.closest('[hidden="until-found"]'); hidden; hidden = hidden.parentElement?.closest('[hidden="until-found"]')) {
      hidden.dispatchEvent(new Event('beforematch'))
    }
    requestAnimationFrame(() => {
      reveal(messageId)
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
  const findReveal = useStableCallback((messageId: string) => {
    revealRow(messageId)
  })
  const revealFromInspector = (messageId: string) => {
    setInfoPage(false)
    revealRow(messageId)
  }
  // Where the session runs: its harness (a Host without a catalog runs the built-in one) and its project's folder.
  const topHarness = harnessInfo ?? (snapshot.harness ? { ...snapshot.harness, source: 'builtin' as const } : undefined)
  const savedProject = summary && catalog ? projectOf(summary, catalog.workspaces) : undefined
  const project = savedProject ? savedProject.name || basename(savedProject.path) : undefined
  // The demo label follows what this session (or the new-session choice) actually runs on.
  const demo =
    selectedId === null
      ? usesDemoModel(snapshot, choice.harnessId, choice.model?.providerId)
      : summary !== undefined && usesDemoModel(snapshot, summary.harnessId, summary.providerId)
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
  const connectionProblem = harness.error || connection === 'reconnecting' || connection === 'offline'
  // What is known about why the Host does not answer: main's own view on the desktop, else the Host's announcement.
  const shellHost = lifecycle.view?.host
  const hostProblem = shellHost && shellHost.status !== 'running' ? hostLine(shellHost) : null
  const notice = harness.hostNotice ? hostNoticeCopy(harness.hostNotice) : null
  const connectionTitle = connection === 'offline' ? '当前设备已离线' : (hostProblem?.text ?? notice?.title ?? '连接已中断，正在重连…')
  const connectionText =
    connection === 'offline'
      ? '已读内容仍可查看；恢复连接后会同步执行端状态。'
      : (notice?.body ?? (hostProblem ? '恢复后会同步执行端的最新状态。' : harness.error || '恢复后会同步执行端的最新状态。'))
  const devMode = host?.devMode === true
  const level = current?.permission?.level ?? summary?.level

  // 会话信息: the same blocks in the column beside the paper and in the page that takes the conversation's place.
  const infoLocked =
    selectedId && workspaceChanged.has(selectedId)
      ? '原会话的文件夹已变化，请选择一个项目继续。'
      : selectedId && configFeedback.get(selectedId)?.kind === 'unknown'
        ? '上次设置切换的结果还未确认，请先在模型菜单刷新设置。'
        : gate.kind === 'stopped'
          ? '该会话不再接受输入。'
          : gate.kind === 'read-only'
            ? level === 'L3' && !access.local
              ? `完全访问会话的选项只能在 ${snapshot.hostName} 上用 Latch 桌面端更改`
              : gate.text
            : undefined
  const browseFiles = () => {
    if (!canBrowseFiles) return
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
  const inspector = (summary || filesVisible) && (
    <SessionPanels
      key={contextKey}
      fileContext={canBrowseFiles && fileContext ? fileContext : undefined}
      fileRevision={JSON.stringify(summary?.folders ?? workspaceForFiles?.folders ?? workspaceForFiles?.path)}
      treeView={fileTabs.treeView}
      onTreeViewChange={fileTabs.setTreeView}
      showFiles={filesOpen}
      onShowFiles={setFilesOpen}
      onSearchFiles={searchFiles}
      onMention={mentionChoice.enabled && !active && !submission.pending ? mentionFile : undefined}
      onQuote={active ? undefined : quoteFile}
      folders={workspaceForFiles?.folders}
      cwd={workspaceForFiles?.path}
      panels={catalog?.uiPanels ?? []}
      files={fileTabs.tabs}
      activeFile={fileTabs.active}
      fileExpanded={fileExpanded}
      local={access.local}
      deviceId={snapshot.device.id}
      detail={current}
      onFileView={fileTabs.view}
      onSelectFile={id => {
        fileTabs.select(id)
        setFileExpanded(false)
      }}
      onCloseFile={id => {
        fileTabs.close(id)
        setFileExpanded(false)
        if (fileTabs.tabs.length === 1) {
          setInfoPage(false)
          requestAnimationFrame(() => inspectorToggle.current?.focus({ preventScroll: true }))
        }
      }}
      onFileResolved={(id, file) => {
        fileTabs.resolved(id, file)
        if (!fileContext) return
        const quote = quoteSnapshots.current.get(fileContextKey(fileContext) + '\n' + file.root + '\n' + file.path)
        if (quote && quote.etag !== file.etag && submission.draft.includes(quote.marker)) {
          setToast({ text: file.name + ' 已更新，草稿中的引用保留原内容，可能已过时。', tone: 'ok' })
          quote.etag = file.etag
        }
      }}
      onExpandFile={() => {
        setFileExpanded(value => !value)
        setInfoPage(true)
      }}
      summary={summary}
      canCompose={gate.kind === 'open' && !submission.pending && !submission.sending && sessionBlock === undefined}
      onCompose={text => {
        submission.setDraft(previous => (previous.trim() ? `${previous}\n\n${text}` : text))
        if (pageMode) setInfoPage(false)
        composerRef.current?.focus()
      }}>
      {summary && (
        <Inspector
          snapshot={snapshot}
          summary={summary}
          detail={current}
          local={access.local}
          admin={access.admin}
          onProjectsChanged={() => {
            void refresh()
          }}
          onEditProject={owner ? openProjectSettings : undefined}
          controls={{
            ...(!summary.personal && harnessInfo?.models === 'host' && (catalog?.providers.length ?? 0) > 0
              ? {
                  model: {
                    ...(effectiveModel ? { value: effectiveModel } : {}),
                    ...(currentModel ? { current: currentModel } : {}),
                    onChange: model => {
                      submission.setOverride(summary.id, model)
                    },
                  },
                }
              : {}),
            config: summary.personal ? [] : (current?.config ?? []),
            busy: configBusy.get(summary.id) ?? null,
            onConfig: (configId, value) => setConfig(configId, value),
            ...(infoLocked ? { locked: infoLocked } : {}),
          }}
          collapsed={new Set(preferences.inspector.collapsed)}
          onToggleBlock={toggleBlock}
          onReveal={revealFromInspector}
          onSource={choose}
          {...(owner && shell
            ? {
                onNewProject: () => {
                  openSettings('workspaces')
                },
              }
            : {})}
        />
      )}
    </SessionPanels>
  )
  // The connection and the Host itself: over the open conversation, or at the top of a phone's list.
  const hostBanners = (
    <>
      <NotificationPrompt />
      <Banner show={Boolean(connectionProblem)}>
        <InlineNotice
          tone={hostProblem?.tone === 'error' && connection !== 'offline' ? 'error' : 'warn'}
          title={connectionTitle}
          action={
            shellHost && hostNeedsStart(shellHost) && connection !== 'offline' ? (
              <Button
                size="xs"
                onClick={() => {
                  void lifecycle.restartHost().then(message => {
                    if (message) setToast({ text: message, tone: 'error' })
                  })
                }}>
                启动 Host
              </Button>
            ) : (
              <Button
                size="xs"
                onClick={() => {
                  void resync()
                }}>
                重试
              </Button>
            )
          }>
          {connectionText}
        </InlineNotice>
      </Banner>
      <Banner show={audit.rollback}>
        <InlineNotice
          tone="error"
          secure
          action={
            <span className="banner-actions">
              <Button size="xs" onClick={audit.accept}>
                已核对
              </Button>
              <IconButton className="banner-close" label="关闭提示" icon={X} size="xs" onClick={audit.dismiss} />
            </span>
          }>
          {AUDIT_ROLLBACK_TEXT}
        </InlineNotice>
      </Banner>
      <Banner show={access.legacy}>
        <InlineNotice tone="neutral" secure>
          {LEGACY_HOST_TEXT}
        </InlineNotice>
      </Banner>
    </>
  )
  /** Phones: a session is pushed over the list, which stays beneath it, inert, until the session slides away. */
  const phoneSession = phone && (selectedId !== null || (infoPage && filesVisible))
  const harnessChoices = !personalDraft && catalog && (
    <HarnessChoice
      addRef={addAgentTrigger}
      catalog={catalog}
      workspaceId={choice.workspaceId}
      value={choice.harnessId ? entryKey(choice.harnessId, choice.mode) : undefined}
      access={access}
      disabled={newChoicesLocked}
      onManage={owner ? () => openSettings('agents') : undefined}
      onChange={entry => submission.updateChoice({ harnessId: entry.harness.id, mode: entry.mode })}
      onAdded={agent => {
        submission.updateChoice({ harnessId: agent.id, mode: 'agent' })
        void refresh()
      }}
    />
  )
  const setupCard = (
    <>
      {submission.fork && (
        <InlineNotice tone="neutral">
          正在从「{submission.fork.title ?? submission.fork.taskId}」分叉。文件不会复制或回滚；同一项目中的会话共用项目文件夹。
          <Button size="xs" variant="ghost" onClick={() => submission.setFork(null)}>
            取消分叉
          </Button>
        </InlineNotice>
      )}
      {block && (
        <SetupCard
          triggerRef={setupTrigger}
          block={block}
          owner={owner}
          providers={
            owner && catalog
              ? {
                  access,
                  onSettings: () => openSettings('providers'),
                  onSaved: (model: ModelRef) => {
                    submission.updateChoice({ model })
                    void refresh()
                  },
                }
              : undefined
          }
          onSetup={() => {
            openSettings(block.kind === 'model-required' ? 'providers' : catalog ? 'agents' : 'plugins')
          }}
        />
      )}
    </>
  )
  const suggest = (prompt: string) => {
    submission.setDraft(prompt)
    ;(phone ? sheetComposerRef : composerRef).current?.focus()
  }
  const column = usePresence(columnOpen, MOTION.panel)
  const page = usePresence(pageMode && infoPage, MOTION.pushExit)
  const closeInfoPage = () => {
    setInfoPage(false)
    if (phone && selectedId === null) {
      fileTabs.select(undefined)
      setFilesOpen(false)
      setNewSheet(true)
    }
    inspectorToggle.current?.focus({ preventScroll: true })
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

  return (
    <FileOpenContext.Provider value={catalog?.features?.filePreview ? openFile : undefined}>
      <LayerHistory value={phone ? openLayer : null}>
        <LiveChanges value={harness.resyncs}>
          <div
            className={`app-shell viewport-${viewport}`}
            data-viewport={viewport}
            data-connection={connection}
            data-sidebar={widthClass === null ? undefined : sidebarCollapsed ? 'collapsed' : 'open'}
            data-inspector={columnOpen ? 'open' : undefined}
            data-resizing={(sidebarDrag !== null && !sidebarSnapping) || inspectorDrag !== null ? '' : undefined}
            style={{
              // Shut, each side column keeps the window inset, so the paper sits 8px in on every side.
              ...(widthClass === null
                ? {}
                : {
                    '--sidebar-width': sidebarCollapsed ? 'var(--shell-inset)' : `${sidebarWidth}px`,
                    '--sidebar-open-width': `${sidebarWidth}px`,
                  }),
              '--inspector-width': columnOpen ? `${inspectorWidth}px` : 'var(--shell-inset)',
              '--inspector-open-width': `${inspectorWidth}px`,
            }}>
            {viewport === 'tablet' && (
              <nav ref={rail} className="rail" aria-label="快捷导航">
                <Rail
                  onPersonal={openPersonal}
                  approvals={snapshot.approvals.length}
                  drawerOpen={drawer.open}
                  onSessions={() => {
                    drawer.show()
                  }}
                  onNew={startNew}
                  onSearch={openSearch}
                  onApprovals={openApprovals}
                  onSettings={() => {
                    openSettings()
                  }}
                  devMode={devMode}
                />
              </nav>
            )}
            {drawerMode && drawer.open && (
              <button
                type="button"
                className="drawer-backdrop"
                aria-label="关闭会话列表"
                tabIndex={-1}
                onClick={() => {
                  drawer.setOpen(false)
                }}
              />
            )}
            {phone ? (
              <section
                id="session-navigation"
                className="phone-list"
                aria-label="会话"
                data-covered={phoneSession && !popping ? '' : undefined}
                inert={(phoneSession && !popping) || undefined}>
                <PhoneSessionList
                  onPersonal={openPersonal}
                  snapshot={snapshot}
                  searchResults={searchResults}
                  archiveBatch={archiveBatch}
                  selectedId={selectedId}
                  isUnread={unread}
                  cancelling={stopping}
                  search={search}
                  onSearch={setSearch}
                  searchRef={searchRef}
                  searching={phoneSearching}
                  onSearching={setPhoneSearching}
                  filter={filter}
                  onFilter={setFilter}
                  onSelect={choose}
                  onNew={startNew}
                  onNewIn={startIn}
                  onCreateProject={createProjectAndStart}
                  onEditProject={owner ? openProjectSettings : undefined}
                  onProjectsChanged={() => {
                    void refresh()
                  }}
                  onApprovals={openApprovals}
                  onSettings={() => {
                    openSettings()
                  }}
                  onRefresh={resync}
                  sessionMenu={sessionMenu}
                  now={now}
                  banners={selectedId === null ? hostBanners : undefined}
                />
              </section>
            ) : (
              <aside
                ref={navigation}
                id="session-navigation"
                className={`sidebar ${drawer.open ? 'is-open' : ''}`}
                aria-label="会话导航"
                role={drawerMode && drawer.open ? 'dialog' : undefined}
                aria-modal={drawerMode && drawer.open ? true : undefined}
                tabIndex={-1}>
                <Sidebar
                  onPersonal={openPersonal}
                  snapshot={snapshot}
                  searchResults={searchResults}
                  archiveBatch={archiveBatch}
                  selectedId={selectedId}
                  isUnread={unread}
                  cancelling={stopping}
                  search={search}
                  onSearch={setSearch}
                  searchRef={searchRef}
                  filter={filter}
                  onFilter={setFilter}
                  onSelect={choose}
                  onNew={startNew}
                  onNewIn={startIn}
                  onCreateProject={createProjectAndStart}
                  onEditProject={owner ? openProjectSettings : undefined}
                  onProjectsChanged={() => {
                    void refresh()
                  }}
                  newActive={selectedId === null}
                  onApprovals={openApprovals}
                  onNextApproval={nextApproval}
                  drawer={drawerMode}
                  onClose={() => {
                    drawer.setOpen(false)
                  }}
                  onCollapse={
                    widthClass === null
                      ? undefined
                      : () => {
                          setSidebarShut(true, true)
                        }
                  }
                  collapseRef={collapseButton}
                  connection={connection}
                  onRefresh={() => {
                    void resync()
                  }}
                  onSettings={() => {
                    openSettings()
                  }}
                  sessionMenu={sessionMenu}
                  now={now}
                  devMode={devMode && !drawerMode}
                  {...(lifecycle.view?.keepAwake.active ? { keepAwake: keepAwakeLine(lifecycle.view.keepAwake) } : {})}
                />
              </aside>
            )}
            {widthClass !== null && (
              <ResizeHandle
                className="sidebar-resize"
                label="调整侧栏宽度"
                value={sidebarCollapsed ? 0 : sidebarWidth}
                min={SIDEBAR_MIN}
                max={sidebarLimit}
                collapsed={sidebarCollapsed}
                onResize={resizeSidebar}
                onReset={() => {
                  setSidebarDrag(null)
                  saveSidebar({ width: null, collapsed: false })
                }}
                onToggle={() => {
                  setSidebarShut(!sidebarCollapsed, false)
                }}
              />
            )}
            <LiveChanges value={conversationEpoch}>
              {(!phone || phoneSession) && (
                <main
                  ref={main}
                  onDragEnter={event => {
                    if (
                      catalog?.features?.attachments === true
                      && gate.kind === 'open'
                      && [...event.dataTransfer.types].includes('Files')
                    ) {
                      event.preventDefault()
                      attachmentDraft.setDragging(true)
                    }
                  }}
                  onDragOver={event => {
                    if ([...event.dataTransfer.types].includes('Files')) event.preventDefault()
                  }}
                  onDragLeave={event => {
                    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
                      attachmentDraft.setDragging(false)
                  }}
                  onDropCapture={event => {
                    attachmentDraft.setDragging(false)
                    if (catalog?.features?.attachments === true && gate.kind === 'open' && !noteComposer)
                      dropAttachments(event, attachmentDraft)
                    else if ([...event.dataTransfer.types].includes('Files')) event.preventDefault()
                  }}
                  className={`workspace ${selectedId === null ? 'is-new' : 'has-task'}`}
                  data-info-page={pageMode && infoPage ? '' : undefined}
                  data-pushed={phone && pushed ? '' : undefined}
                  data-leaving={phone && popping ? '' : undefined}>
                  {attachmentDraft.dragging && (
                    <div className="attachment-drop-mask" role="status">
                      松开以添加到这条消息
                    </div>
                  )}
                  {/* Under the page of 会话信息 the conversation cannot be reached until the page is closed. */}
                  <div className="workspace-view" inert={(pageMode && infoPage) || undefined}>
                    <TopBar
                      identity={summary?.personal ? harnessName : undefined}
                      inspectorRef={inspectorToggle}
                      onFiles={canBrowseFiles ? browseFiles : undefined}
                      filesOpen={filesVisible}
                      summary={summary}
                      harness={topHarness}
                      project={project}
                      cancelling={selectedId !== null && stopping.has(selectedId)}
                      level={access.legacy ? undefined : level}
                      demo={demo}
                      phone={phone}
                      onBack={() => {
                        back()
                      }}
                      onNew={startNew}
                      sidebarCollapsed={sidebarCollapsed}
                      onExpandSidebar={
                        widthClass === null
                          ? undefined
                          : () => {
                              setSidebarShut(false, true)
                            }
                      }
                      expandRef={expandButton}
                      approvals={snapshot.approvals.length}
                      onApprovals={openApprovals}
                      inspectorOpen={columnOpen || (pageMode && infoPage)}
                      onInspector={toggleInspector}
                      sessionMenu={titleMenu}
                      menu={topMenu}
                      connection={connection}
                      onRefresh={() => {
                        void resync()
                      }}
                    />
                    {/* The conversation's paper: on phones it rises under the header on the ground. */}
                    <div className="workspace-body">
                      {hostBanners}
                      {summary?.personal?.groupId && (
                        <InlineNotice
                          tone="neutral"
                          action={
                            <Button
                              size="xs"
                              onClick={() => {
                                setPersonalGroupId(summary.personal!.groupId)
                                setPersonalOpen(true)
                              }}>
                              回到群聊
                            </Button>
                          }>
                          这段记录来自个人助手群聊。
                        </InlineNotice>
                      )}
                      {current && workspaceChanged.has(current.summary.id) && (
                        <WorkspaceRecovery
                          source={current}
                          workspaces={catalog?.workspaces ?? []}
                          workspaceId={recoveryProjects.get(current.summary.id)}
                          onWorkspaceChange={workspaceId =>
                            setRecoveryProjects(previous => new Map(previous).set(current.summary.id, workspaceId))
                          }
                          forkSupported={catalog?.features?.fork === true}
                          local={access.local}
                          harness={harnessInfo}
                          runGate={
                            access.scopes.has('run') && harnessInfo?.status === 'ready'
                              ? { allowed: true }
                              : { allowed: false, reason: '请先恢复发起会话权限和可用的执行方式。' }
                          }
                          phase={
                            submission.pending ? 'unknown' : submission.sending || cancelling.has(current.summary.id) ? 'busy' : 'idle'
                          }
                          onFork={(taskId, upToMessageId, workspaceId) => {
                            const draft = submission.draft
                            choose(null)
                            submission.setFork({ taskId, upToMessageId, title: current.summary.title })
                            submission.updateChoice({
                              harnessId: current.summary.harnessId,
                              workspaceId,
                              mode: current.summary.mode ?? 'agent',
                            })
                            submission.setDraft(draft)
                            if (phone) setNewSheet(true)
                            requestAnimationFrame(() => (phone ? sheetComposerRef : composerRef).current?.focus())
                          }}
                        />
                      )}
                      <Banner show={stopCode !== undefined} scope={selectedId ?? ''}>
                        {stopCode && (
                          <InlineNotice
                            tone={stopCode === 'permission-drift' ? 'error' : 'warn'}
                            secure
                            action={
                              <Button size="xs" onClick={startNew} icon={SquarePen}>
                                新建会话
                              </Button>
                            }>
                            {SESSION_STOP_TEXT[stopCode]}
                          </InlineNotice>
                        )}
                      </Banner>
                      <Banner show={Boolean(sessionBlock) && !workspaceChanged.has(selectedId ?? '')} scope={selectedId ?? ''}>
                        {sessionBlock && <InlineNotice tone="neutral">{sessionBlock}</InlineNotice>}
                      </Banner>
                      {selectedId === null ? (
                        <NewSession
                          onboarding={
                            !personalDraft && (
                              <GettingStarted
                                sessionCount={snapshot.tasks.length}
                                ready={!block}
                                project={catalog?.workspaces.find(item => item.id === choice.workspaceId)?.name ?? ''}
                                remote={!access.local}
                                firstTask={() => composerRef.current?.focus()}
                                onAgent={() => {
                                  if (block?.kind === 'model-required' && setupTrigger.current) setupTrigger.current.click()
                                  else addAgentTrigger.current?.click()
                                }}
                                onProject={() => {
                                  const picker = document.querySelector<HTMLButtonElement>('.composer [aria-label^="项目："]')
                                  if (picker) picker.click()
                                  else if (owner) openSettings('workspaces')
                                  else composerRef.current?.focus()
                                }}
                              />
                            )
                          }
                          harnesses={harnessChoices}
                          title={personalDraft ? '和' + personalDraft.name + '聊聊' : undefined}
                          composer={
                            <>
                              {sendingBubble}
                              {composer}
                            </>
                          }
                          demo={demo}
                          mode={choice.mode}
                          setup={setupCard}
                          onSuggestion={suggest}
                        />
                      ) : (
                        <div className="conversation">
                          <div className="transcript-shell">
                            {findOpen && current && (
                              <FindBar
                                sessionId={current.summary.id}
                                revision={current.cursor}
                                messages={current.messages}
                                onReveal={findReveal}
                                onClose={() => setFindOpen(false)}
                              />
                            )}
                            <div className="transcript" ref={reading.containerRef} {...reading.handlers} tabIndex={0} aria-label="会话记录">
                              <div className="transcript-content" ref={reading.contentRef}>
                                {current === null ? (
                                  <>
                                    <Loading label="正在读取会话记录…" />
                                    {sendingBubble}
                                  </>
                                ) : (
                                  <ApprovalStatuses.Provider value={statuses}>
                                    <ApprovalVisibilityContext.Provider value={approvalVisibility}>
                                      <Transcript
                                        detail={current}
                                        questionActions={{
                                          deviceId: snapshot.device.id,
                                          canAnswer: gate.kind === 'open' && sessionBlock === undefined,
                                          onChanged: refresh,
                                        }}
                                        onCopyError={cause => setToast({ text: errorMessage(cause), tone: 'error' })}
                                        onFork={
                                          catalog?.features?.fork && access.scopes.has('run')
                                            ? upToMessageId => {
                                                submission.setFork({
                                                  taskId: current.summary.id,
                                                  upToMessageId,
                                                  title: current.summary.title,
                                                })
                                                submission.updateChoice({
                                                  harnessId: current.summary.harnessId,
                                                  workspaceId: projectFor(catalog, current.summary),
                                                  mode: current.summary.mode ?? 'agent',
                                                })
                                                choose(null)
                                                submission.setDraft('请接着这个会话继续。')
                                                if (phone) setNewSheet(true)
                                                requestAnimationFrame(() => (phone ? sheetComposerRef : composerRef).current?.focus())
                                              }
                                            : undefined
                                        }
                                        approvals={approvals}
                                        busy={approvalBusy}
                                        onDecide={onDecide}
                                        gateFor={gateFor}
                                        harnessName={harnessName}
                                        harness={topHarness}
                                        active={active}
                                        cancelling={cancelState === 'cancelling'}
                                        coarse={coarse}
                                        providerName={providerName}
                                        {...(fallbackElapsed !== undefined ? { fallbackElapsed } : {})}
                                        {...(retry ? { retry } : {})}
                                      />
                                      {sendingBubble}
                                    </ApprovalVisibilityContext.Provider>
                                  </ApprovalStatuses.Provider>
                                )}
                                {current !== null
                                  && current.messages.length === 0
                                  && !isLive(current)
                                  && approvals.length === 0
                                  && !active && <p className="transcript-empty">会话记录会显示在这里。</p>}
                              </div>
                            </div>
                            <JumpLatest
                              show={!reading.isFollowing}
                              onJump={jumpToLatest}
                              {...(current && active
                                ? {
                                    live: {
                                      detail: current,
                                      harness: harnessName,
                                      cancelling: cancelState === 'cancelling',
                                      approvals: approvals.length,
                                      ...(fallbackElapsed !== undefined ? { fallbackElapsed } : {}),
                                    },
                                  }
                                : {})}
                            />
                          </div>
                          <div className="composer-dock">{composer}</div>
                        </div>
                      )}
                    </div>
                  </div>
                  {page.present && (summary || filesVisible) && (
                    <section
                      ref={infoPageRef}
                      className="info-page"
                      data-leaving={page.leaving ? '' : undefined}
                      aria-label="会话信息"
                      onKeyDown={event => {
                        if (event.key === 'Escape' && !event.defaultPrevented) {
                          event.preventDefault()
                          closeInfoPage()
                        }
                      }}>
                      <header className="info-page-head">
                        {phone ? (
                          <IconButton ref={infoBack} size="lg" label="返回" icon={ChevronLeft} onClick={closeInfoPage} />
                        ) : (
                          <Button ref={infoBack} variant="ghost" icon={ChevronLeft} onClick={closeInfoPage}>
                            返回对话
                          </Button>
                        )}
                        <div className="info-page-title">
                          <h2>
                            {fileTabs.active?.target.view === 'changes'
                              ? '代码审阅'
                              : fileTabs.active
                                ? '文件预览'
                                : filesOpen
                                  ? '文件'
                                  : '会话信息'}
                          </h2>
                          <span>{summary?.title || workspaceForFiles?.name || '项目文件'}</span>
                        </div>
                      </header>
                      <div className="info-page-body">{inspector}</div>
                    </section>
                  )}
                </main>
              )}
              {placement?.kind === 'column' && (
                <aside className="inspector-column" aria-label="会话信息" inert={!columnOpen || undefined}>
                  {column.present && <div className="inspector-column-inner">{inspector}</div>}
                </aside>
              )}
              {placement?.kind === 'column' && columnOpen && widthClass !== null && (
                <ResizeHandle
                  className="inspector-resize"
                  label="调整会话信息宽度"
                  edge="start"
                  value={inspectorWidth}
                  min={fileTabs.active && fileIsDocument ? 480 : INSPECTOR_MIN}
                  max={fileTabs.active ? windowWidth - 528 : inspectorMax(windowWidth, sidebarCollapsed ? 8 : sidebarWidth)}
                  onResize={(width, phase) => {
                    if (!fileTabs.active) {
                      resizeInspector(width, phase)
                      return
                    }
                    setInspectorDrag(width)
                    if (phase === 'commit') {
                      storageSet(fileWidthKey, String(width))
                      setInspectorDrag(null)
                    }
                  }}
                  onReset={() => {
                    setInspectorDrag(null)
                    if (fileTabs.active) {
                      storageSet(fileWidthKey, '')
                      return
                    }
                    const width = { ...preferences.inspector.width }
                    delete width[widthClass]
                    setPreference('inspector', { ...preferences.inspector, width })
                  }}
                />
              )}
            </LiveChanges>
            {phone && (
              <NewSessionSheet
                personal={personalDraft ?? undefined}
                focusComposer={submission.fork ? sheetComposerRef : undefined}
                open={newSheet && selectedId === null}
                onBrowseFiles={canBrowseFiles ? browseFiles : undefined}
                onClose={() => {
                  setNewSheet(false)
                }}
                snapshot={snapshot}
                access={access}
                choice={choice}
                onChoice={submission.updateChoice}
                disabled={newChoicesLocked}
                canStart={sheetCanStart}
                sending={submission.sending}
                onStart={() => {
                  void sendDraft()
                }}
                harnesses={harnessChoices}
                onManageProviders={manageProviders}
                onProvidersChanged={() => {
                  void refresh()
                }}
                onManageWorkspaces={owner ? () => openSettings('workspaces') : undefined}
                onCreateProject={createProject}
                composer={
                  <>
                    {sendingBubble}
                    {sheetComposer}
                  </>
                }
                setup={setupCard}
                demo={demo}
                suggestions={<DemoSuggestions demo={demo} mode={choice.mode} onSuggestion={suggest} />}
              />
            )}
            {settings && (
              <SettingsPage
                snapshot={snapshot}
                access={access}
                initial={settings.section}
                initialProjectId={settings.projectId}
                onOpenSession={id => {
                  setSettings(null)
                  choose(id)
                }}
                onClose={() => {
                  setSettings(null)
                  void refresh()
                }}
                onChanged={() => {
                  void refresh()
                }}
              />
            )}
            {catalog?.features?.personal && (privateVisible || personalOpen) && (
              <PersonalPage
                key={privateVisible ? 'private' : 'restricted'}
                open={personalOpen}
                initialGroupId={personalGroupId}
                canStart={!submission.pending && !submission.sending}
                snapshot={snapshot}
                access={access}
                refreshHint={harness.refreshHints + harness.resyncs}
                onClose={() => {
                  setPersonalGroupId(undefined)
                  setPersonalOpen(false)
                }}
                onChanged={() => {
                  void refresh()
                }}
                onSession={id => {
                  setPersonalGroupId(undefined)
                  setPersonalOpen(false)
                  choose(id)
                }}
                onGroupSession={(id, groupId) => {
                  setPersonalGroupId(groupId)
                  choose(id)
                  setPersonalOpen(false)
                }}
                onStart={assistant => {
                  if (submission.pending || submission.sending) return
                  choose(null)
                  setPersonalDraft(assistant)
                  submission.setFork(null)
                  setPersonalOpen(false)
                  if (phone) setNewSheet(true)
                  else requestAnimationFrame(() => composerRef.current?.focus())
                }}
              />
            )}
            {keyboardHelp && <KeyboardHelp onClose={() => setKeyboardHelp(false)} />}
            {commandOpen && (
              <CommandPalette
                snapshot={snapshot}
                mode={commandMode}
                fileContext={fileContext ?? undefined}
                onOpenFile={catalog?.features?.filePreview ? openFile : undefined}
                onSelect={choose}
                onSearchHit={selectSearchHit}
                onProject={startIn}
                onClose={() => setCommandOpen(false)}
                commands={[
                  { id: 'new', label: '新建会话', shortcut: currentShell() ? '⌘N' : 'Alt N', run: startNew },
                  { id: 'search', label: '搜索会话', run: openSearch },
                  { id: 'settings', label: '打开设置', run: () => openSettings() },
                  {
                    id: 'sidebar',
                    label: '展开或收起侧栏',
                    shortcut: currentShell() ? '⌘B' : 'Alt B',
                    run: () => {
                      if (drawerMode) drawer.setOpen(!drawer.open)
                      else setSidebarShut(!sidebarCollapsed, true)
                    },
                  },
                  ...(summary
                    ? [
                        { id: 'info', label: '展开或收起会话信息', run: toggleInspector },
                        { id: 'copy', label: '复制当前会话为 Markdown', run: () => void copyTask(summary) },
                        {
                          id: 'export',
                          label: '导出当前会话为 Markdown',
                          run: () => {
                            void exportTask(summary)
                          },
                        },
                      ]
                    : []),
                  ...(canBrowseFiles
                    ? [
                        { id: 'files', label: '浏览项目文件', shortcut: currentShell() ? '⇧⌘E' : 'Alt Shift E', run: browseFiles },
                        ...(catalog?.features?.fileSearch
                          ? [{ id: 'file-search', label: '搜索项目文件', shortcut: currentShell() ? '⌘P' : 'Alt P', run: searchFiles }]
                          : []),
                      ]
                    : []),
                  ...fileTabs.tabs.map(tab => ({
                    id: 'file:' + tab.id,
                    label: '切换文件：' + (tab.file?.name ?? tab.target.reference),
                    run: () => {
                      fileTabs.select(tab.id)
                      setInfoPage(true)
                      setColumnOpen(true)
                    },
                  })),
                  ...(['system', 'light', 'dark'] as const).map(theme => ({
                    id: 'theme:' + theme,
                    label: '外观：' + { system: '跟随系统', light: '浅色', dark: '深色' }[theme],
                    run: () => setPreference('theme', theme),
                  })),
                  ...settingsSections(snapshot, access).map(section => ({
                    id: 'settings:' + section,
                    label:
                      '设置：'
                      + {
                        general: '通用',
                        computer: '电脑',
                        providers: '模型服务',
                        agents: 'Agent 成员',
                        workspaces: '项目',
                        plugins: '插件',
                        devices: '设备',
                        about: '关于',
                      }[section],
                    run: () => openSettings(section),
                  })),
                  ...(openPersonal ? [{ id: 'personal', label: '打开个人助手', run: openPersonal }] : []),
                  { id: 'keyboard', label: '键盘快捷键', shortcut: currentShell() ? '⌘/' : 'Alt /', run: () => setKeyboardHelp(true) },
                  ...(selectedId ? [{ id: 'find', label: '在当前会话中查找', shortcut: '⌘F', run: () => setFindOpen(true) }] : []),
                  ...(snapshot.approvals.length ? [{ id: 'approval', label: '跳转到下一个待处理请求', run: nextApproval }] : []),
                ]}
              />
            )}
            {renaming && (
              <PromptDialog
                title="重命名会话"
                label="会话名称"
                initial={renaming.title}
                maxLength={120}
                onClose={() => {
                  setRenaming(null)
                }}
                onSubmit={async title => {
                  try {
                    await api<unknown>(`tasks/${encodeURIComponent(renaming.id)}`, { method: 'PATCH', body: { title } })
                  } catch (cause) {
                    throw new Error(errorMessage(cause))
                  }
                  await refresh()
                }}
              />
            )}
            {deleting && (
              <ConfirmDialog
                title="删除会话"
                danger
                confirmLabel="删除"
                message={`删除「${deleting.title || '未命名会话'}」及其全部记录？此操作无法撤销。`}
                onClose={() => {
                  setDeleting(null)
                }}
                onConfirm={async () => {
                  try {
                    await api<unknown>(`tasks/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' })
                  } catch (cause) {
                    throw new Error(errorMessage(cause))
                  }
                  setStopped(previous => {
                    if (!previous.has(deleting.id)) return previous
                    const next = new Map(previous)
                    next.delete(deleting.id)
                    return next
                  })
                  if (deleting.id === selectedId) choose(null)
                  await refresh()
                }}
              />
            )}
            {approvalToast && (
              <Toast className="toast" duration={null}>
                <span>另一个会话有请求等你处理。</span>
                <Button
                  variant="ghost"
                  onClick={() => {
                    choose(approvalToast.sessionId)
                    const target = snapshot.approvals.find(item => item.id === approvalToast.id)
                    if (target) reading.show(target.sessionId, toolRowId(target))
                    setApprovalToast(null)
                  }}>
                  查看
                </Button>
              </Toast>
            )}
            {!approvalToast && toast && (
              <Toast className="toast" tone={toast.tone === 'error' ? 'error' : 'neutral'} duration={null}>
                {toast.text}
              </Toast>
            )}
          </div>
        </LiveChanges>
      </LayerHistory>
    </FileOpenContext.Provider>
  )
}
