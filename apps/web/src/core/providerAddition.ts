import { readStorage } from './storageKeys.ts'
import { newRequestId } from './api.ts'
import type { NewProvider } from './providerSetup.ts'

interface Addition {
  requestId: string
  presetId: string
}

const storageKey = (identity: string) => `latch.provider-addition.${identity}`
const inputLifetime = 10 * 60_000
const attempts = new Map<string, Addition>()
const inputs = new Map<string, { input: NewProvider; expires: ReturnType<typeof setTimeout> }>()

export function providerAddition(identity: string | undefined): Addition | undefined {
  if (!identity) return undefined
  const current = attempts.get(identity)
  if (current) return current
  const text = readStorage('localStorage', storageKey(identity))
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as Partial<Addition> | null
    return value !== null
      && typeof value.requestId === 'string'
      && /^[A-Za-z0-9_-]{8,128}$/u.test(value.requestId)
      && typeof value.presetId === 'string'
      && /^[a-z0-9_-]{1,48}$/u.test(value.presetId)
      ? { requestId: value.requestId, presetId: value.presetId }
      : undefined
  } catch {
    return undefined
  }
}

/** Only the receipt lookup survives a reload. The entered key has the same in-memory lifetime as a provider draft. */
export function rememberProviderAddition(identity: string, presetId: string, request: NewProvider): NewProvider {
  const requestId = newRequestId()
  const receipt = { requestId, presetId }
  const input = { ...request, addition: { id: `setup-${requestId}`, requestId } }
  const expires = setTimeout(() => inputs.delete(identity), inputLifetime)
  clearTimeout(inputs.get(identity)?.expires)
  inputs.set(identity, { input, expires })
  attempts.set(identity, receipt)
  try {
    localStorage.setItem(storageKey(identity), JSON.stringify(receipt))
  } catch {
    // In-memory retry still works when local storage is unavailable.
  }
  return input
}

export function previousProviderInput(identity: string): NewProvider | undefined {
  return inputs.get(identity)?.input
}

export function clearProviderAddition(identity: string): void {
  clearTimeout(inputs.get(identity)?.expires)
  inputs.delete(identity)
  attempts.delete(identity)
  try {
    localStorage.removeItem(storageKey(identity))
  } catch {
    // The request can still be reconciled while this page is open.
  }
}
