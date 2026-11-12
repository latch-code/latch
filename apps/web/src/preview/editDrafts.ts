import { useSyncExternalStore } from 'react'
import type { FileMetadata } from '@latch/protocol'

/** A save sent and not answered: a retry sends exactly this. */
export interface EditSent {
  requestId: string
  baseHash: string
  content: string
}

/** The file as it is now, after a save found it changed. */
export interface EditTheirs {
  hash: string
  /** Undefined when it could not be read as text. */
  text?: string
}

export type EditPhase = 'editing' | 'saving' | 'unknown' | 'conflict'

/** What the editor shows, kept so it survives the tab or the panel going away. */
export interface EditorState {
  draft: string
  phase: EditPhase
  sent?: EditSent
  theirs?: EditTheirs
  /** After 载入最新: the version the editor works from now, in place of the one it opened. */
  base?: { text: string; hash: string }
}

/** One open editor: the version it started from, and its state. */
export interface EditDraft {
  file: FileMetadata
  text: string
  hash: string
  state: EditorState
}

/**
 * Open editors by session and file (`draftKey`), in memory only: switching tabs or panels keeps the person's text, a
 * conflict and an unanswered save. Leaving the session or closing the file's tab asks first (`requestLeave`,
 * `requestDrop`), and a closed tab takes its draft with it. A reload asks through the browser.
 */
const drafts = new Map<string, Map<string, EditDraft>>()
const listeners = new Set<() => void>()
/** `keys`: the files whose drafts go; all of the session's when absent. */
let pending: { sessionId: string; keys?: readonly string[]; proceed: () => void } | undefined

/** A file's draft key: its folder ID and relative path, as a resolved tab's target names them. */
export const draftKey = (root: string | undefined, path: string) => `${root ?? ''}\n${path}`
let version = 0

function changed(): void {
  version++
  for (const listener of listeners) listener()
}

export function editDraft(sessionId: string, key: string): EditDraft | undefined {
  return drafts.get(sessionId)?.get(key)
}

export function setEditDraft(sessionId: string, key: string, draft: EditDraft | undefined): void {
  const tabs = drafts.get(sessionId) ?? new Map<string, EditDraft>()
  if (draft) tabs.set(key, draft)
  else if (!tabs.delete(key)) return
  else if (tabs.size === 0) drafts.delete(sessionId)
  if (tabs.size) drafts.set(sessionId, tabs)
  changed()
}

/** Text that would be lost: changed, sent without an answer, or held in a conflict. */
export const unsaved = (draft: EditDraft) => draft.state.phase !== 'editing' || draft.state.draft !== draft.text

export function hasUnsaved(sessionId?: string): boolean {
  const sessions = sessionId === undefined ? [...drafts.values()] : [drafts.get(sessionId) ?? new Map<string, EditDraft>()]
  return sessions.some(tabs => [...tabs.values()].some(unsaved))
}

/** True when leaving the session must wait for the person: the guard asks, then calls `proceed`. */
export function requestLeave(sessionId: string, proceed: () => void): boolean {
  if (!hasUnsaved(sessionId)) return false
  pending = { sessionId, proceed }
  changed()
  return true
}

/**
 * Closing the tabs of these files: true when one holds unsaved text and the guard asks first; `proceed` then runs once
 * the person lets it go. Without unsaved text the drafts go at once and the caller goes on.
 */
export function requestDrop(sessionId: string, keys: readonly string[], proceed: () => void): boolean {
  const tabs = drafts.get(sessionId)
  if (
    keys.some(key => {
      const draft = tabs?.get(key)
      return !!draft && unsaved(draft)
    })
  ) {
    pending = { sessionId, keys, proceed }
    changed()
    return true
  }
  for (const key of keys) setEditDraft(sessionId, key, undefined)
  return false
}

export function answerLeave(discard: boolean): void {
  const request = pending
  pending = undefined
  if (request && discard) {
    if (request.keys) for (const key of request.keys) drafts.get(request.sessionId)?.delete(key)
    else drafts.delete(request.sessionId)
    if (drafts.get(request.sessionId)?.size === 0) drafts.delete(request.sessionId)
  }
  changed()
  if (request && discard) request.proceed()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The leave request waiting for an answer, and whether any text would be lost on a reload. */
export function useEditDrafts(): { leaving: boolean; unsaved: boolean } {
  const seen = useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  )
  void seen
  return { leaving: pending !== undefined, unsaved: hasUnsaved() }
}
