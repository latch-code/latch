import { useShortcutBindings } from '../core/shortcutBindings.ts'
import { useCallback, useMemo } from 'react'
import { readsProjectFiles } from '@latch/protocol'
import {
  ChartNoAxesColumn,
  ClipboardCopy,
  FileSearch,
  FolderTree,
  ArrowRightToLine,
  SunMoon,
  Eraser,
  GitFork,
  MessageCircle,
  MessagesSquare,
  Shield,
  SquareKanban,
} from 'lucide-react'
import {
  Icon,
  type IconComponent,
  CodeGlyph,
  DownloadGlyph,
  DiffGlyph,
  FileGlyph,
  GlobeGlyph,
  PanelLeftGlyph,
  PanelRightGlyph,
  SearchGlyph,
  TerminalGlyph,
  SettingsGlyph,
  NewSessionGlyph,
  HarnessGlyph,
  ModelGlyph,
  ReasonGlyph,
} from '@latch/ui'
import { HARNESS_MARKS, presetOf } from '../brands.ts'
import { harnessName } from '../composerChoice.ts'
import { HarnessTile, MarkTile } from '../components/BrandTile.tsx'
import { currentShell } from '../core/shell.ts'
import { BACKDROP_CHOICES, DENSITY_CHOICES, MOTION_CHOICES, backdropLevel, setPreference, toggleWorkView } from '../preferences.ts'
import { projectOf } from '../sessions.ts'
import { sectionLabel, settingsSections } from '../settings/SettingsPage.tsx'
import { settingsSectionsAt, type SettingsSection } from '../shell/routes.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { composerActions } from '../shell/composerActions.ts'
import { shortcutKeys, type ShortcutId } from '../workbenchShortcuts.ts'
import { AgentAvatar, AgentsGlyph } from '../agents/AgentAvatar.tsx'
import { openUsage } from '../usage/surface.ts'
import { CommandPalette } from './CommandPalette.tsx'
import { recentSessions, type PaletteEntry } from './model.ts'
import { defineCopy, useLocale } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    generalKeywords: '外观 主题 通知 发送键',
    providerKeywords: '模型 密钥',
    projectKeywords: '文件夹',
    deviceKeywords: '手机 连接手机 配对 浏览器',
    shortcutKeywords: '键盘',
    aboutKeywords: '版本 许可',
    archived: '已归档',
    untitled: '未命名会话',
    nextAttention: '下一个等你处理的请求',
    agents: '我的 Agent',
    browser: '浏览器',
    terminal: '终端',
    sidebar: '收起或展开侧栏',
    addHarness: '添加 Harness',
    harnessKeywords: '新建 Harness',
    settings: '设置',
    usage: '额度与用量',
    usageKeywords: '额度 用量 tokens 花费 预算 限额',
    find: '在当前会话中查找',
    sidePanel: '展开或收起侧边面板',
    copy: '复制当前会话为 Markdown',
    export: '导出当前会话为 Markdown',
    browseFiles: '浏览项目文件',
    searchFiles: '搜索项目文件',
    switchFile: (name: string) => `切换文件：${name}`,
    toChat: '切换到对话',
    toBoard: '切换到看板',
    theme: (label: string) => `外观：${label}`,
    system: '跟随系统',
    light: '浅色',
    dark: '深色',
    current: '当前',
    backdrop: (label: string) => `背景效果：${label}`,
    backdropKeywords: '外观 粒子',
    motion: (label: string) => `动效：${label}`,
    motionKeywords: '外观 动画',
    density: (label: string) => `密度：${label}`,
    appearanceKeywords: '外观',
  },
  {
    generalKeywords: 'appearance theme notifications send key language',
    providerKeywords: 'models keys',
    projectKeywords: 'folders',
    deviceKeywords: 'phone connect pair browser',
    shortcutKeywords: 'keyboard',
    aboutKeywords: 'version license',
    archived: 'Archived',
    untitled: 'Untitled session',
    nextAttention: 'Next request that needs you',
    agents: 'My Agents',
    browser: 'Browser',
    terminal: 'Terminal',
    sidebar: 'Toggle sidebar',
    addHarness: 'Add Harness',
    harnessKeywords: 'new harness',
    settings: 'Settings',
    usage: 'Limits and usage',
    usageKeywords: 'limits usage tokens cost budget',
    find: 'Find in current session',
    sidePanel: 'Toggle side panel',
    copy: 'Copy current session as Markdown',
    export: 'Export current session as Markdown',
    browseFiles: 'Browse project files',
    searchFiles: 'Search project files',
    switchFile: (name: string) => `Switch file: ${name}`,
    toChat: 'Switch to chat',
    toBoard: 'Switch to board',
    theme: (label: string) => `Appearance: ${label}`,
    system: 'Follow system',
    light: 'Light',
    dark: 'Dark',
    current: 'Current',
    backdrop: (label: string) => `Backdrop: ${label}`,
    backdropKeywords: 'appearance particles',
    motion: (label: string) => `Motion: ${label}`,
    motionKeywords: 'appearance animation',
    density: (label: string) => `Density: ${label}`,
    appearanceKeywords: 'appearance',
  },
)

const glyph = (icon: IconComponent) => <Icon icon={icon} size={16} />

/** Each settings section, in the order of the page, with the words it also answers to. */
const SETTINGS_ROWS: ReadonlyArray<{ section: SettingsSection; keywords?: string }> = [
  {
    section: 'general',
    get keywords() {
      return COPY.generalKeywords
    },
  },
  {
    section: 'providers',
    get keywords() {
      return COPY.providerKeywords
    },
  },
  { section: 'engines', keywords: 'agent' },
  {
    section: 'workspaces',
    get keywords() {
      return COPY.projectKeywords
    },
  },
  { section: 'plugins' },
  {
    section: 'devices',
    get keywords() {
      return COPY.deviceKeywords
    },
  },
  {
    section: 'shortcuts',
    get keywords() {
      return COPY.shortcutKeywords
    },
  },
  {
    section: 'about',
    get keywords() {
      return COPY.aboutKeywords
    },
  },
]

/** The palette over the shell: what this device can reach now, and only that. */
export function ShellPalette({ shell }: { shell: ShellState }) {
  const locale = useLocale()
  useShortcutBindings()
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
    canBrowser,
    showSurface,
    toggleSidebar,
    togglePanel,
    openSettings,
    openAgentPage,
    copyTask,
    exportTask,
    canBrowseFiles: canBrowseReadingFiles,
    browseFiles,
    fileTabs: readingFileTabs,
    fileContext: readingFileContext,
    openFile,
    setInfoPage,
    setColumnOpen,
    setFindOpen,
    nextApproval,
    selectSearchHit,
    commandMode,
    closePalette,
  } = shell
  const fileContext = route.start ? shell.draftFileContext : readingFileContext
  const fileTabs = route.start ? shell.draftFileTabs : readingFileTabs
  const canBrowseFiles = route.start ? shell.canBrowseDraftFiles : canBrowseReadingFiles
  const desktop = currentShell() !== null
  const keys = (id: ShortcutId) => {
    const value = shortcutKeys(id, desktop)
    return value ? { shortcut: value } : {}
  }
  /** A command for the open session, whose columns a page entry or 看板 hides: it goes back to them to show its result. */
  const inSession = (run: () => void) => () => {
    shell.showChat()
    setRoute({ entry: 'sessions' })
    run()
  }

  const allowed = settingsSections(snapshot, access)
  const canSearchFiles =
    catalog?.features?.fileSearch === true && catalog.features.filePreview === true && readsProjectFiles(snapshot.device.dataScope)
  const canDefineAgents = allowed.includes('engines')

  const folders = route.start ? catalog?.workspaces.find(item => item.id === shell.choice.workspaceId)?.folders : summary?.folders
  const fileRootName = useCallback(
    (root: string) =>
      folders
        ?.find(folder => folder.id === root)
        ?.path.split('/')
        .findLast(Boolean) ?? root,
    [folders],
  )

  const customAgents = snapshot.customAgents
  const myAgents: PaletteEntry[] = (customAgents ?? []).map(agent => ({
    id: `my-agent:${agent.id}`,
    label: agent.name,
    ...(agent.description ? { sub: agent.description } : {}),
    icon: <AgentAvatar avatar={agent.avatar} size={16} />,
    run: () => {
      shell.openMyAgent({ id: agent.id })
    },
  }))
  const spaces = shell.entries.includes('agents')
  const sessionEntry = useMemo(() => {
    const workspaces = catalog?.workspaces ?? []
    return (task: (typeof snapshot.tasks)[number]): PaletteEntry => {
      const project = projectOf(task, workspaces)
      const harness = catalog?.harnesses.find(item => item.id === task.harnessId)
      // Where it lives: Code, or the Agent it was delegated to (found by the Agent's name as well).
      const owner = task.agent ? customAgents?.find(item => item.id === task.agent?.customAgentId) : undefined
      const agent = task.agent ? (owner?.name ?? 'Agent') : undefined
      const sub = [agent, project?.name, task.archived ? COPY.archived : ''].filter(Boolean).join(' · ')
      return {
        id: `session:${task.id}`,
        codeSession: spaces && !task.agent,
        label: task.title || COPY.untitled,
        ...(sub ? { sub } : {}),
        ...(agent ? { keywords: agent } : {}),
        icon: task.agent ? (
          <AgentAvatar avatar={owner?.avatar ?? 'general'} size={16} />
        ) : harness ? (
          <HarnessTile harness={harness} size={16} />
        ) : (
          <MarkTile mark={presetOf(task.harnessId, HARNESS_MARKS)} size={16} />
        ),
        run: () => {
          choose(task.id)
        },
      }
    }
  }, [catalog?.workspaces, catalog?.harnesses, customAgents, choose, spaces, locale])
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
    row => allowed.includes(row.section) && settingsSectionsAt(phone).includes(row.section),
  ).map(row => ({
    id: `settings:${row.section}`,
    label: sectionLabel(row.section),
    ...(row.keywords ? { keywords: row.keywords } : {}),
    icon: glyph(SettingsGlyph),
    run: () => {
      openSettings(row.section)
    },
  }))

  const commands: PaletteEntry[] = [
    ...(snapshot.approvals.length
      ? [
          {
            id: 'approval',
            label: COPY.nextAttention,
            icon: glyph(ArrowRightToLine),
            root: true,
            ...keys('next-approval'),
            run: nextApproval,
          },
        ]
      : []),
    ...(spaces
      ? [
          {
            id: 'space:code',
            label: 'Code',
            icon: glyph(CodeGlyph),
            root: true,
            ...keys('space-code'),
            run: () => {
              shell.goSpace('code')
            },
          },
          {
            id: 'space:agents',
            label: COPY.agents,
            icon: glyph(AgentsGlyph),
            root: true,
            ...keys('space-agents'),
            run: () => {
              shell.goSpace('agents')
            },
          },
        ]
      : []),
    ...composerActions(
      shell.inputTarget === 'new' ? { ...shell, ...shell.homeComposerState, composerRef: shell.homeComposerRef } : shell,
      'palette',
    )
      .filter(action => !action.unavailable)
      .map(action => ({
        id: action.name,
        label: action.label,
        keywords: '/' + action.name,
        icon: glyph(
          {
            clear: Eraser,
            btw: MessageCircle,
            fork: GitFork,
            new: NewSessionGlyph,
            model: ModelGlyph,
            think: ReasonGlyph,
            permissions: Shield,
            changes: DiffGlyph,
          }[action.name],
        ),
        root: action.name === 'new' || action.name === 'changes',
        ...(action.name === 'new' || action.name === 'changes' ? keys(action.name) : {}),
        run: inSession(() => action.run?.()),
      })),
    ...(canBrowser
      ? [
          {
            id: 'browser',
            label: COPY.browser,
            icon: glyph(GlobeGlyph),
            root: true,
            ...keys('browser'),
            run: inSession(() => showSurface({ kind: 'browser' })),
          },
        ]
      : []),
    ...(shell.canTerminal
      ? [{ id: 'terminal', label: COPY.terminal, icon: glyph(TerminalGlyph), root: true, ...keys('terminal'), run: shell.toggleTerminal }]
      : []),
    ...(drawerMode && route.entry !== 'sessions'
      ? []
      : [{ id: 'sidebar', label: COPY.sidebar, icon: glyph(PanelLeftGlyph), root: true, ...keys('sidebar'), run: toggleSidebar }]),
    ...(canDefineAgents
      ? [
          {
            id: 'new-agent',
            label: COPY.addHarness,
            keywords: COPY.harnessKeywords,
            icon: glyph(HarnessGlyph),
            root: true,
            run: () => {
              openAgentPage({ kind: 'presets' })
            },
          },
        ]
      : []),
    {
      id: 'settings',
      label: COPY.settings,
      icon: glyph(SettingsGlyph),
      root: true,
      ...keys('settings'),
      run: () => {
        openSettings()
      },
    },
    ...(access.scopes.has('view')
      ? [
          {
            id: 'usage',
            label: COPY.usage,
            keywords: COPY.usageKeywords,
            icon: glyph(ChartNoAxesColumn),
            root: true,
            ...keys('usage'),
            run: () => {
              closePalette()
              openUsage({ view: 'limits' })
            },
          },
        ]
      : []),
    ...(selectedId
      ? [
          {
            id: 'find',
            label: COPY.find,
            icon: glyph(SearchGlyph),
            ...keys('find'),
            run: inSession(() => {
              setFindOpen(true)
            }),
          },
        ]
      : []),
    ...(summary
      ? [
          {
            id: 'info',
            label: COPY.sidePanel,
            icon: glyph(PanelRightGlyph),
            ...keys('side-panel'),
            run: inSession(() => togglePanel(true)),
          },
          {
            id: 'copy',
            label: COPY.copy,
            icon: glyph(ClipboardCopy),
            run: () => {
              void copyTask(summary)
            },
          },
          {
            id: 'export',
            label: COPY.export,
            icon: glyph(DownloadGlyph),
            run: () => {
              void exportTask(summary)
            },
          },
        ]
      : []),
    ...(canBrowseFiles
      ? [
          {
            id: 'files',
            label: COPY.browseFiles,
            icon: glyph(FolderTree),
            ...keys('files'),
            run: route.start ? browseFiles : inSession(browseFiles),
          },
          ...(canSearchFiles
            ? [
                {
                  id: 'file-search',
                  label: COPY.searchFiles,
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
      label: COPY.switchFile(tab.file?.name ?? tab.target.reference),
      icon: glyph(FileGlyph),
      run: route.start
        ? () => {
            fileTabs.select(tab.id)
            shell.setDraftFilesOpen(true)
          }
        : inSession(() => {
            fileTabs.select(tab.id)
            setInfoPage(true)
            setColumnOpen(true)
          }),
    })),
    {
      id: 'view',
      label: shell.board ? COPY.toChat : COPY.toBoard,
      icon: glyph(shell.board ? MessagesSquare : SquareKanban),
      root: true,
      ...keys('view'),
      run: toggleWorkView,
    },
    ...(['system', 'light', 'dark'] as const).map(theme => ({
      id: `theme:${theme}`,
      label: COPY.theme({ system: COPY.system, light: COPY.light, dark: COPY.dark }[theme]),
      ...(shell.preferences.theme === theme ? { sub: COPY.current } : {}),
      icon: glyph(SunMoon),
      run: () => {
        setPreference('theme', theme)
      },
    })),
    ...BACKDROP_CHOICES.map(({ value, label }) => ({
      id: `backdrop:${value}`,
      label: COPY.backdrop(label),
      ...(backdropLevel(shell.preferences, shell.phone) === value ? { sub: COPY.current } : {}),
      keywords: COPY.backdropKeywords,
      icon: glyph(SunMoon),
      run: () => setPreference('backdrop', value),
    })),
    ...MOTION_CHOICES.map(({ value, label }) => ({
      id: `motion:${value}`,
      label: COPY.motion(label),
      ...(shell.preferences.motion === value ? { sub: COPY.current } : {}),
      keywords: COPY.motionKeywords,
      icon: glyph(SunMoon),
      run: () => setPreference('motion', value),
    })),
    ...DENSITY_CHOICES.map(({ value, label }) => ({
      id: `density:${value}`,
      label: COPY.density(label),
      ...(shell.preferences.density === value ? { sub: COPY.current } : {}),
      keywords: COPY.appearanceKeywords,
      icon: glyph(SunMoon),
      run: () => setPreference('density', value),
    })),
  ]

  return (
    <CommandPalette
      level={commandMode}
      recent={recent}
      sessions={sessions}
      agents={agents}
      myAgents={myAgents}
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
