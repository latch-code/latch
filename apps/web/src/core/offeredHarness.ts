import { AGENT_PRESETS } from '@latch/protocol'
import { api, ApiError } from './api.ts'
import { withConfirmation } from './confirmations.ts'

/**
 * Saves the definition of a preset a draft lists before it has one (`HarnessInfo.offer`). It runs nothing; the Host takes
 * a confirmation on this Mac for it, which the confirmation card shows. Saved by another window meanwhile is saved.
 * False: no such preset, so there is nothing to save.
 */
export async function saveOfferedPreset(presetId: string | undefined): Promise<boolean> {
  const preset = AGENT_PRESETS.find(item => item.id === presetId)
  if (!preset) return false
  const body = { id: preset.id, name: preset.name, presetId: preset.id, command: preset.command, args: preset.args, env: {}, enabled: true }
  try {
    await withConfirmation(confirmation => api('agents', { method: 'POST', body, ...(confirmation ? { confirmation } : {}) }))
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.code === 'agent-exists')) throw cause
  }
  return true
}
