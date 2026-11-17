import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AppSnapshot,
  Automation,
  AutomationDetail,
  CustomAgent,
  CustomAgentList,
  PluginPackageBundle,
  PluginPackageDetail,
  TaskDetail,
  WorkItemAnswer,
  WorkItemStartAnswer,
  WorkProposalAnswer,
  WorkProposalSummary,
} from '@latch/protocol'
import { AppError, type HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SLOW = { timeout: 120_000 }
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const TODO = { title: '给 README 加安装一节', prompt: '在 README.md 末尾加「安装」一节。' }
const board = (tool: string, args: Record<string, unknown>) => `board ${JSON.stringify({ tool, args })}`
const calls = (count: number, prefix: string) =>
  `board ${JSON.stringify({ calls: Array.from({ length: count }, (_, n) => ({ tool: 'propose_todo', args: { ...TODO, title: `${prefix} ${n}` } })) })}`

/** A Host with the fake ACP agent (which takes MCP servers) defined from this Mac, and the built-in Harness's fixture model. */
async function fixture(plugins: HarnessPlugin[] = []) {
  const t = await startTestHost({ demo: false, plugins })
  cleanups.push(() => t.close())
  const root = await mkdtemp(join(tmpdir(), 'latch-work-proposal-rules-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const owner = await t.enroll({ listener: 'unix' })
  await owner.confirmedJson('agents', {
    body: {
      id: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(root, 'state.json') },
    },
  })
  return { t, owner }
}

async function settled(device: TestDevice, sessionId: string): Promise<TaskDetail> {
  let detail: TaskDetail | undefined
  await vi.waitFor(
    async () => {
      detail = await device.json<TaskDetail>(`tasks/${sessionId}`)
      expect(['idle', 'completed', 'failed', 'cancelled']).toContain(detail.summary.status)
    },
    { timeout: 20_000, interval: 50 },
  )
  return detail!
}

async function codeSession(owner: TestDevice, prompt: string): Promise<string> {
  const response = await owner.confirmed('tasks', {
    method: 'POST',
    body: { requestId: randomUUID(), prompt, harnessId: 'fake', mode: 'agent' },
  })
  expect(response.status).toBe(201)
  const { sessionId } = (await response.json()) as { sessionId: string }
  await settled(owner, sessionId)
  return sessionId
}

async function say(owner: TestDevice, sessionId: string, prompt: string): Promise<string> {
  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt, requestId: randomUUID() } })
  const detail = await settled(owner, sessionId)
  return detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? ''
}

const pending = async (device: TestDevice) => (await device.json<AppSnapshot>('snapshot')).workProposals ?? []
async function newest(device: TestDevice, sessionId: string): Promise<WorkProposalSummary> {
  let found: WorkProposalSummary | undefined
  await vi.waitFor(
    async () => {
      found = (await pending(device)).filter(row => row.from.sessionId === sessionId).at(-1)
      expect(found).toBeDefined()
    },
    { timeout: 10_000, interval: 50 },
  )
  return found!
}
const errorOf = async (response: Response) => ({ status: response.status, error: ((await response.json()) as { error: string }).error })

describe('the external mark follows content into a session that can propose', () => {
  it(
    'a thread delivery, a handoff (new or existing session) and a fork with tool output: what it proposes next is external',
    SLOW,
    async () => {
      const { owner } = await fixture()

      // A 待办's member session proposes as itself; after a delivery quoting the thread, as from outside content.
      const { item } = await owner.json<WorkItemAnswer>('work/items', {
        method: 'POST',
        body: { requestId: randomUUID(), title: '整理', prompt: 'echo 开始', harnessId: 'fake' },
      })
      const started = await owner.confirmed(`work/items/${item.id}/start`, {
        method: 'POST',
        body: { requestId: randomUUID(), baseRevision: item.revision, mode: 'agent' },
      })
      const { sessionId: member } = (await started.json()) as WorkItemStartAnswer
      await settled(owner, member)
      await say(owner, member, board('propose_todo', { ...TODO, title: '之前' }))
      expect((await newest(owner, member)).external).toBeUndefined()
      const post = await owner.request(`work/items/${item.id}/posts`, {
        method: 'POST',
        body: { requestId: randomUUID(), text: 'echo 看看讨论', target: { sessionId: member } },
      })
      expect(post.status).toBe(201)
      await settled(owner, member)
      await say(owner, member, board('propose_todo', { ...TODO, title: '之后' }))
      await vi.waitFor(async () => expect((await newest(owner, member)).entries?.[0]?.title).toBe('之后'))
      expect((await newest(owner, member)).external).toBe(true)

      // A handoff into a new session and into an existing one.
      const source = await codeSession(owner, 'echo 计划写好了')
      const reply = (await owner.json<TaskDetail>(`tasks/${source}`)).messages.find(message => message.role === 'assistant')!
      const handoff = (target: Record<string, unknown>) =>
        owner.confirmed('handoffs', {
          method: 'POST',
          body: {
            requestId: randomUUID(),
            sourceSessionId: source,
            target,
            materials: [{ kind: 'message', messageId: reply.id, hash: sha(reply.text) }],
            requirements: 'echo 照着做',
            decisions: [],
            returnScope: 'none',
          },
        })
      const created = await handoff({ kind: 'new-session', harnessId: 'fake', mode: 'agent' })
      expect(created.status).toBe(201)
      const { targetSessionId: fresh } = (await created.json()) as { targetSessionId: string }
      await settled(owner, fresh)
      await say(owner, fresh, board('propose_todo', TODO))
      expect((await newest(owner, fresh)).external).toBe(true)
      const existing = await codeSession(owner, 'echo 等着')
      expect((await handoff({ kind: 'session', sessionId: existing })).status).toBe(201)
      await settled(owner, existing)
      await say(owner, existing, board('propose_todo', TODO))
      expect((await newest(owner, existing)).external).toBe(true)

      // A fork of a session whose record holds tool output; a fork of one that holds none proposes as itself.
      const fetched = await codeSession(owner, 'fetch')
      const quiet = await codeSession(owner, 'echo 只说话')
      const fork = async (from: string) => {
        const detail = await owner.json<TaskDetail>(`tasks/${from}`)
        const response = await owner.confirmed('tasks', {
          method: 'POST',
          body: {
            requestId: randomUUID(),
            prompt: 'echo 接着',
            harnessId: 'fake',
            mode: 'agent',
            forkOf: { taskId: from, upToMessageId: detail.messages.at(-1)!.id },
          },
        })
        expect(response.status).toBe(201)
        const { sessionId } = (await response.json()) as { sessionId: string }
        await settled(owner, sessionId)
        await say(owner, sessionId, board('propose_todo', TODO))
        return newest(owner, sessionId)
      }
      expect((await fork(fetched)).external).toBe(true)
      expect((await fork(quiet)).external).toBeUndefined()
    },
  )
})

describe('privacy after the fact', () => {
  /** The built-in Harness's model: `TODO!` proposes a 待办, `CARD!` a note for the session's 待办; otherwise it answers. */
  const scripted: HarnessPlugin = {
    id: 'board-script',
    name: 'fixture',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider({
        id: 'board-script',
        name: 'fixture',
        model: 'fixture',
        async *stream({ messages, tools }) {
          const last = messages.at(-1)
          const asked = last?.role === 'user' ? JSON.stringify(last) : ''
          const call = asked.includes('TODO!')
            ? { name: 'propose_todo', arguments: TODO }
            : asked.includes('CARD!')
              ? { name: 'propose_card', arguments: { target: 'todo', note: '还差文档' } }
              : undefined
          if (call && tools.some(tool => tool.name === call.name)) {
            yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, ...call } }
            yield { type: 'finish', reason: 'tool-calls' }
            return
          }
          yield { type: 'text', text: 'ok' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const model = { providerId: 'board-script', model: 'fixture' }

  it(
    'a proposer that turned private is not named to a work-scope device; a suggestion for a 待办 that turned private is invisible to it',
    SLOW,
    async () => {
      const { t, owner } = await fixture([scripted])
      const work = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope: 'work' })
      const { sessionId: proposer } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt: 'TODO!', harnessId: 'standard', model },
      })
      await settled(owner, proposer)
      const proposal = await newest(owner, proposer)
      const { itemIds } = await owner.json<WorkProposalAnswer>(`work/proposals/${proposal.id}/accept`, {
        method: 'POST',
        body: { requestId: randomUUID(), baseRevision: proposal.revision },
      })
      const accepted = itemIds![0]!
      // A member of another 待办 waits on a suggestion for it.
      const { item } = await owner.json<WorkItemAnswer>('work/items', {
        method: 'POST',
        body: { requestId: randomUUID(), title: '旧标题', prompt: '开始', harnessId: 'standard', model },
      })
      const started = await owner.json<WorkItemStartAnswer>(`work/items/${item.id}/start`, {
        method: 'POST',
        body: { requestId: randomUUID(), baseRevision: item.revision },
      })
      const member = started.sessionId
      await settled(owner, member)
      await say(owner, member, 'CARD!')
      const change = await newest(owner, member)
      expect((await pending(work)).some(row => row.id === change.id)).toBe(true)
      expect((await work.json<WorkItemAnswer>(`work/items/${accepted}`)).item.from).toMatchObject({ sessionId: proposer })

      // 通用 has private rules now; a full-scope device continues both sessions, which turn private.
      const list = await owner.json<CustomAgentList>('custom-agents')
      await owner.json('custom-agents/general', {
        method: 'PATCH',
        body: { requestId: randomUUID(), baseRevision: list.general.revision, instructions: 'PRIVATE RULES' },
      })
      await say(owner, proposer, '继续')
      await say(owner, member, '继续')
      await vi.waitFor(async () => expect((await work.request(`tasks/${proposer}`)).status).toBe(403))

      // The accepted 待办 stays readable, and says only that an agent proposed it.
      expect((await work.json<WorkItemAnswer>(`work/items/${accepted}`)).item.from).toEqual({ proposalId: proposal.id })
      const listed = (await work.json<AppSnapshot>('snapshot')).items?.find(row => row.id === accepted)
      expect(listed?.from).toEqual({ proposalId: proposal.id })
      expect((await owner.json<WorkItemAnswer>(`work/items/${accepted}`)).item.from).toMatchObject({ sessionId: proposer })
      // The suggestion for the now private 待办: nothing of it to the narrow device.
      expect((await pending(work)).some(row => row.id === change.id)).toBe(false)
      expect((await work.request(`work/proposals/${change.id}`)).status).toBe(404)
      expect((await pending(owner)).some(row => row.id === change.id)).toBe(true)
    },
  )
})

describe('bounds, audit and who may propose', () => {
  it('holds 64 waiting on the Host, refuses a proposal and an accept whose audit line cannot be written', SLOW, async () => {
    const { t, owner } = await fixture()
    // Four sessions of sixteen waiting each fill the Host; a fifth session's proposal is not kept.
    for (let round = 0; round < 4; round++) {
      const session = await codeSession(owner, calls(4, `s${round}`))
      for (let turn = 0; turn < 3; turn++) await say(owner, session, calls(4, `s${round}t${turn}`))
    }
    await vi.waitFor(async () => expect(await pending(owner)).toHaveLength(64), { timeout: 20_000 })
    const late = await codeSession(owner, board('propose_todo', TODO))
    expect((await settled(owner, late)).messages.at(-1)?.text).toContain('Not proposed')
    expect((await pending(owner)).some(row => row.from.sessionId === late)).toBe(false)

    // Its audit line is not written: no proposal is kept, and an accept is refused.
    const first = (await pending(owner))[0]!
    await owner.json(`work/proposals/${first.id}/dismiss`, {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: first.revision },
    })
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    vi.spyOn(t.host.security.audit, 'append').mockImplementation(event =>
      event.action.startsWith('work.proposal.') ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
    )
    expect(await say(owner, late, board('propose_todo', { ...TODO, title: '审计失败' }))).toContain('Not proposed')
    expect((await pending(owner)).some(row => row.entries?.[0]?.title === '审计失败')).toBe(false)
    const second = (await pending(owner))[0]!
    const refused = await owner.request(`work/proposals/${second.id}/accept`, {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: second.revision },
    })
    expect(await errorOf(refused)).toEqual({ status: 503, error: 'audit-unavailable' })
    expect((await owner.json<AppSnapshot>('snapshot')).items ?? []).toEqual([])
  })

  it('a plugin page’s session is offered no board tools', SLOW, async () => {
    const { t, owner } = await fixture()
    const bundle: PluginPackageBundle = {
      manifest: {
        formatVersion: 2,
        id: 'release-check',
        name: '发布检查',
        version: '1.0.0',
        description: '发布前逐项检查。',
        apps: [
          {
            id: 'main',
            title: '发布检查',
            icon: 'list-checks',
            entry: 'src/index.js',
            dataVersion: 1,
            capabilities: { 'tasks.start': { projects: 'any' }, 'tasks.continue': true, 'tasks.readOwn': true },
          },
        ],
      },
      files: [{ path: 'src/index.js', content: 'export default function Page() { return null }' }],
    }
    const draft = (await owner.json<{ package: PluginPackageDetail }>('plugin-packages', { body: { requestId: randomUUID(), bundle } }))
      .package
    const applied = await owner.confirmed(`plugin-packages/${draft.id}/apply`, {
      body: { requestId: randomUUID(), revision: draft.revision },
    })
    const pkg = ((await applied.json()) as { package: PluginPackageDetail }).package
    const response = await owner.confirmed('tasks', {
      body: {
        via: { app: 'release-check/main', revision: pkg.appliedRevision },
        requestId: randomUUID(),
        prompt: board('propose_todo', TODO),
        harnessId: 'fake',
      },
    })
    expect(response.status).toBe(201)
    const { sessionId } = (await response.json()) as { sessionId: string }
    const detail = await vi.waitFor(async () => {
      const read = (await t.host.bridge.detail(sessionId)).summary.status
      expect(read).toBe('idle')
      return t.host.bridge.detail(sessionId)
    })
    expect(detail.messages.at(-1)?.text).toBe('no MCP server')
    expect(await pending(owner)).toEqual([])
  })

  it('我的 Agent’s scheduled run proposes, private and external; 通用’s scheduled run has no board tools', SLOW, async () => {
    const seen: string[][] = []
    const plugin: HarnessPlugin = {
      id: 'board-provider',
      name: 'fixture',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'board-provider',
          name: 'fixture',
          model: 'fixture',
          async *stream({ tools }) {
            seen.push(tools.map(tool => tool.name))
            yield { type: 'text', text: 'ok' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const { owner } = await fixture([plugin])
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: { requestId: randomUUID(), name: '定时', harnessId: 'fake' },
    })
    const run = async (body: Record<string, unknown>) => {
      const automation = await owner.json<Automation>('automations', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name: '每天看看',
          schedule: { kind: 'daily', time: '09:00' },
          notify: false,
          enabled: false,
          ...body,
        },
      })
      await owner.json(`automations/${automation.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
      let detail: AutomationDetail | undefined
      await vi.waitFor(
        async () => {
          detail = await owner.json<AutomationDetail>(`automations/${automation.id}`)
          expect(['running', undefined]).not.toContain(detail.automation.lastRun?.state)
        },
        { timeout: 20_000 },
      )
      return detail!.automation.lastRun!.sessionId!
    }
    const agentRun = await run({ customAgentId: agent.id, prompt: board('propose_todo', TODO) })
    expect(await newest(owner, agentRun)).toMatchObject({ external: true, private: true, from: { customAgentId: agent.id } })
    await run({ prompt: 'hello', model: { providerId: 'board-provider', model: 'fixture' } })
    expect(seen.at(-1)).not.toContain('propose_todo')
  })
})
