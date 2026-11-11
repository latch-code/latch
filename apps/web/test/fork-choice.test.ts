import { testHarness } from '@latch/testkit'
import { describe, expect, it } from 'vitest'
import type { HarnessInfo, HostCatalog, ModeTier, SessionConfigOption, SessionPermission, TaskDetail, TaskSummary } from '@latch/protocol'
import { resolveChoice } from '../src/composerChoice.ts'
import { forkedChoice, forkSource } from '../src/forkChoice.ts'

const option = (id: string, category: string, currentValue: string, values: string[]): SessionConfigOption => ({
  id,
  name: id,
  category,
  currentValue,
  options: values.map(value => ({ value, name: value.toUpperCase() })),
})
const tiers = (map: Record<string, ModeTier['tier']>): Record<string, ModeTier> =>
  Object.fromEntries(Object.entries(map).map(([value, tier]) => [value, { tier, line: value }]))

/** An agent with its own models, thinking levels and modes, as its last session reported them. */
function agent(
  id: string,
  modes: Record<string, ModeTier['tier']> | undefined,
  values = Object.keys(modes ?? { ask: 'ask' }),
): HarnessInfo {
  const info = testHarness(id, { label: id.toUpperCase() })
  return {
    ...info,
    permission: { approvals: 'prompts', readback: 'mode', ...(modes ? { modeTiers: tiers(modes) } : {}) },
    catalogue: {
      options: [
        option('model', 'model', 'small', ['small', 'large']),
        option('effort', 'thought_level', 'low', ['low', 'high']),
        // A session starts in the Harness's 先问你 row.
        option('mode', 'mode', values.find(value => modes?.[value] === 'ask') ?? values[0]!, values),
      ],
      perModel: [{ model: 'large', options: [option('effort', 'thought_level', 'low', ['low', 'high'])] }],
      reportedAt: '2026-11-08T00:00:00.000Z',
      source: 'session',
    },
  }
}

const codexModes = { ask: 'ask', write: 'rule', review: 'model', full: 'never' } as const
const catalog: HostCatalog = {
  harnesses: [
    testHarness('standard', { kind: 'builtin', label: 'Latch 内置' }),
    agent('codex', codexModes),
    // No 由模型判断: the strictest row under it is the rules' one.
    agent('gemini', { plan: 'plan', default: 'ask', edit: 'rule', yolo: 'never' }),
    // Modes Latch has no tiers for.
    agent('cursor', undefined, ['agent', 'ask']),
  ],
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'openai-compatible',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      defaultModel: 'deepseek-chat',
      modelCapabilities: { 'deepseek-reasoner': { thinking: ['low', 'high'] } },
    },
  ],
  workspaces: [{ id: 'default', name: '启动目录', path: '/repo' }],
  defaults: { harnessId: 'codex', mode: 'agent', workspaceId: 'default' },
}

function detail(summary: Partial<TaskSummary> & { harnessId: string }, config: SessionConfigOption[] = []): TaskDetail {
  return {
    summary: { id: 'source', title: '来源', status: 'idle', updatedAt: '2026-11-08T00:00:00.000Z', mode: 'agent', ...summary },
    messages: [],
    approvals: [],
    liveText: '',
    cursor: 0,
    config,
  }
}

const codexSession = (mode: string, model = 'large') =>
  detail({ harnessId: 'codex' }, [
    option('model', 'model', model, ['small', 'large', 'retired']),
    option('effort', 'thought_level', 'high', ['low', 'high']),
    option('mode', 'mode', mode, Object.keys(codexModes)),
  ])
const codex = catalog.harnesses[1]!

describe('a fork keeps what its source ran with', () => {
  it("takes the source's model, thinking and row on the same Harness, over what this device remembers for it", () => {
    const remembered = { harnessId: 'codex', config: { model: 'small', effort: 'low', mode: 'ask' } }
    const source = forkSource(codexSession('full'), codex)
    expect(source).toMatchObject({
      harnessId: 'codex',
      model: { value: 'large' },
      thinking: { value: 'high' },
      mode: { value: 'full', tier: 'never' },
    })
    const forked = forkedChoice(catalog, remembered, { harnessId: 'codex', mode: 'agent' }, source)
    expect(forked.choice.config).toEqual({ model: 'large', effort: 'high', mode: 'full' })
    expect(forked.missed).toEqual([])
    // Without a source, the Harness's own picks on this device, as before.
    expect(forkedChoice(catalog, remembered, { harnessId: 'codex', mode: 'agent' }).choice.config).toEqual(remembered.config)
  })

  it('falls back to what is remembered when the source model is no longer offered, and says so', () => {
    const remembered = { harnessId: 'codex', config: { model: 'small', mode: 'ask' } }
    const forked = forkedChoice(catalog, remembered, { harnessId: 'codex' }, forkSource(codexSession('write', 'retired'), codex))
    expect(forked.choice.config).toEqual({ model: 'small', effort: 'high', mode: 'write' })
    expect(forked.missed).toEqual(['没有沿用来源会话的模型「RETIRED」：CODEX 在这里不能选。'])
  })

  it('maps the row by tier onto another Harness, never wider than the source, and says what changed', () => {
    const wide = { harnessId: 'gemini', config: { mode: 'yolo' } }
    // The same tier: the row is the source's, and the remembered wider one is not used.
    const asked = forkedChoice(catalog, wide, { harnessId: 'gemini' }, forkSource(codexSession('ask'), codex))
    expect(asked.choice.config).toMatchObject({ mode: 'default', model: 'large', effort: 'high' })
    expect(asked.missed).toEqual([])
    // No 由模型判断 there: the widest stricter row.
    const judged = forkedChoice(catalog, wide, { harnessId: 'gemini' }, forkSource(codexSession('review'), codex))
    expect(judged.choice.config?.mode).toBe('edit')
    expect(judged.missed).toEqual(['来源会话的权限是「由模型判断」，GEMINI 没有这一项，这里用更严的「按规则放行」。'])
    // Modes Latch has no tiers for: none is taken, so the session starts in its own default.
    const unknown = forkedChoice(
      catalog,
      { harnessId: 'cursor', config: { mode: 'agent' } },
      { harnessId: 'cursor' },
      forkSource(codexSession('full'), codex),
    )
    expect(unknown.choice.config).toEqual({ model: 'large', effort: 'high' })
    expect(unknown.missed).toEqual(['来源会话的权限是「不再询问」，CURSOR 的权限对应不上，这里从它默认的那一项开始。'])
  })

  it('takes the strictest row there is, and says so, when the Harness has nothing as strict as the source', () => {
    const planned = detail({ harnessId: 'gemini' }, [option('mode', 'mode', 'plan', ['plan', 'default'])])
    const gemini = catalog.harnesses[2]!
    const forked = forkedChoice(
      catalog,
      { harnessId: 'codex', config: { mode: 'full' } },
      { harnessId: 'codex' },
      forkSource(planned, gemini),
    )
    expect(forked.choice.config).toEqual({ mode: 'ask' })
    expect(forked.missed).toEqual(['来源会话的权限是「只看不改」，CODEX 没有这一项或更严的，这里用它最严的「先问你」。'])
  })

  it('starts a Harness on its default row when the source had none', () => {
    const builtin = detail({ harnessId: 'standard', providerId: 'deepseek', model: 'deepseek-reasoner', effort: 'high', level: 'L1' })
    const forked = forkedChoice(
      catalog,
      { harnessId: 'codex', config: { mode: 'full' } },
      { harnessId: 'codex' },
      forkSource(builtin, undefined),
    )
    expect(forked.choice.config).toEqual({ effort: 'high' })
    expect(forked.missed).toEqual(['没有沿用来源会话的模型「deepseek-reasoner」：CODEX 在这里不能选。'])
  })

  it('keeps the built-in model and thinking level, and the remembered model when the source one is gone', () => {
    const remembered = { harnessId: 'standard', model: { providerId: 'deepseek', model: 'deepseek-chat' } }
    const source = detail({ harnessId: 'standard', providerId: 'deepseek', model: 'deepseek-reasoner', effort: 'high' })
    expect(forkedChoice(catalog, remembered, { harnessId: 'standard' }, forkSource(source, undefined)).choice.model).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-reasoner',
      effort: 'high',
    })
    const gone = detail({ harnessId: 'standard', providerId: 'deepseek', model: 'deepseek-v2', effort: 'high' })
    const forked = forkedChoice(catalog, remembered, { harnessId: 'standard' }, forkSource(gone, undefined))
    expect(forked.choice.model).toEqual(remembered.model)
    expect(forked.missed).toEqual(['没有沿用来源会话的模型「deepseek-v2」与思考「高」：Latch 内置 在这里不能选。'])
  })

  it('lets the person pick anything in the draft, and then says nothing about the row they replaced', () => {
    const source = forkSource(codexSession('review'), codex)
    const mapped = forkedChoice(catalog, null, { harnessId: 'gemini' }, source)
    const picked = forkedChoice(catalog, null, { harnessId: 'gemini', config: { ...mapped.choice.config, mode: 'yolo' } }, source)
    expect(picked.choice.config?.mode).toBe('yolo')
    expect(picked.missed).toEqual([])
    // A pick of another model keeps the row the fork mapped, and what the draft said about it.
    const model = forkedChoice(catalog, null, { harnessId: 'gemini', config: { ...mapped.choice.config, model: 'small' } }, source)
    expect(model.choice.config).toMatchObject({ model: 'small', mode: 'edit' })
    expect(model.missed).toEqual(mapped.missed)
  })

  it('keeps a session that only chats in chat, with no row to carry', () => {
    const chat = detail({ harnessId: 'standard', mode: 'chat', providerId: 'deepseek', model: 'deepseek-chat' })
    const source = forkSource(chat, undefined)
    expect(source.mode).toBeUndefined()
    expect(forkedChoice(catalog, null, { harnessId: 'standard', mode: 'chat' }, source).choice).toMatchObject({ mode: 'chat' })
  })

  it('says so when a session that only chats goes to a Harness that always works on files', () => {
    const source = forkSource(detail({ harnessId: 'standard', mode: 'chat', providerId: 'deepseek', model: 'deepseek-chat' }), undefined)
    const line = '来源会话不读写文件，CODEX 没有这一项，这里从它默认的那一项开始。'
    const forked = forkedChoice(catalog, null, { harnessId: 'codex', mode: 'chat' }, source)
    expect(forked.choice).toMatchObject({ harnessId: 'codex', mode: 'agent' })
    expect(forked.choice.config?.mode).toBeUndefined()
    expect(forked.missed).toContain(line)
    // Before the Harness's options are read, the start is the same and so is the line.
    const unread = { ...catalog, harnesses: [catalog.harnesses[0]!, { ...codex, catalogue: undefined }] }
    expect(forkedChoice(unread, null, { harnessId: 'codex', mode: 'chat' }, source).missed).toContain(line)
    // A row the person picks in the draft is theirs.
    expect(forkedChoice(catalog, null, { harnessId: 'codex', mode: 'chat', config: { mode: 'ask' } }, source).missed).not.toContain(line)
  })

  it('keeps the saved service Latch forwarded the source to, while it still can, and the built-in model on that service', () => {
    const speaking = {
      ...codex,
      capabilities: { ...codex.capabilities, models: { ...codex.capabilities.models, wires: ['responses' as const] } },
    }
    const services: HostCatalog = {
      ...catalog,
      harnesses: [catalog.harnesses[0]!, speaking],
      providers: [{ id: 'openai', name: 'OpenAI', kind: 'openai-responses', models: ['gpt-5.5', 'gpt-5.5-mini'], defaultModel: 'gpt-5.5' }],
    }
    const routed = detail({ harnessId: 'codex', modelRoute: { providerId: 'openai', model: 'gpt-5.5-mini', name: 'OpenAI' } }, [
      option('mode', 'mode', 'review', Object.keys(codexModes)),
    ])
    const forked = forkedChoice(
      services,
      { harnessId: 'codex', config: { model: 'large' } },
      { harnessId: 'codex' },
      forkSource(routed, speaking),
    )
    expect(forked.choice.config).toEqual({ '~service': 'openai\u0000gpt-5.5-mini', mode: 'review' })
    expect(forked.missed).toEqual([])
    // On the built-in Harness the same service and model are a model of its own.
    expect(forkedChoice(services, null, { harnessId: 'standard' }, forkSource(routed, speaking)).choice.model).toEqual({
      providerId: 'openai',
      model: 'gpt-5.5-mini',
    })
    // A service that is gone: the Harness's own model as remembered, and the draft says so.
    const gone = forkedChoice(
      { ...services, providers: [] },
      { harnessId: 'codex', config: { model: 'large' } },
      { harnessId: 'codex' },
      forkSource(routed, speaking),
    )
    expect(gone.choice.config).toEqual({ model: 'large', mode: 'review' })
    expect(gone.missed).toEqual(['没有沿用来源会话的模型「gpt-5.5-mini」：CODEX 在这里不能选。'])
  })

  it('takes the row Latch held the source to, never one the Harness moved itself into', () => {
    const permission = (expectedMode?: string): SessionPermission => ({
      level: 'L3',
      enforcer: 'NONE',
      readback: 'mode',
      notes: [],
      modeTiers: tiers(codexModes),
      ...(expectedMode ? { expectedMode } : {}),
    })
    const drifted = (expectedMode?: string) => {
      const source = codexSession('full')
      return {
        ...source,
        summary: { ...source.summary, permissionDrift: true as const },
        permission: { ...permission(expectedMode), drift: { at: '2026-11-08T00:00:00.000Z', observed: 'full' } },
      }
    }
    const remembered = { harnessId: 'codex', config: { mode: 'write' } }
    // It switched itself from 先问你 to 不再询问: the new session starts where the person had it.
    const kept = forkedChoice(catalog, remembered, { harnessId: 'codex' }, forkSource(drifted('ask'), codex))
    expect(kept.choice.config?.mode).toBe('ask')
    expect(kept.missed).toEqual([])
    // A row it reported that Latch could not confirm is not the session's either.
    const unconfirmed = { ...codexSession('full'), permission: permission('ask') }
    expect(forkedChoice(catalog, remembered, { harnessId: 'codex' }, forkSource(unconfirmed, codex)).choice.config?.mode).toBe('ask')
    // With no row Latch held it to, nothing is taken: the Harness's default row, and the draft says why.
    const unknown = forkedChoice(catalog, remembered, { harnessId: 'codex' }, forkSource(drifted(), codex))
    expect(unknown.choice.config).toEqual({ model: 'large', effort: 'high' })
    expect(unknown.missed).toEqual(['来源会话的权限被它的 Harness 自己改过，没有沿用，这里从 CODEX 默认的那一项开始。'])
  })

  it("says nothing is lost before the other Harness's options are read, only that they are needed", () => {
    const unread: HarnessInfo = { ...agent('goose', { approve: 'ask', smart: 'model' }), catalogue: undefined }
    const reading = { ...catalog, harnesses: [...catalog.harnesses, unread] }
    const forked = forkedChoice(reading, null, { harnessId: 'goose' }, forkSource(codexSession('write'), codex))
    expect(forked.choice.harnessId).toBe('goose')
    expect(forked.choice.config ?? {}).toEqual({})
    expect(forked.missed).toEqual(['来源会话的模型「LARGE」、思考「HIGH」与权限「按规则放行」要等读到 GOOSE 的选项后才能沿用。'])
    // A model of a service, which no list of the Harness's own can offer, is still lost; its thinking level waits.
    const builtin = detail({ harnessId: 'standard', providerId: 'deepseek', model: 'deepseek-reasoner', effort: 'high' })
    expect(forkedChoice(reading, null, { harnessId: 'goose' }, forkSource(builtin, undefined)).missed).toEqual([
      '没有沿用来源会话的模型「deepseek-reasoner」：GOOSE 在这里不能选。',
      '来源会话的思考「高」要等读到 GOOSE 的选项后才能沿用。',
    ])
  })

  it('maps onto the Harness a draft falls back to when the source one is gone', () => {
    const gone = { ...catalog, harnesses: catalog.harnesses.filter(harness => harness.id !== 'codex') }
    const forked = forkedChoice(gone, null, { harnessId: 'codex' }, forkSource(codexSession('review'), codex))
    expect(forked.choice.harnessId).toBe(resolveChoice(gone, null).harnessId)
    expect(forked.choice.harnessId).toBe('gemini')
    expect(forked.choice.config?.mode).toBe('edit')
  })
})
