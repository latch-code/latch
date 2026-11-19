import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { liveHarnesses, replies, startRealHarnessHost, systemNotes, type RealHarnessHost } from './helpers/real-harnesses.ts'

/**
 * A conversation that goes on with another Harness, between real ones: every ordered pair of the Harnesses whose path is
 * set (the same switches as the gateway live tests). The conversation starts on the first, moves to the second, and
 * comes back to the first.
 *
 * Two ways to run it. By default every model request goes to a local recording service through Latch's model services,
 * under temporary HOME and config directories, and the test reads what each Harness actually sent: the second must be
 * sent what was said on the first, and the first, back again, what was said on the second. With `LATCH_RELAY_REAL=1`
 * each Harness runs as the person has it, signed in, on its own model, with one-line prompts: each is told a code word
 * and the next must say it back. `LATCH_RELAY_EVIDENCE_DIR` collects one JSON line per pair.
 */

const REAL = process.env.LATCH_RELAY_REAL === '1'
const only = process.env.LATCH_RELAY_PAIRS?.split(',')
const pairs = liveHarnesses
  .flatMap(from => liveHarnesses.filter(to => to !== from).map(to => ({ from, to })))
  .filter(pair => !only || only.includes(`${pair.from}-${pair.to}`))
const evidenceDir = process.env.LATCH_RELAY_EVIDENCE_DIR

let live: RealHarnessHost

beforeAll(async () => {
  if (pairs.length === 0) return
  live = await startRealHarnessHost({ real: REAL })
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true })
}, 120_000)

afterAll(async () => {
  await live?.close()
})

async function start(harness: string, prompt: string, forkOf?: { taskId: string; upToMessageId: string }): Promise<TaskDetail> {
  const created = await live.owner.confirmed('tasks', {
    method: 'POST',
    body: {
      harnessId: harness,
      prompt,
      requestId: randomUUID(),
      ...live.model(harness),
      ...(forkOf ? { forkOf: { ...forkOf, moved: true } } : {}),
    },
  })
  expect(created.status, await created.clone().text()).toBe(201)
  return live.firstTurn(((await created.json()) as { sessionId: string }).sessionId)
}

const end = (current: TaskDetail) => ({ taskId: current.summary.id, upToMessageId: current.messages.at(-1)!.id })
/** Everything the Harness sent the service in the request that asked `mark`, as one text. */
const sent = (mark: string) => {
  const request = live.upstream!.requests.findLast(item => JSON.stringify(item.body).includes(mark))
  return request ? JSON.stringify(request.body) : ''
}

if (pairs.length === 0) it.skip('moves a conversation between real Harnesses (fewer than two Harness switches set)', () => {})
else
  it.each(pairs)(
    `moves a conversation from $from to $to and back (${REAL ? 'their own models' : 'recorded service'})`,
    async ({ from, to }) => {
      const tag = `${from}-${to}-${randomUUID().slice(0, 6)}`.toUpperCase()
      const [kiwi, pear] = [`KIWI-${tag}`, `PEAR-${tag}`]
      const first = await start(from, `The code word is ${kiwi}. Reply with only: noted.`)
      expect(first.summary.status, systemNotes(first)).toBe('idle')
      const second = await start(
        to,
        `Say the code word you were told earlier, then remember a second one: ${pear}. Reply in one line.`,
        end(first),
      )
      expect(second.summary.status, systemNotes(second)).toBe('idle')
      expect(second.summary.forkOf?.moved).toEqual({ from })
      const back = await start(from, 'Reply with both code words from this conversation, in one line.', end(second))
      expect(back.summary.status, systemNotes(back)).toBe('idle')
      const opening = back.messages.find(message => message.role === 'user')
      const native = opening?.nativeFork === true
      const evidence: Record<string, unknown> = { from, to, real: REAL, resumedOwnSession: native, notes: systemNotes(back) || undefined }
      if (live.upstream) {
        // What the second was sent holds the first's turn; what the first was sent, back again, holds both.
        const [toSecond, toBack] = [sent(pear), sent('Reply with both code words')]
        evidence.secondSentFirstTurn = toSecond.includes(kiwi)
        evidence.backSentBoth = toBack.includes(kiwi) && toBack.includes(pear)
        // Its own record of the first turn, not the Host's text record of it, when it went on from its own session.
        evidence.backSentTextRecord = toBack.includes('以下是会话')
        expect(toSecond).toContain(kiwi)
        expect(toBack).toContain(kiwi)
        expect(toBack).toContain(pear)
        if (native) expect(toBack).not.toContain('以下是会话')
      } else {
        evidence.second = replies(second).slice(0, 200)
        evidence.back = replies(back).slice(0, 200)
        expect(replies(second)).toContain(kiwi)
        expect(replies(back)).toContain(kiwi)
        expect(replies(back)).toContain(pear)
      }
      if (evidenceDir)
        await writeFile(join(evidenceDir, `relay-${REAL ? 'real' : 'recorded'}-${from}-${to}.json`), `${JSON.stringify(evidence)}\n`)
    },
    480_000,
  )
