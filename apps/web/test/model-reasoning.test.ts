import { createElement } from 'react'
import { testHarness } from '@latch/testkit'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { HarnessInfo, HostCatalog, ModelRef, SessionConfigOption } from '@latch/protocol'
import { readsOnPermission } from '../src/composer/harnessCatalogue.tsx'
import { DraftModelControl, ownModelGroups, routeService, serviceValue, SessionModelControl } from '../src/composer/ModelControl.tsx'
import { DraftThinkingControl, SessionThinkingControl } from '../src/composer/ThinkingControl.tsx'
import { draftConfig, harnessPicks, resolveChoice, sameModel, startConfig, switchModel, thinkingLevels } from '../src/composerChoice.ts'
import { forkedChoice } from '../src/forkChoice.ts'
import { contextWords, draftPermission, draftRead, permissionView } from '../src/composer/permission.ts'
import {
  agentConfigChoice,
  agentConfigValues,
  agentModelControls,
  composerOptions,
  modelWords,
  thinkingWord,
  unreportedModelNote,
  unreportedThinkingNote,
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
type Props = ReturnType<typeof props> & {
  feedback?: { kind: 'failed' | 'unknown'; message: string }
  onRefresh?: () => void
  locked?: string
}
const html = (value: Props) => renderToStaticMarkup(createElement(SessionModelControl, value))
const thinkingHtml = (value: Props) => renderToStaticMarkup(createElement(SessionThinkingControl, value))
/** A trigger's accessible name: what a screen reader and the e2e read. */
const named = (markup: string, label: string) => markup.match(new RegExp(`aria-label="${label}：([^"]*)"`, 'u'))?.[1]

describe('Agent model and reasoning controls', () => {
  it('uses only semantic categories, preserves priority and does not infer capabilities from familiar model or option names', () => {
    const unclassified = { ...reasoning, id: 'reasoning_effort', category: undefined }
    const guessed = {
      ...model,
      currentValue: 'gpt-6-high-reasoning',
      options: [{ value: 'gpt-6-high-reasoning', name: 'GPT high reasoning' }],
    }
    expect(agentModelControls([unclassified, context, guessed])).toEqual({ model: guessed, related: [context] })
    expect(agentModelControls([unclassified])).toEqual({ related: [] })
    const second = { ...reasoning, id: 'second-budget' }
    const state = agentModelControls([context, reasoning, model, second, { ...model, id: 'second-model' }])
    expect(state.model).toBe(model)
    expect(state.thinking).toBe(reasoning)
    expect(state.related).toEqual([context])
    // Thinking alone is the thinking control's, never the model's.
    expect(agentModelControls([reasoning])).toEqual({ thinking: reasoning, related: [] })
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

  it('does not invent a level for a model-only or uncategorized list: 思考 is 默认 and says why', () => {
    const modelOnly = { ...props(), config: [model] }
    expect(named(html(modelOnly), '模型')).toBe('First model')
    expect(html(modelOnly)).not.toContain('role="slider"')
    expect(named(thinkingHtml(modelOnly), '思考')).toBe('默认')
    expect(thinkingHtml(modelOnly)).toContain('Fake Agent 没有报告思考，用它自己的默认值。')
    // Nothing reported: each control names its own fact and says the Harness decides.
    const silent = { ...props(), config: [] }
    expect(named(html(silent), '模型')).toBe('默认模型')
    expect(html(silent)).toContain('Fake Agent 没有报告可选的模型，由它自己决定。')
    expect(html(silent)).not.toContain('思考')
    expect(named(thinkingHtml(silent), '思考')).toBe('默认')
  })

  it('keeps model and thinking apart: each control writes only its value, and every choice stays reachable', () => {
    const rendered = html(props())
    expect(named(rendered, '模型')).toBe('First model')
    expect(rendered).toContain('上下文窗口')
    expect(rendered).toContain('Agent description')
    expect(rendered).not.toContain('aria-label="思考"')
    const thinking = thinkingHtml(props())
    expect(named(thinking, '思考')).toBe('均衡')
    // The Harness's own names, each a row of the menu, the current one checked.
    for (const level of ['由模型决定', '均衡', '更详细']) expect(thinking).toContain(level)
    expect(thinking).toContain('aria-checked="true"')
    expect(thinking).not.toContain('First model')
    expect(thinking).not.toContain('role="slider"')
    expect(thinking).toContain('thinking-picker')
    expect(thinking).not.toContain('is-fixed')
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
    const unknown = { ...props(), feedback: { kind: 'unknown' as const, message: '保持原请求，结果未知' }, onRefresh() {} }
    // Both controls are held back, and each says so in its menu with the way out.
    for (const [markup, label, value] of [
      [html(unknown), '模型', 'First model · 结果未知'],
      [thinkingHtml(unknown), '思考', '均衡 · 结果未知'],
    ] as const) {
      expect(named(markup, label)).toBe(value)
      expect(markup).toContain('刷新当前设置')
      expect(markup).toContain('保持原请求，结果未知')
      expect(markup).toContain('aria-disabled="true"')
    }
    // A write in flight turns the control it belongs to, not the other one.
    expect(thinkingHtml({ ...props(), busy: reasoning.id })).toContain('aria-busy="true"')
    expect(thinkingHtml({ ...props(), busy: reasoning.id })).toContain('正在切换…')
    expect(html({ ...props(), busy: reasoning.id })).not.toContain('aria-busy="true"')
    expect(html({ ...props(), busy: model.id })).toContain('aria-busy="true"')
    expect(thinkingHtml({ ...props(), busy: model.id })).not.toContain('aria-busy="true"')
  })

  it('shows a device that may only watch both controls with the reason, and no way to change them', () => {
    const watching = { ...props(), locked: '这台设备不能发送消息' }
    for (const markup of [html(watching), thinkingHtml(watching)]) {
      expect(markup).toMatch(/<button[^>]*aria-disabled="true"/u)
      expect(markup).toContain('这台设备不能发送消息')
    }
  })

  it('renders Agent text safely and visibly exposes direction controls', () => {
    for (const rendered of [
      html({ ...props(), config: [{ ...model, options: [{ value: 'one', name: '<script>\u202EModel' }] }] }),
      thinkingHtml({ ...props(), config: [{ ...reasoning, options: [{ value: 'balanced', name: '<script>\u202ELevel' }] }] }),
    ]) {
      expect(rendered).not.toContain('<script>')
      expect(rendered).not.toContain('\u202E')
      expect(rendered).toContain('&lt;script&gt;')
      expect(rendered).toContain('\\u{202E}')
    }
  })
})

describe('the 权限 chip', () => {
  const modes: SessionConfigOption = {
    id: 'mode',
    name: '模式',
    category: 'mode',
    currentValue: 'read-only',
    options: [
      { value: 'read-only', name: 'Read-only' },
      { value: 'workspace-write', name: 'Workspace access' },
      { value: 'agent', name: 'Auto review', description: 'Only ask for actions detected as potentially unsafe' },
      { value: 'agent-full-access', name: 'Full access' },
      { value: 'permission-profile:x', name: 'Profile X' },
    ],
  }
  const modeTiers = {
    'read-only': { tier: 'ask' as const, line: 'Codex 只读；要改文件或联网时先问你' },
    'workspace-write': { tier: 'rule' as const, line: '在项目里改文件、运行命令不问你' },
    agent: { tier: 'model' as const, line: '写项目外或联网由 Codex 的模型代你决定，拦下就不做。模型可能判断错' },
    'agent-full-access': { tier: 'never' as const, line: 'Codex 直接读写这台 Mac 上的文件、联网并运行命令' },
  }
  const permission = {
    level: 'L3' as const,
    enforcer: 'NONE' as const,
    readback: 'mode' as const,
    approvals: 'prompts' as const,
    expectedMode: 'read-only',
    defaultMode: 'read-only',
    modeTiers,
    notes: [],
  }
  const local = { legacy: false, local: true }
  const view = (currentValue: string, access = local) =>
    permissionView({ harness, permission, config: [{ ...modes, currentValue }], access })!

  it("titles each mode by Latch's word with the Harness's own line, amber only where it never asks", () => {
    expect(view('read-only')).toMatchObject({ amber: false, label: '先问你', icon: 'shield', line: modeTiers['read-only'].line })
    expect(view('workspace-write')).toMatchObject({ amber: false, label: '按规则放行', icon: 'list-checks' })
    // The model reviewing requests itself is said so, not as asking the person, and is not amber.
    expect(view('agent')).toMatchObject({ amber: false, label: '由模型判断', icon: 'scale', line: modeTiers.agent.line })
    expect(view('agent-full-access')).toMatchObject({ amber: true, label: '不再询问', icon: 'shield-alert' })
    // Whose setting it is, with its mark; that Latch does not isolate it stays findable behind the ⓘ.
    expect(view('read-only').note?.detail).toContain('也不隔离它')
  })

  it('shows at most three main rows, the rest under 更多, and never hides the current one', () => {
    const rows = (current: string) => view(current).rows!.map(row => [row.value, row.more])
    expect(rows('read-only')).toEqual([
      ['read-only', false],
      ['workspace-write', true],
      ['agent', false],
      ['agent-full-access', false],
    ])
    // A mode Latch has no word for is left out, unless the agent is in it, where it keeps the agent's own name.
    expect(rows('workspace-write')).toContainEqual(['workspace-write', false])
    expect(view('permission-profile:x')).toMatchObject({ label: 'Profile X', amber: false })
    expect(rows('permission-profile:x').at(-1)).toEqual(['permission-profile:x', false])
    // Three rows or fewer need no 更多.
    const two = { ...modes, currentValue: 'read-only', options: modes.options.slice(0, 2) }
    expect(permissionView({ harness, permission, config: [two], access: local })!.rows!.every(row => !row.more)).toBe(true)
  })

  it("keeps an unknown Harness's own names and lines, all of them main rows", () => {
    const { modeTiers: _tiers, ...plain } = permission
    const own = permissionView({ harness, permission: plain, config: [{ ...modes, currentValue: 'agent' }], access: local })!
    expect(own).toMatchObject({ label: 'Auto review', amber: false, line: 'Only ask for actions detected as potentially unsafe' })
    expect(own.rows!.every(row => !row.more && row.tier === undefined)).toBe(true)
  })

  it('makes the widest and the unconfirmable case the visible ones', () => {
    const decides = permissionView({ harness, permission: { ...permission, approvals: 'none' }, config: [], access: local })
    // An extension's confirmation still reaches the person, so the line does not say it never asks.
    expect(decides).toMatchObject({
      amber: true,
      label: '不询问 · 由 Fake Agent 决定',
      line: 'Fake Agent 执行工具前不询问，只有扩展要求确认时才问你；Latch 不限制它',
    })
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
    expect(draft({ approvals: 'prompts', readback: 'mode' })?.note?.label).toBe('发第一条消息后可以换')
    expect(draft({ approvals: 'none', readback: 'none' })).toMatchObject({ label: '不询问 · 由 Fake Agent 决定', amber: true })
    expect(draft({ approvals: 'prompts', readback: 'none' })).toMatchObject({ label: '权限无法确认', amber: true })
    expect(draft()).toMatchObject({ label: '开始后可以选', amber: false })
  })

  it("gives a draft's 先问你 the line Latch knows for that mode, the same one a session shows", () => {
    const codex = {
      ...harness,
      permission: {
        approvals: 'prompts' as const,
        readback: 'mode' as const,
        modeTiers: {
          'read-only': { tier: 'ask' as const, line: '只读；改文件或联网前先问你' },
          'workspace-write': { tier: 'rule' as const, line: '项目里直接改和运行；越界或联网前问你' },
        },
      },
    }
    expect(draftPermission(codex, 'agent')).toMatchObject({ label: '先问你', line: '只读；改文件或联网前先问你', amber: false })
    // Without a word for its modes, the general line stays.
    expect(draftPermission({ ...codex, permission: { approvals: 'prompts', readback: 'mode' } }, 'agent')?.line).toBe(
      'Fake Agent 改文件或运行命令前问你',
    )
  })

  it("says when a declared Harness's modes can be changed, from whether its read reports them", () => {
    const declared = { approvals: 'prompts' as const, readback: 'mode' as const }
    const run = { scopes: new Set(['view', 'run'] as const) }
    const reads = { ...harness, permission: declared, catalogueRead: { when: 'select' as const, modes: true } }
    const note = (target: Parameters<typeof draftPermission>[0], read?: 'reading' | 'readable') =>
      draftPermission(target, 'agent', undefined, read)?.note
    const later = { label: '发第一条消息后可以换', detail: 'Fake Agent 开始会话时才给出其他几项。' }
    // Its read opens a session, which reports the modes: the menu reads it, and the rows come once it is read.
    expect(readsOnPermission(reads, run)).toBe(true)
    expect(note(reads, 'reading')).toEqual({ label: '正在读取 Fake Agent 的权限…' })
    expect(note(reads, 'readable')).toEqual({ label: '读取 Fake Agent 的权限后可以换' })
    expect(note({ ...reads, catalogueRead: { ...reads.catalogueRead, last: { at: 'x', ok: false } } }, 'readable')).toEqual({
      label: '没有读到 Fake Agent 的权限',
      detail: '发第一条消息后可以换。',
    })
    // Its read lists models only, as Codex's own model list does: the modes come with the session.
    const models = { ...reads, catalogueRead: { when: 'select' as const, modes: false } }
    expect(readsOnPermission(models, run)).toBe(false)
    for (const read of ['reading', 'readable', undefined] as const) expect(note(models, read)).toEqual(later)
    expect(note({ ...reads, catalogueRead: undefined }, undefined)).toEqual(later)
    // What it reported had no modes: nothing to change to, so no promise of it.
    const none = { options: [], perModel: [], reportedAt: 'x' }
    expect(note({ ...reads, catalogue: { ...none, source: 'check' } })).toBeUndefined()
    expect(note({ ...models, catalogue: { ...none, source: 'session' } })).toBeUndefined()
    expect(note({ ...models, catalogue: { ...none, source: 'check' } })).toEqual(later)
  })

  it('says an undeclared Harness that can be read tells its modes when read, not only once started', () => {
    const readable = { ...harness, catalogueRead: { when: 'select' as const, modes: true } }
    const run = { scopes: new Set(['view', 'run'] as const) }
    expect(draftRead(readable, run, false)).toBe('readable')
    expect(draftRead(readable, run, true)).toBe('reading')
    expect(draftRead({ ...readable, catalogueRead: { when: 'select', modes: true, last: { at: 'x', ok: false } } }, run, false)).toBe(
      'readable',
    )
    // Nothing to read with: no read, a list already there, a device that cannot start one, or a Harness that cannot start.
    expect(draftRead(harness, run, false)).toBeUndefined()
    expect(
      draftRead({ ...readable, catalogue: { options: [], perModel: [], reportedAt: 'x', source: 'check' } }, run, false),
    ).toBeUndefined()
    expect(draftRead(readable, { scopes: new Set(['view'] as const) }, false)).toBeUndefined()
    expect(draftRead({ ...readable, status: 'unavailable' }, run, false)).toBeUndefined()
    // Another device's read is still a read under way.
    expect(draftRead(harness, { scopes: new Set(['view'] as const) }, true)).toBe('reading')

    const before = draftPermission(readable, 'agent', undefined, 'readable')
    expect(before).toMatchObject({ label: '读取后可以选', amber: false })
    expect(before?.line).toBe('Fake Agent 读取或开始时告诉 Latch 它有哪几项权限')
    expect(draftPermission(readable, 'agent', undefined, 'reading')).toMatchObject({
      label: '正在读取…',
      line: '正在读取 Fake Agent 的权限…',
      amber: false,
    })
    // Without a read the agent tells only once started.
    expect(draftPermission(harness, 'agent')?.line).toBe('Fake Agent 开始后才告诉 Latch 它有哪几项权限')
    // What a Harness declares, and a chat, need no read.
    expect(
      draftPermission({ ...readable, permission: { approvals: 'none', readback: 'none' } }, 'agent', undefined, 'reading'),
    ).toMatchObject({
      label: '不询问 · 由 Fake Agent 决定',
    })
    expect(draftPermission(readable, 'chat', undefined, 'reading')).toMatchObject({ label: '不读写文件' })
    // Opening 权限 reads only where the read is what tells Latch the modes.
    expect(readsOnPermission(readable, run)).toBe(true)
    expect(readsOnPermission({ ...readable, catalogueRead: { when: 'request', modes: true } }, run)).toBe(false)
    expect(readsOnPermission(readable, { scopes: new Set(['view'] as const) })).toBe(false)
  })

  it('offers every row, the model and never-asking ones too, on another device without a confirmation', () => {
    const rows = view('workspace-write', { legacy: false, local: false }).rows!
    expect(rows.map(row => [row.tier, row.disabledReason])).toEqual([
      ['ask', undefined],
      ['rule', undefined],
      ['model', undefined],
      ['never', undefined],
    ])
  })
})

describe('the context words of the title row', () => {
  it('say the share only when the engine reported both numbers', () => {
    expect(contextWords(undefined)).toBeUndefined()
    expect(contextWords({ contextUsed: 100 })).toBeUndefined()
    expect(contextWords({ contextUsed: 100_000, contextSize: 400_000 })?.percent).toBe(25)
    expect(contextWords({ contextUsed: 248_000, contextSize: 400_000 })).toEqual({ percent: 62, words: '上下文已用 62% · 248K / 400K' })
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

describe('what a Harness has not reported', () => {
  const option = (category: string) => ({
    id: category,
    name: category,
    category,
    type: 'select' as const,
    currentValue: 'a',
    options: [{ value: 'a', name: 'A' }],
  })
  it('gives each control one sentence on its own fact', () => {
    expect(unreportedModelNote('pi', false, [])).toBe('pi 开始后才报告可选的模型，发第一条消息后可以在这里换。')
    expect(unreportedThinkingNote('pi', false, [])).toBe('pi 开始后才报告有哪些思考，发第一条消息后可以在这里换。')
    expect(unreportedModelNote('pi', true, [])).toBe('pi 没有报告可选的模型，由它自己决定。')
    expect(unreportedThinkingNote('pi', true, [])).toBe('pi 没有报告思考，用它自己的默认值。')
    expect(unreportedModelNote('pi', true, [option('model')])).toBeUndefined()
    expect(unreportedThinkingNote('pi', true, [option('model')])).toBe('pi 没有报告思考，用它自己的默认值。')
    expect(unreportedModelNote('pi', true, [option('thought_level')])).toBe('pi 没有报告可选的模型，由它自己决定。')
    expect(unreportedThinkingNote('pi', true, [option('thought_level')])).toBeUndefined()
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
    permission: {
      approvals: 'prompts',
      readback: 'mode',
      modeTiers: {
        read: { tier: 'ask', line: '只读；改文件前问你' },
        write: { tier: 'rule', line: '项目里不问你' },
        full: { tier: 'never', line: '直接运行' },
      },
    },
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

  it('starts with only what was picked and is still offered', () => {
    expect(startConfig(listed, { model: 'large', effort: 'max', mode: 'write', other: 'x' })).toEqual([
      { configId: 'model', value: 'large' },
      { configId: 'effort', value: 'max' },
      { configId: 'mode', value: 'write' },
    ])
    expect(startConfig(listed, { model: 'small', effort: 'max' })).toEqual([{ configId: 'model', value: 'small' }])
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

  it('lists the modes as a session does, in Latch words, the picked one current and the never-asking one amber', () => {
    const view = draftPermission(listed, 'agent', draftConfig(listed, { mode: 'full' })!.config)!
    expect(view.rows?.map(row => [row.value, row.name, row.line, row.current, row.neverAsks])).toEqual([
      ['read', '先问你', '只读；改文件前问你', false, false],
      ['write', '按规则放行', '项目里不问你', false, false],
      ['full', '不再询问', '直接运行', true, true],
    ])
    expect(view).toMatchObject({ amber: true, label: '不再询问', line: '直接运行', icon: 'shield-alert' })
    // Nothing picked: the mode a session starts in, never a wider one.
    expect(draftPermission(listed, 'agent', draftConfig(listed, undefined)!.config)!.label).toBe('先问你')
    // Without a list: what the Harness declares, and that it can be changed after the start.
    expect(draftPermission(testHarness('codex', { permission: { approvals: 'prompts', readback: 'mode' } }), 'agent')?.note?.label).toBe(
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

  it("keeps each Harness's picks, the mode too, for when it is chosen again", () => {
    const built: HostCatalog = { ...catalog, harnesses: [listed, testHarness('pi')], defaults: { ...catalog.defaults, harnessId: 'codex' } }
    const codex = resolveChoice(built, { harnessId: 'codex', config: { mode: 'full', model: 'large' } })
    const away = harnessPicks(codex, 'pi')
    expect(away).toEqual({ config: undefined, otherPicks: { codex: { mode: 'full', model: 'large' } } })
    const onPi = resolveChoice(built, { ...codex, harnessId: 'pi', ...away })
    expect(onPi).toMatchObject({ harnessId: 'pi', otherPicks: { codex: { mode: 'full' } } })
    expect(onPi.config).toBeUndefined()
    // Back on Codex: the person's own wider pick is the start again, and nothing else is chosen for them.
    const back = resolveChoice(built, { ...onPi, harnessId: 'codex', ...harnessPicks(onPi, 'codex') })
    expect(back.config).toEqual({ mode: 'full', model: 'large' })
    expect(back.otherPicks).toBeUndefined()
    // A remembered Harness that cannot start now keeps its picks.
    const gone: HostCatalog = { ...built, harnesses: [testHarness('pi')], defaults: { ...built.defaults, harnessId: 'pi' } }
    expect(resolveChoice(gone, { harnessId: 'codex', config: { mode: 'write' } })).toMatchObject({
      harnessId: 'pi',
      otherPicks: { codex: { mode: 'write' } },
    })
    // A fork onto another Harness takes that Harness's own picks, never those of the one remembered.
    expect(
      forkedChoice(built, { harnessId: 'pi', config: { mode: 'x' }, otherPicks: { codex: { mode: 'write' } } }, { harnessId: 'codex' })
        .choice.config,
    ).toEqual({
      mode: 'write',
    })
  })

  it('draws the draft from the list, says where it came from, and not that it is known only after the start', () => {
    const draft = {
      catalog: { ...catalog, harnesses: [listed] },
      choice: { mode: 'agent' as const, harnessId: 'codex', config: { model: 'large' } },
      onChoice() {},
      access: { local: true, legacy: false, admin: true, scopes: new Set(['view', 'run'] as const) },
      disabled: false,
    }
    const markup = renderToStaticMarkup(createElement(DraftModelControl, draft))
    expect(named(markup, '模型')).toBe('LARGE')
    expect(markup).not.toContain('开始后才报告')
    // Large's own levels, as the list says, in the thinking control.
    const thinking = renderToStaticMarkup(createElement(DraftThinkingControl, draft))
    expect(named(thinking, '思考')).toBe('LOW')
    for (const level of ['LOW', 'HIGH', 'MAX']) expect(thinking).toContain(level)
    expect(thinking).not.toContain('开始后才报告')
    // A model no session ran on: its levels are not known yet, so 默认 and why.
    const huge = renderToStaticMarkup(
      createElement(DraftThinkingControl, { ...draft, choice: { ...draft.choice, config: { model: 'huge' } } }),
    )
    expect(named(huge, '思考')).toBe('默认')
    expect(huge).toContain('这个模型有哪些思考，Codex 开始后才告诉 Latch。')
    // Nothing read yet: each control says it comes with the start.
    const unread = {
      ...draft,
      catalog: { ...catalog, harnesses: [testHarness('pi')] },
      choice: { mode: 'agent' as const, harnessId: 'pi' },
    }
    expect(renderToStaticMarkup(createElement(DraftModelControl, unread))).toContain('pi 开始后才报告可选的模型')
    expect(renderToStaticMarkup(createElement(DraftThinkingControl, unread))).toContain('pi 开始后才报告有哪些思考')
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

  const thinking = (model: ModelRef | undefined, current: ModelRef | undefined, locked?: string) =>
    renderToStaticMarkup(
      createElement(SessionThinkingControl, {
        ...props(),
        catalog: declared,
        harness: builtin,
        model,
        current,
        config: [],
        ...(locked ? { locked } : {}),
      }),
    )

  it('writes the model alone on its control and the level on 思考, each switch as the next message', () => {
    const current = { providerId: 'lab', model: 'alpha', effort: 'high' }
    expect(named(session(current, current), '模型')).toBe('alpha')
    expect(named(thinking(current, current), '思考')).toBe('高')
    // The declared levels in the menu, 默认 first, in Latch's words.
    for (const level of ['默认', '低', '中', '高']) expect(thinking(current, current)).toContain(`>${level}<`)
    // A level switch is the thinking's; the model control stays as it is.
    expect(named(session({ providerId: 'lab', model: 'alpha' }, current), '模型')).toBe('alpha')
    expect(named(thinking({ providerId: 'lab', model: 'alpha' }, current), '思考')).toBe('下一条：默认')
    expect(named(thinking({ providerId: 'lab', model: 'alpha', effort: 'low' }, current), '思考')).toBe('下一条：低')
    expect(thinking({ providerId: 'lab', model: 'alpha', effort: 'low' }, current)).toContain('撤销切换，继续使用 alpha · 高')
    expect(named(session({ providerId: 'lab', model: 'beta' }, current), '模型')).toBe('下一条：beta')
    expect(session(current, current)).not.toContain('思考')
  })

  it('opens with the one row 默认 and why when the model declares no levels, and says a level taken away', () => {
    const gamma = { providerId: 'lab', model: 'gamma' }
    const none = thinking(gamma, gamma)
    expect(named(none, '思考')).toBe('默认')
    // Still a button that opens, without the arrow.
    expect(none).toMatch(/<button[^>]*class="ui-value-picker thinking-picker is-fixed"[^>]*aria-haspopup="menu"/u)
    expect(none).toContain('这个模型没有设置思考，用它自己的默认值。可以在 设置 › 模型 里为它选择。')
    const gone = { providerId: 'lab', model: 'alpha', effort: 'max' }
    expect(named(thinking(gone, gone), '思考')).toBe('最高')
    expect(thinking(gone, gone)).toContain('这个模型不再设置「最高」，重新选一个后再发送。')
    expect(thinking(gone, gone, '这台设备不能发送消息')).toContain('aria-disabled="true"')
  })

  it('drops a remembered level the owner has since taken away, and keeps one still declared', () => {
    const stored = (effort: string) => ({ harnessId: builtin.id, model: { providerId: 'lab', model: 'alpha', effort } })
    expect(resolveChoice(declared, stored('high')).model).toEqual({ providerId: 'lab', model: 'alpha', effort: 'high' })
    expect(resolveChoice(declared, stored('max')).model).toEqual({ providerId: 'lab', model: 'alpha' })
  })
})

describe('the services a draft offers through Latch', () => {
  const relay = {
    id: 'relay',
    name: 'Relay',
    kind: 'openai-responses' as const,
    models: ['GPT-5-2025-08-07', 'deepseek-v3'],
    defaultModel: 'deepseek-v3',
  }
  const codex = (knownOnly: boolean, read = true): HarnessInfo => {
    const info = testHarness('codex', { label: 'Codex' })
    info.capabilities.models = { ...info.capabilities.models, wires: ['responses'], ...(knownOnly ? { knownOnly: true as const } : {}) }
    if (read)
      info.catalogue = {
        options: [{ ...model, currentValue: 'gpt-5', options: [{ value: 'gpt-5', name: 'GPT-5' }] }],
        perModel: [],
        reportedAt: '2026-11-07T00:00:00.000Z',
        source: 'session',
      }
    // A model typed for it is its own login's, not one it knows.
    info.customModels = ['deepseek-v3']
    return info
  }
  const options = (info: HarnessInfo) =>
    ownModelGroups({ ...catalog, harnesses: [info], providers: [relay] }, info, []).find(group => group.id === '~service-relay')?.options

  it('offers of a service only the models a Harness that uses no others knows, as its own list names them', () => {
    expect(options(codex(true))).toEqual([
      expect.not.objectContaining({ disabledReason: expect.anything() }),
      expect.objectContaining({
        value: serviceValue({ providerId: 'relay', model: 'deepseek-v3' }),
        disabledReason: 'Codex 不认识这个模型',
      }),
    ])
    // Its own list not read yet, or a Harness that takes any model: every model of the service.
    for (const list of [options(codex(true, false)), options(codex(false))])
      expect(list?.map(option => option.disabledReason)).toEqual([undefined, undefined])
  })
})

describe('the service a session started on through Latch', () => {
  const openai = { id: 'openai', name: 'OpenAI', kind: 'openai-responses' as const, models: ['gpt-5'], defaultModel: 'gpt-5' }
  const info = testHarness('codex', { label: 'Codex' })
  const own = [{ value: 'gpt-5', label: 'gpt-5' }]
  const route = { providerId: 'openai', model: 'gpt-5', name: 'OpenAI' }
  const header = (on: HostCatalog, at: typeof route & { off?: true }) => ownModelGroups(on, info, own, { route: at })[0]!

  it('names the service and where requests go while the catalog offers it', () => {
    const on = { ...catalog, harnesses: [info], providers: [openai] }
    expect(header(on, route)).toMatchObject({ label: 'OpenAI · 经 Latch', options: [{ value: 'gpt-5' }] })
    expect(header(on, route).options[0]).not.toHaveProperty('disabledReason')
    expect(routeService(on, route)).toEqual({ name: 'OpenAI' })
  })

  it('says by name that the next turn fails once the service is turned off, never its ID or that it goes through Latch', () => {
    const off = { ...catalog, harnesses: [info], providers: [] }
    const stopped = { ...route, off: true as const }
    expect(header(off, stopped)).toMatchObject({ label: 'OpenAI · 已停用', options: [{ disabledReason: '下一轮会失败：服务已停用' }] })
    expect(routeService(off, stopped).unusable?.note).toBe(
      '这个会话开始时用的「OpenAI」已停用，下一轮会失败。在设置 › 模型里重新打开它，或新开一个会话。',
    )
    // Held back for a missing key, it says that instead; deleted, there is no name left to give.
    const keyless = { ...off, unusableProviders: [{ id: 'openai', name: 'OpenAI', reason: 'key-missing' as const }] }
    expect(routeService(keyless, route).unusable?.note).toBe(
      '这个会话开始时用的「OpenAI」没有密钥，下一轮会失败。在设置 › 模型里添加密钥，或新开一个会话。',
    )
    const { name: _name, ...deleted } = route
    expect(header(off, deleted as typeof route).label).toBe('模型服务 · 已经删除')
    for (const at of [stopped, route]) expect(JSON.stringify(header(off, at))).not.toContain('openai ·')
  })
})
