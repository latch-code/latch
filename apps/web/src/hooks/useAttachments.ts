import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AttachmentCapabilities, AttachmentRef, AttachmentSelection } from '@latch/protocol'
import { api, ApiError, errorMessage, newRequestId, uploadAttachment } from '../core/api.ts'

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

/** Files remain immutable for a request ID; the Host is the authority for type and capability checks. */
export function useAttachments({
  enabled,
  selection,
  sessionId,
  locked,
  revision = '',
  heldBack,
  heldRefs = false,
}: {
  enabled: boolean
  selection: AttachmentSelection
  sessionId?: string
  locked: boolean
  /** Changes when what the Harness takes may have changed (it started, or was tested): capabilities are read again. */
  revision?: string
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
  const [error, setError] = useState('')
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
    const controller = new AbortController()
    // A new selection starts unknown; the same one read again keeps what it knew until the answer comes.
    if (known.current !== context) setCaps(undefined)
    known.current = context
    setNote('')
    setChecking(enabled)
    if (enabled)
      void api<{ capabilities: AttachmentCapabilities }>('attachments/capabilities', {
        method: 'POST',
        body: JSON.parse(context) as object,
        signal: controller.signal,
      })
        .then(result => {
          if (!controller.signal.aborted) setCaps(result.capabilities)
        })
        .catch(cause => {
          if (!controller.signal.aborted) {
            setCaps(undefined)
            setError(errorMessage(cause))
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setChecking(false)
        })
    return () => controller.abort()
  }, [enabled, context, revision])
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
    const largest = largestAccepted(caps) ?? FILE_BYTES
    setNote('')
    for (const file of files) {
      if (!file.size) {
        setError('空文件不能添加。')
        continue
      }
      if (file.size > largest) {
        setError(
          `「${file.name}」超过 ${sizeText(largest)}，没有添加。${attachmentLimits(caps) ? `可以添加：${attachmentLimits(caps)}。` : ''}`,
        )
        continue
      }
      accepted.push({
        key: crypto.randomUUID(),
        requestId: newRequestId(),
        file,
        status: 'uploading',
        progress: 0,
        ...(pastedText === undefined ? {} : { pastedText }),
      })
    }
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
      if (state.current.some(item => (item.ref?.kind === 'image' ? !caps?.images : !caps?.text || item.file.size > caps.textBytes))) {
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
    /** Pressing the button when nothing can be attached: says why, in place. */
    explain: (reason: string) => setNote(reason),
    heldBack: heldBack && (items.length > 0 || heldRefs) ? heldBack : undefined,
    error,
    preparing,
    add,
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
