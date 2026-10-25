import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { CircleAlert, CircleCheck, ExternalLink, Plus, RefreshCw, ShieldCheck, ShieldQuestion, X } from 'lucide-react'
import type { AgentSettings, AppSnapshot, AgentPreset, HarnessInfo, TaskSummary } from '@latch/protocol'
import { api, errorMessage, inlineError } from '../core/api.ts'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { withConfirmation } from '../core/confirmations.ts'
import { LEVEL_LABELS, type DeviceAccess } from '../core/permissions.ts'
import { LOCAL_ONLY_TEXT } from '../core/securityCopy.ts'
import { dateTime, hostOf } from '../format.ts'
import { ConfirmDialog } from '../components/overlays.tsx'
import {
  Badge,
  Button,
  ButtonLink,
  Dialog,
  Icon,
  IconButton,
  InlineNotice,
  StatusPill,
  Switch,
  SwitchRow,
  TextAreaField,
  TextField,
} from '@latch/ui'
import { CopyButton } from '../components/ui.tsx'
import { HarnessTile } from '../components/BrandTile.tsx'
import { IconTile, Loading, MiddleEllipsis, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { FieldDialog } from './dialogs.tsx'
import { AgentProbe, probeResultTitle } from './AgentProbe.tsx'
import { SettingsPages, type SettingsLevel } from './navigation.tsx'

interface AgentsResponse {
  agents: AgentSettings[]
  presets: AgentPreset[]
}
type Editing = { kind: 'agent'; id: string } | { kind: 'new'; preset?: AgentPreset } | { kind: 'presets' } | null

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const FULL_ACCESS_NOTE = '用它开启的会话为完全访问：Agent 自己决定执行范围，Latch 不隔离它。'
const DEFINE_ON_DESKTOP = `启动命令、参数和环境变量：${LOCAL_ONLY_TEXT}。`
/** Saving a definition asks for nothing; every full-access start is confirmed on this computer with what it runs. */
const SAVE_NOTE = '保存不需要确认；每次用它开始会话，都会在这台电脑上确认要运行的命令。'
/** A definition no full-access session has started with yet (`started: false`; older Hosts do not say). */
const NOT_STARTED = '还没有开启过会话'
const NOT_STARTED_NOTE = '开始会话时，会在这台电脑上确认它要运行的命令、参数和环境变量名。'
const lines = (text: string) =>
  text
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean)

/**
 * What is missing for an agent to start, in words: its command, or for an adapter preset the adapter, the agent it
 * connects to, or both. Undefined when everything was found.
 */
export function missingText(agent: Pick<AgentSettings, 'command' | 'detected'>): string | undefined {
  const companion = agent.detected.companion
  if (!companion) return agent.detected.found ? undefined : `未找到命令 ${agent.command}`
  if (agent.detected.found && companion.found) return undefined
  if (agent.detected.found) return `已找到适配器 ${agent.command}，还没找到 ${companion.command}`
  if (companion.found) return `已安装 ${companion.command}，还差让 Latch 连接它的适配器 ${agent.command}`
  return `未找到 ${companion.command} 和它的适配器 ${agent.command}`
}

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

/** Where a preset comes from and how to install it: the install command to copy and the project's page. */
function InstallHint({ preset }: { preset: AgentPreset }) {
  return (
    <div className="agent-install">
      {preset.install && (
        <span className="agent-install-command">
          <code>{preset.install}</code>
          <CopyButton text={preset.install} label="复制安装命令" />
        </span>
      )}
      <ButtonLink variant="link" size="xs" href={preset.homepage} target="_blank" rel="noopener noreferrer">
        项目主页
        <Icon icon={ExternalLink} size={12} />
      </ButtonLink>
    </div>
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

function PresetList({
  presets,
  configured,
  onPick,
}: {
  presets: AgentPreset[]
  configured: AgentSettings[]
  onPick: (preset?: AgentPreset) => void
}) {
  return (
    <>
      <SectionHeading title="添加 Agent" description="只收录可在本机安装运行、许可证可核对的开源 Agent。Latch 不会替你安装或下载它们。" />
      <SettingsGroup title="预设" meta={`${presets.length} 个 Agent`}>
        {presets.map(preset => {
          const exists = configured.some(agent => agent.presetId === preset.id)
          return (
            <div key={preset.id} className="settings-row agent-preset" data-leading="">
              <span className="settings-row-lead">
                <HarnessTile harness={{ id: preset.id, source: 'acp', presetId: preset.id }} size={24} />
              </span>
              <span className="settings-row-text">
                <span className="settings-row-title settings-row-name" data-record="">
                  {preset.name}
                  <Badge>{preset.license}</Badge>
                </span>
                <span className="settings-row-description">{preset.description}</span>
                <code className="agent-command">{[preset.command, ...preset.args].join(' ')}</code>
                <InstallHint preset={preset} />
              </span>
              <span className="settings-row-end">
                <Button
                  onClick={() => {
                    onPick(preset)
                  }}>
                  {exists ? '再添加一个' : '添加'}
                </Button>
              </span>
            </div>
          )
        })}
        <div className="settings-row agent-preset" data-leading="">
          <span className="settings-row-lead">
            <HarnessTile harness={{ id: '', source: 'acp' }} size={24} />
          </span>
          <span className="settings-row-text">
            <span className="settings-row-title" data-record="">
              自定义命令
            </span>
            <span className="settings-row-description">任何支持 Agent Client Protocol 的本机程序</span>
          </span>
          <span className="settings-row-end">
            <Button
              onClick={() => {
                onPick()
              }}>
              添加
            </Button>
          </span>
        </div>
      </SettingsGroup>
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
 * Only the Host's desktop saves a definition, without a local confirmation: its full-access starts are confirmed. Older
 * Hosts still ask when saving, which `withConfirmation` handles.
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
      await withConfirmation(confirmation => api('agents', { method: 'POST', body, ...(confirmation ? { confirmation } : {}) }))
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
        title={preset ? `添加 ${preset.name}` : '自定义 Agent'}
        description={preset?.description ?? '通过 ACP 在本机启动的程序'}
      />
      {preset && (
        <SettingsGroup title="安装">
          <InstallRows preset={preset} />
        </SettingsGroup>
      )}
      <SettingsGroup title="启动定义" caption={`${SAVE_NOTE}${FULL_ACCESS_NOTE}`}>
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
          description="停用的 Agent 不能用来发起会话"
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
        caption="值只写入执行端，不会再显示。">
        {env.length === 0 && <SettingsRow title="没有环境变量" description="Agent 继承执行端的安全环境；需要额外的变量时在这里添加" />}
        <EnvFields entries={env} onChange={setEnv} />
      </SettingsGroup>
      <InlineConfirm active={busy} rank={1} />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <div className="settings-actions">
        <Button size="md" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button size="md" type="submit" variant="primary" loading={busy}>
          添加 Agent
        </Button>
      </div>
    </form>
  )
}

/** Edits an agent's command and arguments in a 560 dialog; only the Host's desktop saves them. */
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
      title="编辑启动定义"
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
      subtitle="值只写入执行端，不会再显示"
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
 * An added agent's page, in cards. 启用 and the name change from any admin device; the command, arguments and
 * environment define what a full-access session runs, so they change only on the Host's desktop with a local
 * confirmation, and read-only elsewhere. Detection says what the Host found, with 重新检测 and the install command.
 */
function AgentPage({
  agent,
  preset,
  harness,
  definable,
  checking,
  probe,
  probeDisabledReason,
  onRecheck,
  onSaved,
  onDeleted,
}: {
  agent: AgentSettings
  preset?: AgentPreset
  harness?: HarnessInfo
  definable: boolean
  checking: boolean
  probe: boolean
  probeDisabledReason?: string
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

  /** One change; an older Host confirms a new definition, and the confirmation resends the identical body. */
  const update = async (body: Record<string, unknown>): Promise<string> => {
    setBusy(true)
    setError('')
    try {
      await withConfirmation(confirmation => api(`agents/${id}`, { method: 'PUT', body, ...(confirmation ? { confirmation } : {}) }))
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
        description={`通过 ACP 在本机启动 · ${LEVEL_LABELS.L3}`}
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
          description={enabled ? '新会话可以选择这个 Agent' : '停用后不能用它发起新会话'}
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
        title="启动定义"
        meta={
          definable ? (
            <Button
              variant="link"
              size="xs"
              disabled={busy}
              onClick={() => {
                setDialog('definition')
              }}>
              编辑…
            </Button>
          ) : undefined
        }
        caption={definable ? FULL_ACCESS_NOTE : DEFINE_ON_DESKTOP}
        captionIcon={definable ? 'info' : 'lock'}>
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
          definable ? (
            <Button
              variant="link"
              size="xs"
              disabled={busy}
              onClick={() => {
                setDialog('env')
              }}>
              添加…
            </Button>
          ) : agent.envKeys.length > 0 ? (
            `${agent.envKeys.length} 个变量`
          ) : undefined
        }
        caption="值只写入执行端，不会再显示。">
        {agent.envKeys.length === 0 && <SettingsRow title="没有环境变量" description="Agent 继承执行端的安全环境" />}
        {agent.envKeys.map(key => (
          <SettingsRow
            key={key}
            title={<code className="settings-mono">{key}</code>}
            description="已设置"
            trailing={
              definable ? (
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
              ) : undefined
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
          title={agent.verified ? '已验证的预设' : '未验证的定义'}
          description={agent.verified ? '命令和参数与预设一致' : '命令或参数与预设不同'}
        />
        {preset && <InstallRows preset={preset} />}
      </SettingsGroup>
      {probe && <AgentProbe agent={agent} disabled={busy} disabledReason={probeDisabledReason} onSaved={onSaved} />}
      <SettingsGroup danger>
        <SettingsRow
          title="删除 Agent"
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
        title="重命名 Agent"
        label="名称"
        initial={agent.name}
        maxLength={80}
        onSubmit={value => update({ name: value })}
        onClose={() => {
          setDialog(null)
        }}
      />
      {definable && (
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
      )}
      {removing && (
        <ConfirmDialog
          title="删除 Agent"
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

/** Counts only sessions already visible in this device's snapshot. */
export function agentUsage(tasks: readonly TaskSummary[], agentId: string): { count: number; lastUsedAt?: string } {
  const sessions = tasks.filter(task => task.harnessId === agentId)
  const latest = sessions
    .filter(task => Number.isFinite(Date.parse(task.updatedAt)))
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
  return { count: sessions.length, ...(latest ? { lastUsedAt: latest.updatedAt } : {}) }
}

/** One added agent: the row opens its page; the switch turns it on or off from any admin device. */
function AgentRow({
  agent,
  preset,
  harness,
  busy,
  usage,
  onOpen,
  onToggle,
}: {
  agent: AgentSettings
  preset?: AgentPreset
  harness?: HarnessInfo
  busy: boolean
  usage?: ReturnType<typeof agentUsage>
  onOpen: () => void
  onToggle: () => void
}) {
  const missing = missingText(agent) !== undefined
  return (
    <div className="settings-row agent-row" data-leading="" data-dim={missing ? '' : undefined} data-agent-id={agent.id}>
      <button type="button" className="settings-row-main" aria-label={`编辑 ${agent.name}`} onClick={onOpen}>
        <span className="settings-row-lead">
          <HarnessTile
            harness={{ id: agent.id, source: 'acp', presetId: agent.presetId, ...(harness ? { status: harness.status } : {}) }}
            size={24}
          />
        </span>
        <span className="settings-row-text">
          <span className="settings-row-title settings-row-name" data-record="">
            {agent.name}
            <Badge title={LEVEL_LABELS.L3}>完全访问</Badge>
            {preset && <Badge>{preset.license}</Badge>}
            {agent.verified === false && <Badge>未验证的定义</Badge>}
            {!agent.enabled && <StatusPill>已停用</StatusPill>}
            {agent.started === false && <StatusPill>{NOT_STARTED}</StatusPill>}
          </span>
          <code className="agent-command">{[agent.command, ...agent.args].join(' ')}</code>
          <Detection agent={agent} preset={preset} harness={harness} />
          {agent.problem && (
            <span className="detect is-warn">
              <Icon icon={CircleAlert} size={12} />
              <span>{agent.problem}</span>
            </span>
          )}
          {agent.lastProbe && (
            <span className="settings-row-description">
              上次测试：{probeResultTitle(agent.lastProbe)} · {agent.lastProbe.status === 'ready' ? '登录未验证' : '查看详情'}
            </span>
          )}
          {usage && (
            <span className="settings-row-description">
              当前可见 {usage.count} 个会话{usage.lastUsedAt && ` · 最近会话：${dateTime(usage.lastUsedAt)}`}
            </span>
          )}
          {agent.envKeys.length > 0 && <span className="settings-row-description">环境变量：{agent.envKeys.join('、')}</span>}
        </span>
      </button>
      <span className="settings-row-end">
        <Switch label={`启用 ${agent.name}`} checked={agent.enabled} disabled={busy} onCheckedChange={onToggle} />
      </span>
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
  const openPresets = () => {
    setEditing({ kind: 'presets' })
  }

  const heading = (
    <SectionHeading
      title="Agent 成员"
      description="在本机启动的开源 Agent，通过 ACP 接入。Agent 使用自己的登录和模型；Latch 不保存它们的账号，也不替你安装它们。"
      action={
        data && definable ? (
          <Button onClick={openPresets} icon={Plus}>
            添加 Agent
          </Button>
        ) : undefined
      }
    />
  )
  if (data === null)
    return (
      <>
        {heading}
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : <Loading />}
      </>
    )

  const main = (
    <>
      {heading}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {data.agents.length === 0 ? (
        <SettingsGroup
          title="本机 Agent"
          caption={definable ? undefined : `添加 Agent 或修改启动定义：${LOCAL_ONLY_TEXT}。`}
          captionIcon="lock">
          <SettingsRow
            title="还没有添加 Agent"
            description="添加 Codex、OpenCode 等开源 Agent 后，可以在新会话中选择它们"
            trailing={definable ? <Button onClick={openPresets}>从预设添加</Button> : undefined}
          />
        </SettingsGroup>
      ) : (
        <SettingsGroup
          title="本机 Agent"
          meta={`${data.agents.length} 个 Agent`}
          caption={definable ? FULL_ACCESS_NOTE : `添加 Agent 或修改启动定义：${LOCAL_ONLY_TEXT}。`}
          captionIcon={definable ? 'info' : 'lock'}>
          {data.agents.map(agent => (
            <AgentRow
              key={agent.id}
              agent={agent}
              preset={data.presets.find(item => item.id === agent.presetId)}
              harness={snapshot.catalog?.harnesses.find(item => item.id === agent.id)}
              busy={busy !== null}
              usage={
                Array.isArray(snapshot.device.scopes) && snapshot.device.scopes.includes('view')
                  ? agentUsage(snapshot.tasks, agent.id)
                  : undefined
              }
              onOpen={() => {
                setEditing({ kind: 'agent', id: agent.id })
              }}
              onToggle={() => {
                void toggle(agent)
              }}
            />
          ))}
        </SettingsGroup>
      )}
    </>
  )

  const presetsLevel: SettingsLevel = {
    key: 'presets',
    title: '添加 Agent',
    onBack: () => {
      setEditing(null)
    },
    content: (
      <PresetList
        presets={data.presets}
        configured={data.agents}
        onPick={choice => {
          setEditing({ kind: 'new', preset: choice })
        }}
      />
    ),
  }
  const levels: SettingsLevel[] = []
  if (editing?.kind === 'presets') levels.push(presetsLevel)
  if (editing?.kind === 'new')
    levels.push(presetsLevel, {
      key: `new:${editing.preset?.id ?? 'custom'}`,
      title: editing.preset ? `添加 ${editing.preset.name}` : '自定义 Agent',
      onBack: openPresets,
      content: <AgentAdd key={editing.preset?.id ?? 'custom'} preset={editing.preset} onSaved={done} onCancel={openPresets} />,
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
          definable={definable}
          checking={checking}
          probe={snapshot.catalog?.features?.agentProbe === true}
          probeDisabledReason={
            !access.local
              ? '测试启动只能在运行 Latch 的电脑上，通过桌面端进行。'
              : !snapshot.device.scopes?.includes('admin')
                ? '此设备没有管理此 Host 的权限。'
                : !snapshot.device.scopes?.includes('run')
                  ? '此设备没有发起和继续会话的权限。'
                  : !snapshot.host?.policy.allowL3
                    ? '这台电脑尚未允许完全访问，请先到设置 › 电脑开启。'
                    : snapshot.host.presence.status !== 'available'
                      ? '本机认证不可用，请先到设置 › 电脑检查确认组件。'
                      : !agent.detected.found
                        ? '先安装或配置 Agent 命令，再测试启动。'
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
