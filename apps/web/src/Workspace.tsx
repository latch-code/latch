import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ArrowDown, PanelRight, RefreshCw, SquarePen, X } from 'lucide-react'
import type { Approval, AppSnapshot, TaskDetail, TaskSummary } from '@latch/protocol'
import { api, ApiError, errorMessage, inlineError, isUncertain } from './core/api.ts'
import { choiceKind, DecisionRequests, settledOutcome } from './core/approvalDecision.ts'
import { AUDIT_ROLLBACK_TEXT, useAuditCheckpoint } from './core/auditCheckpoint.ts'
import { usesDrawer, useCoarsePointer, useViewport, useWindowWidth } from './breakpoints.ts'
import { findHarness, sessionHarness, sessionModel, startBlock, usesDemoModel } from './composerChoice.ts'
import { withConfirmation } from './core/confirmations.ts'
import { exportFileName, saveText, transcriptMarkdown } from './exportMarkdown.ts'
import { basename, isActive } from './format.ts'
import { approvalActions, composerGate, deviceAccess, harnessLevel, hostView, L3_START_HINT, LEGACY_HOST_TEXT } from './core/permissions.ts'
import { setPreference, usePreferences } from './preferences.ts'
import { isSessionStopCode, SESSION_STOP_TEXT, type SessionStopCode } from './core/securityCopy.ts'
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
import { emptySeen, isUnread, markSeen, pruneSeen, readSeen, writeSeen, type SeenState, type SessionFilter } from './sessions.ts'
import type { useHarness } from './core/useHarness.ts'
import { useReadingPosition } from './core/useReadingPosition.ts'
import { currentShell } from './core/shell.ts'
import { useDrawer } from './hooks/useDrawer.ts'
import { useStableCallback } from './hooks/useStableCallback.ts'
import { useRunClock } from './hooks/useRunClock.ts'
import { useSubmission } from './hooks/useSubmission.ts'
import { Composer, type RunState } from './components/Composer.tsx'
import { NewSessionControls, SessionControls } from './components/ComposerControls.tsx'
import { Inspector } from './components/Inspector.tsx'
import { NewSession, SetupCard } from './components/NewSession.tsx'
import { ConfirmDialog, Modal, ModalHeader, PromptDialog, type MenuSection } from './components/overlays.tsx'
import { Rail, Sidebar } from './components/Sidebar.tsx'
import { TopBar } from './components/TopBar.tsx'
import { Transcript, isLive, toolRowId } from './components/Transcript.tsx'
import { Button, ICON_STROKE, IconButton, InlineNotice, LiveChanges, Loading, ResizeHandle, Toast, type ResizePhase } from '@latch/ui'
import { SettingsPage, type SettingsSection } from './settings/SettingsPage.tsx'

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
  const sidebarCollapsed =
    widthClass !== null && (sidebarDrag !== null ? 'collapsed' in sidebarDrag : preferences.sidebar.collapsed[widthClass] === true)
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
    },
    [],
  )
  const navigation = useRef<HTMLElement>(null)
  const main = useRef<HTMLElement>(null)
  const rail = useRef<HTMLElement>(null)
  const collapseButton = useRef<HTMLButtonElement>(null)
  const expandButton = useRef<HTMLButtonElement>(null)
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
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<SessionFilter>('all')
  const [settings, setSettings] = useState<{ section?: SettingsSection } | null>(null)
  const [inspectorSheet, setInspectorSheet] = useState(false)
  const [renaming, setRenaming] = useState<TaskSummary | null>(null)
  const [deleting, setDeleting] = useState<TaskSummary | null>(null)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const [approvalBusy, setApprovalBusy] = useState<ReadonlyMap<string, string>>(new Map())
  const approvalFlights = useRef(new Set<string>())
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set())
  const [cancelUncertain, setCancelUncertain] = useState<ReadonlySet<string>>(new Set())
  const [configBusy, setConfigBusy] = useState<ReadonlyMap<string, string>>(new Map())
  const [now, setNow] = useState(() => Date.now())
  /** Sessions that stopped accepting input, learned from the Host's refusal. */
  const [stopped, setStopped] = useState<ReadonlyMap<string, SessionStopCode>>(new Map())
  const decisions = useRef(new DecisionRequests())

  const catalog = snapshot.catalog
  const shell = currentShell()
  const host = hostView(snapshot)
  const scopesKey = host ? `${snapshot.device.listener}:${snapshot.device.scopes.join(',')}` : 'legacy'
  // Recomputed only when the device's listener or scopes change, so approval cards stay memoized across snapshots.
  const access = useMemo(() => deviceAccess(snapshot, shell), [scopesKey, shell])
  const owner = access.admin
  const gateFor = useCallback((approval: Approval) => approvalActions(approval, access.device, shell), [access, shell])
  const audit = useAuditCheckpoint(host?.hostId, connection === 'connected')
  const current = detail?.summary.id === selectedId ? detail : null
  const summary = current?.summary ?? snapshot.tasks.find(task => task.id === selectedId)
  const approvals = useMemo(
    () => current?.approvals ?? snapshot.approvals.filter(approval => approval.sessionId === selectedId),
    [current, snapshot.approvals, selectedId],
  )
  const active = isActive(summary?.status)
  const harnessInfo = sessionHarness(catalog, summary)
  const harnessName = harnessInfo?.name ?? snapshot.harness?.name ?? 'Latch'

  const reading = useReadingPosition({
    sessionId: selectedId,
    ready: current !== null,
    contentVersion: `${current?.cursor ?? 0}:${current?.liveText.length ?? 0}:${current?.liveReasoning?.length ?? 0}:${approvals.length}`,
  })
  const stopSession = (sessionId: string, cause: unknown) => {
    if (cause instanceof ApiError && isSessionStopCode(cause.code)) {
      const code = cause.code
      setStopped(previous => new Map(previous).set(sessionId, code))
    }
  }
  const submission = useSubmission({
    snapshot,
    access,
    selectedId,
    select,
    refresh,
    onSent: sessionId => {
      setFilter('all')
      setSearch('')
      reading.show(sessionId)
    },
    onRefused: stopSession,
  })
  const runElapsed = useRunClock(snapshot.tasks, selectedId)

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
  const seenKey = `harness-link.seen.${location.origin}.${snapshot.device.id}`
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
  }, [snapshot])

  const choose = useStableCallback((id: string | null) => {
    select(id)
    drawer.setOpen(false)
    submission.setError('')
    setActionError(previous => (previous?.sessionId === id ? previous : null))
    if (submission.pending === null) submission.setDraft('')
  })
  const failAction = (sessionId: string, text: string) => {
    setActionError({ sessionId, text })
  }
  const clearAction = (sessionId: string) => {
    setActionError(previous => (previous?.sessionId === sessionId ? null : previous))
  }
  const startNew = () => {
    choose(null)
    requestAnimationFrame(() => {
      composerRef.current?.focus({ preventScroll: true })
    })
  }
  const openSettings = (section?: SettingsSection) => {
    drawer.setOpen(false)
    setSettings(section ? { section } : {})
  }
  const openSearch = () => {
    if (drawerMode) drawer.show(searchRef.current)
    else if (sidebarCollapsed) {
      // The search is in the shut column: open it, then focus the search once the column can take focus.
      focusAfterToggle.current = { target: searchRef, shut: false }
      saveSidebar({ collapsed: false })
    } else searchRef.current?.focus()
  }

  const searchShortcut = useStableCallback((event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
    if (document.querySelector('dialog[open]')) return
    event.preventDefault()
    openSearch()
  })
  useEffect(() => {
    window.addEventListener('keydown', searchShortcut)
    return () => {
      window.removeEventListener('keydown', searchShortcut)
    }
  }, [searchShortcut])

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

  const decide = useCallback(
    async (approval: Approval, decision: 'allow' | 'reject', optionId: string | undefined) => {
      if (approvalFlights.current.has(approval.id)) return
      approvalFlights.current.add(approval.id)
      setApprovalBusy(previous => new Map(previous).set(approval.id, optionId ?? (decision === 'allow' ? 'allow_once' : 'reject_once')))
      clearAction(approval.sessionId)
      // One requestId per decision, reused when the same choice is retried after an unknown outcome.
      const requestId = decisions.current.idFor(approval.id, decision, optionId)
      const body = { decision, requestId, ...(optionId ? { optionId } : {}) }
      try {
        await withConfirmation(confirmation =>
          api<unknown>(`approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', body, ...(confirmation ? { confirmation } : {}) }),
        )
        decisions.current.settle(approval.id)
        await refresh()
      } catch (cause) {
        decisions.current.settle(approval.id, cause)
        const optionKind = choiceKind(approval, decision, optionId)
        const settled = settledOutcome(cause, { decision, ...(optionKind ? { optionKind } : {}) })
        if (settled === undefined) {
          const text = inlineError(cause)
          if (text) failAction(approval.sessionId, isUncertain(cause) ? `${text} 可重试同一选择，不会重复提交。` : text)
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
  const onDecide = useCallback(
    (approval: Approval, decision: 'allow' | 'reject', optionId: string | undefined) => {
      void decide(approval, decision, optionId)
    },
    [decide],
  )

  const cancel = async () => {
    if (selectedId === null || (cancelling.has(selectedId) && !cancelUncertain.has(selectedId))) return
    const id = selectedId
    setCancelling(previous => new Set(previous).add(id))
    setCancelUncertain(previous => without(previous, id))
    clearAction(id)
    try {
      await api<unknown>(`tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
      await refresh()
    } catch (cause) {
      if (isUncertain(cause)) {
        setCancelUncertain(previous => new Set(previous).add(id))
        failAction(id, '取消结果尚未确认。恢复连接后可重试取消。')
      } else {
        failAction(id, errorMessage(cause))
        setCancelling(previous => without(previous, id))
      }
    }
  }

  const setConfig = async (configId: string, value: string) => {
    if (selectedId === null || configBusy.has(selectedId)) return
    const id = selectedId
    setConfigBusy(previous => new Map(previous).set(id, configId))
    clearAction(id)
    try {
      // Widening a full-access session's permission mode needs a local confirmation.
      await withConfirmation(confirmation =>
        api<unknown>(`tasks/${encodeURIComponent(id)}/config`, {
          method: 'POST',
          body: { configId, value },
          ...(confirmation ? { confirmation } : {}),
        }),
      )
      await refresh()
    } catch (cause) {
      stopSession(id, cause)
      const text = inlineError(cause)
      if (text && !(cause instanceof ApiError && isSessionStopCode(cause.code))) failAction(id, text)
    } finally {
      setConfigBusy(previous => {
        const next = new Map(previous)
        next.delete(id)
        return next
      })
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
  const sessionMenu = useCallback(
    (task: TaskSummary): MenuSection[] =>
      sessionMenuSections(
        task,
        {
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
    [patchTask, exportTask, manageable],
  )

  // Composer: new-session choices or the open session's next-turn settings.
  const choice = submission.choice
  const block = selectedId === null ? startBlock(snapshot, choice, access) : null
  const chosenHarness = selectedId === null ? findHarness(catalog, choice.harnessId) : undefined
  const startsL3 = !access.legacy && chosenHarness !== undefined && harnessLevel(chosenHarness) === 'L3'
  const stopCode: SessionStopCode | undefined =
    selectedId === null ? undefined : summary?.permissionDrift || current?.permission?.drift ? 'permission-drift' : stopped.get(selectedId)
  const gate =
    selectedId === null
      ? access.legacy || access.scopes.has('run')
        ? { kind: 'open' as const }
        : { kind: 'read-only' as const, text: '此设备没有「发起和继续会话」权限' }
      : composerGate({ summary, permission: current?.permission, access, stopped: stopCode !== undefined })
  const sessionBlock =
    selectedId === null
      ? undefined
      : harnessInfo?.status === 'unavailable'
        ? harnessInfo.statusMessage || `${harnessInfo.name} 暂不可用`
        : !catalog && snapshot.execution?.ready === false
          ? '当前模型接口不可用，请检查模型插件状态。'
          : undefined
  const currentModel = sessionModel(summary)
  const effectiveModel = submission.override ?? currentModel
  const mode = selectedId === null ? choice.mode : (summary?.mode ?? 'agent')
  const manageProviders = owner
    ? () => {
        openSettings('providers')
      }
    : undefined
  const liveTool = current?.messages.findLast(message => message.role === 'tool' && message.state === 'running')
  const phase = current?.activity?.phase
  const runLabel =
    phase === 'tool'
      ? `正在执行 ${liveTool?.tool?.title || current?.activity?.toolName || liveTool?.toolName || '工具'}`
      : current?.liveText
        ? '正在生成回复'
        : current?.liveReasoning
          ? '正在思考'
          : phase === 'model'
            ? '等待模型响应'
            : '正在运行'
  const cancelState =
    selectedId !== null && cancelUncertain.has(selectedId)
      ? 'uncertain'
      : selectedId !== null && (cancelling.has(selectedId) || phase === 'cancelling')
        ? 'cancelling'
        : 'idle'
  const run: RunState | undefined =
    selectedId !== null && active
      ? {
          label: runLabel,
          elapsed: runElapsed,
          approvals: approvals.length,
          onRevealApprovals: revealApprovals,
          cancel: cancelState,
          onCancel: () => {
            void cancel()
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
        : mode === 'chat'
          ? '继续对话 · 对话模式不调用工具'
          : '继续补充要求…'
  const composer = (
    <Composer
      textareaRef={composerRef}
      variant={selectedId === null ? 'new' : 'session'}
      label={selectedId === null ? '新会话消息' : '继续对话'}
      placeholder={placeholder}
      draft={submission.draft}
      onDraft={submission.setDraft}
      pending={submission.pending}
      sending={submission.sending}
      error={submission.error || (actionError?.sessionId === selectedId ? actionError.text : '')}
      onRetry={() => {
        if (submission.pending) void submission.submit(submission.pending)
      }}
      canSend={gate.kind === 'open' && (selectedId === null ? block === null : sessionBlock === undefined)}
      blockReason={block?.message ?? sessionBlock}
      readOnly={gate.kind === 'read-only' ? gate.text : gate.kind === 'stopped' ? '该会话不再接受输入。' : undefined}
      notice={startsL3 && block === null ? L3_START_HINT : undefined}
      onSubmit={() => {
        void submission.submit()
      }}
      sendKey={preferences.sendKey}
      coarse={coarse}
      run={run}
      plan={active ? current?.plan : undefined}
      controls={
        selectedId === null ? (
          <NewSessionControls
            catalog={catalog}
            choice={choice}
            onChoice={submission.updateChoice}
            phone={phone}
            disabled={submission.pending !== null || submission.sending || gate.kind !== 'open'}
            onManageProviders={manageProviders}
            onManageWorkspaces={
              owner
                ? () => {
                    openSettings('workspaces')
                  }
                : undefined
            }
            access={access}
          />
        ) : (
          summary && (
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
              onConfig={(configId, value) => {
                void setConfig(configId, value)
              }}
              phone={phone}
              onManageProviders={manageProviders}
              locked={gate.kind !== 'open'}
            />
          )
        )
      }
    />
  )

  const inspectorInline = viewport === 'desktop' && preferences.inspector && summary !== undefined
  // The inline inspector stands beside the paper, which keeps its minimum width between the two columns.
  const inspectorBeside = inspectorInline ? 320 : 0
  const sidebarLimit = sidebarMax(windowWidth, inspectorBeside)
  const sidebarWidth =
    sidebarDrag !== null && 'width' in sidebarDrag
      ? sidebarDrag.width
      : clampSidebar(
          (widthClass ? preferences.sidebar.width[widthClass] : undefined) ?? defaultSidebarWidth(windowWidth),
          windowWidth,
          inspectorBeside,
        )
  /** Shuts or opens the sidebar; from its own buttons, focus follows to the button that does the opposite. */
  const setSidebarShut = (shut: boolean, moveFocus: boolean) => {
    if (moveFocus) focusAfterToggle.current = { target: shut ? expandButton : collapseButton, shut }
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
  const toggleInspector = () => {
    if (viewport === 'desktop') setPreference('inspector', !preferences.inspector)
    else setInspectorSheet(true)
  }
  const revealFromInspector = (messageId: string) => {
    setInspectorSheet(false)
    reveal(messageId)
  }
  // Where the session runs: its harness (a Host without a catalog runs the built-in one) and its project's folder.
  const topHarness = harnessInfo ?? (snapshot.harness ? { ...snapshot.harness, source: 'builtin' as const } : undefined)
  const project = summary?.cwd ? basename(summary.cwd) : undefined
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
  const topMenu: MenuSection[] = summary
    ? [
        ...(viewport !== 'desktop'
          ? [
              {
                id: 'view',
                items: [
                  {
                    id: 'details',
                    label: '会话详情',
                    icon: PanelRight,
                    onSelect: () => {
                      setInspectorSheet(true)
                    },
                  },
                ],
              },
            ]
          : []),
        ...titleMenu,
        syncSection,
      ]
    : [syncSection]
  const canStart = catalog !== undefined && (access.legacy || access.scopes.has('run'))
  const startIn = canStart
    ? (workspaceId: string) => {
        submission.updateChoice({ workspaceId })
        startNew()
      }
    : undefined
  const connectionProblem = harness.error || connection === 'reconnecting' || connection === 'offline'
  const devMode = host?.devMode === true
  const level = current?.permission?.level ?? summary?.level

  return (
    <LiveChanges value={harness.resyncs}>
      <div
        className={`app-shell viewport-${viewport} ${inspectorInline ? 'has-inspector' : ''}`}
        data-viewport={viewport}
        data-connection={connection}
        data-sidebar={widthClass === null ? undefined : sidebarCollapsed ? 'collapsed' : 'open'}
        data-resizing={sidebarDrag !== null && !sidebarSnapping ? '' : undefined}
        style={
          widthClass === null
            ? undefined
            : {
                // Shut, the column keeps the window inset, so the paper sits 8px in on every side.
                '--sidebar-width': sidebarCollapsed ? 'var(--shell-inset)' : `${sidebarWidth}px`,
                '--sidebar-open-width': `${sidebarWidth}px`,
              }
        }>
        {viewport === 'tablet' && (
          <nav ref={rail} className="rail" aria-label="快捷导航">
            <Rail
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
        <aside
          ref={navigation}
          id="session-navigation"
          className={`sidebar ${drawer.open ? 'is-open' : ''}`}
          aria-label="会话导航"
          role={drawerMode && drawer.open ? 'dialog' : undefined}
          aria-modal={drawerMode && drawer.open ? true : undefined}
          tabIndex={-1}>
          <Sidebar
            snapshot={snapshot}
            selectedId={selectedId}
            isUnread={unread}
            cancelling={cancelling}
            search={search}
            onSearch={setSearch}
            searchRef={searchRef}
            filter={filter}
            onFilter={setFilter}
            onSelect={choose}
            onNew={startNew}
            onNewIn={startIn}
            newActive={selectedId === null}
            onApprovals={openApprovals}
            drawer={drawerMode}
            phone={phone}
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
          />
        </aside>
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
          <main ref={main} className={`workspace ${selectedId === null ? 'is-new' : 'has-task'}`}>
            <TopBar
              summary={summary}
              harness={topHarness}
              project={project}
              cancelling={selectedId !== null && cancelling.has(selectedId)}
              level={access.legacy ? undefined : level}
              demo={demo}
              phone={phone}
              drawerOpen={drawer.open}
              onDrawer={
                phone
                  ? () => {
                      drawer.show()
                    }
                  : undefined
              }
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
              inspectorOpen={inspectorInline}
              onInspector={toggleInspector}
              sessionMenu={titleMenu}
              menu={topMenu}
              connection={connection}
              onRefresh={() => {
                void resync()
              }}
            />
            {connectionProblem && (
              <div className="banner-region">
                <InlineNotice
                  tone="warn"
                  title={connection === 'offline' ? '当前设备已离线' : '连接已中断，正在重连…'}
                  action={
                    <Button
                      size="xs"
                      onClick={() => {
                        void resync()
                      }}>
                      重试
                    </Button>
                  }>
                  {connection === 'offline'
                    ? '已读内容仍可查看；恢复连接后会同步执行端状态。'
                    : harness.error || '恢复后会同步执行端的最新状态。'}
                </InlineNotice>
              </div>
            )}
            {audit.rollback && (
              <div className="banner-region">
                <InlineNotice
                  tone="error"
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
              </div>
            )}
            {access.legacy && (
              <div className="banner-region">
                <InlineNotice tone="neutral">{LEGACY_HOST_TEXT}</InlineNotice>
              </div>
            )}
            {stopCode && (
              <div className="banner-region">
                <InlineNotice
                  tone={stopCode === 'permission-drift' ? 'error' : 'warn'}
                  action={
                    <Button size="xs" onClick={startNew} icon={SquarePen}>
                      新建会话
                    </Button>
                  }>
                  {SESSION_STOP_TEXT[stopCode]}
                </InlineNotice>
              </div>
            )}
            {sessionBlock && (
              <div className="banner-region">
                <InlineNotice tone="neutral">{sessionBlock}</InlineNotice>
              </div>
            )}
            {selectedId === null ? (
              <NewSession
                composer={composer}
                demo={demo}
                mode={choice.mode}
                setup={
                  block && (
                    <SetupCard
                      block={block}
                      owner={owner}
                      onSetup={() => {
                        openSettings(block.kind === 'model-required' ? 'providers' : catalog ? 'agents' : 'plugins')
                      }}
                    />
                  )
                }
                onSuggestion={prompt => {
                  submission.setDraft(prompt)
                  composerRef.current?.focus()
                }}
              />
            ) : (
              <div className="conversation">
                <div className="transcript-shell">
                  <div className="transcript" ref={reading.containerRef} {...reading.handlers} tabIndex={0} aria-label="会话记录">
                    <div className="transcript-content" ref={reading.contentRef}>
                      {current === null ? (
                        <Loading label="正在读取会话记录…" />
                      ) : (
                        <Transcript
                          detail={current}
                          approvals={approvals}
                          busy={approvalBusy}
                          onDecide={onDecide}
                          gateFor={gateFor}
                          harnessName={harnessName}
                          harness={topHarness}
                          active={active}
                        />
                      )}
                      {current !== null && current.messages.length === 0 && !isLive(current) && approvals.length === 0 && (
                        <p className="transcript-empty">{active ? '执行端已接收，等待输出。' : '会话记录会显示在这里。'}</p>
                      )}
                    </div>
                  </div>
                  {!reading.isFollowing && (
                    <button type="button" className="jump-latest" onClick={jumpToLatest}>
                      <ArrowDown size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                      回到最新
                    </button>
                  )}
                </div>
                <div className="composer-dock">{composer}</div>
              </div>
            )}
          </main>
          {inspectorInline && summary && (
            <aside className="inspector-pane" aria-label="会话详情">
              <header className="pane-header">
                <h2>会话详情</h2>
                <IconButton
                  label="收起会话详情"
                  icon={X}
                  onClick={() => {
                    setPreference('inspector', false)
                  }}
                />
              </header>
              <Inspector snapshot={snapshot} summary={summary} detail={current} onReveal={reveal} />
            </aside>
          )}
          {inspectorSheet && summary && viewport !== 'desktop' && (
            <Modal
              label="会话详情"
              variant={phone ? 'sheet' : 'side'}
              onClose={() => {
                setInspectorSheet(false)
              }}>
              <ModalHeader
                title="会话详情"
                onClose={() => {
                  setInspectorSheet(false)
                }}
              />
              <div className="sheet-body">
                <Inspector snapshot={snapshot} summary={summary} detail={current} onReveal={revealFromInspector} />
              </div>
            </Modal>
          )}
        </LiveChanges>
        {settings && (
          <SettingsPage
            snapshot={snapshot}
            access={access}
            initial={settings.section}
            onClose={() => {
              setSettings(null)
              void refresh()
            }}
            onChanged={() => {
              void refresh()
            }}
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
        {toast && (
          <Toast className="toast" tone={toast.tone === 'error' ? 'error' : 'neutral'} duration={null}>
            {toast.text}
          </Toast>
        )}
      </div>
    </LiveChanges>
  )
}
