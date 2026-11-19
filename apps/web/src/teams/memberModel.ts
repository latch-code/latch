import type { HostCatalog, ModelRef } from '@latch/protocol'
import { draftStart, findHarness, resolveChoice, servicePick, type ComposerChoice } from '../composerChoice.ts'

/**
 * The model a member on `harnessId` is started with: what a new session of that Harness would start on in this
 * person's input box, in the lead's project, when that is a model of a Latch service. None when it is the Harness's
 * own model. Never the lead session's model.
 */
export function memberModel(
  catalog: HostCatalog | undefined,
  remembered: Partial<ComposerChoice> | null,
  harnessId: string,
  { projectId, access }: { projectId?: string | undefined; access?: { legacy: boolean; local: boolean } } = {},
): ModelRef | undefined {
  const harness = findHarness(catalog, harnessId)
  if (!catalog || !harness) return undefined
  const memory = projectId ? { ...remembered, workspaceId: projectId } : remembered
  const choice = resolveChoice(catalog, draftStart(catalog, memory, { harnessId }, access))
  if (choice.harnessId !== harnessId) return undefined
  return harness.capabilities.models.owner === 'latch' ? choice.model : servicePick(catalog, harness, choice.config)
}
