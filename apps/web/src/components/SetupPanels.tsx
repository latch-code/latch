import { useEffect, useRef, useState, type ReactNode } from 'react'

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
import { computerName, SETUP_COPY } from '../core/securityCopy.ts'
import { withConfirmation } from '../core/confirmations.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { hostOf } from '../format.ts'
import { providerAbilities } from '../core/providerAbilities.ts'
import { deferredComponent } from './DeferredContent.tsx'
import { destinationOf, SERVICE_FORM, servicesToPick, type ProvidersResponse } from '../core/providerSetup.ts'
import { providerAddition } from '../core/providerAddition.ts'
import { hostView } from '../core/permissions.ts'
import { InlineConfirm } from './InlineConfirm.tsx'
import { missingText } from '../core/agentDetection.ts'
import {
  Badge,
  Button,
  ButtonLink,
  Hint,
  Icon,
  IconButton,
  InlineNotice,
  Loading,
  CopyButton,
  ChevronLeftGlyph,
  ChevronRightGlyph,
  AlertGlyph,
  CircleCheckGlyph,
  ExternalGlyph,
  LockGlyph,
  RefreshGlyph,
  ShieldAlertGlyph,
} from '@latch/ui'
import { MarkTile, ProviderTile } from './BrandTile.tsx'
import { TerminalFillButton } from './TerminalFillButton.tsx'
import { defineCopy } from '../core/i18n.ts'
import { harnessPresetCopy } from '../core/harnessPresetCopy.ts'

const COPY = defineCopy(
  {
    providerForm: '模型服务表单',
    back: '返回',
    found: '已找到',
    addHarness: '添加 Harness',
    local: '在这台 Mac 上运行',
    upgrade: '需要升级',
    add: '添加',
    copyUpgrade: '复制升级命令',
    copyInstall: '复制安装命令',
    check: '重新检测',
    manageServices: '管理模型服务…',
    chooseService: '选择服务',
    loading: '正在读取模型服务…',
  },
  {
    providerForm: 'model service form',
    back: 'Back',
    found: 'Found',
    addHarness: 'Add Harness',
    local: 'Runs on this Mac',
    upgrade: 'Upgrade needed',
    add: 'Add',
    copyUpgrade: 'Copy upgrade command',
    copyInstall: 'Copy install command',
    check: 'Check again',
    manageServices: 'Manage model services…',
    chooseService: 'Choose a service',
    loading: 'Reading model services…',
  },
)

const ProviderAddForm = deferredComponent(
  async () => ({ default: (await import('../settings/ProvidersSettings.tsx')).ProviderAddForm }),
  () => COPY.providerForm,
)

/*
 * Adding a harness or a model service where it is chosen: the picker's own layer turns into a small panel (the tile,
 * the name, what is needed, one primary action). Settings stays the full place to manage them; these panels only add.
 */

type Access = Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>

/** The panel: a head with the way back, the thing's tile and name; then what is needed; then its one action. */
function SetupPanel({
  title,
  panelId,
  tile,
  onBack,
  backLabel = COPY.back,
  children,
  footer,
}: {
  title: string
  panelId: string
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
  }, [panelId])
  return (
    <section className="setup-panel" aria-label={title}>
      <header ref={head} className="setup-panel-head">
        {onBack && <IconButton size="xs" label={backLabel} icon={ChevronLeftGlyph} onClick={onBack} />}
        {tile}
        <h3>{title}</h3>
      </header>
      <div className="setup-panel-body">{children}</div>
      {footer && <footer className="setup-panel-foot">{footer}</footer>}
    </section>
  )
}

/**
 * The Host computer's name for a line that sends this device there, read from the snapshot only while such a line shows;
 * 「Mac」 until it arrives or when it cannot be read.
 */
function useComputerName(needed: boolean): string {
  const [hostName, setHostName] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!needed) return undefined
    let active = true
    api<AppSnapshot>('snapshot').then(
      current => {
        if (active) setHostName(current.hostName)
      },
      () => {
        // The line still reads 「Mac」.
      },
    )
    return () => {
      active = false
    }
  }, [needed])
  return computerName(hostName)
}

/** A line that says why this device cannot do it here, and where it can. */
function Elsewhere({ children }: { children: ReactNode }) {
  return (
    <p className="setup-panel-note">
      <Icon icon={LockGlyph} size={12} />
      <span>{children}</span>
    </p>
  )
}

// ---- Agents ---------------------------------------------------------------------------------------------------

/** What the Host found of a preset's commands, in one line: found with its path, or what is still missing. */
function Detected({ preset, detected }: { preset: AgentPresetSettings; detected?: CommandDetection }) {
  if (!detected) return null
  const missing = missingText({ command: preset.command, detected }) ?? detected.outdated?.need
  if (missing)
    return (
      <span className="detect is-warn">
        <Icon icon={AlertGlyph} size={12} />
        <span>{missing}</span>
      </span>
    )
  return (
    <span className="detect is-ok">
      <Icon icon={CircleCheckGlyph} size={12} />
      <span className="detect-label">{COPY.found}</span>
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
    <div className="setup-list" role="group" aria-label={COPY.addHarness}>
      <p className="setup-list-head">
        <span className="setup-list-title">{COPY.addHarness}</span>
        <span className="setup-list-meta">{COPY.local}</span>
      </p>
      {presets.map(preset => {
        const words = harnessPresetCopy(preset)
        return (
          <button
            key={preset.id}
            type="button"
            className="setup-list-item"
            onClick={() => {
              onPick(preset)
            }}>
            <MarkTile mark={preset.id} size={24} />
            <span className="setup-list-text">
              <span className="setup-list-name">
                {preset.name}
                <Badge>{words.license}</Badge>
              </span>
              <span className="setup-list-description">{words.description}</span>
            </span>
            <span className="setup-list-end">
              {preset.detected?.outdated ? COPY.upgrade : preset.detected?.found ? COPY.found : COPY.add}
              <Icon icon={ChevronRightGlyph} size={12} />
            </span>
          </button>
        )
      })}
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
  const computer = useComputerName(!canAdd)
  const missing = preset.detected ? missingText({ command: preset.command, detected: preset.detected }) : undefined
  // Here but too old: its upgrade command takes the install command's place.
  const upgrade = preset.detected?.outdated?.upgrade
  const command = upgrade ?? preset.install
  const words = harnessPresetCopy(preset)
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
      panelId={preset.id}
      tile={<MarkTile mark={preset.id} size={24} />}
      onBack={onBack}
      footer={
        canAdd ? (
          <Button variant="primary" loading={busy === 'add'} disabled={busy !== null} onClick={() => void add()}>
            {COPY.add}
          </Button>
        ) : (
          <Elsewhere>{SETUP_COPY.addAgentElsewhere(computer)}</Elsewhere>
        )
      }>
      <p className="setup-panel-text">{words.description}</p>
      <Detected preset={preset} detected={preset.detected} />
      {(missing !== undefined || !preset.detected || upgrade) && command && (
        <div className="agent-install">
          <span className="agent-install-command">
            <code>{command}</code>
            <CopyButton text={command} label={upgrade ? COPY.copyUpgrade : COPY.copyInstall} size="xs" />
            <TerminalFillButton command={command} detached />
          </span>
          {onRecheck && (
            <Button
              size="xs"
              variant="ghost"
              icon={RefreshGlyph}
              loading={busy === 'check'}
              disabled={busy !== null}
              onClick={() => void recheck()}>
              {COPY.check}
            </Button>
          )}
        </div>
      )}
      <ButtonLink variant="link" size="xs" href={preset.homepage} target="_blank" rel="noopener noreferrer" className="setup-panel-link">
        {`${hostOf(preset.homepage)} · ${words.license}`}
        <Icon icon={ExternalGlyph} size={12} />
      </ButtonLink>
      <Hint className="setup-panel-caption" lead={<Icon icon={ShieldAlertGlyph} size={12} />} label={SETUP_COPY.agentFullAccess.label}>
        {SETUP_COPY.agentFullAccess.detail}
      </Hint>
      <InlineConfirm active={busy === 'add'} rank={2} />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </SetupPanel>
  )
}

// ---- Model services -------------------------------------------------------------------------------------------

/**
 * The same service form as settings, opened where a model is chosen (the new-session card, the composer's model menu,
 * the phone's model sheet): the same title, the same grid ending in 「自定义地址…」, the same fields and save words.
 * Saving here also chooses the service's default model, so the button needs no word of its own.
 *
 * On a device with 管理 that is not this Mac, a service that needs a key, or a keyless one at an address not confirmed
 * yet, does not open the form: a session started from here could not use it, so the panel says where to go. The
 * settings dialog lets the same device save it and finish on the Mac (`ProviderAddForm`).
 */
export function ProviderSetupPanel({
  access,
  onSaved,
  onCancel,
  onSettings,
  onBusy,
  additionOwner,
}: {
  access: Access
  onSaved: (model: ModelRef) => void
  onCancel?: () => void
  onSettings?: () => void
  onBusy?: (busy: boolean) => void
  additionOwner?: string
}) {
  const [preset, setPreset] = useState<ProviderPreset | null>(
    () => PROVIDER_PRESETS.find(item => item.id === providerAddition(additionOwner)?.presetId) ?? null,
  )
  const [data, setData] = useState<ProvidersResponse | null>(null)
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [error, setError] = useState('')
  const remoteName = useComputerName(!access.admin)
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
      <SetupPanel title={SERVICE_FORM.title} panelId="provider" onBack={onCancel}>
        <Elsewhere>{SETUP_COPY.addProviderElsewhere(remoteName)}</Elsewhere>
      </SetupPanel>
    )
  const presets = data?.presets ?? PROVIDER_PRESETS
  if (!preset)
    return (
      <SetupPanel
        title={SERVICE_FORM.title}
        panelId="provider"
        onBack={onCancel}
        footer={
          onSettings && (
            <Button variant="ghost" size="xs" onClick={onSettings}>
              {COPY.manageServices}
            </Button>
          )
        }>
        <div className="setup-grid" role="group" aria-label={COPY.chooseService}>
          {servicesToPick(presets).map(item => (
            <button key={item.id} type="button" className="setup-grid-item" onClick={() => setPreset(item)}>
              <ProviderTile provider={{ id: item.id, kind: item.kind, presetId: item.id }} size={24} />
              <span>{item.id === 'custom' || !item.baseURL ? SERVICE_FORM.custom : item.name}</span>
            </button>
          ))}
        </div>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
      </SetupPanel>
    )
  const title = preset.id === 'custom' || !preset.baseURL ? SERVICE_FORM.customTitle : preset.name
  const computer = computerName(snapshot?.hostName)
  const elsewhere =
    !access.legacy
    && !access.local
    && (preset.requiresKey
      ? SETUP_COPY.keyElsewhere(computer)
      : data && destinationOf(preset.baseURL, data) === 'unconfirmed'
        ? SETUP_COPY.confirmAddressElsewhere(computer)
        : undefined)
  if (elsewhere)
    return (
      <SetupPanel
        title={title}
        panelId={preset.id}
        tile={<ProviderTile provider={{ id: preset.id, kind: preset.kind, presetId: preset.id }} size={24} />}
        onBack={() => setPreset(null)}
        footer={
          onSettings && (
            <Button variant="ghost" size="xs" onClick={onSettings}>
              {COPY.manageServices}
            </Button>
          )
        }>
        <Elsewhere>{elsewhere}</Elsewhere>
      </SetupPanel>
    )
  return (
    <SetupPanel
      title={title}
      panelId={preset.id}
      tile={<ProviderTile provider={{ id: preset.id, kind: preset.kind, presetId: preset.id }} size={24} />}
      onBack={() => setPreset(null)}>
      {data && snapshot ? (
        <ProviderAddForm
          key={preset.id}
          compact
          computer={computer}
          preset={preset}
          data={data}
          abilities={providerAbilities(access, hostView(snapshot)?.presence)}
          onConfirmed={address =>
            setData(
              current => current && { ...current, confirmedAddresses: [...new Set([...(current.confirmedAddresses ?? []), address])] },
            )
          }
          onSaved={provider => onSaved({ providerId: provider.id, model: provider.defaultModel })}
          {...(onBusy && { onBusy })}
          {...(additionOwner && { additionOwner })}
          onCancel={() => setPreset(null)}
        />
      ) : error ? (
        <InlineNotice tone="error">{error}</InlineNotice>
      ) : (
        <Loading label={COPY.loading} />
      )}
    </SetupPanel>
  )
}
