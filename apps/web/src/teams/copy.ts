import { TEAM_LIMITS, type TeamMemberState, type TeamSummary } from '@latch/protocol'
import { APPROVAL_COPY } from '../core/securityCopy.ts'
import { defineCopy, formatNumber } from '../core/i18n.ts'
import type { EndMark } from './model.ts'

export const TEAM_COPY = defineCopy(
  {
    team: '团队分工',
    useTeam: '用团队分工',
    member: '成员',
    thisSession: '这个会话',
    task: (position: number) => `第 ${formatNumber(position)} 项`,
    taskPlaceholder: '这个成员要做的事',
    harness: 'Harness',
    add: '添加一项',
    remove: (position: number) => `移除第 ${formatNumber(position)} 项`,
    start: '开始',
    retry: '重试',
    giveUp: '放弃',
    unanswered: '没有收到电脑的答复',
    askAgent: '让 Agent 来分',
    modes: '分工方式',
    sessionsMode: '各开会话',
    sessionsModeHint: '每项开一个会话，用你为它选的 Harness 与模型',
    codexMode: 'Codex 子 Agent',
    codexModeHint: '作为一条消息发给这个会话，由 Codex 派给自己的子 Agent',
    slashInInput: '输入框里已有斜杠命令',
    noHarness: '没有可用的 Harness',
    count: (count: number, limit: number) => `${formatNumber(count)} / ${formatNumber(limit)}`,
    startTogether: '一起开始',
    starting: '正在开始',
    running: '运行中',
    done: '已完成',
    failed: '失败',
    stopped: '已停止',
    unknown: '未回报结果',
    unstarted: '没有开始',
    endMembers: '等成员',
    ended: (ended: number, total: number) => `${formatNumber(ended)}/${formatNumber(total)}`,
    memberCount: (count: number) => `${formatNumber(count)} 个成员`,
    endStopping: '正在停止…',
    endPending: '结果待发',
    endReturned: '已交回',
    endKept: '留在这里',
    keptStopped: '已停止',
    keptLeadGone: '这个会话不在了',
    keptDeviceRemoved: '开始它的设备已移除',
    stop: '停止',
    results: '成员的结果',
    source: '发给 Agent 的原文',
    openSession: '打开会话',
    reading: '读取中',
    noReply: '没有回复',
    place: (place: number, of: number) => `团队分工 · ${formatNumber(place)}/${formatNumber(of)}`,
    said: (members: number) => `团队分工，${formatNumber(members)} 个成员`,
    round: (round: number) => `第 ${formatNumber(round)} 轮`,
    byYou: '你派的',
    byAgent: 'Agent 派的',
    again: '再派一轮',
    againTo: (title: string) => `再派一轮给「${title}」`,
    againPlaceholder: '要它再做什么',
    sendAgain: '发出',
    letAgent: '让它自己派活',
    resultsOfRound: (round: number) => `成员的结果 · 第 ${formatNumber(round)} 轮`,
    memberUnstarted: '没有开始过',
    memberArchived: '会话已归档',
    memberBusy: '还在做上一件',
    roundOpen: '这一轮还没结束',
    writeFirst: '写下要成员做的事',
    tooLong: `最多 ${formatNumber(TEAM_LIMITS.promptChars)} 个字符`,
    textOnly: '派给成员只带文字',
    sendToMembers: '派给成员',
    memberMark: '成员 · ',
  },
  {
    team: 'Team',
    useTeam: 'Split work with a team',
    member: 'Member',
    thisSession: 'This session',
    task: (position: number) => `Task ${formatNumber(position)}`,
    taskPlaceholder: 'What this member should do',
    harness: 'Harness',
    add: 'Add a task',
    remove: (position: number) => `Remove task ${formatNumber(position)}`,
    start: 'Start',
    retry: 'Retry',
    giveUp: 'Give up',
    unanswered: 'The computer did not reply',
    askAgent: 'Let the agent split it',
    modes: 'How to split',
    sessionsMode: 'Sessions',
    sessionsModeHint: 'Each task opens a session on the Harness and model you pick for it',
    codexMode: 'Codex agents',
    codexModeHint: 'Sent to this session as one message; Codex hands it to its own subagents',
    slashInInput: 'The input already holds a slash command',
    noHarness: 'No Harness is ready',
    count: (count: number, limit: number) => `${formatNumber(count)} / ${formatNumber(limit)}`,
    startTogether: 'Start together',
    starting: 'Starting',
    running: 'Running',
    done: 'Done',
    failed: 'Failed',
    stopped: 'Stopped',
    unknown: 'No result reported',
    unstarted: 'Not started',
    endMembers: 'Waiting for members',
    ended: (ended: number, total: number) => `${formatNumber(ended)}/${formatNumber(total)}`,
    memberCount: (count: number) => `${formatNumber(count)} ${count === 1 ? 'member' : 'members'}`,
    endStopping: 'Stopping…',
    endPending: 'Results pending',
    endReturned: 'Handed back',
    endKept: 'Kept here',
    keptStopped: 'Stopped',
    keptLeadGone: 'This session is gone',
    keptDeviceRemoved: 'The device that started it was removed',
    stop: 'Stop',
    results: 'Members’ results',
    source: 'What was sent to the agent',
    openSession: 'Open session',
    reading: 'Loading',
    noReply: 'No reply',
    place: (place: number, of: number) => `Team · ${formatNumber(place)}/${formatNumber(of)}`,
    said: (members: number) => `Team of ${formatNumber(members)}`,
    round: (round: number) => `Round ${formatNumber(round)}`,
    byYou: 'Sent by you',
    byAgent: 'Sent by the agent',
    again: 'Send again',
    againTo: (title: string) => `Send “${title}” another round`,
    againPlaceholder: 'What next',
    sendAgain: 'Send',
    letAgent: 'Let it assign work',
    resultsOfRound: (round: number) => `Members’ results · Round ${formatNumber(round)}`,
    memberUnstarted: 'Never started',
    memberArchived: 'Session archived',
    memberBusy: 'Still at work',
    roundOpen: 'This round is still open',
    writeFirst: 'Write what the members should do',
    tooLong: `At most ${formatNumber(TEAM_LIMITS.promptChars)} characters`,
    textOnly: 'Members get text only',
    sendToMembers: 'Send to members',
    memberMark: 'Member · ',
  },
)

/** What Codex is asked when its own subagents do the work: the tasks follow it, numbered, in the same message. */
export const CODEX_TEAM_REQUEST = '请启动 Codex 的子 Agent 并行处理下列任务。分工后等待各成员结果，再汇总给我。'

/** What the agent is asked when the person lets it write the split; it goes into the input, and the person sends it. */
export const ASK_AGENT_REQUEST =
  '请把这件事拆成几项互不依赖、可以同时进行的任务，用 propose_todos 提出来；只在确知某个 Harness 合适时写上它。'

export function memberWords(state: TeamMemberState): string {
  if (state === 'starting') return TEAM_COPY.starting
  if (state === 'running') return TEAM_COPY.running
  if (state === 'waiting') return APPROVAL_COPY.waiting
  if (state === 'done') return TEAM_COPY.done
  if (state === 'failed') return TEAM_COPY.failed
  if (state === 'cancelled') return TEAM_COPY.stopped
  if (state === 'unknown') return TEAM_COPY.unknown
  return TEAM_COPY.unstarted
}

export function endWords(mark: EndMark): string {
  if (mark === 'members') return TEAM_COPY.endMembers
  if (mark === 'you') return APPROVAL_COPY.waiting
  if (mark === 'stopping') return TEAM_COPY.endStopping
  if (mark === 'pending') return TEAM_COPY.endPending
  if (mark === 'returned') return TEAM_COPY.endReturned
  return TEAM_COPY.endKept
}

export function keptWords(kept: TeamSummary['kept']): string | undefined {
  if (kept === 'stopped') return TEAM_COPY.keptStopped
  if (kept === 'lead-gone') return TEAM_COPY.keptLeadGone
  if (kept === 'device-removed') return TEAM_COPY.keptDeviceRemoved
  return undefined
}
