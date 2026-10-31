import { fileContextKey } from '../preview/fileContext.ts'
import { Inspector } from '../components/Inspector.tsx'
import { SessionPanels } from '../components/SessionPanels.tsx'
import type { ShellState } from './useShellLayout.tsx'

/** The session's panels: the same blocks in the column beside the conversation and in the page over it. */
export function RightPanel({ shell }: { shell: ShellState }) {
  const {
    current,
    summary,
    composerRef,
    setToast,
    configBusy,
    catalog,
    shell: desktop,
    access,
    owner,
    active,
    harnessInfo,
    submission,
    quoteSnapshots,
    mentionChoice,
    choose,
    setConfig,
    gate,
    sessionBlock,
    currentModel,
    effectiveModel,
    preferences,
    setInfoPage,
    inspectorToggle,
    fileContext,
    fileTabs,
    fileExpanded,
    setFileExpanded,
    filesOpen,
    setFilesOpen,
    canBrowseFiles,
    filesVisible,
    contextKey,
    pageMode,
    openSettings,
    openProjectSettings,
    toggleBlock,
    revealFromInspector,
    infoLocked,
    searchFiles,
    mentionFile,
    quoteFile,
    workspaceForFiles,
    snapshot,
    refresh,
  } = shell
  if (!(summary || filesVisible)) return null
  return (
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
          collapsed={new Set(preferences.rightPanel.collapsed)}
          onToggleBlock={toggleBlock}
          onReveal={revealFromInspector}
          onSource={choose}
          {...(owner && desktop
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
}
