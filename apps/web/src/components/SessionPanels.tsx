import { FilePreview } from '../preview/FilePreview.tsx'
import { FileHistoryPreview } from '../preview/FileHistoryPreview.tsx'
import { fileHistories } from '../preview/fileHistory.ts'
import type { FileTab } from '../preview/useFileTabs.ts'
import type { FileContext, FileMetadata, FileMention } from '@latch/protocol'
import { FileTree } from '../preview/FileTree.tsx'
import { fileContextKey } from '../preview/fileContext.ts'
import type { FileQuote } from '../preview/quote.ts'
import type { FileTreeView } from '../preview/treeFiles.ts'
import { useEffect, useId, useState, type ReactNode } from 'react'
import {
  escapeSecurityText,
  isUiPanelDocument,
  type TaskSummary,
  type UiPanelBlock,
  type UiPanelDocument,
  type UiPanelInfo,
} from '@latch/protocol'
import { FileDiff, Folder, GitCommitHorizontal, Maximize2, Minimize2, Puzzle, SquareTerminal, X } from 'lucide-react'
import { Button, IconButton, InlineNotice, Loading, PanelTabs, type PanelTab } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { VisibleText } from './VisibleText.tsx'
import { ClientPluginPanel } from './ClientPluginPanel.tsx'
import { PanelLauncher } from '../panel/PanelLauncher.tsx'
import { referenceIcon } from '../fileReference.ts'
import { currentShell } from '../core/shell.ts'

const closeShortcut = () => (currentShell() !== null ? '⌥⌘B' : 'Alt Shift B')

/** What the panel shows; `launcher` when nothing is open. */
export type PanelSurface =
  | { kind: 'launcher' }
  | { kind: 'changes' }
  | { kind: 'delivery' }
  | { kind: 'terminal' }
  | { kind: 'files' }
  | { kind: 'file'; id: string }
  | { kind: 'plugin'; id: string }

function surfaceOf(value: string): PanelSurface {
  if (value === 'changes' || value === 'files' || value === 'delivery' || value === 'terminal') return { kind: value }
  if (value.startsWith('file:')) return { kind: 'file', id: value.slice(5) }
  return { kind: 'plugin', id: value.slice(7) }
}

/** The right panel: a strip of tabs over 改动, 文件, the opened files and the panels enabled plugins contribute. */
export function SessionPanels({
  panels = [],
  summary,
  canCompose = false,
  onCompose = () => {},
  files = [],
  activeFile,
  onCloseFile,
  onFileResolved,
  onExpand,
  expanded,
  local = false,
  deviceId,
  detail,
  onFileView,
  fileContext,
  fileRevision,
  treeView,
  onTreeViewChange,
  onSurface,
  onClose,
  plugin,
  onSearchFiles,
  rootReveal,
  fileSearch = false,
  onMention,
  onQuote,
  folders,
  cwd,
  showFiles = false,
  changes,
  changesOpen = false,
  changesTotals,
  delivery,
  deliveryOpen = false,
  terminal,
  terminalOpen = false,
  launcherNote,
  launcherTakesFocus,
}: {
  launcherTakesFocus?(): boolean
  /** Under the launcher's rows: a phone's only home for what the title row's popover holds elsewhere. */
  launcherNote?: ReactNode
  /** The 改动 tab's content, when the session has one. */
  changes?: ReactNode
  changesOpen?: boolean
  /** The 交付 tab's content, when the Host delivers and the session has a folder. */
  delivery?: ReactNode
  deliveryOpen?: boolean
  /** The 终端 tab's content, only where the Host offers a terminal (this Mac). */
  terminal?: ReactNode
  terminalOpen?: boolean
  /** The number on the tab, only while another tab is showing. */
  changesTotals?: { add: number; del: number; files: number }
  files?: FileTab[]
  activeFile?: FileTab
  onSurface?(surface: PanelSurface): void
  onClose?(): void
  plugin?: string
  onCloseFile?(id: string): void
  onFileResolved?(id: string, file: FileMetadata): void
  onExpand?(): void
  expanded?: boolean
  local?: boolean
  deviceId?: string
  detail?: import('@latch/protocol').TaskDetail | null
  onFileView?(id: string, view: 'preview' | 'changes'): void
  panels?: UiPanelInfo[]
  fileContext?: FileContext
  fileRevision?: string
  treeView?: FileTreeView
  onTreeViewChange?(view: FileTreeView): void
  showFiles?: boolean
  onSearchFiles?(): void
  rootReveal?(rootId: string): (() => void) | undefined
  fileSearch?: boolean
  onMention?(mention: FileMention): void
  onQuote?(quote: FileQuote): void
  folders?: Array<{ id: string; path: string }>
  cwd?: string
  summary?: TaskSummary
  canCompose?: boolean
  onCompose?: (text: string) => void
}) {
  const id = useId()
  const offered = summary
    ? panels.filter(
        panel =>
          (!summary.personal || summary.pluginIds?.includes(panel.pluginId))
          && (panel.harnessIds === undefined || panel.harnessIds.includes(summary.harnessId)),
      )
    : []
  const [treeStarted, setTreeStarted] = useState(showFiles)
  useEffect(() => {
    if (showFiles) setTreeStarted(true)
  }, [showFiles])
  const histories = detail ? fileHistories(detail) : []
  const turnStart = Math.max(0, detail?.messages.findLastIndex(message => message.role === 'user') ?? 0)
  const observedFiles = detail?.fileChanges?.files ?? detail?.messages.slice(turnStart).flatMap(message => message.outputs ?? []) ?? []
  const treeRevision = JSON.stringify([
    fileRevision,
    summary?.runId,
    summary?.status,
    observedFiles.map(file => [file.root, file.path, file.change]),
  ])
  const history = activeFile
    ? histories.find(item => item.path === activeFile.target.reference && item.root === activeFile.target.rootId)
    : undefined
  const [changesStarted, setChangesStarted] = useState(changesOpen)
  useEffect(() => {
    if (changesOpen) setChangesStarted(true)
  }, [changesOpen])
  const [deliveryStarted, setDeliveryStarted] = useState(deliveryOpen)
  useEffect(() => {
    if (deliveryOpen) setDeliveryStarted(true)
  }, [deliveryOpen])
  const [terminalStarted, setTerminalStarted] = useState(terminalOpen)
  useEffect(() => {
    if (terminalOpen) setTerminalStarted(true)
  }, [terminalOpen])
  const showingChanges = changesOpen && !activeFile
  const showingDelivery = deliveryOpen && !activeFile && !showingChanges
  const showingTerminal = terminalOpen && !activeFile && !showingChanges && !showingDelivery
  const showingFiles = showFiles && !activeFile && !showingChanges && !showingDelivery && !showingTerminal
  const active =
    !activeFile && !showingChanges && !showingDelivery && !showingTerminal && !showingFiles
      ? offered.find(panel => panel.id === plugin)
      : undefined
  const launcher = !activeFile && !showingChanges && !showingDelivery && !showingTerminal && !showingFiles && !active
  const tabs: Array<PanelTab<string>> = [
    ...(changes
      ? [
          {
            value: 'changes',
            label: '改动',
            icon: FileDiff,
            controls: id,
            ...(!showingChanges && changesTotals?.files ? { stat: { added: changesTotals.add, removed: changesTotals.del } } : {}),
          },
        ]
      : []),
    ...(fileContext ? [{ value: 'files', label: '文件', icon: Folder, controls: id }] : []),
    ...(terminal ? [{ value: 'terminal', label: '终端', icon: SquareTerminal, controls: id }] : []),
    ...(delivery ? [{ value: 'delivery', label: '交付', icon: GitCommitHorizontal, controls: id }] : []),
    ...files.map(tab => {
      const name = escapeSecurityText(tab.file?.name ?? tab.target.reference.split(/[\\/]/u).at(-1) ?? tab.target.reference)
      return {
        value: `file:${tab.id}`,
        label: name,
        icon: referenceIcon(name),
        controls: id,
        closeLabel: `关闭 ${name}`,
        ...(tab.fresh ? { fresh: true } : {}),
      }
    }),
    ...offered.map(panel => ({ value: `plugin:${panel.id}`, label: escapeSecurityText(panel.title), icon: Puzzle, controls: id })),
  ]
  const value = activeFile
    ? `file:${activeFile.id}`
    : showingChanges
      ? 'changes'
      : showingDelivery
        ? 'delivery'
        : showingTerminal
          ? 'terminal'
          : showingFiles
            ? 'files'
            : active
              ? `plugin:${active.id}`
              : ''
  return (
    <div className="session-panels">
      <PanelTabs
        label="会话面板"
        className="session-panel-strip"
        value={value}
        tabs={tabs}
        onValueChange={next => onSurface?.(surfaceOf(next))}
        onClose={next => {
          if (next.startsWith('file:')) onCloseFile?.(next.slice(5))
        }}
        actions={
          <>
            {!launcher && onExpand && (
              <IconButton size="xs" icon={expanded ? Minimize2 : Maximize2} label={expanded ? '还原' : '铺满'} onClick={onExpand} />
            )}
            {onClose && <IconButton size="xs" icon={X} label="关闭" shortcut={closeShortcut()} onClick={onClose} />}
          </>
        }
      />
      {changes && changesStarted && (
        <div className="session-panel-changes" hidden={!showingChanges}>
          {changes}
        </div>
      )}
      {delivery && deliveryStarted && (
        <div className="session-panel-changes" hidden={!showingDelivery}>
          {delivery}
        </div>
      )}
      {terminal && terminalStarted && (
        <div className="session-panel-changes" hidden={!showingTerminal}>
          {terminal}
        </div>
      )}
      {fileContext && treeStarted && (
        <div className="session-file-tree" hidden={!showingFiles}>
          <FileTree
            key={`${fileContextKey(fileContext)}:${fileRevision ?? ''}`}
            context={fileContext}
            local={local}
            folders={summary?.folders ?? folders}
            cwd={summary?.cwd ?? cwd}
            fileChanges={observedFiles}
            revision={treeRevision}
            initialView={treeView}
            onViewChange={onTreeViewChange}
            {...(fileSearch ? { onSearch: () => onSearchFiles?.() } : {})}
            {...(rootReveal ? { rootReveal } : {})}
            onMention={onMention}
          />
        </div>
      )}
      <div
        className="session-panel-body"
        hidden={showingChanges || showingDelivery || showingTerminal || showingFiles}
        role={launcher ? undefined : 'tabpanel'}
        id={id}
        aria-label={launcher ? undefined : (activeFile?.file?.name ?? active?.title)}>
        {activeFile?.target.view === 'changes' ? (
          <FileHistoryPreview
            history={history}
            histories={histories}
            expanded={expanded}
            name={activeFile.target.reference.split('/').at(-1) ?? activeFile.target.reference}
            onPreview={() => onFileView?.(activeFile.id, 'preview')}
            onExpand={() => onExpand?.()}
          />
        ) : activeFile ? (
          <FilePreview
            key={activeFile.id}
            tab={activeFile}
            local={local}
            deviceId={deviceId}
            browsable={!!fileContext}
            onHistory={history ? () => onFileView?.(activeFile.id, 'changes') : undefined}
            folders={summary?.folders ?? folders}
            cwd={summary?.cwd ?? cwd}
            onResolved={file => onFileResolved?.(activeFile.id, file)}
            onMention={onMention}
            onQuote={canCompose ? onQuote : undefined}
          />
        ) : active?.moduleHash && summary ? (
          <section className="plugin-panel" aria-label={active.title}>
            <p className="plugin-panel-caption">
              由 <VisibleText text={active.pluginName} /> 提供
            </p>
            <ClientPluginPanel
              key={`${active.id}:${active.moduleHash}:${summary.id}`}
              panel={active}
              summary={summary}
              canCompose={canCompose}
              onCompose={onCompose}
            />
          </section>
        ) : active && summary ? (
          <PluginPanel key={active.id} panel={active} summary={summary} />
        ) : (
          <PanelLauncher
            {...(changes ? { changes: true } : {})}
            files={!!fileContext}
            {...(terminal ? { terminal: true } : {})}
            {...(delivery ? { delivery: true } : {})}
            plugins={offered.map(panel => ({ id: panel.id, title: panel.title }))}
            {...(launcherTakesFocus ? { takesFocus: launcherTakesFocus } : {})}
            onOpen={surface => onSurface?.(surface)}>
            {launcherNote}
          </PanelLauncher>
        )}
      </div>
    </div>
  )
}

function BlockContent({ block }: { block: UiPanelBlock }) {
  switch (block.type) {
    case 'text':
      return (
        <p className="plugin-panel-text">
          <VisibleText text={block.text} />
        </p>
      )
    case 'code':
      return (
        <div className="plugin-panel-code">
          {block.language && (
            <span className="plugin-panel-caption">
              <VisibleText text={block.language} />
            </span>
          )}
          <pre tabIndex={0}>
            <code>
              <VisibleText text={block.text} />
            </code>
          </pre>
        </div>
      )
    case 'list':
      return (
        <ul>
          {block.items.map((item, index) => (
            <li key={index}>
              <VisibleText text={item} />
            </li>
          ))}
        </ul>
      )
    case 'facts':
      return (
        <dl>
          {block.items.map((item, index) => (
            <div key={index}>
              <dt>
                <VisibleText text={item.label} />
              </dt>
              <dd>
                <VisibleText text={item.value} />
              </dd>
            </div>
          ))}
        </dl>
      )
    case 'table':
      return (
        <div className="plugin-panel-table" role="region" tabIndex={0} aria-label="面板表格">
          <table>
            <thead>
              <tr>
                {block.columns.map((column, index) => (
                  <th key={index} scope="col">
                    <VisibleText text={column} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, at) => (
                    <td key={at}>
                      <VisibleText text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

/** A response belongs to its panel and session revision. Late reads never replace the next session's content. */
function PluginPanel({ panel, summary }: { panel: UiPanelInfo; summary: TaskSummary }) {
  const [retry, setRetry] = useState(0)
  const key = JSON.stringify([panel.id, summary.id, summary.runId, summary.status, summary.title, retry])
  const [result, setResult] = useState<{ key: string; document?: UiPanelDocument; error?: string } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void api<{ panel: unknown }>(`tasks/${encodeURIComponent(summary.id)}/ui-panels/${encodeURIComponent(panel.id)}`, {
      signal: controller.signal,
    })
      .then(data => {
        if (controller.signal.aborted) return
        if (!isUiPanelDocument(data.panel)) throw new Error('扩展面板返回了不支持的内容。')
        setResult({ key, document: data.panel })
      })
      .catch(cause => {
        if (!controller.signal.aborted) setResult({ key, error: errorMessage(cause) })
      })
    return () => {
      controller.abort()
    }
  }, [key, panel.id, summary.id])
  const current = result?.key === key ? result : null
  return (
    <section className="plugin-panel" aria-label={panel.title}>
      <header className="plugin-panel-head">
        <div>
          <h2>
            <VisibleText text={panel.title} />
          </h2>
          <p className="plugin-panel-caption">
            由 <VisibleText text={panel.pluginName} /> 提供
          </p>
        </div>
        <Button size="xs" variant="ghost" onClick={() => setRetry(value => value + 1)}>
          刷新
        </Button>
      </header>
      {panel.description && (
        <p className="plugin-panel-description">
          <VisibleText text={panel.description} />
        </p>
      )}
      {current?.document ? (
        <div className="plugin-panel-content">
          {current.document.blocks.map((block, index) => (
            <BlockContent key={index} block={block} />
          ))}
          {current.document.blocks.length === 0 && <p className="plugin-panel-caption">这个会话暂时没有面板内容。</p>}
        </div>
      ) : current?.error ? (
        <InlineNotice
          tone="error"
          action={
            <Button size="xs" onClick={() => setRetry(value => value + 1)}>
              重试
            </Button>
          }>
          {current.error}
        </InlineNotice>
      ) : (
        <Loading label="正在读取扩展面板…" />
      )}
    </section>
  )
}
