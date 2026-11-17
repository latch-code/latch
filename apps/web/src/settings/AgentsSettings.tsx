import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { ShieldCheck, ShieldQuestion } from 'lucide-react'
import type { AgentPresetSettings, AgentSettings, AppSnapshot, AgentPreset, HarnessInfo } from '@latch/protocol'
import { api, errorMessage, inlineError, MessageError } from '../core/api.ts'
import { deviceAccess, type DeviceAccess } from '../core/permissions.ts'
import { computerName, RUNS_AS_YOU_COPY, SETUP_COPY } from '../core/securityCopy.ts'
import { currentShell } from '../core/shell.ts'
import type { AgentPageTarget } from '../shell/routes.ts'
import { builtinHarness, harnessName } from '../composerChoice.ts'
import { foundWithoutAdapter, missingText } from '../core/agentDetection.ts'
export { missingText } from '../core/agentDetection.ts'
import { hostOf } from '../format.ts'
import { ConfirmDialog } from '../components/overlays.tsx'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { withConfirmation } from '../core/confirmations.ts'
import {
  Button,
  ButtonLink,
  Collapse,
  Dialog,
  Hint,
  Icon,
  IconButton,
  InlineNotice,
  Switch,
  SwitchRow,
  TextAreaField,
  TextField,
  Tooltip,
  CopyButton,
  AlertGlyph,
  CircleCheckGlyph,
  ExternalGlyph,
  PlusGlyph,
  RefreshGlyph,
  ShieldGlyph,
  CloseGlyph,
} from '@latch/ui'
import { HarnessTile, MarkTile } from '../components/BrandTile.tsx'
import { IconTile, Loading, MiddleEllipsis, NavRow, NoteLine, ObjectRow, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { FieldDialog } from './dialogs.tsx'
import { AgentProbe } from './AgentProbe.tsx'
import { LoginGroup } from './LoginGroup.tsx'
import { loginSurface, type LoginSurface } from '../panel/terminal/loginRuns.ts'
import { ExtensionsLink } from './ExtensionsLink.tsx'
import { SettingsPages, type SettingsLevel } from './navigation.tsx'
import { TerminalFillButton } from '../components/TerminalFillButton.tsx'

interface AgentsResponse {
  agents: AgentSettings[]
  presets: AgentPresetSettings[]
}
type Editing = { kind: 'agent'; id: string } | { kind: 'new'; preset?: AgentPreset } | null

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Where the Harnesses run, as a person on this device names that computer: 「这台 Mac」 in its own app, else its name. */
const onComputer = (local: boolean, hostName?: string) => (local ? '这台 Mac 上' : ` ${computerName(hostName)} 上`)
/** A session started with a definition is an external Harness's session: it decides its own reach, Latch does not isolate it. */
const FULL_ACCESS_NOTE = <NoteLine icon={ShieldGlyph} brief={SETUP_COPY.externalNote} />
const CUSTOM_START = '自定义启动方式'
/** Environment values: kept on this Mac and never shown again. */
const ENV_HELD = '只存在这台 Mac 上，不再显示'
/** A definition no full-access session has started with yet (`started: false`; older Hosts do not say). */
const NOT_STARTED = '还没有开启过会话'
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
        <Icon icon={AlertGlyph} size={12} />
        <span>
          {missing}
          {preset ? '；安装后点「重新检测」' : ''}
        </span>
      </span>
    )
  const outdated = agent.detected.outdated
  if (outdated)
    return (
      <span className="detect is-warn">
        <Icon icon={AlertGlyph} size={12} />
        <span>{outdated.need}</span>
      </span>
    )
  if (harness?.status === 'unavailable' && harness.statusMessage)
    return (
      <span className="detect is-warn">
        <Icon icon={AlertGlyph} size={12} />
        <span>{harness.statusMessage}</span>
      </span>
    )
  return (
    <span className="detect is-ok">
      <Icon icon={CircleCheckGlyph} size={12} />
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
          trailing={
            <span className="command-actions">
              <CopyButton text={preset.install} label="复制安装命令" />
              <TerminalFillButton command={preset.install} detached />
            </span>
          }
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
            <Icon icon={ExternalGlyph} size={12} />
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
            icon={CloseGlyph}
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
      // A new Harness is a new program: the Host asks for Touch ID on this Mac first.
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
        title={preset ? CUSTOM_START : '自定义 Harness'}
        description={preset ? `${preset.name}：${preset.description}` : '在这台 Mac 上运行的程序'}
      />
      {preset && (
        <SettingsGroup title="安装">
          <InstallRows preset={preset} />
        </SettingsGroup>
      )}
      <SettingsGroup title="启动方式" note={FULL_ACCESS_NOTE}>
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
        <SwitchRow className="settings-row" title="添加后启用" checked={enabled} onCheckedChange={setEnabled} />
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
        caption={ENV_HELD}
        captionIcon="lock">
        {env.length === 0 && <SettingsRow title="没有环境变量" />}
        <EnvFields entries={env} onChange={setEnv} />
      </SettingsGroup>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <InlineConfirm active={busy} rank={1} />
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
      size="lg"
      title="编辑启动方式"
      subtitle={SETUP_COPY.externalNote.label}
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
        <InlineConfirm active={busy} rank={1} />
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
      size="lg"
      title="添加环境变量"
      subtitle={ENV_HELD}
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
        <InlineConfirm active={busy} rank={1} />
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
  loginSurface: surface = { kind: 'none' },
  run = false,
  onRecheck,
  onSaved,
  onDeleted,
  on,
  local = false,
}: {
  agent: AgentSettings
  preset?: AgentPreset
  harness?: HarnessInfo
  checking: boolean
  probe: boolean
  probeDisabledReason?: string
  loginSurface?: LoginSurface
  /** This device may start sessions, so it may ask about logging in and log out. */
  run?: boolean
  onRecheck: () => void
  onSaved: () => void
  onDeleted: () => void
  /** 「这台 Mac 上」 or 「 <name> 上」: where the definition starts. */
  on: string
  /** The desktop app on this Mac: the only place a command, its arguments or variables can change. */
  local?: boolean
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
      // Another command, other arguments or a variable's new value: the Host asks for Touch ID on this Mac first.
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
        description={`在${on}启动 · 外部 Harness`}
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
          local && (
            <Button
              variant="link"
              size="xs"
              disabled={busy}
              onClick={() => {
                setDialog('definition')
              }}>
              编辑…
            </Button>
          )
        }
        note={FULL_ACCESS_NOTE}>
        {agent.started === false && <SettingsRow title={NOT_STARTED} />}
        <SettingsRow title="命令" description={<MiddleEllipsis text={agent.command} className="settings-mono" />} />
        <SettingsRow
          title="参数"
          description={agent.args.length > 0 ? <MiddleEllipsis text={agent.args.join(' ')} className="settings-mono" /> : '无'}
        />
      </SettingsGroup>
      <SettingsGroup
        title="环境变量"
        meta={
          local && (
            <Button
              variant="link"
              size="xs"
              disabled={busy}
              onClick={() => {
                setDialog('env')
              }}>
              添加…
            </Button>
          )
        }
        caption={ENV_HELD}
        captionIcon="lock">
        <InlineConfirm active={busy && dialog === null} rank={1} />
        {agent.envKeys.length === 0 && <SettingsRow title="没有环境变量" />}
        {agent.envKeys.map(key => (
          <SettingsRow
            key={key}
            title={<code className="settings-mono">{key}</code>}
            description="已设置"
            trailing={
              local && (
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
              )
            }
          />
        ))}
      </SettingsGroup>
      <SettingsGroup
        title="检测"
        meta={
          <Button variant="ghost" size="xs" icon={RefreshGlyph} loading={checking} onClick={onRecheck}>
            重新检测
          </Button>
        }>
        <SettingsRow
          leading={<IconTile icon={missing || agent.detected.outdated ? AlertGlyph : CircleCheckGlyph} />}
          title={missing ? '还不能启动' : agent.detected.outdated ? '需要升级' : '已找到命令'}
          description={
            missing || agent.detected.outdated || harness?.status === 'unavailable' ? (
              <Detection agent={agent} preset={preset} harness={harness} />
            ) : (
              <MiddleEllipsis text={agent.detected.path ?? agent.command} className="settings-mono" />
            )
          }
          trailing={
            missing ? undefined : agent.detected.outdated ? (
              <span className="command-actions">
                <CopyButton text={agent.detected.outdated.upgrade} label="复制升级命令" />
                <TerminalFillButton command={agent.detected.outdated.upgrade} detached />
              </span>
            ) : agent.detected.path ? (
              <CopyButton text={agent.detected.path} label="复制命令路径" />
            ) : undefined
          }
        />
        {agent.detected.outdated && (
          <SettingsRow title="升级命令" description={<span className="settings-mono">{agent.detected.outdated.upgrade}</span>} />
        )}
        {agent.problem && (
          <SettingsRow
            leading={<IconTile icon={AlertGlyph} />}
            title="定义有问题"
            description={<span className="detect is-warn">{agent.problem}</span>}
          />
        )}
        <SettingsRow
          leading={<IconTile icon={agent.verified ? ShieldCheck : ShieldQuestion} />}
          title={agent.verified ? 'Latch 已收录' : '未验证的定义'}
          description={agent.verified ? undefined : '命令或参数与 Latch 收录的不同'}
        />
        {preset && <InstallRows preset={preset} />}
      </SettingsGroup>
      {harness?.login && <LoginGroup harness={harness} allowed={run} surface={surface} probe={agent.lastProbe} />}
      {harness && <ExtensionsLink title="技能、命令、MCP 与插件" harnessId={harness.id} />}
      {probe && <AgentProbe agent={agent} disabled={busy} disabledReason={probeDisabledReason} onSaved={onSaved} />}
      <SettingsGroup>
        <SettingsRow
          title="删除 Harness"
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
              throw new MessageError(errorMessage(cause), { cause })
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
        {missing !== undefined ? '未安装' : agent.detected.outdated ? '需要升级' : '需要处理'}
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

/**
 * The presets with no saved definition: found on the computer (an executable with the command's name is there), which
 * stand with what is installed, and the rest, which can be installed. A Host that sends no detection finds none.
 */
export function presetGroups(presets: readonly AgentPresetSettings[], agents: readonly Pick<AgentSettings, 'presetId'>[]) {
  const unsaved = presets.filter(preset => !agents.some(agent => agent.presetId === preset.id))
  return {
    found: unsaved.filter(preset => preset.detected?.found === true),
    installable: unsaved.filter(preset => preset.detected?.found !== true),
  }
}

/** 可以安装 stands on the section's own page, so asking for the presets is asking for that page. */
const editingOf = (target: AgentPageTarget): Editing => (target.kind === 'presets' ? null : target)

const commandBase = (command: string) => command.replace(/\\/g, '/').split('/').at(-1) ?? command

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
  // Saved on the preset's adapter rather than its own program: said, with what the direct route needs.
  const viaAdapter = preset?.fallback !== undefined && commandBase(agent.command) === preset.fallback.command
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
        // A preset says which program it is bound to; anything else says what it runs.
        agent.verified && preset && harness?.bound?.path ? (
          <MiddleEllipsis text={harness.bound.path} className="settings-mono" />
        ) : agent.verified && preset ? (
          ((viaAdapter ? preset.fallback?.description : undefined) ?? preset.description)
        ) : (
          <code className="agent-command">{[agent.command, ...agent.args].join(' ')}</code>
        )
      }
      onOpen={onOpen}
      trailing={
        <>
          {viaAdapter && preset?.fallback && <Hint label={`经 ${preset.fallback.command}`}>{preset.fallback.direct}</Hint>}
          <EngineStatus agent={agent} harness={harness} />
          <Switch label={`启用 ${agent.name}`} checked={agent.enabled} disabled={busy} onCheckedChange={onToggle} />
        </>
      }
    />
  )
}

/**
 * A preset found on this computer with no definition yet: 「已找到」 says only that an executable with that name is there,
 * so it is not drawn as ready. The row opens its start form, for a person who wants to change how it starts.
 */
/** Behind 已找到's ⓘ: a preset is run for its version only once it is confirmed on this Mac. */
const VERSION_UNREAD = '版本未读：添加并在这台 Mac 上确认后读取'

function FoundRow({ preset, onOpen }: { preset: AgentPresetSettings; onOpen: () => void }) {
  const outdated = preset.detected?.outdated
  const unread = preset.detected?.versionUnread === true
  return (
    <NavRow
      className="agent-row"
      leading={<MarkTile mark={preset.id} size={24} />}
      record
      title={preset.name}
      description={
        outdated ? (
          <span className="detect is-warn">
            <Icon icon={AlertGlyph} size={12} />
            <span>{outdated.need}</span>
          </span>
        ) : (
          <MiddleEllipsis text={preset.detected?.path ?? preset.command} className="settings-mono" />
        )
      }
      value={
        outdated ? (
          '需要升级'
        ) : unread ? (
          // Not run for its version until it is confirmed: 已找到 says only that the program is there.
          // The row's name already says it to assistive tech; pointer and touch get it as the word's tooltip.
          <Tooltip content={VERSION_UNREAD} describe={false}>
            <span className="agent-found-unread">已找到</span>
          </Tooltip>
        ) : (
          '已找到'
        )
      }
      label={`${preset.name}，${outdated ? '需要升级' : unread ? `已找到，${VERSION_UNREAD}` : '已找到'}，${CUSTOM_START}`}
      onClick={onOpen}
    />
  )
}

/**
 * A preset that is not on this computer. 「怎么装」 opens the command, copying it and looking again; Latch installs
 * nothing. The start form stays one step further, under 「自定义启动方式」, for a program that is somewhere else.
 */
function InstallRow({
  preset,
  checking,
  onRecheck,
  onCustom,
}: {
  preset: AgentPresetSettings
  checking: boolean
  onRecheck: () => void
  onCustom: () => void
}) {
  const [open, setOpen] = useState(false)
  const program = foundWithoutAdapter(preset.detected)
  return (
    <div className="agent-install">
      <SettingsRow
        className="agent-preset"
        leading={<MarkTile mark={preset.id} size={24} />}
        record
        title={preset.name}
        description={program ? `找到了 ${program}，还差让 Latch 连接它的适配器` : preset.description}
        trailing={
          <Button
            variant="outline"
            aria-expanded={open}
            aria-label={`怎么装 ${preset.name}`}
            onClick={() => {
              setOpen(!open)
            }}>
            怎么装
          </Button>
        }
      />
      <Collapse open={open} lazy>
        <div className="agent-how">
          <div className="agent-how-command">
            {preset.install && (
              <>
                <span className="agent-how-prompt" aria-hidden="true">
                  $
                </span>
                <code>{preset.install}</code>
              </>
            )}
            <span className="agent-how-actions">
              {preset.install && <CopyButton text={preset.install} label={`复制 ${preset.name} 的安装命令`} size="xs" />}
              {preset.install && <TerminalFillButton command={preset.install} detached />}
              <Button size="xs" variant="ghost" icon={RefreshGlyph} loading={checking} onClick={onRecheck}>
                重新检测
              </Button>
            </span>
          </div>
          {preset.installNote && <p className="agent-how-note">{preset.installNote}</p>}
          <span className="agent-how-custom">
            <Button variant="link" size="xs" onClick={onCustom}>
              {CUSTOM_START}…
            </Button>
          </span>
        </div>
      </Collapse>
    </div>
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
  const on = onComputer(deviceAccess(snapshot, currentShell()).local, snapshot.hostName)
  const { found, installable } = presetGroups(data.presets, data.agents)
  const { installed, missing } = engineGroups(data.agents)
  const custom = (preset: AgentPreset) => {
    setEditing({ kind: 'new', preset })
  }
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
            icon={PlusGlyph}
            onClick={() => {
              setEditing({ kind: 'new' })
            }}>
            自定义 Harness
          </Button>
        }
        note={<NoteLine icon={ShieldGlyph} brief={RUNS_AS_YOU_COPY.engines(on)} />}>
        {builtin && (
          <SettingsRow
            className="agent-row"
            leading={<HarnessTile harness={builtin} size={24} />}
            record
            title={harnessName(builtin)}
            description="内置，用你接入的模型服务"
            trailing={<span className="service-status">{builtin.status === 'ready' ? '可用' : '需要模型服务'}</span>}
          />
        )}
        {installed.map(engineRow)}
        {found.map(preset => (
          <FoundRow key={preset.id} preset={preset} onOpen={() => custom(preset)} />
        ))}
      </SettingsGroup>
      {(missing.length > 0 || installable.length > 0) && (
        <SettingsGroup title="可以安装">
          {missing.map(engineRow)}
          {installable.map(preset => (
            <InstallRow
              key={preset.id}
              preset={preset}
              checking={checking}
              onRecheck={() => void recheck()}
              onCustom={() => custom(preset)}
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
      title: editing.preset ? CUSTOM_START : '自定义 Harness',
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
          loginSurface={loginSurface(snapshot.catalog?.features)}
          run={snapshot.device.scopes?.includes('run') === true}
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
          on={on}
          local={deviceAccess(snapshot, currentShell()).local}
        />
      ),
    })

  return <SettingsPages main={main} levels={levels} />
}
