import { useMemo, useRef, useState } from 'react'
import { Button, Dialog, Menu, SelectButton, StatusWord, Tooltip } from '@latch/ui'
import type { Message, Subagent, TaskDetail } from '@latch/protocol'
import { AgentsGlyph } from '../agents/AgentAvatar.tsx'
import { MessageContent } from '../MessageContent.tsx'
import { SUBAGENT_STATUS } from '../components/SubagentRow.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import type { RunState } from './Composer.tsx'
import { CODEX_TEAM_REQUEST } from '../teams/copy.ts'
import { TeamEntry, type TeamEntryProps } from '../teams/TeamEntry.tsx'
import { defineCopy, formatNumber } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    memberReports: '成员回报',
    memberResults: '成员结果',
    team: 'Agent 团队',
    useTeam: '用团队分工',
    needsApproval: '待审批',
    usesCurrentService: '成员走当前会话的模型服务，调用量合计在此会话',
    delegation: '当前会话中的 Codex 委派',
    session: '当前会话',
    stopping: '正在停止当前运行…',
    checkStop: '核对当前运行的停止请求',
    stop: '停止当前运行',
    history: '委派记录',
    number: (number: number) => `第 ${formatNumber(number)} 次委派`,
    numberPrefix: '第 ',
    numberSuffix: ' 次委派',
    members: '实际成员',
    viewApproval: '查看此成员的审批',
    teamDisabled: '当前 Codex 会话的原生协作已关闭。',
  },
  {
    memberReports: 'Member updates',
    memberResults: 'Member results',
    team: 'Agent team',
    useTeam: 'Split work with a team',
    needsApproval: 'Needs approval',
    usesCurrentService: 'Members use this session’s model service. Their usage is counted in this session.',
    delegation: 'Codex delegation in this session',
    session: 'Current session',
    stopping: 'Stopping the current run…',
    checkStop: 'Check the current stop request',
    stop: 'Stop the current run',
    history: 'Delegation history',
    number: (number: number) => `Delegation ${formatNumber(number)}`,
    numberPrefix: 'Delegation ',
    numberSuffix: ' ',
    members: 'Actual members',
    viewApproval: 'Review this member’s approval',
    teamDisabled: 'Native collaboration is off for this Codex session.',
  },
)

interface Member {
  rowId: string
  subagent: Subagent
}

interface Delegation {
  id: string
  userMessageId: string | undefined
  members: Member[]
}

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
      <summary>{running ? COPY.memberReports : COPY.memberResults}</summary>
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
  onApproval,
  run,
  team,
}: {
  /**
   * This session can start a team of its own (docs/TEAMS.md): the one entry is that panel, with Codex's own subagents as
   * a way of working the list; once Codex has delegated, the entry opens this record, which leads to the panel. Absent
   * (a member, a session with a team open, a device without run), only a record that exists is offered.
   */
  team?: TeamEntryProps | undefined
  detail: TaskDetail
  onApproval: (approvalId: string) => void
  run?: RunState | undefined
}) {
  const groups = useMemo(() => delegations(detail.messages), [detail.messages])
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string>()
  const panel = useRef<(() => void) | undefined>(undefined)
  const group = groups.find(entry => entry.id === selected) ?? groups[0]
  const delegationRequest = group?.userMessageId ? detail.messages.find(message => message.id === group.userMessageId)?.text : undefined
  const available = detail.codexTeam === 'available'
  const approvals = detail.approvals
  const waiting = approvals.some(approval => approval.subagentId !== undefined)
  const currentRun = groups.length > 0 && detail.activity ? run : undefined
  if (!group) return team ? <TeamEntry {...team} codex={{ available }} /> : null
  const dialog = (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      size="lg"
      title={COPY.team}
      subtitle={
        // That members go to the session's own service is the subtitle's hover: a fact about where they run, not a line.
        detail.summary.modelRoute ? (
          <Tooltip content={COPY.usesCurrentService}>
            <span tabIndex={0}>{COPY.delegation}</span>
          </Tooltip>
        ) : (
          COPY.delegation
        )
      }
      className="codex-team-dialog"
      footer={
        (currentRun || team) && (
          <>
            {currentRun && (
              <div className="codex-team-current-run" role="group" aria-label={COPY.session}>
                <span>{COPY.session}</span>
                <Button variant="outline" disabled={currentRun.cancel === 'cancelling'} onClick={currentRun.onCancel}>
                  {currentRun.cancel === 'cancelling' ? COPY.stopping : currentRun.cancel === 'uncertain' ? COPY.checkStop : COPY.stop}
                </Button>
              </div>
            )}
            {team && (
              <Button
                variant="outline"
                onClick={() => {
                  setOpen(false)
                  // Once the dialog has given the page back, the panel opens at the entry.
                  requestAnimationFrame(() => panel.current?.())
                }}>
                {COPY.useTeam}
              </Button>
            )}
          </>
        )
      }>
      <div className="codex-team-content">
        {groups.length > 1 && (
          <div className="codex-team-history">
            <span>{COPY.history}</span>
            <Menu
              label={COPY.history}
              align="end"
              selection
              sections={[
                {
                  id: 'delegations',
                  items: groups.map((entry, index) => ({
                    id: entry.id,
                    label: COPY.number(groups.length - index),
                    checked: group.id === entry.id,
                    onSelect: () => setSelected(entry.id),
                  })),
                },
              ]}
              trigger={menu => (
                <SelectButton {...menu} aria-label={COPY.history}>
                  {COPY.numberPrefix}
                  {groups.length - groups.indexOf(group)}
                  {COPY.numberSuffix}
                </SelectButton>
              )}
            />
          </div>
        )}
        {delegationRequest && (
          <p className="codex-team-request">
            <VisibleText text={delegationRequest.replace(CODEX_TEAM_REQUEST, '').trim() || delegationRequest} />
          </p>
        )}
        <ul className="codex-team-members" aria-label={COPY.members}>
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
                    {COPY.viewApproval}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
        {detail.codexTeam === 'disabled' && <p className="codex-team-note">{COPY.teamDisabled}</p>}
      </div>
    </Dialog>
  )
  if (team)
    return (
      <>
        <TeamEntry
          {...team}
          panelToggle={panel}
          codex={{
            available,
            record: { label: COPY.team, ...(waiting ? { waiting: COPY.needsApproval } : {}), open: () => setOpen(true) },
          }}
        />
        {dialog}
      </>
    )
  return (
    <div className="codex-team-control">
      <Button variant="ghost" size="xs" onClick={() => setOpen(true)} aria-haspopup="dialog" className="codex-team-entry">
        <AgentsGlyph size={14} />
        <span className="codex-team-label">{COPY.team}</span>
        {waiting && <StatusWord tone="waiting">{COPY.needsApproval}</StatusWord>}
      </Button>
      {dialog}
    </div>
  )
}
