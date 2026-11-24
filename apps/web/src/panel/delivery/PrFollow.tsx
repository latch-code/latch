import { useEffect, useRef, useState } from 'react'
import type { GitPrFollow, PrFollowRestriction } from '@latch/protocol'
import { Button } from '@latch/ui'
import { api, errorMessage, isUncertain, newRequestId } from '../../core/api.ts'
import { defineCopy } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    harness: '此 Harness 的工具权限无法限制到无人值守等级，只能提醒。',
    scope: '此设备的权限或授权有效期只允许提醒。',
    session: '只有普通 Code 会话可自动续办。',
    configuration: '模型、项目或插件配置目前不能用于自动续办。',
    auto: '跟进并自动续办',
    autoDetail: '新反馈会作为外部资料发回本会话。只有权限允许且会话空闲时才会启动一轮。',
    sent: '已发到原会话',
    busy: '会话有待处理的工作，由你继续',
    policy: '当前权限或 Harness 需要你继续',
    changed: '分支、提交或授权已变化，由你继续',
    unknown: '自动发送结果未知，已暂停自动续办',
    follow: '后台提醒',
    stop: '停止跟进',
    retry: '重试同一请求',
    open: '查看反馈',
    detail: '关闭面板后，Latch 会继续跟进这个 PR。有新评审、评论或检查失败时，你会在这条会话里收到提醒。',
    notice: (comments: number, failures: number) => `PR 有新反馈 · ${comments} 条评审或评论 · ${failures} 项检查失败`,
  },
  {
    harness: 'This harness cannot enforce the unattended tool policy. Notifications are available.',
    scope: 'The device permissions or authorization lifetime only allow notifications.',
    session: 'Automatic follow-up is available in ordinary Code sessions.',
    configuration: 'The current model, project or plugin configuration does not allow automatic follow-up.',
    auto: 'Follow and continue automatically',
    autoDetail:
      'New feedback is sent to this conversation as external content only when its permissions allow a background turn and it is idle.',
    sent: 'Sent to this conversation',
    busy: 'Session has pending work. Continue manually.',
    policy: 'The current permissions or harness require a manual follow-up.',
    changed: 'Branch, commit, or authorization changed. Continue manually.',
    unknown: 'Delivery is unconfirmed. Automatic follow-up paused.',
    follow: 'Follow and notify',
    stop: 'Stop following',
    retry: 'Retry same request',
    open: 'Review feedback',
    detail: 'Latch keeps following this PR after you close the panel. New reviews, comments and failed checks appear in this conversation.',
    notice: (comments: number, failures: number) => `PR update · ${comments} reviews or comments · ${failures} failed checks`,
  },
)

type Change = { requestId: string; revision: string | null; enabled: boolean; number: number; automatic?: boolean }

export function PrFollowControl({
  sessionId,
  number,
  value,
  restriction,
  disabled,
  reload,
}: {
  sessionId: string
  number: number
  value?: GitPrFollow | undefined
  restriction?: PrFollowRestriction | undefined
  disabled: boolean
  reload: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [pending, setPending] = useState<Change>()
  const post = async (automatic = false) => {
    if (busy || disabled) return
    const change = pending ?? { requestId: newRequestId(), revision: value?.revision ?? null, enabled: !value?.enabled, number, automatic }
    setBusy(true)
    setProblem('')
    try {
      await api(`tasks/${encodeURIComponent(sessionId)}/git/pr/follow`, { method: 'POST', body: change, timeoutMs: 90_000 })
      setPending(undefined)
    } catch (cause) {
      setPending(isUncertain(cause) ? change : undefined)
      setProblem(errorMessage(cause))
    } finally {
      setBusy(false)
      reload()
    }
  }
  return (
    <div className="delivery-section-head">
      <Button size="xs" variant="ghost" title={COPY.detail} disabled={disabled || busy} onClick={() => void post()}>
        {pending ? COPY.retry : value?.enabled ? COPY.stop : COPY.follow}
      </Button>
      {!value?.enabled && !pending && !restriction && (
        <Button size="xs" variant="outline" title={COPY.autoDetail} disabled={disabled || busy} onClick={() => void post(true)}>
          {COPY.auto}
        </Button>
      )}
      {restriction && (!value?.enabled || value.automatic) && <span>{COPY[restriction]}</span>}
      {problem && <span role="alert">{problem}</span>}
    </div>
  )
}

export function PrFollowNotice({ sessionId, open }: { sessionId: string; open: () => void }) {
  const [notice, setNotice] = useState<GitPrFollow['notice']>()
  const [dismissed, setDismissed] = useState('')
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    const load = async () => {
      if (document.visibilityState !== 'visible' || controller.current) return
      const request = new AbortController()
      controller.current = request
      try {
        const result = await api<{ follow: GitPrFollow | null }>(`tasks/${encodeURIComponent(sessionId)}/git/pr/follow`, {
          signal: request.signal,
        })
        if (!request.signal.aborted) setNotice(result.follow?.notice)
      } catch {
        if (!request.signal.aborted) setNotice(undefined)
      } finally {
        if (controller.current === request) controller.current = undefined
      }
    }
    void load()
    const timer = setInterval(() => void load(), 30_000)
    const visible = () => void load()
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearInterval(timer)
      controller.current?.abort()
      controller.current = undefined
      document.removeEventListener('visibilitychange', visible)
    }
  }, [sessionId])
  if (!notice || dismissed === notice.at) return null
  return (
    <div className="delivery-section-head" role="status">
      <span>
        {COPY.notice(notice.comments, notice.failures)}
        {notice.outcome && ` · ${COPY[notice.outcome]}`}
      </span>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          setDismissed(notice.at)
          open()
        }}>
        {COPY.open}
      </Button>
    </div>
  )
}
