import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type AppSnapshot, type ModelRef, type FileMention, type WorktreeStart } from '@latch/protocol'
import {
  api,
  fromInput,
  ApiError,
  inlineError,
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
  worktreeProject,
  type ComposerChoice,
  type DraftPick,
} from '../composerChoice.ts'
import { forkedChoice, type ForkSource } from '../forkChoice.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { saveOfferedPreset } from '../core/offeredHarness.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import {
  abandonSubmission,
  endFlight,
  isFlightKey,
  markFlight,
  readFlight,
  readPendingReason,
  releaseStored,
  unconfirmedReason,
  writePendingReason,
  type SendingMessage,
} from '../core/sendingMessage.ts'

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

const storedOwnsInput = (pending: PendingSubmission, selectedId: string | null): boolean =>
  pending.sessionId === undefined ? selectedId === null : selectedId === pending.sessionId

/**
 * Draft, composer choice and the at-most-one unconfirmed submission of this
 * device. A submission is stored before it is sent and cleared only once the
 * Host answers definitively, so a retry repeats the identical request.
 */
/** This page's unconfirmed submission, also when browser storage cannot hold it (for 设置 › 设备). */
let heldHere: PendingSubmission | null = null
export const heldSubmission = (): PendingSubmission | null => heldHere

export function useSubmission({
  snapshot,
  access,
  selectedId,
  select,
  refresh,
  onSent,
  onRefused,
  onReleased,
}: {
  snapshot: AppSnapshot
  access: Pick<DeviceAccess, 'legacy' | 'local'>
  selectedId: string | null
  select: (id: string | null) => void
  refresh: () => Promise<void>
  onSent: (
    sessionId: string,
    submission: PendingSubmission,
    result: { foreground: boolean; consumedDraft: boolean; memoryRefused?: string },
  ) => void
  /** A definitive refusal; `resent`, a prompt that never sat in the input. Return true when a dedicated recovery UI owns its explanation. */
  onRefused?: (sessionId: string, error: unknown, resent?: string) => boolean | void
  /**
   * The Host says, for certain, that this submission was not delivered: the person released its attachments
   * (`attachment-released`). `restored`: its text is back in the input on screen; otherwise the caller keeps it.
   */
  onReleased?: (submission: PendingSubmission, restored: boolean) => void
}) {
  const deviceId = snapshot.device.id
  const catalog = snapshot.catalog
  const pendingKey = `latch.pending.${location.origin}.${deviceId}`
  const [draft, setDraft] = useState('')
  const [fork, setFork] = useState<ForkDraft | null>(null)
  const [pending, setPending] = useState<PendingSubmission | null>(null)
  useEffect(() => {
    heldHere = pending
    return () => {
      heldHere = null
    }
  }, [pending])
  const [sending, setSending] = useState(false)
  const [sendingMessage, setSendingMessage] = useState<SendingMessage | null>(null)
  /** Why the pending submission is still unconfirmed after this page's last try; '' before one. */
  const [pendingReason, setPendingReason] = useState('')
  /** Another window of this device is sending or retrying the pending submission now. */
  const [sendingElsewhere, setSendingElsewhere] = useState(false)
  const sendingRef = useRef(false)
  const mounted = useRef(true)
  const destination = useRef({ selectedId, epoch: 0 })
  if (destination.current.selectedId !== selectedId) destination.current = { selectedId, epoch: destination.current.epoch + 1 }
  const requestOrigins = useRef(new Map<string, { epoch: number; consumedDraft: boolean }>())
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      destination.current.epoch++
    }
  }, [])
  const [error, setError] = useState('')
  // The code of the refusal the error says, while it still says that one: the composer offers the next step that fits.
  const failed = useRef<{ text: string; code: string } | undefined>(undefined)
  const refuse = (cause: unknown, text = inlineError(cause)) => {
    failed.current = cause instanceof ApiError && text ? { text, code: cause.code } : undefined
    setError(text)
  }
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
  /**
   * The draft starts in a new worktree: a choice for this draft only, so it never carries over to the next session
   * unseen, and it counts only while the draft's project can have one.
   */
  const [worktreePicked, setWorktreePicked] = useState<{ projectId: string | undefined; start: WorktreeStart } | null>(null)
  const worktreeOffered = worktreeProject(catalog, choice, fork !== null) !== undefined
  // A start point names this project's branches and worktrees: it counts only for the project it was picked in.
  const worktree = worktreeOffered && worktreePicked && worktreePicked.projectId === choice.workspaceId ? worktreePicked.start : undefined
  const setWorktree = (start: WorktreeStart | undefined) => {
    setWorktreePicked(start ? { projectId: choice.workspaceId, start } : null)
  }
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
    // A prompt sent again was never the input's text, so it does not take the input over on a reload.
    const owner = stored && fromInput(stored) && storedOwnsInput(stored, selectedId)
    setPending(stored)
    setPendingReason(stored ? readPendingReason(pendingKey, stored.requestId) : '')
    setSendingMessage(
      stored && !stored.queue && !stored.steer
        ? { submission: stored, sessionId: stored.sessionId ?? null, state: 'unknown', startedAt: Date.now() }
        : null,
    )
    if (stored === null) return
    if (owner) {
      setDraft(stored.prompt)
      setFork(stored.forkOf ? { ...stored.forkOf, choice: restoredChoice(stored) } : null)
      setWorktreePicked(
        stored.worktree ? { projectId: stored.workspaceId, start: stored.worktree === true ? { from: 'head' } : stored.worktree } : null,
      )
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

  // Another window's send or retry: no 放弃 here until it ends or its mark runs out.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      clearTimeout(timer)
      const flight = sendingRef.current ? null : readFlight(pendingKey)
      setSendingElsewhere(flight !== null)
      if (flight) timer = setTimeout(check, flight.until - Date.now() + 50)
    }
    check()
    const onStorage = (event: StorageEvent) => {
      if (isFlightKey(event.key, pendingKey)) check()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('storage', onStorage)
    }
  }, [pendingKey])

  // Another window of this device settled what it sent: this one was showing that row from storage.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== pendingKey || sendingRef.current || readPending(pendingKey) !== null) return
      setPending(null)
      setSendingMessage(null)
      setPendingReason('')
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
    if (presetId === undefined) return true
    sendingRef.current = true
    setSending(true)
    setError('')
    try {
      await saveOfferedPreset(presetId)
      return true
    } catch (cause) {
      refuse(cause)
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
    if (!retry && selectedId === null && !(await saveOfferedHarness())) return false
    const override = selectedId === null ? undefined : overrides[selectedId]
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
            resent: true,
            ...(override ? { model: override } : {}),
            ...(clearing.has(selectedId) ? { freshContext: true } : {}),
          }
        : undefined)
      ?? (selectedId === null
        ? {
            requestId: newRequestId(),
            prompt: draft.trim(),
            mode: choice.mode,
            ...(fork ? { forkOf: { taskId: fork.taskId, upToMessageId: fork.upToMessageId } } : {}),
            ...(choice.harnessId ? { harnessId: choice.harnessId } : {}),
            ...(choice.workspaceId ? { workspaceId: choice.workspaceId } : {}),
            ...(service ? { model: service } : choice.model ? { model: choice.model } : {}),
            ...(picks.length ? { config: picks } : {}),
            ...(worktree ? { worktree: worktree.from === 'head' ? (true as const) : worktree } : {}),
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
      // After a reload only the stored submission says where it came from.
      consumedDraft: earlier?.consumedDraft ?? (resend === undefined && fromInput(submission)),
    }
    if (earlier && !storedOwnsInput(submission, destination.current.selectedId)) origin.epoch = earlier.epoch
    if (!retry) requestOrigins.current.clear()
    requestOrigins.current.set(submission.requestId, origin)
    // Another window of this device may have stored its own unconfirmed message meanwhile: that one is shown, and this
    // one is not sent, so the device never holds two.
    const elsewhere = readPending(pendingKey)
    if (elsewhere && elsewhere.requestId !== submission.requestId) {
      requestOrigins.current.delete(submission.requestId)
      setPending(elsewhere)
      setSendingMessage(
        elsewhere.queue || elsewhere.steer
          ? null
          : { submission: elsewhere, sessionId: elsewhere.sessionId ?? null, state: 'unknown', startedAt: Date.now() },
      )
      return false
    }
    try {
      writePending(pendingKey, submission)
    } catch {
      requestOrigins.current.delete(submission.requestId)
      setError('无法保存待发送内容。请允许浏览器存储后重试，避免断线时重复提交。')
      return false
    }
    sendingRef.current = true
    markFlight(pendingKey, submission.requestId)
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
      // A Harness saved before confirmations is confirmed on this Mac at its first start; the same request goes again.
      const result = await withConfirmation(confirmation =>
        api<{ sessionId?: string; queued?: { id: string }; memoryRefused?: string }>(path, {
          method: 'POST',
          body,
          ...(confirmation ? { confirmation } : {}),
        }),
      )
      const sessionId = submission.sessionId ?? result.sessionId
      if (sessionId === undefined) throw new Error('missing session id')
      setSendingMessage(submission.queue || submission.steer ? null : { submission, sessionId, state: 'accepted', startedAt: Date.now() })
      const foreground =
        mounted.current && destination.current.epoch === origin.epoch && destination.current.selectedId === (submission.sessionId ?? null)
      if (foreground) select(sessionId)
      if (mounted.current)
        onSent(sessionId, submission, {
          foreground,
          consumedDraft: origin.consumedDraft,
          ...(result.memoryRefused ? { memoryRefused: result.memoryRefused } : {}),
        })
      requestOrigins.current.delete(submission.requestId)
      releaseStored(pendingKey, submission.requestId)
      setPending(null)
      setPendingReason('')
      // A resent prompt never came from the composer, so whatever is being drafted stays.
      if (origin.consumedDraft && foreground) setDraft('')
      if (submission.sessionId === undefined && foreground) setFork(null)
      if (submission.sessionId === undefined) setWorktreePicked(null)
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
      const reason = unconfirmedReason(cause)
      const uncertain = reason !== null
      setSendingMessage(previous =>
        previous?.submission.requestId !== submission.requestId ? previous : uncertain ? { ...previous, state: 'unknown' } : null,
      )
      if (!uncertain) {
        requestOrigins.current.delete(submission.requestId)
        releaseStored(pendingKey, submission.requestId)
        setPending(null)
      }
      setPendingReason(reason ?? '')
      if (uncertain) writePendingReason(pendingKey, submission.requestId, reason)
      if (!uncertain && cause instanceof ApiError && cause.code === 'attachment-released' && fromInput(submission)) {
        const restored = mounted.current && storedOwnsInput(submission, destination.current.selectedId)
        if (restored) setDraft(previous => (previous.trim() ? previous : submission.prompt))
        onReleased?.(submission, restored)
      }
      const handled =
        !uncertain
        && submission.sessionId !== undefined
        && onRefused?.(submission.sessionId, cause, origin.consumedDraft ? undefined : submission.prompt) === true
      // The pending card owns unknown delivery and says why; it is not a confirmed failure.
      refuse(cause, uncertain || handled ? '' : inlineError(cause))
      return false
    } finally {
      endFlight(pendingKey, submission.requestId)
      sendingRef.current = false
      setSending(false)
    }
  }

  /** Lets go of the unconfirmed submission on this device, outside a send; a retry never changes its requestId. */
  const release = (submission: PendingSubmission) => {
    requestOrigins.current.delete(submission.requestId)
    setPending(current => (current?.requestId === submission.requestId ? null : current))
    setSendingMessage(previous => (previous?.submission.requestId === submission.requestId ? null : previous))
    setPendingReason('')
  }

  /**
   * 放弃这次提交: this device stops waiting for the Host's answer. The text goes back into the input when that input is on
   * screen (`restored`); otherwise the caller keeps it as that session's draft. Sending it again is a new message.
   */
  const abandon = (): { sessionId: string | null; text: string; restored: boolean } | null => {
    if (sendingRef.current || pending === null || readFlight(pendingKey)?.requestId === pending.requestId) return null
    const home = abandonSubmission(pendingKey, pending)
    release(pending)
    const restored = storedOwnsInput(pending, destination.current.selectedId)
    if (restored) setDraft(previous => (previous.trim() ? previous : home.text))
    return { ...home, restored }
  }

  /** The Host lists this submission in its session: settled as sent, as if the retry had been answered. */
  const delivered = (submission: PendingSubmission): boolean => {
    if (sendingRef.current || pending?.requestId !== submission.requestId || submission.sessionId === undefined) return false
    abandonSubmission(pendingKey, submission)
    release(submission)
    const sessionId = submission.sessionId
    if (storedOwnsInput(submission, destination.current.selectedId))
      setDraft(previous => (previous.trim() === submission.prompt.trim() ? '' : previous))
    if (submission.model)
      setOverrides(previous => {
        const next = { ...previous }
        delete next[sessionId]
        return next
      })
    if (submission.freshContext) setClearing(previous => without(previous, sessionId))
    return true
  }

  return {
    draft,
    setDraft,
    fork,
    setFork,
    pending,
    pendingReason,
    sendingElsewhere,
    abandon,
    delivered,
    sending,
    sendingMessage,
    error,
    /** The Host's code for the refusal `error` says, while it says it. */
    errorCode: failed.current?.text === error ? failed.current.code : undefined,
    setError,
    choice,
    /** The draft starts in a worktree of its project, from this start point. */
    worktree,
    setWorktree,
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
