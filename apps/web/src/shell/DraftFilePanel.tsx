import { Button, Dialog, Sheet } from '@latch/ui'
import { SessionPanels } from '../components/SessionPanels.tsx'
import { fileContextKey } from '../preview/fileContext.ts'
import { errorMessage } from '../core/api.ts'
import { shellFolders } from '../core/shell.ts'
import { liveFolder } from './SessionEnvironment.tsx'
import type { ShellState } from './useShellLayout.tsx'

/** A new project's files stay apart from the conversation still being read under Home. */
export function DraftFilePanel({ shell }: { shell: ShellState }) {
  const { draftFileContext: context, draftFileTabs: tabs, draftFilesOpen: open, setDraftFilesOpen } = shell
  if (!context || context.kind !== 'workspace') return null
  const workspace = shell.catalog?.workspaces.find(item => item.id === context.workspaceId)
  const folders = shell.access.local && shell.access.admin ? shellFolders() : null
  const canCompose =
    shell.inputId === null && shell.homeComposerState.gate.kind === 'open' && !shell.submission.pending && !shell.submission.sending
  const onClose = () => setDraftFilesOpen(false)
  const content = open ? (
    <SessionPanels
      key={fileContextKey(context)}
      fileContext={context}
      fileRevision={JSON.stringify(workspace?.folders ?? workspace?.path)}
      treeView={tabs.treeView}
      onTreeViewChange={tabs.setTreeView}
      fileSearch={shell.catalog?.features?.fileSearch === true}
      onSearchFiles={shell.searchFiles}
      showFiles
      files={tabs.tabs}
      activeFile={tabs.active}
      onSurface={surface => tabs.select(surface.kind === 'file' ? surface.id : undefined)}
      onCloseFile={id => tabs.close(id)}
      onFileResolved={(id, file) => {
        tabs.resolved(id, file)
        const quote = shell.quoteSnapshots.current.get(fileContextKey(context) + '\n' + file.root + '\n' + file.path)
        if (quote && quote.etag !== file.etag && shell.submission.draft.includes(quote.marker)) {
          shell.setToast({ text: file.name + ' 已更新，引用可能过时', tone: 'ok' })
          quote.etag = file.etag
        }
      }}
      {...(folders && workspace
        ? {
            rootReveal: (root: string) =>
              liveFolder(workspace, undefined, root)
                ? () => {
                    void folders
                      .reveal(workspace.id, root)
                      .then(result => {
                        if (result.status === 'failed') shell.setToast({ text: '找不到这个文件夹，请同步后重试。', tone: 'error' })
                      })
                      .catch(cause => shell.setToast({ text: errorMessage(cause), tone: 'error' }))
                  }
                : undefined,
          }
        : {})}
      onMention={canCompose && shell.mentionChoice.enabled ? shell.mentionFile : undefined}
      onQuote={canCompose ? shell.quoteFile : undefined}
      canCompose={canCompose}
      folders={workspace?.folders}
      cwd={workspace?.path}
      local={shell.access.local}
      deviceId={shell.snapshot.device.id}
    />
  ) : null
  return shell.phone ? (
    <Sheet
      open={open}
      onClose={onClose}
      title="项目文件"
      cancelLabel={null}
      action={
        <Button variant="ghost" onClick={onClose}>
          完成
        </Button>
      }
      detent="large"
      className="draft-file-panel">
      {content}
    </Sheet>
  ) : (
    <Dialog open={open} onClose={onClose} title="项目文件" subtitle={workspace?.name} size="wide" className="draft-file-panel">
      {content}
    </Dialog>
  )
}
