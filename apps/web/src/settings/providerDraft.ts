import type { ProviderKind, ProviderPreset } from '@latch/protocol'

/**
 * The add form of a model service as it was when 查看会话 left settings for the session holding its confirmation back.
 * Kept in this page's memory only, never stored: it is handed back once, to the same preset's form, and dropped after
 * ten minutes. It may hold a key that was typed, exactly as the form did.
 */
export interface ProviderDraft {
  preset: ProviderPreset
  name: string
  kind: ProviderKind
  baseURL: string
  apiKey: string
  models: string[]
  defaultModel: string
}

const LIFETIME = 10 * 60_000
let kept: ProviderDraft | null = null
let expiry: ReturnType<typeof setTimeout> | undefined

export function keepProviderDraft(draft: ProviderDraft): void {
  kept = { ...draft, models: [...draft.models] }
  clearTimeout(expiry)
  expiry = setTimeout(dropProviderDraft, LIFETIME)
}

/** The kept draft, for this preset when one is named. */
export function peekProviderDraft(presetId?: string): ProviderDraft | undefined {
  return kept && (presetId === undefined || kept.preset.id === presetId) ? kept : undefined
}

export function dropProviderDraft(): void {
  kept = null
  clearTimeout(expiry)
}
