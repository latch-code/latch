import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { GENERAL_AGENT_ID } from '@latch/protocol'
import { CustomAgents, MAX_AGENT_PENDING, MAX_PROPOSALS, looksSecret, rememberRequest, type AgentActor } from '../src/custom-agents.ts'
import { AGENT_ACTIONS as AUDIT_ACTIONS } from '../src/audit-actions/agents.ts'

const roots: string[] = []
const stores: CustomAgents[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const actor: AgentActor = { actor: { deviceId: 'dev_owner', listener: 'unix' }, authorize: () => {} }
let clock = Date.parse('2026-11-01T00:00:00Z')
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-proposals-'))
  roots.push(dataDir)
  const audit = { append: vi.fn(async () => undefined as never) }
  const open = () => CustomAgents.open({ dataDir, audit, now: () => (clock += 1000) })
  const store = await open()
  stores.push(store)
  const agent = (
    await store.create(
      { requestId: randomUUID(), name: '资料', description: '', harnessId: 'standard', mode: 'agent', instructions: '', skills: [] },
      actor,
    )
  ).value
  return { dataDir, audit, store, open, agent }
}
const proposal = (owner: string, key: string, content = '喜欢简短的回答') => ({
  owner,
  key,
  content,
  origin: 'agent' as const,
  external: false,
  source: { sessionId: 'session-1', messageId: 'msg-1' },
  actor: { listener: 'host' as const },
})

describe('memory proposals', () => {
  test('are kept pending in the strict file, once per key, and audited with enums and ids only', async () => {
    const { store, audit, agent, dataDir, open } = await fixture()
    const first = await store.propose({ ...proposal(agent.id, 'line:0'), reason: '你说过两次' })
    expect(first).toMatchObject({ state: 'pending', origin: 'agent', external: false, reason: '你说过两次' })
    expect(first).not.toHaveProperty('key')
    expect((await store.propose(proposal(agent.id, 'line:0'))).id).toBe(first.id)
    expect(store.proposals(agent.id)).toHaveLength(1)
    expect(store.memories(agent.id)).toHaveLength(0)
    const proposed = audit.append.mock.calls.map(call => (call as unknown[])[0] as { action: string; detail: unknown })
    const row = proposed.find(entry => entry.action === 'agent.memory.proposed')!
    expect(row.detail).toEqual({ origin: 'agent', external: false, customAgentId: agent.id, kind: 'memory' })
    expect(AUDIT_ACTIONS['agent.memory.proposed'].safeParse(row.detail).success).toBe(true)
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('简短')
    // The file is strict: a field it does not know refuses it, and the original stays.
    const path = join(dataDir, 'agents/custom.json')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved.proposals[agent.id][0]).toMatchObject({ content: '喜欢简短的回答', state: 'pending' })
    await store.close()
    saved.proposals[agent.id][0].autoAccept = true
    await writeFile(path, JSON.stringify(saved), { mode: 0o600 })
    await expect(open()).rejects.toMatchObject({ code: 'agent-journal-invalid' })
  })

  test('opens a file written before proposals existed', async () => {
    const { store, dataDir, open } = await fixture()
    await store.close()
    const path = join(dataDir, 'agents/custom.json')
    const { proposals: _p, changes: _c, ...older } = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify(older), { mode: 0o600 })
    const again = await open()
    stores.push(again)
    expect(again.proposals(GENERAL_AGENT_ID)).toEqual([])
  })

  test('refuse what looks like a secret or is too long, storing nothing', async () => {
    const { store, agent, audit } = await fixture()
    const before = audit.append.mock.calls.length
    await expect(store.propose(proposal(agent.id, 'a', '我的 key 是 sk-proj-abcdefghijklmnopqrstuvwxyz0123'))).rejects.toMatchObject({
      code: 'agent-memory-secret',
    })
    await expect(store.propose({ ...proposal(agent.id, 'b'), reason: 'ghp_' + 'a'.repeat(36) })).rejects.toMatchObject({
      code: 'agent-memory-secret',
    })
    await expect(store.propose(proposal(agent.id, 'c', 'x'.repeat(4001)))).rejects.toMatchObject({ code: 'agent-memory-too-long' })
    expect(store.proposals(agent.id)).toEqual([])
    expect(audit.append.mock.calls.length).toBe(before)
    expect(looksSecret('https://user:pass@example.com')).toBe(true)
    expect(looksSecret('用中文回答')).toBe(false)
  })

  test('save makes a memory with its source and dismiss sets it aside; each answers a replay the same', async () => {
    const { store, agent, audit } = await fixture()
    const one = await store.propose(proposal(agent.id, 'line:0'))
    const two = await store.propose(proposal(agent.id, 'line:1', '周报在周五'))
    const save = randomUUID()
    const saved = (await store.saveProposal(agent.id, one.id, save, actor)).value
    expect(saved.proposal).toMatchObject({ state: 'saved', memoryId: saved.memoryId })
    expect(saved.memory).toMatchObject({
      content: '喜欢简短的回答',
      source: {
        proposalId: one.id,
        origin: 'agent',
        external: false,
        sessionId: 'session-1',
        messageId: 'msg-1',
        proposedAt: one.createdAt,
      },
    })
    const audits = audit.append.mock.calls.length
    expect((await store.saveProposal(agent.id, one.id, save, actor)).value.memoryId).toBe(saved.memoryId)
    expect(audit.append.mock.calls.length).toBe(audits)
    expect(store.memories(agent.id)).toHaveLength(1)
    await expect(store.saveProposal(agent.id, one.id, randomUUID(), actor)).rejects.toMatchObject({ code: 'agent-proposal-decided' })
    const dismiss = randomUUID()
    expect((await store.dismissProposal(agent.id, two.id, dismiss, actor)).value.proposal?.state).toBe('dismissed')
    expect((await store.dismissProposal(agent.id, two.id, dismiss, actor)).value.proposal?.state).toBe('dismissed')
    await expect(store.saveProposal(agent.id, two.id, randomUUID(), actor)).rejects.toMatchObject({ code: 'agent-proposal-decided' })
    await expect(store.dismissProposal(agent.id, one.id, randomUUID(), actor)).rejects.toMatchObject({ code: 'agent-proposal-decided' })
    await expect(store.saveProposal(agent.id, two.id, dismiss, actor)).rejects.toMatchObject({ code: 'request-conflict' })
    const details = audit.append.mock.calls.map(call => (call as unknown[])[0] as { action: string; detail: Record<string, unknown> })
    expect(
      details.filter(entry => entry.action === 'agent.changed').map(entry => [entry.detail.kind, entry.detail.operation, entry.detail.via]),
    ).toEqual(
      expect.arrayContaining([
        ['memory', 'create', 'proposal'],
        ['proposal', 'delete', undefined],
      ]),
    )
    expect(store.proposalStates()).toEqual({ [agent.id]: { pending: 0, at: expect.any(String) } })
  })

  test('a retried save or dismiss is answered from its receipt after the proposal was dropped for room', async () => {
    const { store, agent } = await fixture()
    const kept = await store.propose(proposal(agent.id, 'kept'))
    const gone = await store.propose(proposal(agent.id, 'gone', '会被挤掉'))
    const save = randomUUID(),
      dismiss = randomUUID()
    const saved = (await store.saveProposal(agent.id, kept.id, save, actor)).value
    await store.dismissProposal(agent.id, gone.id, dismiss, actor)
    // Fill the room with the person's own: the decided ones are dropped.
    for (let index = 0; index < MAX_PROPOSALS; index++)
      await store.propose({ ...proposal(agent.id, `u${index}`, `第 ${index} 条`), origin: 'user' })
    expect(store.proposals(agent.id).map(row => row.id)).not.toContain(kept.id)
    expect((await store.saveProposal(agent.id, kept.id, save, actor)).value).toEqual({
      proposalId: kept.id,
      memoryId: saved.memoryId,
      memory: saved.memory,
    })
    expect((await store.dismissProposal(agent.id, gone.id, dismiss, actor)).value).toEqual({ proposalId: gone.id })
  })

  test("agent proposals wait 32 at most; the person's 「记住…」 still has room up to 64", async () => {
    const { store, agent } = await fixture()
    for (let index = 0; index < MAX_AGENT_PENDING; index++) await store.propose(proposal(agent.id, `a${index}`, `第 ${index} 条`))
    await expect(store.propose(proposal(agent.id, 'over'))).rejects.toMatchObject({
      code: 'agent-proposal-limit',
      message: expect.stringContaining('Too many of your proposals'),
    })
    for (let index = 0; index < MAX_PROPOSALS - MAX_AGENT_PENDING; index++)
      await store.propose({ ...proposal(agent.id, `u${index}`, `人 ${index}`), origin: 'user' })
    expect(store.proposals(agent.id)).toHaveLength(MAX_PROPOSALS)
    await expect(store.propose({ ...proposal(agent.id, 'u-over'), origin: 'user' })).rejects.toMatchObject({ code: 'agent-proposal-limit' })
    // A decided one makes room for the person again.
    await store.dismissProposal(agent.id, store.proposals(agent.id)[0]!.id, randomUUID(), actor)
    await store.propose({ ...proposal(agent.id, 'u-again', '又一条'), origin: 'user' })
  })

  test('a reason with control characters is refused as invalid before anything is audited', async () => {
    const { store, agent, audit } = await fixture()
    const before = audit.append.mock.calls.length
    await expect(store.propose({ ...proposal(agent.id, 'x'), reason: 'ok\u202Eevil' })).rejects.toMatchObject({
      status: 400,
      code: 'agent-memory-invalid',
    })
    await expect(store.propose(proposal(agent.id, 'y', 'bell\u0007'))).rejects.toMatchObject({ code: 'agent-memory-invalid' })
    expect(audit.append.mock.calls.length).toBe(before)
    // Line breaks are fine in the text.
    await store.propose(proposal(agent.id, 'z', '第一行\n第二行'))
  })

  test('undo puts back the last edit or delete once, only from the revision the person saw', async () => {
    const { store, agent, audit } = await fixture()
    const made = await store.propose(proposal(agent.id, 'k'))
    const memory = (await store.saveProposal(agent.id, made.id, randomUUID(), actor)).value.memory!
    const edited = (await store.patchMemory(agent.id, memory.id, { requestId: randomUUID(), baseRevision: 1, content: '改过的' }, actor))
      .value
    expect(edited.source).toBeUndefined()
    expect(store.memoryChanges(agent.id)).toEqual([expect.objectContaining({ memoryId: memory.id, operation: 'update' })])
    await expect(store.undoMemory(agent.id, memory.id, { requestId: randomUUID(), baseRevision: 1 }, actor)).rejects.toMatchObject({
      code: 'agent-changed',
    })
    const undo = { requestId: randomUUID(), baseRevision: 2 }
    const back = (await store.undoMemory(agent.id, memory.id, undo, actor)).value
    expect(back).toMatchObject({ content: '喜欢简短的回答', revision: 3, source: memory.source })
    expect((await store.undoMemory(agent.id, memory.id, undo, actor)).value.revision).toBe(3)
    await expect(store.undoMemory(agent.id, memory.id, { requestId: randomUUID(), baseRevision: 3 }, actor)).rejects.toMatchObject({
      code: 'agent-memory-no-undo',
    })
    await store.removeMemory(agent.id, memory.id, randomUUID(), actor)
    expect(store.memories(agent.id)).toEqual([])
    const restored = (await store.undoMemory(agent.id, memory.id, { requestId: randomUUID(), baseRevision: 3 }, actor)).value
    expect(restored).toMatchObject({ id: memory.id, content: '喜欢简短的回答', revision: 4 })
    expect(store.memoryChanges(agent.id)).toEqual([])
    const vias = audit.append.mock.calls
      .map(call => ((call as unknown[])[0] as { detail: { via?: string } }).detail.via)
      .filter(via => via === 'undo')
    expect(vias).toHaveLength(2)
    // One step per memory: a second edit replaces the first.
    await store.patchMemory(agent.id, memory.id, { requestId: randomUUID(), baseRevision: 4, content: 'A' }, actor)
    await store.patchMemory(agent.id, memory.id, { requestId: randomUUID(), baseRevision: 5, content: 'B' }, actor)
    expect(store.memoryChanges(agent.id)).toHaveLength(1)
    expect((await store.undoMemory(agent.id, memory.id, { requestId: randomUUID(), baseRevision: 6 }, actor)).value.content).toBe('A')
  })

  test("a deleted memory's text goes after 7 days, or at once on 清除", async () => {
    const { store, agent, dataDir } = await fixture()
    const one = (await store.createMemory(agent.id, { requestId: randomUUID(), content: 'FIRST GONE' }, actor)).value
    const two = (await store.createMemory(agent.id, { requestId: randomUUID(), content: 'SECOND GONE' }, actor)).value
    await store.removeMemory(agent.id, one.id, randomUUID(), actor)
    await store.removeMemory(agent.id, two.id, randomUUID(), actor)
    expect(store.memoryChanges(agent.id).map(change => change.previous.content)).toEqual(['SECOND GONE', 'FIRST GONE'])
    await store.forgetChange(agent.id, two.id, { requestId: randomUUID(), baseRevision: 1 }, actor)
    expect(store.memoryChanges(agent.id).map(change => change.previous.content)).toEqual(['FIRST GONE'])
    expect(await readFile(join(dataDir, 'agents/custom.json'), 'utf8')).not.toContain('SECOND GONE')
    // Past the window it is no longer shown, and the next write removes it from the file.
    clock += 8 * 24 * 60 * 60 * 1000
    expect(store.memoryChanges(agent.id)).toEqual([])
    await expect(store.undoMemory(agent.id, one.id, { requestId: randomUUID(), baseRevision: 1 }, actor)).rejects.toMatchObject({
      code: 'agent-memory-no-undo',
    })
    await store.createMemory(agent.id, { requestId: randomUUID(), content: '新的' }, actor)
    expect(await readFile(join(dataDir, 'agents/custom.json'), 'utf8')).not.toContain('FIRST GONE')
  })

  test('purging a saved memory blanks the proposal it came from, at start or daily, without another write', async () => {
    const { store, agent, dataDir, open } = await fixture()
    const made = await store.propose(proposal(agent.id, 'k', 'PROPOSED TEXT'))
    const memory = (await store.saveProposal(agent.id, made.id, randomUUID(), actor)).value.memory!
    const other = await store.propose(proposal(agent.id, 'k2', 'CLEARED TEXT'))
    const second = (await store.saveProposal(agent.id, other.id, randomUUID(), actor)).value.memory!
    await store.removeMemory(agent.id, memory.id, randomUUID(), actor)
    await store.removeMemory(agent.id, second.id, randomUUID(), actor)
    // 清除: the memory's text and its proposal's go now; the row keeps its ids and state, and is not listed.
    await store.forgetChange(agent.id, second.id, { requestId: randomUUID(), baseRevision: 1 }, actor)
    expect(store.proposals(agent.id).map(row => row.id)).toEqual([made.id])
    const file = () => readFile(join(dataDir, 'agents/custom.json'), 'utf8')
    expect(await file()).not.toContain('CLEARED TEXT')
    expect(JSON.parse(await file()).proposals[agent.id].find((row: { id: string }) => row.id === other.id)).toMatchObject({
      content: '',
      state: 'saved',
      purged: true,
    })
    // Past the window, the purge at start or each day takes the rest with no write in between.
    clock += 8 * 24 * 60 * 60 * 1000
    await store.purgeExpired()
    expect(await file()).not.toContain('PROPOSED TEXT')
    expect(store.proposals(agent.id)).toEqual([])
    await store.close()
    const again = await open()
    stores.push(again)
    expect(again.proposals(agent.id)).toEqual([])
  })

  test("the agent may fill half the room at most: the person's 「记住…」 still saves", async () => {
    const { store, agent } = await fixture()
    const long = (index: number) => `${index}`.padEnd(4000, '记')
    let refused: unknown
    for (let index = 0; index < 64 && !refused; index++)
      await store.propose(proposal(agent.id, `a${index}`, long(index))).catch(error => {
        refused = error
      })
    expect(refused).toMatchObject({ code: 'agent-proposal-limit', message: expect.stringContaining('too long in total') })
    const agentRows = store.proposals(agent.id)
    expect(Buffer.byteLength(JSON.stringify(agentRows))).toBeLessThanOrEqual(128 * 1024)
    for (let index = 0; index < agentRows.length; index++)
      await store.propose({ ...proposal(agent.id, `u${index}`, long(index)), origin: 'user' })
    expect(store.proposals(agent.id).filter(row => row.origin === 'user')).toHaveLength(agentRows.length)
  })

  test('go with the Agent when it is deleted', async () => {
    const { store, agent } = await fixture()
    await store.propose(proposal(agent.id, 'k'))
    await store.remove(agent.id, randomUUID(), actor)
    expect(store.proposalStates()).toEqual({})
    await expect(store.propose(proposal(agent.id, 'k2'))).rejects.toMatchObject({ code: 'agent-not-found' })
  })
})

test('「记住」 takes only the start of the person’s message', () => {
  expect(rememberRequest('记住：我用 pnpm')).toBe('我用 pnpm')
  expect(rememberRequest('请记住 周报在周五')).toBe('周报在周五')
  expect(rememberRequest('Remember: answer in English')).toBe('answer in English')
  expect(rememberRequest('remembering things')).toBeUndefined()
  expect(rememberRequest('你要记住这个')).toBeUndefined()
  expect(rememberRequest('记住')).toBeUndefined()
})
