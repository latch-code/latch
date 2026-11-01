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
import { storageGet, storageSet } from './preferences.ts'
import { projectOf } from './sessions.ts'

/** Without access information (older call sites, tests) every ready harness may be chosen. */
type StartAccess = Pick<DeviceAccess, 'legacy' | 'local'>
const openAccess: StartAccess = { legacy: true, local: false }

/**
 * What a new session will run on. Fields beyond `mode` exist only when the Host sends a catalog; `harnessId` is absent
 * while this device has yet to choose an engine.
 */
export interface ComposerChoice {
  mode: TaskMode
  harnessId?: string
  workspaceId?: string
  model?: ModelRef
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
  /** Why this project cannot use it, though it can start here. */
  disabledReason?: string
  /** Latch does not ask per step: starting it takes the confirmation on the Mac. */
  fullAccess: boolean
}

/** The one sentence about what the built-in engine cannot do. */
export const LATCH_ENGINE_LIMIT = `${BUILTIN_HARNESS_NAME}只能读写项目里的文件，不能运行命令。`

/**
 * What the new-session page says when this device can only start the built-in engine: what it cannot do and where the
 * way around that is. Nothing when another engine can start here, since the model control then names the difference.
 */
export function engineLimitNote(catalog: HostCatalog, access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>): string | undefined {
  const usable = engineEntries(catalog, access)
  if (usable.some(entry => entry.harness.source !== 'builtin') || usable.length === 0) return undefined
  if (catalog.harnesses.some(harness => harness.source !== 'builtin' && harness.status === 'ready'))
    return `${LATCH_ENGINE_LIMIT}其他引擎只能在 Mac 上开始。`
  return access.local && access.admin
    ? `${LATCH_ENGINE_LIMIT}要运行命令，在输入框的模型菜单里添加一个引擎。`
    : `${LATCH_ENGINE_LIMIT}要运行命令，在 Mac 上的 Latch 里添加一个引擎。`
}

/** Said before a full-access engine starts, however it came to be chosen: remembered, forked or just picked. */
export const fullAccessStartNote = (harness: Pick<HarnessInfo, 'name'>) =>
  `${harness.name} 由它自己决定权限，Latch 不限制它。开始时要在这台 Mac 上确认。`

const builtinFirst = (a: HarnessInfo, b: HarnessInfo) => Number(b.source === 'builtin') - Number(a.source === 'builtin')

/**
 * The engines a new session can run on from this device, in a fixed order with the built-in one first. What is not
 * installed, or may only start on the Mac, is not offered: another device gets the built-in engine alone.
 */
export function engineEntries(catalog: HostCatalog, access: StartAccess = openAccess, workspaceId?: string): EngineEntry[] {
  const project = catalog.workspaces.find(item => item.id === workspaceId)
  const count = project?.folders?.length ?? 1
  return catalog.harnesses
    .filter(harness => harness.status === 'ready' && harnessGate(harness, access).allowed)
    .toSorted(builtinFirst)
    .map(harness => {
      const max = harness.projectFolders?.access === 'all' ? harness.projectFolders.max : undefined
      return {
        harness,
        label: harnessName(harness),
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

/**
 * A remembered or partial choice, repaired against what the Host offers now: a
 * missing harness, unsupported mode, removed workspace or model falls back to
 * the Host defaults instead of failing at submit time.
 */
export function resolveChoice(
  catalog: HostCatalog | undefined,
  stored: Partial<ComposerChoice> | null,
  access: StartAccess = openAccess,
): ComposerChoice {
  if (!catalog) return { mode: stored?.mode ?? 'agent' }
  const usable = engineEntries(catalog, access).map(entry => entry.harness)
  // This device's last engine. With none, one engine that asks before each step needs no question; a full-access one
  // is never chosen for the person, and neither is one engine among several.
  const harness =
    usable.find(item => item.id === stored?.harnessId) ?? (usable.length === 1 && harnessLevel(usable[0]!) !== 'L3' ? usable[0] : undefined)
  const modes = harness?.modes.length ? harness.modes : (['chat', 'agent'] as TaskMode[])
  const mode =
    [stored?.mode, catalog.defaults.mode].find((item): item is TaskMode => item !== undefined && modes.includes(item)) ?? modes.at(-1)!
  const workspaces = startableWorkspaces(catalog)
  const workspace =
    workspaces.find(item => item.id === stored?.workspaceId)
    ?? workspaces.find(item => item.id === catalog.defaults.workspaceId)
    ?? workspaces[0]
  const model = harness?.models === 'host' ? (validModel(catalog, stored?.model) ?? defaultModel(catalog)) : undefined
  return {
    mode,
    ...(harness ? { harnessId: harness.id } : {}),
    ...(workspace ? { workspaceId: workspace.id } : {}),
    ...(model ? { model } : {}),
  }
}

/**
 * `hint` and `action`: what the setup card says to do and its button, when a configured service is held back rather than
 * missing (its address is not confirmed, or it has no key), so the card does not ask for another service.
 */
export type StartBlock =
  | { kind: 'engine-required'; message: string }
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
    // Only a choice not yet made is a question; an assistant whose engine is gone cannot be answered by picking one here.
    if (choice.harnessId === undefined && engineEntries(catalog, access).length > 0)
      return { kind: 'engine-required', message: '先选一个引擎。' }
    const builtin = catalog.harnesses.find(item => item.source === 'builtin')
    return {
      kind: 'harness-unavailable',
      message: builtin?.status === 'unavailable' && builtin.statusMessage ? builtin.statusMessage : '没有可用的引擎。',
    }
  }
  if (harness.status !== 'ready')
    return { kind: 'harness-unavailable', message: harness.statusMessage || `${harnessName(harness)} 暂不可用。` }
  if (!harnessGate(harness, access).allowed) return { kind: 'harness-unavailable', message: `${harnessName(harness)} 只能在 Mac 上开始。` }
  if (choice.mode !== 'chat') {
    const project = catalog.workspaces.find(item => item.id === choice.workspaceId)
    if (project?.unavailable) return { kind: 'harness-unavailable', message: project.unavailable }
    if (!access.local && !access.legacy && project?.remoteStart === false)
      return { kind: 'harness-unavailable', message: '其他设备不能在这个项目中发起会话。' }
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
    }
  } catch {
    return null
  }
}

export function writeChoice(deviceId: string, choice: ComposerChoice): void {
  storageSet(choiceKey(deviceId), JSON.stringify(choice))
}
