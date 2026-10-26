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
import { harnessGate, harnessLevel, LOCAL_ONLY_HARNESS, type DeviceAccess } from './core/permissions.ts'
import { SETUP_COPY } from './core/securityCopy.ts'
import { heldBackService } from './core/providerSetup.ts'
import { storageGet, storageSet } from './preferences.ts'
import { projectOf } from './sessions.ts'

/** Without access information (older call sites, tests) every ready harness may be chosen. */
type StartAccess = Pick<DeviceAccess, 'legacy' | 'local'>
const openAccess: StartAccess = { legacy: true, local: false }

/** What a new session will run on. Fields beyond `mode` exist only when the Host sends a catalog. */
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

/**
 * One choice of what a new session runs on: a harness, and for a harness that offers both, how it works. The built-in
 * harness is two choices, 「Latch 内置」 working as an agent (the default) and 「只对话」, which reads and writes no files
 * and runs no commands; that is the whole of the 对话 / Agent choice.
 */
export interface HarnessEntry {
  key: string
  harness: HarnessInfo
  mode: TaskMode
  /** The harness's name. */
  label: string
  /** The line under the tile: the way of working, the full-access level, or why it cannot be chosen here. */
  note?: string
  /** What choosing it means, or why it cannot be chosen: the tooltip, read after the name. */
  description: string
  /** Why it cannot be chosen on this device now. */
  disabledReason?: string
  /** Full access: the agent decides what it runs; Latch does not ask per step. */
  fullAccess: boolean
}

export const entryKey = (harnessId: string, mode: TaskMode) => `${harnessId}\u0000${mode}`

const ENTRY_TEXT = {
  agent: { note: 'Agent', description: '可以读写项目里的文件、运行命令，有风险的操作先问你' },
  chat: { note: '只对话', description: '不读写文件、不运行命令' },
} as const

/**
 * Every harness the Host offers as choices, usable ones first and then those that cannot start here, each with why.
 * A harness that takes both ways of working is two entries, Agent first.
 */
export function harnessEntries(catalog: HostCatalog, access: StartAccess = openAccess, workspaceId?: string): HarnessEntry[] {
  const entries = catalog.harnesses.flatMap(harness => {
    const gate = harnessGate(harness, access)
    const fullAccess = !access.legacy && harnessLevel(harness) === 'L3'
    const unavailable = harness.status !== 'ready' ? harness.statusMessage || '暂不可用' : undefined
    const project = catalog.workspaces.find(item => item.id === workspaceId)
    const count = project?.folders?.length ?? 1
    const max = harness.projectFolders?.access === 'all' ? harness.projectFolders.max : undefined
    const folderReason = max !== undefined && count > max ? `这个项目有 ${count} 个文件夹，${harness.name} 最多使用 ${max} 个` : undefined
    const disabledReason = unavailable ?? (gate.allowed ? folderReason : gate.reason)
    const modes: TaskMode[] = harness.modes.length ? (['agent', 'chat'] as const).filter(mode => harness.modes.includes(mode)) : ['agent']
    const both = modes.length > 1
    return modes.map(mode => {
      const reason = mode === 'chat' ? (unavailable ?? (gate.allowed ? undefined : gate.reason)) : disabledReason
      const note = reason
        ? unavailable
          ? '不可用'
          : (gate.reason ?? LOCAL_ONLY_HARNESS)
        : both
          ? ENTRY_TEXT[mode].note
          : fullAccess
            ? '完全访问'
            : harness.source === 'plugin'
              ? '插件'
              : undefined
      const description = both
        ? ENTRY_TEXT[mode].description
        : (harness.description ?? (harness.models === 'agent' ? '自带模型与登录' : '使用执行端的模型服务'))
      return {
        key: entryKey(harness.id, mode),
        harness,
        mode,
        label: harnessName(harness),
        ...(note ? { note } : {}),
        description: fullAccess && !disabledReason ? `${description}。${SETUP_COPY.fullAccessDetail}` : description,
        ...(reason ? { disabledReason: reason } : {}),
        fullAccess,
      }
    })
  })
  return [...entries.filter(entry => !entry.disabledReason), ...entries.filter(entry => entry.disabledReason)]
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
  // Full-access harnesses that this device may not start are skipped like unavailable ones.
  const ready = (harness: HarnessInfo | undefined) =>
    harness?.status === 'ready' && harnessGate(harness, access).allowed ? harness : undefined
  const harness =
    ready(catalog.harnesses.find(item => item.id === stored?.harnessId))
    ?? ready(catalog.harnesses.find(item => item.id === catalog.defaults.harnessId))
    ?? catalog.harnesses.find(item => ready(item) !== undefined)
    ?? catalog.harnesses.find(item => item.id === catalog.defaults.harnessId)
    ?? catalog.harnesses[0]
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
  | { kind: 'harness-unavailable'; message: string }
  | { kind: 'model-required'; message: string; hint?: string; action?: string }

/** Why a new session cannot start with this choice, or null when it can. */
export function startBlock(snapshot: AppSnapshot, choice: ComposerChoice, access: StartAccess = openAccess): StartBlock | null {
  const catalog = snapshot.catalog
  if (!catalog) {
    if (snapshot.execution?.modelConfigurationRequired) return { kind: 'model-required', message: '需要先连接模型服务。' }
    if (snapshot.execution?.ready === false) return { kind: 'harness-unavailable', message: '当前模型接口不可用，请检查模型插件状态。' }
    return null
  }
  const harness = findHarness(catalog, choice.harnessId)
  if (!harness) return { kind: 'harness-unavailable', message: '执行端没有可用的 Harness。' }
  if (harness.status !== 'ready') return { kind: 'harness-unavailable', message: harness.statusMessage || `${harness.name} 暂不可用。` }
  if (!harnessGate(harness, access).allowed)
    return { kind: 'harness-unavailable', message: `${harness.name} 是完全访问（L3）Harness，只能在执行端电脑上用 Latch 桌面端开启。` }
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
      ? { kind: 'model-required', message: `${harness.name} 需要一个模型服务。${held.message}`, hint: held.hint, action: '打开模型服务' }
      : { kind: 'model-required', message: `${harness.name} 需要一个模型服务。` }
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
