import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ChevronLeft, CircleAlert, CircleCheck, ExternalLink, LockKeyhole, Plus, Terminal, X } from 'lucide-react'
import type { AgentSettings, AppSnapshot, AgentPreset } from '@latch/protocol'
import { api, errorMessage, inlineError } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { LEVEL_LABELS, type DeviceAccess } from '../core/permissions.ts'
import { LOCAL_ONLY_TEXT } from '../core/securityCopy.ts'
import { ICON_STROKE, Spinner } from '../icons.tsx'
import { ConfirmDialog } from '../components/overlays.tsx'
import { Badge, CopyButton, InlineAlert, Switch } from '../components/ui.tsx'
import { Avatar, Loading, SectionHeading } from './common.tsx'

interface AgentsResponse {
  agents: AgentSettings[]
  presets: AgentPreset[]
}
type Editing = { kind: 'agent'; agent: AgentSettings } | { kind: 'new'; preset?: AgentPreset } | { kind: 'presets' } | null

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Command, arguments and environment define what a full-access session runs, so they change only on the
 * Host's desktop with a local confirmation. Name and enabled state can change from any admin device.
 */
function AgentEditor({
  agent,
  preset,
  definable,
  onSaved,
  onCancel,
}: {
  agent?: AgentSettings
  preset?: AgentPreset
  definable: boolean
  onSaved: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState(agent?.name ?? preset?.name ?? '')
  const [command, setCommand] = useState(agent?.command ?? preset?.command ?? '')
  const [args, setArgs] = useState((agent?.args ?? preset?.args ?? []).join('\n'))
  const [removed, setRemoved] = useState<string[]>([])
  const [added, setAdded] = useState<Array<{ key: string; value: string }>>([])
  const [enabled, setEnabled] = useState(agent?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !command.trim()) {
      setError('请填写名称和启动命令。')
      return
    }
    const env = added.filter(item => item.key.trim())
    const invalid = env.find(item => !ENV_KEY.test(item.key.trim()))
    if (invalid) {
      setError(`环境变量名「${invalid.key}」无效，只能包含字母、数字和下划线。`)
      return
    }
    const argList = args
      .split('\n')
      .map(item => item.trim())
      .filter(Boolean)
    setBusy(true)
    setError('')
    try {
      const definition = definable ? { command: command.trim(), args: argList } : {}
      const body = agent
        ? {
            name: name.trim(),
            enabled,
            ...definition,
            ...(definable
              ? {
                  env: {
                    ...Object.fromEntries(removed.map(key => [key, null])),
                    ...Object.fromEntries(env.map(item => [item.key.trim(), item.value])),
                  },
                }
              : {}),
          }
        : {
            name: name.trim(),
            command: command.trim(),
            args: argList,
            enabled,
            ...(preset ? { presetId: preset.id } : {}),
            env: Object.fromEntries(env.map(item => [item.key.trim(), item.value])),
          }
      const path = agent ? `agents/${encodeURIComponent(agent.id)}` : 'agents'
      await withConfirmation(confirmation => api(path, { method: agent ? 'PUT' : 'POST', body, ...(confirmation ? { confirmation } : {}) }))
      onSaved()
    } catch (cause) {
      setError(inlineError(cause))
      setBusy(false)
    }
  }

  return (
    <form
      className="agent-editor"
      onSubmit={event => {
        void save(event)
      }}>
      <div className="editor-heading">
        <Avatar name={name || '?'} />
        <div>
          <h4>{agent ? `编辑 ${agent.name}` : preset ? `添加 ${preset.name}` : '自定义 Agent'}</h4>
          <span>通过 ACP 在本机启动</span>
        </div>
        <Switch label="启用" checked={enabled} onChange={setEnabled} />
      </div>
      <div className="form-grid">
        <label className="field">
          <span>名称</span>
          <input
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={event => {
              setName(event.target.value)
            }}
          />
        </label>
        <label className="field">
          <span>启动命令</span>
          <input
            value={command}
            spellCheck={false}
            autoComplete="off"
            placeholder="例如 codex-acp"
            disabled={!definable}
            onChange={event => {
              setCommand(event.target.value)
            }}
          />
        </label>
        <label className="field field-wide">
          <span>
            参数<small>每行一个</small>
          </span>
          <textarea
            rows={3}
            value={args}
            spellCheck={false}
            disabled={!definable}
            onChange={event => {
              setArgs(event.target.value)
            }}
          />
        </label>
      </div>
      {!definable && (
        <p className="settings-hint">
          <LockKeyhole size={12} strokeWidth={ICON_STROKE} aria-hidden="true" /> 启动命令、参数和环境变量：{LOCAL_ONLY_TEXT}。
        </p>
      )}
      {definable && (
        <p className="settings-hint">
          保存启动定义需要在本机确认。用它开启的会话为{LEVEL_LABELS.L3}：Harness 自己决定执行范围，Latch 不隔离它。
        </p>
      )}
      {definable && (
        <section className="env-section" aria-label="环境变量">
          <h5>
            环境变量 <small>值只写入执行端，不会再显示</small>
          </h5>
          <ul className="env-list">
            {(agent?.envKeys ?? []).map(key => (
              <li key={key} className={removed.includes(key) ? 'is-removed' : ''}>
                <code>{key}</code>
                <span>{removed.includes(key) ? '保存后移除' : '已设置'}</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setRemoved(previous => (previous.includes(key) ? previous.filter(item => item !== key) : [...previous, key]))
                  }}>
                  {removed.includes(key) ? '撤销' : '移除'}
                </button>
              </li>
            ))}
            {added.map((item, index) => (
              <li key={index} className="env-new">
                <input
                  aria-label="变量名"
                  placeholder="变量名"
                  value={item.key}
                  spellCheck={false}
                  onChange={event => {
                    const key = event.target.value
                    setAdded(previous => previous.map((entry, i) => (i === index ? { ...entry, key } : entry)))
                  }}
                />
                <input
                  aria-label="变量值"
                  type="password"
                  placeholder="值"
                  value={item.value}
                  autoComplete="new-password"
                  onChange={event => {
                    const value = event.target.value
                    setAdded(previous => previous.map((entry, i) => (i === index ? { ...entry, value } : entry)))
                  }}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label="删除此变量"
                  onClick={() => {
                    setAdded(previous => previous.filter((_, i) => i !== index))
                  }}>
                  <X size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setAdded(previous => [...previous, { key: '', value: '' }])
            }}>
            <Plus size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            添加变量
          </button>
        </section>
      )}
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      <footer className="editor-footer">
        <span className="editor-footer-spacer" />
        <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          {busy && <Spinner size={14} />}
          {agent ? '保存' : '添加 Agent'}
        </button>
      </footer>
    </form>
  )
}

function PresetCards({
  presets,
  configured,
  onPick,
}: {
  presets: AgentPreset[]
  configured: AgentSettings[]
  onPick: (preset?: AgentPreset) => void
}) {
  return (
    <div className="agent-presets">
      {presets.map(preset => {
        const exists = configured.some(agent => agent.presetId === preset.id)
        return (
          <article key={preset.id} className="agent-preset">
            <div className="agent-preset-heading">
              <Avatar name={preset.name} />
              <strong>{preset.name}</strong>
              <Badge>{preset.license}</Badge>
            </div>
            <p>{preset.description}</p>
            <code className="agent-command">{[preset.command, ...preset.args].join(' ')}</code>
            {preset.install && (
              <div className="agent-install">
                <span>安装</span>
                <code>{preset.install}</code>
                <CopyButton text={preset.install} label="复制安装命令" />
              </div>
            )}
            <div className="agent-preset-actions">
              <a className="text-button" href={preset.homepage} target="_blank" rel="noopener noreferrer">
                项目主页
                <ExternalLink size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </a>
              <button
                type="button"
                className="button secondary small"
                onClick={() => {
                  onPick(preset)
                }}>
                {exists ? '再添加一个' : '添加'}
              </button>
            </div>
          </article>
        )
      })}
      <article className="agent-preset is-custom">
        <div className="agent-preset-heading">
          <span className="avatar" aria-hidden="true">
            <Terminal size={14} strokeWidth={ICON_STROKE} />
          </span>
          <strong>自定义命令</strong>
        </div>
        <p>任何支持 Agent Client Protocol 的本机程序。</p>
        <div className="agent-preset-actions">
          <span />
          <button
            type="button"
            className="button secondary small"
            onClick={() => {
              onPick()
            }}>
            添加
          </button>
        </div>
      </article>
    </div>
  )
}

export function AgentsSettings({
  snapshot,
  access,
  onChanged,
}: {
  snapshot: AppSnapshot
  access: Pick<DeviceAccess, 'legacy' | 'local'>
  onChanged: () => void
}) {
  const definable = access.legacy || access.local
  const [data, setData] = useState<AgentsResponse | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Editing>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<AgentSettings | null>(null)
  const load = useCallback(async () => {
    try {
      setData(await api<AgentsResponse>('agents'))
      setError('')
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const done = () => {
    setEditing(null)
    onChanged()
    void load()
  }
  const toggle = async (agent: AgentSettings) => {
    setBusy(agent.id)
    setError('')
    try {
      await api(`agents/${encodeURIComponent(agent.id)}`, { method: 'PUT', body: { enabled: !agent.enabled } })
      onChanged()
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const heading = (
    <SectionHeading
      title="Agent"
      description="在本机启动的开源 Agent，通过 ACP 接入。Agent 使用自己的登录和模型；Latch 不保存它们的账号。"
      action={
        editing === null && data && definable ? (
          <button
            type="button"
            className="button secondary small"
            onClick={() => {
              setEditing({ kind: 'presets' })
            }}>
            <Plus size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            添加 Agent
          </button>
        ) : undefined
      }
    />
  )
  if (data === null)
    return (
      <>
        {heading}
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : <Loading />}
      </>
    )
  if (editing !== null)
    return (
      <>
        {heading}
        <button
          type="button"
          className="back-link"
          onClick={() => {
            setEditing(editing.kind === 'new' ? { kind: 'presets' } : null)
          }}>
          <ChevronLeft size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {editing.kind === 'new' ? '选择 Agent' : 'Agent 列表'}
        </button>
        {editing.kind === 'presets' ? (
          <PresetCards
            presets={data.presets}
            configured={data.agents}
            onPick={preset => {
              setEditing({ kind: 'new', preset })
            }}
          />
        ) : (
          <AgentEditor
            key={editing.kind === 'agent' ? editing.agent.id : (editing.preset?.id ?? 'custom')}
            agent={editing.kind === 'agent' ? editing.agent : undefined}
            preset={editing.kind === 'new' ? editing.preset : undefined}
            definable={definable}
            onSaved={done}
            onCancel={() => {
              setEditing(null)
            }}
          />
        )}
      </>
    )
  return (
    <>
      {heading}
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {!definable && <p className="settings-hint">添加 Agent 或修改启动定义：{LOCAL_ONLY_TEXT}。</p>}
      {data.agents.length === 0 ? (
        <div className="empty-panel">
          <p>还没有添加 Agent。</p>
          {definable && (
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setEditing({ kind: 'presets' })
              }}>
              从预设添加
            </button>
          )}
        </div>
      ) : (
        <ul className="agent-list">
          {data.agents.map(agent => {
            const preset = data.presets.find(item => item.id === agent.presetId)
            const harness = snapshot.catalog?.harnesses.find(item => item.id === agent.id)
            return (
              <li key={agent.id} className="agent-row">
                <div className="agent-row-main">
                  <div className="agent-row-heading">
                    <strong>{agent.name}</strong>
                    <Badge tone="warn">L3</Badge>
                    {preset && <Badge>{preset.license}</Badge>}
                    {agent.verified === true && <Badge tone="ok">已验证的预设</Badge>}
                    {agent.verified === false && <Badge>未验证的定义</Badge>}
                    {!agent.enabled && <Badge>已停用</Badge>}
                  </div>
                  <code className="agent-command">{[agent.command, ...agent.args].join(' ')}</code>
                  <span className={`detect ${agent.detected.found ? 'is-ok' : 'is-warn'}`}>
                    {agent.detected.found ? (
                      <CircleCheck size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    ) : (
                      <CircleAlert size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    )}
                    {agent.detected.found
                      ? `已找到 ${agent.detected.path ?? agent.command}`
                      : `未找到命令 ${agent.command}${preset?.install ? `，安装：${preset.install}` : ''}`}
                  </span>
                  {harness?.status === 'unavailable' && agent.detected.found && harness.statusMessage && (
                    <span className="detect is-warn">{harness.statusMessage}</span>
                  )}
                  {agent.problem && (
                    <span className="detect is-warn">
                      <CircleAlert size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                      {agent.problem}
                    </span>
                  )}
                  {agent.envKeys.length > 0 && <span className="agent-env">环境变量：{agent.envKeys.join('、')}</span>}
                </div>
                <div className="agent-row-actions">
                  <Switch
                    label={`启用 ${agent.name}`}
                    checked={agent.enabled}
                    disabled={busy !== null}
                    onChange={() => {
                      void toggle(agent)
                    }}
                  />
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setEditing({ kind: 'agent', agent })
                    }}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className="text-button danger-text"
                    onClick={() => {
                      setRemoving(agent)
                    }}>
                    删除
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {removing && (
        <ConfirmDialog
          title="删除 Agent"
          danger
          confirmLabel="删除"
          message={`删除「${removing.name}」的启动配置和环境变量？它的会话正在运行时无法删除。`}
          onClose={() => {
            setRemoving(null)
          }}
          onConfirm={async () => {
            try {
              await api(`agents/${encodeURIComponent(removing.id)}`, { method: 'DELETE' })
            } catch (cause) {
              throw new Error(errorMessage(cause))
            }
            onChanged()
            await load()
          }}
        />
      )}
    </>
  )
}
