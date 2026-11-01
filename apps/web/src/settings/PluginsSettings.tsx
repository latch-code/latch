import { useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ArrowLeftRight, BookOpen, Plus, Wrench } from 'lucide-react'
import type { AppSnapshot, PluginInfo, PluginPackageManifest, PluginPackageSummary } from '@latch/protocol'
import { api, errorMessage } from '../core/api.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { Button, EmptyState, IconButton, InlineNotice, Switch, type LucideIcon } from '@latch/ui'
import { IconTile, Loading, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { NavigationContext, SettingsPages } from './navigation.tsx'
import { packageState, PluginReachGroup, usePluginAssets } from './PluginAssetsSettings.tsx'
import { packageReach, pluginReach, type PluginReach } from './pluginAssets.ts'

type Shelf = 'tool' | 'skill' | 'connection'
const SHELVES: Array<{ id: Shelf; label: string; icon: LucideIcon }> = [
  { id: 'tool', label: '工具', icon: Wrench },
  { id: 'skill', label: '技能', icon: BookOpen },
  { id: 'connection', label: '连接', icon: ArrowLeftRight },
]
const CAPABILITY_LABELS: Record<string, string> = {
  harness: 'Harness',
  provider: '模型服务',
  tool: '工具',
  ui: '界面',
  skill: '技能',
  data: '数据',
  transport: '连接',
}
const kindsOf = (capabilities: readonly string[]) => capabilities.map(capability => capability.split(':')[0])

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
  return [...counts].map(([kind, count]) => `${CAPABILITY_LABELS[kind] ?? kind} ${count}`).join(' · ')
}

/** One row of a shelf, whichever source it came from. */
type Item = { key: string; name: string; state: string; attention: boolean; shelf: Shelf } & (
  | { kind: 'plugin'; plugin: PluginInfo }
  | { kind: 'package'; record: PluginPackageSummary; plugin?: PluginInfo }
)

/** What 设置 › 模型 and 设置 › Harness already list. A person's own package offering either is still a plugin. */
function managedElsewhere(plugin: PluginInfo): boolean {
  if (plugin.managed === 'provider' || plugin.managed === 'agent') return true
  return plugin.managed === 'core' && kindsOf(plugin.capabilities).some(kind => kind === 'harness' || kind === 'provider')
}

function pluginState(plugin: PluginInfo): string {
  if (plugin.managed === 'core') return '始终开启'
  return plugin.enabled ? '已开启' : '未开启'
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
        name: plugin.name,
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
          <section key={shelf.id} className="plugin-shelf" aria-label={shelf.label}>
            <header className="plugin-shelf-head">
              <h3>{shelf.label}</h3>
              {add && <IconButton size="xs" label="添加插件…" tooltip="添加插件…" icon={Plus} onClick={add} />}
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
                    {item.attention ? '需要处理' : item.state}
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
const inUseText = (sessions: number) => `有 ${sessions} 个会话正在使用，结束后才能停用`

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
}) {
  // A phone's page has the name in its bar.
  const { phone } = useContext(NavigationContext)
  const plugin = item.plugin
  const record = item.kind === 'package' ? item.record : undefined
  const version = record?.version ?? plugin?.version
  const description = record?.description ?? plugin?.description
  const capabilities = record?.capabilities ?? plugin?.capabilities ?? []
  const reason = plugin?.enabled && plugin.activeRuns > 0 && plugin.managed === undefined ? inUseText(plugin.activeRuns) : undefined
  // A package has its own switch once a revision is applied: taking it back should not need its editor.
  const appliedPackage = record?.appliedRevision && canEdit ? record : undefined
  const canSwitch = appliedPackage !== undefined || (plugin !== undefined && plugin.managed !== 'core' && !plugin.editable)
  const control: ReactNode = canSwitch && (
    <Switch
      label={`启用 ${item.name}`}
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
      <SettingsGroup title="设置">
        {canSwitch ? <SettingsRow title={item.state} description={reason} trailing={control} /> : <SettingsRow title={item.state} />}
        {version && <SettingsRow title="版本" trailing={<span className="settings-row-value">{version}</span>} />}
        {capabilities.length > 0 && (
          <SettingsRow title="提供" trailing={<span className="settings-row-value">{provides(capabilities)}</span>} />
        )}
        {plugin?.editable && !record && <SettingsRow title="内容" description="在 Mac 上的 Latch 里编辑" />}
        {record && canEdit && (
          <SettingsRow
            title="内容"
            trailing={
              <Button
                onClick={() => {
                  onEdit(record)
                }}>
                编辑…
              </Button>
            }
          />
        )}
      </SettingsGroup>
      <PluginReachGroup reach={reach} {...(onRetryReach ? { onRetryRead: onRetryReach } : {})} />
    </>
  )
}

export function PluginsSettings({ snapshot, access, onChanged }: { snapshot: AppSnapshot; access: DeviceAccess; onChanged: () => void }) {
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

  if (plugins === null) return error ? <InlineNotice tone="error">{error}</InlineNotice> : <Loading label="正在读取插件…" />

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
    />
  )
  const assetsError = !assets.locked && assets.error && (
    <InlineNotice
      tone="error"
      action={
        <Button variant="ghost" onClick={assets.retry}>
          重试
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
            {items.length === 0 ? <EmptyState title="这台 Mac 还没有可管理的插件" /> : shelves}
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
