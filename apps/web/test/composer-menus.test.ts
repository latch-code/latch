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
import { controlKeyCaps, controlKeyText } from '../src/composer/modelReasoning.ts'
import { forkedChoice, forkSource } from '../src/forkChoice.ts'

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
  providers: [openai, deepseek, ollama],
  workspaces: [],
  defaults: { harnessId: harness.id, mode: 'agent', workspaceId: 'default' },
  ...extra,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the services a Harness cannot use, folded into one row', () => {
  it('gives each the reason in the words decided for it: a protocol Codex does not speak is not 尚未实现', () => {
    const info = codex()
    const off = unusableServices(catalogOf(info), info)
    expect(off.map(item => [item.name, item.reason])).toEqual([
      ['DeepSeek', 'Codex 不说这个服务的协议'],
      ['Ollama 本地', 'Codex 不说这个服务的协议'],
    ])
    // The one it can use is listed with its models, not folded.
    const groups = ownModelGroups(catalogOf(info), info, [{ value: 'own', label: 'gpt-5.5' }])
    expect(groups.map(group => group.label)).toEqual(['Codex 自己的模型', 'OpenAI · 实验性 · 经 Latch'])
    expect(JSON.stringify(groups)).not.toContain('尚未实现')
  })

  it('says of a Harness Latch does not forward yet that it is not done, since a step builds it', () => {
    const info = opencode()
    expect(unusableServices(catalogOf(info), info).map(item => item.reason)).toEqual(
      Array(3).fill('让 Latch 把 OpenCode 的请求转给它，尚未实现'),
    )
    expect(ownModelGroups(catalogOf(info), info, []).map(group => group.id)).toEqual(['~own'])
  })

  it('says of a Harness that uses only its own models that it does not, never that it is unfinished', () => {
    const info = testHarness('claude-agent', { label: 'Claude Agent' })
    info.capabilities.models = { ...info.capabilities.models, wires: [], ownOnly: true }
    expect(unusableServices(catalogOf(info), info).map(item => item.reason)).toEqual(Array(3).fill('Claude Agent 不经 Latch 用模型服务'))
  })

  it('keeps the rule that a session stays on the service it started with, with its reason', () => {
    const info = codex()
    const route = { providerId: 'openai', model: 'openai-model', name: 'OpenAI' }
    const other = service('relay', 'Relay', 'openai-responses')
    const catalog = catalogOf(info, { providers: [openai, other, deepseek] })
    const groups = ownModelGroups(catalog, info, [{ value: 'openai-model', label: 'openai-model' }], { route })
    expect(groups.at(-1)).toMatchObject({
      label: '模型服务',
      options: [{ label: 'Relay', disabledReason: '换服务要新开会话：开始时确认的是这个服务。' }],
    })
    // The session's own service is never among the ones it cannot use.
    expect(unusableServices(catalog, info, undefined, { route }).map(item => item.name)).toEqual(['DeepSeek'])
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
    const html = renderToStaticMarkup(createElement(UnusableServices, { services: unusableServices(catalogOf(codex()), codex()) }))
    expect(html).toContain('另有 2 个模型服务，这个 Harness 用不了')
    expect(html).not.toContain('DeepSeek')
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
    expect(html).toContain('另有 2 个模型服务，这个 Harness 用不了')
    expect(html.indexOf('另有 2 个')).toBeGreaterThan(html.indexOf('经 Latch'))
  })
})

describe("Latch's own sentences on another computer's page", () => {
  it('names the computer where the app on that Mac says 这台 Mac', () => {
    expect(onComputer('能读写这台 Mac 上的文件并运行命令', 'studio-mini')).toBe('能读写 studio-mini 上的文件并运行命令')
    expect(onComputer('能读写这台 Mac 上的文件并运行命令', undefined)).toBe('能读写这台 Mac 上的文件并运行命令')
    expect(ROUTE_NOTE('Codex', 'studio-mini')).toBe(
      '「经 Latch」表示请求由 Latch 在 studio-mini 上转发，用设置里的密钥。Codex 有一整轮没有经过 Latch 时，会话里会告诉你。',
    )
  })
})

describe('the keys on the menu titles', () => {
  it('are drawn only in the desktop app, whose keys are settled', () => {
    expect(controlKeyCaps('model')).toBeUndefined()
    vi.stubGlobal('window', { latchShell: { kind: 'electron', platform: 'darwin' } })
    expect(controlKeyCaps('harness')).toEqual(['⌥', '⌘', '1'])
    expect(controlKeyText('permission')).toBe('⌥⌘4')
    const html = renderToStaticMarkup(
      createElement(PermissionList, {
        view: { label: '先问你', line: '', icon: 'shield', amber: false },
        onChoose() {},
      }),
    )
    expect(html).toMatch(/什么时候问你？<\/span><span class="menu-title-keys"[^>]*>(<kbd class="ui-kbd">[^<]+<\/kbd>){3}/u)
  })
})

describe('分叉 in the session Harness popover', () => {
  const render = (fork?: Parameters<typeof SessionHarnessControl>[0]['fork']) =>
    renderToStaticMarkup(createElement(SessionHarnessControl, { harness: codex(), onNewSession() {}, fork }))

  it('offers a fork of the latest turn that may change Harness, and says files are not copied or rolled back', () => {
    const html = render({ onFork() {} })
    expect(html).toContain('从最后一轮分叉，可以换 Harness；文件不会复制或回滚。')
    expect(html).not.toContain('aria-disabled')
  })

  it('stays readable but off while the latest turn runs, with the reason', () => {
    const html = render({ onFork() {}, blocked: FORK_BUSY })
    expect(html).toMatch(/aria-disabled="true"[^>]*>.*请等这一轮结束后再从这里分叉/su)
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
