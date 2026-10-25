import { UsageSettings } from './UsageSettings.tsx'
import { ModelVisibilitySettings } from './ModelVisibilitySettings.tsx'
import { PromptTemplatesSettings } from './PromptTemplatesSettings.tsx'
import { NotificationSettings } from './NotificationSettings.tsx'
import { useState } from 'react'
import type { AppSnapshot, HostCatalog, ModelRef, SessionDefaults, TaskMode } from '@latch/protocol'
import { api, errorMessage } from '../core/api.ts'
import { defaultModel, findHarness, harnessName, startableWorkspaces } from '../composerChoice.ts'
import { basename } from '../format.ts'
import { setPreference, usePreferences, type SendKey, type ThemePreference } from '../preferences.ts'
import { HarnessTile, ProviderTile } from '../components/BrandTile.tsx'
import { hostLine, hostNeedsStart, keepAwakeLine, loginItemNote, useShellLifecycle } from '../core/shellLifecycle.ts'
import type { ShellLifecycle } from '../core/shell.ts'
import { Button, ChoiceList, InlineNotice, SegmentedControl, StatusPill, SwitchRow, ValuePicker, type PickerGroup } from '@latch/ui'
import { SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'

const encodeModel = (ref: ModelRef | undefined) => (ref ? JSON.stringify([ref.providerId, ref.model]) : undefined)
function decodeModel(value: string): ModelRef | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return undefined
    const [providerId, model] = parsed as unknown[]
    return typeof providerId === 'string' && typeof model === 'string' ? { providerId, model } : undefined
  } catch {
    return undefined
  }
}
const MODE_LABELS: Record<TaskMode, string> = { chat: '对话', agent: 'Agent' }
/** What the chosen way does, as the row's one sentence. */
const MODE_EFFECTS: Record<TaskMode, string> = { chat: '不读写文件、不运行命令', agent: '会读写项目文件、运行命令（按权限询问）' }

/** What the Host stores: a mode the harness offers, a startable project, and a model only for a harness that uses the Host's. */
function normalized(catalog: HostCatalog, draft: SessionDefaults): SessionDefaults {
  const harness = findHarness(catalog, draft.harnessId)
  const modes: TaskMode[] = harness?.modes.length ? harness.modes : ['chat', 'agent']
  const workspaces = startableWorkspaces(catalog)
  const workspaceId = workspaces.some(item => item.id === draft.workspaceId) ? draft.workspaceId : (workspaces[0]?.id ?? draft.workspaceId)
  return {
    harnessId: draft.harnessId,
    mode: modes.includes(draft.mode) ? draft.mode : modes[0],
    workspaceId,
    ...(harness?.models === 'host' && draft.model ? { model: draft.model } : {}),
  }
}

/**
 * Host-wide defaults that a new session starts from on every device, one picker per row. A choice applies at once,
 * as every settings value does; the row goes back to the Host's value if the Host refuses it.
 */
function SessionDefaultsGroup({ catalog, onChanged }: { catalog: HostCatalog; onChanged: () => void }) {
  const stored = (): SessionDefaults => ({ ...catalog.defaults, ...(catalog.defaults.model ? {} : { model: defaultModel(catalog) }) })
  const [draft, setDraft] = useState<SessionDefaults>(stored)
  const [error, setError] = useState('')
  // A change of the Host's defaults (this device's, once refreshed, or another device's) replaces the draft.
  const basis = JSON.stringify(catalog.defaults)
  const [seen, setSeen] = useState(basis)
  if (seen !== basis) {
    setSeen(basis)
    setDraft(stored())
  }
  const harness = findHarness(catalog, draft.harnessId)
  const shown = normalized(catalog, draft)
  const modes: TaskMode[] = harness?.modes.length ? harness.modes : ['chat', 'agent']
  // The Host already answers a disabled saved default with the default workspace, so disabled ones are never offered.
  const workspaces = startableWorkspaces(catalog)

  const commit = async (patch: Partial<SessionDefaults>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    setError('')
    try {
      await api('preferences', { method: 'PUT', body: { defaults: normalized(catalog, next) } })
      onChanged()
    } catch (cause) {
      setError(errorMessage(cause))
      setDraft(stored())
    }
  }

  const modelGroups: Array<PickerGroup<string>> = catalog.providers.map(provider => ({
    id: provider.id,
    label: provider.name,
    options: (provider.models.length ? provider.models : [provider.defaultModel]).filter(Boolean).map(model => ({
      value: encodeModel({ providerId: provider.id, model })!,
      label: model,
    })),
  }))
  const modelCount = modelGroups.reduce((sum, group) => sum + group.options.length, 0)
  const provider = shown.model ? catalog.providers.find(item => item.id === shown.model?.providerId) : undefined

  return (
    <>
      <SettingsGroup title="新会话默认值" caption="对所有设备生效。每台设备会记住自己上次的选择；首次使用或选择失效时采用这里的默认值。">
        <SettingsRow
          title="Agent"
          description="新会话由谁来执行"
          trailing={
            <ValuePicker
              label="Agent"
              value={shown.harnessId}
              bleed="end"
              leading={harness ? <HarnessTile harness={harness} size={16} /> : undefined}
              options={catalog.harnesses.map(item => ({
                value: item.id,
                label: harnessName(item),
                disabledReason: item.status === 'ready' ? undefined : item.statusMessage || '暂不可用',
              }))}
              onValueChange={value => {
                void commit({ harnessId: value })
              }}
            />
          }
        />
        <SettingsRow
          title="方式"
          description={MODE_EFFECTS[shown.mode]}
          trailing={
            <ValuePicker
              label="方式"
              value={shown.mode}
              bleed="end"
              options={modes.map(mode => ({ value: mode, label: MODE_LABELS[mode] }))}
              onValueChange={value => {
                void commit({ mode: value })
              }}
            />
          }
        />
        {harness?.models === 'host' && (
          <SettingsRow
            title="模型"
            description="Latch 内置使用执行端的模型服务"
            trailing={
              <ValuePicker
                label="模型"
                value={encodeModel(shown.model)}
                placeholder="选择模型"
                bleed="end"
                searchable={modelCount > 8}
                leading={provider ? <ProviderTile provider={provider} size={16} /> : undefined}
                groups={modelGroups}
                onValueChange={value => {
                  const model = decodeModel(value)
                  if (model) void commit({ model })
                }}
              />
            }
          />
        )}
        <SettingsRow
          title="项目"
          description="新会话在哪个目录中工作"
          trailing={
            <ValuePicker
              label="项目"
              value={shown.workspaceId}
              bleed="end"
              options={workspaces.map(item => ({
                value: item.id,
                label: item.id === 'default' ? '启动目录' : item.name || basename(item.path),
              }))}
              onValueChange={value => {
                void commit({ workspaceId: value })
              }}
            />
          }
        />
      </SettingsGroup>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </>
  )
}

/** The Host's state in its row: plain while it runs, a pill otherwise (the text beside it says what happened). */
const HOST_STATUS_LABELS: Record<ShellLifecycle['host']['status'], string> = {
  running: '运行中',
  starting: '正在启动',
  restarting: '正在重启',
  stopped: '已停止',
  crashed: '已退出',
  'crash-loop': '已停止重启',
  unresponsive: '没有响应',
}

/** Desktop only: how this Mac keeps the Host reachable. Main owns all of it; the page shows and asks. */
function BackgroundSettings() {
  const lifecycle = useShellLifecycle()
  const [busy, setBusy] = useState<'login' | 'awake' | 'restart' | null>(null)
  const [error, setError] = useState('')
  if (!lifecycle.view) return null
  const { loginItem, keepAwake, host } = lifecycle.view
  const note = loginItemNote(loginItem)
  const status = hostLine(host)
  const restartable = (host.supervised && host.status !== 'unresponsive') || hostNeedsStart(host)
  const act = async (kind: 'login' | 'awake' | 'restart', action: () => Promise<string>) => {
    setBusy(kind)
    setError('')
    setError(await action())
    setBusy(null)
  }
  return (
    <>
      <SettingsGroup
        title="后台运行"
        caption="插着电源时，有会话运行或审批等待就阻止电脑自动休眠；合上盖子（没有接外接显示器）时 Mac 仍会休眠。关闭窗口后 Latch 仍在后台重启 Host 并保持唤醒，退出 Latch（⌘Q）后这两项停止，Host 继续运行。">
        <SwitchRow
          className="settings-row"
          title="让 Latch 在后台运行，手机随时能连上这台 Mac"
          description={note || '登录这台 Mac 后自动打开 Latch 并启动 Host，不弹出窗口。'}
          checked={loginItem.enabled}
          disabled={!loginItem.available || busy !== null}
          onCheckedChange={enabled => {
            void act('login', () => lifecycle.setLoginItem(enabled))
          }}
        />
        <SwitchRow
          className="settings-row"
          title="有任务时保持唤醒"
          description={keepAwakeLine(keepAwake)}
          checked={keepAwake.enabled}
          disabled={busy !== null}
          onCheckedChange={enabled => {
            void act('awake', () => lifecycle.setKeepAwake(enabled))
          }}
        />
        <SettingsRow
          title="Latch Host"
          description={status.text}
          trailing={
            restartable ? (
              <Button
                disabled={busy !== null || host.status === 'starting' || host.status === 'restarting'}
                loading={busy === 'restart'}
                onClick={() => {
                  void act('restart', lifecycle.restartHost)
                }}>
                {host.status === 'running' ? '重新启动 Host' : '启动 Host'}
              </Button>
            ) : status.tone === 'neutral' ? (
              <span className="settings-row-value">{HOST_STATUS_LABELS[host.status]}</span>
            ) : (
              <StatusPill tone={status.tone === 'error' ? 'err' : 'warn'}>{HOST_STATUS_LABELS[host.status]}</StatusPill>
            )
          }
        />
        <SettingsRow
          title="时间机器备份"
          description="模型密钥、Agent 定义（含环境变量）与项目列表、设备登记和 Host 身份不进入时间机器备份；会话、审计记录与安全策略会进入备份，建议加密备份盘。"
        />
      </SettingsGroup>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </>
  )
}

export function GeneralSettings({ snapshot, admin, onChanged }: { snapshot: AppSnapshot; admin: boolean; onChanged: () => void }) {
  const preferences = usePreferences()
  return (
    <>
      <SectionHeading title="通用" description="外观与发送方式只影响这台设备。" />
      <NotificationSettings />
      {snapshot.catalog?.features?.usage && <UsageSettings catalog={snapshot.catalog} />}
      {snapshot.catalog && <ModelVisibilitySettings catalog={snapshot.catalog} />}
      {admin && snapshot.catalog?.features?.promptTemplates && <PromptTemplatesSettings snapshot={snapshot} onChanged={onChanged} />}
      <SettingsGroup title="外观">
        <SettingsRow
          title="主题"
          description="跟随系统时随系统的浅色与深色切换"
          trailing={
            <SegmentedControl<ThemePreference>
              label="外观"
              value={preferences.theme}
              onValueChange={value => {
                setPreference('theme', value)
              }}
              options={[
                { value: 'system', label: '跟随系统' },
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ]}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="发送消息" bare caption="触屏设备上 Enter 始终换行，点按发送按钮发送；⌘/Ctrl + Enter 在任何设备上都会发送。">
        <ChoiceList<SendKey>
          label="发送消息"
          value={preferences.sendKey}
          onValueChange={value => {
            setPreference('sendKey', value)
          }}
          options={[
            { value: 'enter', title: 'Enter 发送', description: 'Shift + Enter 换行' },
            { value: 'mod-enter', title: '⌘/Ctrl + Enter 发送', description: 'Enter 换行，适合输入长段落' },
          ]}
        />
      </SettingsGroup>
      <BackgroundSettings />
      {admin && snapshot.catalog && <SessionDefaultsGroup catalog={snapshot.catalog} onChanged={onChanged} />}
    </>
  )
}
