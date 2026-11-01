import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { HarnessInfo, HostCatalog, SessionConfigOption } from '@latch/protocol'
import { SessionModelControl } from '../src/composer/ModelControl.tsx'
import { contextUse, contextWords, permissionView } from '../src/composer/permission.ts'
import { agentConfigChoice, agentConfigValues, agentModelControls, composerOptions } from '../src/composer/modelReasoning.ts'

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
const harness: HarnessInfo = {
  id: 'fake-agent',
  name: 'Fake Agent',
  source: 'acp',
  status: 'ready',
  modes: ['agent'],
  models: 'agent',
  level: 'L3',
}
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
    expect(modelOnly).not.toContain('思考预算')
    expect(modelOnly).not.toContain('role="slider"')
    // Nothing reported: the control still names the engine, and says the engine decides.
    expect(html({ ...props(), config: [] })).toContain('Fake Agent')
  })

  it('holds model and thinking in one control, under their original names, with every choice still reachable', () => {
    const rendered = html(props())
    expect(rendered).toContain('First model · 均衡')
    expect(rendered).toContain('思考预算')
    expect(rendered).toContain('上下文窗口')
    expect(rendered).toContain('Agent description')
    expect(rendered).toContain('会话开始后不能换引擎')
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
    const rendered = html({ ...props(), config: [{ ...model, name: '<script>\u202EModel' }] })
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

  it('draws nothing on the engine’s default, the mode otherwise, and amber only where it never asks', () => {
    expect(view('read-only')).toMatchObject({ chip: false, amber: false, label: '只读', icon: 'eye' })
    expect(view('workspace-write')).toMatchObject({ chip: true, amber: false, label: '自动', icon: 'shield' })
    expect(view('agent-full-access')).toMatchObject({ chip: true, amber: true, icon: 'shield-alert' })
  })

  it('judges the default by the mode a session starts in, not the one it was last set to', () => {
    const moved = { ...permission, expectedMode: 'workspace-write' }
    expect(
      permissionView({ harness, permission: moved, config: [{ ...modes, currentValue: 'workspace-write' }], access: local })?.chip,
    ).toBe(true)
  })

  it('keeps the chip for an engine Latch cannot limit or read back', () => {
    const decides = permissionView({ harness, permission: { ...permission, approvals: 'none' }, config: [], access: local })
    expect(decides).toMatchObject({ chip: true, label: '由 Fake Agent 决定' })
    const blind = permissionView({ harness, permission: { ...permission, readback: 'none' }, config: [], access: local })
    expect(blind).toMatchObject({ chip: true, label: '权限无法确认' })
  })

  it('says nothing for the built-in engine, which asks before each step', () => {
    const builtin = { ...harness, source: 'builtin' as const, level: 'L1' as const }
    expect(permissionView({ harness: builtin, config: [], access: local })).toMatchObject({ chip: false, label: '需要时询问' })
  })

  it('disables wider rows on another device, with where to do it', () => {
    const rows = view('workspace-write', { legacy: false, local: false }).rows!
    expect(rows.map(row => row.disabledReason)).toEqual([undefined, undefined, '在 Mac 上开启'])
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
