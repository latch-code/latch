import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { CircleAlert, CircleCheck, ExternalLink, Plus, RefreshCw, ShieldCheck, ShieldQuestion, X } from 'lucide-react'
import type { AgentSettings, AppSnapshot, AgentPreset, HarnessInfo } from '@latch/protocol'
import { api, errorMessage, inlineError } from '../core/api.ts'
import { LEVEL_LABELS, type DeviceAccess } from '../core/permissions.ts'
import type { AgentPageTarget } from '../shell/routes.ts'
import { builtinHarness, harnessName } from '../composerChoice.ts'
import { missingText } from '../core/agentDetection.ts'
export { missingText } from '../core/agentDetection.ts'
import { hostOf } from '../format.ts'
import { ConfirmDialog } from '../components/overlays.tsx'
import {
  Button,
  ButtonLink,
  Dialog,
  Icon,
  IconButton,
  InlineNotice,
  Switch,
  SwitchRow,
  TextAreaField,
  TextField,
  CopyButton,
} from '@latch/ui'
import { HarnessTile, MarkTile } from '../components/BrandTile.tsx'
import { IconTile, Loading, MiddleEllipsis, ObjectRow, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { FieldDialog } from './dialogs.tsx'
import { AgentProbe } from './AgentProbe.tsx'
import { SettingsPages, type SettingsLevel } from './navigation.tsx'

interface AgentsResponse {
  agents: AgentSettings[]
  presets: AgentPreset[]
}
type Editing = { kind: 'agent'; id: string } | { kind: 'new'; preset?: AgentPreset } | null

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENGINES_CAPTION = 'Harness 是这台 Mac 上已安装的程序，以你的权限运行。Latch 不会替你安装它们。'
const FULL_ACCESS_NOTE = '用它开启的会话为完全访问：Harness 自己决定执行范围，Latch 不隔离它。'
const SAVE_NOTE = '保存后就能用它开始会话，每次启动都留有记录。'
/** A definition no full-access session has started with yet (`started: false`; older Hosts do not say). */
const NOT_STARTED = '还没有开启过会话'
const NOT_STARTED_NOTE = '第一次开始会话时，会话开头会说明它能做什么。'
const lines = (text: string) =>
  text
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean)

/** What the Host found for an agent's command, in one line; ready is the default state and stays quiet. */
function Detection({ agent, preset, harness }: { agent: AgentSettings; preset?: AgentPreset; harness?: HarnessInfo }) {
  const missing = missingText(agent)
  if (missing)
    return (
      <span className="detect is-warn">
        <Icon icon={CircleAlert} size={12} />
        <span>
          {missing}
          {preset ? '；安装后点「重新检测」' : ''}
        </span>
      </span>
    )
  if (harness?.status === 'unavailable' && harness.statusMessage)
    return (
      <span className="detect is-warn">
        <Icon icon={CircleAlert} size={12} />
        <span>{harness.statusMessage}</span>
      </span>
    )
  return (
    <span className="detect is-ok">
      <Icon icon={CircleCheck} size={12} />
      <span className="detect-label">已找到</span>
      <MiddleEllipsis text={agent.detected.path ?? agent.command} className="detect-path" />
    </span>
  )
}

/** The preset's install command and project page as two rows of a card. */
function InstallRows({ preset }: { preset: AgentPreset }) {
  return (
    <>
      {preset.install && (
        <SettingsRow
          title="安装命令"
          description={<code className="settings-mono">{preset.install}</code>}
          trailing={<CopyButton text={preset.install} label="复制安装命令" />}
        />
      )}
      <SettingsRow
        title="项目主页"
        description={`${hostOf(preset.homepage)} · ${preset.license}`}
        trailing={
          <ButtonLink
            variant="ghost"
            href={preset.homepage}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`打开 ${preset.name} 的项目主页`}>
            打开
            <Icon icon={ExternalLink} size={12} />
          </ButtonLink>
        }
      />
    </>
  )
}

/** Name and value rows of a new definition's environment; values are written to the Host and never shown again. */
function EnvFields({
  entries,
  onChange,
}: {
  entries: Array<{ key: string; value: string }>
  onChange: (entries: Array<{ key: string; value: string }>) => void
}) {
  return (
    <>
      {entries.map((item, index) => (
        <div key={index} className="settings-row env-row">
          <input
            className="ui-input"
            aria-label="变量名"
            placeholder="变量名"
            value={item.key}
            spellCheck={false}
            autoComplete="off"
            onChange={event => {
              onChange(entries.map((entry, i) => (i === index ? { ...entry, key: event.target.value } : entry)))
            }}
          />
          <input
            className="ui-input"
            aria-label="变量值"
            type="password"
            placeholder="值"
            value={item.value}
            autoComplete="new-password"
            onChange={event => {
              onChange(entries.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)))
            }}
          />
          <IconButton
            label="删除此变量"
            icon={X}
            onClick={() => {
              onChange(entries.filter((_, i) => i !== index))
            }}
          />
        </div>
      ))}
    </>
  )
}

/** An invalid variable name, or undefined. */
const invalidEnv = (entries: Array<{ key: string }>) => entries.find(item => item.key.trim() && !ENV_KEY.test(item.key.trim()))

/**
 * A new agent from a preset or a custom command: the definition and environment as fields in cards, then 添加 Agent.
 */
function AgentAdd({ preset, onSaved, onCancel }: { preset?: AgentPreset; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(preset?.name ?? '')
  const [command, setCommand] = useState(preset?.command ?? '')
  const [args, setArgs] = useState((preset?.args ?? []).join('\n'))
  const [env, setEnv] = useState<Array<{ key: string; value: string }>>([])
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !command.trim()) {
      setError('请填写名称和启动命令。')
      return
    }
    const invalid = invalidEnv(env)
    if (invalid) {
      setError(`环境变量名「${invalid.key}」无效，只能包含字母、数字和下划线。`)
      return
    }
    setBusy(true)
    setError('')
    try {
      const body = {
        name: name.trim(),
        command: command.trim(),
        args: lines(args),
        enabled,
        ...(preset ? { presetId: preset.id } : {}),
        env: Object.fromEntries(env.filter(item => item.key.trim()).map(item => [item.key.trim(), item.value])),
      }
      await api('agents', { method: 'POST', body })
      onSaved()
    } catch (cause) {
      setError(inlineError(cause))
      setBusy(false)
    }
  }
  return (
    <form
      className="settings-subpage agent-add"
      onSubmit={event => {
        void save(event)
      }}>
      <SectionHeading
        title={preset ? `添加 ${preset.name}` : '自定义 Harness'}
        description={preset?.description ?? '在这台 Mac 上运行的程序'}
      />
      {preset && (
        <SettingsGroup title="安装">
          <InstallRows preset={preset} />
        </SettingsGroup>
      )}
      <SettingsGroup title="启动方式" caption={`${SAVE_NOTE}${FULL_ACCESS_NOTE}`}>
        <div className="settings-card-body settings-fields">
          <TextField
            label="名称"
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={event => {
              setName(event.target.value)
            }}
          />
          <TextField
            label="启动命令"
            value={command}
            spellCheck={false}
            autoComplete="off"
            placeholder="例如 codex-acp"
            onChange={event => {
              setCommand(event.target.value)
            }}
          />
          <TextAreaField
            label="参数"
            hint="每行一个"
            rows={3}
            value={args}
            spellCheck={false}
            onChange={event => {
              setArgs(event.target.value)
            }}
          />
        </div>
        <SwitchRow
          className="settings-row"
          title="添加后启用"
          description="停用的 Harness 不能用来发起会话"
          checked={enabled}
          onCheckedChange={setEnabled}
        />
      </SettingsGroup>
      <SettingsGroup
        title="环境变量"
        meta={
          <Button
            variant="link"
            size="xs"
            onClick={() => {
              setEnv(previous => [...previous, { key: '', value: '' }])
            }}>
            添加变量
          </Button>
        }
        caption="值只保存在这台 Mac 上，不会再显示。">
        {env.length === 0 && <SettingsRow title="没有环境变量" description="Harness 继承这台 Mac 的安全环境；需要额外的变量时在这里添加" />}
        <EnvFields entries={env} onChange={setEnv} />
      </SettingsGroup>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <div className="settings-actions">
        <Button size="md" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button size="md" type="submit" variant="primary" loading={busy}>
          添加 Harness
        </Button>
      </div>
    </form>
  )
}

/** Edits an agent's command and arguments in a 560 dialog; any admin device saves them. */
function DefinitionDialog({
  open,
  agent,
  onSubmit,
  onClose,
}: {
  open: boolean
  agent: AgentSettings
  onSubmit: (body: { command: string; args: string[] }) => Promise<string>
  onClose: () => void
}) {
  const form = useId()
  const [command, setCommand] = useState(agent.command)
  const [args, setArgs] = useState(agent.args.join('\n'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      setCommand(agent.command)
      setArgs(agent.args.join('\n'))
      setError('')
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!command.trim() || busy) return
    setBusy(true)
    const failure = await onSubmit({ command: command.trim(), args: lines(args) })
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }
  return (
    <Dialog
      open={open}
      size="form"
      title="编辑启动方式"
      subtitle={FULL_ACCESS_NOTE}
      note={SAVE_NOTE}
      onClose={() => {
        if (!busy) onClose()
      }}
      footer={
        <>
          <Button size="md" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button size="md" variant="primary" type="submit" form={form} disabled={!command.trim()} loading={busy}>
            保存
          </Button>
        </>
      }>
      <form
        id={form}
        className="settings-form"
        onSubmit={event => {
          void submit(event)
        }}>
        <TextField
          label="启动命令"
          value={command}
          spellCheck={false}
          autoComplete="off"
          onChange={event => {
            setCommand(event.target.value)
          }}
        />
        <TextAreaField
          label="参数"
          hint="每行一个"
          rows={4}
          value={args}
          spellCheck={false}
          onChange={event => {
            setArgs(event.target.value)
          }}
        />
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
      </form>
    </Dialog>
  )
}

/** Adds one environment variable to an agent; the value goes to the Host and is never shown again. */
function EnvDialog({
  open,
  onSubmit,
  onClose,
}: {
  open: boolean
  onSubmit: (key: string, value: string) => Promise<string>
  onClose: () => void
}) {
  const form = useId()
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const close = () => {
    setKey('')
    setValue('')
    setError('')
    onClose()
  }
  const invalid = key.trim() !== '' && !ENV_KEY.test(key.trim())
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!key.trim() || invalid || busy) return
    setBusy(true)
    const failure = await onSubmit(key.trim(), value)
    setBusy(false)
    if (failure) setError(failure)
    else close()
  }
  return (
    <Dialog
      open={open}
      size="form"
      title="添加环境变量"
      subtitle="值只保存在这台 Mac 上，不会再显示"
      note={SAVE_NOTE}
      onClose={() => {
        if (!busy) close()
      }}
      footer={
        <>
          <Button size="md" disabled={busy} onClick={close}>
            取消
          </Button>
          <Button size="md" variant="primary" type="submit" form={form} disabled={!key.trim() || invalid} loading={busy}>
            添加
          </Button>
        </>
      }>
      <form
        id={form}
        className="settings-form"
        onSubmit={event => {
          void submit(event)
        }}>
        <TextField
          label="变量名"
          value={key}
          spellCheck={false}
          autoComplete="off"
          placeholder="例如 OPENAI_BASE_URL"
          error={invalid ? '只能包含字母、数字和下划线，不能以数字开头' : undefined}
          onChange={event => {
            setKey(event.target.value)
            setError('')
          }}
        />
        <TextField
          label="值"
          type="password"
          value={value}
          autoComplete="new-password"
          onChange={event => {
            setValue(event.target.value)
          }}
        />
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
      </form>
    </Dialog>
  )
}

/**
 * An added agent's page, in cards: everything on it changes from any admin device, and each change is on record. Detection
 * says what the Host found, with 重新检测 and the install command.
 */
function AgentPage({
  agent,
  preset,
  harness,
  checking,
  probe,
  probeDisabledReason,
  loginTerminal = false,
  onRecheck,
  onSaved,
  onDeleted,
}: {
  agent: AgentSettings
  preset?: AgentPreset
  harness?: HarnessInfo
  checking: boolean
  probe: boolean
  probeDisabledReason?: string
  loginTerminal?: boolean
  onRecheck: () => void
  onSaved: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<null | 'name' | 'definition' | 'env'>(null)
  const [removing, setRemoving] = useState(false)
  const [enabled, setEnabled] = useState(agent.enabled)
  const [seen, setSeen] = useState(agent.enabled)
  if (seen !== agent.enabled) {
    setSeen(agent.enabled)
    setEnabled(agent.enabled)
  }
  const id = encodeURIComponent(agent.id)

  /** One change. */
  const update = async (body: Record<string, unknown>): Promise<string> => {
    setBusy(true)
    setError('')
    try {
      await api(`agents/${id}`, { method: 'PUT', body })
      onSaved()
      return ''
    } catch (cause) {
      return inlineError(cause)
    } finally {
      setBusy(false)
    }
  }
  const missing = missingText(agent) !== undefined
  return (
    <>
      <SectionHeading
        title={agent.name}
        description={`在这台 Mac 上启动 · ${LEVEL_LABELS.L3}`}
        action={
          <Button
            disabled={busy}
            onClick={() => {
              setDialog('name')
            }}>
            重命名…
          </Button>
        }
      />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <SettingsGroup>
        <SwitchRow
          className="settings-row"
          title="启用"
          description={enabled ? '新会话可以选择这个 Harness' : '停用后不能用它发起新会话'}
          checked={enabled}
          disabled={busy}
          onCheckedChange={next => {
            setEnabled(next)
            void update({ enabled: next }).then(text => {
              if (text) {
                setError(text)
                setEnabled(agent.enabled)
              }
            })
          }}
        />
      </SettingsGroup>
      <SettingsGroup
        title="启动方式"
        meta={
          <Button
            variant="link"
            size="xs"
            disabled={busy}
            onClick={() => {
              setDialog('definition')
            }}>
            编辑…
          </Button>
        }
        caption={FULL_ACCESS_NOTE}
        captionIcon="info">
        {agent.started === false && <SettingsRow title={NOT_STARTED} description={NOT_STARTED_NOTE} />}
        <SettingsRow title="命令" description={<MiddleEllipsis text={agent.command} className="settings-mono" />} />
        <SettingsRow
          title="参数"
          description={agent.args.length > 0 ? <MiddleEllipsis text={agent.args.join(' ')} className="settings-mono" /> : '无'}
        />
      </SettingsGroup>
      <SettingsGroup
        title="环境变量"
        meta={
          <Button
            variant="link"
            size="xs"
            disabled={busy}
            onClick={() => {
              setDialog('env')
            }}>
            添加…
          </Button>
        }
        caption="值只保存在这台 Mac 上，不会再显示。">
        {agent.envKeys.length === 0 && <SettingsRow title="没有环境变量" description="Harness 继承这台 Mac 的安全环境" />}
        {agent.envKeys.map(key => (
          <SettingsRow
            key={key}
            title={<code className="settings-mono">{key}</code>}
            description="已设置"
            trailing={
              <Button
                variant="ghost"
                disabled={busy}
                aria-label={`移除 ${key}`}
                onClick={() => {
                  void update({ env: { [key]: null } }).then(text => {
                    if (text) setError(text)
                  })
                }}>
                移除
              </Button>
            }
          />
        ))}
      </SettingsGroup>
      <SettingsGroup
        title="检测"
        meta={
          <Button variant="ghost" size="xs" icon={RefreshCw} loading={checking} onClick={onRecheck}>
            重新检测
          </Button>
        }>
        <SettingsRow
          leading={<IconTile icon={missing ? CircleAlert : CircleCheck} />}
          title={missing ? '还不能启动' : '已找到命令'}
          description={
            missing || harness?.status === 'unavailable' ? (
              <Detection agent={agent} preset={preset} harness={harness} />
            ) : (
              <MiddleEllipsis text={agent.detected.path ?? agent.command} className="settings-mono" />
            )
          }
          trailing={!missing && agent.detected.path ? <CopyButton text={agent.detected.path} label="复制命令路径" /> : undefined}
        />
        {agent.problem && (
          <SettingsRow
            leading={<IconTile icon={CircleAlert} />}
            title="定义有问题"
            description={<span className="detect is-warn">{agent.problem}</span>}
          />
        )}
        <SettingsRow
          leading={<IconTile icon={agent.verified ? ShieldCheck : ShieldQuestion} />}
          title={agent.verified ? 'Latch 已收录' : '未验证的定义'}
          description={agent.verified ? '命令和参数与 Latch 收录的一致' : '命令或参数与 Latch 收录的不同'}
        />
        {preset && <InstallRows preset={preset} />}
      </SettingsGroup>
      {probe && (
        <AgentProbe
          agent={agent}
          disabled={busy}
          disabledReason={probeDisabledReason}
          onSaved={onSaved}
          login={harness?.login}
          terminal={loginTerminal}
        />
      )}
      <SettingsGroup>
        <SettingsRow
          title="删除 Harness"
          description="删除启动配置和环境变量；它的会话正在运行时无法删除"
          trailing={
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setRemoving(true)
              }}>
              删除
            </Button>
          }
        />
      </SettingsGroup>
      <FieldDialog
        open={dialog === 'name'}
        title="重命名 Harness"
        label="名称"
        initial={agent.name}
        maxLength={80}
        onSubmit={value => update({ name: value })}
        onClose={() => {
          setDialog(null)
        }}
      />
      <>
        <DefinitionDialog
          open={dialog === 'definition'}
          agent={agent}
          onSubmit={body => update(body)}
          onClose={() => {
            setDialog(null)
          }}
        />
        <EnvDialog
          open={dialog === 'env'}
          onSubmit={(key, value) => update({ env: { [key]: value } })}
          onClose={() => {
            setDialog(null)
          }}
        />
      </>
      {removing && (
        <ConfirmDialog
          title="删除 Harness"
          danger
          confirmLabel="删除"
          message={`删除「${agent.name}」的启动配置和环境变量？它的会话正在运行时无法删除。`}
          onClose={() => {
            setRemoving(false)
          }}
          onConfirm={async () => {
            try {
              await api(`agents/${id}`, { method: 'DELETE' })
            } catch (cause) {
              throw new Error(errorMessage(cause), { cause })
            }
            onDeleted()
          }}
        />
      )}
    </>
  )
}

/** Whether an engine can start now, in one word: quiet when it can, amber with its reason when it cannot. */
function EngineStatus({ agent, harness }: { agent: AgentSettings; harness?: HarnessInfo }) {
  const missing = missingText(agent)
  if (missing !== undefined || agent.problem || harness?.status === 'unavailable') {
    const reason = missing ?? agent.problem ?? harness?.statusMessage
    return (
      <span className="service-status" data-tone="warn" title={reason}>
        {missing !== undefined ? '未安装' : '需要处理'}
      </span>
    )
  }
  if (!agent.enabled) return <span className="service-status">已停用</span>
  return <span className="service-status">可用</span>
}

/** 已安装 holds what can run; a definition whose program is not on this Mac waits with the others that can be installed. */
export const engineGroups = (agents: readonly AgentSettings[]) => ({
  installed: agents.filter(agent => missingText(agent) === undefined),
  missing: agents.filter(agent => missingText(agent) !== undefined),
})

/** 可以安装 stands on the section's own page, so asking for the presets is asking for that page. */
const editingOf = (target: AgentPageTarget): Editing => (target.kind === 'presets' ? null : target)

/** One engine: the row opens its page; the switch turns it on or off from any admin device. */
export function AgentRow({
  agent,
  preset,
  harness,
  busy,
  onOpen,
  onToggle,
}: {
  agent: AgentSettings
  preset?: AgentPreset
  harness?: HarnessInfo
  busy: boolean
  onOpen: () => void
  onToggle: () => void
}) {
  return (
    <ObjectRow
      className="agent-row"
      label={`编辑 ${agent.name}`}
      dim={missingText(agent) !== undefined}
      leading={<MarkTile mark={agent.presetId} cold={harness?.status === 'unavailable'} size={24} />}
      title={
        <span className="settings-row-name">
          {agent.name}
          {!agent.verified && <span className="settings-row-note">未验证的定义</span>}
        </span>
      }
      description={
        // A preset's description would hide that this runs something other than the preset.
        agent.verified && preset ? preset.description : <code className="agent-command">{[agent.command, ...agent.args].join(' ')}</code>
      }
      onOpen={onOpen}
      trailing={
        <>
          <EngineStatus agent={agent} harness={harness} />
          <Switch label={`启用 ${agent.name}`} checked={agent.enabled} disabled={busy} onCheckedChange={onToggle} />
        </>
      }
    />
  )
}

export function AgentsSettings({
  snapshot,
  onChanged,
  initialPage,
}: {
  snapshot: AppSnapshot
  onChanged: () => void
  /** A page to open on, each time a new one is given. */
  initialPage?: AgentPageTarget | undefined
}) {
  const [data, setData] = useState<AgentsResponse | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Editing>(initialPage ? editingOf(initialPage) : null)
  useEffect(() => {
    if (initialPage) setEditing(editingOf(initialPage))
  }, [initialPage])
  const [busy, setBusy] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
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
    // An agent installed in a terminal shows up when the person comes back to this window.
    const again = () => {
      if (document.visibilityState === 'visible') void load()
    }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [load])
  const recheck = async () => {
    setChecking(true)
    await load()
    onChanged()
    setChecking(false)
  }
  const refreshed = () => {
    onChanged()
    void load()
  }
  const done = () => {
    setEditing(null)
    refreshed()
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
  if (data === null) return error ? <InlineNotice tone="error">{error}</InlineNotice> : <Loading />

  const builtin = builtinHarness(snapshot.catalog)
  const installable = data.presets.filter(preset => !data.agents.some(agent => agent.presetId === preset.id))
  const { installed, missing } = engineGroups(data.agents)
  const engineRow = (agent: AgentSettings) => (
    <AgentRow
      key={agent.id}
      agent={agent}
      preset={data.presets.find(item => item.id === agent.presetId)}
      harness={snapshot.catalog?.harnesses.find(item => item.id === agent.id)}
      busy={busy !== null}
      onOpen={() => {
        setEditing({ kind: 'agent', id: agent.id })
      }}
      onToggle={() => {
        void toggle(agent)
      }}
    />
  )
  const main = (
    <>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <SettingsGroup
        title="已安装"
        meta={
          <Button
            variant="outline"
            icon={Plus}
            onClick={() => {
              setEditing({ kind: 'new' })
            }}>
            自定义 Harness
          </Button>
        }
        caption={ENGINES_CAPTION}
        captionIcon={null}>
        {builtin && (
          <SettingsRow
            className="agent-row"
            leading={<HarnessTile harness={builtin} size={24} />}
            record
            title={harnessName(builtin)}
            description="内置 Harness，用你在 设置 › 模型 里接入的服务"
            trailing={<span className="service-status">{builtin.status === 'ready' ? '可用' : '需要模型服务'}</span>}
          />
        )}
        {installed.map(engineRow)}
      </SettingsGroup>
      {(missing.length > 0 || installable.length > 0) && (
        <SettingsGroup title="可以安装">
          {missing.map(engineRow)}
          {installable.map(preset => (
            <ObjectRow
              key={preset.id}
              className="agent-preset"
              label={`安装 ${preset.name}`}
              leading={<MarkTile mark={preset.id} size={24} />}
              title={preset.name}
              description={preset.description}
              trailing={
                <Button
                  variant="outline"
                  aria-label={`安装 ${preset.name}`}
                  onClick={() => {
                    setEditing({ kind: 'new', preset })
                  }}>
                  安装…
                </Button>
              }
            />
          ))}
        </SettingsGroup>
      )}
    </>
  )

  const levels: SettingsLevel[] = []
  if (editing?.kind === 'new')
    levels.push({
      key: `new:${editing.preset?.id ?? 'custom'}`,
      title: editing.preset ? `添加 ${editing.preset.name}` : '自定义 Harness',
      onBack: () => {
        setEditing(null)
      },
      content: (
        <AgentAdd
          key={editing.preset?.id ?? 'custom'}
          preset={editing.preset}
          onSaved={done}
          onCancel={() => {
            setEditing(null)
          }}
        />
      ),
    })
  const agent = editing?.kind === 'agent' ? data.agents.find(item => item.id === editing.id) : undefined
  if (agent)
    levels.push({
      key: `agent:${agent.id}`,
      title: agent.name,
      onBack: () => {
        setEditing(null)
      },
      content: (
        <AgentPage
          key={agent.id}
          agent={agent}
          preset={data.presets.find(item => item.id === agent.presetId)}
          harness={snapshot.catalog?.harnesses.find(item => item.id === agent.id)}
          checking={checking}
          probe={snapshot.catalog?.features?.agentProbe === true}
          loginTerminal={snapshot.catalog?.features?.loginTerminal === true}
          probeDisabledReason={
            !snapshot.device.scopes?.includes('admin')
              ? '这台设备没有管理这台 Mac 的权限。'
              : !snapshot.device.scopes?.includes('run')
                ? '此设备没有发起和继续会话的权限。'
                : !agent.detected.found
                  ? '先安装或配置 Harness 命令，再测试启动。'
                  : undefined
          }
          onRecheck={() => {
            void recheck()
          }}
          onSaved={refreshed}
          onDeleted={done}
        />
      ),
    })

  return <SettingsPages main={main} levels={levels} />
}
