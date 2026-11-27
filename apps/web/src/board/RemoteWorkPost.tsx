import { useEffect, useState } from 'react'
import { escapeSecurityText, type ComputerSummary, type WorkPost, type WorkPostRemote } from '@latch/protocol'
import { Button, StatusWord } from '@latch/ui'
import { computerState } from '../core/computers.ts'
import { defineCopy } from '../core/i18n.ts'
import { describeFailure } from '../core/securityCopy.ts'
import type { ShellComputers } from '../core/shell.ts'
import { useStableCallback } from '../hooks/useStableCallback.ts'

const COPY = defineCopy(
  {
    prepared: '待发送',
    unknown: '未确认送达',
    offline: '工作电脑离线',
    running: '执行中',
    'waiting-approval': '等你审批',
    completed: '已完成',
    failed: '执行失败',
    undelivered: '没有送达',
    cancelled: '已取消',
    interrupted: '执行中断',
    refresh: '刷新状态',
    retry: '重试',
    result: (name: string) => `在 ${name} 上查看结果`,
    approval: (name: string) => `在 ${name} 上查看审批`,
    turn: (name: string) => `在 ${name} 上查看回合`,
  },
  {
    prepared: 'Ready to send',
    unknown: 'Delivery unconfirmed',
    offline: 'Work computer offline',
    running: 'Running',
    'waiting-approval': 'Waiting for your approval',
    completed: 'Completed',
    failed: 'Failed',
    undelivered: 'Not delivered',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted',
    refresh: 'Refresh status',
    retry: 'Retry',
    result: (name: string) => `View result on ${name}`,
    approval: (name: string) => `View approval on ${name}`,
    turn: (name: string) => `View turn on ${name}`,
  },
)
const tones = {
  prepared: 'neutral',
  unknown: 'warn',
  offline: 'warn',
  running: 'running',
  'waiting-approval': 'waiting',
  completed: 'done',
  failed: 'failed',
  cancelled: 'neutral',
  interrupted: 'warn',
} as const

export function remoteActions(remote: WorkPostRemote) {
  const active = remote.status === 'running' || remote.status === 'waiting-approval'
  const unresolved = remote.status === 'prepared' || remote.status === 'unknown' || remote.status === 'offline'
  return {
    refresh: active || unresolved,
    retry: unresolved && !remote.sessionId,
    open: Boolean(remote.sessionId),
    poll: active || remote.status === 'unknown',
  }
}

/** Read one accepted turn at a time while its source item is visible. Refresh never submits a request. */
export function useRemoteWorkRefresh(
  posts: WorkPost[] | null,
  itemId: string,
  computers: readonly ComputerSummary[] | undefined,
  bridge: ShellComputers | null,
  read: () => Promise<void>,
) {
  const candidates = (posts ?? []).filter(
    post =>
      post.requestId
      && post.remote
      && remoteActions(post.remote).poll
      && computers?.some(computer => !computer.local && computer.hostId === post.remote?.hostId && computer.state === 'online'),
  )
  const refresh = useStableCallback(async (index: number) => {
    const post = candidates[index % candidates.length]
    if (!post || !bridge?.refreshWorkPost || document.visibilityState !== 'visible') return false
    try {
      if (bridge.isWorkspaceActive && !(await bridge.isWorkspaceActive())) return false
      await bridge.refreshWorkPost(itemId, post.id)
    } catch {
      // The source may already have recorded the latest observation.
    }
    await read()
    return true
  })
  const enabled = !!bridge?.refreshWorkPost && candidates.length > 0
  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let index = 0
    const tick = async () => {
      if (await refresh(index)) index++
      if (!stopped) timer = window.setTimeout(() => void tick(), 5000)
    }
    let timer = window.setTimeout(() => void tick(), 5000)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [enabled, refresh])
}

export function RemoteWorkPostStatus({
  remote,
  itemId,
  postId,
  bridge,
  bound,
  computer,
  read,
}: {
  remote: WorkPostRemote
  itemId: string
  postId: string
  bridge: ShellComputers | null
  bound: boolean
  computer: ComputerSummary | undefined
  read: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ revision: number; text: string }>()
  const invoke = async (action: 'refreshWorkPost' | 'retryWorkPost' | 'openWorkPost') => {
    const run = bridge?.[action]
    if (!run || busy) return
    setBusy(true)
    setFailure(undefined)
    try {
      const result = await run(itemId, postId)
      if (!result.ok && result.error !== 'cancelled') setFailure({ revision: remote.revision, text: describeFailure(0, result.error) })
    } catch {
      setFailure({ revision: remote.revision, text: describeFailure(0, 'work-computer-unavailable') })
    } finally {
      await read()
      setBusy(false)
    }
  }
  const actions = remoteActions(remote)
  const connection = computer && computer.state !== 'online' && remote.status !== 'offline' ? computerState(computer) : undefined
  const openLabel = remote.status === 'completed' ? COPY.result : remote.status === 'waiting-approval' ? COPY.approval : COPY.turn
  return (
    <div className="item-thread-post-state" data-remote-receipt="">
      <StatusWord tone={tones[remote.status]}>
        {remote.status === 'failed' && !remote.sessionId ? COPY.undelivered : COPY[remote.status]}
      </StatusWord>
      {connection && <StatusWord tone={connection.tone}>{connection.text}</StatusWord>}
      {actions.open && computer && bridge?.openWorkPost && (
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void invoke('openWorkPost')}>
          {openLabel(escapeSecurityText(computer.name))}
        </Button>
      )}
      {actions.refresh && bridge?.refreshWorkPost && (
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void invoke('refreshWorkPost')}>
          {COPY.refresh}
        </Button>
      )}
      {actions.retry && bound && bridge?.retryWorkPost && (
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void invoke('retryWorkPost')}>
          {COPY.retry}
        </Button>
      )}
      {failure?.revision === remote.revision && <StatusWord tone="failed">{failure.text}</StatusWord>}
    </div>
  )
}
