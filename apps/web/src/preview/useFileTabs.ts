import { useEffect, useState } from 'react'
import type { FileContext, FileMetadata } from '@latch/protocol'
import { storageGet, storageSet } from '../preferences.ts'
import { contextOf, fileContextKey, targetIn, type PreviewTarget } from './fileContext.ts'

export interface FileTab {
  id: string
  target: PreviewTarget
  file?: FileMetadata
}
type ContextTabs = { context: FileContext; tabs: FileTab[]; selected?: string }
const keyFor = (deviceId: string) => `latch.file-tabs.${location.origin}.${deviceId}`
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)

function restoreContext(item: Record<string, unknown>): FileContext | undefined {
  if (validId(item.sessionId)) return { kind: 'session', sessionId: item.sessionId }
  const context = item.context
  if (!context || typeof context !== 'object') return
  if ('kind' in context && context.kind === 'session' && 'sessionId' in context && validId(context.sessionId))
    return { kind: 'session', sessionId: context.sessionId }
  if (
    'kind' in context
    && context.kind === 'workspace'
    && 'workspaceId' in context
    && validId(context.workspaceId)
    && 'harnessId' in context
    && validId(context.harnessId)
  )
    return { kind: 'workspace', workspaceId: context.workspaceId, harnessId: context.harnessId }
}

function restore(key: string): Record<string, ContextTabs> {
  try {
    const raw = storageGet(key)
    if (!raw || raw.length > 128_000) return {}
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return {}
    const result: Record<string, ContextTabs> = Object.create(null)
    for (const item of value.slice(-40)) {
      if (!item || typeof item !== 'object' || !Array.isArray(item.files)) continue
      const context = restoreContext(item)
      if (!context) continue
      const tabs: FileTab[] = item.files.slice(0, 6).flatMap((file: unknown) => {
        if (!file || typeof file !== 'object') return []
        const entry = file as Record<string, unknown>
        if (
          typeof entry.path !== 'string'
          || entry.path.length > 4096
          || entry.path.startsWith('/')
          || entry.path.split(/[\\/]/u).includes('..')
          || /[\u0000-\u001f\u007f]/u.test(entry.path)
          || typeof entry.root !== 'string'
          || !/^[A-Za-z0-9_-]{1,32}$/u.test(entry.root)
        )
          return []
        if (
          entry.attachmentId !== undefined
          && (context.kind !== 'session' || typeof entry.attachmentId !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(entry.attachmentId))
        )
          return []
        if (entry.view !== undefined && entry.view !== 'preview' && entry.view !== 'changes') return []
        const target = targetIn(context, entry.path, entry.root)
        return [
          {
            id: crypto.randomUUID(),
            target:
              'sessionId' in target
                ? {
                    ...target,
                    ...(entry.view === 'changes' ? { view: 'changes' as const } : {}),
                    ...(typeof entry.attachmentId === 'string' ? { attachmentId: entry.attachmentId } : {}),
                  }
                : target,
          },
        ]
      })
      if (tabs.length) result[fileContextKey(context)] = { context, tabs }
    }
    return result
  } catch {
    return {}
  }
}

/** Only context IDs, relative paths and root IDs survive reload. Bytes and handles stay in memory. */
export function useFileTabs(deviceId: string, context: FileContext | null) {
  const key = keyFor(deviceId)
  const [contexts, setContexts] = useState(() => restore(key))
  useEffect(() => {
    storageSet(
      key,
      JSON.stringify(
        Object.values(contexts)
          .slice(-40)
          .map(state => ({
            context: state.context,
            files: state.tabs.flatMap(tab => {
              const root = tab.file?.root ?? tab.target.rootId,
                path = tab.file?.path ?? tab.target.reference
              if (!root || path.startsWith('/')) return []
              return [
                {
                  root,
                  path,
                  ...(tab.file?.attachmentId ? { attachmentId: tab.file.attachmentId } : {}),
                  ...(tab.target.view === 'changes' ? { view: 'changes' } : {}),
                },
              ]
            }),
          })),
      ),
    )
  }, [key, contexts])
  const currentKey = context ? fileContextKey(context) : undefined
  const state = currentKey ? contexts[currentKey] : undefined
  const tabs = state?.tabs ?? []
  const update = (targetContext: FileContext, change: (state: ContextTabs) => ContextTabs) => {
    const id = fileContextKey(targetContext)
    setContexts(previous =>
      Object.fromEntries([
        ...Object.entries(previous)
          .filter(([key]) => key !== id)
          .slice(-39),
        [id, change(Object.hasOwn(previous, id) ? previous[id]! : { context: targetContext, tabs: [] })],
      ]),
    )
  }
  return {
    tabs,
    active: tabs.find(tab => tab.id === state?.selected),
    open(target: PreviewTarget) {
      update(contextOf(target), state => {
        const existing = state.tabs.find(
          tab =>
            (tab.target.reference === target.reference
              && tab.target.rootId === target.rootId
              && tab.target.attachmentId === target.attachmentId)
            || (tab.file?.path === target.reference && tab.file.root === target.rootId && tab.file.attachmentId === target.attachmentId),
        )
        const nextTarget = 'sessionId' in target ? { ...target, view: target.view ?? ('preview' as const) } : target
        const tab = { id: existing?.id ?? crypto.randomUUID(), ...(existing?.file ? { file: existing.file } : {}), target: nextTarget }
        return { ...state, tabs: [...state.tabs.filter(item => item.id !== tab.id), tab].slice(-6), selected: tab.id }
      })
    },
    select(id?: string) {
      if (context) update(context, state => ({ ...state, selected: id }))
    },
    view(id: string, view: 'preview' | 'changes') {
      if (context?.kind === 'session')
        update(context, state => ({
          ...state,
          selected: id,
          tabs: state.tabs.map(tab => (tab.id === id && 'sessionId' in tab.target ? { ...tab, target: { ...tab.target, view } } : tab)),
        }))
    },
    close(id: string) {
      if (context)
        update(context, state => {
          const tabs = state.tabs.filter(tab => tab.id !== id)
          return { ...state, tabs, selected: state.selected === id ? tabs.at(-1)?.id : state.selected }
        })
    },
    resolved(id: string, file: FileMetadata) {
      if (context)
        update(context, state => ({
          ...state,
          tabs: state.tabs.map(tab =>
            tab.id === id ? { ...tab, file, target: { ...tab.target, reference: file.path, rootId: file.root } } : tab,
          ),
        }))
    },
  }
}
