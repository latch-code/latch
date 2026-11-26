import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import type {
  AgentMention,
  AppSnapshot,
  CustomAgent,
  CustomAgentList,
  TaskDetail,
  WorkItemAnswer,
  WorkProposalAnswer,
  WorkThreadAnswer,
} from '@latch/protocol'
import type { HarnessPlugin, ToolCall } from '@latch/sdk'
import { startTestHost } from './helpers/host.ts'

const LIST_AGENTS = 'list_personal_agents'
const CONSULT_AGENT = 'consult_personal_agent'
type Action = 'delegate' | 'refresh' | 'retry' | 'open'
const { createWorkDelegationHandler } = createRequire(import.meta.url)(resolve('apps/desktop/src/work-delegations.cjs')) as {
  createWorkDelegationHandler(
    options: Record<string, unknown>,
  ): (event: { senderFrame: object }, action: Action, itemId: string, input: unknown) => Promise<{ ok: boolean; error?: string }>
}

it('keeps a model’s proposal local until a person sends it and recovers the original target turn after a lost receipt', async () => {
  // Only this fixture offers discovery of a specifically shared local shortcut. It neither contacts the target nor supplies its address.
  const discovery = 'fixture_list_work_shortcuts'
  const prompt = 'Run the release checks'
  let candidates = async (): Promise<{ id: string; name: string }[]> => []
  let shortcutId = ''
  const results = new Map<string, string>()
  const plugin: HarnessPlugin = {
    id: 'proposal-fixture',
    name: 'Proposal fixture',
    version: '1',
    description: '',
    activate(context) {
      context.registerTool({
        name: discovery,
        description: 'List local shortcut names for a proposal',
        parameters: { type: 'object', properties: {} },
        requiresApproval: true,
        async execute() {
          return { text: JSON.stringify(await candidates()) }
        },
      })
      context.registerProvider({
        id: 'proposal-fixture',
        name: 'Proposal fixture',
        model: 'fixture',
        async *stream({ messages }) {
          const last = messages.at(-1)!
          if (last.role === 'tool') results.set(last.toolCallId!, last.content)
          let call: ToolCall | undefined
          if (last.role === 'user') call = { id: 'local-list', name: LIST_AGENTS, arguments: {} }
          if (last.toolCallId === 'local-list')
            call = { id: 'invented-recipient', name: CONSULT_AGENT, arguments: { agentId: shortcutId, question: prompt } }
          if (last.toolCallId === 'invented-recipient') call = { id: 'discovery', name: discovery, arguments: {} }
          if (last.toolCallId === 'discovery') {
            const [candidate] = JSON.parse(last.content) as { id: string; name: string }[]
            if (candidate) call = { id: 'draft', name: 'propose_todo', arguments: { title: candidate.name, prompt } }
          }
          if (call) {
            yield { type: 'tool-call', call }
            yield { type: 'finish', reason: 'tool-calls' }
          } else {
            yield { type: 'text', text: 'Review the local proposal.' }
            yield { type: 'finish', reason: 'stop' }
          }
        },
      })
    },
  }
  const source = await startTestHost({ plugins: [plugin] })
  const privateAnswer = 'Verified in the test workspace.'
  let executions = 0
  const target = await startTestHost({
    tls: true,
    plugins: [
      {
        id: 'verification-fixture',
        name: 'Verification fixture',
        version: '1',
        description: '',
        activate(context) {
          context.registerProvider({
            id: 'verification-fixture',
            name: 'Verification fixture',
            model: 'fixture',
            async *stream() {
              executions++
              yield { type: 'text', text: privateAnswer }
              yield { type: 'finish', reason: 'stop' }
            },
          })
        },
      },
    ],
  })
  try {
    const owner = await source.enroll({ listener: 'unix' })
    const operator = await target.enroll({ listener: 'unix' })
    const recipient = await operator.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        name: 'Execution helper',
        harnessId: 'standard',
        model: { providerId: 'verification-fixture', model: 'fixture' },
        requestId: randomUUID(),
      },
    })
    const shortcut = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        name: 'Release verifier',
        harnessId: 'standard',
        requestId: randomUUID(),
        workComputer: { hostId: target.host.hostId, agentId: recipient.id },
      },
    })
    shortcutId = shortcut.id
    candidates = async () =>
      (await owner.json<CustomAgentList>('custom-agents')).agents
        .filter(
          agent =>
            agent.id === shortcut.id && agent.workComputer?.hostId === target.host.hostId && agent.workComputer.agentId === recipient.id,
        )
        .map(({ id, name }) => ({ id, name }))
    const coordinator = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        name: 'Coordinator',
        harnessId: 'standard',
        mode: 'agent',
        requestId: randomUUID(),
        model: { providerId: plugin.id, model: 'fixture' },
      },
    })
    await owner.json('custom-agents/' + coordinator.id, {
      method: 'PATCH',
      body: { baseRevision: coordinator.revision, requestId: randomUUID(), canConsultAgents: true, canConsultLocalAgents: true },
    })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { customAgentId: coordinator.id, requestId: randomUUID(), prompt: 'Suggest who can verify the release.' },
    })
    const detail = () => owner.json<TaskDetail>('tasks/' + sessionId)
    await expect.poll(async () => (await detail()).summary.status, { timeout: 20_000 }).toBe('waiting-approval')
    const approval = (await detail()).approvals.find(item => item.toolName === discovery)
    expect(approval).toBeDefined()
    await owner.confirmed('approvals/' + approval!.id, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
    await expect.poll(async () => (await detail()).summary.status, { timeout: 20_000 }).toBe('idle')
    expect(JSON.parse(results.get('local-list')!)).not.toContainEqual(expect.objectContaining({ id: shortcut.id }))
    expect(results.has('invented-recipient')).toBe(true)
    expect((await detail()).messages).toContainEqual(expect.objectContaining({ role: 'tool', toolName: CONSULT_AGENT, state: 'failed' }))
    expect(JSON.parse(results.get('discovery')!)).toEqual([{ id: shortcut.id, name: shortcut.name }])
    const before = await owner.json<AppSnapshot>('snapshot')
    expect(before.items ?? []).toHaveLength(0)
    const draft = before.workProposals?.find(proposal => proposal.from.sessionId === sessionId)
    expect(draft).toMatchObject({ kind: 'todo', entries: [{ title: shortcut.name }], from: { customAgentId: coordinator.id } })
    const decision = { requestId: randomUUID(), baseRevision: draft!.revision }
    const accept = () => owner.json<WorkProposalAnswer>(`work/proposals/${draft!.id}/accept`, { method: 'POST', body: decision })
    const { itemIds } = await accept()
    expect(itemIds).toHaveLength(1)
    expect((await accept()).itemIds).toEqual(itemIds)
    const { item } = await owner.json<WorkItemAnswer>('work/items/' + itemIds![0])
    expect(item).toMatchObject({ prompt, sessionIds: [], from: { sessionId, proposalId: draft!.id }, board: { group: 'todo' } })
    expect((await owner.json<{ mentions: AgentMention[] }>(`custom-agents/${coordinator.id}/mentions`)).mentions).toEqual([])
    expect((await operator.json<AppSnapshot>('snapshot')).tasks).toHaveLength(0)

    // The target binding is picked by the person. The production proposal currently stores only its source and text.
    const remote = await target.enroll({ listener: 'tls', scopes: ['view', 'run'], dataScope: 'all' })
    await operator.confirmedJson('devices/' + remote.id, { method: 'PATCH', body: { dataScope: 'all' } })
    const base = '/link/api/'
    const posts = () => owner.json<WorkThreadAnswer>(`work/items/${item.id}/posts`)
    const openSession = vi.fn(async () => ({ ok: true }))
    const confirm = vi.fn(async () => false)
    const gesture = vi.fn(() => false)
    let sends = 0
    let loseResponse = false
    let online = false
    const proxy = {
      deviceId: () => remote.id,
      probe: async () => (online ? { state: 'online', snapshot: await remote.json<AppSnapshot>('snapshot') } : { state: 'offline' }),
      handle: async (request: Request) => {
        const url = new URL(request.url)
        expect(url.pathname.startsWith(base)).toBe(true)
        const path = url.pathname.slice(base.length) + url.search
        if (loseResponse && request.method === 'GET') return new Response(null, { status: 503 })
        if (request.method === 'POST') sends++
        const response = await remote.request(path, {
          method: request.method,
          ...(request.method === 'POST' ? { body: await request.json() } : {}),
        })
        if (request.method === 'POST' && response.ok) {
          await response.body?.cancel()
          loseResponse = true
          return new Response(null, { status: 504 })
        }
        return response
      },
    }
    const delegate = createWorkDelegationHandler({
      senderOf: () => ({ kind: 'full' }),
      gestureOf: gesture,
      confirm,
      openSession,
      proxyFor: (hostId: string) => (hostId === target.host.hostId ? proxy : undefined),
      localRequest: async (method: string, path: string, body?: unknown) => {
        expect(path.startsWith(base)).toBe(true)
        const response = await owner.request(path.slice(base.length), { method, body })
        return { status: response.status, json: await response.json() }
      },
    })
    const frame = { senderFrame: {} }
    const input = {
      requestId: randomUUID(),
      text: item.prompt,
      customAgentId: shortcut.id,
      hostId: target.host.hostId,
      agentId: recipient.id,
    }
    expect(await delegate(frame, 'delegate', item.id, input)).toMatchObject({ error: 'gesture-required' })
    gesture.mockReturnValue(true)
    expect(await delegate(frame, 'delegate', item.id, input)).toMatchObject({ error: 'cancelled' })
    expect((await posts()).posts).toHaveLength(0)
    expect(sends).toBe(0)
    confirm.mockResolvedValue(true)
    expect(await delegate(frame, 'delegate', item.id, input)).toMatchObject({ ok: false })
    const [post] = (await posts()).posts
    expect(post?.remote?.status).toBe('offline')
    expect(sends).toBe(0)
    online = true
    expect(await delegate(frame, 'retry', item.id, post!.id)).toMatchObject({ ok: false })
    expect((await posts()).posts[0]?.remote?.status).toBe('unknown')
    await expect.poll(() => executions).toBe(1)
    loseResponse = false
    await expect
      .poll(async () => {
        await delegate(frame, 'refresh', item.id, post!.id)
        return (await posts()).posts[0]?.remote?.status
      })
      .toBe('completed')
    expect(await delegate(frame, 'retry', item.id, post!.id)).toEqual({ ok: true })
    const final = (await posts()).posts
    expect(final).toHaveLength(1)
    expect(final[0]?.id).toBe(post!.id)
    expect(JSON.stringify(final)).not.toContain(privateAnswer)
    const receipt = final[0]!.remote!
    expect(await delegate(frame, 'open', item.id, post!.id)).toEqual({ ok: true })
    expect(openSession).toHaveBeenCalledExactlyOnceWith(target.host.hostId, receipt.sessionId, receipt.messageId)
    const targetDetail = await operator.json<TaskDetail>('tasks/' + receipt.sessionId)
    expect(targetDetail.messages).toContainEqual(expect.objectContaining({ id: receipt.messageId, text: privateAnswer, role: 'assistant' }))
    const targetReceipt = (await remote.json<{ mentions: AgentMention[] }>('custom-agents/general/mentions')).mentions
    expect(targetReceipt).toMatchObject([{ id: receipt.mentionId, initiator: 'person', targetAgentId: recipient.id, text: prompt }])
    expect(targetDetail.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([prompt])
    expect(sends).toBe(1)
    expect(executions).toBe(1)
    expect((await detail()).messages.filter(message => message.role === 'user')).toHaveLength(1)
  } finally {
    await Promise.all([source.close(), target.close()])
  }
}, 60_000)
