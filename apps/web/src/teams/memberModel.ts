import { LADDER_MODE, type HostCatalog, type ModelRef, type TeamTaskInput } from '@latch/protocol'
import { draftStart, findHarness, resolveChoice, servicePick, startChoices, type ComposerChoice } from '../composerChoice.ts'

/** What a member's own choice can change: the model (with its level) and the Harness's own options. */
export type MemberPick = Pick<ComposerChoice, 'model' | 'config'>

interface Place {
  projectId?: string | undefined
  access?: { legacy: boolean; local: boolean } | undefined
}

/**
 * What a member on `harnessId` starts on before anyone changes it: what a new session of that Harness would start on in
 * this person's input box, in the lead's project. Never the lead session's model or level. None while that Harness
 * cannot be chosen.
 */
export function memberChoice(
  catalog: HostCatalog | undefined,
  remembered: Partial<ComposerChoice> | null,
  harnessId: string,
  { projectId, access }: Place = {},
): ComposerChoice | undefined {
  if (!catalog || !findHarness(catalog, harnessId)) return undefined
  const memory = projectId ? { ...remembered, workspaceId: projectId } : remembered
  const choice = resolveChoice(catalog, draftStart(catalog, memory, { harnessId }, access))
  return choice.harnessId === harnessId ? choice : undefined
}

/** A member's choice with what the person picked for it in the list; the picks are the row's alone. */
export function withPick(catalog: HostCatalog | undefined, base: ComposerChoice, pick: MemberPick | undefined): ComposerChoice {
  if (!pick || !catalog) return base
  return resolveChoice(catalog, { ...base, ...pick })
}

/**
 * What a member's start carries beside its Harness, as a new session's start carries it (`startChoices`). A pick of the
 * permission mode never goes: a member starts on its Harness's and project's default.
 */
export function memberStart(
  catalog: HostCatalog | undefined,
  choice: ComposerChoice | undefined,
): Pick<TeamTaskInput, 'model' | 'config' | 'ownModel'> {
  if (!catalog || !choice) return {}
  const harness = findHarness(catalog, choice.harnessId)
  const { config, ...rest } = startChoices(catalog, choice)
  const kept = config?.filter(
    pick => pick.configId !== LADDER_MODE && harness?.catalogue?.options.find(option => option.id === pick.configId)?.category !== 'mode',
  )
  return { ...rest, ...(kept?.length ? { config: kept } : {}) }
}

/**
 * The model of a Latch service a member on `harnessId` starts on by default, for the muted name beside its Harness where
 * a proposal is reviewed. None when it is the Harness's own model.
 */
export function memberModel(
  catalog: HostCatalog | undefined,
  remembered: Partial<ComposerChoice> | null,
  harnessId: string,
  place: Place = {},
): ModelRef | undefined {
  const choice = memberChoice(catalog, remembered, harnessId, place)
  const harness = findHarness(catalog, harnessId)
  if (!choice || !harness) return undefined
  return harness.capabilities.models.owner === 'latch' ? choice.model : servicePick(catalog, harness, choice.config)
}
