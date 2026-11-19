import { describe, expect, it } from 'vitest'
import { TEAM_LIMITS, type Message, type TeamMember, type TeamSummary } from '@latch/protocol'
import { promptMarks } from '../src/composer/prompt-tokens.ts'
import { matchingMembers } from '../src/hooks/useFileMentions.tsx'
import { TEAM_COPY } from '../src/teams/copy.ts'
import { returnOf, teamTurnKey } from '../src/teams/model.ts'
import { draftRound, leadTeamOf, memberChoices, memberMarks, memberTokens, replyOf, roundOfReturn } from '../src/teams/rounds.ts'

const member = (itemId: string, title: string, state: TeamMember['state'], sessionId?: string): TeamMember => ({
  itemId,
  title,
  harnessId: 'codex',
  state,
  ...(sessionId ? { sessionId } : {}),
})

const team = (members: TeamMember[], extra: Partial<TeamSummary> = {}): TeamSummary => ({
  id: 'tem_1',
  leadSessionId: 'lead',
  state: 'returned',
  members,
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
  ...extra,
})

const idle = (id: string) => ({ id, status: 'idle' as const })

describe('a team’s members in the lead’s input', () => {
  it('names each member by its title, spaces as dashes, a second of the same name numbered', () => {
    expect(memberTokens([{ title: '查 前端' }, { title: '查 前端' }, { title: '  ' }, { title: 'x'.repeat(40) }])).toEqual([
      '@查-前端',
      '@查-前端-2',
      '@member',
      `@${'x'.repeat(24)}`,
    ])
  })

  it('lists every member, and says why one cannot take work now', () => {
    const members = [
      member('itm_a', '一', 'done', 's1'),
      member('itm_b', '二', 'running', 's2'),
      member('itm_c', '三', 'unstarted'),
      member('itm_d', '四', 'done', 's4'),
      member('itm_e', '五', 'done', 's5'),
    ]
    const tasks = [idle('s1'), idle('s2'), { id: 's4', status: 'idle' as const, archived: true }, { id: 's5', status: 'running' as const }]
    expect(memberChoices(team(members), tasks).map(choice => [choice.token, choice.disabled])).toEqual([
      ['@一', undefined],
      ['@二', TEAM_COPY.memberBusy],
      ['@三', TEAM_COPY.memberUnstarted],
      ['@四', TEAM_COPY.memberArchived],
      ['@五', TEAM_COPY.memberBusy],
    ])
    // While a round is open nobody takes another.
    expect(memberChoices(team([members[0]!], { state: 'returning' }), tasks)[0]!.disabled).toBe(TEAM_COPY.roundOpen)
  })

  it('finds members by title or token, all of them with nothing typed', () => {
    const items = [
      { title: '查前端', token: '@查前端' },
      { title: 'Fix API', token: '@Fix-API' },
    ]
    expect(matchingMembers(items, '')).toHaveLength(2)
    expect(matchingMembers(items, 'api').map(item => item.title)).toEqual(['Fix API'])
    expect(matchingMembers(items, 'fix-a').map(item => item.title)).toEqual(['Fix API'])
    expect(matchingMembers(items, '后端')).toEqual([])
  })

  it('reads a draft with chips as one round: the text without them for each, only when every one is free', () => {
    const choices = memberChoices(team([member('itm_a', '一', 'done', 's1'), member('itm_b', '二', 'done', 's2')]), [
      idle('s1'),
      idle('s2'),
    ])
    expect(draftRound('请再看看边界情况', choices)).toBeUndefined()
    // Not a chip: a token that runs into the next word.
    expect(draftRound('@一二 看看', choices)).toBeUndefined()
    expect(draftRound('@一 请再看看  @二 边界情况', choices)).toEqual({
      itemIds: ['itm_a', 'itm_b'],
      prompt: '请再看看 边界情况',
      ready: true,
    })
    expect(draftRound('@一 @一 继续', choices)).toMatchObject({ itemIds: ['itm_a'], prompt: '继续' })
    expect(draftRound('@一 ', choices)).toMatchObject({ ready: false, reason: TEAM_COPY.writeFirst })
    expect(draftRound(`@一 ${'x'.repeat(TEAM_LIMITS.promptChars + 1)}`, choices)).toMatchObject({ ready: false, reason: TEAM_COPY.tooLong })
    const busy = memberChoices(team([member('itm_a', '一', 'running', 's1')]), [idle('s1')])
    expect(draftRound('@一 继续', busy)).toMatchObject({ ready: false, reason: `一 · ${TEAM_COPY.memberBusy}` })
    expect(memberMarks('a @二 b @一', choices).map(mark => mark.itemId)).toEqual(['itm_b', 'itm_a'])
  })

  it('draws a chip as a mark where it stands on its own', () => {
    const marks = promptMarks('@一 再看 @一x @二', {
      members: [
        { token: '@一', title: '一' },
        { token: '@二', title: '二' },
      ],
    })
    expect(marks.map(mark => [mark.kind, mark.start, mark.end, mark.name])).toEqual([
      ['member', 0, 2, '一'],
      ['member', 10, 12, '二'],
    ])
  })

  it('takes the newest team of the session as its own', () => {
    const older = team([], { id: 'tem_old', createdAt: '2026-11-18T00:00:00.000Z' })
    const newer = team([], { id: 'tem_new' })
    expect(leadTeamOf([newer, older, team([], { id: 'tem_other', leadSessionId: 'other' })], 'lead')?.id).toBe('tem_new')
    expect(leadTeamOf(undefined, 'lead')).toBeUndefined()
  })
})

describe('a team’s rounds in the conversation', () => {
  const message = (id: string, role: Message['role'], text: string, requestId?: string): Message =>
    ({ id, role, text, createdAt: '2026-11-19T00:00:00.000Z', ...(requestId ? { requestId } : {}) }) as Message

  it('reads a member’s reply to one round, not a later one', () => {
    const messages = [
      message('u1', 'user', '第一轮'),
      message('a1', 'assistant', '第一轮的结果'),
      message('u2', 'user', '人插了一句'),
      message('a2', 'assistant', '回答插话'),
      message('u3', 'user', '第二轮', 'req-2'),
      message('a3', 'assistant', ''),
      message('a4', 'assistant', '第二轮的结果'),
    ]
    expect(replyOf(messages)).toBe('第一轮的结果')
    expect(replyOf(messages, 'req-2')).toBe('第二轮的结果')
    expect(replyOf(messages, 'missing')).toBe('')
  })

  it('finds the round a returned message carried, and places the card where the latest round was made', () => {
    const rounds = [
      { round: 1, by: 'person' as const, members: [], state: 'returned' as const, returnedMessageId: 'r1', messageId: 'm1', createdAt: '' },
      { round: 2, by: 'agent' as const, members: [], state: 'returned' as const, returnedMessageId: 'r2', messageId: 'm2', createdAt: '' },
    ]
    const later = team([], { returnedMessageId: 'r2', messageId: 'm1', round: 2, rounds })
    expect(roundOfReturn(later, 'r1')).toMatchObject({ round: { round: 1 }, count: 2 })
    expect(roundOfReturn(team([]), 'x')).toEqual({ round: undefined, count: 1 })
    // An earlier round's message is still this team's results.
    expect(returnOf(message('r1', 'user', '…'), [later])).toBe(later)
    const messages = [message('m1', 'user', 'a'), message('x', 'assistant', 'b'), message('m2', 'user', 'c')]
    expect(teamTurnKey(later, messages)).toBe('m2')
    expect(teamTurnKey(team([], { messageId: 'm1' }), messages)).toBe('m1')
  })
})
