import { useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ArrowLeftRight, BookOpen, Wrench } from 'lucide-react'
import type { AppSnapshot, AppSummary, PluginInfo, PluginPackageManifest, PluginPackageSummary } from '@latch/protocol'
import { api, errorMessage } from '../core/api.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { Button, EmptyState, IconButton, InlineNotice, Switch, type IconComponent, PlusGlyph } from '@latch/ui'
import { IconTile, Loading, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { NavigationContext, SettingsPages } from './navigation.tsx'
import { packageState, PluginReachGroup, usePluginAssets } from './PluginAssetsSettings.tsx'
import { packageReach, pluginReach, type PluginReach } from './pluginAssets.ts'
import { NewApps } from './NewAppCard.tsx'
import { computerName } from '../core/securityCopy.ts'
import { DiagnosticsDialog } from '../plugin-pages/AppsPage.tsx'
import { currentLocale, defineCopy, formatNumber, plural, useLocale } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    tools: '工具',
    skills: '技能',
    connections: '连接',
    modelService: '模型服务',
    ui: '界面',
    data: '数据',
    codeSurface: '代码 · 在 Mac 上运行',
    panelSurface: '面板 · 与页面同权',
    pageSurface: '页面 · 侧栏入口',
    alwaysOn: '始终开启',
    on: '已开启',
    off: '未开启',
    add: '添加插件…',
    needsAttention: '需要处理',
    settings: '设置',
    version: '版本',
    provides: '提供',
    content: '内容',
    editOnMac: '在 Mac 上的 Latch 里编辑',
    edit: '编辑…',
    rollback: '回退',
    diagnostics: '诊断',
    loading: '正在读取插件…',
    retry: '重试',
    empty: '这台 Mac 还没有可管理的插件',
    activeSessions: (count: number) => `${formatNumber(count)} 个会话在用，结束后才能停用`,
    enable: (name: string) => `启用 ${name}`,
    rollBackTo: (version: string) => `回退到 ${version}`,
    editOnHost: (host: string) => `在 ${host} 上修改`,
  },
  {
    tools: 'Tools',
    skills: 'Skills',
    connections: 'Connections',
    modelService: 'Model service',
    ui: 'UI',
    data: 'Data',
    codeSurface: 'Code · Runs on the Mac',
    panelSurface: 'Panel · Same permissions as the page',
    pageSurface: 'Page · Available in the sidebar',
    alwaysOn: 'Always on',
    on: 'On',
    off: 'Off',
    add: 'Add plugin…',
    needsAttention: 'Needs attention',
    settings: 'Settings',
    version: 'Version',
    provides: 'Provides',
    content: 'Content',
    editOnMac: 'Edit in Latch on the Mac',
    edit: 'Edit…',
    rollback: 'Roll back',
    diagnostics: 'Diagnostics',
    loading: 'Loading plugins…',
    retry: 'Retry',
    empty: 'No plugins to manage on this Mac',
    activeSessions: (count: number) =>
      plural(count, {
        one: 'End the {n} session using this plugin to turn it off',
        other: 'End the {n} sessions using this plugin to turn it off',
      }),
    enable: (name: string) => `Turn on ${name}`,
    rollBackTo: (version: string) => `Roll back to ${version}`,
    editOnHost: (host: string) => `Edit on ${host}`,
  },
)

type Shelf = 'tool' | 'skill' | 'connection'
const SHELVES: Array<{ id: Shelf; label: 'tools' | 'skills' | 'connections'; icon: IconComponent }> = [
  { id: 'tool', label: 'tools', icon: Wrench },
  { id: 'skill', label: 'skills', icon: BookOpen },
  { id: 'connection', label: 'connections', icon: ArrowLeftRight },
]
const CAPABILITY_LABELS: Partial<Record<string, 'modelService' | 'tools' | 'ui' | 'skills' | 'data' | 'connections'>> = {
  provider: 'modelService',
  tool: 'tools',
  ui: 'ui',
  skill: 'skills',
  data: 'data',
  transport: 'connections',
}
const kindsOf = (capabilities: readonly string[]) => capabilities.map(capability => capability.split(':')[0])

const BUILTIN_NAMES: Readonly<Record<string, { name: string; englishName: string; description: string; englishDescription: string }>> = {
  'user-questions': {
    name: '向你提问',
    englishName: 'Questions for you',
    description: '内置 Agent 的选择题与多题向导；回答仅交回当前会话。',
    englishDescription: 'Multiple-choice questions from the built-in Agent. Answers go only to the current session.',
  },
  browser: {
    name: '浏览器',
    englishName: 'Browser',
    description: '内置 Agent 经这台 Mac 的 Latch 桌面端操作「浏览器」页签：只在本机地址上。',
    englishDescription: 'The built-in Agent can use the Browser tab in the Latch desktop app on this Mac, on local addresses only.',
  },
  device: {
    name: '设备',
    englishName: 'Devices',
    description:
      '内置 Agent 经 xcrun simctl 与 devicectl 查看和操作这台 Mac 上的 iOS 模拟器；点按与按键只给完全访问的外部 Harness 会话，不启动或关闭设备。',
    englishDescription:
      'Access this Mac’s iOS simulators through xcrun simctl and devicectl. Only external Harness sessions with full access can tap or press keys. These tools leave device power unchanged.',
  },
  'workspace-files': {
    name: '项目文件',
    englishName: 'Project files',
    description: '列出、读取和编辑项目各文件夹中的文件；每次写入需要审批，节点私有数据不可访问。',
    englishDescription:
      'List, read, and edit files in project folders. Each write requires approval. Private Latch data on this computer stays inaccessible.',
  },
  'safe-tools': {
    name: '安全文件工具',
    englishName: 'Safe file tools',
    description: '需要审批的报告写入，以及固定 30 秒的可取消任务；文件只能写入执行节点的 artifacts 目录。',
    englishDescription:
      'Write reports with approval and run a cancellable 30-second task. Files can only be written to the artifacts folder on this computer.',
  },
  demo: {
    name: '确定性演示模型',
    englishName: 'Deterministic demo model',
    description: '无需 API Key；通过真实工具、审批与文件产物验证执行流程。用量为演示值。',
    englishDescription: 'Try a workflow with real tools, approvals, and files without an API key. Usage figures are simulated.',
  },
}

function builtInCopy(plugin: PluginInfo) {
  if (currentLocale() !== 'en' || !(plugin.builtIn || plugin.managed === 'core') || !Object.hasOwn(BUILTIN_NAMES, plugin.id))
    return undefined
  const words = BUILTIN_NAMES[plugin.id]
  return words?.name === plugin.name ? words : undefined
}

/** The shelf a plugin stands on, named for what it does for the person; anything else with code is a tool. */
export function shelfOf(capabilities: readonly string[]): Shelf {
  const kinds = kindsOf(capabilities)
  if (kinds.includes('transport')) return 'connection'
  if (kinds.includes('skill') && !kinds.includes('tool') && !kinds.includes('ui')) return 'skill'
  return 'tool'
}

function provides(capabilities: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const kind of kindsOf(capabilities)) if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  return [...counts]
    .map(([kind, count]) => {
      const label = CAPABILITY_LABELS[kind]
      return `${label ? COPY[label] : kind === 'harness' ? 'Harness' : kind} ${formatNumber(count)}`
    })
    .join(' · ')
}

/** What a package brings and where it runs, in a few words: a page, a panel with the page's authority, or Mac code. */
export function reachLabel(record: Pick<PluginPackageSummary, 'pages' | 'capabilities'>): string | undefined {
  const kinds = kindsOf(record.capabilities)
  if (['tool', 'harness', 'provider', 'transport'].some(kind => kinds.includes(kind))) return COPY.codeSurface
  if (kinds.includes('ui')) return COPY.panelSurface
  if ((record.pages ?? 0) > 0) return COPY.pageSurface
  return undefined
}

/** One row of a shelf, whichever source it came from. */
type Item = { key: string; name: string; state: string; attention: boolean; shelf: Shelf; reach?: string } & (
  | { kind: 'plugin'; plugin: PluginInfo }
  | { kind: 'package'; record: PluginPackageSummary; plugin?: PluginInfo }
)

/** What 设置 › 模型 and 设置 › Harness already list. A person's own package offering either is still a plugin. */
function managedElsewhere(plugin: PluginInfo): boolean {
  if (plugin.managed === 'provider' || plugin.managed === 'agent') return true
  return plugin.managed === 'core' && kindsOf(plugin.capabilities).some(kind => kind === 'harness' || kind === 'provider')
}

function pluginState(plugin: PluginInfo): string {
  if (plugin.managed === 'core') return COPY.alwaysOn
  return plugin.enabled ? COPY.on : COPY.off
}

export function pluginItems(plugins: readonly PluginInfo[], records: readonly PluginPackageSummary[]): Item[] {
  const owned = new Map(records.map(record => [record.id, record]))
  return [
    ...records.map((record): Item => {
      const plugin = plugins.find(item => item.id === record.id)
      return {
        key: `package:${record.id}`,
        kind: 'package',
        record,
        ...(plugin ? { plugin } : {}),
        name: record.name,
        state: packageState(record),
        ...(reachLabel(record) ? { reach: reachLabel(record)! } : {}),
        attention: record.unavailableReason !== undefined,
        shelf: shelfOf(record.capabilities),
      }
    }),
    ...plugins
      .filter(plugin => !owned.has(plugin.id) && !managedElsewhere(plugin))
      .map((plugin): Item => ({
        key: `plugin:${plugin.id}`,
        kind: 'plugin',
        plugin,
        name: builtInCopy(plugin)?.englishName ?? plugin.name,
        state: pluginState(plugin),
        attention: false,
        shelf: shelfOf(plugin.capabilities),
      })),
  ]
}

/** The shelves with their rows: the section's list, and a row opens one plugin over it. */
function Shelves({
  items,
  selected,
  onSelect,
  onAdd,
}: {
  items: Item[]
  selected: string | null
  onSelect: (key: string) => void
  onAdd?: () => void
}) {
  return (
    <div className="plugin-shelves">
      {SHELVES.map(shelf => {
        const members = items.filter(item => item.shelf === shelf.id)
        const add = shelf.id === 'tool' ? onAdd : undefined
        if (members.length === 0 && !add) return null
        return (
          <section key={shelf.id} className="plugin-shelf" aria-label={COPY[shelf.label]}>
            <header className="plugin-shelf-head">
              <h3>{COPY[shelf.label]}</h3>
              {add && <IconButton size="xs" label={COPY.add} tooltip={COPY.add} icon={PlusGlyph} onClick={add} />}
            </header>
            {members.map(item => (
              <button
                key={item.key}
                type="button"
                className="plugin-nav-row"
                aria-current={selected === item.key || undefined}
                onClick={() => {
                  onSelect(item.key)
                }}>
                <IconTile icon={shelf.icon} />
                <span className="plugin-nav-text">
                  <span className="plugin-nav-name">{item.name}</span>
                  <span className="plugin-nav-state" data-attention={item.attention ? '' : undefined}>
                    {item.attention ? COPY.needsAttention : item.reach ? `${item.reach} · ${item.state}` : item.state}
                  </span>
                </span>
              </button>
            ))}
          </section>
        )
      })}
    </div>
  )
}

/** Why a plugin's switch is locked while sessions run on it. */
const inUseText = (sessions: number) => COPY.activeSessions(sessions)

/**
 * One plugin: what it is, what it provides, where its code runs and which devices receive it.
 */
function PluginDetail({
  item,
  busy,
  error,
  reach,
  onRetryReach,
  canEdit,
  status,
  onToggle,
  onSetPackage,
  onEdit,
  pages = [],
  onRollback,
}: {
  item: Item
  busy: boolean
  error: string
  reach: PluginReach[]
  onRetryReach?: () => void
  canEdit: boolean
  /** A package change under way or with an unknown result. */
  status: ReactNode
  onToggle: (plugin: PluginInfo) => void
  onSetPackage: (record: PluginPackageSummary, enabled: boolean) => void
  onEdit: (record: PluginPackageSummary) => void
  /** The package's applied pages, from the snapshot. */
  pages?: AppSummary[]
  onRollback?: (record: PluginPackageSummary, revision: string) => void
}) {
  const [diagnostics, setDiagnostics] = useState<AppSummary | null>(null)
  // A phone's page has the name in its bar.
  const { phone } = useContext(NavigationContext)
  const plugin = item.plugin
  const record = item.kind === 'package' ? item.record : undefined
  const version = record?.version ?? plugin?.version
  const builtIn = plugin && builtInCopy(plugin)
  const description =
    record?.description ?? (builtIn && plugin?.description === builtIn.description ? builtIn.englishDescription : plugin?.description)
  const capabilities = record?.capabilities ?? plugin?.capabilities ?? []
  const reason = plugin?.enabled && plugin.activeRuns > 0 && plugin.managed === undefined ? inUseText(plugin.activeRuns) : undefined
  // A package has its own switch once a revision is applied: taking it back should not need its editor.
  const appliedPackage = record?.appliedRevision && canEdit ? record : undefined
  const canSwitch = appliedPackage !== undefined || (plugin !== undefined && plugin.managed !== 'core' && !plugin.editable)
  const control: ReactNode = canSwitch && (
    <Switch
      label={COPY.enable(item.name)}
      checked={appliedPackage ? appliedPackage.enabled : plugin?.enabled === true}
      disabled={busy || reason !== undefined}
      title={reason}
      onCheckedChange={enabled => {
        if (appliedPackage) onSetPackage(appliedPackage, enabled)
        else if (plugin) onToggle(plugin)
      }}
    />
  )
  return (
    <>
      {!phone && <SectionHeading title={item.name} />}
      {description && <p className="plugin-description">{description}</p>}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {record?.unavailableReason && <InlineNotice tone="error">{record.unavailableReason}</InlineNotice>}
      {status}
      <SettingsGroup title={COPY.settings}>
        {canSwitch ? <SettingsRow title={item.state} description={reason} trailing={control} /> : <SettingsRow title={item.state} />}
        {version && <SettingsRow title={COPY.version} trailing={<span className="settings-row-value">{version}</span>} />}
        {capabilities.length > 0 && (
          <SettingsRow title={COPY.provides} trailing={<span className="settings-row-value">{provides(capabilities)}</span>} />
        )}
        {plugin?.editable && !record && <SettingsRow title={COPY.content} description={COPY.editOnMac} />}
        {record && canEdit && (
          <SettingsRow
            title={COPY.content}
            trailing={
              <Button
                onClick={() => {
                  onEdit(record)
                }}>
                {COPY.edit}
              </Button>
            }
          />
        )}
        {record && canEdit && onRollback && record.rollbackRevisions?.[0] && (
          <SettingsRow
            title={COPY.rollback}
            trailing={
              <Button disabled={busy} onClick={() => onRollback(record, record.rollbackRevisions![0]!.revision)}>
                {COPY.rollBackTo(record.rollbackRevisions[0].version)}
              </Button>
            }
          />
        )}
        {pages.map(page => (
          <SettingsRow
            key={page.appId}
            title={page.title}
            description={COPY.pageSurface}
            trailing={<Button onClick={() => setDiagnostics(page)}>{COPY.diagnostics}</Button>}
          />
        ))}
      </SettingsGroup>
      {diagnostics && <DiagnosticsDialog page={diagnostics} onClose={() => setDiagnostics(null)} />}
      <PluginReachGroup reach={reach} {...(onRetryReach ? { onRetryRead: onRetryReach } : {})} />
    </>
  )
}

export function PluginsSettings({
  snapshot,
  access,
  onChanged,
  onOpenSession,
  onOpenApp,
}: {
  snapshot: AppSnapshot
  access: DeviceAccess
  onChanged: () => void
  onOpenSession?: (id: string) => void
  onOpenApp?: (target: { pluginId: string; appId: string }) => void
}) {
  useLocale()
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [manifestRead, setManifestRead] = useState<{ key: string; manifest?: PluginPackageManifest } | null>(null)
  const [readAgain, setReadAgain] = useState(0)
  const load = useCallback(async () => {
    try {
      setPlugins((await api<{ plugins: PluginInfo[] }>('plugins')).plugins)
      setError('')
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const canEdit = Boolean(snapshot.catalog?.features?.pluginPackages) && access.local && access.admin && access.device?.dataScope === 'all'
  const assets = usePluginAssets({
    canEdit,
    onChanged: () => {
      void load()
      onChanged()
    },
  })

  // A build or an automatic import (开发中) changes the list without this page asking: the snapshot moves with it.
  const reload = assets.reload
  useEffect(() => {
    if (canEdit) reload()
  }, [snapshot.revision, canEdit])
  const appPages = snapshot.catalog?.features?.appPages === 1

  // The switch moving is the feedback; only a failure is said.
  const toggle = async (plugin: PluginInfo) => {
    if (busy !== null) return
    setBusy(plugin.id)
    setError('')
    try {
      setPlugins(
        (
          await api<{ plugins: PluginInfo[] }>(`plugins/${encodeURIComponent(plugin.id)}`, {
            method: 'POST',
            body: { enabled: !plugin.enabled },
          })
        ).plugins,
      )
    } catch (cause) {
      setError(errorMessage(cause))
      await load()
    } finally {
      setBusy(null)
    }
  }

  const items = pluginItems(plugins ?? [], assets.records ?? []).toSorted(
    (a, b) => SHELVES.findIndex(shelf => shelf.id === a.shelf) - SHELVES.findIndex(shelf => shelf.id === b.shelf),
  )
  const selected = items.find(item => item.key === chosen)
  const selectedRecord = selected?.kind === 'package' ? selected.record : undefined
  useEffect(() => {
    if (!selectedRecord) return undefined
    let live = true
    const key = `package:${selectedRecord.id}`
    assets.read(selectedRecord).then(
      detail => {
        if (live) setManifestRead({ key, manifest: detail.bundle.manifest })
      },
      () => {
        if (live) setManifestRead({ key })
      },
    )
    return () => {
      live = false
    }
    // Reads again when the saved content changes; `assets` is new each render.
  }, [selectedRecord?.id, selectedRecord?.revision, readAgain])
  const read = manifestRead?.key === selected?.key ? manifestRead : null
  const reach = selected ? (selected.kind === 'package' ? packageReach(read?.manifest, selected.record) : pluginReach(selected.plugin)) : []
  const readFailed = selected?.kind === 'package' && read !== null && read.manifest === undefined

  if (plugins === null) return error ? <InlineNotice tone="error">{error}</InlineNotice> : <Loading label={COPY.loading} />

  const shelves = (
    <Shelves items={items} selected={selected?.key ?? null} onSelect={setChosen} {...(canEdit ? { onAdd: assets.add } : {})} />
  )
  const detail = selected && (
    <PluginDetail
      item={selected}
      busy={busy !== null || assets.locked}
      error={error}
      reach={reach}
      {...(readFailed
        ? {
            onRetryReach: () => {
              setManifestRead(null)
              setReadAgain(count => count + 1)
            },
          }
        : {})}
      canEdit={canEdit}
      status={assets.pageStatus}
      onToggle={plugin => {
        void toggle(plugin)
      }}
      onSetPackage={assets.setEnabled}
      onEdit={assets.open}
      pages={(snapshot.apps ?? []).filter(page => selected.kind === 'package' && page.pluginId === selected.record.id)}
      onRollback={assets.rollback}
    />
  )
  const assetsError = !assets.locked && assets.error && (
    <InlineNotice
      tone="error"
      action={
        <Button variant="ghost" onClick={assets.retry}>
          {COPY.retry}
        </Button>
      }>
      {assets.error}
    </InlineNotice>
  )
  return (
    <>
      <SettingsPages
        main={
          <>
            {error && !selected && <InlineNotice tone="error">{error}</InlineNotice>}
            {assetsError}
            {canEdit && appPages && assets.records && (
              <NewApps
                records={assets.records}
                snapshot={snapshot}
                onChanged={() => {
                  assets.reload()
                  onChanged()
                }}
                {...(onOpenSession ? { onOpenSession } : {})}
                {...(onOpenApp ? { onOpenApp } : {})}
              />
            )}
            {!canEdit && appPages && <p className="settings-empty">{COPY.editOnHost(computerName(snapshot.hostName))}</p>}
            {items.length === 0 ? <EmptyState title={COPY.empty} /> : shelves}
          </>
        }
        levels={
          selected
            ? [
                {
                  key: selected.key,
                  title: selected.name,
                  onBack: () => {
                    setChosen(null)
                  },
                  content: detail,
                },
              ]
            : []
        }
      />
      {assets.dialogs}
    </>
  )
}
