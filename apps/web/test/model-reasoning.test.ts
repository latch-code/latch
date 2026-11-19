import { createElement } from 'react'
import { testHarness } from '@latch/testkit'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LADDER_MODE, type HarnessInfo, type HostCatalog, type ModelRef, type SessionConfigOption } from '@latch/protocol'
import { readsOnPermission } from '../src/composer/harnessCatalogue.tsx'
import { ownModelGroups, routeService, serviceValue } from '../src/composer/ModelControl.tsx'
import { DraftModelControl, DraftThinkingControl, SessionModelControl, SessionThinkingControl } from '../src/composer/ModelPanel.tsx'
import {
  draftConfig,
  harnessPicks,
  resolveChoice,
  sameModel,
  startConfig,
  switchModel,
  thinkingLevels,
  withLadderMode,
} from '../src/composerChoice.ts'
import { forkedChoice } from '../src/forkChoice.ts'
import { draftPermission, draftRead, permissionTip, permissionView } from '../src/composer/permission.ts'
import {
  agentConfigChoice,
  agentConfigValues,
  agentModelControls,
  calmWrite,
  composerOptions,
  modelWords,
  thinkingWord,
  unreportedModelNote,
  unreportedThinkingNote,
  withPicked,
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
/** The chip itself, without the panel it opens. */
const trigger = (markup: string) => markup.match(/<button[^>]*class="ui-value-picker[^>]*>/u)?.[0] ?? ''
/** The panel's 思考 column, which the 模型 and 思考 chips both open. */
const levelsColumn = (markup: string) => markup.slice(Math.max(0, markup.indexOf('class="ui-board-levels"')))
const levelNames = (markup: string) =>
  [...levelsColumn(markup).matchAll(/class="ui-menu-item ui-board-level"[^>]*aria-label="([^"]*)"/gu)].map(match => match[1])

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

  it('lets an explicit launch-setting reselect replace a draft but still respects an unknown write', () => {
    const launch = { ...reasoning, source: 'launch' as const }
    expect(agentConfigChoice([launch], launch.id, launch.currentValue, { busy: null })).toEqual({
      configId: launch.id,
      value: launch.currentValue,
    })
    expect(agentConfigChoice([launch], launch.id, 'not-listed', { busy: null })).toBeUndefined()
    expect(
      agentConfigChoice([launch], launch.id, launch.currentValue, {
        busy: null,
        feedback: { kind: 'unknown', message: 'unknown' },
      }),
    ).toBeUndefined()
  })

  it('does not invent a level for a model-only or uncategorized list: 思考 is 默认 and says why', () => {
    const modelOnly = { ...props(), config: [model] }
    expect(named(html(modelOnly), '模型')).toBe('First model')
    expect(html(modelOnly)).not.toContain('role="slider"')
    expect(named(thinkingHtml(modelOnly), '思考')).toBe('默认')
    expect(thinkingHtml(modelOnly)).toContain('用 Fake Agent 的默认值')
    // Nothing reported: each control names its own fact and says the Harness decides.
    const silent = { ...props(), config: [] }
    expect(named(html(silent), '模型')).toBe('默认模型')
    expect(html(silent)).toContain('由 Fake Agent 决定')
    expect(levelNames(html(silent))).toEqual(['默认'])
    expect(named(thinkingHtml(silent), '思考')).toBe('默认')
  })

  it('opens one panel from both chips: each writes only its value, and every choice stays reachable', () => {
    const rendered = html(props())
    expect(named(rendered, '模型')).toBe('First model')
    expect(rendered).toContain('上下文窗口')
    expect(rendered).not.toContain('Agent description')
    expect(levelNames(rendered)).toEqual(['由模型决定', '均衡', '更详细'])
    const thinking = thinkingHtml(props())
    expect(levelNames(thinking)).toEqual(levelNames(rendered))
    expect(thinking).toContain('model-board is-thinking')
    expect(named(thinking, '思考')).toBe('均衡')
    // The Harness's own names, each a row of the menu, the current one checked.
    for (const level of ['由模型决定', '均衡', '更详细']) expect(thinking).toContain(level)
    expect(thinking).toContain('aria-checked="true"')
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
      expect(markup).toContain('核对')
      expect(markup).toContain('保持原请求，结果未知')
      expect(markup).toContain('aria-disabled="true"')
    }
    // A write in flight turns the control it belongs to, not the other one.
    expect(trigger(thinkingHtml({ ...props(), busy: reasoning.id }))).toContain('aria-busy="true"')
    expect(thinkingHtml({ ...props(), busy: reasoning.id })).toContain('正在切换…')
    expect(trigger(html({ ...props(), busy: reasoning.id }))).not.toContain('aria-busy="true"')
    expect(trigger(html({ ...props(), busy: model.id }))).toContain('aria-busy="true"')
    expect(trigger(thinkingHtml({ ...props(), busy: model.id }))).not.toContain('aria-busy="true"')
    // The panel's levels wait on either write.
    expect(levelsColumn(html({ ...props(), busy: model.id }))).toContain('aria-busy="true"')
  })

  it("draws the panel's own pick at once and shows nothing of a write that answers quickly", () => {
    const config = [model, reasoning, context]
    // The pick stands in for the reported value only while its own write is under way, and only for a value offered.
    expect(withPicked(config, { configId: model.id, value: 'two' }, model.id).find(item => item.id === model.id)?.currentValue).toBe('two')
    expect(withPicked(config, { configId: model.id, value: 'two' }, null)).toBe(config)
    expect(withPicked(config, { configId: model.id, value: 'two' }, reasoning.id)).toBe(config)
    // A move to another source is no value the option offers: the session switches, and says so.
    expect(withPicked(config, { configId: model.id, value: 'service:p\u0000m' }, model.id)).toEqual(config)
    // Quiet: its own pick, not yet slow, nothing unknown or locked. Any other write is drawn.
    expect(calmWrite({ busy: model.id }, true, false)).toBe(true)
    expect(calmWrite({ busy: model.id }, true, true)).toBe(false)
    expect(calmWrite({ busy: model.id }, false, false)).toBe(false)
    expect(calmWrite({ busy: model.id, disabled: true }, true, false)).toBe(false)
    expect(calmWrite({ busy: null }, true, false)).toBe(false)
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
    // Whose setting it is, with its mark; that Latch does not isolate it stays findable on the chip's tooltip.
    expect(view('read-only').note?.detail).toContain('也不隔离它')
  })

  it('lists every row, in tier order, with unclassified native modes last and unranked', () => {
    const rows = (current: string) => view(current).rows!.map(row => row.value)
    expect(rows('read-only')).toEqual(['read-only', 'workspace-write', 'agent', 'agent-full-access', 'permission-profile:x'])
    expect(rows('permission-profile:x')).toEqual(rows('read-only'))
    const own = view('read-only').rows!.find(row => row.value === 'permission-profile:x')!
    // Its own glyph, a plain shape: the shield is the tier's, and two segments never look alike.
    expect(own).toMatchObject({ name: 'Profile X', icon: 'circle' })
    expect(own.tier).toBeUndefined()
    expect(view('permission-profile:x')).toMatchObject({ label: 'Profile X', amber: false })
  })

  it("puts the current row's line and whose setting it is in the chip's tooltip, not in the menu", () => {
    const tip = permissionTip(view('read-only'))!
    expect(tip).toContain(modeTiers['read-only'].line)
    expect(tip).toContain('也不隔离它')
    expect(permissionTip({ label: '先问你', line: '', icon: 'shield', amber: false })).toBeUndefined()
  })

  it("keeps an unknown Harness's own names and lines, all of them main rows", () => {
    const { modeTiers: _tiers, ...plain } = permission
    const own = permissionView({ harness, permission: plain, config: [{ ...modes, currentValue: 'agent' }], access: local })!
    expect(own).toMatchObject({ label: 'Auto review', amber: false, line: 'Only ask for actions detected as potentially unsafe' })
    expect(own.rows!.every(row => row.tier === undefined)).toBe(true)
  })

  it('makes the widest and the unconfirmable case the visible ones', () => {
    const decides = permissionView({ harness, permission: { ...permission, approvals: 'none' }, config: [], access: local })
    // An extension's confirmation still reaches the person, so the line does not say it never asks.
    expect(decides).toMatchObject({
      amber: true,
      label: '不询问 · 由 Fake Agent 决定',
      line: '只有扩展要求确认时才问你',
    })
    // Who decides stays under the rows once it runs, with that Latch does not limit it one press away.
    expect(decides?.note).toMatchObject({ label: 'Fake Agent 自己决定', detail: 'Latch 不限制它，也不隔离它。' })
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
    expect(draft({ approvals: 'prompts', readback: 'mode' })?.note).toBeUndefined()
    expect(draft({ approvals: 'none', readback: 'none' })).toMatchObject({ label: '不询问 · 由 Fake Agent 决定', amber: true })
    expect(draft({ approvals: 'prompts', readback: 'none' })).toMatchObject({ label: '权限无法确认', amber: true })
    expect(draft()).toMatchObject({ label: '默认', amber: false })
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
      '改文件或运行命令前问你',
    )
  })

  it("says only that a declared Harness's modes are being read or could not be, never when they can be changed", () => {
    const declared = { approvals: 'prompts' as const, readback: 'mode' as const }
    const run = { scopes: new Set(['view', 'run'] as const) }
    const reads = { ...harness, permission: declared, catalogueRead: { when: 'select' as const, modes: true } }
    const note = (target: Parameters<typeof draftPermission>[0], read?: 'reading' | 'readable') =>
      draftPermission(target, 'agent', undefined, read)?.note
    // Its read opens a session, which reports the modes: the menu reads it, and the rows come once it is read.
    expect(readsOnPermission(reads, run)).toBe(true)
    expect(note(reads, 'reading')).toEqual({ label: '正在读取 Fake Agent 的权限…' })
    expect(note(reads, 'readable')).toBeUndefined()
    expect(note({ ...reads, catalogueRead: { ...reads.catalogueRead, last: { at: 'x', ok: false } } }, 'readable')).toEqual({
      label: '没有读到 Fake Agent 的权限',
    })
    // Its read lists models only, as Codex's own model list does: the modes come with the session.
    const models = { ...reads, catalogueRead: { when: 'select' as const, modes: false } }
    expect(readsOnPermission(models, run)).toBe(false)
    for (const read of ['reading', 'readable', undefined] as const) expect(note(models, read)).toBeUndefined()
    expect(note({ ...reads, catalogueRead: undefined }, undefined)).toBeUndefined()
    // What it reported had no modes: nothing to change to, so no promise of it.
    const none = { options: [], perModel: [], reportedAt: 'x' }
    expect(note({ ...reads, catalogue: { ...none, source: 'check' } })).toBeUndefined()
    expect(note({ ...models, catalogue: { ...none, source: 'session' } })).toBeUndefined()
    expect(note({ ...models, catalogue: { ...none, source: 'check' } })).toBeUndefined()
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
    expect(before).toMatchObject({ label: '默认', amber: false })
    // The title says when the rows come; no line repeats it.
    expect(before?.line).toBe('')
    expect(draftPermission(readable, 'agent', undefined, 'reading')).toMatchObject({ label: '正在读取…', line: '', amber: false })
    // Without a read the agent tells only once started.
    expect(draftPermission(harness, 'agent')).toMatchObject({ label: '默认', line: '' })
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
      [undefined, undefined],
    ])
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
  it('gives each control a few words on its own fact', () => {
    // Before a start nothing is said: the control shows what will be used.
    expect(unreportedModelNote('pi', false, [])).toBeUndefined()
    expect(unreportedThinkingNote('pi', false, [])).toBeUndefined()
    expect(unreportedModelNote('pi', true, [])).toBe('由 pi 决定')
    expect(unreportedThinkingNote('pi', true, [])).toBe('用 pi 的默认值')
    expect(unreportedModelNote('pi', true, [option('model')])).toBeUndefined()
    expect(unreportedThinkingNote('pi', true, [option('model')])).toBe('用 pi 的默认值')
    expect(unreportedModelNote('pi', true, [option('thought_level')])).toBe('由 pi 决定')
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
    // Without a list: what the Harness declares, and no promise about later.
    expect(draftPermission(testHarness('codex', { permission: { approvals: 'prompts', readback: 'mode' } }), 'agent')?.note).toBeUndefined()
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
    expect(markup).not.toContain('发第一条消息后可以换')
    // Large's own levels, as the list says, in the thinking control.
    const thinking = renderToStaticMarkup(createElement(DraftThinkingControl, draft))
    expect(named(thinking, '思考')).toBe('LOW')
    for (const level of ['LOW', 'HIGH', 'MAX']) expect(thinking).toContain(level)
    expect(thinking).not.toContain('发第一条消息后可以换')
    // A model no session ran on: its levels are not known yet, so 默认, and no sentence about the start.
    const huge = renderToStaticMarkup(
      createElement(DraftThinkingControl, { ...draft, choice: { ...draft.choice, config: { model: 'huge' } } }),
    )
    expect(named(huge, '思考')).toBe('默认')
    expect(huge).not.toContain('开始后')
    // Nothing read yet: each control shows what will be used, and nothing more.
    const unread = {
      ...draft,
      catalog: { ...catalog, harnesses: [testHarness('pi')] },
      choice: { mode: 'agent' as const, harnessId: 'pi' },
    }
    for (const control of [DraftModelControl, DraftThinkingControl]) {
      const markup = renderToStaticMarkup(createElement(control, unread))
      for (const words of ['发第一条消息后可以换', '开始后', '读取后可以选']) expect(markup).not.toContain(words)
    }
    expect(named(renderToStaticMarkup(createElement(DraftThinkingControl, unread)), '思考')).toBe('默认')
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
    // The model chip opens the same panel, with the model's levels beside its list.
    expect(levelNames(session(current, current))).toEqual(['默认', '低', '中', '高'])
  })

  it('opens with the one row 默认 and why when the model declares no levels, and says a level taken away', () => {
    const gamma = { providerId: 'lab', model: 'gamma' }
    const none = thinking(gamma, gamma)
    expect(named(none, '思考')).toBe('默认')
    // Still a button that opens, without the arrow.
    expect(none).toMatch(/<button[^>]*class="ui-value-picker thinking-picker is-fixed"[^>]*aria-haspopup="menu"/u)
    // A short label; where to set it is its tooltip.
    expect(none).toContain('用模型默认值')
    expect(none).toMatch(/用模型默认值<\/span><span[^>]*role="tooltip"/u)
    expect(none).not.toContain('aria-label="说明"')
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

describe('thinking on a service model before the session starts', () => {
  const relay = {
    id: 'relay',
    name: 'Relay',
    kind: 'openai-responses' as const,
    models: ['deepseek-flash', 'plain'],
    defaultModel: 'deepseek-flash',
    modelCapabilities: { 'deepseek-flash': { thinking: ['low', 'high'] } },
  }
  // What the Host projects for Codex's own wire: the option the session will offer, with the same ID and values.
  const projected: SessionConfigOption = {
    id: 'reasoning_effort',
    name: '思考',
    category: 'thought_level',
    currentValue: '~default',
    options: [
      { value: '~default', name: '默认' },
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  }
  const codex = (serviceOptions?: HarnessInfo['serviceOptions'], serviceThinking = true): HarnessInfo => {
    const info = testHarness('codex', { label: 'Codex' })
    info.capabilities.models = {
      ...info.capabilities.models,
      wires: ['responses'],
      ...(serviceThinking ? { serviceThinking: true as const } : {}),
    }
    info.catalogue = {
      options: [
        { ...model, id: 'model', currentValue: 'gpt-5', options: [{ value: 'gpt-5', name: 'GPT-5' }] },
        { ...reasoning, id: 'reasoning_effort', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }] },
      ],
      perModel: [],
      reportedAt: '2026-11-07T00:00:00.000Z',
      source: 'session',
    }
    if (serviceOptions) info.serviceOptions = serviceOptions
    return info
  }
  const draftOf = (info: HarnessInfo, service: string, extra: Record<string, string> = {}) => ({
    catalog: { ...catalog, harnesses: [info], providers: [relay] },
    choice: { mode: 'agent' as const, harnessId: 'codex', config: { '~service': `relay\u0000${service}`, ...extra } },
    onChoice() {},
    access: { local: true, legacy: false, admin: true, scopes: new Set(['view', 'run'] as const) },
    disabled: false,
  })
  const declared = [{ providerId: 'relay', model: 'deepseek-flash', options: [projected], source: 'declared' as const }]

  it('lists 默认 and the levels the service declared, never the Harness’s own thinking', () => {
    const draft = draftOf(codex(declared), 'deepseek-flash')
    const thinking = renderToStaticMarkup(createElement(DraftThinkingControl, draft))
    expect(named(thinking, '思考')).toBe('默认')
    for (const level of ['Low', 'High']) expect(thinking).toContain(level)
    expect(thinking).not.toContain('Medium')
    expect(thinking).not.toContain('开始后')
    const known = draftConfig(draft.catalog.harnesses[0], draft.choice.config)!
    expect(known.config.filter(option => option.category === 'thought_level')).toEqual([projected])
    expect(known.thinkingUnknown).toBe(false)
  })

  it('carries the level picked before the start, and only one the pair offers', () => {
    const info = codex(declared)
    expect(startConfig(info, { '~service': 'relay\u0000deepseek-flash', reasoning_effort: 'high' })).toEqual([
      { configId: 'reasoning_effort', value: 'high' },
    ])
    // A level the service did not declare, or a model it declared none for, carries nothing: the session's default.
    expect(startConfig(info, { '~service': 'relay\u0000deepseek-flash', reasoning_effort: 'xhigh' })).toEqual([])
    expect(startConfig(info, { '~service': 'relay\u0000plain', reasoning_effort: 'high' })).toEqual([])
    // The Harness's own level is not the service model's.
    expect(startConfig(info, { '~service': 'relay\u0000plain', reasoning_effort: 'medium' })).toEqual([])
  })

  it('shows only 默认 for a model with no declaration, with what it means on hover only', () => {
    const draft = draftOf(codex(declared), 'plain')
    const thinking = renderToStaticMarkup(createElement(DraftThinkingControl, draft))
    expect(named(thinking, '思考')).toBe('默认')
    expect(levelNames(thinking)).toEqual(['默认'])
    expect(levelsColumn(thinking)).not.toContain('model-note')
    for (const words of ['开始后', '发第一条消息后可以换']) expect(thinking).not.toContain(words)
  })

  it('shows what a session on the pair reported, once one ran', () => {
    const effort: SessionConfigOption = { ...reasoning, id: 'effort', currentValue: 'balanced' }
    const cached = [{ providerId: 'relay', model: 'plain', options: [effort], source: 'session' as const }]
    const draft = draftOf(codex(cached), 'plain')
    const thinking = renderToStaticMarkup(createElement(DraftThinkingControl, draft))
    expect(named(thinking, '思考')).toBe('均衡')
    for (const level of ['由模型决定', '更详细']) expect(thinking).toContain(level)
    expect(startConfig(draft.catalog.harnesses[0], { ...draft.choice.config, effort: 'detailed' })).toEqual([
      { configId: 'effort', value: 'detailed' },
    ])
  })

  it('in a session on a service, says 默认 is the service’s only where it sends no level', () => {
    const session = (info: HarnessInfo) =>
      renderToStaticMarkup(
        createElement(SessionThinkingControl, {
          catalog: { ...catalog, harnesses: [info], providers: [relay] },
          harness: info,
          model: undefined,
          current: undefined,
          onModel() {},
          config: [],
          busy: null,
          onConfig() {},
          route: { providerId: 'relay', model: 'plain', name: 'Relay' },
        }),
      )
    const markup = session(codex())
    expect(named(markup, '思考')).toBe('默认')
    expect(markup).not.toContain('用 Codex 的默认值')
    // Another Harness's 默认 is its own: that is the hover of its 默认 row, not a line at the column's foot.
    const own = levelsColumn(session(codex(undefined, false)))
    expect(own).toMatch(/aria-label="默认"[^>]*>.*?<\/button><span[^>]*role="tooltip"[^>]*><span>用 Codex 的默认值<\/span>/su)
    expect(own).not.toContain('ui-board-note')
  })
})

describe('the service a session started on through Latch', () => {
  const openai = { id: 'openai', name: 'OpenAI', kind: 'openai-responses' as const, models: ['gpt-5'], defaultModel: 'gpt-5' }
  const info = testHarness('codex', { label: 'Codex' })
  const own = [{ value: 'gpt-5', label: 'gpt-5' }]
  const route = { providerId: 'openai', model: 'gpt-5', name: 'OpenAI' }
  const header = (on: HostCatalog, at: typeof route & { off?: true }) =>
    ownModelGroups(on, info, own, { route: at }).find(group => group.id === `~service-${at.providerId}`)!

  it('names the service and where requests go while the catalog offers it', () => {
    const on = { ...catalog, harnesses: [info], providers: [openai] }
    expect(header(on, route)).toMatchObject({ label: 'OpenAI', gateway: { experimental: false }, options: [{ value: 'gpt-5' }] })
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

describe('a permission picked before the Harness reports its option', () => {
  const declared = testHarness('codex', {
    permission: {
      approvals: 'prompts',
      readback: 'mode',
      modes: ['read-only', 'workspace-write', 'agent-full-access'],
      startMode: 'read-only',
    },
  })
  const reportedMode: SessionConfigOption = {
    id: 'permission-profile',
    name: '权限',
    category: 'mode',
    currentValue: 'read-only',
    options: ['read-only', 'workspace-write', 'agent-full-access'].map(value => ({ value, name: value })),
  }
  const listed: HarnessInfo = {
    ...declared,
    catalogue: { options: [reportedMode], perModel: [], reportedAt: '2026-11-13T00:00:00Z', source: 'check' },
  }

  it('keeps the selected level when a catalogue arrives with the real mode option id', () => {
    const picks = { [LADDER_MODE]: 'workspace-write' }
    expect(withLadderMode(declared, undefined, picks)?.[0]?.currentValue).toBe('workspace-write')
    expect(withLadderMode(listed, draftConfig(listed, picks)?.config, picks)?.[0]?.currentValue).toBe('workspace-write')
    expect(startConfig(listed, picks)).toEqual([{ configId: LADDER_MODE, value: 'workspace-write' }])
  })

  it('lets a later explicit pick in the reported option replace the earlier declared choice', () => {
    const picks = { [LADDER_MODE]: 'workspace-write', 'permission-profile': 'read-only' }
    expect(withLadderMode(listed, draftConfig(listed, picks)?.config, picks)?.[0]?.currentValue).toBe('read-only')
    expect(startConfig(listed, picks)).toEqual([{ configId: 'permission-profile', value: 'read-only' }])
  })
})
