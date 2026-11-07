import type { HarnessInfo, HostCatalog, ModelRef, ModeTier, PermissionTier, SessionConfigOption, TaskDetail } from '@latch/protocol'
import { thinkingWord } from './composer/modelReasoning.ts'
import { TIER_ORDER } from './composer/permission.ts'
import {
  draftConfig,
  findHarness,
  harnessName,
  harnessPicks,
  offers,
  resolveChoice,
  servicePick,
  thinkingLevels,
  validModel,
  withServicePick,
  type ComposerChoice,
} from './composerChoice.ts'
import { MODE_COPY } from './core/securityCopy.ts'

/** One of the source's own options when it was forked: its ID there, the value and that value's name. */
interface SourcePick {
  id: string
  value: string
  name: string
}

/**
 * What the source session ran with when it was forked, for its draft to keep where the draft's Harness offers the same.
 * `service`: a model of a saved service, the built-in Harness's with its thinking level or the one Latch forwarded the
 * Harness's requests to. `mode.tier`: Latch's word for the mode, when it knows the mode.
 */
export interface ForkSource {
  harnessId: string
  service?: ModelRef
  model?: SourcePick
  thinking?: SourcePick
  mode?: SourcePick & { tier?: PermissionTier }
  /** The Harness moved the source's mode itself and Latch held it to none, so there is no row to keep. */
  modeDrifted?: true
}

function sourcePick(option: SessionConfigOption | undefined, value: string | undefined): SourcePick | undefined {
  if (!option || value === undefined) return undefined
  return { id: option.id, value, name: option.options.find(item => item.value === value)?.name ?? value }
}

const categoryOption = (config: readonly SessionConfigOption[] | undefined, category: string) =>
  config?.find(item => item.category === category)

function reported(config: readonly SessionConfigOption[] | undefined, category: string): SourcePick | undefined {
  const option = categoryOption(config, category)
  return sourcePick(option, option?.currentValue)
}

export function forkSource(detail: TaskDetail, harness: Pick<HarnessInfo, 'permission'> | undefined): ForkSource {
  const { summary } = detail
  const route = summary.modelRoute
  const builtin = summary.providerId !== undefined && summary.model !== undefined
  const service = builtin
    ? { providerId: summary.providerId!, model: summary.model!, ...(summary.effort ? { effort: summary.effort } : {}) }
    : route && { providerId: route.providerId, model: route.model }
  const model = builtin ? undefined : reported(detail.config, 'model')
  const thinking = builtin ? undefined : reported(detail.config, 'thought_level')
  // A session that only chats has no mode, so it has no row to keep.
  const modeOption = summary.mode === 'chat' ? undefined : categoryOption(detail.config, 'mode')
  // The mode Latch holds the session to is the one the person chose; the reported one can be a mode the agent moved
  // into by itself, or one Latch could not confirm.
  const drifted = summary.permissionDrift === true || detail.permission?.drift !== undefined
  const mode = sourcePick(modeOption, detail.permission?.expectedMode ?? (drifted ? undefined : modeOption?.currentValue))
  const tier = mode && (detail.permission?.modeTiers ?? harness?.permission?.modeTiers)?.[mode.value]?.tier
  return {
    harnessId: summary.harnessId,
    ...(service ? { service } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(mode ? { mode: { ...mode, ...(tier ? { tier } : {}) } } : {}),
    ...(modeOption && !mode && drifted ? { modeDrifted: true as const } : {}),
  }
}

/** The row for a tier: the same tier, else the widest stricter one, else the strictest there is. */
function tierRow(
  option: SessionConfigOption,
  tiers: Readonly<Record<string, ModeTier>>,
  tier: PermissionTier,
): { value: string; tier: PermissionTier } | undefined {
  const rows = option.options.flatMap(item => {
    const known = tiers[item.value]?.tier
    return known ? [{ value: item.value, tier: known }] : []
  })
  const stricter = rows.filter(row => TIER_ORDER[row.tier] <= TIER_ORDER[tier])
  if (stricter.length) return stricter.reduce((found, row) => (TIER_ORDER[row.tier] > TIER_ORDER[found.tier] ? row : found))
  return rows.length ? rows.reduce((found, row) => (TIER_ORDER[row.tier] < TIER_ORDER[found.tier] ? row : found)) : undefined
}

interface Carried {
  config?: Record<string, string>
  model?: ModelRef
  /** The source's model and thinking level where the draft could not take them. */
  lost: string[]
  /** What the draft can take only once the Harness's options are read: until then nothing is known of them. */
  pending?: string[]
  /** What the draft says when it could not keep the source's row as it was. */
  permission?: { optionId: string; line: string }
}

/** The source's model, thinking level and mode onto a draft that resolved to `base`. */
function carry(catalog: HostCatalog, base: ComposerChoice, source: ForkSource): Carried {
  const harness = base.harnessId === undefined ? undefined : findHarness(catalog, base.harnessId)
  if (!harness) return { config: base.config, model: base.model, lost: [] }
  const same = harness.id === source.harnessId
  const lost: string[] = []
  const service = source.service && { providerId: source.service.providerId, model: source.service.model }
  const modelWords = source.service?.model ?? source.model?.name
  const thinkingValue = source.thinking?.value ?? source.service?.effort
  const thinkingWords = source.thinking?.name ?? (source.service?.effort ? thinkingWord(source.service.effort) : undefined)
  if (harness.capabilities.models.owner === 'latch') {
    let model = service && validModel(catalog, service)
    if (!model && modelWords !== undefined) lost.push(`模型「${modelWords}」`)
    model ??= base.model
    if (thinkingValue !== undefined) {
      if (model && thinkingLevels(catalog, model).includes(thinkingValue)) model = { ...model, effort: thinkingValue }
      else lost.push(`思考「${thinkingWords}」`)
    }
    return { config: base.config, ...(model ? { model } : {}), lost }
  }
  let config: Record<string, string> = { ...base.config }
  const unread = draftConfig(harness, config) === undefined
  const pending: string[] = []
  // The same Harness names its options as the source did; another one is matched by what each option is.
  const find = (category: string, pick: SourcePick | undefined) => {
    const shown = draftConfig(harness, config)?.config ?? []
    return (same && pick && shown.find(option => option.id === pick.id)) || shown.find(option => option.category === category)
  }
  const modelOption = find('model', source.model)
  const routed = service !== undefined && servicePick(catalog, harness, withServicePick(config, service, modelOption?.id)) !== undefined
  if (routed) config = withServicePick(config, service, modelOption?.id)!
  else if (source.model && modelOption && offers(modelOption, source.model.value))
    config = { ...withServicePick(config, undefined), [modelOption.id]: source.model.value }
  else if (unread && source.model) pending.push(`模型「${modelWords}」`)
  else if (modelWords !== undefined) lost.push(`模型「${modelWords}」`)
  if (thinkingValue !== undefined) {
    // On a service's model the Harness says which levels it has only once it starts.
    const option = routed ? undefined : find('thought_level', source.thinking)
    if (option && offers(option, thinkingValue)) config[option.id] = thinkingValue
    else if (unread && !routed) pending.push(`思考「${thinkingWords}」`)
    else lost.push(`思考「${thinkingWords}」`)
  }
  let permission: Carried['permission']
  const from = source.mode
  const was = from && (from.tier ? MODE_COPY.tierTitles[from.tier] : from.name)
  const rows = base.mode !== 'chat' && harness.level === 'L3'
  if (rows && unread && was !== undefined) pending.push(`权限「${was}」`)
  const option = rows ? find('mode', from) : undefined
  if (option) {
    const exact = same && from && offers(option, from.value) ? from.value : undefined
    const tiers = harness.permission?.modeTiers
    const row = exact === undefined && from?.tier && tiers ? tierRow(option, tiers, from.tier) : undefined
    const name = harnessName(harness)
    if (exact !== undefined) config[option.id] = exact
    else if (row) {
      config[option.id] = row.value
      if (row.tier !== from!.tier)
        permission = {
          optionId: option.id,
          line: MODE_COPY.forkOtherRow(was!, name, MODE_COPY.tierTitles[row.tier], TIER_ORDER[row.tier] < TIER_ORDER[from!.tier!]),
        }
    } else {
      // A source with no row of its own, or one this Harness has no word for, starts where a new session does.
      delete config[option.id]
      if (was !== undefined) permission = { optionId: option.id, line: MODE_COPY.forkNoRow(was, name) }
      else if (source.modeDrifted) permission = { optionId: option.id, line: MODE_COPY.forkDrifted(name) }
    }
  }
  return { config, lost, ...(pending.length ? { pending } : {}), ...(permission ? { permission } : {}) }
}

const listed = (items: readonly string[]) => (items.length > 2 ? `${items.slice(0, -1).join('、')}与${items.at(-1)}` : items.join('与'))
/** What a fork's draft could not take from its source's model and thinking level. */
const lostLine = (items: readonly string[], harness: string) => `没有沿用来源会话的${listed(items)}：${harness} 在这里不能选。`
/** What it can take only once the Harness's options are read, whether that read is running, failed or not asked for. */
const pendingLine = (items: readonly string[], harness: string) => `来源会话的${listed(items)}要等读到 ${harness} 的选项后才能沿用。`

/** A fork's draft, and what it says it could not take from its source. */
export interface ForkedChoice {
  choice: ComposerChoice
  missed: string[]
}

/**
 * A fork's draft: the source's Harness, project and mode while the Harness has that mode, and the source's model,
 * thinking level and permission row where the Harness offers them, the row never wider than the source's. What the
 * person picks in the draft comes last. Without a source, the Harness's own picks on this device.
 */
export function forkedChoice(
  catalog: HostCatalog | undefined,
  start: Partial<ComposerChoice> | null,
  borrowed: Partial<ComposerChoice>,
  source?: ForkSource,
): ForkedChoice {
  const { config: picked, model: pickedModel, ...place } = borrowed
  const own = place.harnessId !== undefined && place.harnessId !== start?.harnessId ? harnessPicks(start ?? {}, place.harnessId) : {}
  const stored = { ...start, ...place, ...own }
  const withMode = (choice: ComposerChoice): ComposerChoice => {
    const harness = findHarness(catalog, choice.harnessId)
    return place.mode && harness?.modes.includes(place.mode) ? { ...choice, mode: place.mode } : choice
  }
  const base = withMode(resolveChoice(catalog, stored))
  if (!catalog || (!source && picked === undefined && pickedModel === undefined)) return { choice: base, missed: [] }
  const carried = source ? carry(catalog, base, source) : { config: base.config, model: base.model, lost: [] }
  const config = picked ?? carried.config
  const model = pickedModel ?? carried.model
  const choice = withMode(
    resolveChoice(catalog, {
      ...stored,
      ...(base.harnessId ? { harnessId: base.harnessId } : {}),
      config,
      model,
    }),
  )
  const harness = findHarness(catalog, choice.harnessId)
  const missed = carried.lost.length && harness ? [lostLine(carried.lost, harnessName(harness))] : []
  if (carried.pending && harness) missed.push(pendingLine(carried.pending, harnessName(harness)))
  const row = carried.permission
  // A row the person picked in the draft is theirs, and what the draft said about the source's no longer applies.
  if (row && (picked === undefined || picked[row.optionId] === carried.config?.[row.optionId])) missed.push(row.line)
  return { choice, missed }
}
