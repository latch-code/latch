import { createElement } from 'react'
import { testHarness } from '@latch/testkit'
import type { ModeGlyph, ModeTier } from '@latch/protocol'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ownChoice,
  serviceChoice,
  type HarnessInfo,
  type HostCatalog,
  type ProviderSummary,
  type SessionConfigOption,
  type TaskDetail,
} from '@latch/protocol'
import {
  FORK_BUSY,
  onComputer,
  ownModelGroups,
  ROUTE_NOTE,
  SessionHarnessControl,
  type ModelGroup,
  unusableServices,
  UnusableServices,
} from '../src/composer/ModelControl.tsx'
import { DraftModelControl, SessionModelControl } from '../src/composer/ModelPanel.tsx'
import { MODE_ICONS, PermissionPanel, stripRows } from '../src/composer/PermissionList.tsx'
import { pickCaps, pickIndex } from '../src/composer/ModelPanel.tsx'
import { permissionView, type PermissionRow, type PermissionView } from '../src/composer/permission.ts'
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

/** Codex as its profile declares it: Latch forwards its Responses requests. */
const codex = (): HarnessInfo => {
  const info = testHarness('codex', { label: 'Codex' })
  info.capabilities.models = { ...info.capabilities.models, wires: ['responses'], experimental: true }
  return info
}
/** A Harness that speaks only Chat Completions, which Latch converts to nothing else. */
const chatOnly = (): HarnessInfo => {
  const info = testHarness('goose', { label: 'goose' })
  info.capabilities.models = { ...info.capabilities.models, wires: ['chat-completions'] }
  return info
}
/** A Harness Latch cannot forward to any service yet. */
const opencode = (): HarnessInfo => testHarness('opencode', { label: 'OpenCode' })
const builtin = (): HarnessInfo => testHarness('standard', { kind: 'builtin', label: 'Latch 内置' })
const catalogOf = (harness: HarnessInfo, extra: Partial<HostCatalog> = {}): HostCatalog => ({
  harnesses: [harness],
  providers: [openai, deepseek, ollama, anthropic],
  workspaces: [],
  defaults: { harnessId: harness.id, mode: 'agent', workspaceId: 'default' },
  ...extra,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A group's heading, and for a service's models that they go through Latch's gateway and whether it is experimental. */
const heads = (groups: ModelGroup[]) =>
  groups.map(group => (group.gateway ? `${group.label} · 网关${group.gateway.experimental ? ' · 实验性' : ''}` : group.label))

describe('the services a Harness cannot use, folded into one row', () => {
  it('gives each the reason in the words decided for it: which protocols the Harness speaks, and which the service does', () => {
    const chat = chatOnly()
    expect(unusableServices(catalogOf(chat), chat).map(item => [item.name, item.reason])).toEqual([
      ['OpenAI', 'goose 只说 Chat Completions，这个服务是 Responses'],
      ['Anthropic', 'goose 只说 Chat Completions，这个服务是 Anthropic Messages'],
    ])
    const info = codex()
    expect(unusableServices(catalogOf(info), info)).toEqual([])
    // Supported services are listed with their models; the Harness's own models remain under its name.
    const groups = ownModelGroups(catalogOf(info), info, [{ value: 'own', label: 'gpt-5.5' }])
    expect(heads(groups)).toEqual([
      'Codex',
      'OpenAI · 网关 · 实验性',
      'DeepSeek · 网关 · 实验性',
      'Ollama 本地 · 网关 · 实验性',
      'Anthropic · 网关 · 实验性',
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

  it.each([
    ['qwen', 'Qwen Code'],
    ['goose', 'goose'],
    ['grok', 'Grok Build'],
  ])('lists %s\u2019s own models and every service it can reach through Latch, side by side', (id, label) => {
    const info = testHarness(id, { label })
    info.capabilities.models = {
      ...info.capabilities.models,
      wires: ['chat-completions', 'responses', 'anthropic-messages'],
      experimental: true,
      credentialInherited: true,
    }
    const catalog = catalogOf(info, { providers: [openai, deepseek, anthropic] })
    const groups = ownModelGroups(catalog, info, [{ value: 'own', label: 'its own model' }])
    // Its own group first, under its own name: that one needs its login. The services need none of it.
    expect(heads(groups)).toEqual([label, 'OpenAI · 网关 · 实验性', 'DeepSeek · 网关 · 实验性', 'Anthropic · 网关 · 实验性'])
    expect(groups[0]!.options.map(option => option.label)).toEqual(['its own model'])
    expect(groups.slice(1).every(group => group.options.every(option => option.disabledReason === undefined))).toBe(true)
    expect(unusableServices(catalog, info)).toEqual([])
  })

  it('offers no service to a Harness that takes no model provider of another\u2019s, and says nothing false about it', () => {
    const cursor = testHarness('cursor', { label: 'Cursor' })
    cursor.capabilities.models = { ...cursor.capabilities.models, ownOnly: true }
    expect(ownModelGroups(catalogOf(cursor), cursor, []).map(group => group.id)).toEqual(['~own'])
    expect(unusableServices(catalogOf(cursor), cursor)).toEqual([])
    const antigravity = testHarness('antigravity', { label: 'Antigravity' })
    expect(ownModelGroups(catalogOf(antigravity), antigravity, []).map(group => group.id)).toEqual(['~own'])
  })

  it('offers Claude Chat and Responses translation beside native Anthropic', () => {
    const info = testHarness('claude-agent', { label: 'Claude Agent' })
    info.capabilities.models = { ...info.capabilities.models, wires: ['anthropic-messages'] }
    const catalog = catalogOf(info)
    expect(heads(ownModelGroups(catalog, info, []))).toEqual([
      'Claude Agent',
      'OpenAI · 网关 · 实验性',
      'DeepSeek · 网关 · 实验性',
      'Ollama 本地 · 网关 · 实验性',
      'Anthropic · 网关',
    ])
    expect(unusableServices(catalog, info)).toEqual([])
  })

  it('has no such row for a Harness Latch forwards to no service: it uses its own models, and nothing else applies', () => {
    const own = testHarness('claude-agent', { label: 'Claude Agent' })
    own.capabilities.models = { ...own.capabilities.models, wires: [], ownOnly: true }
    for (const info of [opencode(), own]) {
      expect(unusableServices(catalogOf(info), info)).toEqual([])
      expect(ownModelGroups(catalogOf(info), info, []).map(group => group.id)).toEqual(['~own'])
    }
  })

  it('lists in a session what a new one lists, and says why a choice that leaves its route cannot be made', () => {
    const info = codex()
    const route = { providerId: 'openai', model: 'openai-model', name: 'OpenAI' }
    const other = service('relay', 'Relay', 'openai-responses')
    const catalog = catalogOf(info, { providers: [openai, other, deepseek, anthropic] })
    const own = [{ value: 'openai-model', label: 'openai-model' }]
    // A Harness that cannot move a session keeps the rule a session started with.
    const fixed = ownModelGroups(catalog, info, own, { route })
    expect(heads(fixed)).toEqual([
      'Codex',
      'OpenAI · 网关 · 实验性',
      'Relay · 网关 · 实验性',
      'DeepSeek · 网关 · 实验性',
      'Anthropic · 网关 · 实验性',
    ])
    expect(fixed.find(group => group.id === '~service-relay')?.options).toMatchObject([
      { value: serviceChoice({ providerId: 'relay', model: 'relay-model' }), disabledReason: '开始后不能换服务' },
    ])
    // Codex moves a session between services only: its own login is shown, not offered.
    info.capabilities.models = { ...info.capabilities.models, routeSwitch: 'services' }
    const moving = ownModelGroups(catalog, info, own, { route })
    expect(moving[0]!.options).toMatchObject([
      { value: ownChoice(''), label: '默认模型', disabledReason: 'Codex 的会话不能在它自己的登录和经 Latch 之间换，新开一个会话' },
    ])
    expect(moving.find(group => group.id === '~service-relay')?.options[0]).not.toHaveProperty('disabledReason')
    // The session's own service lists what the session reports, as its own values.
    expect(moving.find(group => group.id === '~service-openai')?.options).toEqual(own)
    // Where the requests go is on the heading, not a row: the protocol's losses for a translated pair too.
    expect(moving.find(group => group.id === '~service-deepseek')?.hint).toContain('协议转换，实验性')
    expect(moving.find(group => group.id === '~service-openai')?.hint).toContain('请求由 Latch 在这台 Mac 上转发')
    // On its own login, a Harness that moves either way offers every service's models and its own list's.
    info.capabilities.models = { ...info.capabilities.models, routeSwitch: 'any' }
    const listed: HarnessInfo = {
      ...info,
      catalogue: {
        options: [{ id: 'model', name: 'Model', category: 'model', currentValue: 'gpt-5', options: [{ value: 'gpt-5', name: 'GPT-5' }] }],
        perModel: [],
        reportedAt: '2026-11-16T00:00:00Z',
        source: 'session',
      },
    }
    expect(ownModelGroups(catalog, listed, own, { route })[0]!.options).toEqual([{ value: ownChoice('gpt-5'), label: 'GPT-5' }])
    const unrouted = ownModelGroups(catalog, listed, own, {})
    expect(unrouted[0]!.options).toEqual(own)
    expect(unrouted.find(group => group.id === '~service-openai')?.options).toMatchObject([
      { value: serviceChoice({ providerId: 'openai', model: 'openai-model' }) },
    ])
    // The session's own service is never among the ones it cannot use.
    const chat = chatOnly()
    const started = { route: { providerId: 'deepseek', model: 'deepseek-model', name: 'DeepSeek' } }
    expect(unusableServices(catalogOf(chat), chat, undefined, started).map(item => item.name)).toEqual(['OpenAI', 'Anthropic'])
  })

  it('lists for the built-in Harness the saved services held back, naming the computer only away from it', () => {
    const info = builtin()
    const catalog = catalogOf(info, {
      unusableProviders: [
        { id: 'zhipu', name: '智谱 GLM', reason: 'key-missing' },
        { id: 'lmstudio', name: 'LM Studio', reason: 'origin-unconfirmed' },
        { id: 'old', name: '旧服务', reason: 'unsupported' },
      ],
    })
    expect(unusableServices(catalog, info).map(item => item.reason)).toEqual([
      '没有密钥 · 在设置 › 模型里添加',
      '地址还没确认 · 在这台 Mac 上确认',
      '不再支持',
    ])
    expect(unusableServices(catalog, info, 'studio-mini').at(1)?.reason).toBe('地址还没确认 · 在 studio-mini 上确认')
  })

  it('draws one folded row with the count, and no service until it is opened', () => {
    const info = chatOnly()
    const unavailable = unusableServices(catalogOf(info), info)
    for (const services of [unavailable, [...unavailable, { ...unavailable[0]!, id: 'openai-other', name: 'OpenAI 备用' }]]) {
      const html = renderToStaticMarkup(createElement(UnusableServices, { services }))
      expect(html).toContain(`${services.length} 个服务用不了`)
      expect(html).not.toContain('Anthropic')
      expect(html).not.toContain('OpenAI')
    }
    expect(renderToStaticMarkup(createElement(UnusableServices, { services: [] }))).toBe('')
  })

  it('puts the row at the foot of a draft model menu, after the models the Harness can use', () => {
    const info = chatOnly()
    const html = renderToStaticMarkup(
      createElement(DraftModelControl, {
        catalog: catalogOf(info),
        choice: { harnessId: 'goose', mode: 'agent', workspaceId: 'default' },
        onChoice() {},
        access: { legacy: false, local: true, admin: true, scopes: new Set(['view', 'run', 'admin'] as const) },
        disabled: false,
      }),
    )
    // The services it can use are one source, the gateway, named alone: no service's name or paragraph on the rail.
    expect(html).toContain('aria-label="Latch 网关"')
    expect(html).not.toContain('经 Latch')
    expect(html).not.toContain('请求由 Latch')
    expect(html).toContain('2 个服务用不了')
    expect(html.indexOf('2 个服务用不了')).toBeGreaterThan(html.indexOf('aria-label="Latch 网关"'))
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

  it('says a read refused for want of a login as a short state, and nothing of it on a service’s model', () => {
    const last = {
      at: '2026-11-15T03:00:00.000Z',
      ok: false,
      loginRequired: true as const,
      message: 'Codex 还没登录。按它自己的方式登录后重试。',
    }
    const info = { ...codex(), catalogueRead: { when: 'select' as const, modes: false, last } }
    const own = draftMenu(info)
    expect(own).toMatch(/<p class="model-note" data-tone="warn"><svg[^>]*>.*?<\/svg>还没登录<\/p>/u)
    for (const gone of ['没有读到：', '按它自己的方式登录后重试']) expect(own).not.toContain(gone)
    expect(own).toContain('重新读取')
    // With a service's model picked the Harness's login is not what the draft depends on.
    const routed = draftMenu(info, { '~service': 'openai\u0000openai-model' })
    for (const gone of ['还没登录', '没有读到：']) expect(routed).not.toContain(gone)
    expect(routed).toContain('重新读取')
  })

  it('keeps the service’s mark on the model chip of a session that started on a service, as on the draft’s', () => {
    const info = codex()
    const chip = (markup: string) => /<button[^>]*class="[^"]*model-picker[^"]*"[^>]*>.*?<\/button>/su.exec(markup)![0]
    const session = (route?: { providerId: string; model: string; name: string }) =>
      chip(
        renderToStaticMarkup(
          createElement(SessionModelControl, {
            catalog: catalogOf(info),
            harness: info,
            model: undefined,
            current: undefined,
            reported: route?.model ?? 'gpt-5.5',
            onModel() {},
            config: [],
            busy: null,
            onConfig() {},
            ...(route ? { route } : {}),
          }),
        ),
      )
    const draft = chip(draftMenu(info, { '~service': 'openai\u0000openai-model' }))
    const lead = /<span class="ui-value-picker-lead">.*?<span class="ui-value-picker-value">/su
    expect(lead.exec(draft)?.[0]).toContain('openai.svg')
    const routed = session({ providerId: 'openai', model: 'openai-model', name: 'OpenAI' })
    expect(lead.exec(routed)?.[0]).toBe(lead.exec(draft)![0])
    // On the Harness's own model there is no service to mark.
    expect(session()).not.toMatch(lead)
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
      label: '经 Latch 网关转发',
      detail: '「经 Latch 网关」表示请求由 Latch 在 studio-mini 上转发，用设置里的密钥。Codex 有一整轮没有经过 Latch 时，会话里会告诉你。',
    })
    // A Harness that cannot keep its environment from the commands it runs says what they can read, in the same ⓘ.
    expect(ROUTE_NOTE('Qwen Code', undefined, true).detail).toBe(
      '「经 Latch 网关」表示请求由 Latch 在这台 Mac 上转发，用设置里的密钥。Qwen Code 有一整轮没有经过 Latch 时，会话里会告诉你。Qwen Code 运行的命令读得到这个会话的转发凭据，不是密钥。',
    )
    expect(ROUTE_NOTE('Codex', undefined, false).detail).not.toContain('读得到')
  })
})

describe('the keys on the menu titles', () => {
  it('are drawn only in the desktop app, whose keys are settled', () => {
    expect(controlKeyCaps('model')).toBeUndefined()
    vi.stubGlobal('window', { latchShell: { kind: 'electron', platform: 'darwin' } })
    expect(controlKeyCaps('harness')).toEqual(['⌥', '⌘', '1'])
    const html = renderToStaticMarkup(
      createElement(PermissionPanel, {
        view: { label: '先问你', line: '', icon: 'shield', amber: false },
        onChoose() {},
      }),
    )
    expect(html).toMatch(/什么时候问你？<\/span><kbd class="ui-kbd"[^>]*>⌥⌘4<\/kbd>/u)
  })
})

describe('分叉 in the session Harness popover', () => {
  const render = (fork?: Parameters<typeof SessionHarnessControl>[0]['fork']) =>
    renderToStaticMarkup(createElement(SessionHarnessControl, { harness: codex(), admin: false, onNewSession() {}, fork }))

  it('offers a fork of the latest turn, with the lock on the chip as its tooltip and no line under the row', () => {
    const html = render({ onFork() {} })
    expect(html).toMatch(/role="tooltip"[^>]*>.*开始后不能换 Harness/su)
    expect(html).not.toContain('从最后一轮')
    expect(html).not.toContain('aria-disabled')
  })

  it('stays focusable but off while the latest turn runs, with the reason as its tooltip', () => {
    const html = render({ onFork() {}, blocked: FORK_BUSY })
    expect(html).toMatch(/aria-disabled="true"[^>]*>.*分叉.*role="tooltip"[^>]*>.*这一轮结束后才能分叉/su)
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

describe('the 权限 panel', () => {
  const tiers = ['plan', 'ask', 'rule', 'model', 'never'] as const
  const icons = ['eye', 'shield', 'list-checks', 'scale', 'shield-alert'] as const
  const rows = (count: number, tiered = true): PermissionRow[] =>
    Array.from({ length: count }, (_, index) => ({
      value: `m${index}`,
      name: `模式${index}`,
      line: `模式${index}的一句`,
      icon: icons[index % 5]!,
      ...(tiered ? { tier: tiers[index % 5]! } : {}),
      neverAsks: tiered && tiers[index % 5] === 'never',
      current: index === 1,
    }))
  const view = (list: PermissionRow[]): PermissionView => ({ label: '先问你', line: '', icon: 'shield', amber: false, rows: list })

  it('draws two to five modes Latch knows as one row of segments, with the chosen one’s name and its one line', () => {
    expect(stripRows(view(rows(2)))).toHaveLength(2)
    expect(stripRows(view(rows(5)))).toHaveLength(5)
    const html = renderToStaticMarkup(createElement(PermissionPanel, { view: view(rows(5)), onChoose() {} }))
    expect(html.match(/role="radio"/gu)).toHaveLength(5)
    expect(html).toContain('class="ui-mode-strip-name">模式1<')
    expect(html).toContain('class="ui-mode-strip-line">模式1的一句<')
    // The loosest mode carries the risk mark, drawn amber only while chosen or previewed; the panel keeps its lock.
    expect(html).toMatch(/aria-label="模式4"[^>]*data-risk=""/u)
    expect(html).toContain('data-lock=""')
    for (const gone of ['ui-hint', '收起', '更多']) expect(html).not.toContain(gone)
  })

  it('draws every Harness’s modes as segments: one mode, more than a row holds, and a mode this device cannot choose', () => {
    // One mode, and before any are reported the one that is true now: a strip of one segment, never a list.
    expect(stripRows(view(rows(1)))).toHaveLength(1)
    const before = stripRows({ label: '开始后可选', line: '', icon: 'shield', amber: false })
    expect(before.map(row => [row.value, row.name, row.current])).toEqual([['current', '开始后可选', true]])
    // More than five wrap onto a second row of the same segments.
    const seven = renderToStaticMarkup(createElement(PermissionPanel, { view: view(rows(7, false)), onChoose() {} }))
    expect(seven.match(/role="radio"/gu)).toHaveLength(7)
    expect(seven).toContain('--mode-columns:5')
    expect(seven).not.toContain('ui-choice')
    // A mode this device cannot choose stays a segment, with why as its tooltip.
    const locked = rows(3).map((row, index) => (index === 2 ? { ...row, disabledReason: '这台设备不能改' } : row))
    const html = renderToStaticMarkup(createElement(PermissionPanel, { view: view(locked), onChoose() {} }))
    expect(html).toMatch(/aria-label="模式2"[^>]*aria-disabled="true"/u)
    expect(html).toContain('这台设备不能改')
  })

  it('gives every mode a glyph of its own: documented glyphs where two share a tier, plain shapes for unknown ones', () => {
    const harness = testHarness('agy', { label: 'Antigravity' })
    harness.level = 'L3'
    const option = (values: string[]) => ({
      id: 'mode',
      name: 'Mode',
      category: 'mode' as const,
      type: 'select' as const,
      currentValue: values[0]!,
      options: values.map(value => ({ value, name: value })),
    })
    const shown = (values: string[], modeTiers?: Record<string, ModeTier>, modeGlyphs?: Record<string, ModeGlyph>) =>
      permissionView({
        harness,
        config: [option(values)],
        permission: { approvals: 'prompts', readback: 'mode', ...(modeTiers ? { modeTiers } : {}), ...(modeGlyphs ? { modeGlyphs } : {}) },
        access: { legacy: false, local: true },
      })!.rows!.map(row => [row.value, row.icon])
    // Antigravity: Plan has no tier (it promises nothing about reading only); its profile draws it as writing a plan.
    expect(
      shown(
        ['default', 'accept-edits', 'auto', 'plan'],
        {
          default: { tier: 'ask', name: '默认', line: 'a' },
          'accept-edits': { tier: 'rule', line: 'b' },
          auto: { tier: 'model', line: 'c' },
        },
        { plan: 'plan' },
      ),
    ).toEqual([
      ['default', 'shield'],
      ['accept-edits', 'list-checks'],
      ['auto', 'scale'],
      ['plan', 'plan'],
    ])
    // Without that, it would take a plain shape, never a second shield.
    expect(shown(['default', 'plan'], { default: { tier: 'ask', line: 'a' } }).map(([, icon]) => icon)).toEqual(['shield', 'circle'])
    // Two modes of one tier: the profile's glyphs tell them apart (Cursor's Ask and Plan); without them, a shape.
    expect(
      shown(
        ['ask', 'plan'],
        { ask: { tier: 'plan', line: 'a' }, plan: { tier: 'plan', line: 'b' } },
        { ask: 'question', plan: 'plan' },
      ).map(([, icon]) => icon),
    ).toEqual(['question', 'plan'])
    expect(shown(['a', 'b'], { a: { tier: 'plan', line: 'a' }, b: { tier: 'plan', line: 'b' } }).map(([, icon]) => icon)).toEqual([
      'eye',
      'circle',
    ])
    // A Harness Latch knows nothing of: the shield for the first, shapes for the rest, nothing guessed from a name.
    const unknown = shown(['plan', 'default', 'yolo'])
    expect(unknown.map(([, icon]) => icon)).toEqual(['shield', 'circle', 'square'])
    for (const [, icon] of unknown) expect(MODE_ICONS[icon as keyof typeof MODE_ICONS]).toBeDefined()
  })
})

describe('the keys of the model panel', () => {
  it('are the session keys from the registry, drawn only in the desktop app', () => {
    expect(pickCaps(0, false)).toBeUndefined()
    expect(pickCaps(0, true)).toBe('⌘1')
    expect(pickCaps(8, true)).toBe('⌘9')
    expect(pickCaps(9, true)).toBeUndefined()
    const stroke = { code: 'Digit3', key: '3', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
    expect(pickIndex(stroke, true)).toBe(2)
    expect(pickIndex({ ...stroke, altKey: true }, true)).toBeUndefined()
    expect(pickIndex({ ...stroke, metaKey: false, altKey: true }, false)).toBe(2)
  })
})
