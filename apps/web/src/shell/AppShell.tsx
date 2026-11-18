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
import { usesDemoModel, listsFoundHarnesses } from '../composerChoice.ts'
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
import { AgentsPage } from '../agents/AgentsPage.tsx'
import { ProfileLayer } from '../agents/AgentProfile.tsx'
import { AppsPage } from '../plugin-pages/AppsPage.tsx'
import { AgentsSpaceList } from '../agents/AgentsSpaceList.tsx'
import { ShellNewAgent, shellOverview, shellSpaces } from './SpaceNav.tsx'
import { ConversationView } from './ConversationView.tsx'
import { Overlays } from './Overlays.tsx'
import { EditLeaveGuard } from '../preview/EditLeaveGuard.tsx'
import { EditorChooser } from '../components/OpenInEditor.tsx'
import { RightPanel } from './RightPanel.tsx'
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
    owner,
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
    openProjectSettings,
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
  const phoneSession = selectedPhoneSession || (phone && !!pendingStart)
  const pendingStartId = pendingStart ? pendingStart.submission.requestId : undefined
  const homeShell = { ...shell, ...shell.homeComposerState }
  const panes = workbenchPanes(shell)
  const counts = useMemo(() => boardCounts(listed.tasks, listed.items), [listed.tasks, listed.items])
  const hasConnectionStrip = !phone && route.entry === 'sessions'
  useLayoutEffect(() => {
    if (!pendingStartId || settings || document.activeElement !== document.body) return
    main.current?.querySelector<HTMLElement>(phone ? '.topbar-back' : '.transcript')?.focus({ preventScroll: true })
  }, [main, pendingStartId, phone, settings])
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
  useBackLayer(phone && startRoute, toPhoneList)
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
  const backdropEnabled = level !== 'off' && shell.space === 'code' && !settings
  const homeBackdrop = backdropEnabled && start
  return (
    <FileOpenContext.Provider value={catalog?.features?.filePreview ? openFile : undefined}>
      <DetachedPlace.Provider value={catalog?.features?.terminal === true && !phone ? DETACHED : undefined}>
        <LayerHistory value={phone ? openLayer : null}>
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
              data-inspector={columnOpen ? (placement?.kind === 'sheet' ? 'sheet' : 'open') : undefined}
              data-home-inspector={shell.homeInspectorOpen ? '' : undefined}
              data-terminal-dock={shell.terminalOpen ? '' : undefined}
              data-resizing={(sidebarDrag !== null && !sidebarSnapping) || inspectorDrag || shell.dockDrag ? '' : undefined}
              style={{
                '--sidebar-width': sidebarColumn && !sidebarCollapsed ? `${sidebarWidth}px` : '0px',
                '--sidebar-open-width': `${sidebarWidth}px`,
                '--inspector-width': columnOpen && placement?.kind === 'column' ? `${inspectorWidth}px` : '0px',
                '--inspector-open-width': `${inspectorWidth}px`,
                '--dock-height': shell.terminalOpen ? `${shell.dockHeight}px` : '0px',
                '--workbench-pane-count': Number(panes.left) + Number(panes.terminal) + Number(panes.right),
              }}>
              {!phone && <TitleBar shell={shell} />}
              {/* One switch for both views, at the end of the window's top row: it stays mounted through a change. */}
              {!phone && <ViewSwitch className="shell-view-switch" icons value={shell.preferences.workView} waiting={counts.attention} />}
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
                    onNewIn={startIn}
                    onEditProject={owner ? openProjectSettings : undefined}
                    onProjectsChanged={() => {
                      void refresh()
                    }}
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
                  inert={route.entry !== 'sessions' || board || undefined}
                  aria-label={SHELL_COPY.sessionNavigation}
                  role={drawerMode && drawer.open ? 'dialog' : undefined}
                  aria-modal={drawerMode && drawer.open ? true : undefined}
                  tabIndex={-1}>
                  <Sidebar
                    projectTree
                    overview={shellOverview(shell)}
                    onSchedules={catalog?.features?.automations ? () => shell.openMyAgent({ id: 'general', tab: 'schedules' }) : undefined}
                    computerAtFoot={viewport !== 'tablet' && access.scopes.has('view')}
                    {...(viewport !== 'tablet' && access.scopes.has('view') ? { quota: <UsageEntry /> } : {})}
                    update={<ShellUpdateCheck shell={shell} />}
                    snapshot={listed}
                    archiveBatch={archiveBatch}
                    archiveUndo={archiveUndo}
                    selectedId={selectedId}
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
                    onEditProject={owner ? openProjectSettings : undefined}
                    onProjectsChanged={() => {
                      void refresh()
                    }}
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
              {start && (
                <section
                  className={homeBackdrop ? 'workbench-home code-home ui-backdrop-host' : 'workbench-home code-home'}
                  aria-label={SHELL_COPY.newSession}
                  onDragEnter={event => {
                    if (
                      catalog?.features?.attachments === true
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
                    if (catalog?.features?.attachments === true && homeShell.gate.kind === 'open') dropAttachments(event, attachmentDraft)
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
                      <IconButton size="lg" label={SHELL_COPY.search} icon={SearchGlyph} onClick={openSearch} />
                      {access.scopes.has('view') && <UsageEntry />}
                      <ShellUpdateCheck shell={shell} />
                    </header>
                  )}
                  <div className="code-home-input">
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
                    {!submission.fork && (
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
              {(board || shell.itemReturn) && <BoardSurface shell={shell} />}
              {hasConnectionStrip && <WorkbenchConnection shell={shell} inert={drawer.open || !!settings} />}
              {route.entry === 'agents' && <AgentsPage shell={shell} />}
              {route.entry === 'apps' && <AppsPage shell={shell} />}
              {settings && (
                <Modal label={SHELL_COPY.settings} variant="page" className="settings-overlay" onClose={closeSettings}>
                  <SettingsPage
                    snapshot={snapshot}
                    access={access}
                    onClose={closeSettings}
                    section={settings.section}
                    initialProjectId={settings.projectId}
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
              {phone && phoneReview.present && phoneReview.target && phoneReview.summary && (
                <PhoneReview
                  target={phoneReview.target}
                  summary={phoneReview.summary}
                  snapshot={snapshot}
                  canRun={access.scopes.has('run')}
                  canDeliver={catalog?.features?.gitDelivery === true && access.scopes.has('view') && phoneReview.summary.mode !== 'chat'}
                  offline={connection === 'reconnecting' || connection === 'offline'}
                  leaving={phoneReview.leaving}
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
