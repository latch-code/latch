import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { FileCode, TextSearch } from 'lucide-react'
import type { ContextFileOpenTarget, FileContext, SearchHit } from '@latch/protocol'
import { Icon, Kbd, Modal, SearchField } from '@latch/ui'
import { overlayDismissed } from '../escapeGrace.ts'
import { useFileSearch } from '../hooks/useFileSearch.ts'
import { useSessionSearch } from '../hooks/useSessionSearch.ts'
import { targetIn } from '../preview/fileContext.ts'
import {
  fileFolder,
  paletteGroups,
  snippetAround,
  type PaletteEntry,
  type PaletteLevel,
  type PaletteRow,
  type PaletteSearchState,
} from './model.ts'

function PathSub({ path }: { path: string }) {
  const cut = path.lastIndexOf('/') + 1
  return (
    <>
      <span className="palette-row-path-start">{path.slice(0, cut)}</span>
      <span className="palette-row-path-end">{path.slice(cut)}</span>
    </>
  )
}

function Marked({ text, mark }: { text: string; mark: PaletteRow['mark'] }) {
  if (!mark) return <>{text}</>
  return (
    <>
      {text.slice(0, mark.start)}
      <mark>{text.slice(mark.start, mark.end)}</mark>
      {text.slice(mark.end)}
    </>
  )
}

/** Search and commands in one place. Esc steps back (what was typed, then a level) before it closes. */
export function CommandPalette({
  level: firstLevel,
  recent,
  sessions,
  agents,
  settings,
  commands,
  searchMessages,
  fileContext,
  fileRootName,
  onOpenFile,
  onSearchHit,
  onClose,
}: {
  level: PaletteLevel
  recent: readonly PaletteEntry[]
  sessions: readonly PaletteEntry[]
  agents: readonly PaletteEntry[]
  settings: readonly PaletteEntry[]
  commands: readonly PaletteEntry[]
  searchMessages: boolean
  /** Present when this device may search the files of what is open. */
  fileContext: FileContext | undefined
  fileRootName: (root: string) => string
  onOpenFile: (target: ContextFileOpenTarget) => void
  onSearchHit: (hit: SearchHit) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(''),
    [levels, setLevels] = useState<PaletteLevel[]>([firstLevel]),
    [activeId, setActiveId] = useState<string | null>(null)
  const level = levels.at(-1)!
  const typed = query.trim().length > 0
  const message = useSessionSearch(query, level === 'root' && searchMessages)
  const file = useFileSearch(query, fileContext && (level === 'files' || typed) ? fileContext : undefined)
  const list = useRef<HTMLDivElement>(null)
  const moved = useRef(false)
  const seat = useRef<{ id: string | undefined; at: number }>({ id: undefined, at: -1 })

  const groups = useMemo(() => {
    const manyRoots = new Set(file.files.map(item => item.root)).size > 1
    const files: PaletteSearchState | undefined = fileContext && {
      rows: file.files.map(item => {
        const folder = fileFolder(item.path, item.name, manyRoots ? fileRootName(item.root) : undefined)
        const at = item.name.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase())
        return {
          id: `file:${item.root}:${item.path}`,
          label: item.name,
          ...(folder ? { sub: folder, subIsPath: true } : {}),
          ...(query.trim() && at >= 0 ? { mark: { start: at, end: at + query.trim().length } } : {}),
          icon: <Icon icon={FileCode} size={16} />,
          run: () => {
            onOpenFile(targetIn(fileContext, item.path, item.root))
          },
        }
      }),
      loading: file.loading,
      error: file.error,
      truncated: file.truncated,
    }
    const messages: PaletteSearchState | undefined = searchMessages
      ? {
          rows: message.hits.map(hit => {
            const { text, mark } = snippetAround(hit.snippet, hit.match)
            return {
              id: `hit:${hit.sessionId}:${hit.messageId}`,
              label: text,
              mark,
              sub: `${hit.title || '未命名会话'}${hit.archived ? ' · 已归档' : ''}`,
              icon: <Icon icon={TextSearch} size={16} />,
              run: () => {
                onSearchHit(hit)
              },
            }
          }),
          loading: message.loading,
          error: message.error,
          truncated: message.truncated,
        }
      : undefined
    return paletteGroups({ level, query, recent, sessions, files, agents, settings, commands, messages })
  }, [
    level,
    query,
    recent,
    sessions,
    agents,
    settings,
    commands,
    file,
    message,
    searchMessages,
    fileContext,
    fileRootName,
    onOpenFile,
    onSearchHit,
  ])

  const rows = groups.flatMap(group => group.rows)
  // Held by identity from the moment it is shown: results that arrive late, or sessions that reorder, must not change
  // what Enter would open.
  if (rows[0] && !rows.some(row => row.id === activeId)) setActiveId(rows[0].id)
  const selected = rows.find(row => row.id === activeId) ?? rows[0]
  const selectedAt = selected ? rows.indexOf(selected) : -1

  useEffect(() => {
    const pushed = seat.current.id === selected?.id && seat.current.at !== selectedAt
    seat.current = { id: selected?.id, at: selectedAt }
    if (!moved.current && !pushed) return
    moved.current = false
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  })

  const choose = (row: PaletteRow) => {
    if (row.level) {
      setLevels(previous => [...previous, row.level!])
      setQuery('')
      setActiveId(null)
      return
    }
    row.run()
    onClose()
  }
  const keydown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      // The field's own Esc would empty what is still being composed.
      if (event.key === 'Escape') event.preventDefault()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!rows.length) return
      moved.current = true
      setActiveId(rows[(Math.max(0, selectedAt) + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]!.id)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (selected) choose(selected)
    } else if (event.key === 'Escape' && !query && levels.length > 1) {
      event.preventDefault()
      event.stopPropagation()
      setLevels(previous => previous.slice(0, -1))
      setActiveId(null)
    }
  }
  const files = level === 'files'
  const name = files ? '搜索文件' : '命令面板'
  return (
    <Modal
      label={name}
      onClose={() => {
        overlayDismissed()
        onClose()
      }}
      className="command-palette">
      <SearchField
        autoFocus
        variant="ghost"
        label={files ? '搜索文件名' : '搜索会话、文件、Harness 和命令'}
        placeholder={files ? '输入文件名…' : '搜索会话、文件、Harness 和命令…'}
        aria-controls="palette-results"
        aria-activedescendant={selected ? `palette-${selected.id}` : undefined}
        value={query}
        onValueChange={value => {
          setQuery(value)
          setActiveId(null)
        }}
        onKeyDown={keydown}
      />
      <div ref={list} id="palette-results" className="palette-results" role="listbox" aria-label="搜索结果">
        {groups.map(group => (
          <section key={group.label} role="group" aria-label={group.label}>
            <h3>{group.label}</h3>
            {group.rows.map(row => (
              <button
                type="button"
                role="option"
                id={`palette-${row.id}`}
                aria-selected={selected === row}
                aria-label={row.label}
                aria-description={row.sub}
                tabIndex={-1}
                key={row.id}
                className="palette-row"
                onMouseDown={event => {
                  // Focus stays in the input, where the keys are.
                  event.preventDefault()
                }}
                onPointerMove={() => {
                  setActiveId(row.id)
                }}
                onClick={() => {
                  choose(row)
                }}>
                <span className="palette-row-icon">{row.icon}</span>
                <span className="palette-row-label">
                  <Marked text={row.label} mark={row.mark} />
                </span>
                {row.sub && (
                  <span className="palette-row-sub" title={row.sub}>
                    {row.subIsPath ? <PathSub path={row.sub} /> : row.sub}
                  </span>
                )}
                {row.shortcut && <span className="palette-row-keys">{row.shortcut}</span>}
              </button>
            ))}
            {group.notes?.map(note => (
              <p key={note.text} className="palette-note" role="status" data-tone={note.tone}>
                {note.text}
              </p>
            ))}
          </section>
        ))}
        {!groups.length && (
          <p className="palette-note" role="status">
            {message.loading || file.loading ? '正在搜索…' : '没有匹配结果'}
          </p>
        )}
      </div>
      <footer className="palette-foot" aria-hidden="true">
        <span>
          <Kbd>↑↓</Kbd>选择
        </span>
        <span>
          <Kbd>⏎</Kbd>打开
        </span>
        <span>
          <Kbd>esc</Kbd>
          {query || levels.length > 1 ? '返回' : '关闭'}
        </span>
      </footer>
    </Modal>
  )
}
