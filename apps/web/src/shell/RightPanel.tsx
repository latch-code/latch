import { fileContextKey } from '../preview/fileContext.ts'
import { SessionPanels } from '../components/SessionPanels.tsx'
import { harnessName } from '../composerChoice.ts'
import { ChangesPanel } from '../panel/changes/ChangesPanel.tsx'
import { errorMessage } from '../core/api.ts'
import { shellFolders } from '../core/shell.ts'
import { projectOf } from '../sessions.ts'
import { SessionFacts, SessionFolders, frozenFolders, liveFolder } from './SessionEnvironment.tsx'
import type { ShellState } from './useShellLayout.tsx'

/** The session's panels: the same surfaces in the column beside the conversation and in the page over it. */
export function RightPanel({ shell }: { shell: ShellState }) {
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
    showSurface,
    launcherTakesFocus,
    closePanel,
    pluginPanel,
    changesTarget,
    changesTotals,
    setChangesTotals,
    commentOnLine,
    openFile,
    level,
    phone,
    topHarness,
  } = shell
  if (!(summary || filesVisible)) return null
  const folderShell = access.local && access.admin ? shellFolders() : null
  const project = summary ? (catalog ? projectOf(summary, catalog.workspaces) : undefined) : workspaceForFiles
  // The title row's crumb holds these facts; a session without one keeps them under the launcher.
  const noCrumb = !shell.project && (summary?.mode === 'chat' || !summary?.cwd)
  const canCompose = gate.kind === 'open' && !submission.pending && !submission.sending && sessionBlock === undefined
  return (
    <SessionPanels
      key={contextKey}
      {...(summary && canViewChanges
        ? {
            changes: (
              <ChangesPanel
                summary={summary}
                messages={current?.messages ?? []}
                engine={topHarness ? harnessName(topHarness) : 'Harness'}
                local={access.local}
                canRun={access.scopes.has('run')}
                canRead={snapshot.device.dataScope === 'all'}
                hostName={snapshot.hostName}
                phone={phone}
                offline={connection === 'reconnecting' || connection === 'offline'}
                {...(changesTarget ? { target: changesTarget } : {})}
                {...(canCompose && !phone ? { onComment: commentOnLine } : {})}
                onOpenFile={file => {
                  openFile({ sessionId: summary.id, reference: file.path, rootId: file.root })
                }}
                onOpenSession={choose}
                knownSession={id => snapshot.tasks.some(task => task.id === id)}
                onToast={(text, tone = 'ok') => {
                  setToast({ text, tone })
                }}
                onTotals={setChangesTotals}
              />
            ),
          }
        : {})}
      changesOpen={changesOpen}
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
      fileSearch={catalog?.features?.fileSearch === true && snapshot.device.dataScope === 'all'}
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
        fileTabs.close(id)
        setFileExpanded(false)
        if (fileTabs.tabs.length === 1) {
          setInfoPage(false)
          requestAnimationFrame(() => panelToggle.current?.focus({ preventScroll: true }))
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
      summary={summary}
      canCompose={canCompose}
      onCompose={text => {
        submission.setDraft(previous => (previous.trim() ? `${previous}\n\n${text}` : text))
        if (pageMode) setInfoPage(false)
        composerRef.current?.focus()
      }}
    />
  )
}
