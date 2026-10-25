import { FilePreview } from '../preview/FilePreview.tsx'
import { FileHistoryPreview } from '../preview/FileHistoryPreview.tsx'
import { fileHistories } from '../preview/fileHistory.ts'
import type { FileTab } from '../preview/useFileTabs.ts'
import type { FileMetadata } from '@latch/protocol'
import { useEffect, useId, useState, type ReactNode } from 'react'
import {
  escapeSecurityText,
  isUiPanelDocument,
  type TaskSummary,
  type UiPanelBlock,
  type UiPanelDocument,
  type UiPanelInfo,
} from '@latch/protocol'
import { Button, InlineNotice, Loading, Tabs } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { VisibleText } from './VisibleText.tsx'
import { ClientPluginPanel } from './ClientPluginPanel.tsx'

/** First-party session information and the panels enabled plugins contribute for this harness. */
export function SessionPanels({
  panels = [],
  summary,
  children,
  canCompose = false,
  onCompose = () => {},
  files = [],
  activeFile,
  onSelectFile,
  onCloseFile,
  onFileResolved,
  onExpandFile,
  local = false,
  deviceId,
  detail,
  onFileView,
}: {
  files?: FileTab[]
  activeFile?: FileTab
  onSelectFile?(id?: string): void
  onCloseFile?(id: string): void
  onFileResolved?(id: string, file: FileMetadata): void
  onExpandFile?(): void
  local?: boolean
  deviceId?: string
  detail?: import('@latch/protocol').TaskDetail | null
  onFileView?(id: string, view: 'preview' | 'changes'): void
  panels?: UiPanelInfo[]
  summary: TaskSummary
  children: ReactNode
  canCompose?: boolean
  onCompose?: (text: string) => void
}) {
  const [selected, setSelected] = useState('session')
  const id = useId()
  const offered = panels.filter(panel => panel.harnessIds === undefined || panel.harnessIds.includes(summary.harnessId ?? 'standard'))
  const active = offered.find(panel => panel.id === selected)
  const history =
    detail && activeFile
      ? fileHistories(detail).find(item => item.path === activeFile.target.reference && item.root === activeFile.target.rootId)
      : undefined
  if (offered.length === 0 && files.length === 0) return children
  return (
    <div className="session-panels inspector">
      <Tabs
        label="会话面板"
        className="session-panel-tabs"
        value={activeFile ? `file:${activeFile.id}` : (active?.id ?? 'session')}
        options={[
          { value: 'session', label: '会话', controls: id },
          ...files.map(tab => ({
            value: `file:${tab.id}`,
            label: escapeSecurityText(tab.file?.name ?? tab.target.reference.split(/[\\/]/u).at(-1) ?? tab.target.reference),
            controls: id,
          })),
          ...offered.map(panel => ({ value: panel.id, label: escapeSecurityText(panel.title), controls: id })),
        ]}
        onValueChange={value => {
          if (value.startsWith('file:')) onSelectFile?.(value.slice(5))
          else {
            onSelectFile?.(undefined)
            setSelected(value)
          }
        }}
      />
      <div role="tabpanel" id={id} aria-label={activeFile?.file?.name ?? active?.title ?? '会话'}>
        {activeFile?.target.view === 'changes' ? (
          <FileHistoryPreview
            history={history}
            name={activeFile.target.reference.split('/').at(-1) ?? activeFile.target.reference}
            onPreview={() => onFileView?.(activeFile.id, 'preview')}
            onClose={() => onCloseFile?.(activeFile.id)}
            onExpand={() => onExpandFile?.()}
          />
        ) : activeFile ? (
          <FilePreview
            key={activeFile.id}
            tab={activeFile}
            local={local}
            deviceId={deviceId}
            onHistory={history ? () => onFileView?.(activeFile.id, 'changes') : undefined}
            folders={summary.folders}
            cwd={summary.cwd}
            onResolved={file => onFileResolved?.(activeFile.id, file)}
            onCompose={canCompose ? onCompose : undefined}
            onClose={() => onCloseFile?.(activeFile.id)}
            onExpand={() => onExpandFile?.()}
          />
        ) : active?.moduleHash ? (
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
        ) : active ? (
          <PluginPanel key={active.id} panel={active} summary={summary} />
        ) : (
          children
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
