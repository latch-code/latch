import { useCallback, useMemo } from 'react'
import {
  Bot,
  ClipboardCopy,
  Download,
  FileDiff,
  FileSearch,
  FolderTree,
  File as FileIcon,
  PanelLeft,
  PanelRight,
  ArrowRightToLine,
  Search,
  Settings,
  SquarePen,
  SunMoon,
} from 'lucide-react'
import { Icon, type LucideIcon } from '@latch/ui'
import { HARNESS_MARKS, presetOf } from '../brands.ts'
import { harnessName } from '../composerChoice.ts'
import { HarnessTile, MarkTile } from '../components/BrandTile.tsx'
import { currentShell } from '../core/shell.ts'
import { setPreference } from '../preferences.ts'
import { projectOf } from '../sessions.ts'
import { sectionLabel, settingsSections } from '../settings/SettingsPage.tsx'
import { entrySections, entryOfSection, type SettingsSection } from '../shell/routes.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { shortcutKeys, type ShortcutId } from '../workbenchShortcuts.ts'
import { CommandPalette } from './CommandPalette.tsx'
import { recentSessions, type PaletteEntry } from './model.ts'

const glyph = (icon: LucideIcon) => <Icon icon={icon} size={16} />

/** Each settings section, in the order of the page, with the words it also answers to. */
const SETTINGS_ROWS: ReadonlyArray<{ section: SettingsSection; keywords?: string }> = [
  { section: 'general', keywords: '外观 主题 通知 发送键 用量' },
  { section: 'providers', keywords: '模型 密钥' },
  { section: 'engines', keywords: 'agent' },
  { section: 'workspaces', keywords: '文件夹' },
  { section: 'plugins' },
  { section: 'shortcuts', keywords: '键盘' },
  { section: 'devices', keywords: '手机 配对' },
  { section: 'about', keywords: '版本 许可' },
]

/** The palette over the shell: what this device can reach now, and only that. */
export function ShellPalette({ shell }: { shell: ShellState }) {
  const {
    snapshot,
    catalog,
    access,
    route,
    setRoute,
    phone,
    drawerMode,
    summary,
    selectedId,
    choose,
    canViewChanges,
    openChangesTab,
    toggleSidebar,
    togglePanel,
    startNew,
    openSettings,
    openAgentPage,
    copyTask,
    exportTask,
    canBrowseFiles,
    browseFiles,
    fileTabs,
    fileContext,
    openFile,
    setInfoPage,
    setColumnOpen,
    setFindOpen,
    nextApproval,
    selectSearchHit,
    commandMode,
    closePalette,
  } = shell
  const desktop = currentShell() !== null
  const keys = (id: ShortcutId) => {
    const value = shortcutKeys(id, desktop)
    return value ? { shortcut: value } : {}
  }
  /** A command for the open session, whose columns a page entry hides: it goes back to them to show its result. */
  const inSession = (run: () => void) => () => {
    setRoute({ entry: 'sessions' })
    run()
  }

  const allowed = settingsSections(snapshot, access)
  const canSearchFiles =
    catalog?.features?.fileSearch === true && catalog.features.filePreview === true && snapshot.device.dataScope === 'all'
  const canDefineAgents = allowed.includes('engines')

  const folders = summary?.folders
  const fileRootName = useCallback(
    (root: string) =>
      folders
        ?.find(folder => folder.id === root)
        ?.path.split('/')
        .findLast(Boolean) ?? root,
    [folders],
  )

  const sessionEntry = useMemo(() => {
    const workspaces = catalog?.workspaces ?? []
    return (task: (typeof snapshot.tasks)[number]): PaletteEntry => {
      const project = projectOf(task, workspaces)
      const harness = catalog?.harnesses.find(item => item.id === task.harnessId)
      const sub = [project?.name, task.archived ? '已归档' : ''].filter(Boolean).join(' · ')
      return {
        id: `session:${task.id}`,
        label: task.title || '未命名会话',
        ...(sub ? { sub } : {}),
        icon: harness ? <HarnessTile harness={harness} size={16} /> : <MarkTile mark={presetOf(task.harnessId, HARNESS_MARKS)} size={16} />,
        run: () => {
          choose(task.id)
        },
      }
    }
  }, [catalog?.workspaces, catalog?.harnesses, choose])
  const recent = useMemo(() => recentSessions(snapshot.tasks).map(sessionEntry), [snapshot.tasks, sessionEntry])
  const sessions = useMemo(
    () => snapshot.tasks.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(sessionEntry),
    [snapshot.tasks, sessionEntry],
  )

  const agents: PaletteEntry[] = allowed.includes('engines')
    ? (catalog?.harnesses ?? [])
        .filter(harness => harness.editable || harness.offer)
        .map(harness => ({
          id: `agent:${harness.id}`,
          label: harnessName(harness),
          icon: <HarnessTile harness={harness} size={16} />,
          run: () => {
            openAgentPage({ kind: 'agent', id: harness.id })
          },
        }))
    : []

  const settings: PaletteEntry[] = SETTINGS_ROWS.filter(
    row => allowed.includes(row.section) && entrySections(entryOfSection(row.section, phone), phone).includes(row.section),
  ).map(row => ({
    id: `settings:${row.section}`,
    label: sectionLabel(row.section),
    ...(row.keywords ? { keywords: row.keywords } : {}),
    icon: glyph(Settings),
    run: () => {
      openSettings(row.section)
    },
  }))

  const commands: PaletteEntry[] = [
    ...(snapshot.approvals.length
      ? [
          {
            id: 'approval',
            label: '下一个等你处理的请求',
            icon: glyph(ArrowRightToLine),
            root: true,
            ...keys('next-approval'),
            run: nextApproval,
          },
        ]
      : []),
    { id: 'new', label: '新会话', icon: glyph(SquarePen), root: true, ...keys('new'), run: startNew },
    ...(canViewChanges
      ? [{ id: 'changes', label: '打开改动', icon: glyph(FileDiff), root: true, ...keys('changes'), run: inSession(openChangesTab) }]
      : []),
    ...(drawerMode && route.entry !== 'sessions'
      ? []
      : [{ id: 'sidebar', label: '收起或展开侧栏', icon: glyph(PanelLeft), root: true, ...keys('sidebar'), run: toggleSidebar }]),
    ...(canDefineAgents
      ? [
          {
            id: 'new-agent',
            label: '添加 Harness',
            keywords: '新建 Harness',
            icon: glyph(Bot),
            root: true,
            run: () => {
              openAgentPage({ kind: 'presets' })
            },
          },
        ]
      : []),
    {
      id: 'settings',
      label: '设置',
      icon: glyph(Settings),
      root: true,
      ...keys('settings'),
      run: () => {
        openSettings()
      },
    },
    ...(selectedId
      ? [
          {
            id: 'find',
            label: '在当前会话中查找',
            icon: glyph(Search),
            ...keys('find'),
            run: inSession(() => {
              setFindOpen(true)
            }),
          },
        ]
      : []),
    ...(summary
      ? [
          { id: 'info', label: '展开或收起侧边面板', icon: glyph(PanelRight), ...keys('side-panel'), run: inSession(togglePanel) },
          {
            id: 'copy',
            label: '复制当前会话为 Markdown',
            icon: glyph(ClipboardCopy),
            run: () => {
              void copyTask(summary)
            },
          },
          {
            id: 'export',
            label: '导出当前会话为 Markdown',
            icon: glyph(Download),
            run: () => {
              void exportTask(summary)
            },
          },
        ]
      : []),
    ...(canBrowseFiles
      ? [
          { id: 'files', label: '浏览项目文件', icon: glyph(FolderTree), ...keys('files'), run: inSession(browseFiles) },
          ...(canSearchFiles
            ? [
                {
                  id: 'file-search',
                  label: '搜索项目文件',
                  icon: glyph(FileSearch),
                  ...keys('file-search'),
                  level: 'files' as const,
                  run: () => {},
                },
              ]
            : []),
        ]
      : []),
    ...fileTabs.tabs.map(tab => ({
      id: `file:${tab.id}`,
      label: `切换文件：${tab.file?.name ?? tab.target.reference}`,
      icon: glyph(FileIcon),
      run: inSession(() => {
        fileTabs.select(tab.id)
        setInfoPage(true)
        setColumnOpen(true)
      }),
    })),
    ...(['system', 'light', 'dark'] as const).map(theme => ({
      id: `theme:${theme}`,
      label: `外观：${{ system: '跟随系统', light: '浅色', dark: '深色' }[theme]}`,
      icon: glyph(SunMoon),
      run: () => {
        setPreference('theme', theme)
      },
    })),
  ]

  return (
    <CommandPalette
      level={commandMode}
      recent={recent}
      sessions={sessions}
      agents={agents}
      settings={settings}
      commands={commands}
      searchMessages={catalog?.features?.search === true}
      fileContext={canSearchFiles && fileContext ? fileContext : undefined}
      fileRootName={fileRootName}
      onOpenFile={openFile}
      onSearchHit={selectSearchHit}
      onClose={closePalette}
    />
  )
}
