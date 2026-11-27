import { Fragment, useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { CircleArrowUp, ShieldCheck, ShieldQuestion } from 'lucide-react'
import {
  harnessAccountDirectories,
  runsPresetFallback,
  type AgentPresetSettings,
  type AgentSettings,
  type AppSnapshot,
  type AgentPreset,
  type HarnessInfo,
} from '@latch/protocol'
import { api, ApiError, errorMessage, inlineError, isUncertain, MessageError } from '../core/api.ts'
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
  Menu,
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
import { defineCopy, formatNumber } from '../core/i18n.ts'
import { harnessPresetCopy } from '../core/harnessPresetCopy.ts'
import { harnessAccountAlias } from '../core/harnessName.ts'

const COPY = defineCopy(
  {
    accounts: '账号',
    accountCount: (count: number) => `${formatNumber(count)} 个账号`,
    accountGroupLabel: (name: string, count: string) => `${name}，${count}`,
    defaultAccount: '默认账号',
    defaultLaunch: '默认启动方式',
    addAccount: '添加账号…',
    accountTitle: (name: string) => `添加 ${name} 账号`,
    accountAlias: '账号名称',
    aliasExample: '例如：工作',
    accountDirectory: '已登录的配置目录',
    key: '此账号的 Cursor API 密钥',
    enterpriseAccount: 'Gemini Enterprise 账号',
    enterpriseDirectory: 'ADC 凭据目录',
    enterpriseHint: '填写这台 Mac 上存有 Gemini Enterprise 应用默认凭据（application_default_credentials.json）的目录绝对路径。',
    codexLogin: '先在终端用 CODEX_HOME 指定此目录，再运行 codex login。',
    gooseLogin: '请使用 GOOSE_DISABLE_KEYRING=1 在此目录完成原生登录。',
    directoryHint: '填写这台 Mac 上此账号专用目录的绝对路径。',
    directoryBinding: '用这个账号开始的会话会一直绑定此目录。要用其他目录，请另加账号。',
    directoryLayout: '原生 CLI 登录和运行时使用的目录',
    chosenDirectory: '所选目录',
    addAccountButton: '添加账号',
    retryAccount: '重试添加',
    accountUnknown: '添加结果未知。重试会检查此账号是否已保存。',
    leaveAccount: '关闭',
    removeAccount: '移除账号',
    removeAccountConfirm: (name: string) => `从 Latch 移除「${name}」？原生 CLI 的配置目录和登录会保留。`,
    removeKeyAccountConfirm: (name: string) => `从 Latch 移除「${name}」？此账号在这台 Mac 上保存的 API 密钥也会删除。`,
    customStart: '自定义启动方式',
    environmentStored: '只存在这台 Mac 上，不再显示',
    notStarted: '还没有开启过会话',
    recheckAfterInstall: '；安装后点「重新检测」',
    found: '已找到',
    installCommand: '安装命令',
    copyInstall: '复制安装命令',
    homepage: '项目主页',
    open: '打开',
    variableName: '变量名',
    variableValue: '变量值',
    value: '值',
    removeVariable: '删除此变量',
    nameAndCommand: '请填写名称和启动命令。',
    customHarness: '自定义 Harness',
    programHere: '在这台 Mac 上运行的程序',
    presetDescription: (name: string, description: string) => `${name}：${description}`,
    install: '安装',
    launch: '启动方式',
    name: '名称',
    launchCommand: '启动命令',
    example: '例如 codex-acp',
    arguments: '参数',
    perLine: '每行一个',
    enableAfter: '添加后启用',
    environment: '环境变量',
    addVariable: '添加变量',
    noEnvironment: '没有环境变量',
    cancel: '取消',
    addHarness: '添加 Harness',
    editLaunch: '编辑启动方式',
    save: '保存',
    addEnvironment: '添加环境变量',
    add: '添加',
    environmentExample: '例如 OPENAI_BASE_URL',
    invalidVariable: '只能包含字母、数字和下划线，不能以数字开头',
    rename: '重命名…',
    enabled: '启用',
    edit: '编辑…',
    command: '命令',
    none: '无',
    addEllipsis: '添加…',
    set: '已设置',
    remove: '移除',
    detection: '检测',
    checkAgain: '重新检测',
    notLaunchable: '还不能启动',
    updateNeeded: '需要升级',
    commandFound: '已找到命令',
    copyUpdate: '复制升级命令',
    copyCommandPath: '复制命令路径',
    upgradeCommand: '升级命令',
    updateAvailable: '有新版本',
    newerThan: (latest: string, current: string) => `${latest}（当前 ${current}）`,
    definitionProblem: '定义有问题',
    listed: 'Latch 已收录',
    unverified: '未验证的定义',
    differentCommand: '命令或参数与 Latch 收录的不同',
    extensions: '技能、命令、MCP 与插件',
    deleteHarness: '删除 Harness',
    delete: '删除',
    renameHarness: '重命名 Harness',
    notInstalled: '未安装',
    needsAttention: '需要处理',
    needsConfirm: '需要确认',
    programMoved: '命令找到了另一个程序',
    confirmedBefore: '原先确认的',
    confirmProgram: '确认新程序',
    confirmProgramName: (name: string) => `确认 ${name} 的新程序`,
    disabled: '已停用',
    available: '可用',
    versionUnread: '版本未读：添加并在这台 Mac 上确认后读取',
    howToInstall: '怎么装',
    installed: '已安装',
    builtIn: '内置，用你接入的模型服务',
    needsProvider: '需要模型服务',
    offers: '可以安装',
    notAdmin: '这台设备没有管理这台 Mac 的权限。',
    cannotRun: '此设备没有发起和继续会话的权限。',
    commandFirst: '先安装或配置 Harness 命令，再测试启动。',
    onThisMac: '这台 Mac 上',
    onComputer: (name: string) => ` ${name} 上`,
    launchWhere: (place: string) => `在${place}启动 · 外部 Harness`,
    openHomepage: (name: string) => `打开 ${name} 的项目主页`,
    invalidName: (key: string) => `环境变量名「${key}」无效，只能包含字母、数字和下划线。`,
    removeName: (name: string) => `移除 ${name}`,
    deleteConfirm: (name: string) => `删除「${name}」的启动配置和环境变量？它的会话正在运行时无法删除。`,
    editName: (name: string) => `编辑 ${name}`,
    via: (command: string) => `经 ${command}`,
    enableName: (name: string) => `启用 ${name}`,
    offerLabel: (name: string, note: string, launch: string) => `${name}，${note}，${launch}`,
    foundWithNote: (found: string, note: string) => `${found}，${note}`,
    needAdapter: (program: string) => `找到了 ${program}，还差让 Latch 连接它的适配器`,
    installHelp: (name: string) => `怎么装 ${name}`,
    copyInstallFor: (name: string) => `复制 ${name} 的安装命令`,
  },
  {
    accounts: 'Accounts',
    accountCount: (count: number) => `${formatNumber(count)} accounts`,
    accountGroupLabel: (name: string, count: string) => `${name}, ${count}`,
    defaultAccount: 'Default account',
    defaultLaunch: 'Default launch',
    addAccount: 'Add account…',
    accountTitle: (name: string) => `Add ${name} account`,
    accountAlias: 'Account name',
    aliasExample: 'e.g. Work',
    accountDirectory: 'Signed-in configuration directory',
    key: 'Cursor API key for this account',
    enterpriseAccount: 'Gemini Enterprise account',
    enterpriseDirectory: 'ADC credentials directory',
    enterpriseHint:
      'Enter the absolute path on this Mac to the directory containing your Gemini Enterprise Application Default Credentials (application_default_credentials.json).',
    codexLogin: 'In Terminal, set CODEX_HOME to this directory when running codex login.',
    gooseLogin: 'Sign in with GOOSE_DISABLE_KEYRING=1 for this directory.',
    directoryHint: 'Enter the absolute path to this account’s own directory on this Mac.',
    directoryBinding: 'Sessions started with this account stay bound to this directory. To use another directory, add another account.',
    directoryLayout: 'Directories used for native CLI sign-in and sessions',
    chosenDirectory: 'Selected directory',
    addAccountButton: 'Add account',
    retryAccount: 'Retry adding account',
    accountUnknown: 'Outcome unknown. Retrying checks whether this account was already saved.',
    leaveAccount: 'Close',
    removeAccount: 'Remove account',
    removeAccountConfirm: (name: string) => `Remove “${name}” from Latch? Its native CLI configuration directory and login will be kept.`,
    removeKeyAccountConfirm: (name: string) =>
      `Remove “${name}” from Latch? This also deletes the API key saved for this account on this Mac.`,
    customStart: 'Custom launch',
    environmentStored: 'Kept only on this Mac, never shown again',
    notStarted: 'No sessions started yet',
    recheckAfterInstall: ' After installing, check again.',
    found: 'Found',
    installCommand: 'Install command',
    copyInstall: 'Copy install command',
    homepage: 'Homepage',
    open: 'Open',
    variableName: 'Name',
    variableValue: 'Value',
    value: 'Value',
    removeVariable: 'Remove variable',
    nameAndCommand: 'Enter a name and a launch command.',
    customHarness: 'Custom Harness',
    programHere: 'A program that runs on this Mac',
    presetDescription: (name: string, description: string) => `${name} · ${description}`,
    install: 'Install',
    launch: 'Launch',
    name: 'Name',
    launchCommand: 'Launch command',
    example: 'e.g. codex-acp',
    arguments: 'Arguments',
    perLine: 'One per line',
    enableAfter: 'Enable after adding',
    environment: 'Environment variables',
    addVariable: 'Add variable',
    noEnvironment: 'No environment variables',
    cancel: 'Cancel',
    addHarness: 'Add Harness',
    editLaunch: 'Edit launch',
    save: 'Save',
    addEnvironment: 'Add environment variable',
    add: 'Add',
    environmentExample: 'e.g. OPENAI_BASE_URL',
    invalidVariable: 'Letters, digits and underscores only, not starting with a digit',
    rename: 'Rename…',
    enabled: 'Enable',
    edit: 'Edit…',
    command: 'Command',
    none: 'None',
    addEllipsis: 'Add…',
    set: 'Set',
    remove: 'Remove',
    detection: 'Detection',
    checkAgain: 'Check again',
    notLaunchable: 'Can’t launch yet',
    updateNeeded: 'Update required',
    commandFound: 'Command found',
    copyUpdate: 'Copy update command',
    copyCommandPath: 'Copy command path',
    upgradeCommand: 'Update command',
    updateAvailable: 'Update available',
    newerThan: (latest: string, current: string) => `${latest} (current ${current})`,
    definitionProblem: 'Definition has a problem',
    listed: 'Listed by Latch',
    unverified: 'Unverified definition',
    differentCommand: 'Command or arguments differ from Latch’s listing',
    extensions: 'Skills, commands, MCP, and plugins',
    deleteHarness: 'Delete Harness',
    delete: 'Delete',
    renameHarness: 'Rename Harness',
    notInstalled: 'Not installed',
    needsAttention: 'Needs attention',
    needsConfirm: 'Needs confirming',
    programMoved: 'The command finds another program',
    confirmedBefore: 'Confirmed before',
    confirmProgram: 'Confirm new program',
    confirmProgramName: (name: string) => `Confirm ${name}’s new program`,
    disabled: 'Off',
    available: 'Available',
    versionUnread: 'Version unread. Add and confirm on this Mac to read it.',
    howToInstall: 'How to install',
    installed: 'Installed',
    builtIn: 'Built in, uses your model services',
    needsProvider: 'Needs a model service',
    offers: 'Available to install',
    notAdmin: 'This device doesn’t have permission to manage this Mac.',
    cannotRun: 'This device can’t start or continue sessions.',
    commandFirst: 'Install or set up the Harness command, then test the launch.',
    onThisMac: 'on this Mac',
    onComputer: (name: string) => `on ${name}`,
    launchWhere: (place: string) => `Launches ${place} · External Harness`,
    openHomepage: (name: string) => `Open the ${name} homepage`,
    invalidName: (key: string) => `The environment variable “${key}” is invalid. Use only letters, numbers, and underscores.`,
    removeName: (name: string) => `Remove ${name}`,
    deleteConfirm: (name: string) =>
      `Delete the launch configuration and environment variables for “${name}”? Wait for its running sessions to finish before deleting it.`,
    editName: (name: string) => `Edit ${name}`,
    via: (command: string) => `Via ${command}`,
    enableName: (name: string) => `Enable ${name}`,
    offerLabel: (name: string, note: string, launch: string) => `${name}, ${note}, ${launch}`,
    foundWithNote: (found: string, note: string) => `${found}. ${note}`,
    needAdapter: (program: string) => `Found ${program}. Set up its adapter to connect it to Latch.`,
    installHelp: (name: string) => `How to install ${name}`,
    copyInstallFor: (name: string) => `Copy the ${name} install command`,
  },
)

interface AgentsResponse {
  agents: AgentSettings[]
  presets: AgentPresetSettings[]
}
type Editing = { kind: 'agent'; id: string } | { kind: 'new'; preset?: AgentPreset } | null

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Where the Harnesses run, as a person on this device names that computer: 「这台 Mac」 in its own app, else its name. */
const onComputer = (local: boolean, hostName?: string) => (local ? COPY.onThisMac : COPY.onComputer(computerName(hostName)))
/** A session started with a definition is an external Harness's session: it decides its own reach, Latch does not isolate it. */
function FullAccessNote() {
  return <NoteLine icon={ShieldGlyph} brief={SETUP_COPY.externalNote} />
}
const lines = (text: string) =>
  text
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean)

/**
 * Its command now finds another program than the one this Mac confirmed: saving the definition again on this Mac shows
 * the new one on the confirmation sheet, and binds it.
 */
const commandMoved = (harness?: HarnessInfo): boolean => harness?.status === 'unavailable' && harness.statusReason === 'moved'

/** A save waits this long at most for the catalog: queued syncs can keep one going, and the page stays busy meanwhile. */
const CATALOG_WAIT_MS = 5_000

/** What the Host found for an agent's command, in one line; ready is the default state and stays quiet. */
function Detection({ agent, preset, harness }: { agent: AgentSettings; preset?: AgentPreset; harness?: HarnessInfo }) {
  const missing = missingText(agent)
  if (missing)
    return (
      <span className="detect is-warn">
        <Icon icon={AlertGlyph} size={12} />
        <span>
          {missing}
          {preset ? COPY.recheckAfterInstall : ''}
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
      <span className="detect-label">{COPY.found}</span>
      <MiddleEllipsis text={agent.detected.path ?? agent.command} className="detect-path" />
    </span>
  )
}

/** The preset's install command and project page as two rows of a card. */
function InstallRows({ preset, showInstall = true }: { preset: AgentPreset; showInstall?: boolean }) {
  return (
    <>
      {showInstall && preset.install && (
        <SettingsRow
          title={COPY.installCommand}
          description={<code className="settings-mono">{preset.install}</code>}
          trailing={
            <span className="command-actions">
              <CopyButton text={preset.install} label={COPY.copyInstall} />
              <TerminalFillButton command={preset.install} detached />
            </span>
          }
        />
      )}
      <SettingsRow
        title={COPY.homepage}
        description={`${hostOf(preset.homepage)} · ${harnessPresetCopy(preset).license}`}
        trailing={
          <ButtonLink
            variant="ghost"
            href={preset.homepage}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={COPY.openHomepage(preset.name)}>
            {COPY.open}
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
            aria-label={COPY.variableName}
            placeholder={COPY.variableName}
            value={item.key}
            spellCheck={false}
            autoComplete="off"
            onChange={event => {
              onChange(entries.map((entry, i) => (i === index ? { ...entry, key: event.target.value } : entry)))
            }}
          />
          <input
            className="ui-input"
            aria-label={COPY.variableValue}
            type="password"
            placeholder={COPY.value}
            value={item.value}
            autoComplete="new-password"
            onChange={event => {
              onChange(entries.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)))
            }}
          />
          <IconButton
            label={COPY.removeVariable}
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
      setError(COPY.nameAndCommand)
      return
    }
    const invalid = invalidEnv(env)
    if (invalid) {
      setError(COPY.invalidName(invalid.key))
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
        title={preset ? COPY.customStart : COPY.customHarness}
        description={preset ? COPY.presetDescription(preset.name, harnessPresetCopy(preset).description) : COPY.programHere}
      />
      {preset && (
        <SettingsGroup title={COPY.install}>
          <InstallRows preset={preset} />
        </SettingsGroup>
      )}
      <SettingsGroup title={COPY.launch} note={<NoteLine icon={ShieldGlyph} brief={SETUP_COPY.agentFullAccess} />}>
        <div className="settings-card-body settings-fields">
          <TextField
            label={COPY.name}
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={event => {
              setName(event.target.value)
            }}
          />
          <TextField
            label={COPY.launchCommand}
            value={command}
            spellCheck={false}
            autoComplete="off"
            placeholder={COPY.example}
            onChange={event => {
              setCommand(event.target.value)
            }}
          />
          <TextAreaField
            label={COPY.arguments}
            hint={COPY.perLine}
            rows={3}
            value={args}
            spellCheck={false}
            onChange={event => {
              setArgs(event.target.value)
            }}
          />
        </div>
        <SwitchRow className="settings-row" title={COPY.enableAfter} checked={enabled} onCheckedChange={setEnabled} />
      </SettingsGroup>
      <SettingsGroup
        title={COPY.environment}
        meta={
          <Button
            variant="link"
            size="xs"
            onClick={() => {
              setEnv(previous => [...previous, { key: '', value: '' }])
            }}>
            {COPY.addVariable}
          </Button>
        }
        caption={COPY.environmentStored}
        captionIcon="lock">
        {env.length === 0 && <SettingsRow title={COPY.noEnvironment} />}
        <EnvFields entries={env} onChange={setEnv} />
      </SettingsGroup>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <InlineConfirm active={busy} rank={1} />
      <div className="settings-actions">
        <Button size="md" disabled={busy} onClick={onCancel}>
          {COPY.cancel}
        </Button>
        <Button size="md" type="submit" variant="primary" loading={busy}>
          {COPY.addHarness}
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
      title={COPY.editLaunch}
      onClose={() => {
        if (!busy) onClose()
      }}
      footer={
        <>
          <Button size="md" disabled={busy} onClick={onClose}>
            {COPY.cancel}
          </Button>
          <Button size="md" variant="primary" type="submit" form={form} disabled={!command.trim()} loading={busy}>
            {COPY.save}
          </Button>
        </>
      }>
      <form
        id={form}
        className="settings-form"
        onSubmit={event => {
          void submit(event)
        }}>
        <FullAccessNote />
        <TextField
          label={COPY.launchCommand}
          value={command}
          spellCheck={false}
          autoComplete="off"
          onChange={event => {
            setCommand(event.target.value)
          }}
        />
        <TextAreaField
          label={COPY.arguments}
          hint={COPY.perLine}
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
      title={COPY.addEnvironment}
      subtitle={COPY.environmentStored}
      onClose={() => {
        if (!busy) close()
      }}
      footer={
        <>
          <Button size="md" disabled={busy} onClick={close}>
            {COPY.cancel}
          </Button>
          <Button size="md" variant="primary" type="submit" form={form} disabled={!key.trim() || invalid} loading={busy}>
            {COPY.add}
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
          label={COPY.variableName}
          value={key}
          spellCheck={false}
          autoComplete="off"
          placeholder={COPY.environmentExample}
          error={invalid ? COPY.invalidVariable : undefined}
          onChange={event => {
            setKey(event.target.value)
            setError('')
          }}
        />
        <TextField
          label={COPY.value}
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

function AccountDialog({
  preset,
  directories,
  onAdded,
  onClose,
}: {
  preset: AgentPreset
  directories: Readonly<Record<string, string>> | undefined
  onAdded: (agent: AgentSettings) => void
  onClose: (unknown: boolean) => void
}) {
  const form = useId()
  const [cursorId] = useState(() => (directories ? undefined : `cursor-key-${crypto.randomUUID()}`))
  const [alias, setAlias] = useState('')
  const [directory, setDirectory] = useState('')
  const [apiKey, setApiKey] = useState('')
  const name = `${preset.name} · ${alias.trim()}`
  const ready = alias.trim() && (directories ? directory.trim().startsWith('/') : apiKey.trim())
  const [busy, setBusy] = useState(false)
  const [unknown, setUnknown] = useState(false)
  const [error, setError] = useState('')
  const readSaved = async (id: string) => {
    const saved = await api<AgentsResponse>('agents?recheck=0').catch(() => undefined)
    return saved?.agents.find(item => item.id === id && item.presetId === preset.id && item.name === name && item.account)
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !ready) return
    setBusy(true)
    setError('')
    try {
      if (unknown && cursorId) {
        const saved = await readSaved(cursorId)
        if (saved) {
          onAdded(saved)
          return
        }
      }
      const body = {
        presetId: preset.id,
        name,
        command: preset.command,
        args: preset.args,
        enabled: true,
        ...(directories ? { accountDirectory: directory.trim(), env: {} } : { id: cursorId, env: { CURSOR_API_KEY: apiKey.trim() } }),
      }
      const { agent } = await withConfirmation(confirmation =>
        api<{ agent: AgentSettings }>('agents', { method: 'POST', body, ...(confirmation ? { confirmation } : {}) }),
      )
      onAdded(agent)
    } catch (cause) {
      if (unknown || isUncertain(cause)) {
        // On a repeated binding, the Host identifies a definition only when its canonical directory and preset match.
        const boundId = unknown && cause instanceof ApiError && cause.code === 'agent-account-bound' ? cause.details.agentId : undefined
        const id = cursorId ?? boundId
        const agent = typeof id === 'string' ? await readSaved(id) : undefined
        if (agent) {
          onAdded(agent)
          return
        }
        setUnknown(true)
      }
      setError(inlineError(cause))
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      secure
      className="harness-account-dialog"
      title={preset.id === 'antigravity' ? COPY.enterpriseAccount : COPY.accountTitle(preset.name)}
      size="lg"
      onClose={() => {
        if (!busy) onClose(unknown)
      }}
      footer={
        <>
          <Button size="md" disabled={busy} onClick={() => onClose(unknown)}>
            {unknown ? COPY.leaveAccount : COPY.cancel}
          </Button>
          <Button size="md" type="submit" form={form} variant="primary" loading={busy} disabled={!ready}>
            {unknown ? COPY.retryAccount : COPY.addAccountButton}
          </Button>
        </>
      }>
      <form
        id={form}
        className="settings-form"
        onSubmit={event => {
          void save(event)
        }}>
        <TextField
          label={COPY.accountAlias}
          value={alias}
          placeholder={COPY.aliasExample}
          autoComplete="off"
          maxLength={80 - preset.name.length - 3}
          readOnly={busy || unknown}
          onChange={event => setAlias(event.target.value)}
        />
        {directories ? (
          <>
            <TextField
              label={preset.id === 'antigravity' ? COPY.enterpriseDirectory : COPY.accountDirectory}
              value={directory}
              maxLength={4096}
              autoComplete="off"
              spellCheck={false}
              readOnly={busy || unknown}
              hint={`${preset.id === 'antigravity' ? COPY.enterpriseHint : COPY.directoryHint} ${COPY.directoryBinding}`}
              onChange={event => setDirectory(event.target.value)}
            />
            <SettingsGroup title={COPY.directoryLayout}>
              {Object.entries(directories).map(([key, subdirectory]) => (
                <SettingsRow
                  key={key}
                  title={<code>{key}</code>}
                  description={subdirectory ? `${COPY.chosenDirectory}/${subdirectory}` : COPY.chosenDirectory}
                />
              ))}
            </SettingsGroup>
            {preset.id === 'codex' && <p>{COPY.codexLogin}</p>}
            {preset.id === 'goose' && <p>{COPY.gooseLogin}</p>}
          </>
        ) : (
          <TextField
            label={COPY.key}
            hint={COPY.environmentStored}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            readOnly={busy || unknown}
            value={apiKey}
            onChange={event => setApiKey(event.target.value)}
          />
        )}
        {unknown && <InlineNotice tone="warn">{COPY.accountUnknown}</InlineNotice>}
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
  onAddAccount,
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
  onSaved: () => Promise<void>
  onDeleted: () => void
  onAddAccount?: ((preset: AgentPreset) => void) | undefined
  /** 「这台 Mac 上」 or 「 <name> 上」: where the definition starts. */
  on: string
  /** The desktop app on this Mac: the only place a command, its arguments or variables can change. */
  local?: boolean
}) {
  const [saving, setSaving] = useState<'settings' | 'program' | null>(null)
  const busy = saving !== null
  const confirming = saving === 'program'
  const [error, setError] = useState('')
  const [confirmationAttempt, setConfirmationAttempt] = useState(0)
  const [confirmationError, setConfirmationError] = useState('')
  const confirmationErrorLine = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (confirmationError) confirmationErrorLine.current?.scrollIntoView({ block: 'nearest' })
  }, [confirmationError])
  const [dialog, setDialog] = useState<null | 'name' | 'definition' | 'env'>(null)
  const [removing, setRemoving] = useState(false)
  const [enabled, setEnabled] = useState(agent.enabled)
  const [seen, setSeen] = useState(agent.enabled)
  if (seen !== agent.enabled) {
    setSeen(agent.enabled)
    setEnabled(agent.enabled)
  }
  const directories = preset && harnessAccountDirectories(preset.id)
  const canAddAccount = local && onAddAccount && preset && (directories || preset.id === 'cursor')
  const canEditLaunch = local && !(directories && agent.account)
  const keyAccount = agent.account && agent.presetId === 'cursor'
  const id = encodeURIComponent(agent.id)

  /** One change. */
  const update = async (body: Record<string, unknown>, action: 'settings' | 'program' = 'settings'): Promise<string> => {
    setSaving(action)
    setError('')
    try {
      // Another command, other arguments or a variable's new value: the Host asks for Touch ID on this Mac first.
      await withConfirmation(confirmation => api(`agents/${id}`, { method: 'PUT', body, ...(confirmation ? { confirmation } : {}) }))
      if (action === 'program') await onSaved()
      else void onSaved()
      return ''
    } catch (cause) {
      return inlineError(cause)
    } finally {
      setSaving(null)
    }
  }
  const missing = missingText(agent) !== undefined
  const moved = !missing && !agent.detected.outdated && commandMoved(harness)
  const confirmMoved = async () => {
    setConfirmationError('')
    setConfirmationAttempt(attempt => attempt + 1)
    setConfirmationError(await update({ command: agent.command }, 'program'))
  }
  return (
    <>
      <SectionHeading
        title={agent.name}
        description={COPY.launchWhere(on)}
        action={
          <Button
            disabled={busy}
            onClick={() => {
              setDialog('name')
            }}>
            {COPY.rename}
          </Button>
        }
      />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <SettingsGroup>
        <SwitchRow
          className="settings-row"
          title={COPY.enabled}
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
        title={COPY.launch}
        meta={
          canEditLaunch && (
            <Button
              variant="link"
              size="xs"
              disabled={busy}
              onClick={() => {
                setDialog('definition')
              }}>
              {COPY.edit}
            </Button>
          )
        }
        note={<FullAccessNote />}>
        {agent.started === false && <SettingsRow title={COPY.notStarted} />}
        <SettingsRow title={COPY.command} description={<MiddleEllipsis text={agent.command} className="settings-mono" />} />
        <SettingsRow
          title={COPY.arguments}
          description={agent.args.length > 0 ? <MiddleEllipsis text={agent.args.join(' ')} className="settings-mono" /> : COPY.none}
        />
      </SettingsGroup>
      <SettingsGroup
        title={COPY.environment}
        meta={
          canEditLaunch && (
            <Button
              variant="link"
              size="xs"
              disabled={busy}
              onClick={() => {
                setDialog('env')
              }}>
              {COPY.addEllipsis}
            </Button>
          )
        }
        caption={COPY.environmentStored}
        captionIcon="lock">
        <InlineConfirm active={saving === 'settings' && dialog === null} rank={1} />
        {agent.envKeys.length === 0 && <SettingsRow title={COPY.noEnvironment} />}
        {agent.envKeys.map(key => (
          <SettingsRow
            key={key}
            title={<code className="settings-mono">{key}</code>}
            description={COPY.set}
            trailing={
              canEditLaunch
              && !(keyAccount && agent.id.startsWith('cursor-key-') && key === 'CURSOR_API_KEY') && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  aria-label={COPY.removeName(key)}
                  onClick={() => {
                    void update({ env: { [key]: null } }).then(text => {
                      if (text) setError(text)
                    })
                  }}>
                  {COPY.remove}
                </Button>
              )
            }
          />
        ))}
      </SettingsGroup>
      <SettingsGroup
        title={COPY.detection}
        meta={
          <Button variant="ghost" size="xs" icon={RefreshGlyph} loading={checking} onClick={onRecheck}>
            {COPY.checkAgain}
          </Button>
        }>
        {moved ? (
          <SettingsRow
            leading={<IconTile icon={AlertGlyph} />}
            title={COPY.programMoved}
            description={
              // Elsewhere the Host's reason says where it is confirmed.
              local ? (
                <MiddleEllipsis text={agent.detected.path ?? agent.command} className="settings-mono" />
              ) : (
                <Detection agent={agent} preset={preset} harness={harness} />
              )
            }
            trailing={
              local ? (
                <Button variant="secondary" disabled={busy} pending={confirming} onClick={() => void confirmMoved()}>
                  {COPY.confirmProgram}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <SettingsRow
            leading={<IconTile icon={missing || agent.detected.outdated ? AlertGlyph : CircleCheckGlyph} />}
            title={missing ? COPY.notLaunchable : agent.detected.outdated ? COPY.updateNeeded : COPY.commandFound}
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
                  <CopyButton text={agent.detected.outdated.upgrade} label={COPY.copyUpdate} />
                  <TerminalFillButton command={agent.detected.outdated.upgrade} detached />
                </span>
              ) : agent.detected.path ? (
                <CopyButton text={agent.detected.path} label={COPY.copyCommandPath} />
              ) : undefined
            }
          />
        )}
        {moved && harness?.bound?.path && (
          <SettingsRow title={COPY.confirmedBefore} description={<MiddleEllipsis text={harness.bound.path} className="settings-mono" />} />
        )}
        {moved && local && confirmationAttempt > 0 && (
          <>
            <InlineConfirm key={confirmationAttempt} active={confirming} rank={1} reveal />
            {confirmationError && (
              <div ref={confirmationErrorLine}>
                <InlineNotice tone="error" secure>
                  {confirmationError}
                </InlineNotice>
              </div>
            )}
          </>
        )}
        {agent.detected.outdated && (
          <SettingsRow title={COPY.upgradeCommand} description={<span className="settings-mono">{agent.detected.outdated.upgrade}</span>} />
        )}
        {!missing && !agent.detected.outdated && agent.detected.update && (
          <SettingsRow
            leading={<IconTile icon={CircleArrowUp} />}
            title={COPY.updateAvailable}
            description={
              <span className="settings-mono">{COPY.newerThan(agent.detected.update.latest, agent.detected.update.current)}</span>
            }
            trailing={
              agent.detected.update.command ? (
                <span className="command-actions">
                  <CopyButton text={agent.detected.update.command} label={COPY.copyUpdate} />
                  <TerminalFillButton command={agent.detected.update.command} detached />
                </span>
              ) : undefined
            }
          />
        )}
        {agent.problem && (
          <SettingsRow
            leading={<IconTile icon={AlertGlyph} />}
            title={COPY.definitionProblem}
            description={<span className="detect is-warn">{agent.problem}</span>}
          />
        )}
        <SettingsRow
          leading={<IconTile icon={agent.verified ? ShieldCheck : ShieldQuestion} />}
          title={agent.verified ? COPY.listed : COPY.unverified}
          description={agent.verified ? undefined : COPY.differentCommand}
        />
        {preset && <InstallRows preset={preset} showInstall={!agent.detected.outdated && !agent.detected.update?.command} />}
      </SettingsGroup>
      {canAddAccount && preset && onAddAccount && (
        <SettingsGroup>
          <NavRow title={COPY.addAccount} onClick={() => onAddAccount(preset)} />
        </SettingsGroup>
      )}
      {harness?.login && <LoginGroup harness={harness} allowed={run} surface={surface} probe={agent.lastProbe} />}
      {harness && <ExtensionsLink title={COPY.extensions} harnessId={harness.id} />}
      {probe && (
        <AgentProbe
          agent={agent}
          disabled={busy}
          disabledReason={probeDisabledReason}
          onSaved={() => {
            void onSaved()
          }}
        />
      )}
      <SettingsGroup>
        <SettingsRow
          title={agent.account ? COPY.removeAccount : COPY.deleteHarness}
          trailing={
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setRemoving(true)
              }}>
              {agent.account ? COPY.remove : COPY.delete}
            </Button>
          }
        />
      </SettingsGroup>
      <FieldDialog
        open={dialog === 'name'}
        title={COPY.renameHarness}
        label={COPY.name}
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
          title={agent.account ? COPY.removeAccount : COPY.deleteHarness}
          danger
          confirmLabel={agent.account ? COPY.remove : COPY.delete}
          message={
            keyAccount
              ? COPY.removeKeyAccountConfirm(agent.name)
              : agent.account
                ? COPY.removeAccountConfirm(agent.name)
                : COPY.deleteConfirm(agent.name)
          }
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
        {missing !== undefined
          ? COPY.notInstalled
          : agent.detected.outdated
            ? COPY.updateNeeded
            : commandMoved(harness)
              ? COPY.needsConfirm
              : COPY.needsAttention}
      </span>
    )
  }
  if (!agent.enabled) return <span className="service-status">{COPY.disabled}</span>
  return (
    <span
      className="service-status"
      {...(agent.detected.update ? { title: COPY.newerThan(agent.detected.update.latest, agent.detected.update.current) } : {})}>
      {agent.detected.update ? COPY.updateAvailable : COPY.available}
    </span>
  )
}

interface HarnessAccountGroup {
  preset: AgentPresetSettings
  accounts: AgentSettings[]
  foundDefault: boolean
}
type EngineListItem = AgentSettings | HarnessAccountGroup

/** A group stays together as long as any member's command, or its default launch, is found. */
function isInstalled(item: EngineListItem): boolean {
  return 'accounts' in item ? item.foundDefault || item.accounts.some(agent => agent.detected.found) : item.detected.found
}

export const engineGroups = <T extends EngineListItem>(items: readonly T[]) => ({
  installed: items.filter(isInstalled),
  missing: items.filter(item => !isInstalled(item)),
})

/**
 * The presets with no saved definition: found on the computer (an executable with the command's name is there), which
 * stand with what is installed, and the rest, which can be installed. A Host that sends no detection finds none.
 */
export function presetGroups(presets: readonly AgentPresetSettings[], agents: readonly Pick<AgentSettings, 'presetId' | 'account'>[]) {
  const unsaved = presets.filter(preset => !agents.some(agent => !agent.account && agent.presetId === preset.id))
  return {
    found: unsaved.filter(preset => preset.detected?.found === true),
    installable: unsaved.filter(preset => preset.detected?.found !== true),
  }
}

export function settingsEngines(presets: readonly AgentPresetSettings[], agents: readonly AgentSettings[]) {
  const { found, installable } = presetGroups(presets, agents)
  const groupedPresets = new Set<string>()
  const groupFor = new Map<string, HarnessAccountGroup>()
  for (const preset of presets) {
    const matching = agents.filter(agent => agent.presetId === preset.id)
    const separate = matching.filter(agent => agent.account)
    if (separate.length === 0) continue
    // More than one verified definition can point at the same default account.
    const defaults = matching.filter(agent => agent.verified && !agent.account)
    const defaultAccount = defaults.find(agent => agent.id === preset.id) ?? defaults[0]
    const accounts = defaultAccount ? [defaultAccount, ...separate] : separate
    if (accounts.length < 2) continue
    const group = { preset, accounts, foundDefault: found.includes(preset) }
    groupedPresets.add(preset.id)
    for (const account of accounts) groupFor.set(account.id, group)
  }

  const entries: EngineListItem[] = []
  const emitted = new Set<HarnessAccountGroup>()
  for (const agent of agents) {
    const group = groupFor.get(agent.id)
    if (!group) entries.push(agent)
    else if (!emitted.has(group)) {
      emitted.add(group)
      entries.push(group)
    }
  }
  return { ...engineGroups(entries), found: found.filter(preset => !groupedPresets.has(preset.id)), installable }
}

function accountRowTitle(agent: AgentSettings, brand: string): string {
  if (!agent.account && agent.name === brand) return COPY.defaultAccount
  return harnessAccountAlias(agent.name, brand) || agent.name
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
  confirming = false,
  onOpen,
  onToggle,
  local = false,
  onConfirm,
  accountBrand,
}: {
  agent: AgentSettings
  preset?: AgentPreset
  harness?: HarnessInfo
  busy: boolean
  confirming?: boolean
  onOpen: () => void
  onToggle: () => void
  /** The desktop app on this Mac, where a moved command is confirmed. */
  local?: boolean
  /** Saves the definition as it is, which confirms the program its command now finds. */
  onConfirm?: () => void
  accountBrand?: string
}) {
  // Saved on the preset's adapter rather than its own program: said, with what the direct route needs.
  const viaAdapter = preset?.fallback !== undefined && runsPresetFallback(preset, commandBase(agent.command), agent.args)
  const words = preset && harnessPresetCopy(preset)
  const moved = missingText(agent) === undefined && !agent.detected.outdated && commandMoved(harness)
  const title = accountBrand ? accountRowTitle(agent, accountBrand) : agent.name
  const label = accountBrand ? `${accountBrand} · ${title}` : title
  // Keep the new path visible when a program moves. Ordinary account paths are in the detail page.
  const description =
    moved && agent.detected.path ? (
      <MiddleEllipsis text={agent.detected.path} className="settings-mono" />
    ) : !agent.verified || !preset ? (
      <code className="agent-command">{[agent.command, ...agent.args].join(' ')}</code>
    ) : accountBrand ? undefined : harness?.bound?.path ? (
      <MiddleEllipsis text={harness.bound.path} className="settings-mono" />
    ) : (
      ((viaAdapter ? words?.adapterDescription : undefined) ?? words?.description)
    )
  return (
    <ObjectRow
      className="agent-row"
      label={COPY.editName(label)}
      dim={missingText(agent) !== undefined}
      leading={accountBrand ? undefined : <MarkTile mark={agent.presetId} cold={harness?.status === 'unavailable'} size={24} />}
      title={
        <span className="settings-row-name">
          {title}
          {!agent.verified && <span className="settings-row-note">{COPY.unverified}</span>}
        </span>
      }
      description={description}
      onOpen={onOpen}
      trailing={
        <>
          {viaAdapter && preset?.fallback && (
            <Hint label={COPY.via([preset.fallback.command, ...preset.fallback.args].join(' '))}>{words?.direct}</Hint>
          )}
          {moved && local && onConfirm ? (
            <Button
              variant="secondary"
              disabled={busy}
              pending={confirming}
              aria-label={COPY.confirmProgramName(label)}
              onClick={onConfirm}>
              {COPY.confirmProgram}
            </Button>
          ) : (
            <EngineStatus agent={agent} harness={harness} />
          )}
          <Switch label={COPY.enableName(label)} checked={agent.enabled} disabled={busy} onCheckedChange={onToggle} />
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

function FoundRow({
  preset,
  onOpen,
  inAccountGroup = false,
}: {
  preset: AgentPresetSettings
  onOpen: () => void
  inAccountGroup?: boolean
}) {
  const outdated = preset.detected?.outdated
  const unread = preset.detected?.versionUnread === true
  const title = inAccountGroup ? COPY.defaultLaunch : preset.name
  return (
    <NavRow
      className="agent-row"
      leading={inAccountGroup ? undefined : <MarkTile mark={preset.id} size={24} />}
      record
      title={title}
      description={
        outdated ? (
          <span className="detect is-warn">
            <Icon icon={AlertGlyph} size={12} />
            <span>{outdated.need}</span>
          </span>
        ) : inAccountGroup ? undefined : (
          <MiddleEllipsis text={preset.detected?.path ?? preset.command} className="settings-mono" />
        )
      }
      value={
        outdated ? (
          COPY.updateNeeded
        ) : unread ? (
          // Not run for its version until it is confirmed: 已找到 says only that the program is there.
          // The row's name already says it to assistive tech; pointer and touch get it as the word's tooltip.
          <Tooltip content={COPY.versionUnread} describe={false}>
            <span className="agent-found-unread">{COPY.found}</span>
          </Tooltip>
        ) : (
          COPY.found
        )
      }
      label={COPY.offerLabel(
        inAccountGroup ? `${preset.name} · ${title}` : title,
        outdated ? COPY.updateNeeded : unread ? COPY.foundWithNote(COPY.found, COPY.versionUnread) : COPY.found,
        COPY.customStart,
      )}
      onClick={onOpen}
    />
  )
}

function AccountGroupRow({
  group,
  expanded,
  onSetExpanded,
  renderAccount,
  onOpenDefault,
}: {
  group: HarnessAccountGroup
  expanded: boolean
  onSetExpanded: (expanded: boolean) => void
  renderAccount: (agent: AgentSettings, brand: string) => ReactNode
  onOpenDefault: () => void
}) {
  const id = useId()
  const { preset, accounts, foundDefault } = group
  const count = COPY.accountCount(accounts.length)
  return (
    <div className="agent-account-group">
      <NavRow
        leading={<MarkTile mark={preset.id} size={24} />}
        record
        title={preset.name}
        value={count}
        label={COPY.accountGroupLabel(preset.name, count)}
        disclosure={{ expanded, controls: id }}
        onClick={() => onSetExpanded(!expanded)}
      />
      <Collapse id={id} open={expanded} onReveal={() => onSetExpanded(true)} className="agent-account-list">
        {accounts.map(account => renderAccount(account, preset.name))}
        {foundDefault && <FoundRow preset={preset} inAccountGroup onOpen={onOpenDefault} />}
      </Collapse>
    </div>
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
  const words = harnessPresetCopy(preset)
  return (
    <div className="agent-install">
      <SettingsRow
        className="agent-preset"
        leading={<MarkTile mark={preset.id} size={24} />}
        record
        title={preset.name}
        description={program ? COPY.needAdapter(program) : words.description}
        trailing={
          <Button
            variant="outline"
            aria-expanded={open}
            aria-label={COPY.installHelp(preset.name)}
            onClick={() => {
              setOpen(!open)
            }}>
            {COPY.howToInstall}
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
              {preset.install && <CopyButton text={preset.install} label={COPY.copyInstallFor(preset.name)} size="xs" />}
              {preset.install && <TerminalFillButton command={preset.install} detached />}
              <Button size="xs" variant="ghost" icon={RefreshGlyph} loading={checking} onClick={onRecheck}>
                {COPY.checkAgain}
              </Button>
            </span>
          </div>
          {words.installNote && <p className="agent-how-note">{words.installNote}</p>}
          <span className="agent-how-custom">
            <Button variant="link" size="xs" onClick={onCustom}>
              {COPY.customStart}…
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
  /** Reads the snapshot again; settles once one read after the call is in. */
  onChanged: () => void | Promise<void>
  /** A page to open on, each time a new one is given. */
  initialPage?: AgentPageTarget | undefined
}) {
  const [data, setData] = useState<AgentsResponse | null>(null)
  const [error, setError] = useState('')
  const [accountPreset, setAccountPreset] = useState<AgentPreset>()
  const [foldedAccounts, setFoldedAccounts] = useState<ReadonlySet<string>>(() => new Set())
  const [editing, setEditing] = useState<Editing>(initialPage ? editingOf(initialPage) : null)
  useEffect(() => {
    if (initialPage) setEditing(editingOf(initialPage))
  }, [initialPage])
  const [busy, setBusy] = useState(false)
  // Keep a failed confirmation beside its Harness when the request settles and the button becomes available again.
  const [confirmationTarget, setConfirmationTarget] = useState<string | null>(null)
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
    void onChanged()
    setChecking(false)
  }
  /** The definitions and the catalog, read again: whether a command still finds a moved program is in the catalog. */
  const refreshed = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const catalog = Promise.race([onChanged(), new Promise<void>(resolve => (timer = setTimeout(resolve, CATALOG_WAIT_MS)))])
    await Promise.all([catalog, load()])
    clearTimeout(timer)
  }
  const done = () => {
    setEditing(null)
    void refreshed()
  }
  const toggle = async (agent: AgentSettings) => {
    setConfirmationTarget(null)
    setBusy(true)
    setError('')
    try {
      await api(`agents/${encodeURIComponent(agent.id)}`, { method: 'PUT', body: { enabled: !agent.enabled } })
      void onChanged()
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  /** Saves a moved definition as it is: the Host asks for Touch ID with the program its command now finds. */
  const confirmMoved = async (agent: AgentSettings) => {
    setConfirmationTarget(agent.id)
    setBusy(true)
    setError('')
    try {
      await withConfirmation(confirmation =>
        api(`agents/${encodeURIComponent(agent.id)}`, {
          method: 'PUT',
          body: { command: agent.command },
          ...(confirmation ? { confirmation } : {}),
        }),
      )
      // The row stays pending until the catalog no longer counts the program as moved.
      await refreshed()
      setConfirmationTarget(null)
    } catch (cause) {
      setError(inlineError(cause))
    } finally {
      setBusy(false)
    }
  }
  if (data === null) return error ? <InlineNotice tone="error">{error}</InlineNotice> : <Loading />

  const builtin = builtinHarness(snapshot.catalog)
  const { local, admin } = deviceAccess(snapshot, currentShell())
  const on = onComputer(local, snapshot.hostName)
  const { found, installable, installed, missing } = settingsEngines(data.presets, data.agents)
  const custom = (preset: AgentPreset) => {
    setEditing({ kind: 'new', preset })
  }
  const canManageAccounts = local && admin && snapshot.catalog?.features?.harnessAccounts === true
  const accountPresets = canManageAccounts
    ? data.presets.filter(
        preset =>
          (harnessAccountDirectories(preset.id) || preset.id === 'cursor')
          && (preset.detected?.found || data.agents.some(agent => agent.presetId === preset.id && agent.detected.found)),
      )
    : []
  const engineRow = (agent: AgentSettings, accountBrand?: string) => (
    <Fragment key={agent.id}>
      <AgentRow
        agent={agent}
        preset={data.presets.find(item => item.id === agent.presetId)}
        harness={snapshot.catalog?.harnesses.find(item => item.id === agent.id)}
        busy={busy}
        accountBrand={accountBrand}
        confirming={busy && confirmationTarget === agent.id}
        onOpen={() => {
          setEditing({ kind: 'agent', id: agent.id })
        }}
        onToggle={() => {
          void toggle(agent)
        }}
        local={local}
        onConfirm={() => {
          void confirmMoved(agent)
        }}
      />
      {local && editing === null && confirmationTarget === agent.id && <InlineConfirm active={busy} rank={1} />}
    </Fragment>
  )
  const renderEngine = (entry: EngineListItem) => {
    if (!('accounts' in entry)) return engineRow(entry)
    const { preset } = entry
    return (
      <AccountGroupRow
        key={`preset:${preset.id}`}
        group={entry}
        expanded={!foldedAccounts.has(preset.id)}
        onSetExpanded={expanded => {
          setFoldedAccounts(previous => {
            const next = new Set(previous)
            if (expanded) next.delete(preset.id)
            else next.add(preset.id)
            return next
          })
        }}
        renderAccount={engineRow}
        onOpenDefault={() => custom(preset)}
      />
    )
  }
  const main = (
    <>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <SettingsGroup
        title={COPY.installed}
        meta={
          <Button
            variant="outline"
            icon={PlusGlyph}
            onClick={() => {
              setEditing({ kind: 'new' })
            }}>
            {COPY.customHarness}
          </Button>
        }
        note={<NoteLine icon={ShieldGlyph} brief={RUNS_AS_YOU_COPY.engines(on)} />}>
        {builtin && (
          <SettingsRow
            className="agent-row"
            leading={<HarnessTile harness={builtin} size={24} />}
            record
            title={harnessName(builtin)}
            description={COPY.builtIn}
            trailing={<span className="service-status">{builtin.status === 'ready' ? COPY.available : COPY.needsProvider}</span>}
          />
        )}
        {accountPresets.length > 0 && (
          <SettingsRow
            title={COPY.accounts}
            trailing={
              <Menu
                label={COPY.addAccount}
                align="end"
                sections={[
                  {
                    id: 'presets',
                    items: accountPresets.map(preset => ({
                      id: preset.id,
                      label: preset.name,
                      onSelect: () => setAccountPreset(preset),
                    })),
                  },
                ]}
                trigger={menu => (
                  <Button variant="outline" size="xs" icon={PlusGlyph} {...menu}>
                    {COPY.addAccount}
                  </Button>
                )}
              />
            }
          />
        )}
        {installed.map(renderEngine)}
        {found.map(preset => (
          <FoundRow key={preset.id} preset={preset} onOpen={() => custom(preset)} />
        ))}
      </SettingsGroup>
      {(missing.length > 0 || installable.length > 0) && (
        <SettingsGroup title={COPY.offers}>
          {missing.map(renderEngine)}
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
      title: editing.preset ? COPY.customStart : COPY.customHarness,
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
              ? COPY.notAdmin
              : !snapshot.device.scopes?.includes('run')
                ? COPY.cannotRun
                : !agent.detected.found
                  ? COPY.commandFirst
                  : undefined
          }
          onRecheck={() => {
            void recheck()
          }}
          onSaved={refreshed}
          onDeleted={done}
          onAddAccount={canManageAccounts ? setAccountPreset : undefined}
          on={on}
          local={local}
        />
      ),
    })

  return (
    <>
      <SettingsPages main={main} levels={levels} />
      {canManageAccounts && accountPreset && (
        <AccountDialog
          key={accountPreset.id}
          preset={accountPreset}
          directories={harnessAccountDirectories(accountPreset.id)}
          onClose={unknown => {
            setAccountPreset(undefined)
            if (unknown) void refreshed()
          }}
          onAdded={item => {
            setData({ ...data, agents: [...data.agents.filter(agent => agent.id !== item.id), item] })
            setAccountPreset(undefined)
            void refreshed()
            setEditing({ kind: 'agent', id: item.id })
          }}
        />
      )}
    </>
  )
}
