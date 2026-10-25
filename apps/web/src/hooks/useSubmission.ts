import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSnapshot, ModelRef } from '@latch/protocol'
import {
  api,
  inlineError,
  isUncertain,
  newRequestId,
  readPending,
  submissionRequest,
  writePending,
  type PendingSubmission,
} from '../core/api.ts'
import { readChoice, resolveChoice, writeChoice, type ComposerChoice } from '../composerChoice.ts'
import { withConfirmation } from '../core/confirmations.ts'
import type { DeviceAccess } from '../core/permissions.ts'

/**
 * Draft, composer choice and the at-most-one unconfirmed submission of this
 * device. A submission is stored before it is sent and cleared only once the
 * Host answers definitively, so a retry repeats the identical request.
 */
export function useSubmission({
  snapshot,
  access,
  selectedId,
  select,
  refresh,
  onSent,
  onRefused,
}: {
  snapshot: AppSnapshot
  access: Pick<DeviceAccess, 'legacy' | 'local'>
  selectedId: string | null
  select: (id: string | null) => void
  refresh: () => Promise<void>
  onSent: (sessionId: string, submission: PendingSubmission) => void
  /** A definitive refusal for an existing session, e.g. a session that no longer accepts input. */
  onRefused?: (sessionId: string, error: unknown) => void
}) {
  const deviceId = snapshot.device.id
  const catalog = snapshot.catalog
  const pendingKey = `harness-link.pending.${location.origin}.${deviceId}`
  const [draft, setDraft] = useState('')
  const [fork, setFork] = useState<(NonNullable<PendingSubmission['forkOf']> & { title?: string }) | null>(null)
  const [pending, setPending] = useState<PendingSubmission | null>(null)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [error, setError] = useState('')
  const [stored, setStored] = useState<Partial<ComposerChoice> | null>(() => readChoice(deviceId))
  const { legacy, local } = access
  const choice = useMemo(() => resolveChoice(catalog, stored, { legacy, local }), [catalog, stored, legacy, local])
  /** Model switches chosen for existing sessions; sent with that session's next prompt. */
  const [overrides, setOverrides] = useState<Record<string, ModelRef>>({})

  const updateChoice = (patch: Partial<ComposerChoice>) => {
    // Keep the remembered model when a harness without host models is picked, so switching back restores it.
    const next = { ...stored, ...choice, ...patch }
    setStored(next)
    writeChoice(deviceId, resolveChoice(catalog, next, { legacy, local }))
  }

  useEffect(() => {
    const restored = readPending(pendingKey)
    setPending(restored)
    if (restored === null) return
    setDraft(restored.prompt)
    setFork(restored.forkOf ?? null)
    if (restored.sessionId === undefined) {
      setStored(previous => ({
        ...previous,
        ...(restored.mode ? { mode: restored.mode } : {}),
        ...(restored.harnessId ? { harnessId: restored.harnessId } : {}),
        ...(restored.workspaceId ? { workspaceId: restored.workspaceId } : {}),
        ...(restored.model ? { model: restored.model } : {}),
      }))
    } else if (restored.model) {
      const { sessionId, model } = restored
      setOverrides(previous => ({ ...previous, [sessionId]: model }))
    }
  }, [pendingKey])

  /**
   * Sends the draft, retries a pending submission with its own requestId, or (`resend`) sends a prompt of the open
   * session again as a new turn with a new requestId, leaving the draft alone.
   */
  const submit = async (retry?: PendingSubmission, resend?: string): Promise<void> => {
    if (sendingRef.current || (!retry && resend === undefined && !draft.trim())) return
    if (resend !== undefined && (selectedId === null || !resend.trim())) return
    const override = selectedId === null ? undefined : overrides[selectedId]
    const submission: PendingSubmission =
      retry
      ?? (resend !== undefined && selectedId !== null
        ? { requestId: newRequestId(), prompt: resend, sessionId: selectedId, ...(override ? { model: override } : {}) }
        : undefined)
      ?? (selectedId === null
        ? {
            requestId: newRequestId(),
            prompt: draft.trim(),
            mode: choice.mode,
            ...(fork ? { forkOf: { taskId: fork.taskId, upToMessageId: fork.upToMessageId } } : {}),
            ...(choice.harnessId ? { harnessId: choice.harnessId } : {}),
            ...(choice.workspaceId ? { workspaceId: choice.workspaceId } : {}),
            ...(choice.model ? { model: choice.model } : {}),
          }
        : { requestId: newRequestId(), prompt: draft.trim(), sessionId: selectedId, ...(override ? { model: override } : {}) })
    try {
      writePending(pendingKey, submission)
    } catch {
      setError('无法保存待发送内容。请允许浏览器存储后重试，避免断线时重复提交。')
      return
    }
    sendingRef.current = true
    setSending(true)
    setPending(submission)
    setError('')
    try {
      const { path, body } = submissionRequest(submission)
      // Full-access sessions start only after a local confirmation; the resend carries the same requestId.
      const result = await withConfirmation(confirmation =>
        api<{ sessionId?: string }>(path, { method: 'POST', body, ...(confirmation ? { confirmation } : {}) }),
      )
      const sessionId = submission.sessionId ?? result.sessionId
      if (sessionId === undefined) throw new Error('missing session id')
      select(sessionId)
      onSent(sessionId, submission)
      writePending(pendingKey, null)
      setPending(null)
      // A resent prompt never came from the composer, so whatever is being drafted stays.
      if (resend === undefined) setDraft('')
      if (submission.sessionId === undefined) setFork(null)
      if (submission.sessionId !== undefined)
        setOverrides(previous => {
          const next = { ...previous }
          delete next[sessionId]
          return next
        })
      await refresh()
    } catch (cause) {
      const uncertain = isUncertain(cause)
      if (!uncertain) {
        writePending(pendingKey, null)
        setPending(null)
      }
      if (!uncertain && submission.sessionId !== undefined) onRefused?.(submission.sessionId, cause)
      setError(uncertain ? '尚未确认是否发送成功。请重试这次提交；同一个请求不会重复创建任务。' : inlineError(cause))
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
    error,
    setError,
    choice,
    updateChoice,
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
