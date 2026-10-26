import { createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { HarnessInfo, HostCatalog, SessionConfigOption } from '@latch/protocol'
import { ModelReasoningPicker, type ModelReasoningPickerProps } from '../src/components/ModelReasoningPicker.tsx'
import { SessionControls } from '../src/components/ComposerControls.tsx'
import { agentConfigChoice, agentConfigValues, agentModelControls } from '../src/components/modelReasoning.ts'

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
const props = (): ModelReasoningPickerProps => ({ config: structuredClone([model, reasoning, context]), busy: null, onChange() {} })
const html = (value: ModelReasoningPickerProps) => renderToStaticMarkup(createElement(ModelReasoningPicker, value))

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
    expect(modelOnly).not.toContain('setup-panel')
    expect(modelOnly).not.toContain('role="slider"')
    expect(html({ ...props(), config: [{ ...reasoning, category: undefined }] })).toBe('')
    expect(html({ ...props(), config: [] })).toBe('')
  })

  it('keeps model parameters under their original names and reasoning under the actual selected label', () => {
    const rendered = html(props())
    expect(rendered).toContain('First model · 均衡')
    expect(rendered).toContain('思考预算')
    expect(rendered).toContain('上下文窗口')
    expect(rendered).toContain('Only the choices this Agent reports')
    expect(rendered).toContain('Agent description')
    expect(rendered).toContain('aria-checked="true"')
    expect(rendered).toContain('aria-haspopup="menu"')
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

  it('passes a selected intent and its Promise through without treating a resolved callback as a new selected value', async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => {
      finish = resolve
    })
    const onChange = vi.fn(() => pending)
    const value = { ...props(), onChange }
    const control = ModelReasoningPicker(value)
    expect(isValidElement(control)).toBe(true)
    if (!isValidElement<{ onValueChange: (value: string) => void | Promise<void> }>(control)) throw new Error('Missing model control')
    const result = control.props.onValueChange('two')
    expect(result).toBe(pending)
    expect(onChange).toHaveBeenCalledExactlyOnceWith(model.id, 'two')
    expect(value.config[0]!.currentValue).toBe('one')
    finish()
    await result
    expect(html(value)).toContain('First model · 均衡')
    expect(value.config[0]!.currentValue).toBe('one')
    const settled = { ...value, config: value.config.map(option => (option.id === model.id ? { ...option, currentValue: 'two' } : option)) }
    expect(html(settled)).toContain('Second model · 均衡')
    const stopped = ModelReasoningPicker({ ...value, feedback: { kind: 'unknown', message: 'Unknown' } })
    if (!isValidElement<{ onValueChange: (value: string) => void | Promise<void> }>(stopped)) throw new Error('Missing unknown control')
    expect(stopped.props.onValueChange('two')).toBeUndefined()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('renders Agent text safely and visibly exposes direction controls', () => {
    const rendered = html({ ...props(), config: [{ ...model, name: '<script>\u202EModel' }] })
    expect(rendered).not.toContain('<script>')
    expect(rendered).not.toContain('\u202E')
    expect(rendered).toContain('&lt;script&gt;')
    expect(rendered).toContain('\\u{202E}')
  })

  it('exposes the same real Agent options from desktop and phone SessionControls while respecting its locked gate', () => {
    const harness: HarnessInfo = { id: 'fake-agent', name: 'Fake Agent', source: 'acp', status: 'ready', modes: ['agent'], models: 'agent' }
    const catalog: HostCatalog = {
      harnesses: [harness],
      providers: [],
      workspaces: [],
      defaults: { harnessId: harness.id, mode: 'agent', workspaceId: 'default' },
    }
    const value = {
      catalog,
      harness,
      summary: { id: 's', title: '', status: 'idle' as const, updatedAt: '' },
      config: [...props().config],
      configBusy: null,
      onConfig() {},
      onModel() {},
      access: { local: true, legacy: false, admin: true },
    }
    for (const phone of [false, true]) {
      const rendered = renderToStaticMarkup(createElement(SessionControls, { ...value, phone }))
      expect(rendered).toContain('First model · 均衡')
      expect(rendered).toContain('思考预算')
      expect(renderToStaticMarkup(createElement(SessionControls, { ...value, phone, locked: true }))).toBe('')
    }
  })
})
