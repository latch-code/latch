import { DETACHED, DetachedPlace } from '../panel/terminal/fills.ts'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { dropAttachments } from '../composer/AttachmentDrafts.tsx'
import { conversationShown } from '../composer/useArmed.ts'
import { overlayDismissed } from '../escapeGrace.ts'
import { useStableCallback } from '../hooks/useStableCallback.ts'
import { useVisualViewportFit } from '../hooks/useVisualViewportFit.ts'
import { FileOpenContext } from '../preview/fileContext.ts'

import { SIDEBAR_MIN } from './panelLayout.ts'
import { keepAwakeLine } from '../core/shellLifecycle.ts'
import { openLayer } from '../hooks/backStack.ts'
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
  SettingsGlyph,
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
import { ShellNewAgent, SpaceSwitch, shellOverview, shellSpaces } from './SpaceNav.tsx'
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
import { OverviewGlyph } from '@latch/ui'
import { WorkOverview, type WorkOverviewHandle } from './WorkOverview.tsx'
import type { WorkbenchReviewMemory } from './WorkbenchReviewQueue.tsx'
import { HomeFocusSummary } from './HomeFocusSummary.tsx'
import { HOME_FOCUS_LAYER, useHomeFocus } from './useHomeFocus.ts'
import { workGroups } from './workOverview.ts'
import { PhoneComputer, SidebarComputer, TabletRail, WorkbenchConnection, WorkbenchNav } from './WorkbenchNav.tsx'
import { UsageEntry } from '../usage/UsageEntry.tsx'
import { ShellUpdateCheck } from './UpdateCheck.tsx'
import { LayoutSwitch } from './LayoutSwitch.tsx'
import { WorkbenchSessions } from './WorkbenchSessions.tsx'
import { useWorkbenchDelivery } from './useWorkbenchEvidence.ts'
import { backdropLevel } from '../preferences.ts'
import type { AppSnapshot } from '@latch/protocol'
import type { useHarness } from '../core/useHarness.ts'

type Harness = ReturnType<typeof useHarness>

/** The signed-in shell. Mounted once per device identity, so per-device state starts fresh. */
export function AppShell({ harness, snapshot }: { harness: Harness; snapshot: AppSnapshot }) {
  const focus = useHomeFocus()
  const shell = useShellLayout({
    harness,
    snapshot,
    homeFocus: focus.active,
    onHomeShortcut: focus.enter,
    onOpenHomeFiles: focus.reset,
  })
  const homeQueue = useRef<WorkOverviewHandle>(null)
  const homeReviewMemory = useRef<WorkbenchReviewMemory>({ selection: undefined, open: false })
  const focusWasVisible = useRef(false)
  const {
    phoneSession,
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
    filesOpen,
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
    changesOpen,
    deliveryOpen,
    browserOpen,
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
  const overview = route.entry === 'sessions' && route.overview === true
  const allSessions = route.entry === 'sessions' && route.allSessions === true
  const covered = overview || allSessions
  const triage = shell.preferences.workbenchLayout === 'triage'
  const panes = workbenchPanes(shell)
  const homeShell = { ...shell, ...shell.homeComposerState }
  const evidence = useWorkbenchDelivery(
    listed,
    connection,
    overview
      || (triage && !phone && !drawerMode && !sidebarCollapsed && !allSessions && route.entry === 'sessions' && shell.space === 'code'),
  )
  const work = {
    snapshot: listed,
    layout: shell.preferences.workbenchLayout,
    connection,
    now,
    onSelect: choose,
    onNew: startNew,
    onSearch: openSearch,
    isUnread: unread,
    cancelling: stopping,
    selectedId,
    evidence,
    shell,
  }
  const canFocusHome = overview && homeShell.gate.kind === 'open' && !settings
  const homeFocused = shell.homeFocused && canFocusHome
  const hasConnectionStrip = !phone && route.entry === 'sessions'
  const { reset: resetHomeFocus } = focus
  useLayoutEffect(() => {
    const reveal = overview && focusWasVisible.current && !homeFocused
    focusWasVisible.current = homeFocused
    if (reveal) {
      conversationShown()
      overlayDismissed()
    }
  }, [homeFocused, overview])
  useEffect(() => {
    if (focus.active && !canFocusHome) resetHomeFocus()
  }, [canFocusHome, focus.active, resetHomeFocus])
  useVisualViewportFit(focus.frame, phone && homeFocused)
  // The right panel's strip starts where the session's head ends, so the head's foot runs on as one line.
  const headLayout = shell.preferences.workbenchLayout
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
  }, [appShell, main, phone, selectedId, headLayout])
  const closeHomeFocus = useStableCallback((restoreInput = true) => {
    focus.leave()
    if (!restoreInput) return
    if (phone) shell.homeComposerRef.current?.blur()
    else shell.homeComposerRef.current?.focus({ preventScroll: true })
  })
  useEffect(() => {
    if (!homeFocused) return undefined
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape'
        || event.defaultPrevented
        || event.repeat
        || event.isComposing
        || event.keyCode === 229
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
        || document.querySelector(HOME_FOCUS_LAYER)
      )
        return
      event.preventDefault()
      closeHomeFocus()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [homeFocused, closeHomeFocus])
  const visibleConversation =
    route.entry === 'sessions' && selectedId !== null && !covered && !settings && !(pageMode && infoPage) && !phoneReview.present
  const level = backdropLevel(shell.preferences, phone)
  const backdropEnabled = level !== 'off' && shell.space === 'code' && !settings
  const homeBackdrop = backdropEnabled && overview
  const homeGroups = useMemo(
    () => (homeFocused || homeBackdrop ? workGroups(listed.tasks, stopping) : undefined),
    [homeFocused, homeBackdrop, listed.tasks, stopping],
  )
  const focusGroups = homeFocused ? homeGroups : undefined
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
              data-workbench-layout={shell.preferences.workbenchLayout}
              data-overview={overview ? '' : undefined}
              data-home-focus={homeFocused ? '' : undefined}
              data-connection-strip={hasConnectionStrip ? '' : undefined}
              data-all-sessions={allSessions ? '' : undefined}
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
              {!phone && (triage ? <WorkbenchNav shell={shell} /> : <TitleBar shell={shell} />)}
              {/* One switch for both layouts, at the end of the window's top row: it stays mounted through a change. */}
              {!phone && <LayoutSwitch className="shell-layout-switch" value={shell.preferences.workbenchLayout} inert={homeFocused} />}
              {!triage && viewport === 'tablet' && <TabletRail shell={shell} />}
              <Scrim
                open={drawerMode && drawer.open}
                label="关闭会话列表"
                className="drawer-backdrop"
                onDismiss={() => {
                  drawer.setOpen(false)
                }}
              />
              {phone ? (
                <section
                  id="session-navigation"
                  className="phone-list"
                  aria-label="会话"
                  data-covered={(phoneSession && !popping && !covered) || (phoneReview.present && !phoneReview.leaving) ? '' : undefined}
                  inert={
                    (phoneSession && !popping && !covered)
                    || (phoneReview.present && !phoneReview.leaving)
                    || route.entry !== 'sessions'
                    || overview
                    || undefined
                  }>
                  <div className="phone-overview-link">
                    <Button variant="ghost" icon={OverviewGlyph} onClick={shell.openOverview}>
                      返回总览
                    </Button>
                    <LayoutSwitch value={shell.preferences.workbenchLayout} />
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
                  inert={route.entry !== 'sessions' || homeFocused || undefined}
                  aria-label="会话导航"
                  role={drawerMode && drawer.open ? 'dialog' : undefined}
                  aria-modal={drawerMode && drawer.open ? true : undefined}
                  tabIndex={-1}>
                  {triage && shell.space === 'agents' && entries.includes('agents') && !drawerMode ? (
                    // 顶栏 layout, in a topic of 我的 Agent: the queue of people, as on 我的 Agent's own pages.
                    <div className="triage-sidebar agents-rail" data-space="agents">
                      <AgentsSpaceList shell={shell} rail />
                    </div>
                  ) : triage && shell.space === 'code' && !drawerMode ? (
                    <div className="triage-sidebar">
                      <WorkOverview {...work} compact />
                      <Button variant="ghost" onClick={shell.openAllSessions}>
                        全部会话与项目
                      </Button>
                    </div>
                  ) : (
                    <>
                      <Sidebar
                        projectTree={!triage}
                        overview={shellOverview(shell)}
                        onSchedules={
                          catalog?.features?.automations ? () => shell.openMyAgent({ id: 'general', tab: 'schedules' }) : undefined
                        }
                        computerAtFoot={!triage && viewport !== 'tablet' && access.scopes.has('view')}
                        {...(!triage && viewport !== 'tablet' && access.scopes.has('view') ? { quota: <UsageEntry /> } : {})}
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
                    </>
                  )}
                </aside>
              )}
              {sidebarColumn && (
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
                    setSidebarShut(!sidebarCollapsed)
                  }}
                />
              )}
              <LiveChanges value={conversationEpoch}>
                {(!phone || phoneSession) && (
                  <main
                    ref={main}
                    inert={route.entry !== 'sessions' || covered || undefined}
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
                    data-backdrop-hidden={visibleConversation ? undefined : ''}
                    data-info-page={pageMode && infoPage ? '' : undefined}
                    data-pushed={phone && pushed ? '' : undefined}
                    data-leaving={phone && popping ? '' : undefined}>
                    {attachmentDraft.dragging && !overview && (
                      <div className="attachment-drop-mask" role="status">
                        松开以添加到这条消息
                      </div>
                    )}
                    {/* Under the panel's page the conversation cannot be reached until the page is closed. */}
                    <div className="workspace-view" inert={(pageMode && infoPage) || undefined}>
                      <ConversationHeader shell={shell} />
                      {/* The conversation's paper: on phones it rises under the header on the ground. */}
                      <ConversationView shell={shell} visible={visibleConversation} backdrop={backdropEnabled ? level : 'off'} />
                    </div>
                    {page.present && (summary || filesVisible) && (
                      <section
                        ref={infoPageRef}
                        className="info-page"
                        data-leaving={page.leaving ? '' : undefined}
                        aria-label="侧边面板"
                        onKeyDown={event => {
                          if (event.key === 'Escape' && !event.defaultPrevented) {
                            event.preventDefault()
                            closeInfoPage()
                          }
                        }}>
                        <header className="info-page-head">
                          {phone ? (
                            <IconButton ref={infoBack} size="lg" label="返回" icon={ChevronLeftGlyph} onClick={closeInfoPage} />
                          ) : (
                            <Button ref={infoBack} variant="ghost" icon={ChevronLeftGlyph} onClick={closeInfoPage}>
                              返回对话
                            </Button>
                          )}
                          <div className="info-page-title">
                            <h2>
                              {changesOpen && !fileTabs.active
                                ? '改动'
                                : deliveryOpen && !fileTabs.active
                                  ? '交付'
                                  : browserOpen && !fileTabs.active
                                    ? '浏览器'
                                    : fileTabs.active?.target.view === 'changes'
                                      ? '代码审阅'
                                      : fileTabs.active
                                        ? '文件预览'
                                        : filesOpen
                                          ? '文件'
                                          : '面板'}
                            </h2>
                            <span>{summary?.title || workspaceForFiles?.name || '项目文件'}</span>
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
                    aria-label="侧边面板"
                    inert={!columnOpen || route.entry !== 'sessions' || homeFocused || (covered && !shell.homeInspectorOpen) || undefined}
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
                    label="调整侧边面板宽度"
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
              {overview && (
                <section
                  className={homeBackdrop ? 'workbench-home code-home ui-backdrop-host' : 'workbench-home code-home'}
                  aria-label="总览"
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
                      level={level}
                      running={connection === 'connected' ? (homeGroups?.[1]?.tasks.length ?? 0) : 0}
                      focus={homeFocused}
                      focusTarget={focus.composer}
                      fixed={homeFocused}
                    />
                  )}
                  {/* Files dropped anywhere on the home go to its input, as they go to the open session's elsewhere. */}
                  {attachmentDraft.dragging && (
                    <div className="attachment-drop-mask" role="status">
                      松开以添加到这条消息
                    </div>
                  )}
                  {phone && (
                    <header className="workbench-phone-heading" inert={homeFocused || undefined}>
                      {triage && shellSpaces(shell) ? <SpaceSwitch {...shellSpaces(shell)!} /> : <h1>Code</h1>}
                      {!triage && <IconButton label="搜索" icon={SearchGlyph} onClick={openSearch} />}
                      {!triage && access.scopes.has('view') && <UsageEntry />}
                      {!triage && <ShellUpdateCheck shell={shell} />}
                      <LayoutSwitch value={shell.preferences.workbenchLayout} />
                    </header>
                  )}
                  {phone && (
                    <nav className="workbench-phone-code-nav" aria-label="会话导航" inert={homeFocused || undefined}>
                      <Button variant="ghost" onClick={shell.openAllSessions}>
                        全部会话
                      </Button>
                      {triage && (
                        <Button variant="ghost" onClick={openSearch}>
                          搜索
                        </Button>
                      )}
                      {triage && (
                        <div className="workbench-phone-utilities">
                          {/* Beside 设置 here: the 顶栏 heading holds the space switch, and 320px has no room for both. */}
                          {access.scopes.has('view') && <UsageEntry />}
                          {entries.includes('settings') && (
                            <IconButton label="设置" icon={SettingsGlyph} onClick={() => goEntry('settings')} />
                          )}
                          <ShellUpdateCheck shell={shell} />
                        </div>
                      )}
                    </nav>
                  )}
                  <div ref={focus.slot} className="code-home-input">
                    <div
                      ref={focus.frame}
                      className="home-focus-frame"
                      data-active={homeFocused ? '' : undefined}
                      role={homeFocused ? 'region' : undefined}
                      aria-label={homeFocused ? '专注输入' : undefined}
                      onPointerDown={event => {
                        // A dismissal must not leave the pointer over a newly revealed decision.
                        if (homeFocused && event.target === event.currentTarget) event.preventDefault()
                      }}
                      onClick={event => {
                        if (homeFocused && event.target === event.currentTarget) closeHomeFocus()
                      }}
                      onBlur={event => {
                        const frame = event.currentTarget
                        if (!homeFocused || frame.contains(event.relatedTarget) || homeShell.submission.draft.trim()) return
                        requestAnimationFrame(() => {
                          if (document.hasFocus() && !frame.contains(document.activeElement) && !document.querySelector(HOME_FOCUS_LAYER))
                            closeHomeFocus(false)
                        })
                      }}>
                      <div className="home-focus-input">
                        {usesDemoModel(snapshot, choice.harnessId, choice.model?.providerId) && (
                          <p className="workbench-home-demo">
                            <StatusPill tone="warn">演示模型</StatusPill>
                          </p>
                        )}
                        <ConnectionBanners shell={shell} />
                        <div ref={focus.composer} className="workbench-home-composer" data-backdrop-clear="">
                          <SendingBubble shell={homeShell} />
                          <SessionComposer
                            shell={shell}
                            home
                            {...(canFocusHome && {
                              homeFocus: {
                                engage: focus.enter,
                                ...(homeFocused && { close: () => closeHomeFocus(), onSend: () => closeHomeFocus(false) }),
                              },
                            })}
                          />
                        </div>
                      </div>
                      {focusGroups && (
                        <HomeFocusSummary
                          attention={focusGroups[0]!.tasks}
                          running={focusGroups[1]!.tasks.length}
                          connected={connection === 'connected'}
                          onAttention={id => {
                            closeHomeFocus(false)
                            homeQueue.current?.focusAttention(id)
                          }}
                          onClose={() => closeHomeFocus()}
                        />
                      )}
                    </div>
                  </div>
                  <div className="code-home-queue" inert={homeFocused || undefined} data-backdrop-hidden={homeFocused ? '' : undefined}>
                    <div className="code-home-notices">
                      <SetupNotices shell={homeShell} />
                      {listsFoundHarnesses(catalog, snapshot.tasks.length, shell.access) && <FoundHarnessesCard onRecheck={refresh} />}
                    </div>
                    {!submission.fork && work.snapshot.tasks.some(task => !task.archived) && (
                      <div className="workbench-home-history">
                        <HistoryImportEntry snapshot={snapshot} workspaceId={choice.workspaceId} phone={phone} onOpen={choose} />
                      </div>
                    )}
                    <WorkOverview ref={homeQueue} reviewMemory={homeReviewMemory} {...work} />
                  </div>
                </section>
              )}
              {allSessions && !phone && <WorkbenchSessions shell={shell} snapshot={listed} />}
              {hasConnectionStrip && <WorkbenchConnection shell={shell} inert={homeFocused || drawer.open || !!settings} />}
              {route.entry === 'agents' && <AgentsPage shell={shell} />}
              {route.entry === 'apps' && <AppsPage shell={shell} />}
              {settings && (
                <Modal label="设置" variant="page" className="settings-overlay" onClose={closeSettings}>
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
