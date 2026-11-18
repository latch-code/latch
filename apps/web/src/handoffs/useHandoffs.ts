import { useCallback, useEffect, useRef, useState } from 'react'
import { isFileMetadata, type FileMention, type Handoff, type HandoffCreate, type HandoffList, type HandoffSummary } from '@latch/protocol'
import { api, fileBytes } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'
import { HandoffMessageError, sha256Hex } from './model.ts'

const COPY = defineCopy(
  {
    unreadable: '读不到这个文件',
    tooLarge: '超过 4 MB',
    partial: '这台设备读不到整个文件',
    changed: '文件在读取时变化了',
  },
  {
    unreadable: "Couldn't read the file",
    tooLarge: 'Over 4 MB',
    partial: "This device can't read the entire file",
    changed: 'The file changed while it was being read',
  },
)

/** The Host hashes a file material whole and refuses larger ones. */
const FILE_LIMIT = 4 * 1024 * 1024

/**
 * The handoffs whose source or target is this session, as this device may see them. Read again whenever the snapshot's
 * summaries for the session change; a session the snapshot names in none has none, and nothing is asked.
 */
export function useSessionHandoffs({
  sessionId,
  summaries,
  enabled,
}: {
  sessionId: string | null
  summaries: readonly HandoffSummary[] | undefined
  enabled: boolean
}) {
  const signature =
    sessionId === null
      ? ''
      : (summaries ?? [])
          .filter(item => item.sourceSessionId === sessionId || item.targetSessionId === sessionId)
          .map(item => `${item.id}:${item.status}:${item.updatedAt}`)
          .join('|')
  const [held, setHeld] = useState<{ sessionId: string; handoffs: Handoff[] } | null>(null)
  const asked = useRef(0)
  const reload = useCallback(async () => {
    if (!sessionId || !enabled) return
    const ask = ++asked.current
    try {
      const { handoffs } = await api<HandoffList>(`handoffs?sessionId=${encodeURIComponent(sessionId)}`)
      if (asked.current === ask) setHeld({ sessionId, handoffs })
    } catch {
      // The list stays as it was; the next change in the snapshot asks again.
    }
  }, [sessionId, enabled])
  useEffect(() => {
    if (!sessionId || !enabled) return
    if (!signature) {
      setHeld({ sessionId, handoffs: [] })
      return
    }
    void reload()
  }, [sessionId, enabled, signature, reload])
  /** Puts the Host's answer in the list at once, before the snapshot says it changed. */
  const merge = useCallback(
    (handoff: Handoff) => {
      if (!sessionId) return
      setHeld(previous => {
        const list = previous?.sessionId === sessionId ? previous.handoffs : []
        return { sessionId, handoffs: [...list.filter(item => item.id !== handoff.id), handoff] }
      })
    },
    [sessionId],
  )
  const handoffs = held && held.sessionId === sessionId ? held.handoffs : []
  return { handoffs, reload, merge }
}

export type SessionHandoffs = ReturnType<typeof useSessionHandoffs>

/** SHA-256 of a session file's bytes, read through the same authorised handle as the preview. */
export async function fileHash(sessionId: string, file: FileMention, signal?: AbortSignal): Promise<string> {
  const result = await api<{ files: Array<{ status: string; code?: string; file?: unknown }> }>(
    `tasks/${encodeURIComponent(sessionId)}/files/resolve`,
    { method: 'POST', body: { paths: [file.path], rootId: file.root }, ...(signal ? { signal } : {}) },
  )
  const answer = result.files[0]
  if (!answer || answer.status !== 'ok' || !isFileMetadata(answer.file)) throw new HandoffMessageError(() => COPY.unreadable)
  const meta = answer.file
  if (meta.size > FILE_LIMIT) throw new HandoffMessageError(() => COPY.tooLarge)
  if (meta.secret || meta.truncated || meta.size > meta.limit) throw new HandoffMessageError(() => COPY.partial)
  const bytes = await fileBytes(meta.handle, undefined, undefined, signal)
  if (bytes.byteLength !== meta.size) throw new HandoffMessageError(() => COPY.changed)
  return sha256Hex(bytes)
}

/** A create this page sent and has no answer for, by source session: kept so a retry repeats it word for word. */
const unanswered = new Map<string, HandoffCreate>()
export const unansweredCreate = {
  get: (sourceSessionId: string) => unanswered.get(sourceSessionId),
  set: (sourceSessionId: string, body: HandoffCreate | undefined) => {
    if (body) unanswered.set(sourceSessionId, body)
    else unanswered.delete(sourceSessionId)
  },
}
