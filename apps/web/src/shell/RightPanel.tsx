import { fileContextKey } from '../preview/fileContext.ts'
import { readsProjectFiles } from '@latch/protocol'
import { ProfileSlot } from '../agents/AgentProfile.tsx'
import { SessionPanels } from '../components/SessionPanels.tsx'
import { harnessName } from '../composerChoice.ts'
import { ChangesPanel } from '../panel/changes/ChangesPanel.tsx'
import type { useStagingWrites } from '../panel/changes/useStaging.ts'
import { AppDraftEntry } from '../plugin-pages/AppDraftEntry.tsx'
import { DeliveryPanel } from '../panel/delivery/DeliveryPanel.tsx'
import { BrowserPanel } from '../panel/browser/BrowserPanel.tsx'
import { BrowserTabList } from '../panel/browser/BrowserTabList.tsx'
import { errorMessage } from '../core/api.ts'
import { shellFolders } from '../core/shell.ts'
import { projectOf } from '../sessions.ts'
import { SessionFacts, SessionFolders, frozenFolders, liveFolder } from './SessionEnvironment.tsx'
import type { ShellState } from './useShellLayout.tsx'
import { SessionOverview } from './SessionOverview.tsx'

/** The session's panels: the same surfaces in the column beside the conversation and in the page over it. */
export function RightPanel({ shell, stagingWrites }: { shell: ShellState; stagingWrites: ReturnType<typeof useStagingWrites> }) {
  const {
    current,
    summary,
    composerRef,
    setToast,
    catalog,
    access,
    active,
    submission,
    quoteSnapshots,
    mentionChoice,
    choose,
    gate,
    sessionBlock,
    setInfoPage,
    panelToggle,
    fileContext,
    fileTabs,
    fileExpanded,
    setFileExpanded,
    filesOpen,
    filesVisible,
    canBrowseFiles,
    contextKey,
    pageMode,
    searchFiles,
    mentionFile,
    quoteFile,
    workspaceForFiles,
    snapshot,
    connection,
    canViewChanges,
    changesOpen,
    canDeliver,
    deliveryOpen,
    sessionTerminal,
    browserShell,
    browserProject,
    canBrowser,
    browserList,
    browserOpen,
    browserRequest,
    attachmentDraft,
    infoPage,
    openChangesTab,
    showSurface,
    launcherTakesFocus,
    closePanel,
    pluginPanel,
    changesTarget,
    changesTotals,
    setChangesTotals,
    openFile,
    level,
    phone,
    topHarness,
  } = shell
  if (!(summary || filesVisible)) return null
  if (shell.profileColumn && shell.profileShown) return <ProfileSlot owner={shell.profileShown.owner} />
  const folderShell = access.local && access.admin ? shellFolders() : null
  const project = summary ? (catalog ? projectOf(summary, catalog.workspaces) : undefined) : workspaceForFiles
  // The title row's crumb holds these facts; a session without one keeps them under the launcher.
  const noCrumb = !shell.project && (summary?.mode === 'chat' || !summary?.cwd)
  const canCompose = gate.kind === 'open' && !submission.pending && !submission.sending && sessionBlock === undefined
  const offline = connection === 'reconnecting' || connection === 'offline'
  /** Text for the draft, never sent from here; a page over the conversation steps aside so it can be read. */
  const compose = (text: string) => {
    submission.setDraft(previous => (previous.trim() ? `${previous}\n\n${text}` : text))
    if (pageMode) setInfoPage(false)
    composerRef.current?.focus()
  }
  const readsChanges = canViewChanges && readsProjectFiles(snapshot.device.dataScope)
  // The page pipeline is this Mac's: the desktop's admin device with all data.
  const pageDrafts =
    catalog?.features?.appPages === 1
    && catalog.features.pluginPackages === true
    && access.local
    && access.admin
    && snapshot.device.dataScope === 'all'
  return (
    <SessionPanels
      key={contextKey}
      {...(summary && shell.space === 'code' ? { overview: <SessionOverview shell={shell} summary={summary} /> } : {})}
      {...(summary && canViewChanges
        ? {
            changes: (
              <ChangesPanel
                summary={summary}
                messages={current?.messages ?? []}
                engine={topHarness ? harnessName(topHarness) : 'Harness'}
                local={access.local}
                canRun={access.scopes.has('run')}
                stagingWrites={stagingWrites}
                canRead={readsProjectFiles(snapshot.device.dataScope)}
                hostName={snapshot.hostName}
                phone={phone}
                offline={offline}
                {...(changesTarget ? { target: changesTarget } : {})}
                reviewNotes={catalog?.features?.reviewNotes === true}
                gitHunks={catalog?.features?.gitHunks === true}
                canQueue={catalog?.features?.queue === true}
                notesRevision={snapshot.reviewNotes?.find(counts => counts.sessionId === summary.id)?.revision ?? 0}
                onOpenFile={file => {
                  openFile({ sessionId: summary.id, reference: file.path, rootId: file.root })
                }}
                onOpenSession={choose}
                knownSession={id => snapshot.tasks.some(task => task.id === id)}
                onToast={(text, tone = 'ok') => {
                  setToast({ text, tone })
                }}
                onTotals={setChangesTotals}
                {...(canDeliver ? { onDeliver: () => showSurface({ kind: 'delivery' }) } : {})}
                {...(pageDrafts
                  ? {
                      appDraft: (
                        <AppDraftEntry
                          sessionId={summary.id}
                          revision={`${summary.updatedAt}:${summary.status}`}
                          onImported={() => {
                            setToast({ text: '已作为应用草稿导入', tone: 'ok' })
                            shell.openSettings('plugins')
                          }}
                          onError={text => {
                            setToast({ text, tone: 'error' })
                          }}
                        />
                      ),
                    }
                  : {})}
              />
            ),
          }
        : {})}
      changesOpen={changesOpen}
      {...(summary && canDeliver
        ? {
            delivery: (
              <DeliveryPanel
                key={summary.id}
                summary={summary}
                revision={current?.summary.id === summary.id ? current.sync?.revision : undefined}
                open={deliveryOpen && !fileTabs.active}
                canRun={access.scopes.has('run')}
                {...(snapshot.hostName ? { hostName: snapshot.hostName } : {})}
                offline={offline}
                phone={phone}
                onOpenFile={path => {
                  const root = summary.folders?.[0]?.id
                  if (readsChanges) openChangesTab({ scope: 'uncommitted', file: { path, ...(root ? { root } : {}) } })
                  else openFile({ sessionId: summary.id, reference: path, ...(root ? { rootId: root } : {}) })
                }}
                onCompose={canCompose ? compose : undefined}
              />
            ),
          }
        : {})}
      deliveryOpen={deliveryOpen}
      {...(summary && browserList
        ? {
            browser: (
              <BrowserTabList key={summary.id} sessionId={summary.id} shown={browserOpen && !fileTabs.active && (!pageMode || infoPage)} />
            ),
          }
        : summary && canBrowser && browserShell && browserProject
          ? {
              browser: (
                <BrowserPanel
                  key={summary.id}
                  shell={browserShell}
                  sessionId={summary.id}
                  projectId={browserProject.id}
                  deviceId={snapshot.device.id}
                  shown={browserOpen && !fileTabs.active && (!pageMode || infoPage)}
                  terminals={sessionTerminal}
                  request={browserRequest}
                  onCompose={canCompose ? compose : undefined}
                  onAttach={
                    canCompose && catalog?.features?.attachments === true
                      ? files => {
                          attachmentDraft.add(files)
                          composerRef.current?.focus()
                        }
                      : undefined
                  }
                />
              ),
            }
          : {})}
      browserOpen={browserOpen}
      {...(summary && (phone || noCrumb)
        ? {
            launcherNote: (
              <div className="crumb-body panel-launcher-facts">
                <SessionFolders summary={summary} snapshot={snapshot} local={access.local} admin={access.admin} />
                <SessionFacts summary={summary} detail={current} harness={topHarness} gate={gate} />
              </div>
            ),
          }
        : {})}
      {...(changesTotals ? { changesTotals } : {})}
      onSurface={showSurface}
      onTerminalShortcut={shell.canTerminal ? shell.openTerminal : undefined}
      launcherTakesFocus={launcherTakesFocus}
      onClose={closePanel}
      {...(pluginPanel !== undefined ? { plugin: pluginPanel } : {})}
      expanded={fileExpanded}
      onExpand={() => {
        setFileExpanded(value => !value)
        setInfoPage(true)
      }}
      fileContext={canBrowseFiles && fileContext ? fileContext : undefined}
      fileRevision={JSON.stringify(summary?.folders ?? workspaceForFiles?.folders ?? workspaceForFiles?.path)}
      treeView={fileTabs.treeView}
      onTreeViewChange={fileTabs.setTreeView}
      showFiles={filesOpen}
      onSearchFiles={searchFiles}
      {...(folderShell && project
        ? {
            rootReveal: (rootId: string) =>
              liveFolder(project, summary && frozenFolders(summary), rootId)
                ? () => {
                    void folderShell
                      .reveal(project.id, rootId)
                      .then(result => {
                        if (result.status === 'failed') setToast({ text: '找不到这个文件夹，请同步后重试。', tone: 'error' })
                      })
                      .catch(cause => {
                        setToast({ text: errorMessage(cause), tone: 'error' })
                      })
                  }
                : undefined,
          }
        : {})}
      fileSearch={catalog?.features?.fileSearch === true && readsProjectFiles(snapshot.device.dataScope)}
      onMention={mentionChoice.enabled && !active && !submission.pending ? mentionFile : undefined}
      onQuote={active ? undefined : quoteFile}
      folders={workspaceForFiles?.folders}
      cwd={workspaceForFiles?.path}
      panels={catalog?.uiPanels ?? []}
      files={fileTabs.tabs}
      activeFile={fileTabs.active}
      local={access.local}
      deviceId={snapshot.device.id}
      detail={current}
      onFileView={fileTabs.view}
      onCloseFile={id => {
        const last = fileTabs.tabs.length === 1
        fileTabs.close(id, () => {
          setFileExpanded(false)
          if (last) {
            setInfoPage(false)
            requestAnimationFrame(() => panelToggle.current?.focus({ preventScroll: true }))
          }
        })
      }}
      onFileResolved={(id, file) => {
        fileTabs.resolved(id, file)
        if (!fileContext) return
        const quote = quoteSnapshots.current.get(fileContextKey(fileContext) + '\n' + file.root + '\n' + file.path)
        if (quote && quote.etag !== file.etag && submission.draft.includes(quote.marker)) {
          setToast({ text: file.name + ' 已更新，引用可能过时', tone: 'ok' })
          quote.etag = file.etag
        }
      }}
      summary={summary}
      canCompose={canCompose}
      onCompose={compose}
    />
  )
}
