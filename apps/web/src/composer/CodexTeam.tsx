import { useMemo, useState } from 'react'
import { Button, Dialog, Menu, SelectButton, StatusWord, Tooltip } from '@latch/ui'
import type { Message, Subagent, TaskDetail } from '@latch/protocol'
import { AgentsGlyph } from '../agents/AgentAvatar.tsx'
import { MessageContent } from '../MessageContent.tsx'
import { SUBAGENT_STATUS } from '../components/SubagentRow.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import type { RunState } from './Composer.tsx'

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

function MemberResult({ text, running }: { text: string; running: boolean }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <details className="codex-team-result" onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>{running ? '成员回报' : '成员结果'}</summary>
      {expanded && (
        <div className="codex-team-result-body">
          <MessageContent text={text} />
        </div>
      )}
    </details>
  )
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
  onApproval: (approvalId: string) => void
  run?: RunState | undefined
}) {
  const groups = useMemo(() => delegations(detail.messages), [detail.messages])
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string>()
  const group = groups.find(entry => entry.id === selected) ?? groups[0]
  const delegationRequest = group?.userMessageId ? detail.messages.find(message => message.id === group.userMessageId)?.text : undefined
  const available = detail.codexTeam === 'available'
  const canAdd = canPrepare && available
  const approvals = detail.approvals
  const waiting = approvals.some(approval => approval.subagentId !== undefined)
  const conflict = draft.trimStart().startsWith('/')
  const currentRun = groups.length > 0 && detail.activity ? run : undefined
  if (!detail.codexTeam && !group) return null
  return (
    <div className="codex-team-control">
      <Button variant="ghost" size="xs" onClick={() => setOpen(true)} aria-haspopup="dialog" className="codex-team-entry">
        <AgentsGlyph size={14} />
        <span className="codex-team-label">{group ? 'Agent 团队' : '用团队分工'}</span>
        {waiting && <StatusWord tone="waiting">待审批</StatusWord>}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title="Agent 团队"
        subtitle={
          // That members go to the session's own service is the subtitle's hover: a fact about where they run, not a line.
          detail.summary.modelRoute ? (
            <Tooltip content="成员走当前会话的模型服务，调用量合计在此会话">
              <span tabIndex={0}>当前会话中的 Codex 委派</span>
            </Tooltip>
          ) : (
            '当前会话中的 Codex 委派'
          )
        }
        className="codex-team-dialog"
        footer={
          currentRun ? (
            <div className="codex-team-current-run" role="group" aria-label="当前会话">
              <span>当前会话</span>
              <Button variant="outline" disabled={currentRun.cancel === 'cancelling'} onClick={currentRun.onCancel}>
                {currentRun.cancel === 'cancelling'
                  ? '正在停止当前运行…'
                  : currentRun.cancel === 'uncertain'
                    ? '核对当前运行的停止请求'
                    : '停止当前运行'}
              </Button>
            </div>
          ) : (
            canAdd && (
              <Button
                variant="primary"
                disabled={conflict || draft.startsWith(REQUEST)}
                // Why it is off, or what it does: the request goes into the input, and the person sends it.
                tooltip={
                  conflict
                    ? '输入框里已有斜杠命令，先发送或移除它'
                    : draft.startsWith(REQUEST)
                      ? '分工请求已在输入框里'
                      : '把分工请求放入输入框，写清目标后亲自发送'
                }
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
                <div className="codex-team-history">
                  <span>委派记录</span>
                  <Menu
                    label="委派记录"
                    align="end"
                    selection
                    sections={[
                      {
                        id: 'delegations',
                        items: groups.map((entry, index) => ({
                          id: entry.id,
                          label: `第 ${groups.length - index} 次委派`,
                          checked: group.id === entry.id,
                          onSelect: () => setSelected(entry.id),
                        })),
                      },
                    ]}
                    trigger={menu => (
                      <SelectButton {...menu} aria-label="委派记录">
                        第 {groups.length - groups.indexOf(group)} 次委派
                      </SelectButton>
                    )}
                  />
                </div>
              )}
              {delegationRequest && (
                <p className="codex-team-request">
                  <VisibleText text={delegationRequest.replace(REQUEST, '').trim() || delegationRequest} />
                </p>
              )}
              <ul className="codex-team-members" aria-label="实际成员">
                {group.members.map(({ rowId, subagent }) => {
                  const approval = approvals.find(item => item.subagentId === rowId)
                  const status = SUBAGENT_STATUS[approval ? 'waiting' : (subagent.status ?? 'unknown')]
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
                      {subagent.team?.result && <MemberResult text={subagent.team.result} running={subagent.status === 'running'} />}
                      {approval && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="codex-team-review"
                          onClick={() => {
                            setOpen(false)
                            onApproval(approval.id)
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
        </div>
      </Dialog>
    </div>
  )
}
