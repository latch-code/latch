import { useState } from 'react'
import { Box, ChevronLeft, Cpu, Pin, PinOff, Plus, Sparkles } from 'lucide-react'
import type { AgentPresetSettings, AgentSettings, HarnessInfo, HostCatalog, ModelRef, SessionConfigOption } from '@latch/protocol'
import {
  Button,
  IconButton,
  InlineNotice,
  MenuFooterLink,
  MenuFooterNote,
  Popover,
  SegmentedControl,
  ValuePicker,
  useLayerClose,
  type PickerGroup,
} from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { SETUP_COPY } from '../core/securityCopy.ts'
import {
  engineEntries,
  findProvider,
  harnessName,
  isPinnedChoice,
  presetsToAdd,
  sameModel,
  type ComposerChoice,
} from '../composerChoice.ts'
import { fuzzyModelMatch, modelKey, rememberModel, useModelPreferences } from '../modelPreferences.ts'
import { HarnessTile, ProviderTile } from '../components/BrandTile.tsx'
import { ModelAddPanel, modelGroups } from '../components/Pickers.tsx'
import { AgentPresetList, AgentSetupPanel } from '../components/SetupPanels.tsx'
import { escapeHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import {
  agentConfigBlocked,
  agentConfigChoice,
  agentConfigLabel,
  agentConfigValues,
  BUILTIN_THINKING_NOTE,
  DEFAULT_MODEL,
  modelChipText,
  unreportedNote,
  type AgentConfigState,
} from './modelReasoning.ts'

type Access = Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>
/** The most levels a segmented row holds in the popover's width; more go in a row that opens its own list. */
const SEGMENTED_LEVELS = 5
const OWN_MODEL = 'own'

const pendingModelText = (model: string) => `下一条：${model}`
const resetModelLabel = (current: ModelRef | undefined) => (current ? `撤销切换，继续使用 ${current.model}` : '撤销切换')

/** 思考: a segmented row of the levels the engine reported; the menu stays open. */
function LevelRow({ option, disabled, onChoose }: { option: SessionConfigOption; disabled: boolean; onChoose: (value: string) => void }) {
  const values = agentConfigValues(option)
  return (
    <div className="model-setting">
      <span className="model-setting-name">思考</span>
      {values.length <= SEGMENTED_LEVELS ? (
        <SegmentedControl
          label="思考"
          value={option.currentValue}
          disabled={disabled}
          options={values.map(item => ({ value: item.value, label: escapeHiddenCharacters(item.name) }))}
          onValueChange={onChoose}
        />
      ) : (
        <ValuePicker
          variant="row"
          label="思考"
          value={option.currentValue}
          disabled={disabled}
          options={values.map(item => ({ value: item.value, label: escapeHiddenCharacters(item.name) }))}
          onValueChange={onChoose}
        />
      )}
    </div>
  )
}

/** 思考 with nothing to choose from: the value in place, and the one sentence on why. */
function FixedThinking({ note }: { note: string | undefined }) {
  return (
    <>
      <div className="model-setting">
        <span className="model-setting-name">思考</span>
        <span className="model-setting-value">默认</span>
      </div>
      {note && <p className="model-note">{note}</p>}
    </>
  )
}

/** Models hidden in settings stay one press away, here where they are chosen. */
function HiddenModelsLink({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const { hidden } = useModelPreferences()
  if (hidden.length === 0) return null
  return (
    <MenuFooterLink chevron={false} onClick={onToggle}>
      {shown ? '收起隐藏的模型' : `显示隐藏的模型（${hidden.length}）`}
    </MenuFooterLink>
  )
}

/** 设为新会话默认: on the Host computer only, because a pinned engine is preselected there. The menu stays open to show it took. */
function PinChoiceRow({
  catalog,
  harness,
  model,
  onChanged,
}: {
  catalog: HostCatalog
  harness: HarnessInfo
  model: ModelRef | undefined
  onChanged?: (() => void | Promise<void>) | undefined
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pinned = isPinnedChoice(catalog, harness, model)
  const toggle = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const defaults = pinned
        ? { pinned: false }
        : { harnessId: harness.id, ...(harness.capabilities.models.owner === 'latch' && model ? { model } : {}), pinned: true }
      await api('preferences', { method: 'PUT', body: { defaults } })
      await onChanged?.()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {pinned && <p className="model-note">这台 Mac 上每个新会话都从这里开始，临时换一个只影响那一次。</p>}
      {error && (
        <p className="model-note" data-tone="error">
          {error}
        </p>
      )}
      <MenuFooterLink
        icon={pinned ? PinOff : Pin}
        chevron={false}
        onClick={() => {
          void toggle()
        }}>
        {busy ? '正在保存…' : pinned ? '取消新会话默认' : '设为新会话默认'}
      </MenuFooterLink>
    </>
  )
}

/** Adding an engine where it is chosen: the presets not added yet, then the one picked with its panel. */
function EngineAddPanel({
  onBack,
  canAdd,
  admin,
  catalog,
  onAdded,
}: {
  onBack: () => void
  canAdd: boolean
  admin: boolean
  catalog: HostCatalog
  onAdded: (agent: AgentSettings) => void
}) {
  const close = useLayerClose()
  const toAdd = presetsToAdd(catalog)
  const [reported, setReported] = useState<AgentPresetSettings[] | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)
  const load = async () => {
    try {
      setReported((await api<{ presets: AgentPresetSettings[] }>('agents')).presets)
    } catch {
      // The list still shows the presets; only what was found on this computer is missing.
    }
  }
  if (admin && !asked) {
    setAsked(true)
    void load()
  }
  const presets = toAdd.map(preset => reported?.find(item => item.id === preset.id) ?? preset)
  const preset = presets.find(item => item.id === picked)
  if (preset)
    return (
      <AgentSetupPanel
        key={preset.id}
        preset={preset}
        canAdd={canAdd}
        onBack={() => {
          setPicked(null)
        }}
        {...(admin ? { onRecheck: load } : {})}
        onAdded={agent => {
          close()
          onAdded(agent)
        }}
      />
    )
  return (
    <div className="permission-list">
      <header className="permission-list-head">
        <IconButton size="xs" icon={ChevronLeft} label="返回" onClick={onBack} />
        <span>添加 Harness</span>
      </header>
      <AgentPresetList
        presets={presets}
        onPick={item => {
          setPicked(item.id)
        }}
      />
    </div>
  )
}

/** The Harness of a new session: each one this device can start, with what it can do. Choosing one never touches the others' settings. */
export function DraftHarnessControl({
  catalog,
  choice,
  onChoice,
  access,
  disabled,
  onManage,
  onAdded,
  onDefaultsChanged,
}: {
  catalog: HostCatalog
  choice: ComposerChoice
  onChoice: (patch: Partial<ComposerChoice>) => void
  access: Access
  disabled: boolean
  onManage?: (() => void) | undefined
  onAdded?: ((agent: AgentSettings) => void) | undefined
  onDefaultsChanged?: (() => void | Promise<void>) | undefined
}) {
  const [adding, setAdding] = useState(false)
  const entries = engineEntries(catalog, choice.workspaceId)
  const harness = entries.find(entry => entry.harness.id === choice.harnessId)?.harness
  const canAdd = !access.legacy && access.admin && presetsToAdd(catalog).length > 0
  const noService = harness?.capabilities.models.owner === 'latch' && !choice.model
  // A pin names a saved Harness; one still on offer is saved by its first session.
  const canPin =
    !access.legacy && access.local && access.admin && catalog.features?.pinnedDefaults === true && !noService && !harness?.offer
  return (
    <ValuePicker
      label="Harness"
      placeholder="选择 Harness"
      value={harness?.id}
      options={entries.map(entry => ({
        value: entry.harness.id,
        label: entry.label,
        description: entry.line,
        media: <HarnessTile harness={entry.harness} size={20} />,
        ...(entry.disabledReason ? { disabledReason: entry.disabledReason } : {}),
      }))}
      header={{ title: '开始后这个会话不能换 Harness。' }}
      width={adding ? 360 : 340}
      leading={harness ? <HarnessTile harness={harness} size={16} /> : Sparkles}
      className="harness-picker"
      menuChevron
      disabled={disabled}
      onOpenChange={open => {
        if (!open) setAdding(false)
      }}
      onValueChange={harnessId => onChoice({ harnessId })}
      footer={
        <div className="model-footer">
          {canPin && harness && <PinChoiceRow catalog={catalog} harness={harness} model={choice.model} onChanged={onDefaultsChanged} />}
          {canAdd && (
            <MenuFooterLink
              icon={Plus}
              chevron={false}
              onClick={() => {
                setAdding(true)
              }}>
              添加 Harness…
            </MenuFooterLink>
          )}
          {onManage && (
            <MenuFooterLink icon={Cpu} chevron={false} closes onClick={onManage}>
              管理 Harness…
            </MenuFooterLink>
          )}
        </div>
      }
      panel={
        adding ? (
          <EngineAddPanel
            catalog={catalog}
            canAdd={canAdd}
            admin={access.admin}
            onBack={() => {
              setAdding(false)
            }}
            onAdded={agent => {
              onAdded?.(agent)
            }}
          />
        ) : undefined
      }
    />
  )
}

/** The Harness of a running session: its mark and name, locked, and why. The chip still opens, since a tooltip never reaches touch. */
export function SessionHarnessControl({ harness, onNewSession }: { harness: HarnessInfo; onNewSession: () => void }) {
  const name = harnessName(harness)
  return (
    <Popover
      label="Harness"
      width={300}
      side="top"
      trigger={props => (
        <button {...props} type="button" className="chip chip-harness" aria-label={`Harness：${name}`}>
          <HarnessTile harness={harness} size={16} />
          <span className="chip-text">{name}</span>
        </button>
      )}>
      <div className="model-footer">
        <p className="model-note">会话开始后不能换 Harness。要换就新开一个会话，或从某一轮分叉。</p>
        <MenuFooterLink icon={Plus} chevron={false} closes onClick={onNewSession}>
          新会话
        </MenuFooterLink>
      </div>
    </Popover>
  )
}

const UNUSABLE_WORDS = {
  'key-missing': '没有密钥 · 在设置 › 模型里添加',
  'origin-unconfirmed': '地址还没确认 · 在这台 Mac 上确认',
} as const

/** Saved services the built-in Harness cannot use yet, each saying what is missing. */
function unusableGroups(catalog: HostCatalog): Array<PickerGroup<string>> {
  return (catalog.unusableProviders ?? []).map(provider => ({
    id: `~unusable-${provider.id}`,
    label: provider.name,
    options: [{ value: `~unusable-${provider.id}`, label: provider.name, disabledReason: UNUSABLE_WORDS[provider.reason] }],
  }))
}

/** A Harness with its own models lists them first; each saved service follows, disabled, until Latch can forward to it. */
function ownModelGroups(
  catalog: HostCatalog,
  name: string,
  own: Array<PickerGroup<string>['options'][number]>,
): Array<PickerGroup<string>> {
  const services = catalog.providers.filter(provider => provider.kind !== 'demo')
  return [
    { id: '~own', label: `${name} 自己的模型`, options: own },
    ...(services.length
      ? [
          {
            id: '~services',
            label: '模型服务',
            options: services.map(provider => ({
              value: `~service-${provider.id}`,
              label: provider.name,
              media: <ProviderTile provider={provider} size={16} />,
              disabledReason: `让 Latch 把 ${name} 的请求转给它，尚未实现`,
            })),
          },
        ]
      : []),
  ]
}

/** The model and thinking of a new session. A Harness with its own models tells Latch nothing before it starts, and this says so in place. */
export function DraftModelControl({
  catalog,
  choice,
  onChoice,
  access,
  disabled,
  onManageModels,
  onProvidersChanged,
}: {
  catalog: HostCatalog
  choice: ComposerChoice
  onChoice: (patch: Partial<ComposerChoice>) => void
  access: Access
  disabled: boolean
  onManageModels?: (() => void) | undefined
  onProvidersChanged?: (() => void) | undefined
}) {
  const [adding, setAdding] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const preferences = useModelPreferences()
  const entries = engineEntries(catalog, choice.workspaceId)
  const harness = entries.find(entry => entry.harness.id === choice.harnessId)?.harness
  const manage = onManageModels && (
    <MenuFooterLink icon={Box} chevron={false} closes onClick={onManageModels}>
      管理模型…
    </MenuFooterLink>
  )
  if (!harness)
    return (
      <ValuePicker
        label="模型"
        placeholder="模型"
        value={undefined}
        options={[]}
        className="model-picker"
        menuChevron
        disabled
        disabledReason="先选一个 Harness，才知道有哪些模型。"
        onValueChange={() => {}}
      />
    )
  if (harness.capabilities.models.owner !== 'latch') {
    const name = harnessName(harness)
    return (
      <ValuePicker
        label="模型"
        value={OWN_MODEL}
        valueText={modelChipText(undefined, undefined)}
        groups={ownModelGroups(catalog, name, [{ value: OWN_MODEL, label: DEFAULT_MODEL }])}
        width={340}
        className="model-picker"
        menuChevron
        disabled={disabled}
        onValueChange={() => {}}
        footer={
          <div className="model-footer">
            <FixedThinking note={unreportedNote(name, false, [])} />
            {manage}
          </div>
        }
      />
    )
  }
  const noService = !choice.model
  const groups = [
    ...modelGroups(catalog, preferences, choice.model, showHidden, access).map(group => ({
      ...group,
      options: group.options.map(option => ({ ...option, description: undefined })),
    })),
    ...unusableGroups(catalog),
  ]
  const count = groups.reduce((sum, group) => sum + group.options.length, 0)
  const provider = findProvider(catalog, choice.model?.providerId)
  return (
    <ValuePicker
      label="模型"
      placeholder="选择模型"
      value={choice.model ? modelKey(choice.model) : undefined}
      {...(choice.model ? { valueText: modelChipText(choice.model.model, undefined) } : {})}
      groups={groups}
      searchable={count >= 8 && !adding}
      searchMatch={(option, query) => fuzzyModelMatch(option.label, query)}
      width={adding ? 360 : 320}
      {...(provider ? { leading: <ProviderTile provider={provider} size={16} /> } : {})}
      className="model-picker"
      menuChevron
      disabled={disabled}
      onOpenChange={open => {
        if (!open) setAdding(false)
      }}
      onValueChange={key => {
        rememberModel(key)
        const [providerId = '', model = ''] = key.split('\u0000')
        onChoice({ model: { providerId, model } })
      }}
      footer={
        <div className="model-footer">
          {!noService && <FixedThinking note={BUILTIN_THINKING_NOTE} />}
          <HiddenModelsLink
            shown={showHidden}
            onToggle={() => {
              setShowHidden(!showHidden)
            }}
          />
          {access.admin ? (
            <MenuFooterLink
              icon={Plus}
              chevron={false}
              onClick={() => {
                setAdding(true)
              }}>
              添加模型服务…
            </MenuFooterLink>
          ) : (
            noService && <MenuFooterNote>{SETUP_COPY.addProviderElsewhere}</MenuFooterNote>
          )}
          {manage}
        </div>
      }
      panel={
        adding ? (
          <ModelAddPanel
            access={access}
            onCancel={() => {
              setAdding(false)
            }}
            onManage={onManageModels}
            onSaved={model => {
              rememberModel(modelKey(model))
              onChoice({ model })
              onProvidersChanged?.()
            }}
          />
        ) : undefined
      }
    />
  )
}

/**
 * The same control in a session. The built-in Harness lists your services and a switch goes with the next message; a
 * Harness with its own models lists what it reported, and a change is written to it at once.
 */
export function SessionModelControl({
  catalog,
  harness,
  model,
  current,
  reported,
  onModel,
  config,
  busy,
  feedback,
  onRefresh,
  onConfig,
  onManageModels,
  locked,
}: AgentConfigState & {
  /** This device may read the session but not change it: why, as the picker's tooltip. */
  locked?: string | undefined
  catalog: HostCatalog
  harness: HarnessInfo | undefined
  model: ModelRef | undefined
  current: ModelRef | undefined
  /** The model name the session last ran on, for when the agent lists no options. */
  reported?: string | undefined
  onModel: (model: ModelRef | undefined) => void
  config: readonly SessionConfigOption[]
  onRefresh?: (() => void | Promise<void>) | undefined
  onConfig: (configId: string, value: string) => void | Promise<void>
  onManageModels?: (() => void) | undefined
}) {
  const [showHidden, setShowHidden] = useState(false)
  const preferences = useModelPreferences()
  const state: AgentConfigState = { busy, ...(feedback ? { feedback } : {}) }
  const blocked = agentConfigBlocked(state)
  const choose = (id: string, value: string) => {
    const intent = agentConfigChoice(config, id, value, state)
    if (intent) return onConfig(intent.configId, intent.value)
    return undefined
  }
  const manage = onManageModels && (
    <MenuFooterLink icon={Box} chevron={false} closes onClick={onManageModels}>
      管理模型…
    </MenuFooterLink>
  )
  if (harness?.capabilities.models.owner === 'latch' && catalog.providers.length > 0) {
    const groups = modelGroups(catalog, preferences, model, showHidden).map(group => ({
      ...group,
      options: group.options.map(option => ({ ...option, description: undefined })),
    }))
    const count = groups.reduce((sum, group) => sum + group.options.length, 0)
    const provider = findProvider(catalog, model?.providerId)
    return (
      <ValuePicker
        label="模型"
        placeholder="选择模型"
        value={model ? modelKey(model) : undefined}
        valueText={!model || sameModel(model, current) ? modelChipText(model?.model, undefined) : pendingModelText(model.model)}
        groups={groups}
        searchable={count >= 8}
        searchMatch={(option, query) => fuzzyModelMatch(option.label, query)}
        width={320}
        {...(provider ? { leading: <ProviderTile provider={provider} size={16} /> } : {})}
        className="model-picker"
        menuChevron
        disabled={locked !== undefined}
        disabledReason={locked}
        onValueChange={key => {
          rememberModel(key)
          const [providerId = '', name = ''] = key.split('\u0000')
          onModel({ providerId, model: name })
        }}
        footer={
          <div className="model-footer">
            <FixedThinking note={BUILTIN_THINKING_NOTE} />
            {model && !sameModel(model, current) && (
              <MenuFooterLink
                chevron={false}
                closes
                onClick={() => {
                  onModel(undefined)
                }}>
                {resetModelLabel(current)}
              </MenuFooterLink>
            )}
            <HiddenModelsLink
              shown={showHidden}
              onToggle={() => {
                setShowHidden(!showHidden)
              }}
            />
            {manage}
          </div>
        }
      />
    )
  }
  const modelOption = config.find(option => option.category === 'model')
  const thought = config.find(option => option.category === 'thought_level')
  const others = config.filter(option => option.category === 'model_config')
  const values = (option: SessionConfigOption) =>
    agentConfigValues(option).map(item => ({
      value: item.value,
      label: escapeHiddenCharacters(item.name),
      ...(item.description ? { description: escapeHiddenCharacters(item.description) } : {}),
      ...(blocked
        ? { disabledReason: feedback?.kind === 'unknown' ? '上次切换的结果未知，请先刷新当前设置。' : '正在切换，请稍后。' }
        : {}),
    }))
  const name = harness ? harnessName(harness) : 'Harness'
  const reportedOr = modelOption ? agentConfigLabel(modelOption) : reported
  const text = modelChipText(reportedOr, thought ? agentConfigLabel(thought) : undefined)
  const note = unreportedNote(name, true, config)
  return (
    <ValuePicker
      label="模型"
      value={modelOption?.currentValue ?? OWN_MODEL}
      valueText={escapeHiddenCharacters(feedback?.kind === 'unknown' ? `${text} · 结果未知` : text)}
      groups={ownModelGroups(catalog, name, modelOption ? values(modelOption) : [{ value: OWN_MODEL, label: reportedOr ?? DEFAULT_MODEL }])}
      className="model-picker"
      menuChevron
      searchable={(modelOption?.options.length ?? 0) >= 8}
      width={340}
      pending={busy !== null}
      pendingLabel="正在切换…"
      disabled={locked !== undefined}
      disabledReason={locked}
      onValueChange={value => {
        if (modelOption) return choose(modelOption.id, value)
        return undefined
      }}
      footer={
        <div className="model-footer">
          {thought ? (
            <>
              <LevelRow
                option={thought}
                disabled={blocked}
                onChoose={value => {
                  void choose(thought.id, value)
                }}
              />
              {note && <p className="model-note">{note}</p>}
            </>
          ) : (
            <FixedThinking note={note} />
          )}
          {others.map(option => (
            <ConfigRow
              key={option.id}
              option={option}
              disabled={blocked}
              onChoose={value => {
                void choose(option.id, value)
              }}
            />
          ))}
          {feedback && (
            <InlineNotice
              tone={feedback.kind === 'unknown' ? 'warn' : 'error'}
              action={feedback.kind === 'unknown' && onRefresh ? <RefreshConfig refresh={onRefresh} /> : undefined}>
              <VisibleText text={feedback.message} />
            </InlineNotice>
          )}
          {manage}
        </div>
      }
    />
  )
}

function ConfigRow({ option, disabled, onChoose }: { option: SessionConfigOption; disabled: boolean; onChoose: (value: string) => void }) {
  return (
    <ValuePicker
      variant="row"
      label={escapeHiddenCharacters(option.name)}
      value={option.currentValue}
      options={agentConfigValues(option).map(item => ({ value: item.value, label: escapeHiddenCharacters(item.name) }))}
      disabled={disabled}
      searchable={option.options.length > 8}
      onValueChange={onChoose}
    />
  )
}

function RefreshConfig({ refresh }: { refresh: () => void | Promise<void> }) {
  const close = useLayerClose()
  return (
    <Button
      size="xs"
      onClick={() => {
        void Promise.resolve(refresh())
          .then(close)
          .catch(() => {})
      }}>
      刷新当前设置
    </Button>
  )
}
