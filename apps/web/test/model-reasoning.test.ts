import { createElement } from 'react'
import { testHarness } from '@latch/testkit'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { HarnessInfo, HostCatalog, ModelRef, SessionConfigOption } from '@latch/protocol'
import { DraftModelControl, SessionModelControl } from '../src/composer/ModelControl.tsx'
import { draftConfig, rememberedConfig, resolveChoice, sameModel, startConfig, switchModel, thinkingLevels } from '../src/composerChoice.ts'
import { contextUse, contextWords, draftPermission, permissionView } from '../src/composer/permission.ts'
import {
  agentConfigChoice,
  agentConfigValues,
  agentModelControls,
  composerOptions,
  modelChipText,
  modelWords,
  thinkingWord,
  unreportedNote,
} from '../src/composer/modelReasoning.ts'

const model: SessionConfigOption = {
  id: 'opaque-model',
  name: 'Agent model',
  category: 'model',
  currentValue: 'one',
  options: [
    { value: 'one', name: 'First model' },
    { value: 'two', name: 'Second model', description: 'Agent description' },
  ],
}
const reasoning: SessionConfigOption = {
  id: 'opaque-budget',
  name: '思考预算',
  category: 'thought_level',
  currentValue: 'balanced',
  description: 'Only the choices this Agent reports',
  options: [
    { value: 'automatic', name: '由模型决定' },
    { value: 'balanced', name: '均衡' },
    { value: 'detailed', name: '更详细' },
  ],
}
const context: SessionConfigOption = { ...reasoning, id: 'context', name: '上下文窗口', category: 'model_config' }
const harness: HarnessInfo = testHarness('fake-agent', { label: 'Fake Agent' })
const catalog: HostCatalog = {
  harnesses: [harness],
  providers: [],
  workspaces: [],
  defaults: { harnessId: harness.id, mode: 'agent', workspaceId: 'default' },
}
const props = () => ({
  catalog,
  harness,
  model: undefined,
  current: undefined,
  onModel() {},
  config: structuredClone([model, reasoning, context]),
  busy: null as string | null,
  onConfig() {},
  permission: undefined,
  access: { local: true, legacy: false, admin: true },
})
const html = (value: ReturnType<typeof props> & { feedback?: { kind: 'failed' | 'unknown'; message: string }; onRefresh?: () => void }) =>
  renderToStaticMarkup(createElement(SessionModelControl, value))

describe('Agent model and reasoning controls', () => {
  it('uses only semantic categories, preserves priority and does not infer capabilities from familiar model or option names', () => {
    const unclassified = { ...reasoning, id: 'reasoning_effort', category: undefined }
    const guessed = {
      ...model,
      currentValue: 'gpt-6-high-reasoning',
      options: [{ value: 'gpt-6-high-reasoning', name: 'GPT high reasoning' }],
    }
    expect(agentModelControls([unclassified, context, guessed])).toEqual({ primary: guessed, related: [context] })
    expect(agentModelControls([unclassified])).toEqual({ related: [] })
    const second = { ...reasoning, id: 'second-budget' }
    const state = agentModelControls([context, reasoning, model, second, { ...model, id: 'second-model' }])
    expect(state.primary).toBe(model)
    expect(state.related).toEqual([context, reasoning, second])
    expect(agentModelControls([reasoning]).primary).toBe(reasoning)
  })

  it('offers only wire values actually reported by this Agent and keeps their order', () => {
    const duplicated = { ...reasoning, options: [...reasoning.options, { value: 'balanced', name: 'Duplicate label' }] }
    expect(agentConfigValues(duplicated)).toEqual(reasoning.options)
    expect(agentConfigChoice([model], model.id, 'two', { busy: null })).toEqual({ configId: model.id, value: 'two' })
    for (const [id, value] of [
      [model.id, 'one'],
      [model.id, 'invented-high'],
      ['reasoning_effort', 'two'],
    ])
      expect(agentConfigChoice([model], id!, value!, { busy: null })).toBeUndefined()
    const changed = { ...model, options: [{ value: 'one', name: 'Only current remains' }] }
    expect(agentConfigChoice([changed], model.id, 'two', { busy: null })).toBeUndefined()
  })

  it('does not expose a reasoning slot for model-only or uncategorized options', () => {
    const modelOnly = html({ ...props(), config: [model] })
    expect(modelOnly).toContain('First model')
    expect(modelOnly).not.toContain('role="slider"')
    expect(modelOnly).toContain('First model · 默认思考')
    // Nothing reported: the control still names both facts, and says the Harness decides.
    const silent = html({ ...props(), config: [] })
    expect(silent).toContain('默认模型 · 默认思考')
    expect(silent).toContain('Fake Agent 没有报告模型和思考深度')
  })

  it('holds model and thinking in one control, with every choice still reachable', () => {
    const rendered = html(props())
    expect(rendered).toContain('First model · 均衡')
    expect(rendered).toContain('思考')
    expect(rendered).toContain('上下文窗口')
    expect(rendered).toContain('Agent description')
    expect(rendered).toContain('aria-checked="true"')
    expect(rendered).not.toContain('role="slider"')
  })

  it('blocks pending, disabled and unknown writes while leaving failed choices authoritative and selectable', () => {
    for (const state of [
      { busy: model.id },
      { busy: null, disabled: true },
      { busy: null, feedback: { kind: 'unknown' as const, message: 'Result unknown' } },
    ])
      expect(agentConfigChoice([model], model.id, 'two', state)).toBeUndefined()
    expect(agentConfigChoice([model], model.id, 'two', { busy: null, feedback: { kind: 'failed', message: 'Declined' } })).toEqual({
      configId: model.id,
      value: 'two',
    })
    const unknown = html({ ...props(), feedback: { kind: 'unknown', message: '保持原请求，结果未知' }, onRefresh() {} })
    expect(unknown).toContain('First model · 均衡 · 结果未知')
    expect(unknown).toContain('刷新当前设置')
    expect(unknown).toContain('保持原请求，结果未知')
    expect(unknown).toContain('aria-disabled="true"')
    expect(html({ ...props(), busy: reasoning.id })).toContain('aria-busy="true"')
  })

  it('renders Agent text safely and visibly exposes direction controls', () => {
    const rendered = html({ ...props(), config: [{ ...model, options: [{ value: 'one', name: '<script>\u202EModel' }] }] })
    expect(rendered).not.toContain('<script>')
    expect(rendered).not.toContain('\u202E')
    expect(rendered).toContain('&lt;script&gt;')
    expect(rendered).toContain('\\u{202E}')
  })
})

describe('the 权限 chip', () => {
  const modes: SessionConfigOption = {
    id: 'mode',
    name: '模式',
    category: 'mode',
    currentValue: 'read-only',
    options: [
      { value: 'read-only', name: '只读' },
      { value: 'workspace-write', name: '自动' },
      { value: 'agent-full-access', name: '完全访问' },
    ],
  }
  const permission = {
    level: 'L3' as const,
    enforcer: 'NONE' as const,
    readback: 'mode' as const,
    approvals: 'prompts' as const,
    expectedMode: 'read-only',
    defaultMode: 'read-only',
    neverAskModes: ['agent-full-access'],
    notes: [],
  }
  const local = { legacy: false, local: true }
  const view = (currentValue: string, access = local) =>
    permissionView({ harness, permission, config: [{ ...modes, currentValue }], access })!

  it('always names the mode, amber only where it never asks', () => {
    expect(view('read-only')).toMatchObject({ amber: false, label: '只读', icon: 'eye' })
    expect(view('workspace-write')).toMatchObject({ amber: false, label: '自动', icon: 'shield' })
    expect(view('agent-full-access')).toMatchObject({ amber: true, icon: 'shield-alert' })
    expect(view('read-only').note).toContain('也不隔离它')
  })

  it('makes the widest and the unconfirmable case the visible ones', () => {
    const decides = permissionView({ harness, permission: { ...permission, approvals: 'none' }, config: [], access: local })
    expect(decides).toMatchObject({ amber: true, label: '不询问 · 由 Fake Agent 决定' })
    const blind = permissionView({ harness, permission: { ...permission, readback: 'none' }, config: [], access: local })
    expect(blind).toMatchObject({ amber: true, label: '权限无法确认' })
  })

  it('says what the built-in Harness does', () => {
    const builtin = { ...harness, source: 'builtin' as const, level: 'L1' as const }
    expect(permissionView({ harness: builtin, config: [], access: local })).toMatchObject({ amber: false, label: '先问你' })
  })

  it('says a chat touches no files, in a draft and in a session, whatever the Harness declares', () => {
    expect(draftPermission(harness, 'chat')).toMatchObject({ label: '不读写文件', amber: false })
    expect(permissionView({ harness, mode: 'chat', config: [], access: local })).toMatchObject({ label: '不读写文件', amber: false })
  })

  it('tells a draft only what the Harness declares', () => {
    const draft = (declared?: { approvals: 'prompts' | 'none'; readback: 'mode' | 'none' }) =>
      draftPermission({ ...harness, ...(declared ? { permission: declared } : {}) }, 'agent')
    expect(draft({ approvals: 'prompts', readback: 'mode' })).toMatchObject({ label: '先问你', amber: false })
    expect(draft({ approvals: 'prompts', readback: 'mode' })?.note).toContain('发第一条消息后可以换')
    expect(draft({ approvals: 'none', readback: 'none' })).toMatchObject({ label: '不询问 · 由 Fake Agent 决定', amber: true })
    expect(draft({ approvals: 'prompts', readback: 'none' })).toMatchObject({ label: '权限无法确认', amber: true })
    expect(draft()).toMatchObject({ label: '开始后可以选', amber: false })
  })

  it('offers wider rows on another device too', () => {
    const rows = view('workspace-write', { legacy: false, local: false }).rows!
    expect(rows.map(row => row.disabledReason)).toEqual([undefined, undefined, undefined])
  })
})

describe('the context ring', () => {
  it('appears from half full, only from what the engine reported', () => {
    expect(contextUse(undefined)).toBeUndefined()
    expect(contextUse({ contextUsed: 100 })).toBeUndefined()
    expect(contextUse({ contextUsed: 100_000, contextSize: 400_000 })).toBeUndefined()
    expect(contextUse({ contextUsed: 248_000, contextSize: 400_000 })).toEqual({ percent: 62, words: '上下文已用 62% · 248K / 400K' })
  })

  it('still has the words below that, for the breadcrumb', () => {
    expect(contextWords({ contextUsed: 100_000, contextSize: 400_000 })?.percent).toBe(25)
    expect(contextWords({ contextUsed: 100 })).toBeUndefined()
  })
})

describe('options the composer has no control for', () => {
  const option = (id: string, category?: SessionConfigOption['category']): SessionConfigOption => ({
    id,
    name: id,
    ...(category ? { category } : {}),
    currentValue: 'a',
    options: [{ value: 'a', name: 'A' }],
  })
  const config = [option('m', 'model'), option('t', 'thought_level'), option('c', 'model_config'), option('mode', 'mode'), option('x')]

  it('stay reachable under ⋯, and appear once', () => {
    expect(composerOptions(config, false).map(item => item.id)).toEqual(['x'])
    expect(composerOptions(config, true).map(item => item.id)).toEqual(['c', 'x'])
    expect(composerOptions([option('c', 'model_config'), option('x')], false).map(item => item.id)).toEqual(['c', 'x'])
  })
})

describe('the model control label', () => {
  const option = (category: string) => ({
    id: category,
    name: category,
    category,
    type: 'select' as const,
    currentValue: 'a',
    options: [{ value: 'a', name: 'A' }],
  })
  it('always has both facts, with words for the one not known', () => {
    expect(modelChipText('GPT-5.5', '高')).toBe('GPT-5.5 · 高')
    expect(modelChipText(undefined, undefined)).toBe('默认模型 · 默认思考')
  })
  it('gives one sentence on what the Harness has not reported', () => {
    expect(unreportedNote('pi', false, [])).toContain('开始后才报告')
    expect(unreportedNote('pi', true, [])).toBe('pi 没有报告模型和思考深度，由它自己决定。')
    expect(unreportedNote('pi', true, [option('model')])).toBe('pi 没有报告思考深度，用它自己的默认值。')
    expect(unreportedNote('pi', true, [option('thought_level')])).toBe('pi 没有报告可选的模型，由它自己决定。')
    expect(unreportedNote('pi', true, [option('model'), option('thought_level')])).toBeUndefined()
  })
})

describe("a draft's list of a Harness's own options", () => {
  const select = (id: string, category: string, currentValue: string, values: string[]): SessionConfigOption => ({
    id,
    name: id,
    category,
    currentValue,
    options: values.map(value => ({ value, name: value.toUpperCase() })),
  })
  const listed: HarnessInfo = testHarness('codex', {
    label: 'Codex',
    permission: { approvals: 'prompts', readback: 'mode', neverAskModes: ['full'] },
    catalogue: {
      options: [
        select('mode', 'mode', 'read', ['read', 'write', 'full']),
        select('model', 'model', 'small', ['small', 'large', 'huge']),
        select('effort', 'thought_level', 'low', ['low', 'high']),
        select('fast', 'model_config', 'off', ['off', 'on']),
      ],
      perModel: [
        { model: 'large', options: [select('effort', 'thought_level', 'low', ['low', 'high', 'max'])] },
        { model: 'small', options: [select('effort', 'thought_level', 'low', ['low', 'high'])] },
      ],
      reportedAt: '2026-11-06T10:00:00.000Z',
      source: 'session',
    },
  })
  const values = (config: SessionConfigOption[] | undefined, id: string) => config?.find(option => option.id === id)

  it('is what the last session offered, with the picks in it', () => {
    expect(draftConfig(testHarness('pi'), {})).toBeUndefined()
    const plain = draftConfig(listed, undefined)!
    expect(plain.config.map(option => [option.id, option.currentValue])).toEqual([
      ['mode', 'read'],
      ['model', 'small'],
      ['effort', 'low'],
      ['fast', 'off'],
    ])
    expect(plain.thinkingUnknown).toBe(false)
    const picked = draftConfig(listed, { model: 'small', effort: 'high', mode: 'write' })!
    expect(picked.config.map(option => option.currentValue)).toEqual(['write', 'small', 'high', 'off'])
  })

  it('follows the model: the levels a session on it offered, or none known yet', () => {
    const large = draftConfig(listed, { model: 'large', effort: 'max' })!
    expect(values(large.config, 'effort')?.options.map(item => item.value)).toEqual(['low', 'high', 'max'])
    expect(values(large.config, 'effort')?.currentValue).toBe('max')
    // What followed the default model is not claimed for another.
    expect(values(large.config, 'fast')).toBeUndefined()
    const huge = draftConfig(listed, { model: 'huge', effort: 'high' })!
    expect(values(huge.config, 'effort')).toBeUndefined()
    expect(huge.thinkingUnknown).toBe(true)
    // A pick the list no longer has is not carried.
    expect(values(draftConfig(listed, { model: 'gone' })!.config, 'model')?.currentValue).toBe('small')
  })

  it('starts with only what was picked and is still offered, and keeps all but the mode for the next draft', () => {
    expect(startConfig(listed, { model: 'large', effort: 'max', mode: 'write', other: 'x' })).toEqual([
      { configId: 'model', value: 'large' },
      { configId: 'effort', value: 'max' },
      { configId: 'mode', value: 'write' },
    ])
    expect(startConfig(listed, { model: 'small', effort: 'max' })).toEqual([{ configId: 'model', value: 'small' }])
    expect(rememberedConfig(listed, { model: 'large', mode: 'write' })).toEqual({ model: 'large' })
    expect(rememberedConfig(listed, { mode: 'write' })).toBeUndefined()
  })

  it('lists model IDs typed for the Harness after its own, and starts on one', () => {
    const typed = { ...listed, customModels: ['vendor/typed', 'large'] }
    const model = draftConfig(typed, { model: 'vendor/typed' })!.config.find(option => option.category === 'model')!
    expect(model.currentValue).toBe('vendor/typed')
    expect(model.options.map(item => [item.value, item.description])).toEqual([
      ['small', undefined],
      ['large', undefined],
      ['huge', undefined],
      ['vendor/typed', '自己填写'],
    ])
    expect(startConfig(typed, { model: 'vendor/typed' })).toEqual([{ configId: 'model', value: 'vendor/typed' }])
    expect(startConfig(listed, { model: 'vendor/typed' })).toEqual([])
  })

  it('lists the modes as a session does, the starting one current and the never-asking one amber', () => {
    const view = draftPermission(listed, 'agent', draftConfig(listed, { mode: 'full' })!.config)!
    expect(view.rows?.map(row => [row.value, row.current, row.neverAsks])).toEqual([
      ['read', false, false],
      ['write', false, false],
      ['full', true, true],
    ])
    expect(view.amber).toBe(true)
    expect(draftPermission(listed, 'agent', draftConfig(listed, undefined)!.config)!.label).toBe('READ')
    // Without a list: what the Harness declares, and that it can be changed after the start.
    expect(draftPermission(testHarness('codex', { permission: { approvals: 'prompts', readback: 'mode' } }), 'agent')?.note).toContain(
      '发第一条消息后可以换',
    )
  })

  it('drops picks made for another Harness', () => {
    const built: HostCatalog = { ...catalog, harnesses: [listed, testHarness('pi')], defaults: { ...catalog.defaults, harnessId: 'codex' } }
    expect(resolveChoice(built, { harnessId: 'codex', config: { model: 'large', mode: 'write' } }).config).toEqual({
      model: 'large',
      mode: 'write',
    })
    expect(resolveChoice(built, { harnessId: 'pi', config: { model: 'large' } }).config).toBeUndefined()
  })

  it('draws the draft from the list, says where it came from, and not that it is known only after the start', () => {
    const markup = renderToStaticMarkup(
      createElement(DraftModelControl, {
        catalog: { ...catalog, harnesses: [listed] },
        choice: { mode: 'agent', harnessId: 'codex', config: { model: 'large' } },
        onChoice() {},
        access: { local: true, legacy: false, admin: true, scopes: new Set(['view', 'run'] as const) },
        disabled: false,
      }),
    )
    expect(markup).toContain('LARGE · LOW')
    expect(markup).not.toContain('开始后才报告')
  })
})

describe('thinking on the built-in Harness', () => {
  const builtin = testHarness('standard', { kind: 'builtin', label: 'Latch 内置' })
  const declared: HostCatalog = {
    harnesses: [builtin],
    providers: [
      {
        id: 'lab',
        name: 'Lab',
        kind: 'openai-compatible',
        models: ['alpha', 'beta', 'gamma'],
        defaultModel: 'alpha',
        modelCapabilities: { alpha: { thinking: ['low', 'medium', 'high'] }, beta: { thinking: ['low', 'xhigh'] } },
      },
    ],
    workspaces: [],
    defaults: { harnessId: builtin.id, mode: 'agent', workspaceId: 'default' },
  }
  const session = (model: ModelRef | undefined, current: ModelRef | undefined) =>
    renderToStaticMarkup(
      createElement(SessionModelControl, { ...props(), catalog: declared, harness: builtin, model, current, config: [] }),
    )

  it('reads the declared levels only, and keeps a level across models only where the other model declares it too', () => {
    expect(thinkingLevels(declared, { providerId: 'lab', model: 'alpha' })).toEqual(['low', 'medium', 'high'])
    expect(thinkingLevels(declared, { providerId: 'lab', model: 'gamma' })).toEqual([])
    const high = { providerId: 'lab', model: 'alpha', effort: 'high' }
    expect(switchModel(declared, high, { providerId: 'lab', model: 'beta' })).toEqual({ providerId: 'lab', model: 'beta' })
    expect(switchModel(declared, { ...high, effort: 'low' }, { providerId: 'lab', model: 'beta' })).toEqual({
      providerId: 'lab',
      model: 'beta',
      effort: 'low',
    })
    expect(sameModel(high, { providerId: 'lab', model: 'alpha' })).toBe(false)
    expect(sameModel(high, { ...high })).toBe(true)
    expect(modelWords(high)).toBe('alpha · 高')
    expect(thinkingWord('xhigh')).toBe('超高')
    expect(thinkingWord('turbo')).toBe('turbo')
  })

  it('shows the chosen level on the chip, the declared levels in the menu, and a level switch as the next message', () => {
    const current = { providerId: 'lab', model: 'alpha', effort: 'high' }
    expect(session(current, current)).toContain('alpha · 高')
    expect(session({ providerId: 'lab', model: 'alpha' }, current)).toContain('下一条：alpha')
    expect(session({ providerId: 'lab', model: 'alpha', effort: 'low' }, current)).toContain('下一条：alpha · 低')
    expect(session({ providerId: 'lab', model: 'gamma' }, { providerId: 'lab', model: 'gamma' })).toContain('gamma · 默认思考')
  })

  it('drops a remembered level the owner has since taken away, and keeps one still declared', () => {
    const stored = (effort: string) => ({ harnessId: builtin.id, model: { providerId: 'lab', model: 'alpha', effort } })
    expect(resolveChoice(declared, stored('high')).model).toEqual({ providerId: 'lab', model: 'alpha', effort: 'high' })
    expect(resolveChoice(declared, stored('max')).model).toEqual({ providerId: 'lab', model: 'alpha' })
  })
})
