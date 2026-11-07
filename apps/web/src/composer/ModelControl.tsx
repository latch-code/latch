import { useState, type ReactNode } from 'react'
import { Box, ChevronLeft, Cpu, Pin, PinOff, Plus, Sparkles } from 'lucide-react'
import {
  modelIdKey,
  pairRoute,
  WIRE_NAMES,
  type AgentPresetSettings,
  type AgentSettings,
  type HarnessInfo,
  type HostCatalog,
  type ModelRef,
  type ProviderSummary,
  type SessionConfigOption,
  type TaskSummary,
} from '@latch/protocol'
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
  draftConfig,
  engineEntries,
  findProvider,
  harnessName,
  isPinnedChoice,
  presetsToAdd,
  sameModel,
  serviceModels,
  servicePick,
  switchModel,
  thinkingLevels,
  withServicePick,
  withTypedModels,
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
  modelWords,
  THINKING_AFTER_START,
  thinkingWord,
  unreportedNote,
  type AgentConfigState,
} from './modelReasoning.ts'
import { CatalogueRows, readOnSelect, readsOnSelect, TypedModelsPanel, useReading } from './harnessCatalogue.tsx'

type Access = Pick<DeviceAccess, 'legacy' | 'local' | 'admin' | 'scopes'>
/** The most levels a segmented row holds in the popover's width; more go in a row that opens its own list. */
const SEGMENTED_LEVELS = 5
export const OWN_MODEL = 'own'

const pendingModelText = (model: ModelRef) => `下一条：${modelWords(model)}`
const resetModelLabel = (current: ModelRef | undefined) => (current ? `撤销切换，继续使用 ${modelWords(current)}` : '撤销切换')
/** The built-in row's first value: no level sent, the model's own default. Not a valid wire level, so it never collides. */
const MODEL_DEFAULT_LEVEL = '~default'

/**
 * 思考: a segmented row of the levels on offer, or a list when there are too many; the menu stays open. A level the
 * Harness describes keeps its own words: on hover in the row, in the list, and under the row for the chosen one, so a
 * phone shows them too.
 */
function LevelRow({
  value,
  options,
  disabled,
  onChoose,
}: {
  value: string
  options: Array<{ value: string; label: string; description?: string }>
  disabled: boolean
  onChoose: (value: string) => void
}) {
  const chosen = options.find(option => option.value === value)?.description
  return (
    <>
      <div className="model-setting">
        <span className="model-setting-name">思考</span>
        {options.length <= SEGMENTED_LEVELS ? (
          <SegmentedControl
            label="思考"
            value={value}
            disabled={disabled}
            options={options.map(({ description, ...option }) => (description ? { ...option, title: description } : option))}
            onValueChange={onChoose}
          />
        ) : (
          <ValuePicker variant="row" label="思考" value={value} disabled={disabled} options={options} onValueChange={onChoose} />
        )}
      </div>
      {chosen && <p className="model-note">{chosen}</p>}
    </>
  )
}

/** 思考 on the built-in Harness: 默认, then the levels declared for this model in settings. A pick goes with the model. */
function BuiltinThinking({
  model,
  levels,
  disabled,
  onModel,
}: {
  model: ModelRef
  levels: readonly string[]
  disabled: boolean
  onModel: (model: ModelRef) => void
}) {
  // A level taken away in settings since the session chose it: the row stays, so 默认 is one press away.
  const withdrawn = model.effort !== undefined && !levels.includes(model.effort)
  if (levels.length === 0 && !withdrawn) return <FixedThinking note={BUILTIN_THINKING_NOTE} />
  return (
    <>
      <LevelRow
        value={model.effort ?? MODEL_DEFAULT_LEVEL}
        options={[{ value: MODEL_DEFAULT_LEVEL, label: '默认' }, ...levels.map(level => ({ value: level, label: thinkingWord(level) }))]}
        disabled={disabled}
        onChoose={value => {
          onModel({ providerId: model.providerId, model: model.model, ...(value === MODEL_DEFAULT_LEVEL ? {} : { effort: value }) })
        }}
      />
      {withdrawn && <p className="model-note">{`这个模型不再设置「${thinkingWord(model.effort!)}」，重新选一个后再发送。`}</p>}
    </>
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
  onRead,
}: {
  catalog: HostCatalog
  choice: ComposerChoice
  onChoice: (patch: Partial<ComposerChoice>) => void
  access: Access
  disabled: boolean
  onManage?: (() => void) | undefined
  onAdded?: ((agent: AgentSettings) => void) | undefined
  onDefaultsChanged?: (() => void | Promise<void>) | undefined
  /** A read of a Harness's lists that a selection started has ended. */
  onRead?: (() => void) | undefined
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
      onValueChange={harnessId => {
        onChoice({ harnessId })
        const chosen = entries.find(entry => entry.harness.id === harnessId)?.harness
        if (readsOnSelect(chosen, access)) readOnSelect(chosen, onRead)
      }}
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

/** A model of a service as the picker's value: never an agent's own option value, which has no NUL in it. */
const SERVICE_VALUE = '~service\u0000'
export const serviceValue = (model: ModelRef) => `${SERVICE_VALUE}${model.providerId}\u0000${model.model}`
export function serviceRef(value: string): ModelRef | undefined {
  if (!value.startsWith(SERVICE_VALUE)) return undefined
  const [providerId = '', model = ''] = value.slice(SERVICE_VALUE.length).split('\u0000')
  return providerId && model ? { providerId, model } : undefined
}

/** Whether a session on `harness` can be started on `provider` through Latch, as a draft states it. */
function serviceReason(harness: HarnessInfo, provider: ProviderSummary): string | undefined {
  const name = harnessName(harness)
  const route = pairRoute(harness.capabilities, provider)
  if (route.kind === 'passthrough') return undefined
  if (route.kind === 'translate')
    return `${name} 只说 ${route.speaks.map(wire => WIRE_NAMES[wire]).join('、')} 协议，转换 ${WIRE_NAMES[route.from]} 尚未实现`
  return `让 Latch 把 ${name} 的请求转给它，尚未实现`
}

// Only a turn with no request through the gateway can be told apart; a turn that sends some elsewhere cannot.
export const ROUTE_NOTE = (name: string) =>
  `「经 Latch」表示请求由 Latch 在这台 Mac 上转发，用设置里的密钥。${name} 有一整轮没有经过 Latch 时，会话里会告诉你。`
const ROUTE_LOCKED = '换服务要新开会话：开始时确认的是这个服务。'

/** What a session on a route says of it in its model menu. */
function routeNote(catalog: HostCatalog, name: string, route: NonNullable<TaskSummary['modelRoute']>): string {
  const service = findProvider(catalog, route.providerId)?.name ?? route.providerId
  return route.bypassed
    ? `这个会话有一轮没有经过 Latch：那一轮可能用了 ${name} 自己的登录或配置。`
    : `这个会话经 Latch 用「${service}」：请求由 Latch 在这台 Mac 上转发，用设置里的密钥。`
}

/**
 * A Harness with its own models lists them first, then each saved service. In a draft, a service Latch can forward the
 * Harness's requests to lists its models under 「经 Latch」; the others say why they cannot be chosen. A Harness that
 * uses only models it knows is offered only those its own list names, once read. In a session the service is the one it
 * started with, so every service is listed without a choice.
 */
export function ownModelGroups(
  catalog: HostCatalog,
  harness: HarnessInfo | undefined,
  own: Array<PickerGroup<string>['options'][number]>,
  session?: { route?: TaskSummary['modelRoute'] },
): Array<PickerGroup<string>> {
  const name = harness ? harnessName(harness) : 'Harness'
  // What it read of its own models, without the IDs a person typed for it.
  const known = harness?.catalogue?.options.find(option => option.category === 'model')?.options
  const knows =
    harness?.capabilities.models.knownOnly && known?.length
      ? new Set(known.flatMap(item => [modelIdKey(item.value), modelIdKey(item.name)]))
      : undefined
  const routed = session?.route ? findProvider(catalog, session.route.providerId) : undefined
  const services = catalog.providers.filter(provider => provider.kind !== 'demo' && provider.id !== session?.route?.providerId)
  // On a route, the Host offers only the service's models, the ones the gateway forwards.
  const ownLabel = session?.route ? `${routed?.name ?? session.route.providerId} · 经 Latch` : `${name} 自己的模型`
  const groups: Array<PickerGroup<string>> = [{ id: '~own', label: ownLabel, options: own }]
  const disabled: Array<PickerGroup<string>['options'][number]> = []
  for (const provider of services) {
    const reason = harness ? serviceReason(harness, provider) : `让 Latch 把 ${name} 的请求转给它，尚未实现`
    const media = <ProviderTile provider={provider} size={16} />
    if (session || reason !== undefined) {
      disabled.push({
        value: `~service-${provider.id}`,
        label: provider.name,
        media,
        disabledReason: reason ?? (session?.route ? ROUTE_LOCKED : '要经 Latch 用它，新开一个会话。'),
      })
      continue
    }
    const experimental = harness?.capabilities.models.experimental ? '实验性 · ' : ''
    groups.push({
      id: `~service-${provider.id}`,
      label: `${provider.name} · ${experimental}经 Latch`,
      options: serviceModels(provider).map(model => ({
        value: serviceValue({ providerId: provider.id, model }),
        label: model,
        media,
        ...(knows && !knows.has(modelIdKey(model)) ? { disabledReason: `${name} 不认识这个模型` } : {}),
      })),
    })
  }
  if (disabled.length) groups.push({ id: '~services', label: '模型服务', options: disabled })
  return groups
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
  onRead,
}: {
  catalog: HostCatalog
  choice: ComposerChoice
  onChoice: (patch: Partial<ComposerChoice>) => void
  access: Access
  disabled: boolean
  onManageModels?: (() => void) | undefined
  onProvidersChanged?: (() => void) | undefined
  /** A read of the Harness's lists, or the IDs typed for it, changed. */
  onRead?: (() => void | Promise<void>) | undefined
}) {
  const [adding, setAdding] = useState(false)
  const [typing, setTyping] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const preferences = useModelPreferences()
  const entries = engineEntries(catalog, choice.workspaceId)
  const harness = entries.find(entry => entry.harness.id === choice.harnessId)?.harness
  const readingNow = useReading(harness)
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
    const known = draftConfig(harness, choice.config)
    const modelOption = known?.config.find(option => option.category === 'model')
    const service = servicePick(catalog, harness, choice.config)
    // A model of its own replaces a service pick; thinking and the rest are the Harness's own, kept either way.
    const pick = (configId: string, value: string) => {
      const base = configId === modelOption?.id ? withServicePick(choice.config, undefined) : choice.config
      onChoice({ config: { ...base, [configId]: value } })
    }
    const pickService = (model: ModelRef | undefined) => {
      onChoice({ config: withServicePick(choice.config, model, modelOption?.id) })
    }
    const rows = (
      <CatalogueRows
        harness={harness}
        access={access}
        hasModels={modelOption !== undefined}
        onRead={onRead}
        onTypeModel={() => {
          setTyping(true)
        }}
      />
    )
    const panel =
      typing && modelOption ? (
        <TypedModelsPanel
          harness={harness}
          onBack={() => {
            setTyping(false)
          }}
          onChoose={model => {
            pick(modelOption.id, model)
            setTyping(false)
          }}
          onSaved={onRead}
        />
      ) : undefined
    const opened = (open: boolean) => {
      if (!open) setTyping(false)
      // Opening the model menu of a Harness nothing is known of is asking what it offers.
      if (open && readsOnSelect(harness, access)) readOnSelect(harness, onRead)
    }
    // One picker whether the list is known yet, so the menu stays open while a read fills it.
    return (
      <HarnessModelPicker
        catalog={catalog}
        harness={harness}
        // Thinking and the like are offered for the Harness's own models; on a service's model it reports them once started.
        config={service ? (known?.config.filter(option => option.category === 'model') ?? []) : (known?.config ?? [])}
        busy={null}
        disabled={disabled}
        service={{ picked: service, onPick: pickService }}
        note={
          service
            ? THINKING_AFTER_START(name)
            : known
              ? known.thinkingUnknown
                ? THINKING_AFTER_START(name)
                : unreportedNote(name, true, known.config)
              : harness.catalogueRead
                ? null
                : unreportedNote(name, false, [])
        }
        onConfig={pick}
        rows={rows}
        panel={panel}
        reading={readingNow}
        onOpenChange={opened}
        manage={manage}
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
      {...(choice.model
        ? { valueText: modelChipText(choice.model.model, choice.model.effort ? thinkingWord(choice.model.effort) : undefined) }
        : {})}
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
        onChoice({ model: switchModel(catalog, choice.model, { providerId, model }) })
      }}
      footer={
        <div className="model-footer">
          {choice.model && (
            <BuiltinThinking
              model={choice.model}
              levels={thinkingLevels(catalog, choice.model)}
              disabled={disabled}
              onModel={model => {
                onChoice({ model })
              }}
            />
          )}
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
  route,
}: AgentConfigState & {
  /** This device may read the session but not change it: why, as the picker's tooltip. */
  locked?: string | undefined
  /** The service the session's requests go to through Latch, fixed when it started. */
  route?: TaskSummary['modelRoute']
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
        valueText={
          !model || sameModel(model, current)
            ? modelChipText(model?.model, model?.effort ? thinkingWord(model.effort) : undefined)
            : pendingModelText(model)
        }
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
          onModel(switchModel(catalog, model, { providerId, model: name }))
        }}
        footer={
          <div className="model-footer">
            {model ? (
              <BuiltinThinking model={model} levels={thinkingLevels(catalog, model)} disabled={locked !== undefined} onModel={onModel} />
            ) : (
              <FixedThinking note={BUILTIN_THINKING_NOTE} />
            )}
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
  return (
    <HarnessModelPicker
      catalog={catalog}
      harness={harness}
      config={config}
      reported={reported}
      busy={busy}
      {...(feedback ? { feedback } : {})}
      onRefresh={onRefresh}
      onConfig={onConfig}
      manage={manage}
      locked={locked}
      service={{ session: true, route }}
    />
  )
}

/**
 * A Harness's own models with their thinking and other options, from one list: a running session's `config`, or for a
 * draft the list its last session offered. A pick is an intent, written to the session or kept for the start.
 */
function HarnessModelPicker({
  catalog,
  harness,
  config: given,
  reported,
  busy,
  feedback,
  onRefresh,
  onConfig,
  manage,
  locked,
  disabled,
  note: noteOverride,
  rows,
  panel,
  reading = false,
  onOpenChange,
  service,
}: AgentConfigState & {
  catalog: HostCatalog
  harness: HarnessInfo | undefined
  config: readonly SessionConfigOption[]
  reported?: string | undefined
  onRefresh?: (() => void | Promise<void>) | undefined
  onConfig: (configId: string, value: string) => void | Promise<void>
  manage: ReactNode
  locked?: string | undefined
  /** For a draft: what to say about thinking instead of what a session would; null for nothing. */
  note?: string | null | undefined
  /** For a draft: where the list comes from, reading it again, typing a model ID. */
  rows?: ReactNode
  panel?: ReactNode
  /** A read of the Harness's lists is running. */
  reading?: boolean
  onOpenChange?: ((open: boolean) => void) | undefined
  /** A draft: the service model it picked and picking one. A session: the service it started on, if any. */
  service?:
    | { picked?: ModelRef | undefined; onPick?: (model: ModelRef | undefined) => void }
    | { session: true; route?: TaskSummary['modelRoute'] }
}) {
  // IDs typed for the Harness's own login are no model of the service a session's route goes to.
  const routed = service !== undefined && 'session' in service && service.route !== undefined
  const config = withTypedModels(given, routed ? undefined : harness?.customModels)
  const state: AgentConfigState = { busy, ...(feedback ? { feedback } : {}) }
  const blocked = agentConfigBlocked(state)
  const choose = (id: string, value: string) => {
    const intent = agentConfigChoice(config, id, value, state)
    if (intent) return onConfig(intent.configId, intent.value)
    return undefined
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
  const picked = service && 'picked' in service ? service.picked : undefined
  const pickedProvider = findProvider(catalog, picked?.providerId)
  // The same model can be listed by two services, so a service's model names its service.
  const text = picked
    ? `${picked.model} · ${pickedProvider?.name ?? picked.providerId}`
    : modelChipText(reportedOr, thought ? agentConfigLabel(thought) : undefined)
  const note = noteOverride === null ? undefined : (noteOverride ?? unreportedNote(name, true, config))
  const session = service && 'session' in service ? { route: service.route } : undefined
  const groups = ownModelGroups(
    catalog,
    harness,
    modelOption ? values(modelOption) : [{ value: OWN_MODEL, label: reportedOr ?? DEFAULT_MODEL }],
    session,
  )
  const routeLine = session?.route
    ? routeNote(catalog, name, session.route)
    : groups.some(group => group.id.startsWith('~service-'))
      ? ROUTE_NOTE(name)
      : undefined
  return (
    <ValuePicker
      label="模型"
      value={picked ? serviceValue(picked) : (modelOption?.currentValue ?? OWN_MODEL)}
      valueText={escapeHiddenCharacters(feedback?.kind === 'unknown' ? `${text} · 结果未知` : text)}
      {...(pickedProvider ? { leading: <ProviderTile provider={pickedProvider} size={16} /> } : {})}
      groups={groups}
      className="model-picker"
      menuChevron
      searchable={groups.reduce((sum, group) => sum + group.options.length, 0) >= 8}
      width={340}
      pending={busy !== null || reading}
      pendingLabel={reading ? '正在读取…' : '正在切换…'}
      disabled={locked !== undefined || disabled === true}
      disabledReason={locked}
      {...(panel ? { panel } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
      onValueChange={value => {
        const ref = serviceRef(value)
        if (ref || picked) {
          // Leaving a service for one of the Harness's own models, its current one included.
          if (service && 'onPick' in service) service.onPick?.(ref)
          if (!ref && modelOption && value !== modelOption.currentValue) return onConfig(modelOption.id, value)
          return undefined
        }
        if (modelOption) return choose(modelOption.id, value)
        return undefined
      }}
      footer={
        <div className="model-footer">
          {thought ? (
            <>
              <LevelRow
                value={thought.currentValue}
                options={agentConfigValues(thought).map(item => ({
                  value: item.value,
                  label: escapeHiddenCharacters(item.name),
                  // Some Harnesses repeat the level's name as its description, which says nothing more.
                  ...(item.description && item.description.trim().toLowerCase() !== item.name.trim().toLowerCase()
                    ? { description: escapeHiddenCharacters(item.description) }
                    : {}),
                }))}
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
          {rows}
          {routeLine && <p className="model-note">{routeLine}</p>}
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
