import { SHELL_COPY } from './copy.ts'
import { DETACHED, DetachedPlace } from '../panel/terminal/fills.ts'
import { useLayoutEffect, useMemo } from 'react'
import { dropAttachments } from '../composer/AttachmentDrafts.tsx'
import { overlayDismissed } from '../escapeGrace.ts'
import { FileOpenContext } from '../preview/fileContext.ts'

import { SIDEBAR_MIN } from './panelLayout.ts'
import { keepAwakeLine } from '../core/shellLifecycle.ts'
import { openLayer, useBackLayer } from '../hooks/backStack.ts'
import { FoundHarnessesCard } from '../newSession/NewSession.tsx'
import { HistoryImportEntry } from '../history/HistoryImport.tsx'
import { harnessName as harnessLabel, usesDemoModel, listsFoundHarnesses } from '../composerChoice.ts'
import { MoveCarry, MoveHistory, MovingThread } from '../conversation/HarnessMove.tsx'
import { PhoneSessionList } from '../components/PhoneSessionList.tsx'
import { Sidebar } from '../components/Sidebar.tsx'
import { ConversationHeader } from './ConversationHeader.tsx'
import {
  Backdrop,
  Button,
  IconButton,
  LiveChanges,
  LayerHistory,
  Modal,
  ResizeHandle,
  Scrim,
  ChevronLeftGlyph,
  SearchGlyph,
  StatusPill,
} from '@latch/ui'
import { ConnectionBanners } from './ConnectionBanners.tsx'
import { PhoneTabBar } from './PhoneTabBar.tsx'
import { PhoneReview } from '../phone-review/PhoneReview.tsx'
import { TitleBar } from './TitleBar.tsx'
import { RIGHT_PANEL_MIN } from './panelLayout.ts'
import { SettingsPage } from '../settings/SettingsPage.tsx'
import { deferredComponent } from '../components/DeferredContent.tsx'
import type { PluginMarketplace as MarketplaceView } from '../plugin-marketplace/PluginMarketplace.tsx'
import { AgentsPage } from '../agents/AgentsPage.tsx'
import { ProfileLayer } from '../agents/AgentProfile.tsx'
import { AppsPage } from '../plugin-pages/AppsPage.tsx'
import { AgentsSpaceList } from '../agents/AgentsSpaceList.tsx'
import { ShellNewAgent, shellOverview, shellSpaces } from './SpaceNav.tsx'
import { ConversationView } from './ConversationView.tsx'
import { Overlays } from './Overlays.tsx'
import { EditLeaveGuard } from '../preview/EditLeaveGuard.tsx'
import { EditorChooser } from '../components/OpenInEditor.tsx'
import { RightPanel, SessionDraftEntry } from './RightPanel.tsx'
import { TerminalDock } from './TerminalDock.tsx'
import { workbenchPanes } from './WorkbenchPanes.tsx'
import { useStagingWrites } from '../panel/changes/useStaging.ts'
import { DraftFilePanel } from './DraftFilePanel.tsx'
import { SendingBubble, SessionComposer, SetupNotices } from './SessionComposers.tsx'
import { useSideQuestionForks, withoutSideForks } from '../conversation/SideQuestion.tsx'
import { useShellLayout } from './useShellLayout.tsx'
import { PhoneComputer, SidebarComputer, TabletRail, WorkbenchConnection } from './WorkbenchNav.tsx'
import { UsageEntry } from '../usage/UsageEntry.tsx'
import { ShellUpdateCheck } from './UpdateCheck.tsx'
import { ViewSwitch } from './ViewSwitch.tsx'
import { StartCounts } from './StartCounts.tsx'
import { BoardSurface } from '../board/BoardSurface.tsx'
import { boardCounts } from '../sessions.ts'
import { conversationInFront } from './conversationShown.ts'
import { backdropLevel } from '../preferences.ts'
import type { AppSnapshot } from '@latch/protocol'
import type { useHarness } from '../core/useHarness.ts'
import { canEditPluginPackages } from '../settings/pluginAssets.ts'

const PluginMarketplace = deferredComponent<Parameters<typeof MarketplaceView>[0]>(
  () => import('../plugin-marketplace/PluginMarketplace.tsx').then(module => ({ default: module.PluginMarketplace })),
  () => SHELL_COPY.marketplace,
  (_props, body) => <div className="marketplace-workspace-status">{body}</div>,
)

type Harness = ReturnType<typeof useHarness>

/** The signed-in shell. Mounted once per device identity, so per-device state starts fresh. */
export function AppShell({ harness, snapshot }: { harness: Harness; snapshot: AppSnapshot }) {
  const shell = useShellLayout({ harness, snapshot })
  const {
    phoneSession: selectedPhoneSession,
    phoneReview,
    folding,
    route,
    setRoute,
    appShell,
    sidebarColumn,
    resetInspector,
    choose,
    access,
    refresh,
    summary,
    stopping,
    now,
    catalog,
    submission,
    choice,
    attachmentDraft,
    unread,
    sessionMenu,
    gate,
    noteComposer,
    conversationEpoch,
    viewport,
    phone,
    drawerMode,
    sidebarDrag,
    setSidebarDrag,
    infoPage,
    phoneSearching,
    setPhoneSearching,
    popping,
    pushed,
    inspectorDrag,
    sidebarSnapping,
    navigation,
    main,
    searchRef,
    search,
    setSearch,
    filter,
    setFilter,
    infoPageRef,
    infoBack,
    lifecycle,
    fileTabs,
    filesVisible,
    placement,
    pageMode,
    columnOpen,
    inspectorWidth,
    sidebarCollapsed,
    drawer,
    saveSidebar,
    openFile,
    startNew,
    openSettings,
    settings,
    closeSettings,
    openProjectEditor,
    createProjectAndStart,
    sidebarLimit,
    sidebarWidth,
    setSidebarShut,
    resizeSidebar,
    resizeInspector,
    searchResults,
    archiveBatch,
    archiveUndo,
    openSearch,
    startWithoutProject,
    startIn,
    workspaceForFiles,
    column,
    page,
    closeInfoPage,
    selectedId,
    resync,
    connection,
    entries,
    goEntry,
    hostProblem,
  } = shell
  const stagingWrites = useStagingWrites(summary, snapshot)
  // The fork behind an open /btw panel is the panel's: it joins the list once opened as a session.
  const sideForks = useSideQuestionForks()
  const listed = withoutSideForks(snapshot, sideForks, selectedId)
  const board = shell.board
  // 对话's start screen: the new session's input over the session kept under it. Under 看板 it is not drawn at all, so
  // only one new-session input is ever mounted (看板's 新建 holds it then).
  const startRoute = route.entry === 'sessions' && route.start === true && !board
  const pendingStart = startRoute && catalog?.features?.messageIdentity && submission.startingMessage
  const start = startRoute && !pendingStart
  const draftProject =
    start && !shell.creator && !submission.fork?.moved
      ? catalog?.workspaces.find(item => item.id === choice.workspaceId && item.id !== 'default')
      : undefined
  const draftSummary = draftProject && shell.renderProjectSummary(draftProject)
  const coveredHome = shell.marketplaceOverHome && !submission.startingMessage
  // A conversation going on with another Harness: its source, the Harness it leaves and the one chosen for the next message.
  const movingFork = (start || coveredHome) && submission.fork?.moved ? submission.fork : undefined
  const movingSource = movingFork ? snapshot.tasks.find(task => task.id === movingFork.taskId) : undefined
  const movingTo = movingFork ? catalog?.harnesses.find(item => item.id === choice.harnessId) : undefined
  const movingFrom = movingSource ? catalog?.harnesses.find(item => item.id === movingSource.harnessId) : undefined
  const moving =
    movingFork && movingSource
      ? {
          taskId: movingFork.taskId,
          from: movingSource.harnessId,
          fromName: movingFrom ? harnessLabel(movingFrom) : movingSource.harnessId,
          to: { name: movingTo ? harnessLabel(movingTo) : (choice.harnessId ?? ''), harness: movingTo },
        }
      : undefined
  const phoneSession = selectedPhoneSession || (phone && !!pendingStart)
  const pendingStartId = pendingStart ? pendingStart.submission.requestId : undefined
  const homeShell = { ...shell, ...shell.homeComposerState }
  const panes = workbenchPanes(shell)
  const counts = useMemo(() => boardCounts(listed.tasks, listed.items), [listed.tasks, listed.items])
  const hasConnectionStrip = !phone && route.entry === 'sessions'
  useLayoutEffect(() => {
    if (!pendingStartId || settings || document.activeElement !== document.body) return
    if (phone) {
      main.current?.querySelector<HTMLElement>('.topbar-back')?.focus({ preventScroll: true })
      return
    }
    const workspace = main.current
    if (!workspace) return
    // The workspace is a region, not a control: it takes focus when the start input unmounts without drawing a ring.
    if (!workspace.hasAttribute('tabindex')) workspace.tabIndex = -1
    workspace.dataset.layoutFocus = ''
    workspace.focus({ preventScroll: true })
  }, [main, pendingStartId, phone, settings])
  useLayoutEffect(() => {
    if (shell.mentionReturnLabel && document.activeElement === document.body)
      main.current?.querySelector<HTMLElement>('[data-mention-return]')?.focus({ preventScroll: true })
  }, [main, shell.mentionReturnLabel])
  // The right panel's strip starts where the session's head ends, so the head's foot runs on as one line.
  useLayoutEffect(() => {
    const frame = appShell.current
    const head = main.current?.querySelector<HTMLElement>(':scope > .workspace-view > .topbar')
    if (!frame || !head || phone) return undefined
    const write = () => frame.style.setProperty('--session-head', `${head.offsetHeight}px`)
    write()
    const observer = new ResizeObserver(write)
    observer.observe(head)
    return () => {
      observer.disconnect()
      frame.style.removeProperty('--session-head')
    }
  }, [appShell, main, phone, selectedId, board])
  // The right panel's strip shares the window's top row with the title row's end, and keeps that end's width clear.
  useLayoutEffect(() => {
    const frame = appShell.current
    const views = frame?.querySelector<HTMLElement>(':scope > .titlebar > .titlebar-views')
    if (!frame || !views || phone) return undefined
    const write = () => frame.style.setProperty('--window-controls', `${views.offsetWidth}px`)
    write()
    const observer = new ResizeObserver(write)
    observer.observe(views)
    return () => {
      observer.disconnect()
      frame.style.removeProperty('--window-controls')
    }
  }, [appShell, phone, board])
  // A phone's start screen is pushed over its session list: back goes to the list, not to a session kept under it.
  const toPhoneList = () => {
    setRoute({ entry: 'sessions' })
    // The session was parked when the start screen covered it; letting go of it here keeps the new session's draft.
    if (selectedId !== null) harness.select(null)
  }
  useBackLayer(phone && (startRoute || shell.marketplaceOverHome), toPhoneList)
  useBackLayer(shell.marketplace, shell.dismissMarketplace, shell.marketplacePath)
  useBackLayer(!phone && shell.marketplace && !!settings, closeSettings)
  // False whenever 看板 is in front: the conversation under it is kept, not seen.
  const visibleConversation = conversationInFront({
    entry: route.entry,
    selectedId,
    start: startRoute,
    board,
    settings: !!settings,
    panelPage: !!(pageMode && infoPage),
    phoneReview: phoneReview.present,
  })
  const level = backdropLevel(shell.preferences, phone)
  const backdropEnabled = level !== 'off' && shell.space === 'code' && !settings && !shell.marketplace
  const homeBackdrop = backdropEnabled && start
  return (
    <FileOpenContext.Provider value={catalog?.features?.filePreview ? openFile : undefined}>
      <DetachedPlace.Provider value={catalog?.features?.terminal === true && !phone ? DETACHED : undefined}>
        <LayerHistory value={phone || shell.marketplace ? openLayer : null}>
          <LiveChanges value={harness.resyncs}>
            <div
              ref={appShell}
              className={`app-shell viewport-${viewport}`}
              data-viewport={viewport}
              data-connection={connection}
              data-entry={route.entry}
              data-view={board ? 'board' : 'chat'}
              data-start={start ? '' : undefined}
              data-connection-strip={hasConnectionStrip ? '' : undefined}
              data-folding={folding ? '' : undefined}
              data-sidebar={sidebarColumn ? (sidebarCollapsed ? 'collapsed' : 'open') : undefined}
              data-inspector={columnOpen && !shell.marketplace ? (placement?.kind === 'sheet' ? 'sheet' : 'open') : undefined}
              data-home-inspector={shell.homeInspectorOpen && !shell.marketplace ? '' : undefined}
              data-terminal-dock={shell.terminalOpen && !shell.marketplace ? '' : undefined}
              data-resizing={(sidebarDrag !== null && !sidebarSnapping) || inspectorDrag || shell.dockDrag ? '' : undefined}
              style={{
                '--sidebar-width': sidebarColumn && !sidebarCollapsed ? `${sidebarWidth}px` : '0px',
                '--sidebar-open-width': `${sidebarWidth}px`,
                '--inspector-width': columnOpen && placement?.kind === 'column' && !shell.marketplace ? `${inspectorWidth}px` : '0px',
                '--inspector-open-width': `${inspectorWidth}px`,
                '--dock-height': shell.terminalOpen && !shell.marketplace ? `${shell.dockHeight}px` : '0px',
                '--workbench-pane-count': Number(panes.left) + Number(panes.terminal) + Number(panes.right),
              }}>
              {!phone && <TitleBar shell={shell} draftSummary={draftSummary} />}
              {/* One switch for both views, at the end of the window's top row: it stays mounted through a change. */}
              {!phone && !shell.marketplace && (
                <ViewSwitch className="shell-view-switch" icons value={shell.preferences.workView} waiting={counts.attention} />
              )}
              {viewport === 'tablet' && <TabletRail shell={shell} />}
              <Scrim
                open={drawerMode && drawer.open}
                label={SHELL_COPY.closeSessions}
                className="drawer-backdrop"
                onDismiss={() => {
                  drawer.setOpen(false)
                }}
              />
              {phone ? (
                <section
                  id="session-navigation"
                  className="phone-list"
                  aria-label={SHELL_COPY.sessions}
                  data-covered={(phoneSession && !popping && !start) || (phoneReview.present && !phoneReview.leaving) ? '' : undefined}
                  inert={
                    (phoneSession && !popping && !start)
                    || (phoneReview.present && !phoneReview.leaving)
                    || route.entry !== 'sessions'
                    || start
                    || board
                    || undefined
                  }>
                  <div className="phone-view-switch">
                    <ViewSwitch value={shell.preferences.workView} waiting={counts.attention} />
                  </div>
                  <PhoneSessionList
                    host={<PhoneComputer shell={shell} />}
                    space={entries.includes('agents') ? 'code' : undefined}
                    snapshot={listed}
                    searchResults={searchResults}
                    archiveBatch={archiveBatch}
                    archiveUndo={archiveUndo}
                    connection={connection}
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
                    onMarketplace={shell.canBrowseMarketplace ? shell.openMarketplace : undefined}
                    onNewIn={startIn}
                    onEditProject={openProjectEditor}
                    onRefresh={resync}
                    sessionMenu={sessionMenu}
                    now={now}
                    banners={selectedId === null ? <ConnectionBanners shell={shell} /> : undefined}
                    reviews={phoneReview.reviews}
                    onReview={phoneReview.open}
                  />
                </section>
              ) : (
                <aside
                  ref={navigation}
                  id="session-navigation"
                  className={`sidebar ${drawer.open ? 'is-open' : ''}`}
                  inert={(route.entry !== 'sessions' && !shell.marketplace) || board || undefined}
                  aria-label={SHELL_COPY.sessionNavigation}
                  role={drawerMode && drawer.open ? 'dialog' : undefined}
                  aria-modal={drawerMode && drawer.open ? true : undefined}
                  tabIndex={-1}>
                  <Sidebar
                    projectTree
                    overview={shellOverview(shell)}
                    onSchedules={catalog?.features?.automations ? () => shell.openMyAgent({ id: 'general', tab: 'schedules' }) : undefined}
                    onMarketplace={shell.canBrowseMarketplace ? shell.openMarketplace : undefined}
                    marketplaceActive={shell.marketplace}
                    computerAtFoot={viewport !== 'tablet' && access.scopes.has('view')}
                    {...(viewport !== 'tablet' && access.scopes.has('view') ? { quota: <UsageEntry /> } : {})}
                    update={<ShellUpdateCheck shell={shell} />}
                    snapshot={listed}
                    archiveBatch={archiveBatch}
                    archiveUndo={archiveUndo}
                    selectedId={shell.marketplace ? null : selectedId}
                    isUnread={unread}
                    cancelling={stopping}
                    onSearch={openSearch}
                    onNewWithoutProject={startWithoutProject}
                    filter={filter}
                    onFilter={setFilter}
                    onSelect={choose}
                    onNew={startNew}
                    onNewIn={startIn}
                    onCreateProject={createProjectAndStart}
                    onSettings={
                      entries.includes('settings')
                        ? () => {
                            goEntry('settings')
                          }
                        : undefined
                    }
                    spaces={shellSpaces(shell)}
                    agents={
                      entries.includes('agents')
                        ? { primary: <ShellNewAgent shell={shell} />, list: <AgentsSpaceList shell={shell} /> }
                        : undefined
                    }
                    hostProblem={hostProblem}
                    onEditProject={openProjectEditor}
                    newActive={false}
                    drawer={drawerMode}
                    onClose={() => {
                      drawer.setOpen(false)
                    }}
                    connection={connection}
                    onRefresh={() => {
                      void resync()
                    }}
                    sessionMenu={sessionMenu}
                    now={now}
                    apps={entries.includes('apps') ? { current: false, onOpen: () => shell.openApp() } : undefined}
                    computerChip={computers => <SidebarComputer shell={shell} computers={computers} />}
                    {...(lifecycle.view?.keepAwake.active ? { keepAwake: keepAwakeLine(lifecycle.view.keepAwake) } : {})}
                  />
                </aside>
              )}
              {sidebarColumn && (
                <ResizeHandle
                  className="sidebar-resize"
                  label={SHELL_COPY.sidebarWidth}
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
                    setSidebarShut(!sidebarCollapsed)
                  }}
                />
              )}
              <LiveChanges value={conversationEpoch}>
                {(!phone || phoneSession) && (
                  <main
                    ref={main}
                    inert={route.entry !== 'sessions' || start || board || undefined}
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
                    className={`workspace ${selectedId === null && !pendingStart ? 'is-new' : 'has-task'}`}
                    data-backdrop-hidden={visibleConversation || (pendingStart && !settings) ? undefined : ''}
                    data-pending-start={pendingStartId}
                    data-info-page={pageMode && infoPage ? '' : undefined}
                    data-pushed={phone && pushed ? '' : undefined}
                    data-leaving={phone && popping ? '' : undefined}>
                    {attachmentDraft.dragging && !start && (
                      <div className="attachment-drop-mask" role="status">
                        {SHELL_COPY.dropAttachments}
                      </div>
                    )}
                    {/* Under the panel's page the conversation cannot be reached until the page is closed. */}
                    <div className="workspace-view" inert={(pageMode && infoPage) || undefined}>
                      <ConversationHeader shell={shell} starting={pendingStart || null} onStartBack={toPhoneList} />
                      {shell.mentionReturnLabel && (
                        <div className="item-conversation-back">
                          <Button size="xs" variant="ghost" icon={ChevronLeftGlyph} data-mention-return="" onClick={shell.returnToMention}>
                            {shell.mentionReturnLabel}
                          </Button>
                        </div>
                      )}
                      {shell.itemReturn && !phone && (
                        <div className="item-conversation-back">
                          <Button size="xs" variant="ghost" icon={ChevronLeftGlyph} onClick={shell.returnToWorkItem}>
                            {SHELL_COPY.backToItem}
                          </Button>
                        </div>
                      )}
                      {/* The conversation's paper: on phones it rises under the header on the ground. */}
                      <ConversationView
                        shell={shell}
                        visible={visibleConversation}
                        starting={pendingStart || null}
                        backdrop={backdropEnabled ? level : 'off'}
                        backdropKind={shell.preferences.backdropStyle}
                      />
                    </div>
                    {page.present && (summary || filesVisible) && (
                      <section
                        ref={infoPageRef}
                        className="info-page"
                        data-leaving={page.leaving ? '' : undefined}
                        aria-label={SHELL_COPY.sidePanel}
                        onKeyDown={event => {
                          if (event.key === 'Escape' && !event.defaultPrevented) {
                            event.preventDefault()
                            closeInfoPage()
                          }
                        }}>
                        <header className="info-page-head">
                          {shell.itemReturn ? (
                            <Button ref={infoBack} size="sm" variant="ghost" icon={ChevronLeftGlyph} onClick={shell.returnToWorkItem}>
                              {SHELL_COPY.backToItem}
                            </Button>
                          ) : phone ? (
                            <IconButton ref={infoBack} size="lg" label={SHELL_COPY.back} icon={ChevronLeftGlyph} onClick={closeInfoPage} />
                          ) : (
                            <Button ref={infoBack} variant="ghost" icon={ChevronLeftGlyph} onClick={closeInfoPage}>
                              {SHELL_COPY.backToChat}
                            </Button>
                          )}
                          <div className="info-page-title">
                            <h2>
                              {fileTabs.active?.target.view === 'changes'
                                ? SHELL_COPY.codeReview
                                : fileTabs.active
                                  ? SHELL_COPY.filePreview
                                  : (shell.panelChoiceList.find(choice => choice.key === shell.panelSelected)?.label ?? SHELL_COPY.panel)}
                            </h2>
                            <span>{summary?.title || workspaceForFiles?.name || SHELL_COPY.projectFiles}</span>
                          </div>
                        </header>
                        <div className="info-page-body">
                          <RightPanel shell={shell} stagingWrites={stagingWrites} />
                        </div>
                      </section>
                    )}
                  </main>
                )}
                {placement !== null && placement.kind !== 'page' && (
                  <aside
                    className="inspector-column"
                    aria-label={SHELL_COPY.sidePanel}
                    inert={!columnOpen || route.entry !== 'sessions' || board || (start && !shell.homeInspectorOpen) || undefined}
                    onKeyDown={event => {
                      // Esc inside the panel shuts it, after what is inside had its turn; it never reaches a run or a request.
                      // Fields, menus, dialogs and editors keep their own Esc.
                      if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
                      if (
                        event.target instanceof Element
                        && event.target.closest(
                          'dialog, [popover], [role="menu"], [role="listbox"], [role="dialog"], input, textarea, select, [contenteditable]:not([contenteditable="false"])',
                        )
                      )
                        return
                      event.preventDefault()
                      overlayDismissed()
                      if (shell.homeInspector) shell.togglePanel()
                      else shell.closePanel()
                    }}>
                    {column.present && (
                      <div className="inspector-column-inner">
                        {shell.homeInspector ? (
                          <DraftFilePanel shell={shell} inline />
                        ) : (
                          <RightPanel shell={shell} stagingWrites={stagingWrites} />
                        )}
                      </div>
                    )}
                  </aside>
                )}
                {placement !== null && placement.kind !== 'page' && columnOpen && sidebarColumn && (
                  <ResizeHandle
                    className="inspector-resize"
                    label={SHELL_COPY.panelWidth}
                    edge="start"
                    value={inspectorWidth}
                    min={RIGHT_PANEL_MIN}
                    max={shell.inspectorMax}
                    onResize={resizeInspector}
                    onReset={resetInspector}
                  />
                )}
              </LiveChanges>
              <TerminalDock shell={shell} />
              {(start || coveredHome) && (
                <section
                  className={homeBackdrop ? 'workbench-home code-home ui-backdrop-host' : 'workbench-home code-home'}
                  data-moving={moving ? '' : undefined}
                  hidden={coveredHome}
                  inert={coveredHome}
                  aria-label={SHELL_COPY.newSession}
                  onDragEnter={event => {
                    if (
                      !shell.creator
                      && catalog?.features?.attachments === true
                      && homeShell.gate.kind === 'open'
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
                    if (!shell.creator && catalog?.features?.attachments === true && homeShell.gate.kind === 'open')
                      dropAttachments(event, attachmentDraft)
                    else if ([...event.dataTransfer.types].includes('Files')) event.preventDefault()
                  }}>
                  {homeBackdrop && (
                    <Backdrop
                      className="workbench-backdrop"
                      kind={shell.preferences.backdropStyle}
                      ambient
                      level={level}
                      running={connection === 'connected' ? counts.running : 0}
                    />
                  )}
                  {/* Files dropped anywhere on the start screen go to its input, as they go to the open session's elsewhere. */}
                  {attachmentDraft.dragging && (
                    <div className="attachment-drop-mask" role="status">
                      {SHELL_COPY.dropAttachments}
                    </div>
                  )}
                  {phone && (
                    <header className="workbench-phone-heading">
                      <IconButton size="lg" label={SHELL_COPY.backToSessions} icon={ChevronLeftGlyph} onClick={toPhoneList} />
                      <h1>{SHELL_COPY.newSession}</h1>
                      {draftSummary}
                      <IconButton size="lg" label={SHELL_COPY.search} icon={SearchGlyph} onClick={openSearch} />
                      {access.scopes.has('view') && <UsageEntry />}
                      <ShellUpdateCheck shell={shell} />
                    </header>
                  )}
                  {/* Going on with another Harness: what was said so far stays in view, over a line that says where it goes next. */}
                  {moving && (
                    <MovingThread>
                      <>
                        <MoveHistory
                          // Read again once the Harness being left has written its note: it is the record's last reply.
                          key={movingFork?.brief ? `brief:${movingFork.upToMessageId}` : 'record'}
                          fork={{ taskId: moving.taskId, moved: { from: moving.from } }}
                          harnesses={catalog?.harnesses}
                          to={moving.to}
                          pending
                          onCancel={() => {
                            submission.setFork(null)
                            choose(moving.taskId)
                          }}
                        />
                        <MoveCarry
                          sourceId={moving.taskId}
                          from={moving.fromName}
                          brief={movingFork?.brief === true}
                          canWrite={access.scopes.has('run')}
                          onRecord={upToMessageId => {
                            if (movingFork) submission.setFork({ ...movingFork, upToMessageId, brief: undefined } as typeof movingFork)
                          }}
                          onBrief={messageId => {
                            if (movingFork) submission.setFork({ ...movingFork, upToMessageId: messageId, brief: true })
                          }}
                        />
                      </>
                    </MovingThread>
                  )}
                  {/* The whole column of words keeps the background clear: notices, counts and the history entry too. */}
                  <div className="code-home-input" data-backdrop-clear="">
                    {usesDemoModel(snapshot, choice.harnessId, choice.model?.providerId) && (
                      <p className="workbench-home-demo" data-backdrop-clear="">
                        <StatusPill tone="warn">{SHELL_COPY.demoModel}</StatusPill>
                      </p>
                    )}
                    <ConnectionBanners shell={shell} />
                    <div className="code-home-notices">
                      <SetupNotices shell={homeShell} />
                      {listsFoundHarnesses(catalog, snapshot.tasks.length, shell.access) && <FoundHarnessesCard onRecheck={refresh} />}
                    </div>
                    <div className="workbench-home-composer" data-backdrop-clear="">
                      {/* On a phone the input keeps to the foot, and the count line stands over it. */}
                      {phone && <StartCounts counts={counts} onGroup={shell.askBoardGroup} />}
                      <SendingBubble shell={homeShell} />
                      <SessionComposer shell={shell} home />
                    </div>
                    {!phone && <StartCounts counts={counts} onGroup={shell.askBoardGroup} />}
                    {!submission.fork && !shell.creator && (
                      <div className="workbench-home-history">
                        <HistoryImportEntry snapshot={snapshot} workspaceId={choice.workspaceId} phone={phone} onOpen={choose} />
                      </div>
                    )}
                  </div>
                </section>
              )}
              {/* 看板 covers 对话 between the title row and the status bar; 对话 stays mounted, hidden and inert, under it. */}
              {/* A phone's 看板 keeps the switch over it, where the list had it. */}
              {board && phone && (
                <div className="phone-view-switch board-phone-switch">
                  <ViewSwitch value={shell.preferences.workView} waiting={counts.attention} />
                </div>
              )}
              {(shell.keepBoard || shell.itemReturn) && <BoardSurface shell={shell} />}
              {hasConnectionStrip && <WorkbenchConnection shell={shell} inert={drawer.open || !!settings} />}
              {route.entry === 'agents' && <AgentsPage shell={shell} />}
              {route.entry === 'apps' && <AppsPage shell={shell} />}
              {shell.showCreatorDraft && <SessionDraftEntry shell={shell} creator />}
              {settings && (
                <Modal label={SHELL_COPY.settings} variant="page" className="settings-overlay" onClose={closeSettings}>
                  <SettingsPage
                    snapshot={snapshot}
                    access={access}
                    onClose={closeSettings}
                    section={settings.section}
                    initialPluginId={settings.pluginId}
                    {...(shell.canBrowseMarketplace ? { onMarketplace: shell.openMarketplace } : {})}
                    {...(shell.canAddPlugins ? { onAddPlugin: shell.openAddPlugin } : {})}
                    {...(shell.creatorAvailable ? { onCreatePlugin: shell.openCreator } : {})}
                    {...(shell.creatorBlockedReason ? { creatorBlockedReason: shell.creatorBlockedReason } : {})}
                    {...(settings.agent ? { initialAgent: settings.agent } : {})}
                    onSection={openSettings}
                    onOpenSession={id => choose(id, closeSettings)}
                    onOpenApp={app => {
                      closeSettings()
                      setRoute({ entry: 'apps', app })
                    }}
                    onChanged={() => {
                      void refresh()
                    }}
                  />
                </Modal>
              )}
              {shell.marketplaceVisited && (
                <div
                  ref={shell.marketFocus}
                  className="marketplace-workspace"
                  role="main"
                  aria-label={shell.canBrowseMarketplace ? SHELL_COPY.marketplace : SHELL_COPY.addPlugin}
                  hidden={!shell.marketplace}
                  inert={!shell.marketplace || drawer.open}
                  tabIndex={-1}>
                  {shell.marketplaceBackInPage && (
                    <div className="marketplace-workspace-controls">
                      <IconButton label={SHELL_COPY.back} icon={ChevronLeftGlyph} onClick={shell.dismissMarketplace} />
                    </div>
                  )}
                  <PluginMarketplace
                    key={`${snapshot.instanceId}:${snapshot.device.id}:${canEditPluginPackages(snapshot, access)}`}
                    open={shell.marketplace}
                    connected={connection === 'connected'}
                    snapshot={snapshot}
                    access={access}
                    showBundled={shell.canBrowseMarketplace}
                    source={shell.marketplaceSource}
                    onSourceChange={shell.setMarketplaceSource}
                    onManage={shell.manageMarketPlugin}
                    {...(shell.creatorAvailable ? { onCreatePlugin: shell.openCreator } : {})}
                    creatorBlockedReason={shell.creatorBlockedReason}
                  />
                </div>
              )}
              {phone && phoneReview.present && phoneReview.target && phoneReview.summary && (
                <PhoneReview
                  key={phoneReview.summary.id}
                  target={phoneReview.target}
                  summary={phoneReview.summary}
                  snapshot={snapshot}
                  canRun={access.scopes.has('run')}
                  canDeliver={catalog?.features?.gitDelivery === true && access.scopes.has('view') && phoneReview.summary.mode !== 'chat'}
                  offline={connection === 'reconnecting' || connection === 'offline'}
                  leaving={phoneReview.leaving}
                  progress={phoneReview.progress}
                  onProgress={phoneReview.remember}
                  onTarget={phoneReview.setTarget}
                  onClose={phoneReview.close}
                />
              )}
              {phone && <PhoneTabBar shell={shell} />}
              {entries.includes('agents') && <ProfileLayer shell={shell} />}
              {phone && <DraftFilePanel shell={shell} />}
              <Overlays shell={shell} />
              <EditLeaveGuard />
              <EditorChooser />
            </div>
          </LiveChanges>
        </LayerHistory>
      </DetachedPlace.Provider>
    </FileOpenContext.Provider>
  )
}
