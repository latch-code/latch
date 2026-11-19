import { useState } from 'react'
import { GitFork } from 'lucide-react'
import {
  modelIdKey,
  ownChoice,
  pairRoute,
  parseModelChoice,
  serviceChoice,
  WIRE_NAMES,
  GATEWAY_LOSS_NAMES,
  type AgentPresetSettings,
  type AgentSettings,
  type HarnessInfo,
  type HostCatalog,
  type ModelRef,
  type ProviderSummary,
  type TaskSummary,
  type UnusableProvider,
} from '@latch/protocol'
import {
  Badge,
  Icon,
  IconButton,
  MenuFooterLink,
  Popover,
  Tooltip,
  useLayerClose,
  type BoardNote,
  type PickerGroup,
  ChevronDownGlyph,
  ChevronLeftGlyph,
  ChevronRightGlyph,
  PinGlyph,
  UnpinGlyph,
  PlusGlyph,
  HarnessGlyph,
} from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { computerLabel, MODEL_MENU_COPY, type Brief } from '../core/securityCopy.ts'
import {
  engineEntries,
  findProvider,
  harnessName,
  isPinnedChoice,
  presetsToAdd,
  serviceModels,
  type ComposerChoice,
} from '../composerChoice.ts'
import { HarnessTile, ProviderTile } from '../components/BrandTile.tsx'
import { HealthDot, menuHealth, nameWithHealth } from '../components/ServiceHealth.tsx'
import { AgentPresetList, AgentSetupPanel } from '../components/SetupPanels.tsx'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { isolationBrief } from '../agents/helpers.ts'
import { agentConfigValues, REASONING_COPY } from './modelReasoning.ts'
import { ValuePicker } from './ComposerControl.tsx'
import { readOnSelect, readsOnSelect } from './harnessCatalogue.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    saving: '正在保存…',
    clearDefault: '取消新会话默认',
    setDefault: '设为新会话默认',
    back: '返回',
    addHarness: '添加 Harness',
    chooseHarness: '选择 Harness',
    addHarnessMenu: '添加 Harness…',
    manageHarnesses: '管理 Harness…',
    fixedHarnessDetail: (value1: string) => `${value1}开始后不能换 Harness。`,
    fixedHarness: '开始后不能换 Harness',
    newSession: '新会话',
    fork: '分叉',
    moveTo: (name: string) => `换到 ${name} 继续`,
    unsupported: '不再支持',
    confirmLocal: (value1: string) => `地址还没确认 · 在${value1} 上确认`,
    unusableServices: '这个 Harness 用不了的模型服务',
    forwarded: (value1: string) => `经 ${value1}转发`,
    forwardedDetail: (value1: string, value2: string) =>
      `「经 ${value1}」表示请求由 Latch 在这台 Mac 上转发，用设置里的密钥。${value2} 有一整轮没有经过 Latch 时，会话里会告诉你。`,
    sessionCredential: (value1: string) => `${value1} 运行的命令读得到这个会话的转发凭据，不是密钥。`,
    fixedRoute: (value1: string) => `${value1} 的会话不能在它自己的登录和经 Latch 之间换，新开一个会话`,
    service: '模型服务',
    deleted: '已经删除',
    deletedDetail: '这个会话开始时用的模型服务已经删除，下一轮会失败。要接着做，新开一个会话。',
    noKey: '没有密钥',
    addKey: '在设置 › 模型里添加密钥',
    unconfirmed: '地址还没确认',
    confirmAddress: '在这台 Mac 上确认它的地址',
    unsupportedRoute: '不再支持',
    anotherService: '换一个模型服务',
    off: '已停用',
    turnOn: '在设置 › 模型里重新打开它',
    unavailable: '现在不能用',
    checkSettings: '在设置 › 模型里看看它',
    unusableDetail: (value1: string, value2: string, value3: string) =>
      `这个会话开始时用的「${value1}」${value2}，下一轮会失败。${value3}，或新开一个会话。`,
    forwards: '请求由 Latch 在这台 Mac 上转发，用设置里的密钥。',
    fallsBack: (value1: string) => `出错时改用「${value1}」。`,
    experimentalDetail: (value1: string) => `协议转换，实验性：略去或受限的有${value1}；文件与服务端会话状态不能转换。`,
    experimentalNote: (value1: string) => `${value1}协议转换，实验性。`,
    limits: '略去或受限',
    notConverted: '文件与服务端会话状态（不能转换）',
    serviceFail: (value1: string) => `下一轮会失败：服务${value1}`,
    unknownModel: (value1: string) => `${value1} 不认识这个模型`,
    default: '默认',
  },
  {
    saving: 'Saving…',
    clearDefault: 'Remove new-session default',
    setDefault: 'Default for new sessions',
    back: 'Back',
    addHarness: 'Add Harness',
    chooseHarness: 'Choose Harness',
    addHarnessMenu: 'Add Harness…',
    manageHarnesses: 'Manage Harnesses…',
    fixedHarnessDetail: (value1: string) => `${value1} The Harness stays fixed after the session starts.`,
    fixedHarness: 'Harness is fixed once started',
    newSession: 'New session',
    fork: 'Fork',
    moveTo: (name: string) => `Continue with ${name}`,
    unsupported: 'No longer supported',
    confirmLocal: (value1: string) => `Address unconfirmed · Confirm on ${value1}`,
    unusableServices: 'Model services this Harness cannot use',
    forwarded: (value1: string) => `Forwarded via ${value1}`,
    forwardedDetail: (value1: string, value2: string) =>
      `Requests through ${value1} are forwarded by Latch on this Mac using the key in Settings. The conversation shows when an entire ${value2} turn bypasses Latch.`,
    sessionCredential: (value1: string) =>
      `Commands run by ${value1} can read this session’s forwarding credential. The model service key stays on this Mac.`,
    fixedRoute: (value1: string) =>
      `This ${value1} session keeps either its own login or the Latch route. Start a new session to change the route.`,
    service: 'Model service',
    deleted: 'deleted',
    deletedDetail: 'The model service this session started on was deleted. The next turn will fail. Start a new session to continue.',
    noKey: 'has no key',
    addKey: 'Add a key in Settings › Models',
    unconfirmed: 'has an unconfirmed address',
    confirmAddress: 'Confirm its address on this Mac',
    unsupportedRoute: 'is no longer supported',
    anotherService: 'Choose another model service',
    off: 'is turned off',
    turnOn: 'Turn it back on in Settings › Models',
    unavailable: 'is unavailable',
    checkSettings: 'Check it in Settings › Models',
    unusableDetail: (value1: string, value2: string, value3: string) =>
      `This session started with “${value1}”, which ${value2}. The next turn will fail. ${value3} or start a new session.`,
    forwards: 'Latch forwards the requests on this Mac using the key in Settings.',
    fallsBack: (value1: string) => `If the request fails, use “${value1}”.`,
    experimentalDetail: (value1: string) =>
      `Experimental protocol conversion. Limited or omitted: ${value1}. Files and server-side session state cannot be converted.`,
    experimentalNote: (value1: string) => `${value1} Protocol conversion is experimental.`,
    limits: 'Limited or omitted',
    notConverted: 'Files and server-side session state (conversion unavailable)',
    serviceFail: (value1: string) => `The next turn will fail. The service ${value1}.`,
    unknownModel: (value1: string) => `${value1} does not recognize this model`,
    default: 'Default',
  },
)

type Access = Pick<DeviceAccess, 'legacy' | 'local' | 'admin' | 'scopes'>
export const OWN_MODEL = 'own'

const CONTROL_COPY = defineCopy(
  { forkBusy: '这一轮结束后才能分叉', fixedService: '开始后不能换服务' },
  { forkBusy: 'Fork after this turn ends', fixedService: 'Service is fixed once started' },
)

/**
 * That Latch does not isolate an external Harness, as the chip that picks it says on hover: the same words each reply's
 * author line carries. Nothing for the built-in Harness.
 */
export function isolationTip(harness: Pick<HarnessInfo, 'capabilities' | 'level' | 'permission'>): string | undefined {
  const brief = isolationBrief(harness)
  return brief && [brief.label, brief.detail].filter(Boolean).join('。')
}

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
        {busy ? COPY.saving : pinned ? COPY.clearDefault : COPY.setDefault}
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
        <IconButton size="xs" icon={ChevronLeftGlyph} label={COPY.back} onClick={onBack} />
        <span>{COPY.addHarness}</span>
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
  const boundary = harness && isolationTip(harness)
  return (
    <ValuePicker
      label="Harness"
      placeholder={COPY.chooseHarness}
      value={harness?.id}
      options={entries.map(entry => ({
        value: entry.harness.id,
        label: entry.label,
        // Where its program is belongs to the hover, not to a line under every name.
        description: entry.harness.statusMessage ? onComputer(entry.harness.statusMessage, computer) : undefined,
        ...(access.admin && entry.harness.bound?.path ? { hint: escapeHiddenCharacters(entry.harness.bound.path) } : {}),
        media: <HarnessTile harness={entry.harness} size={20} />,
        ...(entry.disabledReason ? { disabledReason: entry.disabledReason } : {}),
      }))}
      header={{ title: 'Harness' }}
      width={adding ? 'md' : 'sm'}
      leading={harness ? <HarnessTile harness={harness} size={16} /> : HarnessGlyph}
      className="harness-picker"
      menuChevron
      disabled={disabled}
      {...(boundary ? { hint: boundary } : {})}
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
              {COPY.addHarnessMenu}
            </MenuFooterLink>
          )}
          {onManage && (
            <MenuFooterLink icon={HarnessGlyph} chevron={false} closes onClick={onManage}>
              {COPY.manageHarnesses}
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
export const forkBusy = () => CONTROL_COPY.forkBusy

/** 分叉 in the session's Harness popover: the latest turn into a new session, which may pick another Harness. */
export interface SessionFork {
  onFork: () => void
  /** The other Harnesses this conversation can go on with, each starting it there with what was said so far. */
  moves?: ReadonlyArray<{ harness: HarnessInfo; onMove: () => void }>
  /** Why it cannot fork now; the row stays, dimmed, with this under it. */
  blocked?: string | undefined
}

/**
 * The Harness of a running session: its mark and name, locked (the chip's tooltip says so). It opens to a fork of the
 * latest turn, where the Host can make one, and a new session.
 */
export function SessionHarnessControl({
  harness,
  admin,
  onNewSession,
  fork,
}: {
  harness: HarnessInfo
  admin: boolean
  onNewSession: () => void
  fork?: SessionFork | undefined
}) {
  const name = harnessName(harness)
  const boundary = isolationTip(harness)
  return (
    <Popover
      label="Harness"
      size="sm"
      side="top"
      trigger={props => (
        <Tooltip
          content={
            <>
              {boundary ? COPY.fixedHarnessDetail(boundary) : COPY.fixedHarness}
              {admin && harness.bound?.path && (
                <>
                  <br />
                  <span className="settings-mono">{escapeHiddenCharacters(harness.bound.path)}</span>
                </>
              )}
            </>
          }>
          <button {...props} type="button" className="chip chip-harness" aria-label={`Harness：${name}`}>
            <HarnessTile harness={harness} size={16} />
            <span className="chip-text">{name}</span>
          </button>
        </Tooltip>
      )}>
      <div className="model-footer">
        {fork?.moves?.map(move => (
          <MoveRow key={move.harness.id} move={move} blocked={fork.blocked} />
        ))}
        {fork && <ForkRow fork={fork} />}
        <MenuFooterLink icon={PlusGlyph} chevron={false} closes onClick={onNewSession}>
          {COPY.newSession}
        </MenuFooterLink>
      </div>
    </Popover>
  )
}

/** 换到 another Harness: the same conversation goes on there. Off for the reason a fork is off. */
function MoveRow({ move, blocked }: { move: NonNullable<SessionFork['moves']>[number]; blocked: string | undefined }) {
  const close = useLayerClose()
  const off = blocked !== undefined
  return (
    <Tooltip content={blocked}>
      <button
        type="button"
        className="ui-menu-footer-link harness-move"
        aria-disabled={off || undefined}
        onClick={() => {
          if (off) return
          close()
          move.onMove()
        }}>
        <span className="ui-menu-item-lead">
          <HarnessTile harness={move.harness} size={16} />
        </span>
        <span className="harness-fork-text">{COPY.moveTo(harnessName(move.harness))}</span>
      </button>
    </Tooltip>
  )
}

/** A row of the popover rather than a menu item, so it stays focusable while it is off; why it is off is its tooltip. */
function ForkRow({ fork }: { fork: SessionFork }) {
  const close = useLayerClose()
  const off = fork.blocked !== undefined
  return (
    <Tooltip content={fork.blocked}>
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
        <span className="harness-fork-text">{COPY.fork}</span>
      </button>
    </Tooltip>
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
  if (reason === 'unsupported') return COPY.unsupported
  if (reason === 'key-missing') return MODEL_MENU_COPY.missingKey
  return computer === undefined ? COPY.confirmLocal(computerLabel(true)) : MODEL_MENU_COPY.unconfirmed(computer)
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
        <ul className="model-unusable-list" aria-label={COPY.unusableServices}>
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

/**
 * A model of a service as the picker's value, the same a session's model option takes to move there
 * (`serviceChoice`): never an agent's own option value, which has no NUL in it.
 */
export const serviceValue = (model: ModelRef) => serviceChoice(model)
export function serviceRef(value: string): ModelRef | undefined {
  const choice = parseModelChoice(value)
  return choice?.kind === 'service' ? { providerId: choice.providerId, model: choice.model } : undefined
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

/** The one name of Latch's model gateway wherever a page shows it: the panel's source, the composer's status, a turn's footer. */
export const ROUTING_COPY = defineCopy(
  { gateway: 'Latch 网关', experimental: '实验性' },
  { gateway: 'Latch gateway', experimental: 'Experimental' },
)
/** On a service group's heading: the route is a protocol translation, or the Harness's forwarding is not yet proven. */

/**
 * A group of the model panel. `gateway`: a service's models that go through Latch's gateway, all of which the panel
 * shows under the one 「Latch 网关」 source, each service under its own name.
 */
export type ModelGroup = PickerGroup<string> & { gateway?: { experimental: boolean }; note?: BoardNote }

// Only a turn with no request through the gateway can be told apart; a turn that sends some elsewhere cannot.
export const ROUTE_NOTE = (name: string, computer?: string, inherited?: boolean): Brief & { detail: string } => ({
  label: COPY.forwarded(ROUTING_COPY.gateway),
  detail: `${onComputer(COPY.forwardedDetail(ROUTING_COPY.gateway, name), computer)}${inherited ? credentialInherited(name) : ''}`,
})
/** For a Harness with no switch that keeps its environment from the commands it runs: what those commands can read. */
const credentialInherited = (name: string) => COPY.sessionCredential(name)
/** Why a session of a Harness that keeps it where it began cannot cross between its own login and a service. */
const routeBound = (name: string) => COPY.fixedRoute(name)

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
      name: COPY.service,
      unusable: { words: COPY.deleted, note: COPY.deletedDetail },
    }
  const [words, fix] =
    held?.reason === 'key-missing'
      ? [COPY.noKey, COPY.addKey]
      : held?.reason === 'origin-unconfirmed'
        ? [COPY.unconfirmed, onComputer(COPY.confirmAddress, computer)]
        : held?.reason === 'unsupported'
          ? [COPY.unsupportedRoute, COPY.anotherService]
          : route.off
            ? [COPY.off, COPY.turnOn]
            : [COPY.unavailable, COPY.checkSettings]
  return { name, unusable: { words, note: COPY.unusableDetail(name, words, fix) } }
}

/**
 * What a group of a service's models says on hover of its heading: where its requests go and with which key, what a
 * protocol translation leaves out, that the Harness's commands read the credential, and for the session's own service
 * what it falls back to. Not a row of the menu. `note` is the same for a phone's tap: the lead, then what a translation
 * leaves out folded behind one row.
 */
function serviceHint(
  harness: HarnessInfo | undefined,
  name: string,
  provider: ProviderSummary | undefined,
  computer: string | undefined,
  route?: NonNullable<TaskSummary['modelRoute']>,
): { hint: string; note: BoardNote } {
  const pair = harness && provider ? pairRoute(harness.capabilities, provider) : undefined
  const others = (route?.fallbacks ?? []).flatMap(item => (item.name ? [item.name] : []))
  const lead = onComputer(COPY.forwards, computer)
  const losses = pair?.kind === 'translate' ? [...new Set(pair.losses)].map(loss => GATEWAY_LOSS_NAMES[loss]) : undefined
  const after = [
    harness?.capabilities.models.credentialInherited ? credentialInherited(name) : '',
    others.length ? COPY.fallsBack([...new Set(others)].join('」「')) : '',
  ].filter(Boolean)
  return {
    hint: [lead, losses ? COPY.experimentalDetail(losses.join('、')) : '', ...after].join(''),
    note: {
      lead: losses ? COPY.experimentalNote(lead) : lead,
      ...(losses ? { fold: { label: COPY.limits, items: [...losses, COPY.notConverted] } } : {}),
      after,
    },
  }
}

/**
 * A Harness with its own models lists them first, then each saved service it can use, each service's models in its own
 * group marked `gateway` (the panel's 「Latch 网关」); the ones it cannot use are not groups here but `unusableServices`, folded into one row. A Harness that uses
 * only models it knows is offered only those its own list names, once read. A session lists the same: on a service, its
 * service's models are what the session reports and the Harness's own are those its list names (`ownChoice`); another
 * service's models move the session there (`serviceChoice`). A Harness that cannot move a session that way has those
 * choices shown with the reason.
 */
export function ownModelGroups(
  catalog: HostCatalog,
  harness: HarnessInfo | undefined,
  own: Array<PickerGroup<string>['options'][number]>,
  session?: { route?: TaskSummary['modelRoute'] },
  computer?: string,
): ModelGroup[] {
  const name = harness ? harnessName(harness) : 'Harness'
  // What it read of its own models, without the IDs a person typed for it.
  const listed = harness?.catalogue?.options.find(option => option.category === 'model')
  const known = listed?.options
  const knows =
    harness?.capabilities.models.knownOnly && known?.length
      ? new Set(known.flatMap(item => [modelIdKey(item.value), modelIdKey(item.name)]))
      : undefined
  const route = session?.route
  const routed = route ? routeService(catalog, route, computer) : undefined
  const switching = harness?.capabilities.models.routeSwitch
  // In a session: why a choice that leaves its route cannot be made, `crossing` between the Harness's login and a service.
  const locked = (crossing: boolean) =>
    !session ? undefined : !switching ? CONTROL_COPY.fixedService : crossing && switching === 'services' ? routeBound(name) : undefined
  const media = harness ? { media: <HarnessTile harness={harness} size={16} /> } : {}
  const ownOptions: Array<PickerGroup<string>['options'][number]> = route
    ? (listed ? agentConfigValues(listed) : [{ value: '', name: REASONING_COPY.defaultModel }]).map(item => {
        const reason = locked(true)
        return {
          value: ownChoice(item.value),
          label: escapeHiddenCharacters(item.name),
          ...(reason ? { disabledReason: reason } : {}),
        }
      })
    : own
  const groups: ModelGroup[] = [{ id: '~own', label: name, ...media, options: ownOptions }]
  // The session's own service: what it reports, as it always did; failing, every choice says the next turn fails.
  const routeGroup = (provider: ProviderSummary | undefined): ModelGroup => {
    const health = routed && !routed.unusable ? menuHealth(provider) : undefined
    const pair = harness && provider ? pairRoute(harness.capabilities, provider) : undefined
    const experimental = pair?.kind === 'translate' || harness?.capabilities.models.experimental === true
    return {
      id: `~service-${route!.providerId}`,
      label: routed!.unusable ? `${routed!.name} · ${routed!.unusable.words}` : nameWithHealth(routed!.name, health),
      gateway: { experimental: experimental && !routed!.unusable },
      ...(health ? { media: <HealthDot words={health} /> } : {}),
      ...serviceHint(harness, name, provider, computer, route),
      options: routed!.unusable ? own.map(option => ({ ...option, disabledReason: COPY.serviceFail(routed!.unusable!.words) })) : own,
    }
  }
  let placed = false
  for (const provider of catalog.providers) {
    if (provider.kind === 'demo') continue
    if (route && provider.id === route.providerId) {
      groups.push(routeGroup(provider))
      placed = true
      continue
    }
    // Without a Harness nothing can be forwarded; `unusableServices` says so.
    if (!harness || serviceReason(harness, provider) !== undefined) continue
    const pair = pairRoute(harness.capabilities, provider)
    const experimental = pair.kind === 'translate' || harness.capabilities.models.experimental === true
    const health = menuHealth(provider)
    const tile = <ProviderTile provider={provider} size={16} />
    const reason = locked(!route)
    groups.push({
      id: `~service-${provider.id}`,
      label: nameWithHealth(provider.name, health),
      gateway: { experimental },
      ...(health ? { media: <HealthDot words={health} /> } : {}),
      ...serviceHint(harness, name, provider, computer),
      options: serviceModels(provider).map(model => {
        const why = knows && !knows.has(modelIdKey(model)) ? COPY.unknownModel(name) : reason
        return {
          value: serviceValue({ providerId: provider.id, model }),
          label: model,
          media: tile,
          ...(why ? { disabledReason: why } : {}),
        }
      }),
    })
  }
  // A service the catalog no longer offers stays the session's, with why its next turn fails.
  if (route && !placed) groups.push(routeGroup(undefined))
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
  defaultModel !== undefined && value === defaultModel ? { tag: <Badge>{COPY.default}</Badge> } : {}
