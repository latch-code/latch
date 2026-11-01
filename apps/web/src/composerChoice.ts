import {
  AGENT_PRESETS,
  type AgentPreset,
  type AppSnapshot,
  type HarnessInfo,
  type HostCatalog,
  type ModelRef,
  type ProviderSummary,
  type TaskMode,
  type TaskSummary,
  type WorkspaceInfo,
} from '@latch/protocol'
import { harnessGate, harnessLevel, type DeviceAccess } from './core/permissions.ts'
import { heldBackService } from './core/providerSetup.ts'
import { REMOTE_PROJECT_REFUSED } from './core/securityCopy.ts'
import { storageGet, storageSet } from './preferences.ts'
import { projectOf } from './sessions.ts'

/** Without access information (older call sites, tests) every ready harness may be chosen. */
type StartAccess = Pick<DeviceAccess, 'legacy' | 'local'>
const openAccess: StartAccess = { legacy: true, local: false }

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
}

/** What the Host now calls its built-in harness; a Host from before the rename still says 「Standard Harness」. */
export const BUILTIN_HARNESS_NAME = 'Latch 内置'
/** A harness's name, with the built-in one named as a current Host names it even when an older Host serves this page. */
export const harnessName = (harness: Pick<HarnessInfo, 'id' | 'source' | 'name'>): string =>
  harness.source === 'builtin' && harness.id === 'standard' ? BUILTIN_HARNESS_NAME : harness.name

export const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) => a?.providerId === b?.providerId && a?.model === b?.model

export function findHarness(catalog: HostCatalog | undefined, id: string | undefined): HarnessInfo | undefined {
  return catalog?.harnesses.find(harness => harness.id === (id ?? catalog.defaults.harnessId))
}

/** One engine a new session can run on here. */
export interface EngineEntry {
  harness: HarnessInfo
  label: string
  /** What it can do, in the Harness menu. */
  line: string
  /** Why this project cannot use it, though it can start here. */
  disabledReason?: string
  /** Latch does not ask per step: starting it takes the confirmation on the Mac. */
  fullAccess: boolean
}

/** The one sentence about what the built-in engine cannot do. */
export const LATCH_ENGINE_LIMIT = `${BUILTIN_HARNESS_NAME}只能读写项目里的文件，不能运行命令。`

/** The Harness menu's sentence when this device can only start the built-in engine. */
export function otherHarnessesNote(catalog: HostCatalog, access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>): string | undefined {
  const usable = engineEntries(catalog, access)
  if (usable.some(entry => entry.harness.source !== 'builtin') || usable.length === 0) return undefined
  if (catalog.harnesses.some(harness => harness.source !== 'builtin' && harness.status === 'ready'))
    return '其他 Harness 只能在 Mac 上开始。'
  return access.local && access.admin ? undefined : '要运行命令，在 Mac 上的 Latch 里添加一个 Harness。'
}

/** Presets in their fixed order, then anything else; the built-in one last. `codex-2` ranks with `codex`. */
function harnessRank(harness: HarnessInfo): number {
  if (harness.source === 'builtin') return AGENT_PRESETS.length + 1
  const preset = AGENT_PRESETS.findIndex(item => item.id === harness.id.replace(/-\d+$/u, ''))
  return preset < 0 ? AGENT_PRESETS.length : preset
}

/**
 * The engines a new session can run on from this device, in a fixed order with the built-in one last. What is not
 * installed, or may only start on the Mac, is not offered: another device gets the built-in engine alone.
 */
export function engineEntries(catalog: HostCatalog, access: StartAccess = openAccess, workspaceId?: string): EngineEntry[] {
  const project = catalog.workspaces.find(item => item.id === workspaceId)
  const count = project?.folders?.length ?? 1
  return catalog.harnesses
    .filter(harness => harness.status === 'ready' && harnessGate(harness, access).allowed)
    .toSorted((a, b) => harnessRank(a) - harnessRank(b))
    .map(harness => {
      const max = harness.projectFolders?.access === 'all' ? harness.projectFolders.max : undefined
      return {
        harness,
        label: harnessName(harness),
        line: harness.source === 'builtin' ? '只能读写文件，不能运行命令' : (harness.statusMessage ?? '能读写这台 Mac 上的文件并运行命令'),
        fullAccess: !access.legacy && harnessLevel(harness) === 'L3',
        ...(max !== undefined && count > max ? { disabledReason: `这个项目有 ${count} 个文件夹，${harness.name} 最多使用 ${max} 个` } : {}),
      }
    })
}

/** Agent presets the Host knows that no added agent was made from yet. */
export function presetsToAdd(catalog: HostCatalog | undefined): AgentPreset[] {
  // The Host names an agent after its preset (codex, then codex-2, …); the catalog does not carry the preset itself.
  const added = new Set(
    (catalog?.harnesses ?? []).filter(harness => harness.source === 'acp').map(harness => harness.id.replace(/-\d+$/u, '')),
  )
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

function validModel(catalog: HostCatalog, ref: ModelRef | undefined): ModelRef | undefined {
  if (!ref) return
  const provider = findProvider(catalog, ref.providerId)
  return provider && (provider.models.length ? provider.models : [provider.defaultModel]).includes(ref.model) ? ref : undefined
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
export type DraftPick = Partial<Pick<ComposerChoice, 'harnessId' | 'model'>>

/**
 * Where every new session starts on the Host computer, when it set one. Other devices cannot see or take back a pin,
 * so each of them carries on from its own last choice.
 */
export function pinnedChoice(catalog: HostCatalog | undefined, access: StartAccess = openAccess): DraftPick | undefined {
  if (!catalog?.defaults.pinned || access.legacy || !access.local) return undefined
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
  access: StartAccess = openAccess,
): Partial<ComposerChoice> | null {
  const pin = pinnedChoice(catalog, access)
  return pin ? { ...memory, ...pin, ...pick } : memory
}

/** Whether the draft shows exactly the pinned start. An engine with its own models is the engine alone. */
export function isPinnedChoice(catalog: HostCatalog, harness: Pick<HarnessInfo, 'id' | 'models'>, model: ModelRef | undefined): boolean {
  const pinned = pinnedChoice(catalog, { legacy: false, local: true })
  if (pinned?.harnessId !== harness.id) return false
  return harness.models !== 'host' || (model !== undefined && pinned.model !== undefined && sameModel(model, pinned.model))
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

/** What 不选项目 will do for this Harness, where the Host has no folder set. */
export const noProjectLine = (harness: Pick<HarnessInfo, 'modes'> | undefined): string =>
  harness?.modes.includes('chat') ? '不读写文件，不运行命令' : '在一个新的空文件夹里开始'

/**
 * A remembered or partial choice, repaired against what the Host offers now: a
 * missing harness, removed workspace or model falls back to the Host defaults
 * instead of failing at submit time.
 */
export function resolveChoice(
  catalog: HostCatalog | undefined,
  stored: Partial<ComposerChoice> | null,
  access: StartAccess = openAccess,
): ComposerChoice {
  if (!catalog) return { mode: stored?.mode ?? 'agent' }
  const usable = engineEntries(catalog, access).map(entry => entry.harness)
  // This device's last engine, otherwise the first it can start. Nothing is asked: the first send says what will run.
  const harness = usable.find(item => item.id === stored?.harnessId) ?? usable[0]
  const workspaces = startableWorkspaces(catalog)
  const named =
    workspaces.find(item => item.id === stored?.workspaceId)
    ?? workspaces.find(item => item.id === catalog.defaults.workspaceId)
    ?? workspaces[0]
  // With the Host's own start directory, 'default' means no folder was picked yet, and a saved project is a better guess.
  const skipped = stored?.projectSkipped === true
  const workspace =
    named?.id === 'default' && !skipped && catalog.sessionFolders ? (workspaces.find(item => item.id !== 'default') ?? named) : named
  const model = harness?.models === 'host' ? (validModel(catalog, stored?.model) ?? defaultModel(catalog)) : undefined
  return {
    mode: startMode(catalog, harness, workspace?.id),
    ...(harness ? { harnessId: harness.id } : {}),
    ...(workspace ? { workspaceId: workspace.id } : {}),
    ...(model ? { model } : {}),
    ...(skipped && workspace?.id === 'default' ? { projectSkipped: true } : {}),
  }
}

/** A fork keeps the mode of its source, while the Harness it now names has that mode: an agent session's folder goes with it. */
export function forkedChoice(
  catalog: HostCatalog | undefined,
  start: Partial<ComposerChoice> | null,
  borrowed: Partial<ComposerChoice>,
  access: StartAccess = openAccess,
): ComposerChoice {
  const choice = resolveChoice(catalog, { ...start, ...borrowed }, access)
  const harness = findHarness(catalog, choice.harnessId)
  return borrowed.mode && harness?.modes.includes(borrowed.mode) ? { ...choice, mode: borrowed.mode } : choice
}

/**
 * Whether sending should ask for a folder first: a Harness works in one, and the Host has none in mind. A start directory
 * the owner set is a folder in mind; so is a fork. The built-in engine is fine without, as it reads and writes only what
 * it is given.
 */
export function needsProject(catalog: HostCatalog | undefined, choice: ComposerChoice): boolean {
  if (!catalog?.sessionFolders || choice.mode === 'chat' || choice.projectSkipped) return false
  if (choice.workspaceId !== undefined && choice.workspaceId !== 'default') return false
  const harness = catalog.harnesses.find(item => item.id === choice.harnessId)
  return harness !== undefined && harness.source !== 'builtin'
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
  return !engineEntries(catalog, access).some(entry => entry.harness.source !== 'builtin')
}

/**
 * `hint` and `action`: what the setup card says to do and its button, when a configured service is held back rather than
 * missing (its address is not confirmed, or it has no key), so the card does not ask for another service.
 */
export type StartBlock =
  | { kind: 'harness-unavailable'; message: string }
  | { kind: 'model-required'; message: string; hint?: string; action?: string; settable?: false }

/** Why a new session cannot start with this choice, or null when it can. */
export function startBlock(snapshot: AppSnapshot, choice: ComposerChoice, access: StartAccess = openAccess): StartBlock | null {
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
    const builtin = catalog.harnesses.find(item => item.source === 'builtin')
    return {
      kind: 'harness-unavailable',
      message: builtin?.status === 'unavailable' && builtin.statusMessage ? builtin.statusMessage : '没有可用的 Harness。',
    }
  }
  if (harness.status !== 'ready')
    return { kind: 'harness-unavailable', message: harness.statusMessage || `${harnessName(harness)} 暂不可用。` }
  if (!harnessGate(harness, access).allowed) return { kind: 'harness-unavailable', message: `${harnessName(harness)} 只能在 Mac 上开始。` }
  if (choice.mode !== 'chat') {
    const project = catalog.workspaces.find(item => item.id === choice.workspaceId)
    if (project?.unavailable) return { kind: 'harness-unavailable', message: project.unavailable }
    if (!access.local && !access.legacy && project?.remoteStart === false)
      return { kind: 'harness-unavailable', message: REMOTE_PROJECT_REFUSED }
    const count = project?.folders?.length ?? 1
    const max = harness.projectFolders?.access === 'all' ? harness.projectFolders.max : undefined
    if (max !== undefined && count > max)
      return { kind: 'harness-unavailable', message: `这个项目有 ${count} 个文件夹，${harness.name} 最多使用 ${max} 个。` }
  }
  if (harness.models === 'host' && !choice.model) {
    const held = heldBackService(catalog)
    return held
      ? { kind: 'model-required', message: `还没有可用的模型服务。${held.message}`, hint: held.hint, action: '打开模型服务' }
      : { kind: 'model-required', message: '还没有模型服务。' }
  }
  return null
}

/** Session harness; historical sessions without `harnessId` belong to the Host default. */
export function sessionHarness(catalog: HostCatalog | undefined, summary: TaskSummary | undefined): HarnessInfo | undefined {
  return findHarness(catalog, summary?.harnessId)
}

/**
 * Whether replies come from the built-in demo model: a harness on Host models whose
 * provider is a demo provider. Agents and real providers are never labelled demo,
 * even on a Host started in demo mode. Without a catalog the Host-wide flag decides.
 */
export function usesDemoModel(snapshot: AppSnapshot, harnessId: string | undefined, providerId: string | undefined): boolean {
  const catalog = snapshot.catalog
  if (!catalog) return snapshot.demo
  if (findHarness(catalog, harnessId)?.models !== 'host') return false
  return findProvider(catalog, providerId ?? catalog.defaults.model?.providerId)?.kind === 'demo'
}

export function sessionModel(summary: TaskSummary | undefined): ModelRef | undefined {
  return summary?.providerId && summary.model ? { providerId: summary.providerId, model: summary.model } : undefined
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
        ? { model: { providerId: model.providerId, model: model.model } }
        : {}),
      ...(item.projectSkipped === true ? { projectSkipped: true } : {}),
    }
  } catch {
    return null
  }
}

export function writeChoice(deviceId: string, choice: ComposerChoice): void {
  storageSet(choiceKey(deviceId), JSON.stringify(choice))
}
