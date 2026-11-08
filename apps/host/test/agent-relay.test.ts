import { expect, test } from 'vitest'
import type { TaskSummary } from '@latch/protocol'
import { RELAY_LIMIT, RelayChain, type RelayOptions } from '../src/agent-relay.ts'

type Summary = Pick<TaskSummary, 'status' | 'runId' | 'runOutcome'>

/** Agents whose turns end when a test says so; a cancel is only a request until the test settles the turn. */
function agents(names: string[]) {
  const bases = new Map(names.map(name => [name, `basis-${name}`]))
  const sessions = new Map<string, Summary>()
  const started: string[] = []
  const cancels: Array<{ sessionId: string; runId?: string }> = []
  const options: RelayOptions<string> = {
    members: names,
    basis: name => bases.get(name)!,
    async start(name, index) {
      const sessionId = `${name}-${index}`
      started.push(name)
      sessions.set(sessionId, { status: 'running', runId: `run-${name}` })
      return { sessionId }
    },
    summary: async sessionId => ({ ...sessions.get(sessionId)! }),
    async cancel(sessionId, runId) {
      cancels.push({ sessionId, ...(runId ? { runId } : {}) })
    },
    pollMs: 1,
  }
  const finish = (name: string, runOutcome: NonNullable<Summary['runOutcome']>) => {
    const id = [...sessions.keys()].find(key => key.startsWith(`${name}-`))!
    sessions.set(id, { status: runOutcome === 'completed' ? 'idle' : runOutcome, runOutcome })
  }
  const until = async (check: () => boolean) => {
    for (let tries = 0; !check(); tries++) {
      if (tries > 2000) throw new Error('timed out')
      await new Promise(resolve => setTimeout(resolve, 1))
    }
  }
  return { bases, started, cancels, options, finish, until }
}

test('one message reaches at most the relay limit plus the first agent, in the chosen order', async () => {
  const names = Array.from({ length: RELAY_LIMIT + 2 }, (_, index) => `agent${index}`)
  expect(() => new RelayChain(agents(names).options)).toThrow(expect.objectContaining({ status: 400, code: 'relay-limit' }))
  expect(() => new RelayChain(agents([]).options)).toThrow(expect.objectContaining({ code: 'relay-limit' }))

  const fake = agents(names.slice(0, RELAY_LIMIT + 1))
  const chain = new RelayChain(fake.options)
  for (const name of names.slice(0, RELAY_LIMIT + 1)) {
    await fake.until(() => fake.started.includes(name))
    fake.finish(name, 'completed')
  }
  await expect(chain.done).resolves.toEqual({ state: 'completed', sessionIds: ['agent0-0', 'agent1-1', 'agent2-2', 'agent3-3'] })
  expect(fake.started).toEqual(['agent0', 'agent1', 'agent2', 'agent3'])
})

test('a turn that fails, is cancelled or is interrupted ends the chain before the next agent', async () => {
  for (const outcome of ['failed', 'cancelled', 'interrupted'] as const) {
    const fake = agents(['a', 'b', 'c'])
    const chain = new RelayChain(fake.options)
    await fake.until(() => fake.started.includes('a'))
    fake.finish('a', 'completed')
    await fake.until(() => fake.started.includes('b'))
    fake.finish('b', outcome)
    await expect(chain.done).resolves.toEqual({ state: outcome, sessionIds: ['a-0', 'b-1'] })
    expect(fake.started).toEqual(['a', 'b'])
  }
})

test("a change to any agent's settings stops the chain before the next agent starts", async () => {
  const fake = agents(['a', 'b', 'c'])
  const chain = new RelayChain(fake.options)
  await fake.until(() => fake.started.includes('a'))
  // An agent later in the order changes while the first one works.
  fake.bases.set('c', 'basis-c-edited')
  fake.finish('a', 'completed')
  await expect(chain.done).resolves.toEqual({ state: 'interrupted', reason: 'changed', sessionIds: ['a-0'] })
  expect(fake.started).toEqual(['a'])
})

test('a stop is confirmed only after the running turn has settled, and no later agent starts', async () => {
  const fake = agents(['a', 'b'])
  const chain = new RelayChain(fake.options)
  await fake.until(() => fake.started.includes('a'))
  let confirmed = false
  const stopped = chain.stop().then(result => {
    confirmed = true
    return result
  })
  await fake.until(() => fake.cancels.length > 0)
  expect(fake.cancels).toEqual([{ sessionId: 'a-0', runId: 'run-a' }])
  // The agent has been asked to stop but is still running: nothing is confirmed yet.
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(confirmed).toBe(false)
  fake.finish('a', 'cancelled')
  await expect(stopped).resolves.toEqual({ state: 'cancelled', sessionIds: ['a-0'] })
  expect(fake.started).toEqual(['a'])
  expect(fake.cancels).toHaveLength(1)
})

test('a failed start or read ends the chain and asks a turn of unknown outcome to stop', async () => {
  const fake = agents(['a', 'b'])
  const failure = new Error('driver gone')
  let reads = 0
  const chain = new RelayChain({
    ...fake.options,
    async summary(sessionId) {
      if (++reads > 1) throw failure
      return fake.options.summary(sessionId)
    },
  })
  await expect(chain.done).resolves.toEqual({ state: 'interrupted', sessionIds: ['a-0'], error: failure })
  expect(fake.cancels).toEqual([{ sessionId: 'a-0' }])
  expect(fake.started).toEqual(['a'])
})
