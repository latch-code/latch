import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { testHarness } from '@latch/testkit'
import { describe, expect, it } from 'vitest'
import { BUILTIN_HELPER_CARD, type HostCatalog, type Message, type RunLive, type TaskDetail } from '@latch/protocol'
import { Transcript } from '../src/components/Transcript.tsx'
import { TopicFrame } from '../src/agents/TopicFrame.tsx'
import type { ShellState } from '../src/shell/useShellLayout.tsx'
import { draftPermission, permissionView } from '../src/composer/permission.ts'
import { firstFace, helperCandidates, helperCard, helperMode } from '../src/agents/helpers.ts'
import { helperRequest, HelperCreate } from '../src/agents/HelperCreate.tsx'
import { speakerOf } from '../src/agents/model.ts'
import { helperPermissionBlocked, mcpServer, permissionNote, personActivity, personStatus, toolWord } from '../src/agents/personWords.ts'
import type { AgentWrites } from '../src/agents/useAgentWrites.ts'

const builtin = {
  ...testHarness('standard', { kind: 'builtin', label: 'Latch 内置' }),
  agentContext: 'private' as const,
  skills: 'native' as const,
}
const codex = { ...testHarness('codex', { label: 'Codex' }), agentContext: 'first-turn' as const, skills: 'server' as const }
const pi = {
  ...testHarness('pi', { label: 'pi' }),
  agentContext: 'first-turn' as const,
  permission: { approvals: 'none' as const, readback: 'none' as const },
}
const mine = { ...testHarness('fake-agent', { label: 'Fake Agent', mark: 'plugin' }), agentContext: 'first-turn' as const }
const outdated = {
  ...testHarness('opencode', { label: 'OpenCode', status: 'unavailable' }),
  agentContext: 'first-turn' as const,
  statusReason: 'outdated' as const,
  statusMessage: 'OpenCode 需要 1.2 或更高版本',
}
const missing = {
  ...testHarness('qwen', { label: 'Qwen Code', status: 'unavailable' }),
  agentContext: 'first-turn' as const,
  statusMessage: '找不到命令 qwen。安装：npm i -g @qwen-code/qwen-code',
}
const catalog = (harnesses = [codex, pi, mine, builtin, outdated, missing]): HostCatalog => ({
  harnesses: [...harnesses, { ...testHarness('claude', { label: 'Claude' }), agentContext: 'first-turn', offer: { presetId: 'claude' } }],
  providers: [{ id: 'svc', name: 'Svc', kind: 'openai-compatible', models: ['m1'], defaultModel: 'm1' }],
  workspaces: [{ id: 'default', name: 'start', path: '/work' }],
  defaults: { harnessId: 'standard', mode: 'agent', workspaceId: 'default' },
})

describe('the status words of a helper, from real events only', () => {
  const running = (message: Partial<Message>): TaskDetail => ({
    summary: { harnessId: 'codex', id: 's', title: 't', status: 'running', updatedAt: '' },
    messages: [{ id: 'u', role: 'user', text: '做' }, { id: 'tool:1', role: 'tool', text: '', state: 'running', ...message } as Message],
    approvals: [],
    liveText: '',
    cursor: 1,
  })
  const opts = { cancelling: false, approvals: 0, hostNow: 0 }
  const word = (message: Partial<Message>) => personStatus(running(message), opts).words

  it('says what the running tool does, never its own name', () => {
    expect(word({ toolName: 'read_file' })).toBe('在看文件')
    expect(word({ toolName: 'list_files' })).toBe('在看文件')
    expect(word({ tool: { kind: 'read' } })).toBe('在看文件')
    expect(word({ tool: { kind: 'search' }, toolName: 'grep' })).toBe('在找东西')
    expect(word({ tool: { kind: 'fetch' } })).toBe('在查资料')
    expect(word({ toolName: 'browser_navigate' })).toBe('在看网页')
    expect(word({ toolName: 'write_file' })).toBe('在写文件')
    for (const kind of ['edit', 'delete', 'move'] as const) expect(word({ tool: { kind } })).toBe('在写文件')
    expect(word({ tool: { kind: 'execute' } })).toBe('在跑命令')
    expect(word({ toolName: 'mcp__github__search_issues_1a2b3c4d' })).toBe('在用 github')
    expect(word({ toolName: 'whatever', tool: { title: 'mcp__notes__append' } })).toBe('在用 notes')
    expect(word({ subagent: { title: '查文档', steps: [] } })).toBe('在分头做')
    expect(word({ toolName: 'propose_memory', tool: { kind: 'other' } })).toBe('在动手')
    expect(mcpServer('mcp__')).toBeUndefined()
  })

  it('says the phase when no tool runs: 在准备, 在想, 在回复, 等你点头, 在停下', () => {
    const base = running({ state: 'completed' })
    expect(personStatus({ ...base, activity: { phase: 'starting' } }, opts).words).toBe('在准备')
    expect(personStatus({ ...base, liveReasoning: '嗯' }, opts).words).toBe('在想')
    expect(personStatus(base, opts).words).toBe('在想')
    expect(personStatus({ ...base, liveText: '好的' }, opts).words).toBe('在回复')
    expect(personStatus(base, { ...opts, approvals: 1 })).toEqual({ words: '等你点头', tone: 'waiting' })
    expect(personStatus(base, { ...opts, cancelling: true }).words).toBe('在停下')
  })

  it('gives the lists the coarse word of the summary, and nothing without an event', () => {
    const live = (activity: RunLive['activity']): RunLive => ({ runId: 'r', activity, since: '', lastEventAt: '' })
    expect(personActivity(undefined)).toBeUndefined()
    expect(personActivity(live('starting'))?.words).toBe('在准备')
    expect(personActivity(live('model'))?.words).toBe('在想')
    expect(personActivity(live('command'))?.words).toBe('在跑命令')
    expect(personActivity(live('tool'))?.words).toBe('在动手')
    expect(personActivity(live('approval'))).toEqual({ words: '等你点头', tone: 'waiting' })
    expect(personActivity(live('cancelling'))?.words).toBe('在停下')
    expect(toolWord({ toolName: undefined })).toBe('在动手')
  })

  it('keeps the safety facts once the permission chip is gone: 不先问你 and 权限没确认, never the default', () => {
    expect(permissionNote(draftPermission(codex, 'agent'))).toBeUndefined()
    expect(permissionNote(draftPermission(builtin, 'agent'))).toBeUndefined()
    expect(permissionNote(draftPermission(pi, 'agent'))).toMatchObject({ words: '不先问你', tone: 'warn' })
    expect(permissionNote(draftPermission(pi, 'agent'))?.detail).toContain('Latch 也不隔离它')
    // A mode Latch has no word for is said by its own name, quietly.
    const config = [{ id: 'mode', name: '模式', category: 'mode', currentValue: 'yolo', options: [{ value: 'yolo', name: 'YOLO' }] }]
    const odd = permissionNote(
      permissionView({
        harness: codex,
        mode: 'agent',
        permission: { approvals: 'prompts', readback: 'mode' },
        config,
        access: { legacy: false, local: true },
      }),
    )
    expect(odd).toMatchObject({ words: 'YOLO', tone: 'neutral' })
    const unread = { ...codex, permission: { approvals: 'prompts' as const, readback: 'none' as const } }
    expect(permissionNote(draftPermission(unread, 'agent'))?.words).toBe('权限没确认')
    // Its ⓘ names no Harness.
    expect(permissionNote(draftPermission(pi, 'agent'))?.detail).not.toMatch(/pi/u)
  })
})

describe('a conversation of 我的 Agent reads as the helper', () => {
  const detail = (status: 'idle' | 'running'): TaskDetail => ({
    summary: { harnessId: 'standard', id: 's', title: 't', status, updatedAt: '', model: 'deepseek-flash', providerId: 'svc' },
    messages: [
      { id: 'u1', role: 'user', text: '工具太少了吧？' },
      {
        id: 'a1',
        role: 'assistant',
        text: '你说得对。',
        reasoning: '想一想',
        reasoningMs: 3200,
        model: 'deepseek-flash',
        providerId: 'svc',
        usage: { inputTokens: 1700, outputTokens: 429 },
      },
      { id: 'u2', role: 'user', text: '再看看' },
      { id: 'a2', role: 'assistant', text: '', model: 'deepseek-pro', thinking: 'high' },
    ],
    approvals: [],
    liveText: '',
    cursor: 1,
    ...(status === 'running' ? { activity: { phase: 'model' as const } } : {}),
  })
  const render = (speaker: boolean, status: 'idle' | 'running' = 'idle') =>
    renderToStaticMarkup(
      createElement(Transcript, {
        detail: detail(status),
        approvals: [],
        harnessName: 'Latch 内置',
        harness: builtin,
        active: status === 'running',
        providerName: () => 'Svc',
        ...(speaker ? { speaker: { name: '资料助手', avatar: { kind: 'face', bracket: 'square', eyes: 'dot', hue: 'pine' } } } : {}),
      }),
    )

  it('signs each turn with the helper and names no Harness, model or tokens', () => {
    const html = render(true)
    expect(html).toContain('资料助手')
    expect(html).toContain('想了 3 秒')
    for (const word of ['Latch 内置', 'deepseek', 'Harness', '模型', '思考', 'tokens', '输入 1.7k'])
      expect(html, `${word} on the helper's conversation`).not.toContain(word)
    // Running, the line says what it does in a person's words.
    const running = render(true, 'running')
    expect(running).toContain('在想')
    for (const word of ['Latch 内置', 'deepseek', '等模型', '运行中']) expect(running).not.toContain(word)
  })

  it('leaves Code’s sessions as they are', () => {
    const html = render(false)
    expect(html).toContain('Latch 内置')
    expect(html).toContain('deepseek-flash')
    expect(html).toContain('思考了 3.2 秒')
    expect(html).toContain('tokens')
  })

  it('has a speaker only for a session that 我的 Agent owns', () => {
    const agents = [
      {
        id: 'agt_1',
        name: '资料助手',
        avatar: { kind: 'face' as const, bracket: 'square' as const, eyes: 'dot' as const, hue: 'pine' as const },
      },
    ]
    const snapshot = { customAgents: agents as never }
    expect(speakerOf(snapshot, {})).toBeUndefined()
    expect(speakerOf(snapshot, { agent: { customAgentId: 'agt_1' } })).toEqual({ name: '资料助手', avatar: agents[0]!.avatar })
    expect(speakerOf(snapshot, { generalChat: true })).toEqual({ name: '通用', avatar: 'general' })
    expect(speakerOf({ customAgents: [] }, { agent: { customAgentId: 'agt_gone' } })).toEqual({ name: '已删除的 Agent', avatar: 'general' })
  })
})

describe('creating a helper: 「你想让谁成为你的帮手？」', () => {
  it('offers each ready Harness that can take an Agent, Latch 内置 first, and greys the rest with their reason', () => {
    const { ready, waiting } = helperCandidates(catalog())
    expect(ready.map(item => item.harness.id)).toEqual(['standard', 'codex', 'pi', 'fake-agent'])
    expect(waiting.map(item => [item.harness.id, item.words])).toEqual([
      ['opencode', '需要升级'],
      ['qwen', '未安装'],
    ])
    // An offer is not saved yet, so it is not a candidate.
    expect(ready.some(item => item.harness.id === 'claude')).toBe(false)
  })

  it('says only what each truly does: its card, 跑命令 only with a shell, 不先问你 only for one that never asks', () => {
    const { ready } = helperCandidates(catalog())
    const by = (id: string) => ready.find(item => item.harness.id === id)!
    expect(by('standard')).toMatchObject({ card: BUILTIN_HELPER_CARD, unasked: false })
    expect(by('standard').abilities).not.toContain('commands')
    expect(by('codex').abilities).toEqual(['files', 'commands', 'memory', 'schedule'])
    // 记事 and 定时 need Latch's skill server; without it they are not claimed.
    const bare = helperCandidates(catalog([{ ...codex, skills: undefined } as never])).ready[0]!
    expect(bare.abilities).toEqual(['files', 'commands'])
    expect(by('pi')).toMatchObject({ abilities: ['files', 'commands'], unasked: true })
    // A Harness Latch has no card for is its name alone.
    expect(by('fake-agent')).toMatchObject({ abilities: [], unasked: false })
    expect(by('fake-agent').card).toBeUndefined()
    expect(helperCard(catalog(), codex)?.face).toEqual({ bracket: 'square', eyes: 'dot' })
  })

  it('starts the face from the card, in a hue no other Agent wears', () => {
    const taken = [{ avatar: { kind: 'face' as const, bracket: 'round' as const, eyes: 'dot' as const, hue: 'ink' as const } }]
    expect(firstFace(helperCard(catalog(), pi), taken)).toEqual({ kind: 'face', bracket: 'curly', eyes: 'oval', hue: 'slate' })
    expect(firstFace(undefined, [])).toEqual({ kind: 'face', bracket: 'round', eyes: 'dot', hue: 'ink' })
  })

  it('sends the Harness once, with the face and what was written; a model only where the Harness runs on Latch’s', () => {
    const avatar = { kind: 'face' as const, bracket: 'square' as const, eyes: 'dot' as const, hue: 'pine' as const }
    const draft = {
      harnessId: 'codex',
      avatar,
      name: ' 资料助手 ',
      description: '查资料 ',
      instructions: '只用中文',
      model: { providerId: 'svc', model: 'm1' },
    }
    expect(helperRequest(codex, draft)).toEqual({
      name: '资料助手',
      description: '查资料',
      instructions: '只用中文',
      harnessId: 'codex',
      mode: 'agent',
      skills: [],
      avatar,
    })
    expect(helperRequest(builtin, { ...draft, harnessId: 'standard', defaultProjectId: 'notes' })).toMatchObject({
      harnessId: 'standard',
      model: { providerId: 'svc', model: 'm1' },
      defaultProjectId: 'notes',
    })
    const assembled = { ...draft, skills: ['notes:summary'], tools: [] }
    expect(helperRequest(builtin, assembled)).toMatchObject({ skills: ['notes:summary'], tools: [] })
    expect(helperRequest(codex, assembled)).not.toHaveProperty('tools')
    expect(helperRequest({ ...codex, skills: undefined } as never, assembled).skills).toEqual([])
    expect(helperMode({ modes: ['chat'] })).toBe('chat')
  })

  it('accepts a name for an already chosen cloud assistant even without a local Harness', () => {
    const html = renderToStaticMarkup(
      createElement(HelperCreate, {
        catalog: catalog([]),
        access: { scopes: new Set(['run']), local: true, legacy: false, admin: true } as never,
        agents: [],
        writes: { state: null, saving: false, held: false } as unknown as AgentWrites,
        disabled: false,
        onCreated: () => {},
        onCancel: () => {},
        workComputer: { hostId: 'b'.repeat(52), agentId: 'agt_00000000-0000-4000-8000-000000000007' },
      }),
    )
    expect(html).toContain('添加工作电脑上的助手')
    expect(html).toContain('给它起个名字')
    expect(html).not.toContain('你想让谁成为你的帮手？')
  })

  it('draws the question and the cards before anything is created', () => {
    const writes = { state: null, saving: false, held: false } as unknown as AgentWrites
    const html = renderToStaticMarkup(
      createElement(HelperCreate, {
        catalog: catalog(),
        access: { scopes: new Set(['run']), local: true, legacy: false, admin: true } as never,
        agents: [],
        writes,
        disabled: false,
        onCreated: () => {},
        onCancel: () => {},
      }),
    )
    expect(html).toContain('你想让谁成为你的帮手？')
    expect(html).toContain('稳当，动手前每次问你。')
    // 不先问你 stands beside the name of the one it is said of, not among what it can do.
    expect(html).toMatch(/class="helper-card-name">(?:(?!helper-card-line).)*helper-unasked[^>]*>(?:<[^>]*>)*不先问你/u)
    expect(html.match(/不先问你/gu)).toHaveLength(1)
    expect(html).toContain('还有 2 位没准备好')
    expect(html.indexOf('Latch 内置')).toBeLessThan(html.indexOf('Codex'))
    // Nothing of step two yet.
    expect(html).not.toContain('创建')
  })
})

describe('a helper’s frame on an open topic', () => {
  const frame = (harness: typeof pi | typeof codex, permission?: TaskDetail['permission'], config?: TaskDetail['config']) => {
    const summary = {
      harnessId: harness.id,
      id: 's1',
      title: '待办',
      status: 'idle' as const,
      updatedAt: '',
      mode: 'agent' as const,
      agent: { customAgentId: 'agt_1' },
    }
    const agent = {
      id: 'agt_1',
      name: '小抄',
      description: '',
      harnessId: harness.id,
      mode: 'agent' as const,
      avatar: { kind: 'face' as const, bracket: 'round' as const, eyes: 'dot' as const, hue: 'ink' as const },
      revision: 1,
      skillCount: 0,
      memoryCount: 0,
      sessionCount: 1,
      available: true,
      canAutomate: false,
    }
    const shell = {
      snapshot: { tasks: [summary], approvals: [], customAgents: [agent], catalog: catalog() },
      catalog: catalog(),
      connection: 'connected',
      phone: false,
      preferences: { workbenchLayout: 'overview' },
      access: { scopes: new Set(['run']), local: true, legacy: false },
      current: {
        summary,
        messages: [],
        approvals: [],
        liveText: '',
        cursor: 1,
        ...(permission ? { permission } : {}),
        ...(config ? { config } : {}),
      },
      profileShown: null,
      selectedId: 's1',
      toggleProfile: () => {},
      choose: () => {},
      setRoute: () => {},
      openMyAgent: () => {},
    } as unknown as ShellState
    return renderToStaticMarkup(createElement(TopicFrame, { shell, owner: 'agt_1', current: 's1', title: '待办' }))
  }

  it('keeps 不先问你 and 权限没确认 beside the name, in words, with that Latch does not isolate it', () => {
    const unasked = frame(pi)
    expect(unasked).toContain('agent-boundary-trigger is-warn')
    expect(unasked).toContain('不先问你')
    // Its ⓘ, whose detail says Latch does not isolate it either (permissionNote above).
    expect(unasked).toContain('不先问你：说明')
    const unread = frame(codex, { level: 'L3', enforcer: 'NONE', notes: [], approvals: 'prompts', readback: 'none' })
    expect(unread).toContain('权限没确认')
    // Asking first is not an amber warning, but it still does not imply isolation.
    expect(frame(codex, { level: 'L3', enforcer: 'NONE', notes: [], approvals: 'prompts', readback: 'mode' })).not.toContain(
      'agent-boundary-trigger is-warn',
    )
  })

  it('keeps the isolation boundary reachable on an ask-first topic after the permission chip is removed', () => {
    const html = frame(codex, { level: 'L3', enforcer: 'NONE', notes: [], approvals: 'prompts', readback: 'mode' })
    expect(html).toContain('Latch 不隔离 小抄')
    expect(html).toContain('Latch 不隔离 小抄：说明')
  })

  it('warns and blocks a helper only when the Host expected a readback and the actual mode does not match', () => {
    const permission = {
      level: 'L3' as const,
      enforcer: 'NONE' as const,
      notes: [],
      approvals: 'prompts' as const,
      readback: 'mode' as const,
      expectedMode: 'read-only',
    }
    const config = [{ id: 'mode', name: 'Mode', category: 'mode', currentValue: 'workspace-write', options: [] }]
    const detail = { summary: { agent: { customAgentId: 'agt_1' }, mode: 'agent' }, permission, config } as unknown as TaskDetail
    expect(helperPermissionBlocked(detail)).toBe(true)
    expect(frame(codex, permission, config)).toContain('权限没确认')
    expect(helperPermissionBlocked({ ...detail, config: [{ ...config[0]!, currentValue: 'read-only' }] })).toBe(false)
    expect(helperPermissionBlocked({ ...detail, permission: { ...permission, readback: 'none' } })).toBe(false)
    expect(helperPermissionBlocked({ ...detail, summary: { ...detail.summary, agent: undefined } })).toBe(false)
  })
})
