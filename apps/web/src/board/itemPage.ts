import { useSyncExternalStore } from 'react'
import { readStorage } from '../core/storageKeys.ts'

/**
 * Which 待办's page 看板 shows in place of its board, for this tab: kept in `sessionStorage` (the id only, never its
 * text) so 对话 and back, and a reload, find the same page. Another device's id is never read. The board unmounts
 * while 对话 shows, so the page cannot live in its state.
 */
const key = () => `latch.board.item.${location.origin}`
const ITEM_ID = /^itm_[A-Za-z0-9_-]{22}$/u

interface Stored {
  deviceId: string
  itemId: string
}

const listeners = new Set<() => void>()
let current: Stored | null | undefined
const stored = (): Stored | null => (current === undefined ? (current = read()) : current)

function read(): Stored | null {
  try {
    const value: unknown = JSON.parse(readStorage('sessionStorage', key()) ?? 'null')
    if (typeof value !== 'object' || value === null) return null
    const { deviceId, itemId } = value as Record<string, unknown>
    return typeof deviceId === 'string' && typeof itemId === 'string' && ITEM_ID.test(itemId) ? { deviceId, itemId } : null
  } catch {
    return null
  }
}

function write(next: Stored | null): void {
  current = next
  try {
    if (next) sessionStorage.setItem(key(), JSON.stringify(next))
    else sessionStorage.removeItem(key())
  } catch {
    // Without storage the page still opens; a reload finds the board.
  }
  for (const listener of listeners) listener()
}

/** 看板 shows this 待办's page next time it is in front (and now, if it is). */
export function openItemPage(deviceId: string, itemId: string): void {
  const now = stored()
  if (now?.deviceId === deviceId && now.itemId === itemId) return
  write({ deviceId, itemId })
}

/** Back to the board. */
export function closeItemPage(): void {
  if (stored()) write(null)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The 待办 whose page is open on this device, if any. */
export function useItemPage(deviceId: string): string | null {
  const open = useSyncExternalStore(subscribe, stored)
  return open?.deviceId === deviceId ? open.itemId : null
}
