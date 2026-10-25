import { useMemo, useState } from 'react'
import type { AppSnapshot, SearchHit } from '@latch/protocol'
import { Kbd, SearchField } from '@latch/ui'
import { useSessionSearch } from '../hooks/useSessionSearch.ts'
import { useFileSearch, type FileSearchTarget } from '../hooks/useFileSearch.ts'
import { Modal, ModalHeader } from './overlays.tsx'
export interface WorkbenchCommand {
  id: string
  label: string
  shortcut?: string
  run: () => void
}
export function CommandPalette({
  snapshot,
  mode = 'all',
  sessionId,
  onOpenFile,
  commands,
  onSelect,
  onSearchHit,
  onProject,
  onClose,
}: {
  snapshot: AppSnapshot
  mode?: 'all' | 'files'
  sessionId?: string
  onOpenFile?: (target: FileSearchTarget) => void
  commands: WorkbenchCommand[]
  onSelect: (id: string) => void
  onSearchHit: (hit: SearchHit) => void
  onProject?: (id: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(''),
    [active, setActive] = useState(0)
  const search = useSessionSearch(query, mode === 'all' && snapshot.catalog?.features?.search === true)
  const fileEnabled = !!onOpenFile && snapshot.catalog?.features?.fileSearch === true && snapshot.device.dataScope === 'all'
  const files = useFileSearch(query, fileEnabled ? sessionId : undefined)
  const groups = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    const fileGroup = {
      label: '文件',
      items: files.files.map(file => ({
        id: `${file.root}:${file.path}`,
        label: `${file.name} · ${file.path}`,
        run: () => {
          if (sessionId) onOpenFile?.({ sessionId, reference: file.path, rootId: file.root })
        },
      })),
    }
    if (mode === 'files') return [fileGroup].filter(group => group.items.length)
    return [
      fileGroup,
      {
        label: '会话',
        items: snapshot.tasks
          .filter(task => !q || task.title.toLocaleLowerCase().includes(q))
          .slice(0, 20)
          .map(task => ({
            id: task.id,
            label: `${task.title || '未命名会话'}${task.archived ? ' · 已归档' : ''}`,
            run: () => onSelect(task.id),
          })),
      },
      {
        label: '内容中包含',
        items: search.hits.map(hit => ({
          id: `${hit.sessionId}:${hit.messageId}`,
          label: `${hit.title} — ${hit.snippet}`,
          run: () => onSearchHit(hit),
        })),
      },
      {
        label: '项目',
        items: onProject
          ? (snapshot.catalog?.workspaces ?? [])
              .filter(item => !item.unavailable && (!q || item.name.toLocaleLowerCase().includes(q)))
              .map(item => ({ id: item.id, label: item.name, run: () => onProject(item.id) }))
          : [],
      },
      { label: '命令', items: commands.filter(item => !q || item.label.toLocaleLowerCase().includes(q)) },
    ].filter(group => group.items.length)
  }, [
    mode,
    files.files,
    sessionId,
    onOpenFile,
    query,
    snapshot.tasks,
    snapshot.catalog?.workspaces,
    search.hits,
    commands,
    onSelect,
    onSearchHit,
    onProject,
  ])
  const items = groups.flatMap(group => group.items),
    selected = Math.min(active, Math.max(0, items.length - 1))
  return (
    <Modal label={mode === 'files' ? '搜索文件' : '命令面板'} onClose={onClose} className="command-palette">
      <ModalHeader title={mode === 'files' ? '搜索文件' : '命令面板'} onClose={onClose} />
      <div
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setActive(value => (items.length ? (value + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length : 0))
          }
          if (event.key === 'Enter' && items[selected]) {
            event.preventDefault()
            items[selected]!.run()
            onClose()
          }
        }}>
        <SearchField
          autoFocus
          label={mode === 'files' ? '搜索文件名' : '搜索会话、项目和命令'}
          placeholder={mode === 'files' ? '输入文件名' : '搜索会话、项目和命令'}
          value={query}
          onValueChange={value => {
            setQuery(value)
            setActive(0)
          }}
        />
        <div className="command-results" role="listbox" aria-label="命令搜索结果">
          {groups.map(group => (
            <section key={group.label}>
              <h3>{group.label}</h3>
              {group.items.map(item => (
                <button
                  type="button"
                  role="option"
                  aria-selected={items[selected] === item}
                  key={item.id}
                  onClick={() => {
                    item.run()
                    onClose()
                  }}>
                  <span>{item.label}</span>
                  {'shortcut' in item && typeof item.shortcut === 'string' && <Kbd>{String(item.shortcut)}</Kbd>}
                </button>
              ))}
            </section>
          ))}
          {!items.length && <p>{search.loading ? '正在搜索…' : '没有匹配结果'}</p>}
          {search.error && <p role="status">{search.error}</p>}
          {files.error && <p role="status">{files.error}</p>}
          {files.loading && <p role="status">正在查找文件…</p>}
          {files.truncated && <p>已显示部分文件，请缩小搜索范围。</p>}
          {search.truncated && <p>已显示部分正文结果，请缩小搜索范围。</p>}
        </div>
      </div>
    </Modal>
  )
}
