import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceAccess } from '../src/core/permissions.ts'
import { DEVICES_COPY, ENROLLMENT_COPY, NATIVE_LINK_COPY } from '../src/core/securityCopy.ts'
import { PROVIDER_PRESETS, type AgentPreset, type AgentSettings, type AppSnapshot } from '@latch/protocol'
import { AboutSettings } from '../src/settings/AboutSettings.tsx'
import { AgentRow, engineGroups, missingText } from '../src/settings/AgentsSettings.tsx'
import { PresetGrid, protocolChoices, ProviderAddForm } from '../src/settings/ProvidersSettings.tsx'
import { ProviderSetupPanel } from '../src/components/SetupPanels.tsx'
import { SERVICE_FORM } from '../src/core/providerSetup.ts'
import { usageTotal } from '../src/settings/UsageSettings.tsx'
import { ProjectRow } from '../src/settings/WorkspacesSettings.tsx'

const noop = () => {}
afterEach(() => {
  vi.unstubAllGlobals()
})
/** An adapter preset's detection: the adapter `found`, and the program it drives when `program` is given. */
const adapter = (found: boolean, program?: boolean) => ({
  command: 'codex-acp',
  detected: { found, ...(program === undefined ? {} : { agent: { command: 'codex', found: program } }) },
})

describe('about', () => {
  const snapshot = (presence: { status: 'available' | 'unavailable'; message?: string }) =>
    ({ version: '1', host: { hostId: 'h', presence, devMode: false } }) as unknown as AppSnapshot
  const render = (value: AppSnapshot) => renderToStaticMarkup(createElement(AboutSettings, { snapshot: value, access: { legacy: false } }))

  it('says when this Mac cannot confirm, and is quiet when it can', () => {
    expect(render(snapshot({ status: 'unavailable', message: '确认组件已变化' }))).toContain('确认组件已变化')
    expect(render(snapshot({ status: 'available' }))).not.toContain('暂时不能确认')
  })
})

describe('engine rows', () => {
  const agent = (overrides: Partial<AgentSettings>) =>
    ({
      id: 'a',
      name: 'pi',
      presetId: 'pi',
      enabled: true,
      verified: true,
      command: 'pi',
      args: [],
      detected: { found: true },
      ...overrides,
    }) as AgentSettings
  const row = (value: AgentSettings) =>
    renderToStaticMarkup(
      createElement(AgentRow, {
        agent: value,
        preset: { id: 'pi', description: '预设的说明' } as AgentPreset,
        busy: false,
        onOpen: noop,
        onToggle: noop,
      }),
    )

  it('shows what an altered definition really runs, not the description of the preset it left', () => {
    expect(row(agent({}))).toContain('预设的说明')
    const altered = row(agent({ verified: false, command: '/tmp/other', args: ['--flag'] }))
    expect(altered).toContain('未验证的定义')
    expect(altered).toContain('/tmp/other --flag')
    expect(altered).not.toContain('预设的说明')
  })

  it('keeps a definition whose program is missing out of 已安装', () => {
    const missing = agent({ id: 'b', detected: { found: false } })
    expect(engineGroups([agent({}), missing])).toEqual({ installed: [agent({})], missing: [missing] })
  })
})

describe('phone pairing', () => {
  const access = (local: boolean, admin = true): DeviceAccess => ({
    legacy: false,
    local,
    scopes: new Set(admin ? ['view', 'admin'] : ['view']),
    admin,
    device: null,
  })
  const FLAG = /(?:^|[\s「（(])--[a-z]/u

  it('never names a flag or a command in the words a person holding a phone reads', () => {
    for (const text of [
      NATIVE_LINK_COPY.scan,
      NATIVE_LINK_COPY.sameWifi,
      DEVICES_COPY.pairElsewhere(),
      ENROLLMENT_COPY.invitationRequired,
    ]) {
      expect(text).not.toMatch(FLAG)
      expect(text).not.toContain('pnpm ')
    }
  })

  it('tells nothing of codes, countdowns, addresses, scopes or fingerprints on the page or in the sheet', () => {
    // 关于连接 is the one place that may name the relay.
    const { aboutBody: _about, savedRelay: _relay, ...page } = DEVICES_COPY
    const words = JSON.stringify([
      page,
      NATIVE_LINK_COPY,
      ENROLLMENT_COPY.waiting,
      ENROLLMENT_COPY.compare,
      ENROLLMENT_COPY.desktopFirst,
      ENROLLMENT_COPY.desktopSubmit,
    ])
    for (const word of ['六位', '核对码', '指纹', '剩余', '直连', '中继', '局域网', '证书', '权限', 'HTTPS'])
      expect(words).not.toContain(word)
  })
})

describe('agent settings', () => {
  it('says when only the adapter of an installed program is missing', () => {
    expect(missingText(adapter(true))).toBeUndefined()
    expect(missingText(adapter(false))).toBe('未找到命令 codex-acp')
    expect(missingText(adapter(true, false))).toBeUndefined()
    expect(missingText(adapter(false, true))).toBe('已安装 codex，还差让 Latch 连接它的适配器 codex-acp')
    expect(missingText(adapter(false, false))).toBe('未找到命令 codex-acp')
  })
})

describe('service protocols', () => {
  const preset = (id: string) => PROVIDER_PRESETS.find(item => item.id === id)

  it('starts an OpenAI service on Responses and still offers Chat Completions', () => {
    expect(protocolChoices(preset('openai'))).toEqual(['openai-responses', 'openai-compatible'])
  })

  it('offers every protocol to a custom service and none to choose for a single-protocol preset', () => {
    expect(protocolChoices(preset('custom'))).toEqual(['openai-compatible', 'openai-responses', 'anthropic', 'gemini'])
    expect(protocolChoices(undefined)).toEqual(['openai-compatible', 'openai-responses', 'anthropic', 'gemini'])
    expect(protocolChoices(preset('deepseek'))).toEqual(['openai-compatible'])
    expect(protocolChoices(preset('gemini'))).toEqual(['gemini'])
  })

  it('keeps a saved protocol its preset no longer lists, first, so the page never shows another', () => {
    expect(protocolChoices(preset('deepseek'), 'gemini')).toEqual(['gemini', 'openai-compatible'])
    expect(protocolChoices(preset('openai'), 'openai-compatible')).toEqual(['openai-responses', 'openai-compatible'])
  })
})

describe('the add-service form', () => {
  const preset = (id: string) => PROVIDER_PRESETS.find(item => item.id === id)!
  const data = { providers: [], presets: PROVIDER_PRESETS, confirmedAddresses: [] }
  const thisMac = { keys: true, confirm: true, offline: false }
  const visible = (html: string) => html.replace(/<[^>]+>/gu, '').trim()
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/gsu)].map(match => visible(match[1]!))
  /** Each field's label: the first text in its `<label>`, before the hint or the options. */
  const labels = (html: string) => [...html.matchAll(/<label[^>]*>(?:<[^>]+>)*([^<]+)/gsu)].map(match => match[1]!.trim())
  /** The form as the settings dialog draws it (`compact` false) and as the in-place panels do. */
  const form = (id: string, compact: boolean, abilities = thisMac, computer?: string) =>
    renderToStaticMarkup(
      createElement(ProviderAddForm, {
        preset: preset(id),
        data,
        abilities,
        compact,
        ...(computer ? { computer } : {}),
        onConfirmed: noop,
        onSaved: noop,
        onCancel: noop,
      }),
    )

  it('ends both service grids with the same custom choice, and names the panel as the dialog', () => {
    const grid = buttons(renderToStaticMarkup(createElement(PresetGrid, { presets: PROVIDER_PRESETS, onPick: noop })))
    // The custom preset sits anywhere in the Host's list; the grid still ends with it.
    const shuffled = [preset('custom'), ...PROVIDER_PRESETS.filter(item => item.id !== 'custom')]
    const panelHtml = renderToStaticMarkup(
      createElement(ProviderSetupPanel, { access: { legacy: false, local: true, admin: true }, onSaved: noop }),
    )
    expect(grid.at(-1)).toBe(SERVICE_FORM.custom)
    expect(buttons(renderToStaticMarkup(createElement(PresetGrid, { presets: shuffled, onPick: noop }))).at(-1)).toBe(SERVICE_FORM.custom)
    expect(buttons(panelHtml).at(-1)).toBe(SERVICE_FORM.custom)
    expect(panelHtml).toContain(`<h3>${SERVICE_FORM.title}</h3>`)
    expect(SERVICE_FORM).toMatchObject({ title: '添加模型服务', custom: '自定义地址…' })
    expect(panelHtml).not.toContain('其他服务')
  })

  it('draws the same fields and save word in every frame', () => {
    for (const id of ['deepseek', 'custom']) expect(labels(form(id, true))).toEqual(labels(form(id, false)))
    expect(labels(form('deepseek', false))).toEqual(['地址', '密钥'])
    expect(labels(form('custom', false))).toEqual(['名称', '协议', '地址', '密钥'])
    // A known service's address saves its key directly; a local or custom address is confirmed with the save.
    expect(buttons(form('deepseek', true)).slice(-2)).toEqual(['取消', '保存'])
    expect(buttons(form('deepseek', false)).slice(-2)).toEqual(['取消', '保存'])
    expect(buttons(form('ollama', true)).slice(-2)).toEqual(['取消', '用 Touch ID 保存'])
    expect(buttons(form('ollama', false)).slice(-2)).toEqual(['取消', '用 Touch ID 保存'])
    expect(form('ollama', true) + form('deepseek', true)).not.toContain('保存并使用')
  })

  it('names the computer where another device types the key, and draws no key field there', () => {
    const remote = form('deepseek', false, { keys: false, confirm: false, offline: false }, 'Studio')
    expect(remote).toContain('保存后，在 Studio 上的 Latch 里填写密钥')
    expect(remote).not.toContain('type="password"')
    expect(labels(remote)).toEqual(['地址'])
  })
})

describe('workspace settings', () => {
  it('lists a workspace the Host disabled with its reason and keeps the remove action', () => {
    const reason = '该目录位于受保护目录（如 .git）内，不能作为项目'
    const html = renderToStaticMarkup(
      createElement(ProjectRow, {
        workspace: { id: 'w1', name: 'hooks', path: '/w/.git/hooks', unavailable: reason },
        owner: true,
        isDefault: false,
        folders: null,
        onRemove: noop,
      }),
    )
    expect(html).toContain('<span class="ui-status-word" data-tone="warn">不可用</span>')
    expect(html).toContain(`<span class="workspace-unavailable">${reason}</span>`)
    // Removing is in the project's ⋯ menu.
    expect(html).toContain('aria-label="hooks 的操作"')
    const usable = renderToStaticMarkup(
      createElement(ProjectRow, {
        workspace: { id: 'w2', name: 'app', path: '/w/app' },
        owner: false,
        isDefault: true,
        folders: null,
        onRemove: noop,
      }),
    )
    expect(usable).not.toMatch(/不可用|的操作/)
    expect(usable).toContain('默认')
  })
})

describe('the usage total', () => {
  it('adds input and output across the rows', () => {
    const row = (inputTokens: number, outputTokens: number) => ({
      harnessId: 'standard',
      source: 'provider' as const,
      messages: 1,
      usage: { inputTokens, outputTokens },
      partial: { cacheReadTokens: false, cacheWriteTokens: false, reasoningTokens: false },
    })
    expect(usageTotal([row(100, 20), row(5, 1)])).toBe(126)
  })
})
