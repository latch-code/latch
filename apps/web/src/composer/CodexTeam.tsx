import { useMemo, useState } from 'react'
import { Button, Dialog, StatusWord } from '@latch/ui'
import type { Message, Subagent, TaskDetail } from '@latch/protocol'
import { AgentsGlyph } from '../agents/AgentAvatar.tsx'
import { SUBAGENT_STATUS } from '../components/SubagentRow.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import type { RunState } from './Composer.tsx'
import '../styles/codex-team.css'

interface Member {
  rowId: string
  subagent: Subagent
}

interface Delegation {
  id: string
  userMessageId: string | undefined
  members: Member[]
}

const REQUEST = '请启动 Codex 的子 Agent 并行处理下列任务。分工后等待各成员结果，再汇总给我。'

function delegations(messages: Message[]): Delegation[] {
  const groups = new Map<string, Delegation>()
  for (const message of messages) {
    const subagent = message.subagent
    if (!subagent?.team) continue
    const { id, userMessageId } = subagent.team
    let group = groups.get(id)
    if (!group) {
      group = { id, userMessageId, members: [] }
      groups.set(id, group)
    }
    group.members.push({ rowId: message.id, subagent })
  }
  return [...groups.values()].reverse()
}

export function CodexTeam({
  detail,
  draft,
  canPrepare,
  onPrepare,
  onApproval,
  run,
}: {
  detail: TaskDetail
  draft: string
  canPrepare: boolean
  onPrepare: (value: string) => void
  onApproval: (index: number) => void
  run?: RunState | undefined
}) {
  const groups = useMemo(() => delegations(detail.messages), [detail.messages])
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string>()
  const group = groups.find(entry => entry.id === selected) ?? groups[0]
  const currentRequest = group?.userMessageId ? detail.messages.find(message => message.id === group.userMessageId)?.text : undefined
  const available = detail.codexTeam === 'available'
  const canAdd = canPrepare && available
  const approvals = detail.approvals
  const waiting = approvals.some(approval => approval.subagentId !== undefined)
  const conflict = draft.trimStart().startsWith('/')
  const teamRun = group?.members.some(({ subagent }) => subagent.status === 'running' || subagent.status === 'waiting') ? run : undefined
  if (!detail.codexTeam && !group) return null
  return (
    <div className="codex-team-control">
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog" className="codex-team-entry">
        <AgentsGlyph size={16} />
        {group ? 'Agent 团队' : '用团队分工'}
        {waiting && <StatusWord tone="waiting">待审批</StatusWord>}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="form"
        title="Agent 团队"
        subtitle="当前会话中的 Codex 委派"
        className="codex-team-dialog"
        footer={
          teamRun ? (
            <Button variant="outline" disabled={teamRun.cancel === 'cancelling'} onClick={teamRun.onCancel}>
              {teamRun.cancel === 'cancelling' ? '正在停止本轮…' : teamRun.cancel === 'uncertain' ? '核对停止请求' : '停止本轮'}
            </Button>
          ) : (
            canAdd && (
              <Button
                variant="primary"
                disabled={conflict || draft.startsWith(REQUEST)}
                onClick={() => {
                  onPrepare(draft.trim() ? `${REQUEST}\n\n${draft}` : `${REQUEST}\n\n`)
                  setOpen(false)
                }}>
                加入输入框
              </Button>
            )
          )
        }>
        <div className="codex-team-content">
          {group ? (
            <>
              {groups.length > 1 && (
                <label className="codex-team-history">
                  <span>委派记录</span>
                  <select value={group.id} onChange={event => setSelected(event.currentTarget.value)}>
                    {groups.map((entry, index) => (
                      <option key={entry.id} value={entry.id}>
                        第 {groups.length - index} 次委派
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {currentRequest && (
                <p className="codex-team-request">
                  <VisibleText text={currentRequest.replace(REQUEST, '').trim() || currentRequest} />
                </p>
              )}
              <ul className="codex-team-members" aria-label="实际成员">
                {group.members.map(({ rowId, subagent }) => {
                  const approval = approvals.findIndex(item => item.subagentId === rowId)
                  const status = SUBAGENT_STATUS[approval >= 0 ? 'waiting' : (subagent.status ?? 'unknown')]
                  return (
                    <li key={rowId} className="codex-team-member">
                      <div className="codex-team-member-heading">
                        <strong>
                          <VisibleText text={subagent.title} />
                        </strong>
                        <StatusWord tone={status.tone}>{status.words}</StatusWord>
                      </div>
                      {subagent.status === 'failed' && subagent.team?.failure && (
                        <p className="codex-team-note">
                          <VisibleText text={subagent.team.failure} />
                        </p>
                      )}
                      {subagent.description && (
                        <p className="codex-team-assignment">
                          <VisibleText text={subagent.description} />
                        </p>
                      )}
                      {subagent.team?.result && (
                        <details className="codex-team-result">
                          <summary>{subagent.status === 'running' ? '上次结果' : '成员结果'}</summary>
                          <div>
                            <VisibleText text={subagent.team.result} />
                          </div>
                        </details>
                      )}
                      {approval >= 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="codex-team-review"
                          onClick={() => {
                            setOpen(false)
                            onApproval(approval)
                          }}>
                          查看此成员的审批
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          ) : (
            <p className="codex-team-empty">发送分工请求后，Codex 自行创建成员。这里会显示实际分工和成员回报。</p>
          )}
          {detail.codexTeam === 'disabled' && <p className="codex-team-note">当前 Codex 会话的原生协作已关闭。</p>}
          {detail.summary.modelRoute && <p className="codex-team-note">成员走当前会话的模型服务，调用量合计在此会话。</p>}
          {canAdd && (
            <p className="codex-team-note">
              {conflict ? '输入框里已有斜杠命令，先发送或移除它。' : '把分工请求放入输入框，写清目标后亲自发送。'}
            </p>
          )}
        </div>
      </Dialog>
    </div>
  )
}
