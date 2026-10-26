import { useCallback, useEffect, useState } from 'react'
import { Lock, RefreshCw } from 'lucide-react'
import type { PluginInfo, AppSnapshot } from '@latch/protocol'
import type { DeviceAccess } from '../core/permissions.ts'
import { BUILTIN_HARNESS_NAME } from '../composerChoice.ts'
import { api, errorMessage } from '../core/api.ts'
import { Badge, Button, Icon, InlineNotice, StatusPill, Switch } from '@latch/ui'
import { Loading, NavRow, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { PluginAssetsSettings } from './PluginAssetsSettings.tsx'

type Group = 'package' | 'harness' | 'provider' | 'tool' | 'ui' | 'other'
const groups: Array<{ id: Group; label: string }> = [
  { id: 'package', label: '插件包' },
  { id: 'harness', label: 'Harness' },
  { id: 'provider', label: '模型' },
  { id: 'tool', label: '工具' },
  { id: 'ui', label: '界面' },
  { id: 'other', label: '其他' },
]
const capabilityLabels: Record<string, string> = {
  harness: 'Harness',
  provider: '模型',
  tool: '工具',
  ui: '界面',
  skill: '技能',
  data: '数据',
}
/** Where a plugin that settings manages for the person is turned on and off. */
export type PluginManager = 'providers' | 'agents'
const managers: Record<'provider' | 'agent', { section: PluginManager; label: string }> = {
  provider: { section: 'providers', label: '在模型服务中管理' },
  agent: { section: 'agents', label: '在 Agent 成员中管理' },
}

function groupOf(plugin: PluginInfo): Group {
  if (plugin.package) return 'package'
  const kinds = plugin.capabilities.map(capability => capability.split(':')[0])
  return kinds.includes('harness')
    ? 'harness'
    : kinds.includes('provider')
      ? 'provider'
      : kinds.includes('tool')
        ? 'tool'
        : kinds.includes('ui')
          ? 'ui'
          : 'other'
}

const capabilityText = (plugin: PluginInfo) => {
  const counts = new Map<string, number>()
  for (const capability of plugin.capabilities) {
    const kind = capability.split(':')[0] ?? ''
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts].map(([kind, count]) => `${capabilityLabels[kind] ?? kind} ${count}`).join(' · ')
}

/** Why a plugin's switch is locked while sessions run on it. */
const pluginInUseText = (sessions: number) => `有 ${sessions} 个会话正在使用，结束后才能停用`

/** The built-in harness's plugin, named as the harness is even when an older Host still says 「Standard Harness」. */
export const pluginName = (plugin: Pick<PluginInfo, 'name' | 'capabilities'>) =>
  plugin.capabilities.includes('harness:standard') ? BUILTIN_HARNESS_NAME : plugin.name

/**
 * One plugin: its name and version, one line about it (what it does, or why it cannot be turned off right now) with
 * what it provides in the tooltip, and at its end what can be done with it here: a switch, a way to the section that
 * manages it, or the fact that it is built in.
 */
function PluginRow({
  plugin,
  busy,
  onToggle,
  onManage,
}: {
  plugin: PluginInfo
  busy: boolean
  onToggle: () => void
  onManage: (section: PluginManager) => void
}) {
  const provides = plugin.capabilities.length > 0 ? `提供 ${capabilityText(plugin)}` : ''
  // The Host counts running sessions only; a harness that is loaded with nothing running is not in use.
  const inUse = plugin.enabled && plugin.activeRuns > 0
  // Only a switch here can be held by sessions in use; a built-in or managed plugin is turned off elsewhere or never.
  const reason = inUse && plugin.managed === undefined ? pluginInUseText(plugin.activeRuns) : undefined
  const name = pluginName(plugin)
  const title = (
    <span className="settings-row-name">
      {name}
      <span className="plugin-version">v{plugin.version}</span>
      {/* 「Latch 内置」 already says it is built in. */}
      {plugin.managed === 'core' && !name.includes('内置') && <Badge>内置</Badge>}
      {inUse && <StatusPill>使用中</StatusPill>}
    </span>
  )
  const description = (
    <span title={[plugin.description, provides].filter(Boolean).join('\n') || undefined}>{reason ?? (plugin.description || provides)}</span>
  )
  if (plugin.managed === 'provider' || plugin.managed === 'agent') {
    const manager = managers[plugin.managed]
    return (
      <NavRow
        className="plugin-row"
        record
        title={title}
        description={description}
        value={manager.label}
        onClick={() => {
          onManage(manager.section)
        }}
      />
    )
  }
  return (
    <SettingsRow
      className="plugin-row"
      record
      title={title}
      description={description}
      trailing={
        plugin.editable ? (
          <span className="settings-row-value">在 Mac 上编辑</span>
        ) : plugin.managed === 'core' ? (
          <span className="settings-row-value">始终启用</span>
        ) : (
          <>
            {reason && <Icon icon={Lock} size={12} className="plugin-lock" />}
            <Switch
              label={name}
              checked={plugin.enabled}
              disabled={busy || reason !== undefined}
              title={reason}
              onCheckedChange={onToggle}
            />
          </>
        )
      }
    />
  )
}

export function PluginsSettings({
  onManage,
  snapshot,
  access,
  onChanged,
}: {
  onManage: (section: PluginManager) => void
  snapshot: AppSnapshot
  access: DeviceAccess
  onChanged: () => void
}) {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [ownedIds, setOwnedIds] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
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

  const heading = (
    <SectionHeading
      title="插件"
      description="组合技能、工具、界面与执行方式，按你的工作习惯扩展 Latch。插件在运行 Latch 的电脑上加载，在这里统一管理。"
      action={
        <Button
          disabled={busy !== null}
          onClick={() => {
            setError('')
            void load()
          }}
          icon={RefreshCw}>
          刷新
        </Button>
      }
    />
  )
  if (plugins === null)
    return (
      <>
        {heading}
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : <Loading label="正在读取插件…" />}
      </>
    )
  return (
    <>
      {heading}
      {snapshot.catalog?.features?.pluginPackages && (
        <PluginAssetsSettings
          canEdit={access.local && access.admin && access.device?.dataScope === 'all'}
          onOwned={setOwnedIds}
          onChanged={() => {
            void load()
            onChanged()
          }}
        />
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {plugins.length === 0 && <p className="settings-empty">执行端目前没有可管理的插件。</p>}
      {groups.map(group => {
        const members = plugins.filter(plugin => !ownedIds.includes(plugin.id) && groupOf(plugin) === group.id)
        if (members.length === 0) return null
        return (
          <SettingsGroup key={group.id} title={group.label} meta={`${members.length} 个插件`}>
            {members.map(plugin => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                busy={busy !== null}
                onManage={onManage}
                onToggle={() => {
                  void toggle(plugin)
                }}
              />
            ))}
          </SettingsGroup>
        )
      })}
    </>
  )
}
