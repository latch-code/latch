import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Icon, Kbd, type IconComponent, DiffGlyph, FolderGlyph, CommitGlyph, GlobeGlyph, PluginsGlyph, TerminalGlyph } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import type { PanelSurface } from '../components/SessionPanels.tsx'

type Row = { id: string; label: string; icon: IconComponent; letter?: string; surface: PanelSurface }

/** Only what this session can open; the keys work while the launcher holds focus. */
export function launcherRows(input: {
  changes?: boolean
  files?: boolean
  terminal?: boolean
  browser?: boolean
  delivery?: boolean
  plugins?: ReadonlyArray<{ id: string; title: string }>
}): Row[] {
  return [
    ...(input.changes ? [{ id: 'changes', label: '改动', icon: DiffGlyph, letter: 'D', surface: { kind: 'changes' as const } }] : []),
    ...(input.files ? [{ id: 'files', label: '文件', icon: FolderGlyph, letter: 'F', surface: { kind: 'files' as const } }] : []),
    ...(input.terminal
      ? [{ id: 'terminal', label: '终端', icon: TerminalGlyph, letter: 'T', surface: { kind: 'terminal' as const } }]
      : []),
    ...(input.browser ? [{ id: 'browser', label: '浏览器', icon: GlobeGlyph, letter: 'B', surface: { kind: 'browser' as const } }] : []),
    ...(input.delivery ? [{ id: 'delivery', label: '交付', icon: CommitGlyph, surface: { kind: 'delivery' as const } }] : []),
    ...(input.plugins ?? []).map(plugin => ({
      id: `plugin:${plugin.id}`,
      label: plugin.title,
      icon: PluginsGlyph,
      surface: { kind: 'plugin' as const, id: plugin.id },
    })),
  ]
}

export function PanelLauncher({
  changes,
  files,
  terminal,
  browser,
  delivery,
  plugins,
  takesFocus,
  onOpen,
  children,
}: {
  /** Whether the person just asked for the launcher; anything else mounting it must not pull focus out of the composer. */
  takesFocus?: () => boolean
  changes?: boolean
  files?: boolean
  terminal?: boolean
  browser?: boolean
  delivery?: boolean
  plugins?: ReadonlyArray<{ id: string; title: string }>
  onOpen(surface: PanelSurface): void
  children?: ReactNode
}) {
  const rows = launcherRows({
    ...(changes ? { changes } : {}),
    ...(files ? { files } : {}),
    ...(terminal ? { terminal } : {}),
    ...(browser ? { browser } : {}),
    ...(delivery ? { delivery } : {}),
    ...(plugins ? { plugins } : {}),
  })
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (takesFocus?.()) list.current?.focus({ preventScroll: true })
  }, [])
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return
    const row = rows.find(item => item.letter === event.key.toUpperCase())
    if (row) {
      event.preventDefault()
      onOpen(row.surface)
    }
  }
  if (rows.length === 0)
    return (
      <div className="panel-launcher">
        <p className="panel-launcher-empty">这个会话没有可以打开的面板</p>
        {children}
      </div>
    )
  return (
    <div className="panel-launcher" ref={list} tabIndex={-1} onKeyDown={keydown}>
      <div className="panel-launcher-list">
        <h3>打开一个面板</h3>
        {rows.map(row => (
          <button
            key={row.id}
            type="button"
            className="panel-launcher-row"
            onClick={() => {
              onOpen(row.surface)
            }}>
            <Icon icon={row.icon} size={16} />
            <span>
              <VisibleText text={row.label} />
            </span>
            {row.letter && <Kbd>{row.letter}</Kbd>}
          </button>
        ))}
        {children}
      </div>
    </div>
  )
}
