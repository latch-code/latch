import { useEffect, useState } from 'react'
import type { FileMetadata, FileOpenTarget } from '@latch/protocol'
import { storageGet, storageSet } from '../preferences.ts'
export interface FileTab {
  id: string
  target: FileOpenTarget
  file?: FileMetadata
}
type SessionTabs = { tabs: FileTab[]; selected?: string }
const keyFor = (deviceId: string) => `latch.file-tabs.${location.origin}.${deviceId}`
function restore(key: string): Record<string, SessionTabs> {
  try {
    const raw = storageGet(key)
    if (!raw || raw.length > 128_000) return {}
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return {}
    const result: Record<string, SessionTabs> = Object.create(null)
    for (const item of value.slice(-40)) {
      if (
        !item
        || typeof item !== 'object'
        || typeof item.sessionId !== 'string'
        || item.sessionId.length > 256
        || !Array.isArray(item.files)
      )
        continue
      const sessionId = item.sessionId as string
      const tabs: FileTab[] = item.files.slice(0, 6).flatMap((file: unknown) => {
        if (!file || typeof file !== 'object') return []
        const entry = file as Record<string, unknown>
        if (
          typeof entry.path !== 'string'
          || entry.path.length > 4096
          || entry.path.startsWith('/')
          || entry.path.split(/[\\/]/u).includes('..')
          || typeof entry.root !== 'string'
          || !/^[A-Za-z0-9_-]{1,32}$/u.test(entry.root)
        )
          return []
        return [{ id: crypto.randomUUID(), target: { sessionId, reference: entry.path, rootId: entry.root } }]
      })
      if (tabs.length) result[sessionId] = { tabs }
    }
    return result
  } catch {
    return {}
  }
}
/** Only relative paths and root IDs survive reload. File bytes and handles stay in memory. */
export function useFileTabs(deviceId: string, sessionId: string | null) {
  const key = keyFor(deviceId)
  const [sessions, setSessions] = useState(() => restore(key))
  useEffect(() => {
    storageSet(
      key,
      JSON.stringify(
        Object.entries(sessions)
          .slice(-40)
          .map(([sessionId, state]) => ({
            sessionId,
            files: state.tabs.flatMap(tab =>
              tab.file
                ? [{ root: tab.file.root, path: tab.file.path }]
                : tab.target.rootId && !tab.target.reference.startsWith('/')
                  ? [{ root: tab.target.rootId, path: tab.target.reference }]
                  : [],
            ),
          })),
      ),
    )
  }, [key, sessions])
  const state = sessionId === null ? undefined : sessions[sessionId]
  const tabs = state?.tabs ?? []
  const active = tabs.find(tab => tab.id === state?.selected)
  const update = (id: string, change: (state: SessionTabs) => SessionTabs) =>
    setSessions(previous =>
      Object.fromEntries([
        ...Object.entries(previous)
          .filter(([key]) => key !== id)
          .slice(-39),
        [id, change(Object.hasOwn(previous, id) ? previous[id]! : { tabs: [] })],
      ]),
    )

  return {
    tabs,
    active,
    open(target: FileOpenTarget) {
      update(target.sessionId, state => {
        const existing = state.tabs.find(
          tab =>
            (tab.target.reference === target.reference && tab.target.rootId === target.rootId)
            || (tab.file?.path === target.reference && tab.file.root === target.rootId),
        )
        const tab = existing
          ? { ...existing, target: { ...existing.target, ...(target.line ? { line: target.line } : {}) } }
          : { id: crypto.randomUUID(), target }
        return { tabs: [...state.tabs.filter(item => item.id !== tab.id), tab].slice(-6), selected: tab.id }
      })
    },
    select(id?: string) {
      if (sessionId !== null) update(sessionId, state => ({ ...state, selected: id }))
    },
    close(id: string) {
      if (sessionId !== null)
        update(sessionId, state => {
          const tabs = state.tabs.filter(tab => tab.id !== id)
          return { tabs, selected: state.selected === id ? tabs.at(-1)?.id : state.selected }
        })
    },
    resolved(id: string, file: FileMetadata) {
      if (sessionId !== null)
        update(sessionId, state => ({
          ...state,
          tabs: state.tabs.map(tab =>
            tab.id === id ? { ...tab, file, target: { ...tab.target, reference: file.path, rootId: file.root } } : tab,
          ),
        }))
    },
  }
}
