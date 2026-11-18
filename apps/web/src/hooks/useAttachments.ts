import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AttachmentCapabilities, AttachmentRef, AttachmentSelection } from '@latch/protocol'
import { api, ApiError, ApiTimeoutError, errorMessage, MessageError, newRequestId, NoAnswerError, uploadAttachment } from '../core/api.ts'
import { looksLikeImage, SHRINK_INPUT_BYTES, ShrinkRefusal, shrinkImage } from './imageShrink.ts'

export interface DraftAttachment {
  key: string
  file: File
  requestId: string
  secretAcknowledged?: true
  pastedText?: string
  ref?: AttachmentRef
  /** `refused`: the Host will not take this file as it is (type, size, capability); trying again cannot help. */
  status: 'uploading' | 'ready' | 'failed' | 'refused' | 'confirm'
  progress: number
  error?: string
  /** An image over the image limit: shrunk on this device before it is uploaded. */
  shrink?: true
  /** The original's size once `file` is its shrunk copy. */
  shrunkFrom?: number
  /**
   * 从这里编辑: an attachment of a sent message, which the Host copies into a draft of this device; `file` holds its bytes
   * once the copy is read back, for the preview.
   */
  source?: AttachmentRef
}
/** The size of what goes: the copy's, before its bytes are read back. */
export const draftSize = (item: DraftAttachment): number => item.ref?.size ?? item.source?.size ?? item.file.size

/** A sent attachment copied as this device's draft, and its bytes read back for the preview. */
async function reuseAttachment(
  source: AttachmentRef,
  body: { requestId: string; selection: AttachmentSelection; sessionId?: string; secretAcknowledged?: true },
  signal: AbortSignal,
): Promise<{ ref: AttachmentRef; file: File }> {
  const { attachment: ref } = await api<{ attachment: AttachmentRef }>(`attachments/${encodeURIComponent(source.id)}/reuse`, {
    method: 'POST',
    body,
    signal,
  })
  const { file } = await api<{ file: { handle?: unknown } }>(`attachments/${encodeURIComponent(ref.id)}/resolve`, {
    method: 'POST',
    signal,
  })
  if (typeof file?.handle !== 'string') throw new MessageError('附件响应无效。')
  const bytes = await api<ArrayBuffer>(`attachments/${encodeURIComponent(file.handle)}/content`, {
    response: 'bytes',
    signal,
    timeoutMs: 60_000,
  })
  return { ref, file: new File([bytes], ref.name, { type: ref.kind === 'image' ? ref.mime : 'text/plain' }) }
}

const IMAGE_BYTES = 5 * 1024 * 1024
const FILE_BYTES = 25 * 1024 * 1024
/**
 * Answers that hold for this file however often it is sent: its type, its size, or what the Harness takes. By code, not
 * status: `attachment-incomplete` is a 400 that a retry fixes.
 */
const REFUSED = new Set([
  'attachment-invalid',
  'attachment-too-large',
  'attachment-type-unsupported',
  'attachment-image-unsupported',
  'attachment-image-invalid',
  'attachment-text-invalid',
  'attachment-text-unsupported',
  'attachment-text-too-large',
  'attachments-unsupported',
])
/** Whether the Host refused this file for good, so only removing it helps. */
export const refusedUpload = (cause: unknown): boolean => cause instanceof ApiError && REFUSED.has(cause.code)

export const sizeText = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

/** The limits the Host states for what this composer may attach, in a short line; empty when nothing can be attached. */
export function attachmentLimits(caps: AttachmentCapabilities | undefined): string {
  if (!caps || (!caps.images && !caps.text)) return ''
  const file = caps.fileBytes ?? FILE_BYTES
  return [
    caps.images ? `图片 ${sizeText(Math.min(caps.imageBytes ?? IMAGE_BYTES, file))} 内` : '',
    caps.text ? `文字文件 ${sizeText(Math.min(caps.textBytes, file))} 内` : '',
    '每条 8 个',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The largest file the Host could take under these capabilities; undefined while they are not known. */
function largestAccepted(caps: AttachmentCapabilities | undefined): number | undefined {
  if (!caps) return undefined
  const file = caps.fileBytes ?? FILE_BYTES
  return Math.min(file, Math.max(caps.images ? (caps.imageBytes ?? IMAGE_BYTES) : 0, caps.text ? caps.textBytes : 0))
}

/** The image limit this connection states, when an image over it can be shrunk instead of refused. */
export function shrinkLimit(
  file: { name: string; size: number; type?: string },
  caps: AttachmentCapabilities | undefined,
): number | undefined {
  if (!caps?.images || !looksLikeImage(file) || file.size > SHRINK_INPUT_BYTES) return undefined
  const limit = Math.min(caps.imageBytes ?? IMAGE_BYTES, caps.fileBytes ?? FILE_BYTES)
  return file.size > limit ? limit : undefined
}

/**
 * Why this file is not added before it is uploaded: empty, a Harness that takes no attachments at all, or larger than
 * anything it takes. Undefined when the Host decides.
 */
export function addRefusal(
  file: { name: string; size: number; type?: string },
  caps: AttachmentCapabilities | undefined,
): string | undefined {
  if (!file.size) return '空文件不能添加。'
  if (caps && !caps.images && !caps.text) return caps.reason ?? '这个 Harness 不接收附件。'
  if (shrinkLimit(file, caps) !== undefined) return undefined
  const largest = largestAccepted(caps) ?? FILE_BYTES
  if (file.size > largest)
    return `「${file.name}」超过 ${sizeText(largest)}，没有添加。${attachmentLimits(caps) ? `可以添加：${attachmentLimits(caps)}。` : ''}`
  return undefined
}

interface CapabilityReadFailure {
  text: string
  noAnswer: boolean
}

/** A connection notice covers unanswered capability reads. An attempted attachment operation owns its own feedback. */
export function attachmentDraftError(
  operationError: string,
  readFailure: CapabilityReadFailure | undefined,
  connectionReported: boolean,
): string {
  if (operationError) return operationError
  if (!readFailure || (connectionReported && readFailure.noAnswer)) return ''
  return readFailure.text
}

/** Files remain immutable for a request ID; the Host is the authority for type and capability checks. */
export function useAttachments({
  enabled,
  selection,
  sessionId,
  locked,
  revision = '',
  connectionReported = false,
  heldBack,
  heldRefs = false,
}: {
  enabled: boolean
  selection: AttachmentSelection
  sessionId?: string
  locked: boolean
  /** Changes when what the Harness takes may have changed (it started, or was tested): capabilities are read again. */
  revision?: string
  /** The composer already shows the interruption and its connection retry. */
  connectionReported?: boolean
  /** Why what is attached cannot go with the message being written now, said before sending. */
  heldBack?: string
  /** File references in the text, which `heldBack` also holds back. */
  heldRefs?: boolean
}) {
  const [items, setItems] = useState<DraftAttachment[]>([])
  const [caps, setCaps] = useState<AttachmentCapabilities>()
  const [checking, setChecking] = useState(false)
  /** Why the button does nothing, shown when it is pressed (there is no hover on a touch screen). */
  const [note, setNote] = useState('')
  const [noteDetail, setNoteDetail] = useState('')
  const [error, setError] = useState('')
  const [readFailure, setReadFailure] = useState<CapabilityReadFailure>()
  const [preparing, setPreparing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const state = useRef(items)
  const jobs = useRef(new Map<string, { controller: AbortController; promise: Promise<void> }>())
  const generation = useRef(0)
  const update = (change: (previous: DraftAttachment[]) => DraftAttachment[]) => {
    state.current = change(state.current)
    setItems(state.current)
  }
  const context = JSON.stringify({ selection, ...(sessionId ? { sessionId } : {}) })
  const reset = (published = false) => {
    generation.current++
    for (const job of jobs.current.values()) job.controller.abort()
    jobs.current.clear()
    if (!published)
      for (const item of state.current) if (item.ref) void api(`attachments/${item.ref.id}`, { method: 'DELETE' }).catch(() => {})
    update(() => [])
    setPreparing(false)
    setDragging(false)
    setError('')
    setNote('')
  }
  const known = useRef(context)
  useEffect(() => {
    // Capabilities and any refusal belong to the selection they were read for.
    if (known.current !== context) {
      setCaps(undefined)
      setReadFailure(undefined)
    }
    known.current = context
    setNote('')
    const read = enabled && !connectionReported
    setChecking(read)
    if (!read) {
      if (connectionReported) setReadFailure(previous => (previous?.noAnswer ? undefined : previous))
      return
    }

    const controller = new AbortController()
    void api<{ capabilities: AttachmentCapabilities }>('attachments/capabilities', {
      method: 'POST',
      body: JSON.parse(context) as object,
      signal: controller.signal,
    })
      .then(result => {
        if (controller.signal.aborted) return
        setCaps(result.capabilities)
        setReadFailure(undefined)
      })
      .catch(cause => {
        if (controller.signal.aborted) return
        setCaps(undefined)
        setReadFailure({ text: errorMessage(cause), noAnswer: cause instanceof NoAnswerError || cause instanceof ApiTimeoutError })
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false)
      })
    return () => controller.abort()
  }, [enabled, context, revision, connectionReported])
  const scope = sessionId ?? 'new'
  const previousContext = useRef(scope)
  useLayoutEffect(() => {
    if (scope !== previousContext.current && !locked) {
      reset()
      previousContext.current = scope
    }
  }, [scope, locked])
  useEffect(
    () => () => {
      generation.current++
      for (const job of jobs.current.values()) job.controller.abort()
    },
    [],
  )
  const start = (key: string, acknowledged = false) => {
    const item = state.current.find(item => item.key === key)
    if (!item || jobs.current.has(key)) return
    const acknowledgedSecret = acknowledged || item.secretAcknowledged === true
    const controller = new AbortController(),
      current = generation.current
    if (item.source) {
      const controller = new AbortController(),
        current = generation.current
      update(items =>
        items.map(entry =>
          entry.key === key
            ? {
                ...entry,
                ...(acknowledged ? { secretAcknowledged: true as const } : {}),
                status: 'uploading',
                error: undefined,
                progress: 0,
              }
            : entry,
        ),
      )
      const promise = reuseAttachment(
        item.source,
        {
          requestId: item.requestId,
          selection,
          ...(sessionId ? { sessionId } : {}),
          ...(acknowledged || item.secretAcknowledged ? { secretAcknowledged: true as const } : {}),
        },
        controller.signal,
      )
        .then(({ ref, file }) => {
          if (current !== generation.current || !state.current.some(entry => entry.key === key)) {
            void api(`attachments/${ref.id}`, { method: 'DELETE' }).catch(() => {})
            return
          }
          update(items => items.map(entry => (entry.key === key ? { ...entry, ref, file, status: 'ready', progress: 1 } : entry)))
        })
        .catch(cause => {
          if (current !== generation.current) return
          const confirm = cause instanceof ApiError && cause.code === 'attachment-secret'
          // The sent one is gone, or this device may no longer read it: only removing helps.
          const gone = cause instanceof ApiError && (cause.code === 'attachment-missing' || cause.status === 403)
          update(items =>
            items.map(entry =>
              entry.key === key
                ? {
                    ...entry,
                    status: confirm ? 'confirm' : gone || refusedUpload(cause) ? 'refused' : 'failed',
                    error: controller.signal.aborted ? '已取消，可以重试。' : errorMessage(cause),
                  }
                : entry,
            ),
          )
        })
        .finally(() => {
          if (jobs.current.get(key)?.controller === controller) jobs.current.delete(key)
        })
      jobs.current.set(key, { controller, promise })
      return
    }
    const limit = item.shrink && shrinkLimit(item.file, caps)
    if (limit) {
      update(items => items.map(entry => (entry.key === key ? { ...entry, status: 'uploading', error: undefined, progress: 0 } : entry)))
      const promise = shrinkImage(item.file, limit, controller.signal, sizeText(limit)).then(
        file => {
          if (current !== generation.current || jobs.current.get(key)?.controller !== controller) return
          jobs.current.delete(key)
          update(items =>
            items.map(entry => (entry.key === key ? { ...entry, file, shrink: undefined, shrunkFrom: item.file.size } : entry)),
          )
          start(key, acknowledged)
          return jobs.current.get(key)?.promise
        },
        cause => {
          if (jobs.current.get(key)?.controller === controller) jobs.current.delete(key)
          if (current !== generation.current) return
          update(items =>
            items.map(entry =>
              entry.key === key
                ? cause instanceof ShrinkRefusal
                  ? { ...entry, status: 'refused', error: cause.message }
                  : { ...entry, status: 'failed', error: controller.signal.aborted ? '已取消，可以重试。' : errorMessage(cause) }
                : entry,
            ),
          )
        },
      )
      jobs.current.set(key, { controller, promise })
      return
    }
    update(items =>
      items.map(entry =>
        entry.key === key
          ? {
              ...entry,
              ...(acknowledgedSecret ? { secretAcknowledged: true as const } : {}),
              status: 'uploading',
              error: undefined,
              progress: 0,
            }
          : entry,
      ),
    )
    const promise = uploadAttachment(
      item.file,
      {
        requestId: item.requestId,
        name: item.file.name,
        size: item.file.size,
        selection,
        ...(sessionId ? { sessionId } : {}),
        ...(acknowledgedSecret ? { secretAcknowledged: true } : {}),
      },
      {
        signal: controller.signal,
        onProgress: (loaded, total) => {
          if (current === generation.current)
            update(items => items.map(entry => (entry.key === key ? { ...entry, progress: total ? loaded / total : 0 } : entry)))
        },
      },
    )
      .then(ref => {
        if (current !== generation.current || !state.current.some(item => item.key === key)) {
          void api(`attachments/${ref.id}`, { method: 'DELETE' }).catch(() => {})
          return
        }
        update(items => items.map(entry => (entry.key === key ? { ...entry, ref, status: 'ready', progress: 1 } : entry)))
      })
      .catch(cause => {
        if (current !== generation.current) return
        const confirm = cause instanceof ApiError && cause.code === 'attachment-secret'
        const refused = !controller.signal.aborted && refusedUpload(cause)
        update(items =>
          items.map(entry =>
            entry.key === key
              ? {
                  ...entry,
                  status: confirm ? 'confirm' : refused ? 'refused' : 'failed',
                  error: controller.signal.aborted ? '上传已取消，可以重试。' : errorMessage(cause),
                }
              : entry,
          ),
        )
      })
      .finally(() => {
        if (jobs.current.get(key)?.controller === controller) jobs.current.delete(key)
      })
    jobs.current.set(key, { controller, promise })
  }
  const add = (files: File[], pastedText?: string) => {
    if (!enabled || locked || preparing) return
    if (state.current.length + files.length > 8) {
      setError('每条消息最多添加 8 个附件。')
      return
    }
    const accepted: DraftAttachment[] = []
    setNote('')
    for (const file of files) {
      const refusal = addRefusal(file, caps)
      if (refusal) {
        setError(refusal)
        continue
      }
      accepted.push({
        key: crypto.randomUUID(),
        requestId: newRequestId(),
        file,
        status: 'uploading',
        progress: 0,
        ...(shrinkLimit(file, caps) === undefined ? {} : { shrink: true as const }),
        ...(pastedText === undefined ? {} : { pastedText }),
      })
    }
    update(items => [...items, ...accepted])
    for (const item of accepted) start(item.key)
  }
  /** 从这里编辑: a sent message's attachments, copied by the Host as drafts of this device. */
  const reuse = (refs: readonly AttachmentRef[]) => {
    if (!enabled || locked || !refs.length) return
    const room = Math.max(0, 8 - state.current.length)
    const accepted: DraftAttachment[] = refs.slice(0, room).map(ref => ({
      key: crypto.randomUUID(),
      requestId: newRequestId(),
      file: new File([], ref.name, { type: ref.kind === 'image' ? ref.mime : 'text/plain' }),
      source: ref,
      status: 'uploading',
      progress: 0,
    }))
    if (refs.length > room) setError('每条消息最多添加 8 个附件。')
    update(items => [...items, ...accepted])
    for (const item of accepted) start(item.key)
  }
  /** The Host released these uploads: each row says so and can only be removed. */
  const markReleased = (text: string) =>
    update(items => items.map(item => (item.ref ? { ...item, status: 'refused' as const, error: text } : item)))
  const remove = (key: string) => {
    const item = state.current.find(item => item.key === key)
    jobs.current.get(key)?.controller.abort()
    jobs.current.delete(key)
    if (item?.ref) void api(`attachments/${item.ref.id}`, { method: 'DELETE' }).catch(() => {})
    update(items => items.filter(item => item.key !== key))
  }
  const wait = async (): Promise<string[] | undefined> => {
    if (preparing) return
    const current = generation.current
    setPreparing(true)
    setError('')
    try {
      await Promise.all([...jobs.current.values()].map(job => job.promise))
      if (current !== generation.current) return
      if (state.current.some(item => item.status === 'refused')) {
        setError('有附件不能发送，请移除后再发送。')
        return
      }
      if (state.current.some(item => item.status !== 'ready' || !item.ref)) {
        setError('附件尚未准备好。请重试失败的文件，或移除后发送。')
        return
      }
      if (state.current.some(item => (item.ref?.kind === 'image' ? !caps?.images : !caps?.text || draftSize(item) > caps.textBytes))) {
        setError(caps?.reason ?? '当前 Harness 不接受这些附件。请移除附件或更换模型。')
        return
      }
      return state.current.map(item => item.ref!.id)
    } finally {
      if (current === generation.current) setPreparing(false)
    }
  }
  return {
    items,
    dragging,
    setDragging,
    caps,
    checking,
    note,
    /** What `note` leaves out, behind its Hint. */
    noteDetail: note ? noteDetail : '',
    /** Pressing the button when nothing can be attached: says why, in place, with any detail behind a Hint. */
    explain: (reason: string, detail = '') => {
      setNote(reason)
      setNoteDetail(detail)
    },
    heldBack: heldBack && (items.length > 0 || heldRefs) ? heldBack : undefined,
    error: attachmentDraftError(error, readFailure, connectionReported),
    preparing,
    add,
    reuse,
    remove,
    retry: start,
    markReleased,
    wait,
    cancel: () => {
      generation.current++
      for (const job of jobs.current.values()) job.controller.abort()
      jobs.current.clear()
      update(items =>
        items.map(item => (item.status === 'uploading' ? { ...item, status: 'failed', error: '上传已取消，可以重试。' } : item)),
      )
      setPreparing(false)
    },
    clear: () => reset(true),
    setError,
  }
}
export type AttachmentDraftController = ReturnType<typeof useAttachments>
