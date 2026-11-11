import { dropAttachments } from '../composer/AttachmentDrafts.tsx'
import { FileOpenContext } from '../preview/fileContext.ts'
import { ChevronLeft } from 'lucide-react'
import { SIDEBAR_MIN } from './panelLayout.ts'
import { keepAwakeLine } from '../core/shellLifecycle.ts'
import { openLayer } from '../hooks/backStack.ts'
import { NewSessionSheet } from '../newSession/NewSessionSheet.tsx'
import { worktreeProject } from '../composerChoice.ts'
import { PhoneSessionList } from '../components/PhoneSessionList.tsx'
import { Sidebar } from '../components/Sidebar.tsx'
import { ConversationHeader } from './ConversationHeader.tsx'
import { Button, IconButton, LiveChanges, LayerHistory, ResizeHandle, Scrim } from '@latch/ui'
import { ConnectionBanners } from './ConnectionBanners.tsx'
import { PhoneTabBar } from './PhoneTabBar.tsx'
import { TitleBar } from './TitleBar.tsx'
import { RIGHT_PANEL_MIN, rightPanelMax } from './panelLayout.ts'
import { SettingsPage } from '../settings/SettingsPage.tsx'
import { AgentsPage } from '../agents/AgentsPage.tsx'
import { waitingCount } from '../sessions.ts'
import { ConversationView } from './ConversationView.tsx'
import { Overlays } from './Overlays.tsx'
import { RightPanel } from './RightPanel.tsx'
import { SendingBubble, SetupNotices, SheetComposer } from './SessionComposers.tsx'
import { useShellLayout } from './useShellLayout.tsx'
import { ParticleField } from './ParticleField.tsx'
import type { AppSnapshot } from '@latch/protocol'
import type { useHarness } from '../core/useHarness.ts'

type Harness = ReturnType<typeof useHarness>

/** The signed-in shell. Mounted once per device identity, so per-device state starts fresh. */
export function AppShell({ harness, snapshot }: { harness: Harness; snapshot: AppSnapshot }) {
  const shell = useShellLayout({ harness, snapshot })
  const {
    phoneSession,
    folding,
    route,
    setRoute,
    appShell,
    sidebarColumn,
    resetInspector,
    titleSlot,
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
    sendDraft,
    unread,
    sessionMenu,
    gate,
    noteComposer,
    conversationEpoch,
    viewport,
    phone,
    drawerMode,
    windowWidth,
    sidebarDrag,
    setSidebarDrag,
    infoPage,
    newSheet,
    setNewSheet,
    phoneSearching,
    setPhoneSearching,
    popping,
    pushed,
    inspectorDrag,
    sidebarSnapping,
    navigation,
    main,
    sheetComposerRef,
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
    canBrowseFiles,
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
    openProjectSettings,
    manageProviders,
    createProject,
    projectAsk,
    createProjectAndStart,
    newChoicesLocked,
    sheetCanStart,
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
    demo,
    startIn,
    browseFiles,
    workspaceForFiles,
    column,
    page,
    closeInfoPage,
    changesOpen,
    deliveryOpen,
    selectedId,
    resync,
    connection,
    entries,
    goEntry,
    hostProblem,
  } = shell
  return (
    <FileOpenContext.Provider value={catalog?.features?.filePreview ? openFile : undefined}>
      <LayerHistory value={phone ? openLayer : null}>
        <LiveChanges value={harness.resyncs}>
          <div
            ref={appShell}
            className={`app-shell viewport-${viewport}`}
            data-viewport={viewport}
            data-connection={connection}
            data-entry={route.entry}
            data-folding={folding ? '' : undefined}
            data-sidebar={sidebarColumn ? (sidebarCollapsed ? 'collapsed' : 'open') : undefined}
            data-inspector={columnOpen ? (placement?.kind === 'sheet' ? 'sheet' : 'open') : undefined}
            data-resizing={(sidebarDrag !== null && !sidebarSnapping) || inspectorDrag ? '' : undefined}
            style={{
              '--sidebar-width': sidebarColumn && !sidebarCollapsed ? `${sidebarWidth}px` : '0px',
              '--sidebar-open-width': `${sidebarWidth}px`,
              '--inspector-width': columnOpen && placement?.kind === 'column' ? `${inspectorWidth}px` : '0px',
              '--inspector-open-width': `${inspectorWidth}px`,
            }}>
            {!phone && <ParticleField />}
            {!phone && <TitleBar shell={shell} />}
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
                data-covered={phoneSession && !popping ? '' : undefined}
                inert={(phoneSession && !popping) || route.entry !== 'sessions' || undefined}>
                <PhoneSessionList
                  snapshot={snapshot}
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
                />
              </section>
            ) : (
              <aside
                ref={navigation}
                id="session-navigation"
                className={`sidebar ${drawer.open ? 'is-open' : ''}`}
                inert={route.entry !== 'sessions' || undefined}
                aria-label="会话导航"
                role={drawerMode && drawer.open ? 'dialog' : undefined}
                aria-modal={drawerMode && drawer.open ? true : undefined}
                tabIndex={-1}>
                <Sidebar
                  snapshot={snapshot}
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
                  entries={entries}
                  onEntry={goEntry}
                  hostProblem={hostProblem}
                  onEditProject={owner ? openProjectSettings : undefined}
                  onProjectsChanged={() => {
                    void refresh()
                  }}
                  newActive={selectedId === null}
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
                  {...(lifecycle.view?.keepAwake.active ? { keepAwake: keepAwakeLine(lifecycle.view.keepAwake) } : {})}
                />
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
                  inert={route.entry !== 'sessions' || undefined}
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
                  {/* Under the panel's page the conversation cannot be reached until the page is closed. */}
                  <div className="workspace-view" inert={(pageMode && infoPage) || undefined}>
                    {phone && <ConversationHeader shell={shell} />}
                    {/* The conversation's paper: on phones it rises under the header on the ground. */}
                    <ConversationView shell={shell} />
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
                          <IconButton ref={infoBack} size="lg" label="返回" icon={ChevronLeft} onClick={closeInfoPage} />
                        ) : (
                          <Button ref={infoBack} variant="ghost" icon={ChevronLeft} onClick={closeInfoPage}>
                            返回对话
                          </Button>
                        )}
                        <div className="info-page-title">
                          <h2>
                            {changesOpen && !fileTabs.active
                              ? '改动'
                              : deliveryOpen && !fileTabs.active
                                ? '交付'
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
                        <RightPanel shell={shell} />
                      </div>
                    </section>
                  )}
                </main>
              )}
              {placement !== null && placement.kind !== 'page' && (
                <aside className="inspector-column" aria-label="侧边面板" inert={!columnOpen || route.entry !== 'sessions' || undefined}>
                  {column.present && (
                    <div className="inspector-column-inner">
                      <RightPanel shell={shell} />
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
                  max={rightPanelMax(windowWidth)}
                  onResize={resizeInspector}
                  onReset={resetInspector}
                />
              )}
            </LiveChanges>
            {route.entry === 'agents' && <AgentsPage shell={shell} />}
            {route.entry === 'settings' && (
              <SettingsPage
                snapshot={snapshot}
                access={access}
                entry={route.entry}
                waiting={waitingCount(snapshot)}
                onBack={() => {
                  goEntry('sessions')
                }}
                section={route.section}
                initialProjectId={route.projectId}
                {...(route.agent ? { initialAgent: route.agent } : {})}
                titleSlot={titleSlot}
                onSection={section => {
                  if (section) openSettings(section)
                  else setRoute({ entry: route.entry })
                }}
                onOpenSession={id => {
                  choose(id)
                }}
                onChanged={() => {
                  void refresh()
                }}
              />
            )}
            {phone && <PhoneTabBar shell={shell} />}
            {phone && (
              <NewSessionSheet
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
                onManageProviders={manageProviders}
                onProvidersChanged={() => {
                  void refresh()
                }}
                onHarnessChanged={refresh}
                onManageWorkspaces={owner ? () => openSettings('workspaces') : undefined}
                onCreateProject={createProject}
                projectAsk={projectAsk}
                worktree={(() => {
                  const project = worktreeProject(snapshot.catalog, choice, submission.fork !== null)
                  return project && { project, picked: submission.worktree, onPick: submission.setWorktree }
                })()}
                composer={
                  <>
                    <SendingBubble shell={shell} />
                    <SheetComposer shell={shell} />
                  </>
                }
                setup={<SetupNotices shell={shell} />}
                demo={demo}
              />
            )}
            <Overlays shell={shell} />
          </div>
        </LiveChanges>
      </LayerHistory>
    </FileOpenContext.Provider>
  )
}
