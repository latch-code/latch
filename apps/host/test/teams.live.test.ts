import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { TEAM_RETURN_HEADING, type TaskDetail, type TeamAnswer, type TeamSummary } from '@latch/protocol'
import { liveHarnesses, replies, startRealHarnessHost, systemNotes, type RealHarnessHost } from './helpers/real-harnesses.ts'

/**
 * A team between real Harnesses: each Harness whose path is set leads once, with the next two as its members, so each is
 * also a member twice. The members run at the same time on their own Harnesses; the Host sends their replies to the lead
 * as one message, and the lead answers it. Then a second round goes to the same members, each in its own session again,
 * and its results come back to the lead as a second message.
 *
 * Recorded (the default): every model request goes to a local recording service; the test reads the request the lead
 * sent after the return and finds both members' replies in it. With `LATCH_TEAM_REAL=1` each Harness runs signed in on
 * its own model: each member is asked to reply with a code word, and the lead's answer to the return must hold both.
 * `LATCH_TEAM_EVIDENCE_DIR` collects one JSON line per team.
 */

const REAL = process.env.LATCH_TEAM_REAL === '1'
const only = process.env.LATCH_TEAM_LEADS?.split(',')
const teams = liveHarnesses
  .map((lead, index) => ({
    lead,
    first: liveHarnesses[(index + 1) % liveHarnesses.length]!,
    second: liveHarnesses[(index + 2) % liveHarnesses.length]!,
  }))
  .filter(team => !only || only.includes(team.lead))
const evidenceDir = process.env.LATCH_TEAM_EVIDENCE_DIR

let live: RealHarnessHost

beforeAll(async () => {
  if (liveHarnesses.length < 3) return
  // A member's recorded reply names the code word its request asked for, so the lead's request can be checked for it.
  live = await startRealHarnessHost({
    real: REAL,
    plan: request => {
      // The latest code word asked: a member's second round still carries its first in its history.
      const asked = [
        ...(JSON.stringify(request.body).split(TEAM_RETURN_HEADING)[0] ?? '').matchAll(/(?:KIWI|PEAR|PLUM|FIGS)-[A-Z0-9-]+/gu),
      ].at(-1)
      return { text: asked ? `Member result ${asked[0]} reported.` : 'Recorded reply given.' }
    },
  })
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true })
}, 120_000)

afterAll(async () => {
  await live?.close()
})

async function teamIn(id: string, states: ReadonlyArray<TeamSummary['state']>, limitMs: number): Promise<TeamSummary> {
  const until = Date.now() + limitMs
  for (;;) {
    const { team } = await live.owner.json<TeamAnswer>(`teams/${id}`)
    // Members ask for nothing but words; an approval one raises anyway is allowed, as the person would.
    for (const member of team.members) {
      if (member.state !== 'waiting' || !member.sessionId) continue
      for (const approval of (await live.detail(member.sessionId)).approvals)
        await live.owner.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
    }
    if (states.includes(team.state)) return team
    if (Date.now() > until)
      throw new Error(
        `the team stayed ${team.state}: ${JSON.stringify(team.members.map(member => [member.harnessId, member.state, member.refusal]))}`,
      )
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

async function settledAfter(sessionId: string, messageId: string, limitMs: number): Promise<TaskDetail> {
  const until = Date.now() + limitMs
  for (;;) {
    const current = await live.detail(sessionId)
    for (const approval of current.approvals)
      await live.owner.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
    const sent = current.messages.find(message => message.id === messageId)
    if (sent?.turn?.endedAt && !['running', 'waiting-approval'].includes(current.summary.status)) return current
    if (Date.now() > until) throw new Error(`the lead did not answer the return: ${systemNotes(current)}`)
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

if (teams.length === 0 || liveHarnesses.length < 3)
  it.skip('runs a team between real Harnesses (fewer than three Harness switches set)', () => {})
else
  it.each(teams)(
    `$lead leads a team of $first and $second (${REAL ? 'their own models' : 'recorded service'})`,
    async ({ lead, first, second }) => {
      const tag = `${lead}-${randomUUID().slice(0, 6)}`.toUpperCase()
      const [kiwi, pear] = [`KIWI-${tag}`, `PEAR-${tag}`]
      const created = await live.owner.confirmed('tasks', {
        method: 'POST',
        body: { harnessId: lead, prompt: 'Reply with only: ready.', requestId: randomUUID(), ...live.model(lead) },
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const leadId = ((await created.json()) as { sessionId: string }).sessionId
      const opened = await live.firstTurn(leadId)
      expect(opened.summary.status, systemNotes(opened)).toBe('idle')

      const startedAt = Date.now()
      const started = await live.owner.request(`tasks/${leadId}/team`, {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          goal: 'two code words',
          tasks: [
            {
              title: 'First word',
              prompt: `Reply with only this code word and nothing else: ${kiwi}`,
              harnessId: first,
              ...live.model(first),
            },
            {
              title: 'Second word',
              prompt: `Reply with only this code word and nothing else: ${pear}`,
              harnessId: second,
              ...live.model(second),
            },
          ],
        },
      })
      expect(started.status, await started.clone().text()).toBe(201)
      const begun = ((await started.json()) as TeamAnswer).team
      expect(begun.members.map(member => [member.harnessId, member.state === 'unstarted' ? member.refusal : 'started'])).toEqual([
        [first, 'started'],
        [second, 'started'],
      ])
      const team = await teamIn(begun.id, ['returned', 'kept'], 300_000)
      expect(team.state, JSON.stringify(team.members)).toBe('returned')
      expect(team.members.map(member => member.state)).toEqual(['done', 'done'])
      const memberSessions = await Promise.all(team.members.map(member => live.detail(member.sessionId!)))
      // Each member ran on its own Harness, as a member of this team.
      expect(memberSessions.map(session => [session.summary.harnessId, session.summary.teamOf?.leadSessionId])).toEqual([
        [first, leadId],
        [second, leadId],
      ])
      // At the same time: the second began before the first ended.
      const [a, b] = team.members
      const overlapped = Date.parse(b!.startedAt!) < Date.parse(a!.endedAt!) && Date.parse(a!.startedAt!) < Date.parse(b!.endedAt!)
      const answered = await settledAfter(leadId, team.returnedMessageId!, 300_000)
      expect(answered.summary.status, systemNotes(answered)).toBe('idle')
      const returned = answered.messages.find(message => message.id === team.returnedMessageId)!
      expect(returned.text).toContain(TEAM_RETURN_HEADING)
      const summary = replies({ ...answered, messages: answered.messages.slice(answered.messages.indexOf(returned) + 1) })
      const evidence: Record<string, unknown> = {
        lead,
        members: [first, second],
        real: REAL,
        overlapped,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        said: team.members.map(member => member.said),
      }
      if (live.upstream) {
        // The lead's request after the return holds what both members reported.
        const request = live.upstream.requests.findLast(item => JSON.stringify(item.body).includes(TEAM_RETURN_HEADING))
        const body = request ? JSON.stringify(request.body) : ''
        evidence.leadSentBoth = body.includes(kiwi) && body.includes(pear)
        expect(body).toContain(kiwi)
        expect(body).toContain(pear)
      } else {
        evidence.summary = summary.slice(0, 300)
        expect(replies(memberSessions[0]!)).toContain(kiwi)
        expect(replies(memberSessions[1]!)).toContain(pear)
        expect(summary).toContain(kiwi)
        expect(summary).toContain(pear)
      }
      expect(overlapped).toBe(true)

      // A second round to the same members, from the lead's conversation: each answers in its own session again.
      const [plum, figs] = [`PLUM-${tag}`, `FIGS-${tag}`]
      const sent = await live.owner.request(`teams/${team.id}/rounds`, {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          sends: [
            { itemId: team.members[0]!.itemId, prompt: `Reply with only this code word and nothing else: ${plum}` },
            { itemId: team.members[1]!.itemId, prompt: `Reply with only this code word and nothing else: ${figs}` },
          ],
        },
      })
      expect(sent.status, await sent.clone().text()).toBe(201)
      const again = await teamIn(team.id, ['returned', 'kept'], 300_000)
      expect([again.state, again.round, again.members.map(member => member.state)]).toEqual(['returned', 2, ['done', 'done']])
      expect(again.returnedMessageId).not.toBe(team.returnedMessageId)
      const secondAnswer = await settledAfter(leadId, again.returnedMessageId!, 300_000)
      const secondReturn = secondAnswer.messages.find(message => message.id === again.returnedMessageId)!
      evidence.secondRound = { said: again.members.map(member => member.said) }
      if (live.upstream) {
        expect(secondReturn.text).toContain(plum)
        expect(secondReturn.text).toContain(figs)
      } else {
        const sessions = await Promise.all(again.members.map(member => live.detail(member.sessionId!)))
        expect(replies(sessions[0]!)).toContain(plum)
        expect(replies(sessions[1]!)).toContain(figs)
        expect(secondReturn.text).toContain(plum)
        expect(secondReturn.text).toContain(figs)
      }
      if (evidenceDir)
        await writeFile(join(evidenceDir, `team-${REAL ? 'real' : 'recorded'}-${lead}.json`), `${JSON.stringify(evidence)}\n`)
    },
    900_000,
  )
