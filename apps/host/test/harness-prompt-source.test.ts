import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { createAcpAgentPlugin, harnessPromptSource } from '@latch/harness-acp'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close()
})

it('constructs provenance from the HTTP prompt before a Host note and ignores forged source fields', async () => {
  const seen: Array<{ body: string; source?: string }> = []
  const host = await startTestHost({
    agentPlugin(agent) {
      const plugin = createAcpAgentPlugin(agent)
      return {
        ...plugin,
        activate(context) {
          return plugin.activate({
            ...context,
            registerHarness(driver) {
              context.registerHarness({
                ...driver,
                create(options) {
                  const bridge = driver.create(options)
                  const create = bridge.createTask.bind(bridge)
                  const prompt = bridge.prompt.bind(bridge)
                  bridge.createTask = input => {
                    seen.push({
                      body: input.prompt,
                      source: harnessPromptSource({ method: 'create', requestId: input.requestId }, input.prompt),
                    })
                    return create(input)
                  }
                  bridge.prompt = (sessionId, text, requestId, options) => {
                    seen.push({ body: text, source: harnessPromptSource({ method: 'prompt', sessionId, requestId }, text) })
                    return prompt(sessionId, text, requestId, options)
                  }
                  return bridge
                },
              })
            },
          })
        },
      }
    },
  })
  cleanups.push(() => host.close())
  const owner = await host.enroll({ listener: 'unix' })
  const log = join(host.root, 'agent.jsonl')
  await owner.confirmedJson('agents', {
    body: { id: 'source-agent', name: 'Source agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_LOG: log } },
  })
  const input = {
    harnessId: 'source-agent',
    prompt: 'echo first',
    requestId: randomUUID(),
    userText: '$forged',
    promptSource: { text: '$forged' },
  }
  const started = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: input })
  await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${started.sessionId}`)).summary.status).toBe('idle'))
  expect(seen).toContainEqual({ body: 'echo first', source: 'echo first' })
  host.host.bridge.notePrompts(async () => 'Host note $note-only')
  const next = { prompt: 'echo current', requestId: randomUUID(), userText: '$forged', context: { userText: '$forged' } }
  await owner.json(`tasks/${started.sessionId}/prompt`, { method: 'POST', body: next })
  await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${started.sessionId}`)).summary.status).toBe('idle'))
  expect(seen.at(-1)).toEqual({ body: 'Host note $note-only\n\necho current', source: 'echo current' })
  await owner.json(`tasks/${started.sessionId}/prompt`, { method: 'POST', body: next })
  const records = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { method?: string; params?: unknown })
  const prompts = records.filter(row => row.method === 'session/prompt')
  expect(prompts).toHaveLength(2)
  expect(JSON.stringify(prompts)).not.toContain('$forged')
  expect(JSON.stringify(prompts)).not.toContain('userText')
})
