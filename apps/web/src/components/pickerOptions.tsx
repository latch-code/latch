import type { HostCatalog, ModelRef } from '@latch/protocol'
import { Badge, type PickerGroup, type PickerOption } from '@latch/ui'
import { startableWorkspaces } from '../composerChoice.ts'
import { basename, middleEllipsis } from '../format.ts'

/**
 * The values of the design system's pickers (ValuePicker) for a session's model and project: one string per choice,
 * so a model is keyed by its service and name together.
 */

export const modelKey = (model: ModelRef) => `${model.providerId}\u0000${model.model}`

export function modelFromKey(key: string): ModelRef {
  const [providerId = '', model = ''] = key.split('\u0000')
  return { providerId, model }
}

/** Every model of every service, under the service's name; a demo service's models say so. */
export function modelGroups(catalog: HostCatalog): Array<PickerGroup<string>> {
  return catalog.providers.map(provider => ({
    id: provider.id,
    label: provider.name,
    options: (provider.models.length ? provider.models : [provider.defaultModel]).filter(Boolean).map(model => ({
      value: modelKey({ providerId: provider.id, model }),
      label: model,
      ...(provider.kind === 'demo' ? { tag: <Badge tone="warn">演示</Badge> } : {}),
    })),
  }))
}

/** The projects a new session may start in, by name with the path under it. */
export function workspaceOptions(catalog: HostCatalog): Array<PickerOption<string>> {
  return startableWorkspaces(catalog).map(workspace => ({
    value: workspace.id,
    label: workspace.name || basename(workspace.path),
    description: middleEllipsis(workspace.path, 44),
  }))
}
