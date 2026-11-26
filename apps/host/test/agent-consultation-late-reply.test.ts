import { randomUUID } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import type { AgentMention, CustomAgent, CustomAgentPatch, TaskDetail } from '@latch/protocol'
import type { ModelProvider } from '@latch/sdk'
import { CONSULT_AGENT, ConsultationReplies } from '../src/agent-consultations.ts'
import { startTestHost } from './helpers/host.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test.each(['approval', 'deadline'] as const)('keeps the late consultation reply on its original receipt after %s', async exit => {
  const sourcePrompt = 'Ask the reviewer about the milestone'
  const question = 'Check the milestone'
  const peerPrompt = `来自个人 Agent「Editor」的委托\n\n${question}`
  const lateReply = 'The original milestone needs a rollback plan.'
  const laterPrompt = 'Check the release notes instead'
  const laterReply = 'The release notes are ready.'
  const requestApproval = deferred()
  const finishTarget = deferred()
  const checkMilestone = vi.fn(async () => ({ text: 'Milestone checked' }))
  let targetId = ''
  const provider = {
    id: 'late-consult-model',
    name: 'Late consultation fixture',
    model: 'fixture',
    stream: vi.fn<ModelProvider['stream']>(async function* ({ messages }) {
      const last = messages.at(-1)!
      const prompt = messages.findLast(message => message.role === 'user')?.content
      if (last.role === 'user' && prompt === sourcePrompt) {
        yield { type: 'tool-call', call: { id: 'ask-peer', name: CONSULT_AGENT, arguments: { agentId: targetId, question } } }
        yield { type: 'finish', reason: 'tool-calls' }
        return
      }
      if (last.role === 'user' && prompt === peerPrompt) {
        await requestApproval.promise
        yield { type: 'tool-call', call: { id: 'check-milestone', name: 'check_milestone', arguments: {} } }
        yield { type: 'finish', reason: 'tool-calls' }
        return
      }
      if (prompt === peerPrompt) await finishTarget.promise
      const text = prompt === peerPrompt ? lateReply : prompt === laterPrompt ? laterReply : 'The review is still pending.'
      yield { type: 'text', text }
      yield { type: 'finish', reason: 'stop' }
    }),
  } satisfies ModelProvider
  const host = await startTestHost({
    demo: false,
    providerId: provider.id,
    plugins: [
      {
        id: 'late-consultation-fixture',
        name: 'Late consultation fixture',
        version: '1',
        description: '',
        activate(ctx) {
          ctx.registerProvider(provider)
          ctx.registerTool({
            name: 'check_milestone',
            description: 'Check the milestone fixture',
            parameters: { type: 'object', properties: {} },
            requiresApproval: true,
            execute: checkMilestone,
          })
        },
      },
    ],
  })
  const wait = vi.spyOn(ConsultationReplies.prototype, 'wait')
  try {
    const user = await host.enroll({ listener: 'unix' })
    const create = (name: string) =>
      user.json<CustomAgent>('custom-agents', {
        method: 'POST',
        body: {
          name,
          requestId: randomUUID(),
          harnessId: 'standard',
          mode: 'agent',
          skills: [],
          model: { providerId: provider.id, model: provider.model },
        },
      })
    const configure = (agent: CustomAgent, fields: Partial<CustomAgentPatch>) =>
      user.json(`custom-agents/${agent.id}`, {
        method: 'PATCH',
        body: { requestId: randomUUID(), baseRevision: agent.revision, ...fields },
      })
    const source = await create('Editor')
    const target = await create('Reviewer')
    targetId = target.id
    await configure(source, { canConsultAgents: true, canConsultLocalAgents: true })
    await configure(target, { useOwnPermissionsForConsultations: true })

    if (exit === 'approval') requestApproval.resolve()
    const { sessionId } = await user.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), customAgentId: source.id, prompt: sourcePrompt },
    })
    const detail = (id: string) => user.json<TaskDetail>(`tasks/${id}`)
    const receipts = async () => (await user.json<{ mentions: AgentMention[] }>(`custom-agents/${source.id}/mentions`)).mentions
    const status = async () => (await receipts())[0]?.status
    const sourceCalls = () => provider.stream.mock.calls.map(([input]) => input).filter(input => input.run?.sessionId === sessionId)
    const sourceIdle = () => expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
    const exitStatus = exit === 'deadline' ? 'running' : 'waiting-approval'
    await expect.poll(status).toBe(exitStatus)
    if (exit === 'deadline') {
      await expect.poll(() => wait.mock.calls.length).toBe(1)
      // Let the live wait's next heartbeat see an elapsed deadline while keeping HTTP and disk I/O on real timers.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 45_000)
      try {
        await sourceIdle()
      } finally {
        clock.mockRestore()
      }
    } else await sourceIdle()

    const [sent] = await receipts()
    expect(sent).toMatchObject({ sourceSessionId: sessionId, targetAgentId: target.id, status: exitStatus })
    expect(sent.reply).toBeUndefined()
    const sourceTurns = sourceCalls()
    expect(sourceTurns).toHaveLength(2)
    expect(sourceTurns[0]?.messages.at(-1)).toMatchObject({ role: 'user', content: sourcePrompt })
    const toolResult = sourceTurns[1]?.messages.at(-1)
    expect(toolResult?.role).toBe('tool')
    expect(JSON.parse(toolResult!.content)).toMatchObject({ agentId: target.id, status: exitStatus })
    const sourceMessages = (await detail(sessionId)).messages
    expect(sourceMessages.filter(message => message.role === 'user').map(message => message.text)).toEqual([sourcePrompt])
    expect(sourceMessages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual([
      'The review is still pending.',
    ])

    requestApproval.resolve()
    await expect.poll(async () => (await receipts())[0]?.approval?.id).toEqual(expect.any(String))
    const [pending] = await receipts()
    const identity = { id: sent.id, requestId: sent.requestId, targetMessageId: sent.targetMessageId }
    const targetSession = sent.targetSessionId!
    expect(pending).toMatchObject({ ...identity, targetSessionId: targetSession, status: 'waiting-approval' })
    const targetBeforeApproval = await detail(targetSession)
    expect(pending.approval).toMatchObject({ id: targetBeforeApproval.approvals[0].id, runId: targetBeforeApproval.summary.runId })
    expect(checkMilestone).not.toHaveBeenCalled()
    await user.json(`approvals/${pending.approval!.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
    await expect.poll(status).toBe('running')
    expect((await receipts())[0]).toMatchObject({ ...identity, status: 'running' })
    expect((await receipts())[0]?.reply).toBeUndefined()
    finishTarget.resolve()
    await expect.poll(async () => (await detail(targetSession)).summary.status).toBe('idle')
    const firstTargetMessages = (await detail(targetSession)).messages
    const firstReply = firstTargetMessages.find(message => message.role === 'assistant' && message.text === lateReply)!
    const originalReply = { ...identity, reply: { messageId: firstReply.id, text: lateReply } }
    if (exit === 'approval') expect(await receipts()).toMatchObject([{ ...originalReply, status: 'completed' }])

    await user.json(`tasks/${targetSession}/prompt`, { method: 'POST', body: { requestId: randomUUID(), prompt: laterPrompt } })
    await expect.poll(async () => (await detail(targetSession)).summary.status).toBe('idle')
    const targetMessages = (await detail(targetSession)).messages
    expect(targetMessages.filter(message => message.role === 'user').map(message => message.text)).toEqual([peerPrompt, laterPrompt])
    expect(targetMessages.at(-1)?.text).toBe(laterReply)
    expect(await receipts()).toMatchObject([exit === 'approval' ? { ...originalReply, status: 'completed' } : originalReply])
    expect((await detail(sessionId)).messages).toEqual(sourceMessages)
    expect((await detail(sessionId)).summary.status).toBe('idle')
    expect(sourceCalls()).toHaveLength(2)
    expect(wait).toHaveBeenCalledTimes(1)
    expect(checkMilestone).toHaveBeenCalledTimes(1)
  } finally {
    wait.mockRestore()
    requestApproval.resolve()
    finishTarget.resolve()
    await host.close()
  }
})
