import { FilePreview } from '../preview/FilePreview.tsx'
import { FileHistoryPreview } from '../preview/FileHistoryPreview.tsx'
import { fileHistories } from '../preview/fileHistory.ts'
import type { FileTab } from '../preview/useFileTabs.ts'
import type { FileContext, FileMetadata, FileMention } from '@latch/protocol'
import { FileTree } from '../preview/FileTree.tsx'
import { fileContextKey } from '../preview/fileContext.ts'
import type { FileQuote } from '../preview/quote.ts'
import type { FileTreeView } from '../preview/treeFiles.ts'
import { useEffect, useId, useState, type ReactNode, type RefObject } from 'react'
import {
  escapeSecurityText,
  isUiPanelDocument,
  type TaskSummary,
  type UiPanelBlock,
  type UiPanelDocument,
  type UiPanelInfo,
} from '@latch/protocol'
import { Maximize2, Minimize2 } from 'lucide-react'
import { Button, IconButton, InlineNotice, Loading, PanelTabs, type PanelTab } from '@latch/ui'
import { api, errorMessage, MessageError } from '../core/api.ts'
import { VisibleText } from './VisibleText.tsx'
import { ClientPluginPanel } from './ClientPluginPanel.tsx'
import { PanelAddMenu, PanelEmpty } from '../panel/PanelChoices.tsx'
import { panelFace, type PanelChoice, type PanelKey } from '../panel/panelTabs.ts'
import { referenceIcon } from '../fileReference.ts'

/** What the panel shows: one of its tabs, an opened file, or nothing (the choices). */
export type PanelSurface =
  | { kind: 'empty' }
  | { kind: 'overview' }
  | { kind: 'changes' }
  | { kind: 'delivery' }
  | { kind: 'browser' }
  | { kind: 'terminal' }
  | { kind: 'files' }
  | { kind: 'file'; id: string }
  | { kind: 'plugin'; id: string }

export function surfaceKey(surface: PanelSurface): PanelKey | undefined {
  if (surface.kind === 'empty' || surface.kind === 'file') return undefined
  return surface.kind === 'plugin' ? `plugin:${surface.id}` : surface.kind
}

function surfaceOf(key: PanelKey): PanelSurface {
  return key.startsWith('plugin:') ? { kind: 'plugin', id: key.slice(7) } : ({ kind: key } as PanelSurface)
}

export function offersPluginPanel(panel: UiPanelInfo, session: TaskSummary): boolean {
  return (
    (!session.personal || session.pluginIds?.includes(panel.pluginId) === true)
    && (panel.harnessIds === undefined || panel.harnessIds.includes(session.harnessId))
  )
}

/** Mounted once first shown, then kept (hidden) while another tab shows, so it keeps its place and streams. */
function useStarted(showing: boolean): boolean {
  const [started, setStarted] = useState(showing)
  useEffect(() => {
    if (showing) setStarted(true)
  }, [showing])
  return started || showing
}

/**
 * The right panel: a strip of the tabs opened here (概要, 改动, 文件, 浏览器, 终端, 交付, plugin panels), then the opened
 * files, then 「+」 with everything else this session can open. With no tab open it shows those choices.
 */
export function SessionPanels({
  open = [],
  active,
  choices,
  onChoose,
  onCloseTab,
  addTrigger,
  addShortcut,
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
  onSearchFiles,
  rootReveal,
  fileSearch = false,
  onMention,
  onQuote,
  folders,
  cwd,
  changes,
  changesTotals,
  delivery,
  browser,
  terminal,
  launcherNote,
  emptyTakesFocus,
  overview,
}: {
  /** The tabs open here, in order; only those this session can show. */
  open?: readonly PanelKey[]
  /** The selected one; an active file stands over it. */
  active?: PanelKey | undefined
  /** What 「+」 and the empty panel offer; without it there is no 「+」. */
  choices?: readonly PanelChoice[]
  onChoose?(key: PanelKey): void
  /** Makes the tabs closable. */
  onCloseTab?(key: PanelKey): void
  addTrigger?: RefObject<HTMLButtonElement | null>
  addShortcut?: string | null
  overview?: ReactNode
  emptyTakesFocus?(): boolean
  /** A phone's only home for the folders and facts held by the title row's popover elsewhere. */
  launcherNote?: ReactNode
  changes?: ReactNode
  delivery?: ReactNode
  /** The desktop app's own window on this Mac: the browser; elsewhere a read-only list of its tabs. */
  browser?: ReactNode
  /** The session's terminals, when they live here rather than in the dock. */
  terminal?: ReactNode
  /** The number on the tab, only while another tab is showing. */
  changesTotals?: { add: number; del: number; files: number }
  files?: FileTab[]
  activeFile?: FileTab
  onSurface?(surface: PanelSurface): void
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
  const offered = summary ? panels.filter(panel => offersPluginPanel(panel, summary)) : []
  const content = (key: PanelKey): boolean =>
    key === 'overview'
      ? !!overview
      : key === 'changes'
        ? !!changes
        : key === 'delivery'
          ? !!delivery
          : key === 'browser'
            ? !!browser
            : key === 'terminal'
              ? !!terminal
              : key === 'files'
                ? !!fileContext
                : offered.some(panel => `plugin:${panel.id}` === key)
  const tabsOpen = open.filter(content)
  const selected = activeFile ? undefined : active !== undefined && tabsOpen.includes(active) ? active : tabsOpen[0]
  const showing = (key: PanelKey) => selected === key
  const changesStarted = useStarted(showing('changes'))
  const deliveryStarted = useStarted(showing('delivery'))
  const browserStarted = useStarted(showing('browser'))
  const terminalStarted = useStarted(showing('terminal'))
  const treeStarted = useStarted(showing('files'))
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
  const plugin = selected?.startsWith('plugin:') ? offered.find(panel => `plugin:${panel.id}` === selected) : undefined
  const empty = !activeFile && selected === undefined
  const closable = (name: string) => (onCloseTab ? { closeLabel: `关闭${name}` } : {})
  const tabs: Array<PanelTab<string>> = [
    ...tabsOpen.map(key => {
      const panel = key.startsWith('plugin:') ? offered.find(item => `plugin:${item.id}` === key) : undefined
      const face = panelFace(key, panel ? escapeSecurityText(panel.title) : '')
      const label = face.label
      return {
        value: key,
        label,
        icon: face.icon,
        controls: id,
        ...closable(label),
        ...(key === 'changes' && !showing('changes') && changesTotals?.files
          ? { stat: { added: changesTotals.add, removed: changesTotals.del } }
          : {}),
      }
    }),
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
  ]
  const value = activeFile ? `file:${activeFile.id}` : (selected ?? '')
  const choose = (key: PanelKey) => onChoose?.(key)
  const inBody = !showing('changes') && !showing('delivery') && !showing('browser') && !showing('terminal') && !showing('files')
  return (
    <div className="session-panels">
      <PanelTabs
        label="会话面板"
        className="session-panel-strip"
        value={value}
        tabs={tabs}
        onValueChange={next => onSurface?.(next.startsWith('file:') ? { kind: 'file', id: next.slice(5) } : surfaceOf(next as PanelKey))}
        onClose={next => {
          if (next.startsWith('file:')) onCloseFile?.(next.slice(5))
          else onCloseTab?.(next as PanelKey)
        }}
        {...(choices && choices.length > 0 && onChoose
          ? { add: <PanelAddMenu choices={choices} onChoose={choose} trigger={addTrigger} shortcut={addShortcut} /> }
          : {})}
        actions={
          !empty && onExpand ? (
            <IconButton size="xs" icon={expanded ? Minimize2 : Maximize2} label={expanded ? '还原' : '铺满'} onClick={onExpand} />
          ) : undefined
        }
      />
      {changes && changesStarted && (
        <div className="session-panel-changes" hidden={!showing('changes')}>
          {changes}
        </div>
      )}
      {delivery && deliveryStarted && (
        <div className="session-panel-changes" hidden={!showing('delivery')}>
          {delivery}
        </div>
      )}
      {browser && browserStarted && (
        <div className="session-panel-changes" hidden={!showing('browser')}>
          {browser}
        </div>
      )}
      {terminal && terminalStarted && (
        <div className="session-panel-changes session-panel-terminal" hidden={!showing('terminal')}>
          {terminal}
        </div>
      )}
      {fileContext && treeStarted && (
        <div className="session-file-tree" hidden={!showing('files')}>
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
        hidden={!inBody}
        role={empty ? undefined : 'tabpanel'}
        id={id}
        aria-label={empty ? undefined : (activeFile?.file?.name ?? plugin?.title ?? (showing('overview') ? '会话概要' : undefined))}>
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
            running={summary?.status === 'running' || summary?.status === 'waiting-approval'}
          />
        ) : plugin?.moduleHash && summary ? (
          <section className="plugin-panel" aria-label={plugin.title}>
            <p className="plugin-panel-caption">
              由 <VisibleText text={plugin.pluginName} /> 提供
            </p>
            <ClientPluginPanel
              key={`${plugin.id}:${plugin.moduleHash}:${summary.id}`}
              panel={plugin}
              summary={summary}
              canCompose={canCompose}
              onCompose={onCompose}
            />
          </section>
        ) : plugin && summary ? (
          <PluginPanel key={plugin.id} panel={plugin} summary={summary} />
        ) : showing('overview') ? (
          <>
            {launcherNote}
            {overview}
          </>
        ) : empty ? (
          <PanelEmpty choices={choices ?? []} onChoose={choose} {...(emptyTakesFocus ? { takesFocus: emptyTakesFocus } : {})}>
            {launcherNote}
          </PanelEmpty>
        ) : null}
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
        if (!isUiPanelDocument(data.panel)) throw new MessageError('扩展面板返回了不支持的内容。')
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
