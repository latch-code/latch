/** What an agent offered at the start of its sessions, kept per definition so a draft can choose before it starts one. */
import type { CatalogueRead, HarnessCatalogue, SessionConfigOption } from '@latch/protocol'
import { clip } from './mapping.ts'
import type { HarnessProfile } from './profiles/index.ts'
import type { AcpCatalogue, StartChoice } from './store.ts'

/** Every catalog the Host sends carries it, and a phone reads that catalog whole, so it stays small. */
const MAX_OPTIONS = 16
const MAX_VALUES = 200
const MAX_MODELS = 32
const MAX_DESCRIPTION = 200
/** A value longer than this is not one a person picks from a list; the session itself still offers it. */
const MAX_VALUE = 256
/** A phone refuses a whole snapshot over 1 MiB, and every Harness sends one of these in it. */
const MAX_BYTES = 64 * 1024
/** At most this many choices reach a start; there are never more options than that to choose. */
export const MAX_START_CHOICES = MAX_OPTIONS

/** When a draft reads the harness's lists, and whether that read reports its modes: Codex's model list does not. */
export function catalogueReadOf(profile: Pick<HarnessProfile, 'catalogueRead'> | undefined): Pick<CatalogueRead, 'when' | 'modes'> {
  const configured = profile?.catalogueRead
  if (configured && 'codexModels' in configured) return { when: 'select', modes: false }
  // A command without a profile was confirmed on this Mac as the program to run; its empty session runs no turn.
  return { when: configured?.when ?? 'select', modes: true }
}

/** The options that follow the model: the agent may offer other ones for another model. */
const followsModel = (option: SessionConfigOption) => option.category === 'thought_level' || option.category === 'model_config'

const bounded = (options: readonly SessionConfigOption[]): SessionConfigOption[] =>
  options.slice(0, MAX_OPTIONS).map(option => ({
    ...option,
    ...(option.description ? { description: clip(option.description, MAX_DESCRIPTION) } : {}),
    options: option.options
      .filter(value => value.value.length <= MAX_VALUE)
      .slice(0, MAX_VALUES)
      .map(value => ({
        value: value.value,
        name: value.name,
        ...(value.description ? { description: clip(value.description, MAX_DESCRIPTION) } : {}),
      })),
  }))

/** The options that follow the model, filed under the model they were reported with; the newest first. */
export function withModelOptions(perModel: AcpCatalogue['perModel'], options: readonly SessionConfigOption[]): AcpCatalogue['perModel'] {
  const model = options.find(option => option.category === 'model')?.currentValue
  if (model === undefined) return perModel
  return [{ model, options: bounded(options.filter(followsModel)) }, ...perModel.filter(entry => entry.model !== model)].slice(
    0,
    MAX_MODELS,
  )
}

/**
 * The catalogue after a new session reported `options`. The mode shows `startMode`, the one Latch sets before every first
 * prompt, so a draft never promises another; a definition other than the last one's starts over.
 */
export function startCatalogue(
  prior: AcpCatalogue | undefined,
  input: {
    options: readonly SessionConfigOption[]
    isMode: (option: SessionConfigOption) => boolean
    startMode: string | undefined
    definitionHash: string
    launchHash: string
    agentVersion?: string
    at: string
    source: AcpCatalogue['source']
  },
): AcpCatalogue {
  const { startMode } = input
  const options = input.options.map(option =>
    input.isMode(option) && startMode !== undefined && option.options.some(value => value.value === startMode)
      ? { ...option, category: 'mode', currentValue: startMode }
      : option,
  )
  const kept = prior?.definitionHash === input.definitionHash ? prior.perModel : []
  return {
    definitionHash: input.definitionHash,
    launchHash: input.launchHash,
    ...(input.agentVersion ? { agentVersion: input.agentVersion } : {}),
    options: bounded(options),
    perModel: withModelOptions(kept, input.options),
    reportedAt: input.at,
    source: input.source,
  }
}

/**
 * The catalogue after a harness's own model list: its model and thinking options and thinking for every model replace
 * what was known, and the other options a session of this definition reported stay.
 */
export function modelListCatalogue(
  prior: AcpCatalogue | undefined,
  input: {
    options: readonly SessionConfigOption[]
    perModel: AcpCatalogue['perModel']
    definitionHash: string
    at: string
  },
): AcpCatalogue {
  const listed = (option: SessionConfigOption) => option.category === 'model' || option.category === 'thought_level'
  const kept = prior?.definitionHash === input.definitionHash ? prior.options.filter(option => !listed(option)) : []
  return {
    definitionHash: input.definitionHash,
    launchHash: input.definitionHash,
    ...(prior?.definitionHash === input.definitionHash && prior.agentVersion ? { agentVersion: prior.agentVersion } : {}),
    options: bounded([...input.options, ...kept]),
    perModel: input.perModel.slice(0, MAX_MODELS).map(entry => ({ model: entry.model, options: bounded(entry.options) })),
    reportedAt: input.at,
    source: 'check',
  }
}

/** What a draft may read of it: within its size, dropping the models seen longest ago first, or nothing. */
export function shownCatalogue(stored: AcpCatalogue): HarnessCatalogue | undefined {
  const shown: HarnessCatalogue = structuredClone({
    options: stored.options,
    perModel: stored.perModel,
    reportedAt: stored.reportedAt,
    source: stored.source,
  })
  while (new TextEncoder().encode(JSON.stringify(shown)).length > MAX_BYTES) {
    if (!shown.perModel.length) return undefined
    shown.perModel.pop()
  }
  return shown
}

/** A draft's choices as a session keeps them until they are set, with what the catalogue calls each. */
export function startChoices(config: ReadonlyArray<{ configId: string; value: string }>, stored: AcpCatalogue | undefined): StartChoice[] {
  return config.map(({ configId, value }) => {
    const option = stored?.options.find(item => item.id === configId)
    const named =
      option?.options.find(item => item.value === value)
      ?? stored?.perModel
        .flatMap(entry => entry.options)
        .find(item => item.id === configId)
        ?.options.find(item => item.value === value)
    return {
      configId,
      value,
      ...(option?.category ? { category: option.category } : {}),
      ...(named ? { label: named.name } : {}),
    }
  })
}

/** The order a start sets its choices: the model first, since what else is offered can follow it; the mode last. */
export const START_ORDER = { model: 0, other: 1, mode: 2 } as const
