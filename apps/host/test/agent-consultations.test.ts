import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import type { AgentMention, CustomAgent, CustomAgentPatch, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import type { ModelProvider } from '@latch/sdk'
import { CONSULT_AGENT, LIST_AGENTS } from '../src/agent-consultations.ts'
import { startTestHost } from './helpers/host.ts'

test('a personal Agent chooses a peer on a human turn only while its own switch is enabled', async () => {
  const privateMarker = 'lmg1.' + 'T'.repeat(43)
  let targetId = ''
  const offers = new Map<string, string[]>()
  const results: string[] = []
  const peerQuestion = '来自个人 Agent「Editor」的委托\n\nCheck the draft'
  const heldQuestion = '来自个人 Agent「Editor」的委托\n\nHold this answer'
  let peerContext: string[] = []
  let resume = () => {}
  const paused = new Promise<void>(resolve => {
    resume = resolve
  })
  let releasePeer = () => {}
  const peerPaused = new Promise<void>(resolve => {
    releasePeer = resolve
  })
  const provider: ModelProvider = {
    id: 'consult-model',
    name: 'Consultation fixture',
    model: 'test',
    async *stream({ messages, tools }) {
      const last = messages.at(-1)!
      if (last.role === 'tool') {
        results.push(last.content)
        if (last.toolCallId === 'list-for-review') {
          yield {
            type: 'tool-call',
            call: { id: randomUUID(), name: CONSULT_AGENT, arguments: { agentId: targetId, question: 'Check the draft' } },
          }
          yield { type: 'finish', reason: 'tool-calls' }
          return
        }
        yield { type: 'text', text: 'The review is in.' }
      } else {
        offers.set(
          last.content,
          (tools ?? []).map(item => item.name),
        )
        if (last.content === 'Ask while I change permissions') {
          yield {
            type: 'tool-call',
            call: { id: 'pending-consult', name: CONSULT_AGENT, arguments: { agentId: targetId, question: 'Hold this answer' } },
          }
          yield { type: 'finish', reason: 'tool-calls' }
          return
        }
        if (last.content === peerQuestion) peerContext = messages.map(message => message.content)
        if (last.content === heldQuestion) {
          await peerPaused
          yield { type: 'text', text: 'Reply after the permission change' }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        if (last.content === 'Pause before calling') {
          await paused
          yield {
            type: 'tool-call',
            call: { id: randomUUID(), name: CONSULT_AGENT, arguments: { agentId: targetId, question: 'Withdrawn' } },
          }
          yield { type: 'finish', reason: 'tool-calls' }
          return
        }
        if (last.content === 'Review this together' && tools?.some(item => item.name === LIST_AGENTS)) {
          yield { type: 'tool-call', call: { id: 'list-for-review', name: LIST_AGENTS, arguments: {} } }
          yield { type: 'finish', reason: 'tool-calls' }
          return
        }
        yield { type: 'text', text: 'Reviewed by the peer.' }
      }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const host = await startTestHost({
    providerId: provider.id,
    plugins: [
      {
        id: 'consult-fixture',
        name: 'Collaboration',
        version: '1',
        description: '',
        activate(ctx) {
          ctx.registerProvider(provider)
        },
      },
    ],
  })
  try {
    const user = await host.enroll({ listener: 'unix' })
    const create = (name: string, description = '') =>
      user.json<CustomAgent>('custom-agents', {
        method: 'POST',
        body: {
          name,
          description,
          requestId: randomUUID(),
          harnessId: 'standard',
          mode: 'agent',
          skills: [],
          model: { providerId: provider.id, model: provider.model },
        },
      })
    const source = await create('Editor')
    const target = await create('Reviewer', 'Reviews proposals ' + privateMarker)
    targetId = target.id
    const configure = (agent: CustomAgent, enabled: boolean) =>
      user.json<CustomAgent>('custom-agents/' + agent.id, {
        method: 'PATCH',
        body: { requestId: randomUUID(), baseRevision: agent.revision, canConsultAgents: enabled },
      })
    await configure(target, true)
    const enabled = await configure(source, true)
    const { sessionId } = await user.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), customAgentId: source.id, prompt: 'Review this together' },
    })
    const detail = () => user.json<TaskDetail>('tasks/' + sessionId)
    const wait = () => expect.poll(async () => (await detail()).summary.status, { timeout: 12_000 }).toBe('idle')
    await wait()
    expect(offers.get('Review this together')).toContain(LIST_AGENTS)
    expect(results[0]).toContain(target.id)
    expect(results[0]).toContain('Reviews proposals [redacted]')
    expect(results[0]).not.toContain(privateMarker)
    expect(results.at(-1)).toContain('Reviewed by the peer.')
    expect(offers.get(peerQuestion)).toEqual([])
    expect(peerContext).toContain(peerQuestion)
    expect(peerContext.join(' ')).not.toContain('Review this together')
    const records = () => user.json<{ mentions: AgentMention[] }>('custom-agents/' + source.id + '/mentions')
    expect((await records()).mentions).toMatchObject([
      {
        initiator: 'agent',
        targetAgentId: targetId,
        sourceSessionId: sessionId,
        text: 'Check the draft',
        status: 'completed',
        reply: { text: 'Reviewed by the peer.' },
      },
    ])
    const targetSession = (await records()).mentions[0]!.targetSessionId
    const targetChat = await user.json<TaskDetail>('tasks/' + targetSession)
    expect(targetChat.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([peerQuestion])
    expect((await detail()).messages.find(item => item.role === 'user')?.origin).toBe('agent-mention')
    expect((await user.json<{ mentions: AgentMention[] }>('custom-agents/' + target.id + '/mentions')).mentions).toEqual([])
    // A consultation already in flight loses its grant when the person's mode changes, even if they switch back.
    await user.json('tasks/' + sessionId + '/prompt', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: 'Ask while I change permissions' },
    })
    await expect.poll(() => offers.has(heldQuestion)).toBe(true)
    for (const value of ['plan', 'ask']) {
      await user.json('tasks/' + sessionId + '/config', { method: 'POST', body: { requestId: randomUUID(), configId: 'mode', value } })
    }
    expect(offers.get(heldQuestion)).toEqual([])
    releasePeer()
    await wait()
    expect(results.at(-1)).not.toContain('Reply after the permission change')
    expect((await records()).mentions).toHaveLength(2)

    await user.json('tasks/' + sessionId + '/prompt', { method: 'POST', body: { requestId: randomUUID(), prompt: 'Pause before calling' } })
    await expect.poll(() => offers.has('Pause before calling')).toBe(true)
    await configure(enabled, false)
    resume()
    await wait()
    await user.json('tasks/' + sessionId + '/prompt', { method: 'POST', body: { requestId: randomUUID(), prompt: 'Check again' } })
    await wait()
    expect(offers.get('Check again')).not.toContain(CONSULT_AGENT)
    expect((await records()).mentions).toHaveLength(2)

    // A real MCP bridge to a fixture ACP process, without a desktop browser provider.
    await user.confirmedJson('agents', {
      body: { id: 'consult-acp', name: 'ACP', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_MCP: 'dsh' } },
    })
    const acp = await user.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: { name: 'ACP editor', requestId: randomUUID(), harnessId: 'consult-acp', mode: 'agent', skills: [] },
    })
    await configure(acp, true)
    const steps = [{ tool: CONSULT_AGENT, args: { agentId: targetId, question: 'Review from ACP' } }]
    const other = await user.confirmedJson<{ sessionId: string }>('tasks', {
      body: { requestId: randomUUID(), customAgentId: acp.id, prompt: 'browser ' + JSON.stringify(steps) },
    })
    const acpDetail = () => user.json<TaskDetail>('tasks/' + other.sessionId)
    await expect.poll(async () => (await acpDetail()).summary.status, { timeout: 15_000 }).toBe('idle')
    expect(
      (await acpDetail()).messages
        .filter(m => m.role === 'assistant')
        .map(m => m.text)
        .join(' '),
    ).toContain('Reviewed by the peer.')
    expect((await user.json<{ mentions: AgentMention[] }>('custom-agents/' + acp.id + '/mentions')).mentions).toMatchObject([
      { initiator: 'agent', targetAgentId: targetId, status: 'completed' },
    ])
  } finally {
    releasePeer()
    resume()
    await host.close()
  }
})

test('a local grant delivers to an opted-in Agent on its own Harness and model, including follow-up turns', async () => {
  let targetId = ''
  const directories: string[] = []
  let resume = () => {}
  const pause = new Promise<void>(resolve => {
    resume = resolve
  })
  const provider: ModelProvider = {
    id: 'coordinator-model',
    name: 'Coordinator',
    model: 'coordinator',
    async *stream({ messages }) {
      const last = messages.at(-1)!
      if (last.role === 'user') {
        yield { type: 'tool-call', call: { id: 'list-' + randomUUID(), name: LIST_AGENTS, arguments: {} } }
      } else if (last.toolCallId?.startsWith('list-')) {
        directories.push(last.content)
        if (messages.findLast(row => row.role === 'user')?.content === 'Pause') await pause
        // A learned ID must pass the same checks as the directory.
        yield { type: 'tool-call', call: { id: randomUUID(), name: CONSULT_AGENT, arguments: { agentId: targetId, question: 'Review' } } }
      } else {
        yield { type: 'text', text: last.content }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      yield { type: 'finish', reason: 'tool-calls' }
    },
  }
  const host = await startTestHost({
    providerId: provider.id,
    plugins: [
      {
        id: 'coordinator-provider',
        name: 'Coordinator',
        version: '1',
        description: '',
        activate(ctx) {
          ctx.registerProvider(provider)
        },
      },
    ],
  })
  try {
    const user = await host.enroll({ listener: 'unix' })
    const external = 'independent-acp'
    await user.confirmedJson('agents', {
      body: { id: external, name: 'Independent', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_CONFIG: 'options' } },
    })
    const create = (name: string, harnessId: string) =>
      user.json<CustomAgent>('custom-agents', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name,
          harnessId,
          mode: 'agent',
          skills: [],
          ...(harnessId === external
            ? { engineOptions: { model: 'large' } }
            : { model: { providerId: provider.id, model: provider.model } }),
        },
      })
    const patch = (agent: CustomAgent, fields: Partial<CustomAgentPatch>) =>
      user.json<CustomAgent>('custom-agents/' + agent.id, {
        method: 'PATCH',
        body: { requestId: randomUUID(), baseRevision: agent.revision, ...fields },
      })
    const source = await create('Coordinator', 'standard')
    const target = await create('Writer', external)
    const sibling = await create('Another writer', external)
    targetId = target.id
    const enabled = await patch(source, { canConsultAgents: true, canConsultDeepSeek: true })
    let receiver = await patch(target, { useOwnPermissionsForConsultations: true })
    const receipts = async () => (await user.json<{ mentions: AgentMention[] }>('custom-agents/' + source.id + '/mentions')).mentions
    const { sessionId } = await user.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { customAgentId: source.id, requestId: randomUUID(), prompt: 'Legacy' },
    })
    const settled = () =>
      expect.poll(async () => (await user.json<TaskDetail>('tasks/' + sessionId)).summary.status, { timeout: 15_000 }).toBe('idle')
    const ask = async (prompt: string) => {
      await user.json('tasks/' + sessionId + '/prompt', { method: 'POST', body: { requestId: randomUUID(), prompt } })
      await settled()
    }
    await settled()
    expect(directories.at(-1)).not.toContain(target.id)
    expect(await receipts()).toHaveLength(0)
    await patch(enabled, { canConsultAgents: true, canConsultLocalAgents: true })
    const pending = ask('Pause')
    await expect.poll(() => directories.length).toBe(2)
    expect(directories.at(-1)).toContain(target.id)
    receiver = await patch(receiver, { useOwnPermissionsForConsultations: false })
    receiver = await patch(receiver, { useOwnPermissionsForConsultations: true })
    resume()
    await pending
    expect(await receipts()).toHaveLength(0)

    for (const prompt of ['First', 'Follow up']) await ask(prompt)
    const records = await receipts()
    expect(directories.at(-1)).not.toContain(sibling.id)
    expect(records).toHaveLength(2)
    for (const record of records)
      expect(record).toMatchObject({
        targetAgentId: target.id,
        consultationMode: 'own-permissions',
        status: 'completed',
        targetSessionId: records[0]!.targetSessionId,
      })
    const chat = await user.json<TaskDetail>('tasks/' + records[0]!.targetSessionId)
    expect(chat.summary.harnessId).toBe(external)
    expect(chat.config?.find(option => option.id === 'model')?.currentValue).toBe('large')
    expect(chat.messages.filter(message => message.role === 'user')).toHaveLength(2)
    await patch(receiver, { useOwnPermissionsForConsultations: false })
    await ask('Revoked')
    expect(directories.at(-1)).not.toContain(target.id)
    expect(await receipts()).toHaveLength(2)
  } finally {
    resume()
    await host.close()
  }
})
