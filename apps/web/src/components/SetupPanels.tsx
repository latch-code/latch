import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, ExternalLink, LockKeyhole, RefreshCw } from 'lucide-react'
import {
  PROVIDER_PRESETS,
  type AgentPresetSettings,
  type AgentSettings,
  type CommandDetection,
  type ModelRef,
  type ProviderPreset,
  type AppSnapshot,
} from '@latch/protocol'
import { api, inlineError } from '../core/api.ts'
import { SETUP_COPY } from '../core/securityCopy.ts'
import { withConfirmation } from '../core/confirmations.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { hostOf } from '../format.ts'
import { providerAbilities } from '../core/providerAbilities.ts'
import { deferredComponent } from './DeferredContent.tsx'
import { destinationOf, type ProvidersResponse } from '../core/providerSetup.ts'
import { hostView } from '../core/permissions.ts'
import { InlineConfirm } from './InlineConfirm.tsx'
import { missingText } from '../core/agentDetection.ts'
import { Badge, Button, ButtonLink, Icon, IconButton, InlineNotice, Loading, CopyButton } from '@latch/ui'
import { HarnessTile, ProviderTile } from './BrandTile.tsx'

const ProviderAddForm = deferredComponent(
  async () => ({ default: (await import('../settings/ProvidersSettings.tsx')).ProviderAddForm }),
  '模型服务表单',
)

/*
 * Adding a harness or a model service where it is chosen: the picker's own layer turns into a small panel (the tile,
 * the name, what is needed, one primary action). Settings stays the full place to manage them; these panels only add.
 */

type Access = Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>

/** The panel: a head with the way back, the thing's tile and name; then what is needed; then its one action. */
function SetupPanel({
  title,
  tile,
  onBack,
  backLabel = '返回',
  children,
  footer,
}: {
  title: string
  tile?: ReactNode
  onBack?: () => void
  backLabel?: string
  children: ReactNode
  footer?: ReactNode
}) {
  const head = useRef<HTMLElement>(null)
  // The panel replaces what had focus: the first control in it takes it.
  useEffect(() => {
    head.current?.parentElement?.querySelector<HTMLElement>('input, button:not([aria-disabled="true"])')?.focus({ preventScroll: true })
  }, [title])
  return (
    <section className="setup-panel" aria-label={title}>
      <header ref={head} className="setup-panel-head">
        {onBack && <IconButton size="xs" label={backLabel} icon={ChevronLeft} onClick={onBack} />}
        {tile}
        <h3>{title}</h3>
      </header>
      <div className="setup-panel-body">{children}</div>
      {footer && <footer className="setup-panel-foot">{footer}</footer>}
    </section>
  )
}

/** A line that says why this device cannot do it here, and where it can. */
function Elsewhere({ children }: { children: ReactNode }) {
  return (
    <p className="setup-panel-note">
      <Icon icon={LockKeyhole} size={12} />
      <span>{children}</span>
    </p>
  )
}

// ---- Agents ---------------------------------------------------------------------------------------------------

/** What the Host found of a preset's commands, in one line: found with its path, or what is still missing. */
function Detected({ preset, detected }: { preset: AgentPresetSettings; detected?: CommandDetection }) {
  if (!detected) return null
  const missing = missingText({ command: preset.command, detected })
  if (missing)
    return (
      <span className="detect is-warn">
        <Icon icon={CircleAlert} size={12} />
        <span>{missing}</span>
      </span>
    )
  return (
    <span className="detect is-ok">
      <Icon icon={CircleCheck} size={12} />
      <span className="detect-label">已找到</span>
      <span className="detect-path">{detected.path ?? preset.command}</span>
    </span>
  )
}

/**
 * The presets not added yet, each opening its panel: the tile, the name with its licence, one line of what it is and
 * whether this computer has it.
 */
export function AgentPresetList({
  presets,
  onPick,
  footer,
}: {
  presets: AgentPresetSettings[]
  onPick: (preset: AgentPresetSettings) => void
  footer?: ReactNode
}) {
  return (
    <div className="setup-list" role="group" aria-label="添加 Harness">
      <p className="setup-list-head">
        <span className="setup-list-title">添加 Harness</span>
        <span className="setup-list-meta">开源，在这台电脑上运行</span>
      </p>
      {presets.map(preset => (
        <button
          key={preset.id}
          type="button"
          className="setup-list-item"
          onClick={() => {
            onPick(preset)
          }}>
          <HarnessTile harness={{ id: preset.id, source: 'acp', presetId: preset.id }} size={24} />
          <span className="setup-list-text">
            <span className="setup-list-name">
              {preset.name}
              <Badge>{preset.license}</Badge>
            </span>
            <span className="setup-list-description">{preset.description}</span>
          </span>
          <span className="setup-list-end">
            {preset.detected?.found && (preset.detected.companion?.found ?? true) ? '已找到' : '添加'}
            <Icon icon={ChevronRight} size={12} />
          </span>
        </button>
      ))}
      {footer}
    </div>
  )
}

/**
 * One preset, to add: what it is, what this computer has of it (the missing program with its install command and a
 * way to look again), and 「添加」. Saving a definition is confirmed on this computer. A device that may not add agents
 * reads where it can be done instead.
 */
export function AgentSetupPanel({
  preset,
  canAdd,
  onBack,
  onRecheck,
  onAdded,
}: {
  preset: AgentPresetSettings
  /** This device may define agents (the desktop app with 管理此 Host). */
  canAdd: boolean
  onBack: () => void
  onRecheck?: () => Promise<void>
  onAdded: (agent: AgentSettings) => void
}) {
  const [busy, setBusy] = useState<'add' | 'check' | null>(null)
  const [error, setError] = useState('')
  const missing = preset.detected ? missingText({ command: preset.command, detected: preset.detected }) : undefined
  const add = async () => {
    setBusy('add')
    setError('')
    try {
      const body = { name: preset.name, presetId: preset.id, command: preset.command, args: preset.args, env: {}, enabled: true }
      const result = await withConfirmation(confirmation =>
        api<{ agent: AgentSettings }>('agents', { method: 'POST', body, ...(confirmation ? { confirmation } : {}) }),
      )
      onAdded(result.agent)
    } catch (cause) {
      const text = inlineError(cause)
      if (text) setError(text)
      setBusy(null)
    }
  }
  const recheck = async () => {
    if (!onRecheck) return
    setBusy('check')
    try {
      await onRecheck()
    } finally {
      setBusy(null)
    }
  }
  return (
    <SetupPanel
      title={preset.name}
      tile={<HarnessTile harness={{ id: preset.id, source: 'acp', presetId: preset.id }} size={24} />}
      onBack={onBack}
      footer={
        canAdd ? (
          <>
            <span className="setup-panel-caption">{SETUP_COPY.saveAgent}</span>
            <Button variant="primary" loading={busy === 'add'} disabled={busy !== null} onClick={() => void add()}>
              添加
            </Button>
          </>
        ) : (
          <Elsewhere>{SETUP_COPY.addAgentElsewhere}</Elsewhere>
        )
      }>
      <p className="setup-panel-text">{preset.description}</p>
      <Detected preset={preset} detected={preset.detected} />
      {(missing !== undefined || !preset.detected) && preset.install && (
        <div className="agent-install">
          <span className="agent-install-command">
            <code>{preset.install}</code>
            <CopyButton text={preset.install} label="复制安装命令" size="xs" />
          </span>
          {onRecheck && (
            <Button
              size="xs"
              variant="ghost"
              icon={RefreshCw}
              loading={busy === 'check'}
              disabled={busy !== null}
              onClick={() => void recheck()}>
              重新检测
            </Button>
          )}
        </div>
      )}
      <ButtonLink variant="link" size="xs" href={preset.homepage} target="_blank" rel="noopener noreferrer" className="setup-panel-link">
        {`${hostOf(preset.homepage)} · ${preset.license}`}
        <Icon icon={ExternalLink} size={12} />
      </ButtonLink>
      <p className="setup-panel-caption">{SETUP_COPY.agentFullAccess}</p>
      <InlineConfirm active={busy === 'add'} rank={2} />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </SetupPanel>
  )
}

// ---- Model services -------------------------------------------------------------------------------------------

/** The same service form as settings, opened where a model is chosen. */
export function ProviderSetupPanel({
  access,
  onSaved,
  onCancel,
  onSettings,
}: {
  access: Access
  onSaved: (model: ModelRef) => void
  onCancel?: () => void
  onSettings?: () => void
}) {
  const [preset, setPreset] = useState<ProviderPreset | null>(null)
  const [data, setData] = useState<ProvidersResponse | null>(null)
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!access.admin) return undefined
    let active = true
    void Promise.all([api<ProvidersResponse>('providers'), api<AppSnapshot>('snapshot')])
      .then(([providers, current]) => {
        if (active) {
          setData(providers)
          setSnapshot(current)
        }
      })
      .catch(cause => {
        if (active) setError(inlineError(cause))
      })
    return () => {
      active = false
    }
  }, [access.admin])
  if (!access.admin)
    return (
      <SetupPanel title="添加模型服务" onBack={onCancel}>
        <Elsewhere>{SETUP_COPY.addProviderElsewhere}</Elsewhere>
      </SetupPanel>
    )
  const presets = data?.presets ?? PROVIDER_PRESETS
  if (!preset)
    return (
      <SetupPanel
        title="添加模型服务"
        onBack={onCancel}
        footer={
          <>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setPreset(presets.find(item => item.id === 'custom') ?? PROVIDER_PRESETS.find(item => item.id === 'custom')!)
              }}>
              其他服务…
            </Button>
            {onSettings && (
              <Button variant="ghost" size="xs" onClick={onSettings}>
                管理模型服务…
              </Button>
            )}
          </>
        }>
        <div className="setup-grid" role="group" aria-label="选择服务">
          {presets
            .filter(item => item.baseURL !== '')
            .map(item => (
              <button key={item.id} type="button" className="setup-grid-item" onClick={() => setPreset(item)}>
                <ProviderTile provider={{ id: item.id, kind: item.kind, presetId: item.id }} size={24} />
                <span>{item.name}</span>
              </button>
            ))}
        </div>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
      </SetupPanel>
    )
  const elsewhere =
    !access.legacy
    && !access.local
    && (preset.requiresKey
      ? SETUP_COPY.keyElsewhere
      : data && destinationOf(preset.baseURL, data) === 'unconfirmed'
        ? SETUP_COPY.confirmAddressElsewhere
        : undefined)
  if (elsewhere)
    return (
      <SetupPanel
        title={preset.name}
        tile={<ProviderTile provider={{ id: preset.id, kind: preset.kind, presetId: preset.id }} size={24} />}
        onBack={() => setPreset(null)}
        footer={
          onSettings && (
            <Button variant="ghost" size="xs" onClick={onSettings}>
              管理模型服务…
            </Button>
          )
        }>
        <Elsewhere>{elsewhere}</Elsewhere>
      </SetupPanel>
    )
  return (
    <SetupPanel
      title={preset.name}
      tile={<ProviderTile provider={{ id: preset.id, kind: preset.kind, presetId: preset.id }} size={24} />}
      onBack={() => setPreset(null)}>
      {data && snapshot ? (
        <ProviderAddForm
          key={preset.id}
          compact
          saveLabel="保存并使用"
          preset={preset}
          data={data}
          abilities={providerAbilities(access, hostView(snapshot)?.presence)}
          onConfirmed={address =>
            setData(
              current => current && { ...current, confirmedAddresses: [...new Set([...(current.confirmedAddresses ?? []), address])] },
            )
          }
          onSaved={provider => onSaved({ providerId: provider.id, model: provider.defaultModel })}
          onCancel={() => setPreset(null)}
        />
      ) : error ? (
        <InlineNotice tone="error">{error}</InlineNotice>
      ) : (
        <Loading label="正在读取模型服务…" />
      )}
    </SetupPanel>
  )
}
