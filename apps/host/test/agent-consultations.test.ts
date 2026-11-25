import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import type { AgentMention, CustomAgent, TaskDetail } from '@latch/protocol'
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
