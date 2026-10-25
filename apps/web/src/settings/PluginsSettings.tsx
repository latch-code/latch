import { useCallback, useEffect, useState } from 'react'
import { Lock, RefreshCw } from 'lucide-react'
import type { PluginInfo } from '@latch/protocol'
import { api, errorMessage } from '../core/api.ts'
import { BUILTIN_HARNESS_NAME } from '../composerChoice.ts'
import { Badge, Button, Icon, InlineNotice, StatusPill, Switch } from '@latch/ui'
import { Loading, NavRow, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'

type Group = 'harness' | 'provider' | 'tool' | 'other'
const groups: Array<{ id: Group; label: string }> = [
  { id: 'harness', label: 'Harness' },
  { id: 'provider', label: '模型' },
  { id: 'tool', label: '工具' },
  { id: 'other', label: '其他' },
]
const capabilityLabels: Record<string, string> = { harness: 'Harness', provider: '模型', tool: '工具' }
/** Where a plugin that settings manages for the person is turned on and off. */
export type PluginManager = 'providers' | 'agents'
const managers: Record<'provider' | 'agent', { section: PluginManager; label: string }> = {
  provider: { section: 'providers', label: '在模型服务中管理' },
  agent: { section: 'agents', label: '在 Agent 成员中管理' },
}

function groupOf(plugin: PluginInfo): Group {
  const kinds = plugin.capabilities.map(capability => capability.split(':')[0])
  return kinds.includes('harness') ? 'harness' : kinds.includes('provider') ? 'provider' : kinds.includes('tool') ? 'tool' : 'other'
}

const capabilityText = (plugin: PluginInfo) =>
  plugin.capabilities
    .map(capability => {
      const [kind = '', ...name] = capability.split(':')
      return `${capabilityLabels[kind] ?? kind} · ${name.join(':')}`
    })
    .join('、')

/** The built-in harness's plugin is named as the page names the harness. */
const pluginName = (plugin: PluginInfo) => (plugin.capabilities.includes('harness:standard') ? BUILTIN_HARNESS_NAME : plugin.name)

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
  const inUse = plugin.enabled && plugin.activeRuns > 0
  // Only a switch here can be held by runs in use; a built-in or managed plugin is turned off elsewhere or never.
  const reason = inUse && plugin.managed === undefined ? `正在被 ${plugin.activeRuns} 个运行使用，结束后才能停用` : undefined
  const title = (
    <span className="settings-row-name">
      {pluginName(plugin)}
      <span className="plugin-version">v{plugin.version}</span>
      {plugin.managed === 'core' && <Badge>内置</Badge>}
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
        plugin.managed === 'core' ? (
          <span className="settings-row-value">始终启用</span>
        ) : (
          <>
            {reason && <Icon icon={Lock} size={12} className="plugin-lock" />}
            <Switch
              label={pluginName(plugin)}
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

export function PluginsSettings({ onManage }: { onManage: (section: PluginManager) => void }) {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
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
      description="插件是在执行端运行的可信本机代码，提供 Harness、模型和工具。停用会立即生效并保存。"
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
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {plugins.length === 0 && <p className="settings-empty">执行端目前没有可管理的插件。</p>}
      {groups.map(group => {
        const members = plugins.filter(plugin => groupOf(plugin) === group.id)
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
