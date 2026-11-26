import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
type ComputerResult = { ok: boolean; error?: string }

const { createWorkDelegationHandler } = createRequire(import.meta.url)('../src/work-delegations.cjs') as {
  createWorkDelegationHandler(
    options: Record<string, unknown>,
  ): (event: unknown, action: string, itemId: string, input: unknown) => Promise<ComputerResult>
}
const itemId = 'itm_' + 'A'.repeat(22)
const postId = 'pst_' + 'B'.repeat(22)
const deviceId = 'dev_' + 'D'.repeat(22)
const hostId = 'a'.repeat(52)
const agentId = 'agt_00000000-0000-4000-8000-000000000001'
const customAgentId = 'agt_00000000-0000-4000-8000-000000000002'
const dispatchId = '00000000-0000-4000-8000-000000000003'
const mentionId = '00000000-0000-4000-8000-000000000004'
const target = { customAgentId, agentId, hostId }
const input = { ...target, text: 'Which test failed?', requestId: 'request-one' }
const when = Date.parse('2026-01-01T10:00:00Z')
const mention = {
  id: mentionId,
  requestId: dispatchId,
  initiator: 'person',
  sourceAgentId: 'general',
  targetAgentId: agentId,
  text: input.text,
  status: 'completed',
  targetSessionId: 'session-one',
  targetMessageId: 'message-one',
  reply: { messageId: 'reply-one' },
}
function setup() {
  const frame = { senderFrame: {} }
  const snapshot = {
    host: { hostId },
    device: { id: deviceId, dataScope: 'all', scopes: ['view', 'run'] },
    catalog: { features: { agentWorkComputer: true, agentMentionLookup: true } },
    customAgents: [{ id: agentId, name: 'Work assistant', available: true }],
  }
  const post = {
    id: postId,
    at: new Date(when).toISOString(),
    text: input.text,
    remote: { ...target, revision: 1, status: 'prepared' } as Record<string, unknown>,
  }
  const localRequest = vi.fn(
    async (method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; json: unknown }> => {
      if (method === 'POST') {
        expect(path).toBe('/link/api/work/items/' + itemId + '/posts/remote')
        expect(body).toEqual(input)
      } else if (method === 'PATCH') {
        expect(path).toBe('/link/api/work/items/' + itemId + '/posts/' + postId + '/remote')
        expect(body?.baseRevision).toBe(post.remote.revision)
        const { baseRevision, ...fields } = body!
        post.remote = { ...post.remote, ...fields, revision: Number(baseRevision) + 1 }
        return { status: 200, json: { post: structuredClone(post) } }
      }
      return { status: 200, json: { post: structuredClone(post), dispatchId } }
    },
  )
  const probe = vi.fn(async () => ({ state: 'online', snapshot }))
  const state = { accepted: false, loseAnswer: false }
  const handle = vi.fn(async (req: Request) => {
    const path = new URL(req.url)
    expect(path.hostname).toBe('h-' + hostId)
    if (req.method === 'GET') {
      expect(path.pathname).toBe('/link/api/custom-agents/general/mentions/by-request/' + dispatchId)
      return state.accepted ? Response.json(mention) : Response.json({ error: 'agent-mention-missing' }, { status: 404 })
    }
    expect(path.pathname + path.search).toBe('/link/api/custom-agents/general/mentions?receipt=reference')
    expect(await req.json()).toEqual({ requestId: dispatchId, target: { kind: 'agent', customAgentId: agentId }, text: input.text })
    expect(post.remote).toMatchObject({ deviceId, status: 'unknown' })
    state.accepted = true
    if (state.loseAnswer) throw Error('connection lost')
    return Response.json(mention)
  })
  const proxy = { probe, handle, deviceId: () => snapshot.device.id }
  const confirm = vi.fn(async () => true)
  const senderOf = vi.fn(() => ({ kind: 'full' }))
  const gestureOf = vi.fn(() => true)
  const openSession = vi.fn(async () => ({ ok: true }))
  const now = vi.fn(() => when)
  const handler = createWorkDelegationHandler({
    senderOf,
    gestureOf,
    localRequest,
    proxyFor: () => proxy,
    confirm,
    openSession,
    now,
  })
  const call = (action: string) => handler(frame, action, itemId, action === 'delegate' ? input : postId)
  return { call, now, post, frame, probe, handle, state, snapshot, confirm, senderOf, gestureOf, openSession, localRequest }
}

describe('foreground work delegation on a pinned computer', () => {
  it('confirms the exact target and text, recovers a lost POST by receipt, and opens the exact result only on a later click', async () => {
    const x = setup()
    x.state.loseAnswer = true
    expect(await x.call('delegate')).toEqual({ ok: true })
    expect(x.confirm).toHaveBeenCalledExactlyOnceWith({ hostId, agentId, agentName: 'Work assistant', text: input.text })
    expect(x.post.remote).toMatchObject({ deviceId, mentionId, status: 'completed', sessionId: 'session-one', messageId: 'reply-one' })
    x.probe.mockClear()
    expect(await x.call('refresh')).toEqual({ ok: true })
    expect(x.probe).not.toHaveBeenCalled()
    expect(await x.call('retry')).toEqual({ ok: true })
    expect(x.handle.mock.calls.filter(([req]) => req.method === 'POST')).toHaveLength(1)
    expect(x.openSession).not.toHaveBeenCalled()
    x.gestureOf.mockReturnValue(false)
    expect(await x.call('open')).toMatchObject({ error: 'gesture-required' })
    x.gestureOf.mockReturnValue(true)
    expect(await x.call('open')).toEqual({ ok: true })
    expect(x.openSession).toHaveBeenCalledExactlyOnceWith(hostId, 'session-one', 'reply-one')
  })
  it('rejects other windows, missing clicks and canceled confirmations before reserving or sending the text', async () => {
    const x = setup()
    x.senderOf.mockReturnValueOnce({ kind: 'remote' })
    expect(await x.call('delegate')).toMatchObject({ error: 'forbidden' })
    x.gestureOf.mockReturnValueOnce(false)
    expect(await x.call('delegate')).toMatchObject({ error: 'gesture-required' })
    x.confirm.mockResolvedValueOnce(false)
    expect(await x.call('delegate')).toMatchObject({ error: 'cancelled' })
    expect(x.localRequest).not.toHaveBeenCalled()
    expect(x.handle).not.toHaveBeenCalled()
  })
  it('keeps a refused draft editable and rechecks the recipient after the native prompt', async () => {
    const x = setup()
    x.localRequest.mockResolvedValueOnce({ status: 422, json: { error: 'agent-mention-secret', message: 'private text' } })
    expect(await x.call('delegate')).toMatchObject({ ok: false, error: 'agent-mention-secret' })
    expect(x.handle).not.toHaveBeenCalled()
    x.confirm.mockImplementationOnce(async () => {
      x.snapshot.customAgents = []
      return true
    })
    expect(await x.call('delegate')).toMatchObject({ ok: false })
    expect(x.post.remote.status).toBe('prepared')
    expect(x.handle.mock.calls.every(([req]) => req.method === 'GET')).toBe(true)
  })
  it('keeps offline posts recoverable and never sends from a refresh', async () => {
    const x = setup()
    x.probe.mockResolvedValueOnce({ state: 'offline', snapshot: x.snapshot })
    expect(await x.call('delegate')).toMatchObject({ ok: false })
    expect(x.post.remote.status).toBe('offline')
    expect(await x.call('refresh')).toMatchObject({ ok: false })
    expect(x.handle).not.toHaveBeenCalled()
    expect(await x.call('retry')).toEqual({ ok: true })
    expect(x.post.remote.status).toBe('completed')
  })
  it('refuses readback, navigation and redelivery from a different enrollment or mismatched turn', async () => {
    const x = setup()
    expect(await x.call('delegate')).toEqual({ ok: true })
    x.handle.mockClear()
    x.snapshot.device.id = 'dev_' + 'E'.repeat(22)
    for (const action of ['refresh', 'open', 'retry']) expect(await x.call(action)).toMatchObject({ ok: false })
    expect(x.handle).not.toHaveBeenCalled()
    x.snapshot.device.id = deviceId
    x.handle.mockResolvedValueOnce(Response.json({ ...mention, targetSessionId: 'somebody-else' }))
    expect(await x.call('open')).toMatchObject({ ok: false })
    expect(x.openSession).not.toHaveBeenCalled()
  })
  it('reports an explicitly retired target receipt without claiming its old delivery failed', async () => {
    const x = setup()
    x.handle.mockImplementation(async req =>
      req.method === 'POST'
        ? Response.json({ error: 'agent-mention-expired' }, { status: 409 })
        : Response.json({ error: 'agent-mention-missing' }, { status: 404 }),
    )
    expect(await x.call('retry')).toMatchObject({ error: 'remote-receipt-removed' })
    expect(x.post.remote.status).toBe('unknown')
  })
  it('keeps the original request when the retry window expires during the last preflight', async () => {
    const x = setup()
    x.post.at = new Date(when - 7 * 86400000 + 1).toISOString()
    x.now.mockReturnValueOnce(when).mockReturnValue(when + 1)
    expect(await x.call('retry')).toMatchObject({ error: 'retry-expired' })
    expect(x.probe).toHaveBeenCalledTimes(2)
    expect(x.handle.mock.calls.every(([req]) => req.method === 'GET')).toBe(true)
  })
  it('will not send after expiry, against an older Host, with reduced scope, or after the sender changes', async () => {
    const x = setup()
    x.post.at = new Date(when - 7 * 86400000).toISOString()
    expect(await x.call('retry')).toMatchObject({ error: 'retry-expired' })
    x.snapshot.catalog.features.agentMentionLookup = false
    expect(await x.call('retry')).toMatchObject({ ok: false })
    x.snapshot.catalog.features.agentMentionLookup = true
    x.snapshot.device.scopes = ['view']
    expect(await x.call('retry')).toMatchObject({ ok: false })
    x.snapshot.device.scopes = ['view', 'run']
    x.confirm.mockImplementationOnce(async () => {
      x.frame.senderFrame = {}
      return true
    })
    expect(await x.call('retry')).toMatchObject({ ok: false })
    expect(x.handle.mock.calls.every(([req]) => req.method === 'GET')).toBe(true)
  })
})
