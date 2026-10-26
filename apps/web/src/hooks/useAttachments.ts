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
  status: 'uploading' | 'ready' | 'failed' | 'confirm'
  progress: number
  error?: string
}
/** Files remain immutable for a request ID; the Host is the authority for type and capability checks. */
export function useAttachments({
  enabled,
  selection,
  sessionId,
  draftScope,
  locked,
}: {
  enabled: boolean
  selection: AttachmentSelection
  sessionId?: string
  draftScope?: string
  locked: boolean
}) {
  const [items, setItems] = useState<DraftAttachment[]>([])
  const [caps, setCaps] = useState<AttachmentCapabilities>()
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
  }
  useEffect(() => {
    const controller = new AbortController()
    setCaps(undefined)
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
          if (!controller.signal.aborted) setError(errorMessage(cause))
        })
    return () => controller.abort()
  }, [enabled, context])
  const scope = sessionId ?? draftScope ?? 'new'
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
        update(items =>
          items.map(entry =>
            entry.key === key
              ? {
                  ...entry,
                  status: confirm ? 'confirm' : 'failed',
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
    for (const file of files) {
      if (!file.size || file.size > 25 * 1024 * 1024) {
        setError('文件应大于 0 且不超过 25 MiB。')
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
      if (state.current.some(item => item.status !== 'ready' || !item.ref)) {
        setError('附件尚未准备好。请重试失败的文件，或移除后发送。')
        return
      }
      if (state.current.some(item => (item.ref?.kind === 'image' ? !caps?.images : !caps?.text || item.file.size > caps.textBytes))) {
        setError(caps?.reason ?? '当前 Agent 不接受这些附件。请移除附件或更换模型。')
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
    error,
    preparing,
    add,
    remove,
    retry: start,
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
