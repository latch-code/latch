import { useState, type ReactNode } from 'react'
import { GitFork } from 'lucide-react'
import {
  modelIdKey,
  pairRoute,
  WIRE_NAMES,
  GATEWAY_LOSS_NAMES,
  type AgentPresetSettings,
  type AgentSettings,
  type HarnessInfo,
  type HostCatalog,
  type ModelRef,
  type ProviderSummary,
  type SessionConfigOption,
  type TaskSummary,
  type UnusableProvider,
} from '@latch/protocol'
import {
  Badge,
  Icon,
  IconButton,
  MenuFooterLink,
  MenuFooterNote,
  Popover,
  useLayerClose,
  type PickerGroup,
  ChevronDownGlyph,
  ChevronLeftGlyph,
  ChevronRightGlyph,
  PinGlyph,
  UnpinGlyph,
  PlusGlyph,
  HarnessGlyph,
  ModelGlyph,
} from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { MODEL_MENU_COPY, SETUP_COPY, type Brief } from '../core/securityCopy.ts'
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
  withOwnDefault,
  withServicePick,
  withTypedModels,
  type ComposerChoice,
} from '../composerChoice.ts'
import { fuzzyModelMatch, modelKey, rememberModel, useModelPreferences } from '../modelPreferences.ts'
import { HarnessTile, ProviderTile } from '../components/BrandTile.tsx'
import { HealthDot, menuHealth, nameWithHealth } from '../components/ServiceHealth.tsx'
import { ModelAddPanel, modelGroups } from '../components/Pickers.tsx'
import { AgentPresetList, AgentSetupPanel } from '../components/SetupPanels.tsx'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import {
  agentConfigBlocked,
  agentConfigChoice,
  agentConfigLabel,
  agentConfigValues,
  CONFIG_UNKNOWN_REASON,
  DEFAULT_MODEL,
  feedbackFor,
  resetModelLabel,
  sameModelId,
  unreportedModelNote,
  type AgentConfigState,
} from './modelReasoning.ts'
import { BriefHint } from './BriefHint.tsx'
import { ValuePicker } from './ComposerControl.tsx'
import { ConfigFeedback, useSlowWrite } from './ThinkingControl.tsx'
import { CatalogueRows, readOnSelect, readsOnSelect, TypedModelsPanel, useReading } from './harnessCatalogue.tsx'

type Access = Pick<DeviceAccess, 'legacy' | 'local' | 'admin' | 'scopes'>
export const OWN_MODEL = 'own'

const HERE = '这台 Mac'

/**
 * One of Latch's own sentences as a page shows it: 「这台 Mac」 in the Latch app on that Mac (`computer` undefined), the
 * computer's name on any other page (`computerName`). A Harness's own words never pass through here.
 */
export function onComputer(text: string, computer: string | undefined): string {
  if (computer === undefined) return text
  return text.replace(/(\S)?这台 Mac/gu, (_, before: string | undefined) =>
    before === undefined ? computer : /\p{Script=Han}/u.test(before) ? `${before} ${computer}` : `${before}${computer}`,
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
      {error && (
        <p className="model-note" data-tone="error">
          {error}
        </p>
      )}
      <MenuFooterLink
        icon={pinned ? UnpinGlyph : PinGlyph}
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
        <IconButton size="xs" icon={ChevronLeftGlyph} label="返回" onClick={onBack} />
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
  computer,
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
  /** The Host computer's name on a page that is not the Latch app on it; see `onComputer`. */
  computer?: string | undefined
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
        description: entry.harness.statusMessage ? onComputer(entry.harness.statusMessage, computer) : undefined,
        media: <HarnessTile harness={entry.harness} size={20} />,
        ...(entry.disabledReason ? { disabledReason: entry.disabledReason } : {}),
      }))}
      header={{ title: 'Harness' }}
      width={adding ? 'md' : 'sm'}
      leading={harness ? <HarnessTile harness={harness} size={16} /> : HarnessGlyph}
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
              icon={PlusGlyph}
              chevron={false}
              onClick={() => {
                setAdding(true)
              }}>
              添加 Harness…
            </MenuFooterLink>
          )}
          {onManage && (
            <MenuFooterLink icon={HarnessGlyph} chevron={false} closes onClick={onManage}>
              管理 Harness…
            </MenuFooterLink>
          )}
        </div>
      }
      panel={
        adding ? (
          <EngineAddPanel
            catalog={catalog}
            // Saving a Harness is confirmed on the Mac: elsewhere the panel says where to add it.
            canAdd={canAdd && access.local}
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

/** Why 分叉 is off while the latest turn runs: the Host refuses a fork from a turn that has not ended. */
export const FORK_BUSY = '这一轮结束后才能分叉'

/** 分叉 in the session's Harness popover: the latest turn into a new session, which may pick another Harness. */
export interface SessionFork {
  onFork: () => void
  /** Why it cannot fork now; the row stays, dimmed, with this under it. */
  blocked?: string | undefined
}

/**
 * The Harness of a running session: its mark and name, locked, and why. The chip still opens, since a tooltip never
 * reaches touch. It offers a fork of the latest turn, where the Host can make one, and a new session.
 */
export function SessionHarnessControl({
  harness,
  onNewSession,
  fork,
}: {
  harness: HarnessInfo
  onNewSession: () => void
  fork?: SessionFork | undefined
}) {
  const name = harnessName(harness)
  return (
    <Popover
      label="Harness"
      size="sm"
      side="top"
      trigger={props => (
        <button {...props} type="button" className="chip chip-harness" aria-label={`Harness：${name}`}>
          <HarnessTile harness={harness} size={16} />
          <span className="chip-text">{name}</span>
        </button>
      )}>
      <div className="model-footer">
        <MenuFooterNote>开始后不能换 Harness</MenuFooterNote>
        {fork && <ForkRow fork={fork} />}
        <MenuFooterLink icon={PlusGlyph} chevron={false} closes onClick={onNewSession}>
          新会话
        </MenuFooterLink>
      </div>
    </Popover>
  )
}

/** A row of the popover rather than a menu item, so it stays readable while it is off. */
function ForkRow({ fork }: { fork: SessionFork }) {
  const close = useLayerClose()
  const off = fork.blocked !== undefined
  return (
    <button
      type="button"
      className="ui-menu-footer-link harness-fork"
      aria-disabled={off || undefined}
      onClick={() => {
        if (off) return
        close()
        fork.onFork()
      }}>
      <span className="ui-menu-item-lead">
        <Icon icon={GitFork} size={14} />
      </span>
      <span className="harness-fork-text">
        <span>分叉</span>
        <span className="harness-fork-line">{fork.blocked ?? '从最后一轮，可以换 Harness'}</span>
      </span>
    </button>
  )
}

/** A saved service a Harness cannot use, and why, under the model menu's one folded row. */
export interface UnusableService {
  id: string
  name: string
  provider?: ProviderSummary
  reason: string
}

/** The words for a saved service the built-in Harness cannot use yet. The app on that Mac keeps its own sentence. */
function heldReason(reason: UnusableProvider['reason'], computer: string | undefined): string {
  if (reason === 'unsupported') return '不再支持'
  if (reason === 'key-missing') return MODEL_MENU_COPY.missingKey
  return computer === undefined ? `地址还没确认 · 在${HERE} 上确认` : MODEL_MENU_COPY.unconfirmed(computer)
}

/**
 * The saved services `harness` cannot use, each with why: for the built-in Harness the ones missing a key or a
 * confirmed address; for another Harness the ones Latch cannot forward its requests to. A session's own service is not
 * among them, and one the Harness could use but this session did not start on stays listed with the models.
 */
export function unusableServices(
  catalog: HostCatalog,
  harness: HarnessInfo | undefined,
  computer?: string,
  session?: { route?: TaskSummary['modelRoute'] },
): UnusableService[] {
  if (harness?.capabilities.models.owner === 'latch')
    return (catalog.unusableProviders ?? []).map(provider => ({
      id: provider.id,
      name: provider.name,
      reason: heldReason(provider.reason, computer),
    }))
  // A Harness Latch forwards to no service uses only its own models: there is nothing it could use instead.
  if (harness && harness.capabilities.models.wires.length === 0 && !session?.route) return []
  return catalog.providers.flatMap(provider => {
    if (provider.kind === 'demo' || provider.id === session?.route?.providerId) return []
    const reason = harness ? serviceReason(harness, provider) : MODEL_MENU_COPY.notRouted('Harness')
    return reason === undefined ? [] : [{ id: provider.id, name: provider.name, provider, reason }]
  })
}

/**
 * The services a Harness cannot use, folded into one row at the foot of the model menu; opening it shows each with its
 * reason. Folded again each time the menu opens, since the menu mounts its footer then.
 */
export function UnusableServices({ services }: { services: readonly UnusableService[] }) {
  const [open, setOpen] = useState(false)
  if (services.length === 0) return null
  return (
    <div className="model-unusable" data-open={open ? '' : undefined}>
      <MenuFooterLink
        chevron={false}
        onClick={() => {
          setOpen(!open)
        }}>
        <span className="model-unusable-head">
          {MODEL_MENU_COPY.unusable(services.length)}
          <Icon icon={open ? ChevronDownGlyph : ChevronRightGlyph} size={12} />
        </span>
      </MenuFooterLink>
      {open && (
        <ul className="model-unusable-list" aria-label="这个 Harness 用不了的模型服务">
          {services.map(service => (
            <li key={service.id}>
              {service.provider ? <ProviderTile provider={service.provider} size={16} /> : <span className="model-unusable-blank" />}
              <span className="model-unusable-name">{service.name}</span>
              <span className="model-unusable-why">{service.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
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
  if (route.kind === 'passthrough' || route.kind === 'translate') return undefined
  if (route.kind === 'incompatible')
    return MODEL_MENU_COPY.wrongProtocol(
      name,
      route.speaks.map(wire => WIRE_NAMES[wire]),
      WIRE_NAMES[route.from],
    )
  return MODEL_MENU_COPY.notRouted(name)
}

/** Shared by the composer menu and the phone's new-session sheet; unsupported pairs never appear as usable. */
export function translationBrief(catalog: HostCatalog, harness: HarnessInfo | undefined, providerId?: string): Brief | undefined {
  const translated = harness
    ? catalog.providers.flatMap(provider => {
        if (providerId && providerId !== provider.id) return []
        const route = pairRoute(harness.capabilities, provider)
        return route.kind === 'translate' ? [{ name: provider.name, losses: route.losses }] : []
      })
    : []
  return translated.length
    ? {
        label: '协议转换 · 实验性',
        detail: `${translated.map(item => item.name).join('、')} 使用协议转换。略去或受限：${[...new Set(translated.flatMap(item => item.losses))].map(loss => GATEWAY_LOSS_NAMES[loss]).join('、')}。文件与服务端会话状态不能转换。`,
      }
    : undefined
}

// Only a turn with no request through the gateway can be told apart; a turn that sends some elsewhere cannot.
export const ROUTE_NOTE = (name: string, computer?: string, inherited?: boolean): Brief & { detail: string } => ({
  label: '经 Latch 转发',
  detail: `${onComputer(
    `「经 Latch」表示请求由 Latch 在这台 Mac 上转发，用设置里的密钥。${name} 有一整轮没有经过 Latch 时，会话里会告诉你。`,
    computer,
  )}${inherited ? credentialInherited(name) : ''}`,
})
/** For a Harness with no switch that keeps its environment from the commands it runs: what those commands can read. */
const credentialInherited = (name: string) => `${name} 运行的命令读得到这个会话的转发凭据，不是密钥。`
const ROUTE_LOCKED = '开始后不能换服务'

/**
 * The service a session's route goes to, as its menu names it, and why its next turn cannot go through Latch when the
 * catalog no longer offers it: the gateway refuses a service sessions may not use.
 */
export function routeService(
  catalog: HostCatalog,
  route: NonNullable<TaskSummary['modelRoute']>,
  computer?: string,
): { name: string; unusable?: { words: string; note: string } } {
  const listed = findProvider(catalog, route.providerId)
  if (listed) return { name: listed.name }
  const held = catalog.unusableProviders?.find(provider => provider.id === route.providerId)
  const name = held?.name ?? route.name
  if (name === undefined)
    return {
      name: '模型服务',
      unusable: { words: '已经删除', note: '这个会话开始时用的模型服务已经删除，下一轮会失败。要接着做，新开一个会话。' },
    }
  const [words, fix] =
    held?.reason === 'key-missing'
      ? ['没有密钥', '在设置 › 模型里添加密钥']
      : held?.reason === 'origin-unconfirmed'
        ? ['地址还没确认', onComputer('在这台 Mac 上确认它的地址', computer)]
        : held?.reason === 'unsupported'
          ? ['不再支持', '换一个模型服务']
          : route.off
            ? ['已停用', '在设置 › 模型里重新打开它']
            : ['现在不能用', '在设置 › 模型里看看它']
  return { name, unusable: { words, note: `这个会话开始时用的「${name}」${words}，下一轮会失败。${fix}，或新开一个会话。` } }
}

/** What a session on a route says of it in its model menu: a failure in full, else a few words with the rest behind ⓘ. */
function routeNote(
  catalog: HostCatalog,
  name: string,
  route: NonNullable<TaskSummary['modelRoute']>,
  computer?: string,
  inherited?: boolean,
): { failure: string } | { brief: Brief; tone?: 'warn'; fallback?: string } {
  const service = routeService(catalog, route, computer)
  if (service.unusable) return { failure: service.unusable.note }
  // What the session fixed when it started; a service deleted since has no name left to show.
  const others = (route.fallbacks ?? []).flatMap(item => (item.name ? [item.name] : []))
  const fallback = others.length ? { fallback: `出错时改用「${[...new Set(others)].join('」「')}」` } : {}
  return route.bypassed
    ? { brief: { label: '有一轮没经过 Latch', detail: `那一轮可能用了 ${name} 自己的登录或配置。` }, tone: 'warn', ...fallback }
    : {
        brief: {
          label: `经 Latch 用「${service.name}」`,
          detail: `${onComputer('请求由 Latch 在这台 Mac 上转发，用设置里的密钥。', computer)}${inherited ? credentialInherited(name) : ''}`,
        },
        ...fallback,
      }
}

/**
 * A Harness with its own models lists them first, then each saved service it can use. In a draft, a service Latch can
 * forward the Harness's requests to lists its models under 「经 Latch」; the ones it cannot use are not groups here but
 * `unusableServices`, folded into one row. A Harness that uses only models it knows is offered only those its own list
 * names, once read. In a session the service is the one it started with, so every other service it could use is listed
 * without a choice, with the rule that keeps it: a session's service is fixed when it starts.
 */
export function ownModelGroups(
  catalog: HostCatalog,
  harness: HarnessInfo | undefined,
  own: Array<PickerGroup<string>['options'][number]>,
  session?: { route?: TaskSummary['modelRoute'] },
  computer?: string,
): Array<PickerGroup<string>> {
  const name = harness ? harnessName(harness) : 'Harness'
  // What it read of its own models, without the IDs a person typed for it.
  const known = harness?.catalogue?.options.find(option => option.category === 'model')?.options
  const knows =
    harness?.capabilities.models.knownOnly && known?.length
      ? new Set(known.flatMap(item => [modelIdKey(item.value), modelIdKey(item.name)]))
      : undefined
  const routed = session?.route ? routeService(catalog, session.route, computer) : undefined
  const services = catalog.providers.filter(provider => provider.kind !== 'demo' && provider.id !== session?.route?.providerId)
  // On a route, the Host offers only the service's models, the ones the gateway forwards.
  const routedHealth = routed && !routed.unusable ? menuHealth(findProvider(catalog, session?.route?.providerId)) : undefined
  const ownLabel = routed ? `${nameWithHealth(routed.name, routedHealth)} · ${routed.unusable?.words ?? '经 Latch'}` : name
  const ownOptions = routed?.unusable
    ? own.map(option => ({ ...option, disabledReason: `下一轮会失败：服务${routed.unusable!.words}` }))
    : own
  const ownMedia =
    !routed && harness
      ? { media: <HarnessTile harness={harness} size={16} /> }
      : routedHealth
        ? { media: <HealthDot words={routedHealth} /> }
        : {}
  const groups: Array<PickerGroup<string>> = [{ id: '~own', label: ownLabel, ...ownMedia, options: ownOptions }]
  const disabled: Array<PickerGroup<string>['options'][number]> = []
  for (const provider of services) {
    // Without a Harness nothing can be forwarded; `unusableServices` says so.
    if (!harness || serviceReason(harness, provider) !== undefined) continue
    const media = <ProviderTile provider={provider} size={16} />
    if (session) {
      disabled.push({
        value: `~service-${provider.id}`,
        label: provider.name,
        media,
        disabledReason: session.route ? ROUTE_LOCKED : '新开会话才能经 Latch 用',
      })
      continue
    }
    const route = pairRoute(harness.capabilities, provider)
    const experimental = route.kind === 'translate' || harness.capabilities.models.experimental ? '实验性 · ' : ''
    const health = menuHealth(provider)
    groups.push({
      id: `~service-${provider.id}`,
      label: `${nameWithHealth(provider.name, health)} · ${experimental}经 Latch`,
      ...(health ? { media: <HealthDot words={health} /> } : {}),
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

/**
 * The model a new session of this Harness starts on when nothing is picked, as its own list says: the current value its
 * last session or read reported. Undefined while it reported none.
 */
export function defaultModelOf(harness: Pick<HarnessInfo, 'catalogue'> | undefined): string | undefined {
  return harness?.catalogue?.options.find(option => option.category === 'model')?.currentValue
}

/** 「默认」 beside the real name of the model a new session starts on. */
export const defaultTag = (value: string, defaultModel: string | undefined) =>
  defaultModel !== undefined && value === defaultModel ? { tag: <Badge>默认</Badge> } : {}

/** The menu title stays short; shortcuts belong to the workbench's shortcut list. */
const modelHeader = () => ({ title: '模型' })

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
  computer,
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
  /** The Host computer's name on a page that is not the Latch app on it; see `onComputer`. */
  computer?: string | undefined
}) {
  const [adding, setAdding] = useState(false)
  const [typing, setTyping] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const preferences = useModelPreferences()
  const entries = engineEntries(catalog, choice.workspaceId)
  const harness = entries.find(entry => entry.harness.id === choice.harnessId)?.harness
  const readingNow = useReading(harness)
  const manage = onManageModels && (
    <MenuFooterLink icon={ModelGlyph} chevron={false} closes onClick={onManageModels}>
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
        disabledReason="先选 Harness"
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
    // Leaving a service for the Harness's own default is a choice of its own: remembered, and before a project's 默认模型.
    const pickService = (model: ModelRef | undefined) => {
      onChoice({ config: model ? withServicePick(choice.config, model, modelOption?.id)! : withOwnDefault(choice.config, modelOption?.id) })
    }
    const rows = (
      <CatalogueRows
        harness={harness}
        access={access}
        hasModels={modelOption !== undefined}
        ownModels={!service}
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
        // The model's other settings are offered for the Harness's own models; on a service's model only the model is chosen here.
        config={service ? (known?.config.filter(option => option.category === 'model') ?? []) : (known?.config ?? [])}
        busy={null}
        disabled={disabled}
        service={{ picked: service, onPick: pickService }}
        note={
          service
            ? null
            : known
              ? (unreportedModelNote(name, true, known.config) ?? null)
              : harness.catalogueRead || harness.offer
                ? null
                : unreportedModelNote(name, false, [])
        }
        onConfig={pick}
        rows={rows}
        panel={panel}
        reading={readingNow}
        defaultModel={defaultModelOf(harness)}
        onOpenChange={opened}
        manage={manage}
        computer={computer}
      />
    )
  }
  const noService = !choice.model
  const groups = modelGroups(catalog, preferences, choice.model, showHidden, access).map(group => ({
    ...group,
    options: group.options.map(option => ({ ...option, description: undefined })),
  }))
  const count = groups.reduce((sum, group) => sum + group.options.length, 0)
  const provider = findProvider(catalog, choice.model?.providerId)
  return (
    <ValuePicker
      label="模型"
      placeholder="选择模型"
      value={choice.model ? modelKey(choice.model) : undefined}
      {...(choice.model ? { valueText: choice.model.model } : {})}
      groups={groups}
      searchable={count >= 8 && !adding}
      searchMatch={(option, query) => fuzzyModelMatch(option.label, query)}
      width={adding ? 'md' : 'sm'}
      {...(provider ? { leading: <ProviderTile provider={provider} size={14} /> } : {})}
      className={choice.model ? 'model-picker is-id' : 'model-picker'}
      header={modelHeader()}
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
          <UnusableServices services={unusableServices(catalog, harness, computer)} />
          <HiddenModelsLink
            shown={showHidden}
            onToggle={() => {
              setShowHidden(!showHidden)
            }}
          />
          {access.admin ? (
            <MenuFooterLink
              icon={PlusGlyph}
              chevron={false}
              onClick={() => {
                setAdding(true)
              }}>
              添加模型服务…
            </MenuFooterLink>
          ) : (
            noService && <MenuFooterNote>{SETUP_COPY.addProviderElsewhere()}</MenuFooterNote>
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
  computer,
}: AgentConfigState & {
  /** The Host computer's name on a page that is not the Latch app on it; see `onComputer`. */
  computer?: string | undefined
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
    <MenuFooterLink icon={ModelGlyph} chevron={false} closes onClick={onManageModels}>
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
        valueText={!model ? DEFAULT_MODEL : sameModelId(model, current) ? model.model : `下一条：${model.model}`}
        groups={groups}
        searchable={count >= 8}
        searchMatch={(option, query) => fuzzyModelMatch(option.label, query)}
        width="sm"
        {...(provider ? { leading: <ProviderTile provider={provider} size={14} /> } : {})}
        className={model ? 'model-picker is-id' : 'model-picker'}
        header={modelHeader()}
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
            <UnusableServices services={unusableServices(catalog, harness, computer)} />
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
      computer={computer}
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
  computer,
  defaultModel,
}: AgentConfigState & {
  computer?: string | undefined
  /** For a draft: the model a new session starts on, marked 「默认」. */
  defaultModel?: string | undefined
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
  const others = config.filter(option => option.category === 'model_config')
  const values = (option: SessionConfigOption) =>
    agentConfigValues(option).map(item => ({
      value: item.value,
      label: escapeHiddenCharacters(item.name),
      ...(option.category === 'model' ? defaultTag(item.value, defaultModel) : {}),
      ...(blocked ? { disabledReason: feedback?.kind === 'unknown' ? CONFIG_UNKNOWN_REASON : '正在切换，请稍后。' } : {}),
    }))
  const name = harness ? harnessName(harness) : 'Harness'
  const reportedOr = modelOption ? agentConfigLabel(modelOption) : reported
  const picked = service && 'picked' in service ? service.picked : undefined
  const session = service && 'session' in service ? { route: service.route } : undefined
  // The same model can be listed by two services, so a service's model carries its service's mark: a draft's pick, and
  // the service a session started on.
  const pickedProvider = findProvider(catalog, picked?.providerId ?? session?.route?.providerId)
  const text = picked ? picked.model : (reportedOr ?? DEFAULT_MODEL)
  const note = noteOverride === null ? undefined : (noteOverride ?? unreportedModelNote(name, true, config))
  // Writing the model or one of the settings in its menu; thinking and the mode say so on their own controls.
  const writing = busy !== null && (busy === modelOption?.id || others.some(option => option.id === busy))
  const slow = useSlowWrite(writing)
  const ownFeedback = feedbackFor(feedback, [modelOption?.id, ...others.map(option => option.id)])
  const groups = ownModelGroups(
    catalog,
    harness,
    modelOption ? values(modelOption) : [{ value: OWN_MODEL, label: reportedOr ?? DEFAULT_MODEL }],
    session,
    computer,
  )
  const unusable = unusableServices(catalog, harness, computer, session)
  const translationNote = translationBrief(catalog, harness, picked?.providerId ?? session?.route?.providerId)
  const routeLine = session?.route
    ? routeNote(catalog, name, session.route, computer, harness?.capabilities.models.credentialInherited)
    : groups.some(group => group.id.startsWith('~service-'))
      ? { brief: ROUTE_NOTE(name, computer, harness?.capabilities.models.credentialInherited) }
      : undefined
  return (
    <ValuePicker
      label="模型"
      value={picked ? serviceValue(picked) : (modelOption?.currentValue ?? OWN_MODEL)}
      valueText={escapeHiddenCharacters(feedback?.kind === 'unknown' && ownFeedback ? `${text} · 结果未知` : text)}
      {...(pickedProvider ? { leading: <ProviderTile provider={pickedProvider} size={14} /> } : {})}
      groups={groups}
      className={picked || reportedOr !== undefined ? 'model-picker is-id' : 'model-picker'}
      header={modelHeader()}
      menuChevron
      searchable={groups.reduce((sum, group) => sum + group.options.length, 0) >= 8}
      width="md"
      pending={writing || reading}
      pendingLabel={reading ? '正在读取…' : slow ? `等 ${name} 回应…` : '正在切换…'}
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
          <UnusableServices services={unusable} />
          {translationNote && <BriefHint brief={translationNote} className="model-note" />}
          {note && <p className="model-note">{note}</p>}
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
          {routeLine
            && ('failure' in routeLine ? (
              <p className="model-note" data-tone="error">
                {routeLine.failure}
              </p>
            ) : (
              <>
                <BriefHint brief={routeLine.brief} className="model-note" {...(routeLine.tone ? { tone: routeLine.tone } : {})} />
                {'fallback' in routeLine && routeLine.fallback && <p className="model-note">{routeLine.fallback}</p>}
              </>
            ))}
          {feedback && ownFeedback && <ConfigFeedback feedback={feedback} onRefresh={onRefresh} />}
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
