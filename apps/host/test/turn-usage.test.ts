import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TurnLog, turnLine, turnLineSchema, type TurnLine } from '../src/turn-usage.ts'

const directories: string[] = []
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Noon of a day in the Host computer's own time. */
const local = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).getTime()

async function setup(start = local(2026, 11, 15)) {
  const dir = await mkdtemp(join(tmpdir(), 'latch-turns-'))
  directories.push(dir)
  const time = { now: start }
  const logs: string[] = []
  const log = await TurnLog.open(dir, { now: () => time.now, log: text => void logs.push(text) })
  return { dir, time, logs, log, files: async () => (await readdir(join(dir, 'usage'))).toSorted() }
}

const line = (at: number, extra: Partial<TurnLine> = {}): TurnLine => ({
  at: new Date(at).toISOString(),
  startedAt: new Date(at - 4000).toISOString(),
  sessionId: 'session-1',
  harness: 'codex',
  steps: 3,
  activeMs: 4000,
  inputTokens: 1200,
  outputTokens: 80,
  ...extra,
})

describe('the own-login turn record', () => {
  it('appends one 0600 line per turn to the month’s file, and starts the next month’s file in the Host’s own time', async () => {
    const last = new Date(2026, 10, 30, 23, 59, 50).getTime()
    const { log, time, files, dir } = await setup(last)
    log.append(line(last))
    time.now = new Date(2026, 11, 1, 0, 0, 5).getTime()
    log.append(line(time.now, { sessionId: 'session-2' }))
    await log.flushed()
    expect(await files()).toEqual(['turns-2026-11.jsonl', 'turns-2026-12.jsonl'])
    const mode = (await stat(join(dir, 'usage', 'turns-2026-11.jsonl'))).mode & 0o777
    expect(mode).toBe(0o600)
    expect((await log.read(last - 1000, time.now + 1000)).lines.map(item => item.sessionId)).toEqual(['session-1', 'session-2'])
  })

  it('writes only the fields a line may have, and reads past a line that has more', async () => {
    const { log, logs, dir } = await setup()
    log.append({ ...line(local(2026, 11, 15)), prompt: 'what the person asked' } as TurnLine)
    await log.flushed()
    expect(logs).toEqual(['轮次用量记录格式无效，没有写入。'])
    expect(turnLineSchema.safeParse({ ...line(1), text: 'x' }).success).toBe(false)
    const path = join(dir, 'usage', 'turns-2026-11.jsonl')
    await writeFile(
      path,
      `${JSON.stringify({ ...line(local(2026, 11, 15)), extra: true })}\n${JSON.stringify(line(local(2026, 11, 15)))}\n`,
      { mode: 0o600 },
    )
    const read = await log.read(local(2026, 11, 1), local(2026, 11, 16))
    expect(read.lines).toHaveLength(1)
    expect(read.skipped).toBe(1)
  })

  it('keeps 90 days as the ledger does, and leaves other files alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'latch-turns-'))
    directories.push(dir)
    await mkdir(join(dir, 'usage'), { recursive: true })
    for (const name of ['turns-2026-07.jsonl', 'turns-2026-08.jsonl', 'notes.txt']) await writeFile(join(dir, 'usage', name), '')
    await TurnLog.open(dir, { now: () => local(2026, 11, 15), log: () => {} })
    expect((await readdir(join(dir, 'usage'))).toSorted()).toEqual(['notes.txt', 'turns-2026-08.jsonl'])
  })

  it('takes a driver’s turn as a line: whole tokens only, cost only in a kept currency and within reason, names cut', () => {
    const base = { sessionId: 's', startedAt: '2026-11-15T03:00:00.000Z', endedAt: '2026-11-15T03:00:09.000Z', steps: 2 }
    expect(
      turnLine(
        { ...base, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 6 }, cost: { amount: 0.25, currency: 'USD' } },
        { harness: 'claude-agent', agentId: 'a', projectId: 'p' },
      ),
    ).toEqual({
      at: base.endedAt,
      startedAt: base.startedAt,
      sessionId: 's',
      agentId: 'a',
      projectId: 'p',
      harness: 'claude-agent',
      steps: 2,
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 6,
      cost: { micros: 250_000, currency: 'USD', source: 'agent' },
    })
    const without = turnLine(
      { ...base, usage: { inputTokens: 1.5, outputTokens: 2 }, cost: { amount: 3, currency: 'EUR' }, model: 'x'.repeat(300) },
      { harness: 'h' },
    )!
    expect(without).not.toHaveProperty('inputTokens')
    expect(without).not.toHaveProperty('cost')
    expect(without.model).toHaveLength(200)
    expect(turnLine({ ...base, cost: { amount: 500, currency: 'USD' } }, { harness: 'h' })).not.toHaveProperty('cost')
    expect(turnLine({ ...base, endedAt: 'not a time' }, { harness: 'h' })).toBeUndefined()
  })

  it('marks a built-in turn on a plugin’s provider with its provider, and only then', () => {
    const base = {
      sessionId: 's',
      startedAt: '2026-11-15T03:00:00.000Z',
      endedAt: '2026-11-15T03:00:09.000Z',
      steps: 0,
      providerId: 'plugged',
    }
    expect(turnLine(base, { harness: 'standard', via: 'plugin' })).toMatchObject({ via: 'plugin', providerId: 'plugged' })
    // An ACP turn never names a provider, whatever the driver passed.
    expect(turnLine(base, { harness: 'codex' })).not.toHaveProperty('providerId')
    expect(turnLineSchema.safeParse({ ...line(1), via: 'gateway' }).success).toBe(false)
  })

  it('holds no text of the turn', async () => {
    const { log, dir } = await setup()
    log.append(line(local(2026, 11, 15)))
    await log.flushed()
    const text = await readFile(join(dir, 'usage', 'turns-2026-11.jsonl'), 'utf8')
    expect(Object.keys(JSON.parse(text)).toSorted()).toEqual(
      ['activeMs', 'at', 'harness', 'inputTokens', 'outputTokens', 'sessionId', 'startedAt', 'steps'].toSorted(),
    )
  })
})
