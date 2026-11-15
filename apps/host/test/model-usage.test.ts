import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_MODEL_SPEND_RECEIPTS, ModelSpendStore, addSpend, createModelMeter, type UsageRecord } from '../src/model-budgets.ts'
import {
  MAX_REPORTED_COST,
  UsageLedger,
  costOf,
  monthOf,
  summarizeUsage,
  usageLineSchema,
  type MonthUse,
  type UsageLine,
} from '../src/model-usage.ts'

const directories: string[] = []
const ledgers: UsageLedger[] = []
afterEach(async () => {
  for (const ledger of ledgers.splice(0)) await ledger.flushed()
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const DAY = 86_400_000
/** Noon of a day in the Host computer's own time, so a month boundary is the same wherever the test runs. */
const local = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).getTime()

async function setup(start = local(2026, 11, 15)) {
  const dir = await mkdtemp(join(tmpdir(), 'latch-usage-'))
  directories.push(dir)
  const time = { now: start }
  const logs: string[] = []
  const open = async () => {
    const ledger = await UsageLedger.open(dir, { now: () => time.now, log: text => void logs.push(text) })
    ledgers.push(ledger)
    return ledger
  }
  return {
    dir,
    time,
    logs,
    open,
    ledger: await open(),
    files: async () => (await readdir(join(dir, 'gateway'))).filter(name => !name.startsWith('totals-')),
    sums: async () => (await readdir(join(dir, 'gateway'))).filter(name => name.startsWith('totals-')).toSorted(),
  }
}

const line = (at: number, extra: Partial<UsageLine> = {}): UsageLine => ({
  at: new Date(at).toISOString(),
  sessionId: 'session-1',
  harness: 'codex',
  providerId: 'deepseek',
  model: 'deepseek-chat',
  outcome: 'ok',
  attempts: 1,
  fallback: false,
  totalMs: 1200,
  inputTokens: 100,
  outputTokens: 20,
  ...extra,
})

describe('the usage ledger', () => {
  it('writes one 0600 line per request into the month’s file and reads it back', async () => {
    const { ledger, dir, time, files } = await setup()
    ledger.append(line(time.now, { agentId: 'agent-1', used: 'deepseek-chat-0324', firstByteMs: 300, cacheReadTokens: 40 }))
    ledger.append(line(time.now + 1000, { outcome: 'server', inputTokens: undefined, outputTokens: undefined }))
    await ledger.flushed()
    expect(await files()).toEqual(['usage-2026-11.jsonl'])
    const path = join(dir, 'gateway', 'usage-2026-11.jsonl')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'gateway'))).mode & 0o777).toBe(0o700)
    const text = await readFile(path, 'utf8')
    expect(text.trimEnd().split('\n')).toHaveLength(2)
    const read = await ledger.read(time.now - DAY, time.now + DAY)
    expect(read).toMatchObject({ skipped: 0, truncated: false })
    expect(read.lines.map(item => item.outcome)).toEqual(['ok', 'server'])
    expect(read.lines[0]).toMatchObject({ agentId: 'agent-1', used: 'deepseek-chat-0324', firstByteMs: 300, cacheReadTokens: 40 })
  })

  it('takes only the fields a line may have: anything else is not written', async () => {
    const { ledger, time, logs, files } = await setup()
    expect(usageLineSchema.safeParse({ ...line(time.now), prompt: 'what the person asked' }).success).toBe(false)
    expect(usageLineSchema.safeParse({ ...line(time.now), headers: { authorization: 'x' } }).success).toBe(false)
    expect(usageLineSchema.safeParse({ ...line(time.now), cost: { micros: 1, currency: 'USD', source: 'guess' } }).success).toBe(false)
    expect(usageLineSchema.safeParse({ ...line(time.now), outcome: 'fine' }).success).toBe(false)
    ledger.append({ ...line(time.now), prompt: 'what the person asked' } as UsageLine)
    await ledger.flushed()
    expect(await files()).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).not.toContain('what the person asked')
  })

  it('starts a new file when the month ends in the Host’s own time, and counts the new month from nothing', async () => {
    const last = new Date(2026, 10, 30, 23, 59, 50).getTime()
    const { ledger, time, files } = await setup(last)
    ledger.append(line(time.now))
    expect(ledger.used('service:deepseek').tokens).toBe(120)
    expect(ledger.currentMonth()).toBe('2026-11')
    time.now = new Date(2026, 11, 1, 0, 0, 5).getTime()
    // Nothing of November counts once it is December.
    expect(ledger.currentMonth()).toBe('2026-12')
    expect(ledger.used('service:deepseek').tokens).toBe(0)
    ledger.append(line(time.now, { inputTokens: 7, outputTokens: 3 }))
    // A request that arrived in November and ended in December belongs to November's file and count.
    ledger.append(line(last + 1000))
    await ledger.flushed()
    expect((await files()).toSorted()).toEqual(['usage-2026-11.jsonl', 'usage-2026-12.jsonl'])
    expect(ledger.used('service:deepseek').tokens).toBe(10)
    expect((await ledger.read(last - 1000, time.now + 1000)).lines).toHaveLength(3)
  })

  it('counts the month again from its file after a restart', async () => {
    const { ledger, time, open } = await setup()
    ledger.append(line(time.now, { agentId: 'agent-1', cost: { micros: 2500, currency: 'USD', source: 'reported' } }))
    ledger.append(line(time.now, { providerId: 'other' }))
    ledger.append(line(time.now))
    await ledger.flushed()
    const again = await open()
    expect(again.used('service:deepseek')).toEqual({ tokens: 240, cost: { USD: 2500 }, sent: 2, costed: { USD: 1 } })
    expect(again.used('agent:agent-1')).toEqual({ tokens: 120, cost: { USD: 2500 }, sent: 1, costed: { USD: 1 } })
    expect(again.used('service:other').tokens).toBe(120)
  })

  it('keeps 90 days: an older month’s file goes, older lines are not read, and other files are left alone', async () => {
    const { ledger, time, dir, files, sums, open } = await setup(local(2026, 8, 20))
    ledger.append(line(time.now))
    ledger.append(line(local(2026, 7, 20)))
    await ledger.flushed()
    await writeFile(join(dir, 'gateway', 'notes.txt'), 'not the ledger’s')
    await writeFile(join(dir, 'gateway', 'usage-2020-13.json'), '{}')
    expect((await files()).toSorted()).toEqual(['notes.txt', 'usage-2020-13.json', 'usage-2026-07.jsonl', 'usage-2026-08.jsonl'])
    // 15 November: August ended 76 days ago, July 107 days ago.
    time.now = local(2026, 11, 15)
    await ledger.prune()
    expect((await files()).toSorted()).toEqual(['notes.txt', 'usage-2020-13.json', 'usage-2026-08.jsonl'])
    // The 20 August line is 87 days old and still read; at 25 November it is 97 days old and is not, though its file stays
    // until the whole month is 90 days back.
    expect((await ledger.read(0, time.now)).lines).toHaveLength(1)
    time.now = local(2026, 11, 25)
    await ledger.prune()
    expect((await files()).toSorted()).toContain('usage-2026-08.jsonl')
    expect((await ledger.read(0, time.now)).lines).toHaveLength(0)
    expect(await sums()).toEqual(['totals-2026-08.json'])
    time.now = local(2026, 12, 1)
    await open()
    expect((await files()).toSorted()).toEqual(['notes.txt', 'usage-2020-13.json'])
    // A month's sums go with its ledger file.
    expect(await sums()).toEqual([])
  })

  it('passes over a line it cannot read and says how many, never failing', async () => {
    const { ledger, time, dir, open } = await setup()
    ledger.append(line(time.now))
    await ledger.flushed()
    const path = join(dir, 'gateway', 'usage-2026-11.jsonl')
    await appendFile(path, 'not json at all\n{"at":"2026-11-15T04:00:00.000Z","extra":true}\n\n{"half":\n')
    ledger.append(line(time.now + 5))
    const read = await ledger.read(time.now - DAY, time.now + DAY)
    expect(read.lines).toHaveLength(2)
    expect(read.skipped).toBe(3)
    // A restart counts what it can read.
    expect((await open()).used('service:deepseek').tokens).toBe(240)
  })
})

describe('the month’s sums', () => {
  it('writes sums for the ledger prefix even when the next request already counts towards the live budget', async () => {
    const { ledger, time, dir } = await setup()
    const snapshot = await setup(time.now)
    const firstWritten = deferred()
    const release = deferred()
    // Hold the writer after the first real pair of ledger/totals files is published, before the next queued append.
    const writer = ledger as unknown as { writeTotals(month: string, use: Map<string, MonthUse>, bytes: number): Promise<void> }
    const writeTotals = writer.writeTotals.bind(writer)
    const barrier = vi.spyOn(writer, 'writeTotals').mockImplementationOnce(async (month, use, bytes) => {
      await writeTotals(month, use, bytes)
      firstWritten.resolve()
      await release.promise
    })
    ledger.append(line(time.now, { agentId: 'agent-1', cost: { micros: 1, currency: 'USD', source: 'prices' } }))
    ledger.append(line(time.now, { agentId: 'agent-1', cost: { micros: 2, currency: 'USD', source: 'prices' } }))
    try {
      expect(ledger.used('agent:agent-1').tokens).toBe(240)
      await firstWritten.promise
      for (const file of ['usage-2026-11.jsonl', 'totals-2026-11.json'])
        await copyFile(join(dir, 'gateway', file), join(snapshot.dir, 'gateway', file))
      const fresh = await snapshot.open()
      expect((await fresh.read(time.now - DAY, time.now)).lines).toHaveLength(1)
      expect(fresh.used('service:deepseek')).toEqual({ tokens: 120, cost: { USD: 1 }, sent: 1, costed: { USD: 1 } })
      expect(fresh.used('agent:agent-1')).toEqual({ tokens: 120, cost: { USD: 1 }, sent: 1, costed: { USD: 1 } })
    } finally {
      release.resolve()
      await ledger.flushed()
      barrier.mockRestore()
    }
  })

  it('keeps the failed write in the live budget without persisting its sums along with a later successful append', async () => {
    const { ledger, time, dir, open, logs } = await setup()
    const path = join(dir, 'gateway', 'usage-2026-11.jsonl')
    const parked = join(dir, 'ledger-prefix')
    ledger.append(line(time.now))
    await ledger.flushed()
    await rename(path, parked)
    await mkdir(path)
    ledger.append(line(time.now, { inputTokens: 1000, outputTokens: 0 }))
    await ledger.flushed()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('用量记录写入失败')
    expect(ledger.used('service:deepseek').tokens).toBe(1120)
    await rm(path, { recursive: true })
    await rename(parked, path)
    ledger.append(line(time.now, { inputTokens: 7, outputTokens: 3 }))
    await ledger.flushed()
    expect(ledger.used('service:deepseek').tokens).toBe(1130)
    const again = await open()
    expect((await again.read(time.now - DAY, time.now)).lines).toHaveLength(2)
    expect(again.used('service:deepseek').tokens).toBe(130)
  })

  it('are kept beside the ledger, 0600 and strict, and trusted only while they cover the ledger file exactly', async () => {
    const { ledger, time, dir, open, sums } = await setup()
    ledger.append(line(time.now, { cost: { micros: 700, currency: 'CNY', source: 'prices' } }))
    ledger.append(line(time.now, { outcome: 'budget', attempts: 0, inputTokens: undefined, outputTokens: undefined }))
    await ledger.flushed()
    expect(await sums()).toEqual(['totals-2026-11.json'])
    const totals = join(dir, 'gateway', 'totals-2026-11.json')
    const ledgerFile = join(dir, 'gateway', 'usage-2026-11.jsonl')
    expect((await stat(totals)).mode & 0o777).toBe(0o600)
    const saved = JSON.parse(await readFile(totals, 'utf8')) as { bytes: number; use: Record<string, unknown> }
    expect(saved).toEqual({
      version: 2,
      month: '2026-11',
      bytes: (await stat(ledgerFile)).size,
      use: { 'service:deepseek': { tokens: 120, cost: { CNY: 700 }, sent: 1, costed: { CNY: 1 } } },
    })
    // Names and numbers only.
    expect(await readFile(totals, 'utf8')).not.toMatch(/session|model|deepseek-chat/u)
    // A start reads the sums, not the month: what they say is what is counted while they match the file.
    await writeFile(totals, JSON.stringify({ ...saved, use: { 'service:deepseek': { tokens: 999, cost: {}, sent: 9, costed: {} } } }))
    expect((await open()).used('service:deepseek').tokens).toBe(999)
    // Another size, another shape or an unknown field: the ledger is counted again and the sums rewritten.
    for (const broken of [
      JSON.stringify({ ...saved, version: 1, use: {} }),
      JSON.stringify({ ...saved, bytes: saved.bytes + 1, use: {} }),
      JSON.stringify({ ...saved, extra: true, use: {} }),
      JSON.stringify({ ...saved, month: '2026-10', use: {} }),
      'not json',
    ]) {
      await writeFile(totals, broken)
      expect((await open()).used('service:deepseek')).toEqual({ tokens: 120, cost: { CNY: 700 }, sent: 1, costed: { CNY: 1 } })
      expect(JSON.parse(await readFile(totals, 'utf8'))).toEqual(saved)
    }
    await rm(totals)
    expect((await open()).used('service:deepseek').tokens).toBe(120)
    expect(JSON.parse(await readFile(totals, 'utf8'))).toEqual(saved)
  })

  it('come back when the clock does: a month returned to is read again, never counted from nothing', async () => {
    const { ledger, time, open } = await setup(local(2026, 11, 28))
    ledger.append(line(time.now))
    await ledger.flushed()
    time.now = local(2026, 12, 2)
    expect(ledger.used('service:deepseek').tokens).toBe(0)
    ledger.append(line(time.now, { inputTokens: 7, outputTokens: 3 }))
    await ledger.flushed()
    // The computer's clock is set back into November: November's own sums again.
    time.now = local(2026, 11, 29)
    expect(ledger.currentMonth()).toBe('2026-11')
    expect(ledger.used('service:deepseek').tokens).toBe(120)
    // A Host started in December that finds itself in November reads November's files on the way.
    time.now = local(2026, 12, 3)
    const fresh = await open()
    expect(fresh.used('service:deepseek').tokens).toBe(10)
    time.now = local(2026, 11, 30)
    expect(fresh.used('service:deepseek').tokens).toBe(0)
    fresh.append(line(time.now, { inputTokens: 1, outputTokens: 1 }))
    await fresh.flushed()
    // What November's file already held, and the line added since, once each.
    expect(fresh.used('service:deepseek').tokens).toBe(122)
  })

  it('start a new line after one a crash cut short, so the next request is not lost with it', async () => {
    const { ledger, time, dir, open } = await setup()
    ledger.append(line(time.now))
    await ledger.flushed()
    const path = join(dir, 'gateway', 'usage-2026-11.jsonl')
    await appendFile(path, '{"at":"2026-11-15T04:00:00.000Z","sessionId":"cut-sh')
    const again = await open()
    again.append(line(time.now + 5, { inputTokens: 1, outputTokens: 2 }))
    const read = await again.read(time.now - DAY, time.now + DAY)
    expect(read.lines).toHaveLength(2)
    expect(read.skipped).toBe(1)
    expect(again.used('service:deepseek').tokens).toBe(123)
    const text = await readFile(path, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text.split('\n').filter(Boolean)).toHaveLength(3)
  })
})

describe('summing the ledger', () => {
  const at = local(2026, 11, 15)
  it('groups by session, Agent, service and model, with requests, failures and fallbacks', () => {
    const lines = [
      line(at, { agentId: 'agent-1' }),
      line(at, { sessionId: 'session-2', outcome: 'server', inputTokens: undefined, outputTokens: undefined }),
      line(at, { sessionId: 'session-2', providerId: 'openrouter', model: 'gpt', fallback: true }),
      line(at, { outcome: 'aborted', inputTokens: undefined, outputTokens: undefined }),
    ]
    expect(summarizeUsage(lines, 'session')).toMatchObject([
      { sessionId: 'session-1', requests: 2, failed: 0, fallbacks: 0, measured: 1, usage: { inputTokens: 100, outputTokens: 20 } },
      { sessionId: 'session-2', requests: 2, failed: 1, fallbacks: 1, measured: 1 },
    ])
    expect(summarizeUsage(lines, 'service').map(row => [row.providerId, row.requests])).toEqual([
      ['deepseek', 3],
      ['openrouter', 1],
    ])
    expect(summarizeUsage(lines, 'model').map(row => [row.providerId, row.model])).toEqual([
      ['deepseek', 'deepseek-chat'],
      ['openrouter', 'gpt'],
    ])
    const agents = summarizeUsage(lines, 'agent')
    expect(agents.find(row => row.agentId === 'agent-1')).toMatchObject({ requests: 1 })
    expect(agents.find(row => row.agentId === undefined)).toMatchObject({ requests: 3 })
  })

  it('never shows a number no service reported: no usage at all, or a part left out, rather than zero', () => {
    const none = summarizeUsage([line(at, { inputTokens: undefined, outputTokens: undefined, outcome: 'timeout' })], 'service')[0]!
    expect(none.usage).toBeUndefined()
    expect(none).toMatchObject({ requests: 1, measured: 0, cost: [], uncosted: 0 })
    const mixed = summarizeUsage(
      [
        line(at, { cacheReadTokens: 30, reasoningTokens: 5 }),
        line(at, { cacheReadTokens: 10 }),
        line(at, { cacheReadTokens: 1, reasoningTokens: 1, inputTokens: undefined, outputTokens: undefined }),
      ],
      'service',
    )[0]!
    // Two replies reported tokens; one of them said nothing of reasoning, so reasoning is left out, not shown as 5.
    expect(mixed.measured).toBe(2)
    expect(mixed.usage).toEqual({ inputTokens: 200, outputTokens: 40, cacheReadTokens: 40 })
    expect(mixed.partial).toEqual({ cacheReadTokens: false, cacheWriteTokens: true, reasoningTokens: true })
  })

  it('sums cost by currency, says when prices the person entered are in it, and counts the requests without one', () => {
    const row = summarizeUsage(
      [
        line(at, { cost: { micros: 1500, currency: 'USD', source: 'reported' } }),
        line(at, { cost: { micros: 500, currency: 'USD', source: 'prices' } }),
        line(at, { cost: { micros: 9000, currency: 'CNY', source: 'prices' } }),
        line(at),
      ],
      'service',
    )[0]!
    expect(row.cost).toEqual([
      { currency: 'USD', micros: 2000, priced: true },
      { currency: 'CNY', micros: 9000, priced: true },
    ])
    expect(row.uncosted).toBe(1)
    expect(summarizeUsage([line(at, { cost: { micros: 1, currency: 'USD', source: 'reported' } })], 'service')[0]!.cost).toEqual([
      { currency: 'USD', micros: 1 },
    ])
  })
})

describe('cost', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 400_000, cacheWriteTokens: 100_000 }
  it('is known only when the service reported it or the person entered prices', () => {
    expect(costOf(usage, undefined, undefined)).toBeUndefined()
    expect(costOf(undefined, undefined, { currency: 'USD', input: 1, output: 2 })).toBeUndefined()
    expect(costOf(usage, 0.0123, undefined)).toEqual({ micros: 12_300, currency: 'USD', source: 'reported' })
    // What the person entered comes first: a reply's own number is used only where no price was entered.
    expect(costOf(usage, 0.5, { currency: 'CNY', input: 2, output: 8 })).toMatchObject({ source: 'prices', currency: 'CNY' })
    // Prices without reported tokens are no cost, and the reply's number does not stand in for them.
    expect(costOf(undefined, 0.5, { currency: 'CNY', input: 2, output: 8 })).toBeUndefined()
  })

  it('does not believe a reply’s cost that is not a plain amount within reason', () => {
    for (const hostile of [Number.NaN, -1, -0.0001, Infinity, -Infinity, 1e308, Number.MAX_SAFE_INTEGER, MAX_REPORTED_COST + 0.01])
      expect(costOf(usage, hostile, undefined), String(hostile)).toBeUndefined()
    for (const hostile of ['5', '1e3', null, true, {}, [1], 5n])
      expect(costOf(usage, hostile as unknown as number, undefined), String(hostile)).toBeUndefined()
    expect(costOf(usage, MAX_REPORTED_COST, undefined)).toEqual({ micros: 100_000_000, currency: 'USD', source: 'reported' })
    expect(costOf(usage, 0, undefined)).toEqual({ micros: 0, currency: 'USD', source: 'reported' })
  })

  it('prices cached input and cache writes on their own, and at the input price when none was entered', () => {
    // 500k plain × 2 + 400k read × 0.2 + 100k written × 2.5 + 100k output × 8, per million.
    expect(costOf(usage, undefined, { currency: 'CNY', input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 8 })).toEqual({
      micros: 1_000_000 + 80_000 + 250_000 + 800_000,
      currency: 'CNY',
      source: 'prices',
    })
    expect(costOf(usage, undefined, { currency: 'USD', input: 2, output: 8 })).toMatchObject({ micros: 2_000_000 + 800_000 })
  })
})

describe('prices and budgets', () => {
  async function meterSetup() {
    const base = await setup()
    const store = await ModelSpendStore.open(base.dir)
    const owner: Record<string, string> = { 'session-1': 'agent-1' }
    const meter = createModelMeter({
      ledger: base.ledger,
      store,
      session: id => ({ ...(owner[id] ? { agentId: owner[id]! } : {}), harness: 'codex' }),
      builtIn: 'standard',
    })
    const request = (extra: Partial<UsageRecord> = {}): UsageRecord => ({
      at: base.time.now,
      sessionId: 'session-1',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      outcome: 'ok',
      attempts: 1,
      fallback: false,
      totalMs: 10,
      usage: { inputTokens: 300, outputTokens: 100 },
      ...extra,
    })
    return { ...base, store, meter, request }
  }

  it('keeps them in one strict 0600 file and refuses a file with anything else in it', async () => {
    const { dir, store } = await meterSetup()
    await store.setPrice('deepseek', 'deepseek-chat', { currency: 'CNY', input: 2, output: 8, cacheRead: 0.2 })
    await store.setBudget('service', 'deepseek', { unit: 'tokens', limit: 1000 })
    await store.setBudget('agent', 'agent-1', { unit: 'cost', currency: 'CNY', limit: 50 })
    const path = join(dir, 'gateway', 'budgets.json')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const again = await ModelSpendStore.open(dir)
    expect(again.priceOf('deepseek', 'deepseek-chat')).toEqual({ currency: 'CNY', input: 2, output: 8, cacheRead: 0.2 })
    expect(again.budgets()).toHaveLength(2)
    // One budget per service or Agent: a second replaces the first; null removes it, twice as well as once.
    await again.setBudget('service', 'deepseek', { unit: 'tokens', limit: 5 })
    expect(again.budgetOf('service', 'deepseek')).toMatchObject({ limit: 5 })
    await again.setBudget('service', 'deepseek', null)
    await again.setBudget('service', 'deepseek', null)
    expect(again.budgetOf('service', 'deepseek')).toBeUndefined()
    await expect(again.setBudget('service', 'deepseek', { unit: 'cost', limit: 5 })).rejects.toThrow()
    await expect(again.setBudget('service', 'deepseek', { unit: 'tokens', currency: 'USD', limit: 5 })).rejects.toThrow()
    await expect(again.setBudget('service', 'deepseek', { unit: 'tokens', limit: 1.5 })).rejects.toThrow()
    await expect(again.setPrice('deepseek', 'deepseek-chat', { currency: 'CNY', input: -1, output: 8 })).rejects.toThrow()
    await expect(
      again.setPrice(
        'deepseek',
        'deepseek-chat',
        { currency: 'CNY', input: 1, output: 8 },
        {
          key: 'a'.repeat(64),
          hash: 'b'.repeat(64),
          baseRevision: again.revision(),
          async prepare() {
            return { changed: true }
          },
          authorize() {
            throw new Error('revoked')
          },
        },
      ),
    ).rejects.toThrow('revoked')
    expect(again.priceOf('deepseek', 'deepseek-chat')).toMatchObject({ input: 2 })
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...saved, apiKey: 'sk-not-here' }))
    await expect(ModelSpendStore.open(dir)).rejects.toMatchObject({ code: 'model-budgets-invalid' })
  })

  it('keeps bounded receipts and never applies an evicted request with an old revision, even if the first write was a no-op', async () => {
    const { dir } = await setup()
    const path = join(dir, 'gateway', 'budgets.json')
    const providerId = 'deepseek'
    const budget = { scope: 'service', id: providerId, unit: 'tokens', limit: 50 } as const
    await writeFile(path, JSON.stringify({ version: 1, prices: [], budgets: [budget] }))
    const store = await ModelSpendStore.open(dir)
    expect(store.revision()).toBe(0)
    const request = (baseRevision: number) => ({
      key: baseRevision.toString(16).padStart(64, '0'),
      hash: 'a'.repeat(64),
      baseRevision,
      authorize: () => {},
      prepare: vi.fn(async () => ({ changed: false })),
    })
    const original = request(0)
    expect(await store.setBudget('service', providerId, budget, original)).toEqual({ ok: true, revision: 1 })
    const reopened = await ModelSpendStore.open(dir)
    expect(await reopened.setBudget('service', providerId, budget, original)).toEqual({ ok: true, revision: 1, replayed: true })
    expect(original.prepare).toHaveBeenCalledOnce()
    for (let index = 1; index <= MAX_MODEL_SPEND_RECEIPTS; index++) await reopened.setBudget('service', providerId, budget, request(index))
    await reopened.setBudget('service', providerId, { unit: 'tokens', limit: 10 })
    const again = await ModelSpendStore.open(dir)
    await expect(again.setBudget('service', providerId, budget, original)).rejects.toMatchObject({ code: 'model-spend-conflict' })
    expect(original.prepare).toHaveBeenCalledOnce()
    expect(again.budgetOf('service', providerId)?.limit).toBe(10)
    expect((JSON.parse(await readFile(path, 'utf8')) as { receipts: unknown[] }).receipts).toHaveLength(MAX_MODEL_SPEND_RECEIPTS)
  }, 30_000)

  it('says a budget is near at 80% and over at 100%, per service and per Agent', async () => {
    const { meter, store, request } = await meterSetup()
    await store.setBudget('service', 'deepseek', { unit: 'tokens', limit: 1000 })
    expect(meter.record(request())).toBeUndefined()
    expect(meter.serviceOver('deepseek')).toBe(false)
    // 800 of 1000.
    expect(meter.record(request())).toEqual({ budget: 'near' })
    expect(meter.serviceOver('deepseek')).toBe(false)
    expect(meter.record(request())).toEqual({ budget: 'over' })
    expect(meter.serviceOver('deepseek')).toBe(true)
    expect(meter.serviceOver('other')).toBe(false)
    expect(meter.progress(store.budgetOf('service', 'deepseek')!)).toMatchObject({ used: 1200, limit: 1000, state: 'over' })
    // The Agent has no budget of its own, so its sessions are refused only where the service is.
    expect(meter.agentOver('session-1')).toBe(false)
    await store.setBudget('agent', 'agent-1', { unit: 'tokens', limit: 1200 })
    expect(meter.agentOver('session-1')).toBe(true)
    expect(meter.agentOver('session-of-nobody')).toBe(false)
  })

  it('counts a cost budget only from requests whose cost is known in its currency', async () => {
    const { meter, store, request } = await meterSetup()
    await store.setBudget('service', 'deepseek', { unit: 'cost', currency: 'CNY', limit: 0.01 })
    // No price, nothing reported: the request counts for nothing in a cost budget.
    expect(meter.record(request())).toBeUndefined()
    // Reported in dollars: not this budget's currency.
    expect(meter.record(request({ reportedCost: 5 }))).toEqual({ cost: [{ currency: 'USD', micros: 5_000_000 }] })
    expect(meter.serviceOver('deepseek')).toBe(false)
    // Neither is in the budget, and the budget says so; a request that was never sent is not one it missed.
    meter.record(request({ outcome: 'budget', attempts: 0, usage: undefined }))
    expect(meter.progress(store.budgetOf('service', 'deepseek')!)).toMatchObject({ used: 0, uncounted: 2 })
    await store.setPrice('deepseek', 'deepseek-chat', { currency: 'CNY', input: 10, output: 50 })
    // 300 × 10 + 100 × 50 = 8000 millionths: 80% of 0.01.
    expect(meter.record(request())).toEqual({ cost: [{ currency: 'CNY', micros: 8000, priced: true }], budget: 'near' })
    expect(meter.record(request())).toMatchObject({ budget: 'over' })
    expect(meter.serviceOver('deepseek')).toBe(true)
    expect(meter.progress(store.budgetOf('service', 'deepseek')!)).toMatchObject({ used: 0.016, uncounted: 2, state: 'over' })
    // A token budget counts every request and has nothing to say of cost.
    await store.setBudget('service', 'deepseek', { unit: 'tokens', limit: 10_000 })
    expect(meter.progress(store.budgetOf('service', 'deepseek')!)).not.toHaveProperty('uncounted')
  })

  it('opens a used-up budget again when the month turns in the Host’s own time', async () => {
    const { meter, store, request, time } = await meterSetup()
    time.now = new Date(2026, 10, 30, 23, 50).getTime()
    await store.setBudget('agent', 'agent-1', { unit: 'tokens', limit: 400 })
    meter.record(request({ at: time.now }))
    expect(meter.agentOver('session-1')).toBe(true)
    time.now = new Date(2026, 11, 1, 0, 1).getTime()
    expect(monthOf(time.now)).toBe('2026-12')
    expect(meter.agentOver('session-1')).toBe(false)
    expect(meter.progress(store.budgetOf('agent', 'agent-1')!)).toMatchObject({ used: 0 })
  })

  it('writes names without secrets and no cost for a request a budget refused', async () => {
    const { meter, ledger, time, request, store } = await meterSetup()
    await store.setPrice('deepseek', 'deepseek-chat', { currency: 'USD', input: 1, output: 1 })
    meter.record(request({ outcome: 'budget', attempts: 0, usage: undefined }))
    meter.record(request({ model: 'model sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', used: 'x'.repeat(500) }))
    const { lines } = await ledger.read(time.now - DAY, time.now + DAY)
    expect(lines[0]).toMatchObject({ outcome: 'budget', attempts: 0, agentId: 'agent-1', harness: 'codex' })
    expect(lines[0]!.cost).toBeUndefined()
    expect(lines[1]!.model).not.toContain('sk-ant-api03')
    expect(lines[1]!.used).toHaveLength(200)
  })

  it('adds a turn’s spend by currency and keeps the nearer budget state', () => {
    const one = addSpend(undefined, { cost: [{ currency: 'USD', micros: 5 }], budget: 'near' })
    const two = addSpend(one, { cost: [{ currency: 'USD', micros: 7, priced: true }] })
    expect(two).toEqual({ cost: [{ currency: 'USD', micros: 12, priced: true }], budget: 'near' })
    expect(addSpend(two, { budget: 'over' })?.budget).toBe('over')
    expect(addSpend(addSpend(undefined, { budget: 'over' }), { budget: 'near' })?.budget).toBe('over')
    expect(addSpend(undefined, undefined)).toBeUndefined()
  })
})
