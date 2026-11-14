import { createElement } from 'react'
import { testHarness } from '@latch/testkit'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessInfo, HostCatalog, ProviderSummary, SessionConfigOption, TaskDetail } from '@latch/protocol'
import {
  DraftModelControl,
  FORK_BUSY,
  onComputer,
  ownModelGroups,
  ROUTE_NOTE,
  SessionHarnessControl,
  unusableServices,
  UnusableServices,
} from '../src/composer/ModelControl.tsx'
import { PermissionList } from '../src/composer/PermissionList.tsx'
import { controlKeyCaps } from '../src/composer/modelReasoning.ts'
import { forkedChoice, forkSource } from '../src/forkChoice.ts'
import { draftConfig } from '../src/composerChoice.ts'

const service = (id: string, name: string, kind: ProviderSummary['kind']): ProviderSummary => ({
  id,
  name,
  kind,
  models: [`${id}-model`],
  defaultModel: `${id}-model`,
})
const openai = service('openai', 'OpenAI', 'openai-responses')
const deepseek = service('deepseek', 'DeepSeek', 'openai-compatible')
const ollama = service('ollama', 'Ollama 本地', 'openai-compatible')
const anthropic = service('anthropic', 'Anthropic', 'anthropic')
const gemini = service('gemini', 'Gemini', 'gemini')

/** Codex as its profile declares it: Latch forwards its Responses requests. */
const codex = (): HarnessInfo => {
  const info = testHarness('codex', { label: 'Codex' })
  info.capabilities.models = { ...info.capabilities.models, wires: ['responses'], experimental: true }
  return info
}
/** A Harness Latch cannot forward to any service yet. */
const opencode = (): HarnessInfo => testHarness('opencode', { label: 'OpenCode' })
const builtin = (): HarnessInfo => testHarness('standard', { kind: 'builtin', label: 'Latch 内置' })
const catalogOf = (harness: HarnessInfo, extra: Partial<HostCatalog> = {}): HostCatalog => ({
  harnesses: [harness],
  providers: [openai, deepseek, ollama, anthropic, gemini],
  workspaces: [],
  defaults: { harnessId: harness.id, mode: 'agent', workspaceId: 'default' },
  ...extra,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the services a Harness cannot use, folded into one row', () => {
  it('gives each the reason in the words decided for it: which protocols Codex speaks, and which the service does', () => {
    const info = codex()
    const off = unusableServices(catalogOf(info), info)
    expect(off.map(item => [item.name, item.reason])).toEqual([['Gemini', 'Codex 只说 Responses，这个服务是 Gemini']])
    // Supported services are listed with their models; the Harness's own models remain under its name.
    const groups = ownModelGroups(catalogOf(info), info, [{ value: 'own', label: 'gpt-5.5' }])
    expect(groups.map(group => group.label)).toEqual([
      'Codex',
      'OpenAI · 实验性 · 经 Latch',
      'DeepSeek · 实验性 · 经 Latch',
      'Ollama 本地 · 实验性 · 经 Latch',
      'Anthropic · 实验性 · 经 Latch',
    ])
    expect(JSON.stringify(groups)).not.toContain('尚未实现')
  })

  it('offers translated Chat and Anthropic models as selectable choices alongside same-protocol Responses models', () => {
    const info = codex()
    const catalog = catalogOf(info, { providers: [openai, deepseek, ollama, anthropic] })
    const groups = ownModelGroups(catalog, info, [])
    expect(unusableServices(catalog, info)).toEqual([])
    expect(groups.slice(1).map(group => group.options.map(option => [option.label, option.disabledReason]))).toEqual([
      [['openai-model', undefined]],
      [['deepseek-model', undefined]],
      [['ollama-model', undefined]],
      [['anthropic-model', undefined]],
    ])
  })

  it('offers Claude Chat and Responses translation beside native Anthropic while keeping Gemini unavailable', () => {
    const info = testHarness('claude-agent', { label: 'Claude Agent' })
    info.capabilities.models = { ...info.capabilities.models, wires: ['anthropic-messages'] }
    const catalog = catalogOf(info)
    expect(ownModelGroups(catalog, info, []).map(group => group.label)).toEqual([
      'Claude Agent',
      'OpenAI · 实验性 · 经 Latch',
      'DeepSeek · 实验性 · 经 Latch',
      'Ollama 本地 · 实验性 · 经 Latch',
      'Anthropic · 经 Latch',
    ])
    expect(unusableServices(catalog, info).map(item => [item.name, item.reason])).toEqual([
      ['Gemini', 'Claude Agent 只说 Anthropic Messages，这个服务是 Gemini'],
    ])
  })

  it('has no such row for a Harness Latch forwards to no service: it uses its own models, and nothing else applies', () => {
    const own = testHarness('claude-agent', { label: 'Claude Agent' })
    own.capabilities.models = { ...own.capabilities.models, wires: [], ownOnly: true }
    for (const info of [opencode(), own]) {
      expect(unusableServices(catalogOf(info), info)).toEqual([])
      expect(ownModelGroups(catalogOf(info), info, []).map(group => group.id)).toEqual(['~own'])
    }
  })

  it('keeps the rule that a session stays on the service it started with, with its reason', () => {
    const info = codex()
    const route = { providerId: 'openai', model: 'openai-model', name: 'OpenAI' }
    const other = service('relay', 'Relay', 'openai-responses')
    const catalog = catalogOf(info, { providers: [openai, other, deepseek, anthropic, gemini] })
    const groups = ownModelGroups(catalog, info, [{ value: 'openai-model', label: 'openai-model' }], { route })
    expect(groups.at(-1)).toMatchObject({
      label: '模型服务',
      options: [
        { label: 'Relay', disabledReason: '开始后不能换服务' },
        { label: 'DeepSeek', disabledReason: '开始后不能换服务' },
        { label: 'Anthropic', disabledReason: '开始后不能换服务' },
      ],
    })
    // The session's own service is never among the ones it cannot use.
    expect(unusableServices(catalog, info, undefined, { route }).map(item => item.name)).toEqual(['Gemini'])
  })

  it('lists for the built-in Harness the saved services held back, naming the computer only away from it', () => {
    const info = builtin()
    const catalog = catalogOf(info, {
      unusableProviders: [
        { id: 'zhipu', name: '智谱 GLM', reason: 'key-missing' },
        { id: 'lmstudio', name: 'LM Studio', reason: 'origin-unconfirmed' },
      ],
    })
    expect(unusableServices(catalog, info).map(item => item.reason)).toEqual([
      '没有密钥 · 在设置 › 模型里添加',
      '地址还没确认 · 在这台 Mac 上确认',
    ])
    expect(unusableServices(catalog, info, 'studio-mini').at(-1)?.reason).toBe('地址还没确认 · 在 studio-mini 上确认')
  })

  it('draws one folded row with the count, and no service until it is opened', () => {
    const info = codex()
    const unavailable = unusableServices(catalogOf(info), info)
    for (const services of [unavailable, [...unavailable, { ...unavailable[0]!, id: 'gemini-other', name: 'Gemini 备用' }]]) {
      const html = renderToStaticMarkup(createElement(UnusableServices, { services }))
      expect(html).toContain(`${services.length} 个服务用不了`)
      expect(html).not.toContain('Anthropic')
      expect(html).not.toContain('Gemini')
    }
    expect(renderToStaticMarkup(createElement(UnusableServices, { services: [] }))).toBe('')
  })

  it('puts the row at the foot of a draft model menu, after the models the Harness can use', () => {
    const info = codex()
    const html = renderToStaticMarkup(
      createElement(DraftModelControl, {
        catalog: catalogOf(info),
        choice: { harnessId: 'codex', mode: 'agent', workspaceId: 'default' },
        onChoice() {},
        access: { legacy: false, local: true, admin: true, scopes: new Set(['view', 'run', 'admin'] as const) },
        disabled: false,
      }),
    )
    expect(html).toContain('OpenAI · 实验性 · 经 Latch')
    expect(html).toContain('Anthropic · 实验性 · 经 Latch')
    expect(html).toContain('1 个服务用不了')
    expect(html.indexOf('1 个服务用不了')).toBeGreaterThan(html.indexOf('Anthropic · 实验性 · 经 Latch'))
    // What 「经 Latch」 means, and whose key it uses, stays one press away under a short label.
    expect(html).toMatch(/<span class="ui-hint-label">经 Latch 转发<\/span><button[^>]*aria-label="说明"/u)
  })
})

/** Codex direct, as its app-server's model/list reads: Latch forwards it to no service. */
const codexDirect = (extra: Partial<HarnessInfo> = {}): HarnessInfo => ({
  ...testHarness('codex', { label: 'Codex' }),
  catalogueRead: { when: 'select', modes: false },
  ...extra,
})
const efforts = (values: string[]): SessionConfigOption => ({
  id: 'reasoning_effort',
  name: 'Reasoning effort',
  category: 'thought_level',
  currentValue: values[0]!,
  options: values.map(value => ({ value, name: value.charAt(0).toUpperCase() + value.slice(1) })),
})
const codexList: NonNullable<HarnessInfo['catalogue']> = {
  options: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'gpt-5.5',
      options: [
        { value: 'gpt-5.5', name: 'GPT-5.5' },
        { value: 'gpt-5.5-mini', name: 'GPT-5.5 mini' },
      ],
    },
    efforts(['medium', 'high']),
  ],
  perModel: [
    { model: 'gpt-5.5', options: [efforts(['medium', 'high'])] },
    { model: 'gpt-5.5-mini', options: [efforts(['low', 'medium'])] },
  ],
  reportedAt: '2026-11-13T00:00:00.000Z',
  source: 'check',
}
const draftMenu = (info: HarnessInfo, config?: Record<string, string>) =>
  renderToStaticMarkup(
    createElement(DraftModelControl, {
      catalog: catalogOf(info),
      choice: { harnessId: 'codex', mode: 'agent', workspaceId: 'default', ...(config ? { config } : {}) },
      onChoice() {},
      access: { legacy: false, local: true, admin: true, scopes: new Set(['view', 'run', 'admin'] as const) },
      disabled: false,
    }),
  )

describe("a draft's model menu for a Harness with its own models", () => {
  it('lists them by their real names under the Harness, the default marked beside its name, with 刷新模型列表', () => {
    const html = draftMenu(codexDirect({ catalogue: codexList }))
    expect(html).toContain('GPT-5.5 mini')
    expect(html).toMatch(/GPT-5\.5<\/span>[^]*?默认/u)
    expect(html).not.toMatch(/GPT-5\.5 mini<\/span>[^<]*<[^>]*>默认/u)
    expect(html.match(/>默认</gu)).toHaveLength(1)
    expect(html).toContain('>Codex<')
    for (const gone of ['自己的模型', '默认模型', '服务用不了']) expect(html).not.toContain(gone)
    expect(html).toContain('刷新模型列表')
    expect(html).not.toContain('读取于 ')
  })

  it('says 默认模型 only while the Harness reported nothing, and offers to read it', () => {
    const html = draftMenu(codexDirect())
    expect(html).toContain('默认模型')
    expect(html).toContain('读取 Codex 的模型列表')
    expect(html).not.toContain('发第一条消息后可以换')
  })

  it('says why the last read failed, with 重新读取', () => {
    const html = draftMenu(
      codexDirect({ catalogueRead: { when: 'select', modes: false, last: { at: 'now', ok: false, message: 'Codex 还没登录。' } } }),
    )
    expect(html).toContain('没有读到：')
    expect(html).toContain('Codex 还没登录。')
    expect(html).toContain('重新读取')
    expect(html).not.toContain('刷新模型列表')
  })

  it('offers a preset not saved yet the same read, which saves it on this Mac first', () => {
    const offered = codexDirect({ offer: { presetId: 'codex' } })
    delete offered.catalogueRead
    const html = draftMenu(offered)
    expect(html).toContain('读取 Codex 的模型列表')
    expect(html).not.toContain('发第一条消息后可以换')
    expect(html).not.toContain('填写模型 ID')
  })

  it('offers exactly the thinking levels the Harness reported for the model picked', () => {
    const info = codexDirect({ catalogue: codexList })
    const thinking = (config?: Record<string, string>) =>
      draftConfig(info, config)
        ?.config.find(option => option.category === 'thought_level')
        ?.options.map(item => item.value)
    expect(thinking()).toEqual(['medium', 'high'])
    expect(thinking({ model: 'gpt-5.5-mini' })).toEqual(['low', 'medium'])
  })
})

describe("Latch's own sentences on another computer's page", () => {
  it('names the computer where the app on that Mac says 这台 Mac', () => {
    expect(onComputer('能读写这台 Mac 上的文件并运行命令', 'studio-mini')).toBe('能读写 studio-mini 上的文件并运行命令')
    expect(onComputer('能读写这台 Mac 上的文件并运行命令', undefined)).toBe('能读写这台 Mac 上的文件并运行命令')
    expect(ROUTE_NOTE('Codex', 'studio-mini')).toEqual({
      label: '经 Latch 转发',
      detail: '「经 Latch」表示请求由 Latch 在 studio-mini 上转发，用设置里的密钥。Codex 有一整轮没有经过 Latch 时，会话里会告诉你。',
    })
  })
})

describe('the keys on the menu titles', () => {
  it('are drawn only in the desktop app, whose keys are settled', () => {
    expect(controlKeyCaps('model')).toBeUndefined()
    vi.stubGlobal('window', { latchShell: { kind: 'electron', platform: 'darwin' } })
    expect(controlKeyCaps('harness')).toEqual(['⌥', '⌘', '1'])
    const html = renderToStaticMarkup(
      createElement(PermissionList, {
        view: { label: '先问你', line: '', icon: 'shield', amber: false },
        onChoose() {},
      }),
    )
    expect(html).toMatch(/什么时候问你？<\/span><span class="menu-title-keys"[^>]*><kbd class="ui-kbd">⌥⌘4<\/kbd>/u)
  })
})

describe('分叉 in the session Harness popover', () => {
  const render = (fork?: Parameters<typeof SessionHarnessControl>[0]['fork']) =>
    renderToStaticMarkup(createElement(SessionHarnessControl, { harness: codex(), onNewSession() {}, fork }))

  it('offers a fork of the latest turn that may change Harness, under the lock that keeps this one', () => {
    const html = render({ onFork() {} })
    expect(html).toContain('开始后不能换 Harness')
    // That files are not copied or rolled back is on the fork notice that follows, behind its ⓘ.
    expect(html).toContain('从最后一轮，可以换 Harness')
    expect(html).not.toContain('aria-disabled')
  })

  it('stays readable but off while the latest turn runs, with the reason', () => {
    const html = render({ onFork() {}, blocked: FORK_BUSY })
    expect(html).toMatch(/aria-disabled="true"[^>]*>.*这一轮结束后才能分叉/su)
  })

  it('has no fork row where the Host cannot fork or the device may not start a session', () => {
    expect(render()).not.toContain('分叉</span>')
  })
})

describe('a fork onto a Harness whose options are not read yet', () => {
  const option = (id: string, category: string, value: string): SessionConfigOption => ({
    id,
    name: id,
    category,
    currentValue: value,
    options: [{ value, name: value }],
  })
  const source = testHarness('codex', { label: 'Codex' })
  source.permission = { approvals: 'prompts', readback: 'mode', modeTiers: { write: { tier: 'rule', line: 'write' } } }
  const detail: TaskDetail = {
    summary: { id: 'source', title: '来源', status: 'idle', updatedAt: '2026-11-12T00:00:00.000Z', mode: 'agent', harnessId: 'codex' },
    messages: [],
    approvals: [],
    liveText: '',
    cursor: 0,
    config: [option('model', 'model', 'gpt-5.5'), option('mode', 'mode', 'write')],
  }
  const onto = (harness: HarnessInfo) =>
    forkedChoice(
      {
        harnesses: [source, harness],
        providers: [],
        workspaces: [],
        defaults: { harnessId: 'codex', mode: 'agent', workspaceId: 'default' },
      },
      null,
      { harnessId: harness.id },
      forkSource(detail, source),
    ).missed

  it('waits for the rows of one that has them, and promises none from one whose profile lists no rows', () => {
    const opencode = testHarness('opencode', { label: 'OpenCode' })
    opencode.permission = { approvals: 'prompts', readback: 'mode', modeTiers: { build: { tier: 'ask', line: 'build' } } }
    expect(onto(opencode)).toEqual(['来源会话的模型「gpt-5.5」与权限「按规则放行」要等读到 OpenCode 的选项后才能沿用。'])
    const pi = testHarness('pi', { label: 'pi' })
    pi.permission = { approvals: 'none', readback: 'none' }
    expect(onto(pi)).toEqual(['来源会话的模型「gpt-5.5」要等读到 pi 的选项后才能沿用。'])
  })
})
