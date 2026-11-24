import { useLayoutEffect, useRef, useState } from 'react'
import { api, ApiError, isUncertain, type ApiOptions } from '../core/api.ts'

export const dataObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
export const digest = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
export const receipt = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-z_-]{8,128}$/iu.test(value)

export function receiptUnsettled(cause: unknown, retrying: boolean): boolean {
  return (
    isUncertain(cause)
    || (cause instanceof ApiError
      // Both the rate limit and the concurrent request limit run before the Host looks up the original receipt.
      && ((retrying && cause.status === 429)
        || cause.status === 401
        || cause.code === 'scope-required'
        || cause.code === 'plugin-package-scope'
        || cause.code === 'local-only'))
  )
}

export function useMarketWriteScope(key: string, enabled: boolean) {
  const current = useRef<{ key: string; signal: AbortSignal } | null>(null)
  useLayoutEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    current.current = { key, signal: controller.signal }
    return () => {
      current.current = null
      controller.abort()
    }
  }, [enabled, key])
  return () => (current.current?.key === key ? current.current.signal : null)
}

export async function marketRequest<T>(signal: AbortSignal, path: string, options?: ApiOptions): Promise<T> {
  signal.throwIfAborted()
  const result = await api<T>(path, { ...options, signal, noRenew: true, rateRetried: true })
  signal.throwIfAborted()
  return result
}

/** An unauthorized view hides the receipt. The same Host and device can recover it when editing becomes available. */
export function useMarketReceipt<T>(key: string, editable: boolean, valid: (value: unknown) => value is T) {
  const [stored, setStored] = useState<{ key: string; value: T | null }>(() => ({
    key,
    value: editable ? readPending(key, valid) : null,
  }))
  useLayoutEffect(() => {
    if (!editable) return
    const value = readPending(key, valid)
    setStored(current => (current.key === key && current.value !== null ? current : { key, value }))
  }, [key, editable, valid])
  const pending = editable && stored.key === key ? stored.value : null
  const setPending = (value: T | null) => setStored(current => (current.key === key ? { key, value } : current))
  return [pending, setPending] as const
}

/** The browser holds only exact safe mutations, scoped to this tab, Host and device. */
function readPending<T>(key: string, valid: (value: unknown) => value is T): T | null {
  try {
    const text = sessionStorage.getItem(key)
    if (text === null) return null
    const value: unknown = JSON.parse(text)
    if (valid(value)) return value
  } catch {
    // Drop malformed data written by a previous build or a damaged browser store.
  }
  rememberPending(key, null)
  return null
}

export function rememberPending(key: string, value: { requestId: string } | null): void {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value))
    else sessionStorage.removeItem(key)
  } catch {
    // In-memory retry is still available while this tab is open.
  }
}

export function forgetReceipt(key: string, requestId: string): void {
  try {
    const current: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (dataObject(current) && current.requestId === requestId) sessionStorage.removeItem(key)
  } catch {
    // A later mount discards malformed stored data.
  }
}
