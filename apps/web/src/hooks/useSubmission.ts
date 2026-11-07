import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AGENT_PRESETS, type AppSnapshot, type ModelRef, type FileMention } from '@latch/protocol'
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
import {
  draftStart,
  findHarness,
  harnessPicks,
  pinnedChoice,
  readChoice,
  resolveChoice,
  servicePick,
  startConfig,
  writeChoice,
  type ComposerChoice,
  type DraftPick,
} from '../composerChoice.ts'
import { forkedChoice, type ForkSource } from '../forkChoice.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import type { SendingMessage } from '../core/sendingMessage.ts'

/**
 * A new session forked from another. `choice`: what it borrows from its source and what the person picks in the draft,
 * for this draft only; the source's engine may be one the person never picked here, so it stays out of what this device
 * remembers. `source`: what the source ran with, kept where the draft's Harness offers it.
 */
export type ForkDraft = NonNullable<PendingSubmission['forkOf']> & {
  title?: string
  choice?: Partial<ComposerChoice>
  source?: ForkSource
}

const restoredChoice = (pending: PendingSubmission): Partial<ComposerChoice> => ({
  ...(pending.mode ? { mode: pending.mode } : {}),
  ...(pending.harnessId ? { harnessId: pending.harnessId } : {}),
  ...(pending.workspaceId ? { workspaceId: pending.workspaceId } : {}),
  ...(pending.model ? { model: pending.model } : {}),
  ...(pending.config?.length ? { config: Object.fromEntries(pending.config.map(pick => [pick.configId, pick.value])) } : {}),
})

const without = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  if (!set.has(id)) return set
  const next = new Set(set)
  next.delete(id)
  return next
}

const storedOwnsInput = (pending: PendingSubmission, selectedId: string | null, assistantId: string | undefined): boolean =>
  pending.sessionId === undefined ? selectedId === null && assistantId === pending.assistantId : selectedId === pending.sessionId

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
  const remembered = useMemo(() => resolveChoice(catalog, start), [catalog, start])
  const borrowed = fork?.choice
  const forkSource = fork?.source
  const forked = useMemo(
    () => (borrowed ? forkedChoice(catalog, start, borrowed, forkSource) : undefined),
    [catalog, start, borrowed, forkSource],
  )
  const choice = forked?.choice ?? remembered
  /** Model switches chosen for existing sessions; sent with that session's next prompt. */
  const [overrides, setOverrides] = useState<Record<string, ModelRef>>({})
  /** Sessions whose next prompt starts a new context, as chosen on this device; nothing is sent until that prompt. */
  const [clearing, setClearing] = useState<ReadonlySet<string>>(() => new Set())

  const updateChoice = (patch: Partial<ComposerChoice>) => {
    if (fork?.choice) {
      const forkPatch = patch
      setFork(previous => {
        if (!previous?.choice) return previous
        // A person picking another place or Harness leaves the source's mode behind, and another Harness takes what
        // maps from the source afresh: the picks made in this draft were for the one before.
        const { mode: _source, ...rest } = previous.choice
        const { config: _config, model: _model, otherPicks: _others, ...place } = rest
        const moved = forkPatch.harnessId !== undefined && forkPatch.harnessId !== previous.choice.harnessId
        const base = moved ? place : forkPatch.workspaceId || forkPatch.harnessId ? rest : previous.choice
        return { ...previous, choice: { ...base, ...forkPatch } }
      })
      // What is picked in a fork's draft is for that draft; only a Harness or project chosen in it is remembered.
      const { config: _config, model: _model, otherPicks: _others, ...remember } = patch
      if (!Object.keys(remember).length) return
      patch = remember
    }
    // A Harness's options are its own: another Harness starts on what was last picked for it, else its defaults.
    if (patch.harnessId !== undefined && patch.harnessId !== remembered.harnessId && !('config' in patch))
      patch = { ...patch, ...harnessPicks(remembered, patch.harnessId) }
    if (pinnedChoice(catalog, { legacy, local })) {
      const { harnessId, model, ...rest } = patch
      setDraftPick(previous => ({ ...previous, ...(harnessId ? { harnessId } : {}), ...(model ? { model } : {}) }))
      const kept = { ...stored, ...rest }
      setStored(kept)
      writeChoice(deviceId, { ...kept, harnessId: harnessId ?? remembered.harnessId, mode: kept.mode ?? remembered.mode })
      return
    }
    // Keep the remembered model when a harness without host models is picked, so switching back restores it.
    const next = { ...stored, ...remembered, ...patch }
    setStored(next)
    writeChoice(deviceId, resolveChoice(catalog, next))
  }

  useEffect(() => {
    const stored = readPending(pendingKey)
    const owner = stored && storedOwnsInput(stored, selectedId, assistantId)
    setPending(stored)
    setSendingMessage(
      stored && !stored.queue && !stored.steer
        ? { submission: stored, sessionId: stored.sessionId ?? null, state: 'unknown', startedAt: Date.now() }
        : null,
    )
    if (stored === null) return
    if (owner) {
      setDraft(stored.prompt)
      setFork(stored.forkOf ? { ...stored.forkOf, choice: restoredChoice(stored) } : null)
    }
    if (stored.sessionId === undefined) {
      if (!stored.forkOf) {
        setStored(previous => ({ ...previous, ...restoredChoice(stored) }))
        // Under a pin too, what shows is what this unconfirmed request carries.
        setDraftPick({
          ...(stored.harnessId ? { harnessId: stored.harnessId } : {}),
          ...(stored.model ? { model: stored.model } : {}),
        })
      }
    } else if (stored.model) {
      const { sessionId, model } = stored
      setOverrides(previous => ({ ...previous, [sessionId]: model }))
    }
  }, [pendingKey])

  // Another window of this device settled what it sent: this one was showing that row from storage.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== pendingKey || sendingRef.current || readPending(pendingKey) !== null) return
      setPending(null)
      setSendingMessage(null)
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
    }
  }, [pendingKey])

  /**
   * A preset chosen before it has a definition gets one now. It runs nothing, and comes before the submission is stored,
   * so a retry repeats a request the Host can accept. Saved by another window meanwhile is saved.
   */
  const saveOfferedHarness = async (): Promise<boolean> => {
    const presetId = catalog?.harnesses.find(item => item.id === choice.harnessId)?.offer?.presetId
    const preset = AGENT_PRESETS.find(item => item.id === presetId)
    if (!preset) return true
    sendingRef.current = true
    setSending(true)
    setError('')
    try {
      const body = {
        id: preset.id,
        name: preset.name,
        presetId: preset.id,
        command: preset.command,
        args: preset.args,
        env: {},
        enabled: true,
      }
      await api('agents', { method: 'POST', body })
      return true
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'agent-exists') return true
      setError(inlineError(cause))
      return false
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  /**
   * Sends the draft, retries a pending submission with its own requestId, or (`resend`) sends a prompt of the open
   * session again as a new turn with a new requestId, leaving the draft alone. `followUp`: the session runs, so the draft
   * waits in the queue, or goes into the running turn when its harness takes that.
   */
  const submit = async (
    retry?: PendingSubmission,
    resend?: string,
    followUp?: 'queue' | 'steer',
    attachmentIds?: string[],
    fileRefs?: FileMention[],
  ): Promise<boolean> => {
    if (sendingRef.current || (!retry && resend === undefined && !draft.trim() && !attachmentIds?.length)) return false
    if (resend !== undefined && (selectedId === null || !resend.trim())) return false
    if (!retry && selectedId === null && !assistantId && !(await saveOfferedHarness())) return false
    const override =
      selectedId === null || snapshot.tasks.find(task => task.id === selectedId)?.personal ? undefined : overrides[selectedId]
    const harness = findHarness(catalog, choice.harnessId)
    // A model from a service replaces the Harness's own model pick.
    const service = servicePick(catalog, harness, choice.config)
    const picks = startConfig(harness, choice.config).filter(
      pick => !service || harness?.catalogue?.options.find(option => option.id === pick.configId)?.category !== 'model',
    )
    const submission: PendingSubmission =
      retry
      ?? (resend !== undefined && selectedId !== null
        ? {
            requestId: newRequestId(),
            prompt: resend,
            sessionId: selectedId,
            ...(override ? { model: override } : {}),
            ...(clearing.has(selectedId) ? { freshContext: true } : {}),
          }
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
              ...(service ? { model: service } : choice.model ? { model: choice.model } : {}),
              ...(picks.length ? { config: picks } : {}),
            }
        : {
            requestId: newRequestId(),
            prompt: draft.trim(),
            sessionId: selectedId,
            ...(override ? { model: override } : {}),
            ...(followUp === 'queue'
              ? { queue: true }
              : followUp === 'steer'
                ? { steer: true }
                : clearing.has(selectedId)
                  ? { freshContext: true }
                  : {}),
          })
    if (fileRefs?.length && !retry && resend === undefined) submission.fileRefs = fileRefs
    if (attachmentIds?.length && !retry && resend === undefined) submission.attachmentIds = attachmentIds
    // An uncertain delivery never rebinds a retry to the input currently on screen.
    const earlier = requestOrigins.current.get(submission.requestId)
    // Unless the retry was pressed from where it was sent, which is the only place that offers it.
    const origin = {
      epoch: destination.current.epoch,
      consumedDraft: earlier?.consumedDraft ?? resend === undefined,
    }
    if (earlier && !storedOwnsInput(submission, destination.current.selectedId, destination.current.assistantId))
      origin.epoch = earlier.epoch
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
      submission.queue || submission.steer
        ? null
        : { submission, sessionId: submission.sessionId ?? null, state: 'sending', startedAt: Date.now() },
    )
    setError('')
    try {
      const { path, body } = submissionRequest(submission)
      const result = await api<{ sessionId?: string; queued?: { id: string } }>(path, { method: 'POST', body })
      const sessionId = submission.sessionId ?? result.sessionId
      if (sessionId === undefined) throw new Error('missing session id')
      setSendingMessage(submission.queue || submission.steer ? null : { submission, sessionId, state: 'accepted', startedAt: Date.now() })
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
      if (submission.freshContext) setClearing(previous => without(previous, sessionId))
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
    /** What a fork's draft could not take from its source as it was. */
    forkMissed: forked?.missed ?? [],
    updateChoice,
    /** The pin just moved, so a pick made before that says nothing about the new one. */
    forgetDraftPick: () => {
      setDraftPick(null)
    },
    submit,
    resend: (prompt: string) => submit(undefined, prompt),
    /** The open session's next prompt starts a new context. */
    clearing: selectedId !== null && clearing.has(selectedId),
    setClearing: (sessionId: string, on: boolean) =>
      setClearing(previous =>
        on ? (previous.has(sessionId) ? previous : new Set([...previous, sessionId])) : without(previous, sessionId),
      ),
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
