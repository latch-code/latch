import {
  AGENT_PRESETS,
  LADDER_MODE,
  MODEL_EFFORT,
  pairRoute,
  type AgentPreset,
  type AppSnapshot,
  type HarnessCatalogue,
  type HarnessInfo,
  type HostCatalog,
  type ModelRef,
  type ProviderSummary,
  type SessionConfigOption,
  type TaskMode,
  type TaskSummary,
  type WorkspaceInfo,
} from '@latch/protocol'
import type { DeviceAccess } from './core/permissions.ts'
import { heldBackService } from './core/providerSetup.ts'
import { storageGet, storageSet } from './preferences.ts'
import { projectOf } from './sessions.ts'

/** A pin is this computer's own, so whether this page is on it decides whether a pin applies. */
type PinAccess = Pick<DeviceAccess, 'legacy' | 'local'>

/**
 * What a new session will run on. Fields beyond `mode` exist only when the Host sends a catalog; `harnessId` is absent
 * only when nothing can start from this device. `projectSkipped`: 不选项目 was picked, as opposed to no project chosen yet.
 */
export interface ComposerChoice {
  mode: TaskMode
  harnessId?: string
  workspaceId?: string
  model?: ModelRef
  projectSkipped?: boolean
  /** Picks from the Harness's own options (`HarnessInfo.catalogue`), by option ID; each one it still offers. */
  config?: Record<string, string>
  /** The picks last made for other Harnesses, by Harness ID: each is that Harness's start again once it is chosen. */
  otherPicks?: Record<string, Record<string, string>>
}

/** Another Harness is chosen: the picks made for this one are kept, and that one's own come back. */
export function harnessPicks(
  choice: Pick<ComposerChoice, 'harnessId' | 'config' | 'otherPicks'>,
  harnessId: string,
): Pick<ComposerChoice, 'config' | 'otherPicks'> {
  const others = { ...choice.otherPicks, ...(choice.harnessId && choice.config ? { [choice.harnessId]: choice.config } : {}) }
  const { [harnessId]: own, ...rest } = others
  return { config: own, otherPicks: Object.keys(rest).length ? rest : undefined }
}

/** What a draft shows of a Harness's own options: the list its last session offered, with this draft's picks in it. */
export interface DraftConfig {
  config: SessionConfigOption[]
  /** The picked model is not the one thinking was reported for, so its levels are known only once it starts. */
  thinkingUnknown: boolean
  reportedAt: string
  source: HarnessCatalogue['source']
}

/** Words beside a model ID a person typed, in every list that shows one. */
export const TYPED_MODEL = '自己填写'

/** The model option with the IDs a person typed for this Harness after what it lists. */
export function withTypedModels(config: readonly SessionConfigOption[], typed: readonly string[] | undefined): SessionConfigOption[] {
  if (!typed?.length) return [...config]
  return config.map(option => {
    if (option.category !== 'model') return option
    const extra = typed.filter(model => !option.options.some(item => item.value === model))
    return extra.length
      ? { ...option, options: [...option.options, ...extra.map(model => ({ value: model, name: model, description: TYPED_MODEL }))] }
      : option
  })
}

const followsModel = (option: SessionConfigOption) => option.category === 'thought_level' || option.category === 'model_config'
export const offers = (option: SessionConfigOption | undefined, value: string | undefined) =>
  value !== undefined && option?.options.some(item => item.value === value) === true

/**
 * The draft's options as a session lists them. The model goes first, since what else is offered can follow it: for a
 * model other than the default, the options a session on that model reported, or none when no session ran on it yet.
 */
export function draftConfig(
  harness: Pick<HarnessInfo, 'catalogue' | 'customModels'> | undefined,
  picks: Record<string, string> | undefined,
): DraftConfig | undefined {
  const catalogue = harness?.catalogue
  if (!catalogue?.options.length) return undefined
  const listed = withTypedModels(catalogue.options, harness?.customModels)
  const modelOption = listed.find(option => option.category === 'model')
  const model = modelOption && offers(modelOption, picks?.[modelOption.id]) ? picks![modelOption.id]! : modelOption?.currentValue
  const other = modelOption !== undefined && model !== modelOption.currentValue
  const reported = other ? catalogue.perModel.find(entry => entry.model === model)?.options : undefined
  const options = listed.flatMap(option => {
    if (option === modelOption) return [{ ...option, currentValue: model! }]
    if (other && followsModel(option)) return []
    return [option]
  })
  const config = [...options, ...(reported ?? [])].map(option =>
    offers(option, picks?.[option.id]) ? { ...option, currentValue: picks![option.id]! } : structuredClone(option),
  )
  return {
    config,
    // A session or read on that model said what it offers, thinking or none.
    thinkingUnknown: other && reported === undefined,
    reportedAt: catalogue.reportedAt,
    source: catalogue.source,
  }
}

/**
 * The modes Latch knows a Harness has, as a draft offers them before anything it reported has a mode: a list it read
 * without one, or none at all. The pick is kept as `LADDER_MODE`; the start sets it as whatever mode the agent reports.
 */
export function ladderMode(
  harness: Pick<HarnessInfo, 'permission'> | undefined,
  picks: Record<string, string> | undefined,
): SessionConfigOption | undefined {
  const declared = harness?.permission
  const modes = declared?.modes
  if (!modes?.length || !declared?.startMode) return undefined
  const picked = picks?.[LADDER_MODE]
  return {
    id: LADDER_MODE,
    name: '权限',
    category: 'mode',
    currentValue: picked !== undefined && modes.includes(picked) ? picked : declared.startMode,
    options: modes.map(value => ({ value, name: value })),
  }
}

/** The draft's options with the declared modes when what it knows has none. */
export function withLadderMode(
  harness: Pick<HarnessInfo, 'permission'> | undefined,
  config: readonly SessionConfigOption[] | undefined,
  picks: Record<string, string> | undefined,
): SessionConfigOption[] | undefined {
  const reported = config?.find(option => option.category === 'mode')
  if (reported) {
    const early = picks?.[LADDER_MODE]
    return config!.map(option =>
      option === reported && !offers(option, picks?.[option.id]) && offers(option, early) ? { ...option, currentValue: early! } : option,
    )
  }
  const ladder = ladderMode(harness, picks)
  return ladder ? [...(config ?? []), ladder] : config && [...config]
}

/** The picks a start carries: only what the person chose, and only what the list still offers. */
export function startConfig(
  harness: Pick<HarnessInfo, 'catalogue' | 'customModels' | 'permission'> | undefined,
  picks: Record<string, string> | undefined,
) {
  const shown = withLadderMode(harness, draftConfig(harness, picks)?.config, picks) ?? []
  const mode = shown.find(option => option.category === 'mode')
  return Object.entries(picks ?? {}).flatMap(([configId, value]) => {
    if (configId === LADDER_MODE && mode?.id !== LADDER_MODE) {
      // A catalogue arriving after a choice must not replace it with the Harness's default.
      if (mode && offers(mode, picks?.[mode.id])) return []
      return offers(ladderMode(harness, picks), value) ? [{ configId, value }] : []
    }
    return offers(
      shown.find(option => option.id === configId),
      value,
    )
      ? [{ configId, value }]
      : []
  })
}

export const harnessName = (harness: Pick<HarnessInfo, 'capabilities'>): string => harness.capabilities.display.label

/**
 * A draft's pick of a model from a saved service instead of the Harness's own, kept among its picks so that it is that
 * Harness's alone. Never an option an agent offers: agents' option IDs do not start with `~`.
 */
const SERVICE_PICK = '~service'
/** In the same place: the person chose the Harness's own default model, which no service model, a project's 默认模型 included, replaces. */
const OWN_DEFAULT = '~own'

/** Whether the picks say the Harness's own default model was chosen. */
export const pickedOwnDefault = (picks: Record<string, string> | undefined): boolean => picks?.[SERVICE_PICK] === OWN_DEFAULT

/** The picks with the Harness's own default chosen: no service model, and none of its own models either. */
export function withOwnDefault(picks: Record<string, string> | undefined, modelOptionId?: string): Record<string, string> {
  const { [SERVICE_PICK]: _service, ...rest } = picks ?? {}
  if (modelOptionId) delete rest[modelOptionId]
  return { ...rest, [SERVICE_PICK]: OWN_DEFAULT }
}

/** The models a service offers a session: its list, else its default. */
export const serviceModels = (provider: Pick<ProviderSummary, 'models' | 'defaultModel'>): string[] =>
  provider.models.length ? provider.models : [provider.defaultModel]

/** The service model a draft picked for a Harness with its own models, while Latch can still forward that pair. */
export function servicePick(
  catalog: HostCatalog | undefined,
  harness: Pick<HarnessInfo, 'capabilities'> | undefined,
  picks: Record<string, string> | undefined,
): ModelRef | undefined {
  const value = picks?.[SERVICE_PICK]
  if (!value || !harness || harness.capabilities.models.owner === 'latch') return undefined
  const [providerId = '', model = ''] = value.split('\u0000')
  const provider = findProvider(catalog, providerId)
  if (!provider) return undefined
  const route = pairRoute(harness.capabilities, provider)
  if (route.kind !== 'passthrough' && route.kind !== 'translate') return undefined
  return serviceModels(provider).includes(model) ? { providerId, model } : undefined
}

/**
 * The Harness whose own login a draft depends on: none once a model of a service is picked, since those requests go
 * through Latch with the service's key and the Harness's login is not used.
 */
export function loginHarness<T extends Pick<HarnessInfo, 'capabilities' | 'status'>>(
  catalog: HostCatalog | undefined,
  harness: T | undefined,
  picks: Record<string, string> | undefined,
): T | undefined {
  return harness?.status === 'ready' && !servicePick(catalog, harness, picks) ? harness : undefined
}

/** The picks with `model` as the service pick, or without one; the Harness's own model pick goes with a service pick. */
export function withServicePick(
  picks: Record<string, string> | undefined,
  model: ModelRef | undefined,
  modelOptionId?: string,
): Record<string, string> | undefined {
  const { [SERVICE_PICK]: _service, ...rest } = picks ?? {}
  if (model && modelOptionId) delete rest[modelOptionId]
  const next = model ? { ...rest, [SERVICE_PICK]: `${model.providerId}\u0000${model.model}` } : rest
  return Object.keys(next).length ? next : undefined
}

/** The Harness Latch itself enforces: it has a row of its own in settings. Only the Host can make this true of one. */
export const builtinHarness = (catalog: HostCatalog | undefined): HarnessInfo | undefined =>
  catalog?.harnesses.find(harness => harness.capabilities.permission.enforcement === 'latch')

/** The same model with the same thinking level: a different level is a switch like a different model. */
export const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) =>
  a?.providerId === b?.providerId && a?.model === b?.model && a?.effort === b?.effort

/** The thinking levels the owner declared for a model of a service; none when nothing was declared. */
export function thinkingLevels(catalog: HostCatalog, model: ModelRef | undefined): readonly string[] {
  return (model && findProvider(catalog, model.providerId)?.modelCapabilities?.[model.model]?.thinking) ?? []
}

/** Another model keeps the thinking level when it declares that level too; otherwise it starts on its own default. */
export function switchModel(catalog: HostCatalog, from: ModelRef | undefined, to: Omit<ModelRef, 'effort'>): ModelRef {
  const effort = from?.effort
  return effort && thinkingLevels(catalog, to).includes(effort) ? { ...to, effort } : { providerId: to.providerId, model: to.model }
}

export function findHarness(catalog: HostCatalog | undefined, id: string | undefined): HarnessInfo | undefined {
  return catalog?.harnesses.find(harness => harness.id === (id ?? catalog.defaults.harnessId))
}

/** One engine a new session can run on here. */
export interface EngineEntry {
  harness: HarnessInfo
  label: string
  /** What it can do, in the Harness menu. */
  line: string
  /** Why it cannot be picked: this project has more folders than it uses, or its command needs an upgrade. */
  disabledReason?: string
}

/** Its command is known to be too old: listed greyed with 需要升级, never picked anew. */
export const needsUpgrade = (harness: Pick<HarnessInfo, 'status' | 'statusReason'>): boolean =>
  harness.status === 'unavailable' && harness.statusReason === 'outdated'

/** Presets in their fixed order, then anything else; what cannot run commands last. */
function harnessRank(harness: HarnessInfo): number {
  if (!harness.capabilities.tools.shell) return AGENT_PRESETS.length + 1
  const preset = AGENT_PRESETS.findIndex(item => item.id === harness.capabilities.display.mark)
  return preset < 0 ? AGENT_PRESETS.length : preset
}

/**
 * The engines a new session can run on, in a fixed order with the built-in one last. What is not installed is not
 * offered; one whose command is too old is listed greyed with 需要升级, so a draft that chose it keeps it.
 */
export function engineEntries(catalog: HostCatalog, workspaceId?: string): EngineEntry[] {
  const project = catalog.workspaces.find(item => item.id === workspaceId)
  const count = project?.folders?.length ?? 1
  return catalog.harnesses
    .filter(harness => harness.status === 'ready' || needsUpgrade(harness))
    .toSorted((a, b) => harnessRank(a) - harnessRank(b))
    .map(harness => {
      if (needsUpgrade(harness)) return { harness, label: harnessName(harness), line: '', disabledReason: '需要升级' }
      const max = harness.projectFolders?.access === 'all' ? harness.projectFolders.max : undefined
      return {
        harness,
        label: harnessName(harness),
        line: harness.capabilities.tools.shell ? (harness.statusMessage ?? '读写文件、运行命令') : '只读写文件，不运行命令',
        ...(max !== undefined && count > max ? { disabledReason: `最多 ${max} 个文件夹，这个项目有 ${count} 个` } : {}),
      }
    })
}

/** Agent presets the Host knows that no added agent was made from yet. */
export function presetsToAdd(catalog: HostCatalog | undefined): AgentPreset[] {
  const added = new Set((catalog?.harnesses ?? []).map(harness => harness.capabilities.display.mark))
  return AGENT_PRESETS.filter(preset => !added.has(preset.id))
}

/** The saved project a new session opened from `task` starts in: the one the task ran in, when it can still start. */
export function projectFor(catalog: HostCatalog | undefined, task: TaskSummary | undefined): string | undefined {
  if (!catalog || !task) return undefined
  const saved = projectOf(task, catalog.workspaces)
  const start = catalog.workspaces.find(project => project.id === 'default')
  const legacyStart =
    task.workspaceId === undefined && (task.cwd === undefined || task.cwd === start?.path || task.cwd.startsWith(`${start?.path}/`))
  const project = saved ?? (task.workspaceId === 'default' || legacyStart ? start : undefined)
  return project && project.unavailable === undefined ? project.id : undefined
}

export function findProvider(catalog: HostCatalog | undefined, id: string | undefined): ProviderSummary | undefined {
  return id === undefined ? undefined : catalog?.providers.find(provider => provider.id === id)
}

export function validModel(catalog: HostCatalog, ref: ModelRef | undefined): ModelRef | undefined {
  if (!ref) return
  const provider = findProvider(catalog, ref.providerId)
  if (!provider || !(provider.models.length ? provider.models : [provider.defaultModel]).includes(ref.model)) return undefined
  // A level the owner has since taken away falls back to the model's default rather than failing the send.
  return ref.effort && !thinkingLevels(catalog, ref).includes(ref.effort) ? { providerId: ref.providerId, model: ref.model } : ref
}

/** Saved workspaces a new session may use; one the Host disabled for this run shows only in settings. */
export function startableWorkspaces(catalog: HostCatalog): WorkspaceInfo[] {
  return catalog.workspaces.filter(workspace => workspace.unavailable === undefined)
}

/** The first configured model, preferring the Host default. */
export function defaultModel(catalog: HostCatalog): ModelRef | undefined {
  const preferred = validModel(catalog, catalog.defaults.model)
  if (preferred) return preferred
  const provider = catalog.providers.find(item => item.defaultModel || item.models.length)
  return provider ? { providerId: provider.id, model: provider.defaultModel || provider.models[0]! } : undefined
}

/** The engine and model a pick in a draft can change. */
export type DraftPick = Partial<Pick<ComposerChoice, 'harnessId' | 'model' | 'config'>>

/**
 * Where every new session starts on the Host computer, when it set one. Other devices cannot see or take back a pin,
 * so each of them carries on from its own last choice.
 */
export function pinnedChoice(catalog: HostCatalog | undefined, access?: PinAccess): DraftPick | undefined {
  if (!catalog?.defaults.pinned || !access || access.legacy || !access.local) return undefined
  return { harnessId: catalog.defaults.harnessId, ...(catalog.defaults.model ? { model: catalog.defaults.model } : {}) }
}

/**
 * What a draft resolves from. A pin stands in for what the device remembers, and a pick in the draft stands in for the pin
 * until the session starts; that pick is never remembered, so a reload or the next draft is back at the pin.
 */
export function draftStart(
  catalog: HostCatalog | undefined,
  memory: Partial<ComposerChoice> | null,
  pick: DraftPick | null,
  access?: PinAccess,
): Partial<ComposerChoice> | null {
  const pin = pinnedChoice(catalog, access)
  let base = pin ? { ...memory, ...pin } : memory
  const gateway = catalog?.defaults.gateway
  if (pin?.harnessId && gateway !== undefined && !pick?.config && (pick?.harnessId === undefined || pick.harnessId === pin.harnessId)) {
    const harness = findHarness(catalog, pin.harnessId)
    const config = memory?.harnessId === pin.harnessId ? memory?.config : memory?.otherPicks?.[pin.harnessId]
    const modelOption = harness && draftConfig(harness, config)?.config.find(option => option.category === 'model')
    const source = gateway ? withServicePick(config, gateway, modelOption?.id) : withOwnDefault(config, modelOption?.id)
    base = { ...base, ...(source ? { config: source } : {}) }
  }
  const project = projectStart(catalog, base, pick)
  return pin || project || pick ? { ...base, ...project, ...pick } : memory
}

/**
 * The project's 默认模型 for the draft `stored` resolves to, while that model can be used now. It stands in only where
 * nothing was picked: a model this device picked, on Latch 内置 or for a Harness with its own models, is remembered and
 * comes first, as it did before projects had a default.
 */
export function projectDefault(catalog: HostCatalog | undefined, stored: Partial<ComposerChoice> | null): ModelRef | undefined {
  if (!catalog) return undefined
  const { workspaceId } = resolveChoice(catalog, stored)
  return validModel(catalog, catalog.workspaces.find(workspace => workspace.id === workspaceId)?.defaultModel)
}

function projectStart(
  catalog: HostCatalog | undefined,
  base: Partial<ComposerChoice> | null,
  pick: DraftPick | null,
): Partial<ComposerChoice> | undefined {
  const model = pick?.model ? undefined : projectDefault(catalog, base)
  if (!catalog || !model) return undefined
  const resolved = resolveChoice(catalog, { ...base, ...pick })
  const harness = findHarness(catalog, resolved.harnessId)
  if (!harness) return undefined
  // Latch 内置: only a device that has no model of its own yet.
  if (harness.capabilities.models.owner === 'latch') return validModel(catalog, base?.model) ? undefined : { model }
  // A Harness with its own models: only while nothing was picked for it, and Latch can forward the pair.
  const modelOption = draftConfig(harness, resolved.config)?.config.find(option => option.category === 'model')
  if (
    pickedOwnDefault(resolved.config)
    || servicePick(catalog, harness, resolved.config)
    || (modelOption && resolved.config?.[modelOption.id] !== undefined)
  )
    return undefined
  const config = withServicePick(resolved.config, { providerId: model.providerId, model: model.model }, modelOption?.id)
  return servicePick(catalog, harness, config) ? { harnessId: harness.id, config: config! } : undefined
}

/** Whether the draft shows exactly the pinned start. An engine with its own models is the engine alone. */
export function isPinnedChoice(
  catalog: HostCatalog,
  harness: Pick<HarnessInfo, 'id' | 'capabilities'>,
  model: ModelRef | undefined,
): boolean {
  const pinned = pinnedChoice(catalog, { legacy: false, local: true })
  if (pinned?.harnessId !== harness.id) return false
  return (
    harness.capabilities.models.owner !== 'latch' || (model !== undefined && pinned.model !== undefined && sameModel(model, pinned.model))
  )
}

/**
 * The mode follows from where the session runs, and nobody picks it. With no project and no folder the owner set, a
 * harness that can chat does: Latch 内置 cannot run commands, so a new empty folder would give it nothing to work on.
 * One that cannot chat gets that folder from the Host.
 */
function startMode(catalog: HostCatalog, harness: HarnessInfo | undefined, workspaceId: string | undefined): TaskMode {
  const modes = harness?.modes.length ? harness.modes : (['chat', 'agent'] as TaskMode[])
  const noFolder = catalog.sessionFolders === true && (workspaceId ?? 'default') === 'default'
  if (noFolder && modes.includes('chat')) return 'chat'
  return modes.includes('agent') ? 'agent' : modes[0]!
}

/**
 * What 不选项目 will do for this Harness, where the Host has no folder set: one kind of sentence for both kinds, the
 * Harness and what it does.
 */
export function noProjectLine(harness: Pick<HarnessInfo, 'modes' | 'capabilities'> | undefined): string {
  if (!harness) return '在一个新的空文件夹里开始'
  return harness.modes.includes('chat')
    ? `${harnessName(harness)} 只回复文字，不读写文件`
    : `${harnessName(harness)} 在一个新的空文件夹里开始`
}

/**
 * A remembered or partial choice, repaired against what the Host offers now: a
 * missing harness, removed workspace or model falls back to the Host defaults
 * instead of failing at submit time.
 */
export function resolveChoice(catalog: HostCatalog | undefined, stored: Partial<ComposerChoice> | null): ComposerChoice {
  if (!catalog) return { mode: stored?.mode ?? 'agent' }
  const entries = engineEntries(catalog)
  const usable = entries.filter(entry => entry.harness.status === 'ready').map(entry => entry.harness)
  // This device's last engine, otherwise the first it can start. Nothing is asked: the first send says what will run. One
  // found too old after it was chosen stays chosen: the person picked it, and the input says what to upgrade.
  const harness = entries.find(entry => entry.harness.id === stored?.harnessId)?.harness ?? usable[0]
  const workspaces = startableWorkspaces(catalog)
  const named =
    workspaces.find(item => item.id === stored?.workspaceId)
    ?? workspaces.find(item => item.id === catalog.defaults.workspaceId)
    ?? workspaces[0]
  // With the Host's own start directory, 'default' means no folder was picked yet, and a saved project is a better guess.
  const skipped = stored?.projectSkipped === true
  const workspace =
    named?.id === 'default' && !skipped && catalog.sessionFolders ? (workspaces.find(item => item.id !== 'default') ?? named) : named
  const model = harness?.capabilities.models.owner === 'latch' ? (validModel(catalog, stored?.model) ?? defaultModel(catalog)) : undefined
  // Picks belong to the Harness they were made for, and only what it still offers stays picked.
  const own = harness && (harness.id === stored?.harnessId ? stored?.config : stored?.otherPicks?.[harness.id])
  const service = servicePick(catalog, harness, own)
  const picks = harness ? startConfig(harness, own) : []
  // Chosen, not merely absent: it stays through a repair of the picks, as a service pick does.
  const ownDefault = !service && harness?.capabilities.models.owner !== 'latch' && pickedOwnDefault(own)
  // A remembered Harness that cannot start now keeps its picks for when it can.
  const away = stored?.harnessId && stored.harnessId !== harness?.id && stored.config ? { [stored.harnessId]: stored.config } : {}
  const others = Object.entries({ ...stored?.otherPicks, ...away }).filter(([id]) => id !== harness?.id)
  return {
    mode: startMode(catalog, harness, workspace?.id),
    ...(harness ? { harnessId: harness.id } : {}),
    ...(workspace ? { workspaceId: workspace.id } : {}),
    ...(model ? { model } : {}),
    ...(picks.length || service || ownDefault
      ? {
          config: ownDefault
            ? withOwnDefault(Object.fromEntries(picks.map(pick => [pick.configId, pick.value])))
            : withServicePick(Object.fromEntries(picks.map(pick => [pick.configId, pick.value])), service)!,
        }
      : {}),
    ...(others.length ? { otherPicks: Object.fromEntries(others) } : {}),
    ...(skipped && workspace?.id === 'default' ? { projectSkipped: true } : {}),
  }
}

/**
 * The project a new session could start in a new worktree of: a saved project with one folder whose Git branch the Host
 * read, for a session that reads and writes files and is not a fork (a fork starts where its source left off).
 */
export function worktreeProject(catalog: HostCatalog | undefined, choice: ComposerChoice, forking: boolean): WorkspaceInfo | undefined {
  if (!catalog || forking || choice.mode !== 'agent' || choice.workspaceId === undefined || choice.workspaceId === 'default') return
  const project = catalog.workspaces.find(item => item.id === choice.workspaceId)
  return project && !project.unavailable && project.branch !== undefined && (project.folders?.length ?? 1) === 1 ? project : undefined
}

/**
 * Nothing on this computer can run a session yet, so the page says what to install. Only where a definition can be saved
 * and a service added; a service that is saved but held back has its own way out.
 */
export function nothingInstalled(
  block: StartBlock | null,
  catalog: HostCatalog | undefined,
  access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>,
): boolean {
  if (block?.kind !== 'model-required' || block.action !== undefined || !catalog || access.legacy || !access.local || !access.admin)
    return false
  return !engineEntries(catalog).some(entry => entry.harness.status === 'ready' && entry.harness.capabilities.tools.shell)
}

/**
 * The first open on this Mac (J9): nothing records one, so it is this Mac's app with no session yet, where something
 * that runs commands was found. The page then lists what was found before the input. With nothing found the install
 * card (`nothingInstalled`) speaks instead; the two never show together.
 */
export function listsFoundHarnesses(
  catalog: HostCatalog | undefined,
  sessions: number,
  access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>,
): boolean {
  if (!catalog || sessions > 0 || access.legacy || !access.local || !access.admin) return false
  return engineEntries(catalog).some(entry => entry.harness.status === 'ready' && entry.harness.capabilities.tools.shell)
}

/**
 * `hint` and `action`: what the setup card says to do and its button, when a configured service is held back rather than
 * missing (its address is not confirmed, or it has no key), so the card does not ask for another service.
 */
export type StartBlock =
  | { kind: 'harness-unavailable'; message: string }
  | { kind: 'model-required'; message: string; hint?: string; action?: string; settable?: false }

/** Why a new session cannot start with this choice, or null when it can. */
export function startBlock(snapshot: AppSnapshot, choice: ComposerChoice): StartBlock | null {
  const catalog = snapshot.catalog
  if (!catalog) {
    // A Host from before the catalog has no model-service pages to send anyone to.
    if (snapshot.execution?.modelConfigurationRequired)
      return {
        kind: 'model-required',
        message: '这台 Mac 上的 Latch 较旧，不能在这里连接模型服务。',
        hint: '更新 Latch 并重新启动后再添加。',
        settable: false,
      }
    if (snapshot.execution?.ready === false) return { kind: 'harness-unavailable', message: '当前模型接口不可用，请检查模型插件状态。' }
    return null
  }
  const harness = catalog.harnesses.find(item => item.id === choice.harnessId)
  if (!harness) {
    const builtin = builtinHarness(catalog)
    return {
      kind: 'harness-unavailable',
      message: builtin?.status === 'unavailable' && builtin.statusMessage ? builtin.statusMessage : '没有可用的 Harness。',
    }
  }
  if (harness.status !== 'ready')
    return { kind: 'harness-unavailable', message: harness.statusMessage || `${harnessName(harness)} 暂不可用。` }
  if (choice.mode !== 'chat') {
    const project = catalog.workspaces.find(item => item.id === choice.workspaceId)
    if (project?.unavailable) return { kind: 'harness-unavailable', message: project.unavailable }
    const count = project?.folders?.length ?? 1
    const max = harness.projectFolders?.access === 'all' ? harness.projectFolders.max : undefined
    if (max !== undefined && count > max)
      return { kind: 'harness-unavailable', message: `这个项目有 ${count} 个文件夹，${harnessName(harness)} 最多使用 ${max} 个。` }
  }
  if (harness.capabilities.models.owner === 'latch' && !choice.model) {
    const held = heldBackService(catalog, snapshot.hostName)
    return held
      ? { kind: 'model-required', message: `还没有可用的模型服务。${held.message}`, hint: held.hint, action: '打开模型服务' }
      : { kind: 'model-required', message: '还没有模型服务。' }
  }
  if (
    catalog.defaults.gatewayUnavailable
    && catalog.defaults.harnessId === harness.id
    && !servicePick(catalog, harness, choice.config)
    && !pickedOwnDefault(choice.config)
    && !startConfig(harness, choice.config).some(pick =>
      harness.catalogue?.options.some(option => option.id === pick.configId && option.category === 'model'),
    )
  )
    return { kind: 'model-required', message: '原来选择的模型服务暂不可用。', action: '打开模型服务' }
  return null
}

export function sessionHarness(catalog: HostCatalog | undefined, summary: TaskSummary | undefined): HarnessInfo | undefined {
  return summary && catalog?.harnesses.find(harness => harness.id === summary.harnessId)
}

/**
 * Whether replies come from the built-in demo model: a harness on Host models whose
 * provider is a demo provider. Agents and real providers are never labelled demo,
 * even on a Host started in demo mode. Without a catalog the Host-wide flag decides.
 */
export function usesDemoModel(snapshot: AppSnapshot, harnessId: string | undefined, providerId: string | undefined): boolean {
  const catalog = snapshot.catalog
  if (!catalog) return snapshot.demo
  if (findHarness(catalog, harnessId)?.capabilities.models.owner !== 'latch') return false
  return findProvider(catalog, providerId ?? catalog.defaults.model?.providerId)?.kind === 'demo'
}

export function sessionModel(summary: TaskSummary | undefined): ModelRef | undefined {
  return summary?.providerId && summary.model
    ? { providerId: summary.providerId, model: summary.model, ...(summary.effort ? { effort: summary.effort } : {}) }
    : undefined
}

const choiceKey = (deviceId: string) => `latch.composer.${location.origin}.${deviceId}`

export function readChoice(deviceId: string): Partial<ComposerChoice> | null {
  try {
    const value: unknown = JSON.parse(storageGet(choiceKey(deviceId)) ?? 'null')
    if (typeof value !== 'object' || value === null) return null
    const item = value as Record<string, unknown>
    const model = item.model as Record<string, unknown> | undefined
    return {
      ...(item.mode === 'chat' || item.mode === 'agent' ? { mode: item.mode } : {}),
      ...(typeof item.harnessId === 'string' ? { harnessId: item.harnessId } : {}),
      ...(typeof item.workspaceId === 'string' ? { workspaceId: item.workspaceId } : {}),
      ...(model && typeof model.providerId === 'string' && typeof model.model === 'string'
        ? {
            model: {
              providerId: model.providerId,
              model: model.model,
              ...(typeof model.effort === 'string' && MODEL_EFFORT.test(model.effort) ? { effort: model.effort } : {}),
            },
          }
        : {}),
      ...(item.projectSkipped === true ? { projectSkipped: true } : {}),
      ...(configRecord(item.config) ? { config: configRecord(item.config)! } : {}),
      ...(otherPicks(item.otherPicks) ? { otherPicks: otherPicks(item.otherPicks)! } : {}),
    }
  } catch {
    return null
  }
}

/** Picks as stored: a few strings by option ID, nothing else. */
function configRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0].length <= 128 && entry[1].length <= 1024,
  )
  return entries.length && entries.length <= 16 ? Object.fromEntries(entries) : undefined
}

/** Other Harnesses' picks as stored: a few records by Harness ID. */
function otherPicks(value: unknown): Record<string, Record<string, string>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([id, picks]) => {
    const record = id.length <= 128 ? configRecord(picks) : undefined
    return record ? [[id, record] as const] : []
  })
  return entries.length && entries.length <= 16 ? Object.fromEntries(entries) : undefined
}

export function writeChoice(deviceId: string, choice: ComposerChoice): void {
  storageSet(choiceKey(deviceId), JSON.stringify(choice))
}
