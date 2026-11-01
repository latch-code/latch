import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceAccess } from '../src/core/permissions.ts'
import { DEVICES_COPY, ENROLLMENT_COPY, NATIVE_LINK_COPY } from '../src/core/securityCopy.ts'
import type { AgentPreset, AgentSettings, AppSnapshot } from '@latch/protocol'
import { AboutSettings } from '../src/settings/AboutSettings.tsx'
import { AgentRow, engineGroups, missingText } from '../src/settings/AgentsSettings.tsx'
import { usageTotal } from '../src/settings/UsageSettings.tsx'
import { ProjectRow } from '../src/settings/WorkspacesSettings.tsx'

const noop = () => {}
afterEach(() => {
  vi.unstubAllGlobals()
})
/** An adapter preset's detection: the adapter `found`, and the agent it connects to when `companion` is given. */
const adapter = (found: boolean, companion?: boolean) => ({
  command: 'pi-acp',
  detected: { found, ...(companion === undefined ? {} : { companion: { command: 'pi', found: companion } }) },
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
      command: 'pi-acp',
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
    for (const text of [NATIVE_LINK_COPY.scan, NATIVE_LINK_COPY.sameWifi, DEVICES_COPY.pairElsewhere, ENROLLMENT_COPY.invitationRequired]) {
      expect(text).not.toMatch(FLAG)
      expect(text).not.toContain('pnpm ')
    }
  })

  it('tells nothing of codes, countdowns, addresses, scopes or fingerprints on the page or in the sheet', () => {
    // 关于连接 is the one place that may name the relay.
    const { aboutBody: _about, savedRelay: _relay, ...page } = DEVICES_COPY
    const words = JSON.stringify([page, NATIVE_LINK_COPY, ENROLLMENT_COPY.waiting, ENROLLMENT_COPY.compare, ENROLLMENT_COPY.submit])
    for (const word of ['六位', '核对码', '指纹', '剩余', '直连', '中继', '局域网', '证书', '权限', 'HTTPS'])
      expect(words).not.toContain(word)
  })
})

describe('agent settings', () => {
  it('names both programs when an adapter preset is missing one of them', () => {
    const agent = adapter
    expect(missingText(agent(true))).toBeUndefined()
    expect(missingText(agent(false))).toBe('未找到命令 pi-acp')
    expect(missingText(agent(true, true))).toBeUndefined()
    expect(missingText(agent(true, false))).toBe('已找到适配器 pi-acp，还没找到 pi')
    expect(missingText(agent(false, true))).toBe('已安装 pi，还差让 Latch 连接它的适配器 pi-acp')
    expect(missingText(agent(false, false))).toBe('未找到 pi 和它的适配器 pi-acp')
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
