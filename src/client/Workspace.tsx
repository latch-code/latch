import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, PanelRight, RefreshCw, SquarePen, X } from 'lucide-react'
import type { Approval, AppSnapshot, TaskDetail, TaskSummary } from '../shared/types.ts'
import { api, ApiError, errorMessage, inlineError, isUncertain } from './api.ts'
import { choiceKind, DecisionRequests, settledOutcome } from './approvalDecision.ts'
import { AUDIT_ROLLBACK_TEXT, useAuditCheckpoint } from './auditCheckpoint.ts'
import { usesDrawer, useCoarsePointer, useViewport } from './breakpoints.ts'
import { findHarness, sessionHarness, sessionModel, startBlock, usesDemoModel } from './composerChoice.ts'
import { withConfirmation } from './confirmations.ts'
import { exportFileName, saveText, transcriptMarkdown } from './exportMarkdown.ts'
import { isActive } from './format.ts'
import { ICON_STROKE, Spinner } from './icons.tsx'
import { approvalActions, composerGate, deviceAccess, harnessLevel, hostView, L3_START_HINT, LEGACY_HOST_TEXT } from './permissions.ts'
import { setPreference, usePreferences } from './preferences.ts'
import { isSessionStopCode, SESSION_STOP_TEXT, type SessionStopCode } from './securityCopy.ts'
import { sessionMenuSections } from './sessionMenu.ts'
import { emptySeen, isUnread, markSeen, pruneSeen, readSeen, writeSeen, type SeenState, type SessionFilter } from './sessions.ts'
import type { useHarness } from './useHarness.ts'
import { useReadingPosition } from './useReadingPosition.ts'
import { currentShell } from './shell.ts'
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
import { IconButton, InlineAlert } from './components/ui.tsx'
import { SettingsPage, type SettingsSection } from './settings/SettingsPage.tsx'

type Harness = ReturnType<typeof useHarness>
type Toast = { text: string; tone: 'ok' | 'error' }
/** Results of session actions belong to the session they were made in, not whichever is open when they settle. */
type ActionError = { sessionId: string; text: string }

const without = <T,>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => { const next = new Set(set); next.delete(value); return next }

/** The signed-in shell. Mounted once per device identity, so per-device state starts fresh. */
export function Workspace({ harness, snapshot }: { harness: Harness; snapshot: AppSnapshot }) {
  const { selectedId, detail, select, refresh, connection } = harness
  const viewport = useViewport()
  const coarse = useCoarsePointer()
  const preferences = usePreferences()
  const phone = viewport === 'phone'
  const drawerMode = usesDrawer(viewport)
  const navigation = useRef<HTMLElement>(null)
  const main = useRef<HTMLElement>(null)
  const rail = useRef<HTMLElement>(null)
  const drawer = useDrawer({ enabled: drawerMode, navigation, inertWhenOpen: [main, rail] })
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<SessionFilter>('all')
  const [settings, setSettings] = useState<{ section?: SettingsSection } | null>(null)
  const [inspectorSheet, setInspectorSheet] = useState(false)
  const [renaming, setRenaming] = useState<TaskSummary | null>(null)
  const [deleting, setDeleting] = useState<TaskSummary | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
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
  const approvals = useMemo(() => current?.approvals ?? snapshot.approvals.filter(approval => approval.sessionId === selectedId), [current, snapshot.approvals, selectedId])
  const active = isActive(summary?.status)
  const harnessInfo = sessionHarness(catalog, summary)
  const harnessName = harnessInfo?.name ?? snapshot.harness?.name ?? 'Latch'

  const reading = useReadingPosition({
    sessionId: selectedId, ready: current !== null,
    contentVersion: `${current?.cursor ?? 0}:${current?.liveText.length ?? 0}:${current?.liveReasoning?.length ?? 0}:${approvals.length}`,
  })
  const stopSession = (sessionId: string, cause: unknown) => {
    if (cause instanceof ApiError && isSessionStopCode(cause.code)) {
      const code = cause.code
      setStopped(previous => new Map(previous).set(sessionId, code))
    }
  }
  const submission = useSubmission({
    snapshot, access, selectedId, select, refresh,
    onSent: sessionId => { setFilter('all'); setSearch(''); reading.show(sessionId) },
    onRefused: stopSession,
  })
  const runElapsed = useRunClock(snapshot.tasks, selectedId)

  useEffect(() => { const timer = setInterval(() => { setNow(Date.now()) }, 60_000); return () => { clearInterval(timer) } }, [])
  useEffect(() => { document.title = snapshot.approvals.length ? `(${snapshot.approvals.length}) Latch` : 'Latch' }, [snapshot.approvals.length])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => { setToast(null) }, 3500); return () => { clearTimeout(timer) } }, [toast])
  useEffect(() => { if (harness.removed) setToast({ text: '会话已被删除', tone: 'ok' }) }, [harness.removed])

  // Per-device read markers; the selected session is read while it is open.
  const seenKey = `harness-link.seen.${location.origin}.${snapshot.device.id}`
  const [seen, setSeen] = useState<SeenState>(() => readSeen(seenKey) ?? emptySeen())
  useEffect(() => { if (current) setSeen(previous => markSeen(previous, current.summary.id, current.summary.updatedAt)) }, [current?.summary.id, current?.summary.updatedAt])
  useEffect(() => { setSeen(previous => Object.keys(previous.seen).length > snapshot.tasks.length + 50 ? pruneSeen(previous, snapshot.tasks) : previous) }, [snapshot.tasks])
  useEffect(() => { writeSeen(seenKey, seen) }, [seenKey, seen])
  const unread = useCallback((task: TaskSummary) => isUnread(task, seen), [seen])

  useEffect(() => {
    const running = (id: string) => snapshot.tasks.some(task => task.id === id && isActive(task.status))
    setCancelling(previous => { const next = new Set([...previous].filter(running)); return next.size === previous.size ? previous : next })
    setCancelUncertain(previous => { const next = new Set([...previous].filter(running)); return next.size === previous.size ? previous : next })
  }, [snapshot])

  const choose = useStableCallback((id: string | null) => {
    select(id); drawer.setOpen(false); submission.setError('')
    setActionError(previous => previous?.sessionId === id ? previous : null)
    if (submission.pending === null) submission.setDraft('')
  })
  const failAction = (sessionId: string, text: string) => { setActionError({ sessionId, text }) }
  const clearAction = (sessionId: string) => { setActionError(previous => previous?.sessionId === sessionId ? null : previous) }
  const startNew = () => { choose(null); requestAnimationFrame(() => { composerRef.current?.focus({ preventScroll: true }) }) }
  const openSettings = (section?: SettingsSection) => { drawer.setOpen(false); setSettings(section ? { section } : {}) }
  const openSearch = () => { if (drawerMode) drawer.show(searchRef.current); else searchRef.current?.focus() }

  const searchShortcut = useStableCallback((event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
    if (document.querySelector('dialog[open]')) return
    event.preventDefault()
    openSearch()
  })
  useEffect(() => {
    window.addEventListener('keydown', searchShortcut)
    return () => { window.removeEventListener('keydown', searchShortcut) }
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

  const decide = useCallback(async (approval: Approval, decision: 'allow' | 'reject', optionId: string | undefined) => {
    if (approvalFlights.current.has(approval.id)) return
    approvalFlights.current.add(approval.id)
    setApprovalBusy(previous => new Map(previous).set(approval.id, optionId ?? (decision === 'allow' ? 'allow_once' : 'reject_once')))
    clearAction(approval.sessionId)
    // One requestId per decision, reused when the same choice is retried after an unknown outcome.
    const requestId = decisions.current.idFor(approval.id, decision, optionId)
    const body = { decision, requestId, ...(optionId ? { optionId } : {}) }
    try {
      await withConfirmation(confirmation => api<unknown>(`approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', body, ...(confirmation ? { confirmation } : {}) }))
      decisions.current.settle(approval.id)
      await refresh()
    } catch (cause) {
      decisions.current.settle(approval.id, cause)
      const optionKind = choiceKind(approval, decision, optionId)
      const settled = settledOutcome(cause, { decision, ...(optionKind ? { optionKind } : {}) })
      if (settled === undefined) { const text = inlineError(cause); if (text) failAction(approval.sessionId, isUncertain(cause) ? `${text} 可重试同一选择，不会重复提交。` : text) }
      else if (!settled.applied && settled.conflict) failAction(approval.sessionId, settled.message)
      else if (!settled.applied) setToast({ text: settled.message, tone: 'ok' })
      await refresh()
    } finally {
      approvalFlights.current.delete(approval.id)
      setApprovalBusy(previous => { const next = new Map(previous); next.delete(approval.id); return next })
    }
  }, [refresh])
  const onDecide = useCallback((approval: Approval, decision: 'allow' | 'reject', optionId: string | undefined) => { void decide(approval, decision, optionId) }, [decide])

  const cancel = async () => {
    if (selectedId === null || (cancelling.has(selectedId) && !cancelUncertain.has(selectedId))) return
    const id = selectedId
    setCancelling(previous => new Set(previous).add(id)); setCancelUncertain(previous => without(previous, id)); clearAction(id)
    try { await api<unknown>(`tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); await refresh() }
    catch (cause) {
      if (isUncertain(cause)) { setCancelUncertain(previous => new Set(previous).add(id)); failAction(id, '取消结果尚未确认。恢复连接后可重试取消。') }
      else { failAction(id, errorMessage(cause)); setCancelling(previous => without(previous, id)) }
    }
  }

  const setConfig = async (configId: string, value: string) => {
    if (selectedId === null || configBusy.has(selectedId)) return
    const id = selectedId
    setConfigBusy(previous => new Map(previous).set(id, configId)); clearAction(id)
    try {
      // Widening a full-access session's permission mode needs a local confirmation.
      await withConfirmation(confirmation => api<unknown>(`tasks/${encodeURIComponent(id)}/config`, { method: 'POST', body: { configId, value }, ...(confirmation ? { confirmation } : {}) }))
      await refresh()
    } catch (cause) {
      stopSession(id, cause)
      const text = inlineError(cause)
      if (text && !(cause instanceof ApiError && isSessionStopCode(cause.code))) failAction(id, text)
    }
    finally { setConfigBusy(previous => { const next = new Map(previous); next.delete(id); return next }) }
  }

  const patchTask = useStableCallback(async (task: TaskSummary, patch: { pinned?: boolean; archived?: boolean }, done: string) => {
    try { await api<unknown>(`tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: patch }); await refresh(); setToast({ text: done, tone: 'ok' }) }
    catch (cause) { setToast({ text: errorMessage(cause), tone: 'error' }) }
  })
  const exportTask = useStableCallback(async (task: TaskSummary) => {
    try {
      const data = task.id === current?.summary.id ? current : await api<TaskDetail>(`tasks/${encodeURIComponent(task.id)}`)
      await saveText(exportFileName(data.summary.title), transcriptMarkdown(data, { harness: sessionHarness(catalog, data.summary)?.name }))
    } catch (cause) { setToast({ text: errorMessage(cause), tone: 'error' }) }
  })
  const manageable = catalog !== undefined
  const sessionMenu = useCallback((task: TaskSummary): MenuSection[] => sessionMenuSections(task, {
    rename: () => { setRenaming(task) },
    pin: () => { void patchTask(task, { pinned: !task.pinned }, task.pinned ? '已取消置顶' : '已置顶') },
    archive: () => { void patchTask(task, { archived: !task.archived }, task.archived ? '已移回会话列表' : '已归档，可在筛选中查看') },
    export: () => { void exportTask(task) },
    remove: () => { setDeleting(task) },
  }, manageable), [patchTask, exportTask, manageable])

  // Composer: new-session choices or the open session's next-turn settings.
  const choice = submission.choice
  const block = selectedId === null ? startBlock(snapshot, choice, access) : null
  const chosenHarness = selectedId === null ? findHarness(catalog, choice.harnessId) : undefined
  const startsL3 = !access.legacy && chosenHarness !== undefined && harnessLevel(chosenHarness) === 'L3'
  const stopCode: SessionStopCode | undefined = selectedId === null ? undefined
    : summary?.permissionDrift || current?.permission?.drift ? 'permission-drift' : stopped.get(selectedId)
  const gate = selectedId === null
    ? (access.legacy || access.scopes.has('run') ? { kind: 'open' as const } : { kind: 'read-only' as const, text: '此设备没有「发起和继续会话」权限' })
    : composerGate({ summary, permission: current?.permission, access, stopped: stopCode !== undefined })
  const sessionBlock = selectedId === null ? undefined
    : harnessInfo?.status === 'unavailable' ? harnessInfo.statusMessage || `${harnessInfo.name} 暂不可用`
      : !catalog && snapshot.execution?.ready === false ? '当前模型接口不可用，请检查模型插件状态。' : undefined
  const currentModel = sessionModel(summary)
  const effectiveModel = submission.override ?? currentModel
  const mode = selectedId === null ? choice.mode : summary?.mode ?? 'agent'
  const manageProviders = owner ? () => { openSettings('providers') } : undefined
  const liveTool = current?.messages.findLast(message => message.role === 'tool' && message.state === 'running')
  const phase = current?.activity?.phase
  const runLabel = phase === 'tool' ? `正在执行 ${liveTool?.tool?.title || current?.activity?.toolName || liveTool?.toolName || '工具'}`
    : current?.liveText ? '正在生成回复' : current?.liveReasoning ? '正在思考' : phase === 'model' ? '等待模型响应' : '正在运行'
  const cancelState = selectedId !== null && cancelUncertain.has(selectedId) ? 'uncertain' : selectedId !== null && (cancelling.has(selectedId) || phase === 'cancelling') ? 'cancelling' : 'idle'
  const run: RunState | undefined = selectedId !== null && active ? {
    label: runLabel, elapsed: runElapsed, approvals: approvals.length, onRevealApprovals: revealApprovals, cancel: cancelState, onCancel: () => { void cancel() },
  } : undefined
  const placeholder = submission.pending !== null ? '等待确认上一条提交…'
    : selectedId === null ? (mode === 'chat' ? '写下问题或想法…' : '描述任务，以及你希望得到的结果…')
      : mode === 'chat' ? '继续对话 · 对话模式不调用工具' : '继续补充要求…'
  const composer = <Composer textareaRef={composerRef} variant={selectedId === null ? 'new' : 'session'} label={selectedId === null ? '新会话消息' : '继续对话'}
    placeholder={placeholder} draft={submission.draft} onDraft={submission.setDraft} pending={submission.pending} sending={submission.sending}
    error={submission.error || (actionError?.sessionId === selectedId ? actionError.text : '')} onRetry={() => { if (submission.pending) void submission.submit(submission.pending) }}
    canSend={gate.kind === 'open' && (selectedId === null ? block === null : sessionBlock === undefined)} blockReason={block?.message ?? sessionBlock}
    readOnly={gate.kind === 'read-only' ? gate.text : gate.kind === 'stopped' ? '该会话不再接受输入。' : undefined}
    notice={startsL3 && block === null ? L3_START_HINT : undefined}
    onSubmit={() => { void submission.submit() }} sendKey={preferences.sendKey} coarse={coarse} run={run} plan={active ? current?.plan : undefined}
    controls={selectedId === null
      ? <NewSessionControls catalog={catalog} choice={choice} onChoice={submission.updateChoice} phone={phone} disabled={submission.pending !== null || submission.sending || gate.kind !== 'open'}
        onManageProviders={manageProviders} onManageWorkspaces={owner ? () => { openSettings('workspaces') } : undefined} access={access} />
      : summary && <SessionControls catalog={catalog} summary={summary} harness={harnessInfo} model={effectiveModel} current={currentModel}
        onModel={model => { submission.setOverride(summary.id, model) }} config={current?.config ?? []} configBusy={configBusy.get(summary.id) ?? null}
        onConfig={(configId, value) => { void setConfig(configId, value) }} phone={phone} onManageProviders={manageProviders} locked={gate.kind !== 'open'} />} />

  const inspectorInline = viewport === 'desktop' && preferences.inspector && summary !== undefined
  const toggleInspector = () => { if (viewport === 'desktop') setPreference('inspector', !preferences.inspector); else setInspectorSheet(true) }
  const revealFromInspector = (messageId: string) => { setInspectorSheet(false); reveal(messageId) }
  const runtime = summary ? [harnessName, summary.model].filter(Boolean).join(' · ') : undefined
  // The demo label follows what this session (or the new-session choice) actually runs on.
  const demo = selectedId === null ? usesDemoModel(snapshot, choice.harnessId, choice.model?.providerId)
    : summary !== undefined && usesDemoModel(snapshot, summary.harnessId, summary.providerId)
  const topMenu: MenuSection[] = summary ? [
    ...(viewport !== 'desktop' ? [{ id: 'view', items: [{ id: 'details', label: '会话详情', icon: PanelRight, onSelect: () => { setInspectorSheet(true) } }] }] : []),
    ...sessionMenu(summary),
    { id: 'sync', items: [{ id: 'refresh', label: '同步最新状态', icon: RefreshCw, onSelect: () => { void refresh() } }] },
  ] : []
  const connectionProblem = harness.error || connection === 'reconnecting' || connection === 'offline'
  const devMode = host?.devMode === true
  const level = current?.permission?.level ?? summary?.level

  return <div className={`app-shell viewport-${viewport} ${inspectorInline ? 'has-inspector' : ''}`} data-viewport={viewport} data-connection={connection}>
    {viewport === 'tablet' && <nav ref={rail} className="rail" aria-label="快捷导航">
      <Rail approvals={snapshot.approvals.length} drawerOpen={drawer.open} onSessions={() => { drawer.show() }} onNew={startNew} onSearch={openSearch}
        onApprovals={openApprovals} onDevices={() => { openSettings('devices') }} onSettings={() => { openSettings() }} connection={connection} onRefresh={() => { void refresh() }} devMode={devMode} />
    </nav>}
    {drawerMode && drawer.open && <button type="button" className="drawer-backdrop" aria-label="关闭会话列表" tabIndex={-1} onClick={() => { drawer.setOpen(false) }} />}
    <aside ref={navigation} id="session-navigation" className={`sidebar ${drawer.open ? 'is-open' : ''}`} aria-label="会话导航"
      role={drawerMode && drawer.open ? 'dialog' : undefined} aria-modal={drawerMode && drawer.open ? true : undefined} tabIndex={-1}>
      <Sidebar snapshot={snapshot} selectedId={selectedId} isUnread={unread} cancelling={cancelling} search={search} onSearch={setSearch} searchRef={searchRef}
        filter={filter} onFilter={setFilter} onSelect={choose} onNew={startNew} onApprovals={openApprovals} drawer={drawerMode} onClose={() => { drawer.setOpen(false) }}
        connection={connection} onRefresh={() => { void refresh() }} onDevices={() => { openSettings('devices') }} onSettings={() => { openSettings() }} sessionMenu={sessionMenu} now={now}
        devMode={devMode && !drawerMode} />
    </aside>
    <main ref={main} className={`workspace ${selectedId === null ? 'is-new' : 'has-task'}`}>
      <TopBar summary={summary} cancelling={selectedId !== null && cancelling.has(selectedId)} level={access.legacy ? undefined : level} runtime={runtime} demo={demo} phone={phone}
        drawerOpen={drawer.open} onDrawer={phone ? () => { drawer.show() } : undefined} onNew={startNew} inspectorOpen={inspectorInline} onInspector={toggleInspector}
        menu={topMenu} connection={connection} onRefresh={() => { void refresh() }} />
      {connectionProblem && <div className="banner-region"><InlineAlert tone="warn" action={<button type="button" className="text-button" onClick={() => { void refresh() }}>重试</button>}>
        {connection === 'offline' ? '当前设备已离线。已读内容仍可查看；恢复连接后会同步执行端状态。' : harness.error || '连接已中断，正在重连；恢复后会同步执行端的最新状态。'}
      </InlineAlert></div>}
      {audit.rollback && <div className="banner-region"><InlineAlert tone="error" action={<span className="banner-actions">
        <button type="button" className="text-button" onClick={audit.accept}>已核对</button>
        <button type="button" className="icon-button banner-close" aria-label="关闭提示" title="关闭提示" onClick={audit.dismiss}><X size={14} strokeWidth={ICON_STROKE} aria-hidden="true" /></button>
      </span>}>{AUDIT_ROLLBACK_TEXT}</InlineAlert></div>}
      {access.legacy && <div className="banner-region"><InlineAlert tone="neutral">{LEGACY_HOST_TEXT}</InlineAlert></div>}
      {stopCode && <div className="banner-region"><InlineAlert tone={stopCode === 'permission-drift' ? 'error' : 'warn'}
        action={<button type="button" className="button secondary small" onClick={startNew}><SquarePen size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />新建会话</button>}>
        {SESSION_STOP_TEXT[stopCode]}</InlineAlert></div>}
      {sessionBlock && <div className="banner-region"><InlineAlert tone="info">{sessionBlock}</InlineAlert></div>}
      {selectedId === null
        ? <NewSession composer={composer} demo={demo} mode={choice.mode}
          setup={block && <SetupCard block={block} owner={owner} onSetup={() => { openSettings(block.kind === 'model-required' ? 'providers' : catalog ? 'agents' : 'plugins') }} />}
          onSuggestion={prompt => { submission.setDraft(prompt); composerRef.current?.focus() }} />
        : <div className="conversation">
          <div className="transcript-shell">
            <div className="transcript" ref={reading.containerRef} {...reading.handlers} tabIndex={0} aria-label="会话记录">
              <div className="transcript-content" ref={reading.contentRef}>
                {current === null ? <p className="loading-line"><Spinner size={16} />正在读取会话记录…</p>
                  : <Transcript detail={current} approvals={approvals} busy={approvalBusy} onDecide={onDecide} gateFor={gateFor} harnessName={harnessName} active={active} />}
                {current !== null && current.messages.length === 0 && !isLive(current) && approvals.length === 0
                  && <p className="transcript-empty">{active ? '执行端已接收，等待输出。' : '会话记录会显示在这里。'}</p>}
              </div>
            </div>
            {!reading.isFollowing && <button type="button" className="jump-latest" onClick={jumpToLatest}><ArrowDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />回到最新</button>}
          </div>
          <div className="composer-dock">{composer}</div>
        </div>}
    </main>
    {inspectorInline && summary && <aside className="inspector-pane" aria-label="会话详情">
      <header className="pane-header"><h2>会话详情</h2><IconButton label="收起会话详情" icon={X} onClick={() => { setPreference('inspector', false) }} /></header>
      <Inspector snapshot={snapshot} summary={summary} detail={current} onReveal={reveal} />
    </aside>}
    {inspectorSheet && summary && viewport !== 'desktop' && <Modal label="会话详情" variant={phone ? 'sheet' : 'side'} onClose={() => { setInspectorSheet(false) }}>
      <ModalHeader title="会话详情" onClose={() => { setInspectorSheet(false) }} />
      <div className="sheet-body"><Inspector snapshot={snapshot} summary={summary} detail={current} onReveal={revealFromInspector} /></div>
    </Modal>}
    {settings && <SettingsPage snapshot={snapshot} access={access} initial={settings.section} onClose={() => { setSettings(null); void refresh() }} onChanged={() => { void refresh() }} />}
    {renaming && <PromptDialog title="重命名会话" label="会话名称" initial={renaming.title} maxLength={120} onClose={() => { setRenaming(null) }}
      onSubmit={async title => {
        try { await api<unknown>(`tasks/${encodeURIComponent(renaming.id)}`, { method: 'PATCH', body: { title } }) }
        catch (cause) { throw new Error(errorMessage(cause)) }
        await refresh()
      }} />}
    {deleting && <ConfirmDialog title="删除会话" danger confirmLabel="删除" message={`删除「${deleting.title || '未命名会话'}」及其全部记录？此操作无法撤销。`} onClose={() => { setDeleting(null) }}
      onConfirm={async () => {
        try { await api<unknown>(`tasks/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' }) }
        catch (cause) { throw new Error(errorMessage(cause)) }
        setStopped(previous => { if (!previous.has(deleting.id)) return previous; const next = new Map(previous); next.delete(deleting.id); return next })
        if (deleting.id === selectedId) choose(null)
        await refresh()
        setToast({ text: '会话已删除', tone: 'ok' })
      }} />}
    {toast && <div className={`toast toast-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>{toast.text}</div>}
  </div>
}
