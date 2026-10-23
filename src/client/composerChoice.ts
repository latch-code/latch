import type {
  AppSnapshot,
  HarnessInfo,
  HostCatalog,
  ModelRef,
  ProviderSummary,
  TaskMode,
  TaskSummary,
  WorkspaceInfo,
} from '../shared/types.ts'
import { harnessGate, type DeviceAccess } from './permissions.ts'
import { storageGet, storageSet } from './preferences.ts'

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

export const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) => a?.providerId === b?.providerId && a?.model === b?.model

export function findHarness(catalog: HostCatalog | undefined, id: string | undefined): HarnessInfo | undefined {
  return catalog?.harnesses.find(harness => harness.id === (id ?? catalog.defaults.harnessId))
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

export type StartBlock = { kind: 'harness-unavailable'; message: string } | { kind: 'model-required'; message: string }

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
  if (harness.models === 'host' && !choice.model) return { kind: 'model-required', message: `${harness.name} 需要一个模型服务。` }
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

const choiceKey = (deviceId: string) => `harness-link.composer.${location.origin}.${deviceId}`

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
