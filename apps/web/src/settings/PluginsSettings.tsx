import { useCallback, useEffect, useState } from 'react'
import { Bot, Puzzle, Sparkles, Wrench } from 'lucide-react'
import type { PluginInfo } from '@latch/protocol'
import { api, errorMessage } from '../core/api.ts'
import { ICON_STROKE, type LucideIcon } from '../icons.tsx'
import { Badge, InlineAlert, Switch } from '../components/ui.tsx'
import { Loading, SectionHeading } from './common.tsx'

type Group = 'harness' | 'provider' | 'tool' | 'other'
const groups: Array<{ id: Group; label: string; icon: LucideIcon }> = [
  { id: 'harness', label: 'Harness', icon: Bot },
  { id: 'provider', label: '模型', icon: Sparkles },
  { id: 'tool', label: '工具', icon: Wrench },
  { id: 'other', label: '其他', icon: Puzzle },
]
const capabilityLabels: Record<string, string> = { harness: 'Harness', provider: '模型', tool: '工具' }
const managedNotes = { provider: '由「模型服务」管理', agent: '由「Agent」管理', core: '内置' } as const

function groupOf(plugin: PluginInfo): Group {
  const kinds = plugin.capabilities.map(capability => capability.split(':')[0])
  return kinds.includes('harness') ? 'harness' : kinds.includes('provider') ? 'provider' : kinds.includes('tool') ? 'tool' : 'other'
}

/** Why a switch cannot be used right now, or undefined when it can. */
function lockReason(plugin: PluginInfo): string | undefined {
  if (plugin.managed === 'provider') return '在「模型服务」中启用或停用'
  if (plugin.managed === 'agent') return '在「Agent」中启用或停用'
  if (plugin.enabled && plugin.activeRuns > 0) return `正在被 ${plugin.activeRuns} 个运行使用，结束后才能停用`
  return undefined
}

export function PluginsSettings() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
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

  const toggle = async (plugin: PluginInfo) => {
    if (busy !== null) return
    setBusy(plugin.id)
    setError('')
    setNotice('')
    try {
      setPlugins(
        (
          await api<{ plugins: PluginInfo[] }>(`plugins/${encodeURIComponent(plugin.id)}`, {
            method: 'POST',
            body: { enabled: !plugin.enabled },
          })
        ).plugins,
      )
      setNotice(`${plugin.name} 已${plugin.enabled ? '停用' : '启用'}。`)
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
        <button
          type="button"
          className="text-button"
          disabled={busy !== null}
          onClick={() => {
            setError('')
            void load()
          }}>
          刷新
        </button>
      }
    />
  )
  if (plugins === null)
    return (
      <>
        {heading}
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : <Loading label="正在读取插件…" />}
      </>
    )
  return (
    <>
      {heading}
      {plugins.length === 0 && <p className="settings-hint">执行端目前没有可管理的插件。</p>}
      {groups.map(group => {
        const members = plugins.filter(plugin => groupOf(plugin) === group.id)
        if (members.length === 0) return null
        return (
          <section key={group.id} className="plugin-group" aria-label={group.label}>
            <h4>
              <group.icon size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {group.label}
            </h4>
            <ul className="plugin-list">
              {members.map(plugin => {
                const reason = lockReason(plugin)
                return (
                  <li key={plugin.id} className="plugin-row" data-plugin-id={plugin.id}>
                    <div className="plugin-row-main">
                      <div className="plugin-row-heading">
                        <strong>{plugin.name}</strong>
                        <span className="plugin-version">v{plugin.version}</span>
                        {plugin.managed && <Badge>{managedNotes[plugin.managed]}</Badge>}
                        {plugin.activeRuns > 0 && <Badge tone="accent">使用中</Badge>}
                      </div>
                      {plugin.description && <p>{plugin.description}</p>}
                      {plugin.capabilities.length > 0 && (
                        <ul className="capability-chips">
                          {plugin.capabilities.map(capability => {
                            const [kind = '', ...name] = capability.split(':')
                            return (
                              <li key={capability}>
                                {capabilityLabels[kind] ?? kind} · {name.join(':')}
                              </li>
                            )
                          })}
                        </ul>
                      )}
                      {reason && <span className="plugin-lock">{reason}</span>}
                    </div>
                    <Switch
                      label={plugin.name}
                      checked={plugin.enabled}
                      disabled={busy !== null || reason !== undefined}
                      title={reason}
                      onChange={() => {
                        void toggle(plugin)
                      }}
                    />
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {notice && !error && <InlineAlert tone="ok">{notice}</InlineAlert>}
    </>
  )
}
