import { useEffect, useState } from 'react'
import type { FileContext, FileMetadata } from '@latch/protocol'
import { storageGet, storageSet } from '../preferences.ts'
import { contextOf, fileContextKey, targetIn, type PreviewTarget } from './fileContext.ts'
import type { FileTreeView } from './treeFiles.ts'
import { draftKey, editDraft, requestDrop } from './editDrafts.ts'

export interface FileTab {
  id: string
  target: PreviewTarget
  file?: FileMetadata
  /** Produced by a turn and not looked at yet. Kept in memory: a reload forgets it. */
  fresh?: boolean
}
type ContextTabs = { context: FileContext; tabs: FileTab[]; selected?: string; treeView?: FileTreeView }
const MAX_TABS = 6
const looked = (tab: FileTab): FileTab => {
  const { fresh: _fresh, ...rest } = tab
  return rest
}

/** Waits behind the open file. A full strip keeps what is in it: the new document stays reachable from the turn's card. */
export function offerTab(tabs: FileTab[], tab: FileTab): FileTab[] {
  if (
    tabs.length >= MAX_TABS
    || tabs.some(item => item.target.reference === tab.target.reference && item.target.rootId === tab.target.rootId)
  )
    return tabs
  return [...tabs, tab]
}

/** A tab's draft key: the file it shows, once resolved. */
export const tabDraftKey = (tab: FileTab) => draftKey(tab.file?.root ?? tab.target.rootId, tab.file?.path ?? tab.target.reference)

/**
 * The tab that makes room for a new one in a full strip: the oldest without an editor open. `undefined` when there is
 * room; `ask` with the oldest when every tab holds an editor, so the person decides.
 */
export function eviction(tabs: readonly FileTab[], hasDraft: (tab: FileTab) => boolean): { id: string; ask: boolean } | undefined {
  if (tabs.length < MAX_TABS) return undefined
  const clean = tabs.find(tab => !hasDraft(tab))
  return clean ? { id: clean.id, ask: false } : { id: tabs[0]!.id, ask: true }
}

/** The tab that takes over is being looked at now, so it loses its dot as if it had been picked. */
export function closeTab(tabs: FileTab[], selected: string | undefined, id: string): { tabs: FileTab[]; selected: string | undefined } {
  const left = tabs.filter(tab => tab.id !== id)
  const next = selected === id ? left.at(-1)?.id : selected
  return { tabs: left.map(tab => (tab.id === next ? looked(tab) : tab)), selected: next }
}
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
      const tabs: FileTab[] = item.files.slice(0, MAX_TABS).flatMap((file: unknown) => {
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
export function useFileTabs(deviceId: string, context: FileContext | null, authority = '') {
  const key = keyFor(deviceId)
  const [bank, setBank] = useState(() => ({ key, authority, epoch: 0, contexts: restore(key) }))
  let contexts = bank.contexts
  let epoch = bank.epoch
  if (bank.key !== key || bank.authority !== authority) {
    contexts =
      bank.key !== key
        ? restore(key)
        : Object.fromEntries(
            Object.entries(bank.contexts).map(([id, state]) => [
              id,
              {
                context: state.context,
                tabs: state.tabs.map(tab => ({ id: crypto.randomUUID(), target: tab.target })),
              },
            ]),
          )
    // Fence this render as well as late callbacks; no old preview is committed under new authority.
    epoch++
    setBank({ key, authority, epoch, contexts })
  }
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
  const update = (targetContext: FileContext, change: (state: ContextTabs) => ContextTabs) => {
    const id = fileContextKey(targetContext)
    setBank(previous => {
      if (previous.key !== key || previous.authority !== authority || previous.epoch !== epoch) return previous
      return {
        ...previous,
        contexts: Object.fromEntries([
          ...Object.entries(previous.contexts)
            .filter(([key]) => key !== id)
            .slice(-39),
          [id, change(Object.hasOwn(previous.contexts, id) ? previous.contexts[id]! : { context: targetContext, tabs: [] })],
        ]),
      }
    })
  }
  const forContext = (context: FileContext | null) => {
    const currentKey = context ? fileContextKey(context) : undefined
    const state = currentKey ? contexts[currentKey] : undefined
    const tabs = state?.tabs ?? []
    return {
      tabs,
      active: tabs.find(tab => tab.id === state?.selected),
      treeView: state?.treeView,
      setTreeView(treeView: FileTreeView) {
        if (context) update(context, state => ({ ...state, treeView }))
      },
      open(target: PreviewTarget) {
        const targetContext = contextOf(target)
        const matches = (tab: FileTab) =>
          (tab.target.reference === target.reference
            && tab.target.rootId === target.rootId
            && tab.target.attachmentId === target.attachmentId)
          || (tab.file?.path === target.reference && tab.file.root === target.rootId && tab.file.attachmentId === target.attachmentId)
        const sessionId = targetContext.kind === 'session' ? targetContext.sessionId : undefined
        const current = contexts[fileContextKey(targetContext)]?.tabs ?? []
        // A full strip lets go of a tab with no editor open; an open editor is never closed without asking.
        const room = current.some(matches)
          ? undefined
          : eviction(current, tab => sessionId !== undefined && editDraft(sessionId, tabDraftKey(tab)) !== undefined)
        const go = () =>
          update(targetContext, state => {
            const existing = state.tabs.find(matches)
            const nextTarget = 'sessionId' in target ? { ...target, view: target.view ?? ('preview' as const) } : target
            const tab = { id: existing?.id ?? crypto.randomUUID(), ...(existing?.file ? { file: existing.file } : {}), target: nextTarget }
            const kept = state.tabs.filter(item => item.id !== tab.id && (existing || item.id !== room?.id))
            return { ...state, tabs: [...kept, tab].slice(-MAX_TABS), selected: tab.id }
          })
        const leaving = room && current.find(tab => tab.id === room.id)
        if (room?.ask && sessionId && leaving && requestDrop(sessionId, [tabDraftKey(leaving)], go)) return
        go()
      },
      /** A second document from the same turn: its tab waits with a dot, behind the one that opened. */
      offer(target: PreviewTarget) {
        update(contextOf(target), state => {
          const nextTarget = 'sessionId' in target ? { ...target, view: target.view ?? ('preview' as const) } : target
          return { ...state, tabs: offerTab(state.tabs, { id: crypto.randomUUID(), target: nextTarget, fresh: true }) }
        })
      },
      select(id?: string) {
        if (context)
          update(context, state => ({
            ...state,
            selected: id,
            tabs: state.tabs.map(tab => (tab.id === id ? looked(tab) : tab)),
          }))
      },
      view(id: string, view: 'preview' | 'changes') {
        if (context?.kind === 'session')
          update(context, state => ({
            ...state,
            selected: id,
            tabs: state.tabs.map(tab => (tab.id === id && 'sessionId' in tab.target ? { ...tab, target: { ...tab.target, view } } : tab)),
          }))
      },
      /** Closes the tab; one with unsaved text asks first. `then` runs once it is closed. */
      close(id: string, then?: () => void) {
        if (!context) return
        const tab = tabs.find(item => item.id === id)
        const go = () => {
          update(context, state => ({ ...state, ...closeTab(state.tabs, state.selected, id) }))
          then?.()
        }
        if (context.kind === 'session' && tab && requestDrop(context.sessionId, [tabDraftKey(tab)], go)) return
        go()
      },
      resolved(id: string, file: FileMetadata) {
        if (context)
          update(context, state => ({
            ...state,
            tabs: state.tabs.map(tab => {
              if (tab.id !== id) return tab
              // Metadata refreshes keep the reading position; opening a reference can request a line again.
              const target =
                tab.target.reference === file.path && tab.target.rootId === file.root
                  ? tab.target
                  : { ...tab.target, reference: file.path, rootId: file.root }
              return { ...tab, file, target }
            }),
          }))
      },
    }
  }
  return { ...forContext(context), forContext }
}
