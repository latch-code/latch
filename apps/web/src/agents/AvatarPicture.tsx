import { useCallback, useRef, useState } from 'react'

import type { CustomAgent, CustomAgentSummary } from '@latch/protocol'
import { Button, InlineNotice, Meter, StatusWord } from '@latch/ui'
import { ApiError, newRequestId, uploadAgentAvatar } from '../core/api.ts'
import { AVATAR_PROBLEM_WORDS, preparePicture, type AvatarProblem } from './avatarImage.ts'
import { writeOutcome } from './model.ts'

/** One upload as sent: a retry of a result that stayed unknown repeats it, with the same bytes. */
interface PictureRequest {
  picture: Blob
  requestId: string
  baseRevision: number
}
export type PictureUpload =
  | { phase: 'idle' }
  | { phase: 'preparing' }
  | { phase: 'uploading'; loaded: number; total: number; requestId: string }
  /** Refused before or by the Host, in the picker's own three words where it is one of them. */
  | { phase: 'refused'; problem?: AvatarProblem; message?: string }
  | { phase: 'conflict'; message: string }
  | { phase: 'unknown'; message: string; requestId: string }

/** The Host's refusal as one of the picker's three honest reasons, where it is one. */
export function hostProblem(code: string | undefined): AvatarProblem | undefined {
  if (code === 'agent-avatar-too-large' || code === 'body-too-large') return 'too-large'
  if (code === 'agent-avatar-type' || code === 'agent-avatar-convert') return 'wrong-type'
  if (code === 'agent-avatar-unreadable') return 'unreadable'
  return undefined
}

/**
 * Uploading a picture for an Agent: prepared on this device, sent with its progress, and shown only once the Host has it.
 * A result that stays unknown keeps the request, so 重试 sends the same one.
 */
export function useAvatarUpload(agent: Pick<CustomAgentSummary, 'id' | 'revision'>, onSettled: () => void) {
  const [state, setState] = useState<PictureUpload>({ phase: 'idle' })
  const held = useRef<PictureRequest | undefined>(undefined)
  const busy = useRef(false)
  const send = useCallback(
    async (request: PictureRequest) => {
      held.current = request
      setState({ phase: 'uploading', loaded: 0, total: request.picture.size, requestId: request.requestId })
      try {
        await uploadAgentAvatar<CustomAgent>(agent.id, request.picture, request, {
          onProgress: (loaded, total) => {
            setState(current => (current.phase === 'uploading' ? { ...current, loaded, total } : current))
          },
        })
        held.current = undefined
        setState({ phase: 'idle' })
        onSettled()
      } catch (error) {
        const outcome = writeOutcome(error)
        if (outcome.kind === 'unknown') setState({ phase: 'unknown', message: outcome.message, requestId: request.requestId })
        else {
          held.current = undefined
          if (outcome.kind === 'conflict') {
            setState({ phase: 'conflict', message: outcome.message })
            onSettled()
          } else {
            const problem = hostProblem(error instanceof ApiError ? error.code : undefined)
            setState({ phase: 'refused', ...(problem ? { problem } : { message: outcome.message }) })
          }
        }
      }
    },
    [agent.id, onSettled],
  )
  const choose = useCallback(
    async (file: File | undefined) => {
      if (!file || busy.current) return
      busy.current = true
      try {
        setState({ phase: 'preparing' })
        const prepared = await preparePicture(file)
        if ('problem' in prepared) setState({ phase: 'refused', problem: prepared.problem })
        else await send({ picture: prepared.picture, requestId: newRequestId(), baseRevision: agent.revision })
      } finally {
        busy.current = false
      }
    },
    [agent.revision, send],
  )
  const retry = useCallback(async () => {
    if (!held.current || busy.current) return
    busy.current = true
    try {
      await send(held.current)
    } finally {
      busy.current = false
    }
  }, [send])
  const clear = useCallback(() => {
    setState(current =>
      current.phase === 'unknown' || current.phase === 'uploading' || current.phase === 'preparing' ? current : { phase: 'idle' },
    )
  }, [])
  return {
    state,
    choose,
    retry,
    clear,
    /** Nothing else of the Agent changes while a picture is on its way or its result is unknown. */
    held: state.phase === 'preparing' || state.phase === 'uploading' || state.phase === 'unknown',
  }
}

/**
 * 图片, the picker's last row: 上传 (or 换一张) and 清除, with what the upload is doing now. The picture itself shows only
 * in the preview above, once the Host has it.
 */
export function PictureRow({
  hasPicture,
  upload,
  disabled,
  onChoose,
  onRetry,
  onClear,
  onReload,
}: {
  hasPicture: boolean
  upload: PictureUpload
  /** Offline, or another change of this Agent is unsettled. */
  disabled: boolean
  onChoose: (file: File | undefined) => void
  onRetry: () => void
  onClear: () => void
  onReload: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const working = upload.phase === 'preparing' || upload.phase === 'uploading'
  const locked = disabled || working || upload.phase === 'unknown'
  const percent = upload.phase === 'uploading' && upload.total > 0 ? Math.round((upload.loaded / upload.total) * 100) : 0
  return (
    <div className="avatar-picker-row" data-part="picture" aria-busy={working || undefined}>
      <span className="avatar-picker-label" id="avatar-picker-picture">
        图片
      </span>
      <div className="avatar-picker-picture" role="group" aria-labelledby="avatar-picker-picture">
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          aria-label="选择图片"
          onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            onChoose(file)
          }}
        />
        <Button disabled={locked} onClick={() => input.current?.click()}>
          {hasPicture ? '换一张' : '上传'}
        </Button>
        {hasPicture && (
          <Button variant="ghost" disabled={locked} onClick={onClear}>
            清除
          </Button>
        )}
        {upload.phase === 'preparing' && (
          <StatusWord tone="running" role="status">
            正在处理
          </StatusWord>
        )}
        {upload.phase === 'uploading' && (
          <span className="avatar-picker-progress" role="status">
            <Meter value={upload.loaded} max={Math.max(upload.total, 1)} label="上传" valueText={`${percent}%`} cells={8} />
            <span>上传 {percent}%</span>
          </span>
        )}
        {upload.phase === 'refused' && (
          <StatusWord tone="failed" role="alert">
            {upload.problem ? AVATAR_PROBLEM_WORDS[upload.problem] : (upload.message ?? '没有保存')}
          </StatusWord>
        )}
      </div>
      {upload.phase === 'unknown' && (
        <InlineNotice tone="warn" title="结果未知" action={<Button onClick={onRetry}>重试同一请求</Button>}>
          <span>{upload.message}</span> <span className="agent-request-id">{upload.requestId}</span>
        </InlineNotice>
      )}
      {upload.phase === 'conflict' && (
        <InlineNotice tone="warn" title="已在别处修改" action={<Button onClick={onReload}>载入最新</Button>}>
          {upload.message}
        </InlineNotice>
      )}
    </div>
  )
}
