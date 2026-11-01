import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AppSnapshot, ModelRef, FileMention } from '@latch/protocol'
import {
  api,
  ApiError,
  inlineError,
  isUncertain,
  newRequestId,
  readPending,
  submissionRequest,
  writePending,
  type PendingSubmission,
} from '../core/api.ts'
import { draftStart, pinnedChoice, readChoice, resolveChoice, writeChoice, type ComposerChoice, type DraftPick } from '../composerChoice.ts'
import { withConfirmation } from '../core/confirmations.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import type { SendingMessage } from '../core/sendingMessage.ts'

/**
 * A new session forked from another. `choice`: what it borrows from its source, for this draft only. The source's engine
 * may be one the person never picked here, so it stays out of what this device remembers.
 */
export type ForkDraft = NonNullable<PendingSubmission['forkOf']> & { title?: string; choice?: Partial<ComposerChoice> }

const restoredChoice = (pending: PendingSubmission): Partial<ComposerChoice> => ({
  ...(pending.mode ? { mode: pending.mode } : {}),
  ...(pending.harnessId ? { harnessId: pending.harnessId } : {}),
  ...(pending.workspaceId ? { workspaceId: pending.workspaceId } : {}),
  ...(pending.model ? { model: pending.model } : {}),
})

/**
 * Draft, composer choice and the at-most-one unconfirmed submission of this
 * device. A submission is stored before it is sent and cleared only once the
 * Host answers definitively, so a retry repeats the identical request.
 */
export function useSubmission({
  snapshot,
  access,
  selectedId,
  assistantId,
  select,
  refresh,
  onSent,
  onRefused,
}: {
  snapshot: AppSnapshot
  access: Pick<DeviceAccess, 'legacy' | 'local'>
  selectedId: string | null
  assistantId?: string
  select: (id: string | null) => void
  refresh: () => Promise<void>
  onSent: (sessionId: string, submission: PendingSubmission, result: { foreground: boolean; consumedDraft: boolean }) => void
  /** A definitive refusal; `resent`, a prompt that never sat in the input. Return true when a dedicated recovery UI owns its explanation. */
  onRefused?: (sessionId: string, error: unknown, resent?: string) => boolean | void
}) {
  const deviceId = snapshot.device.id
  const catalog = snapshot.catalog
  const pendingKey = `latch.pending.${location.origin}.${deviceId}`
  const [draft, setDraft] = useState('')
  const [fork, setFork] = useState<ForkDraft | null>(null)
  const [pending, setPending] = useState<PendingSubmission | null>(null)
  const [sending, setSending] = useState(false)
  const [sendingMessage, setSendingMessage] = useState<SendingMessage | null>(null)
  const sendingRef = useRef(false)
  const mounted = useRef(true)
  const destination = useRef({ selectedId, assistantId, epoch: 0 })
  if (destination.current.selectedId !== selectedId || destination.current.assistantId !== assistantId)
    destination.current = { selectedId, assistantId, epoch: destination.current.epoch + 1 }
  const requestOrigins = useRef(new Map<string, { epoch: number; consumedDraft: boolean }>())
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      destination.current.epoch++
    }
  }, [])
  const [error, setError] = useState('')
  const [stored, setStored] = useState<Partial<ComposerChoice> | null>(() => readChoice(deviceId))
  const [draftPick, setDraftPick] = useState<DraftPick | null>(null)
  const { legacy, local } = access
  const start = useMemo(() => draftStart(catalog, stored, draftPick, { legacy, local }), [catalog, stored, draftPick, legacy, local])
  const remembered = useMemo(() => resolveChoice(catalog, start, { legacy, local }), [catalog, start, legacy, local])
  const borrowed = fork?.choice
  const choice = useMemo(
    () => (borrowed ? resolveChoice(catalog, { ...start, ...borrowed }, { legacy, local }) : remembered),
    [catalog, start, borrowed, remembered, legacy, local],
  )
  /** Model switches chosen for existing sessions; sent with that session's next prompt. */
  const [overrides, setOverrides] = useState<Record<string, ModelRef>>({})

  const updateChoice = (patch: Partial<ComposerChoice>) => {
    setFork(previous => previous && (previous.choice ? { ...previous, choice: { ...previous.choice, ...patch } } : previous))
    if (pinnedChoice(catalog, { legacy, local })) {
      const { harnessId, model, ...rest } = patch
      setDraftPick(previous => ({ ...previous, ...(harnessId ? { harnessId } : {}), ...(model ? { model } : {}) }))
      const kept = { ...stored, ...rest }
      setStored(kept)
      writeChoice(deviceId, { ...kept, mode: kept.mode ?? remembered.mode })
      return
    }
    // Keep the remembered model when a harness without host models is picked, so switching back restores it.
    const next = { ...stored, ...remembered, ...patch }
    setStored(next)
    writeChoice(deviceId, resolveChoice(catalog, next, { legacy, local }))
  }

  useEffect(() => {
    const restored = readPending(pendingKey)
    setPending(restored)
    setSendingMessage(
      restored && !restored.queue
        ? { submission: restored, sessionId: restored.sessionId ?? null, state: 'unknown', startedAt: Date.now() }
        : null,
    )
    if (restored === null) return
    const ownsInput =
      restored.sessionId === undefined ? selectedId === null && assistantId === restored.assistantId : selectedId === restored.sessionId
    if (ownsInput) {
      setDraft(restored.prompt)
      setFork(restored.forkOf ? { ...restored.forkOf, choice: restoredChoice(restored) } : null)
    }
    if (restored.sessionId === undefined) {
      if (!restored.forkOf) {
        setStored(previous => ({ ...previous, ...restoredChoice(restored) }))
        // Under a pin too, what shows is what this unconfirmed request carries.
        setDraftPick({
          ...(restored.harnessId ? { harnessId: restored.harnessId } : {}),
          ...(restored.model ? { model: restored.model } : {}),
        })
      }
    } else if (restored.model) {
      const { sessionId, model } = restored
      setOverrides(previous => ({ ...previous, [sessionId]: model }))
    }
  }, [pendingKey])

  /**
   * Sends the draft, retries a pending submission with its own requestId, or (`resend`) sends a prompt of the open
   * session again as a new turn with a new requestId, leaving the draft alone.
   */
  const submit = async (
    retry?: PendingSubmission,
    resend?: string,
    queue = false,
    attachmentIds?: string[],
    fileRefs?: FileMention[],
  ): Promise<boolean> => {
    if (sendingRef.current || (!retry && resend === undefined && !draft.trim() && !attachmentIds?.length)) return false
    if (resend !== undefined && (selectedId === null || !resend.trim())) return false
    const override =
      selectedId === null || snapshot.tasks.find(task => task.id === selectedId)?.personal ? undefined : overrides[selectedId]
    const submission: PendingSubmission =
      retry
      ?? (resend !== undefined && selectedId !== null
        ? { requestId: newRequestId(), prompt: resend, sessionId: selectedId, ...(override ? { model: override } : {}) }
        : undefined)
      ?? (selectedId === null
        ? assistantId
          ? { requestId: newRequestId(), prompt: draft.trim(), assistantId }
          : {
              requestId: newRequestId(),
              prompt: draft.trim(),
              mode: choice.mode,
              ...(fork ? { forkOf: { taskId: fork.taskId, upToMessageId: fork.upToMessageId } } : {}),
              ...(choice.harnessId ? { harnessId: choice.harnessId } : {}),
              ...(choice.workspaceId ? { workspaceId: choice.workspaceId } : {}),
              ...(choice.model ? { model: choice.model } : {}),
            }
        : {
            requestId: newRequestId(),
            prompt: draft.trim(),
            sessionId: selectedId,
            ...(override ? { model: override } : {}),
            ...(queue ? { queue: true } : {}),
          })
    if (fileRefs?.length && !retry && resend === undefined) submission.fileRefs = fileRefs
    if (attachmentIds?.length && !retry && resend === undefined) submission.attachmentIds = attachmentIds
    // An uncertain delivery never rebinds a retry to the input currently on screen.
    const origin = requestOrigins.current.get(submission.requestId) ?? {
      epoch: destination.current.epoch,
      consumedDraft: resend === undefined,
    }
    if (!retry) requestOrigins.current.clear()
    requestOrigins.current.set(submission.requestId, origin)
    try {
      writePending(pendingKey, submission)
    } catch {
      requestOrigins.current.delete(submission.requestId)
      setError('无法保存待发送内容。请允许浏览器存储后重试，避免断线时重复提交。')
      return false
    }
    sendingRef.current = true
    setSending(true)
    setPending(submission)
    setSendingMessage(
      submission.queue ? null : { submission, sessionId: submission.sessionId ?? null, state: 'sending', startedAt: Date.now() },
    )
    setError('')
    try {
      const { path, body } = submissionRequest(submission)
      // Full-access sessions start only after a local confirmation; the resend carries the same requestId.
      const result = await withConfirmation(async confirmation => {
        try {
          return await api<{ sessionId?: string; queued?: { id: string } }>(path, {
            method: 'POST',
            body,
            ...(confirmation ? { confirmation } : {}),
          })
        } catch (error) {
          if (error instanceof ApiError && error.code === 'stepup-required') setSendingMessage(null)
          throw error
        }
      })
      const sessionId = submission.sessionId ?? result.sessionId
      if (sessionId === undefined) throw new Error('missing session id')
      setSendingMessage(submission.queue ? null : { submission, sessionId, state: 'accepted', startedAt: Date.now() })
      const foreground =
        mounted.current
        && destination.current.epoch === origin.epoch
        && (submission.sessionId === undefined
          ? destination.current.selectedId === null && destination.current.assistantId === submission.assistantId
          : destination.current.selectedId === submission.sessionId)
      if (foreground) select(sessionId)
      if (mounted.current) onSent(sessionId, submission, { foreground, consumedDraft: origin.consumedDraft })
      requestOrigins.current.delete(submission.requestId)
      writePending(pendingKey, null)
      setPending(null)
      // A resent prompt never came from the composer, so whatever is being drafted stays.
      if (origin.consumedDraft && foreground) setDraft('')
      if (submission.sessionId === undefined && foreground) setFork(null)
      // The pick went with this session, unless another was made while a slow start was waiting.
      if (submission.sessionId === undefined) setDraftPick(current => (current === draftPick ? null : current))
      if (submission.sessionId !== undefined)
        setOverrides(previous => {
          const next = { ...previous }
          delete next[sessionId]
          return next
        })
      await refresh()
      return true
    } catch (cause) {
      const uncertain = isUncertain(cause)
      setSendingMessage(previous =>
        previous?.submission.requestId !== submission.requestId ? previous : uncertain ? { ...previous, state: 'unknown' } : null,
      )
      if (!uncertain) {
        requestOrigins.current.delete(submission.requestId)
        writePending(pendingKey, null)
        setPending(null)
      }
      const handled =
        !uncertain
        && submission.sessionId !== undefined
        && onRefused?.(submission.sessionId, cause, origin.consumedDraft ? undefined : submission.prompt) === true
      // The persistent pending card owns unknown delivery; it is not a confirmed failure.
      setError(uncertain || handled ? '' : inlineError(cause))
      return false
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  return {
    draft,
    setDraft,
    fork,
    setFork,
    pending,
    sending,
    sendingMessage,
    error,
    setError,
    choice,
    updateChoice,
    /** The pin just moved, so a pick made before that says nothing about the new one. */
    forgetDraftPick: () => {
      setDraftPick(null)
    },
    submit,
    resend: (prompt: string) => submit(undefined, prompt),
    override: selectedId === null ? undefined : overrides[selectedId],
    setOverride: (sessionId: string, model: ModelRef | undefined) =>
      setOverrides(previous => {
        const next = { ...previous }
        if (model) next[sessionId] = model
        else delete next[sessionId]
        return next
      }),
  }
}
