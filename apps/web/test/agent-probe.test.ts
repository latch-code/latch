import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AGENT_PRESETS, type AgentPresetSettings, type AgentProbeResult, type AgentSettings } from '@latch/protocol'
import { AgentProbe, probeRowDescription } from '../src/settings/AgentProbe.tsx'
import { presetGroups } from '../src/settings/AgentsSettings.tsx'
const base: AgentProbeResult = {
  status: 'ready',
  checkedAt: '2026-10-25T06:00:00.000Z',
  launchHash: 'a'.repeat(64),
  capabilities: { images: true, resume: true, load: false, additionalDirectories: false },
  authMethods: [{ name: '终端登录' }],
  agent: { name: 'Codex', version: '1.0.0' },
}
const agent = (result?: AgentProbeResult): AgentSettings => ({
  id: 'fake',
  name: 'Fake',
  command: 'fake',
  args: [],
  envKeys: [],
  enabled: true,
  verified: false,
  detected: { found: true },
  ...(result ? { lastProbe: result } : {}),
})
const render = (result?: AgentProbeResult, disabledReason?: string) =>
  renderToStaticMarkup(createElement(AgentProbe, { agent: agent(result), disabledReason, onSaved: () => {} }))
describe('Agent diagnostic presentation', () => {
  it('labels an initialize success honestly even when login methods are advertised', () => {
    const html = render(base)
    expect(html).toContain('启动握手成功')
    expect(html).toContain('登录状态与模型访问尚未验证。')
    expect(html).toContain('声明支持：图片、恢复会话')
    expect(html).toContain('终端登录')
    expect(html).not.toContain('需要先登录')
  })
  it('says while it runs only how long it waits, since a probe asks for no confirmation', () => {
    expect(probeRowDescription(undefined, true)).toBe('最多等待 20 秒。')
    expect(probeRowDescription(base, true)).toBe('最多等待 20 秒。')
  })
  it('explains why a device cannot run the test without suggesting it can', () => {
    const html = render(undefined, '这台设备没有管理这台 Mac 的权限。')
    expect(html).toContain('没有管理这台 Mac 的权限')
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('尚未测试启动')
  })
  it('shows only the explicit authentication-required result as needing login', () => {
    expect(render({ ...base, status: 'authentication-required', authMethods: [] })).toContain('需要先登录')
  })
  it('renders diagnostics as text with hidden characters exposed and offers a bounded copy action', () => {
    const html = render({ ...base, status: 'failed', diagnostic: '<script>bad()</script>\nleft\u202eright' })
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('\\u{202E}')
    expect(html).toContain('复制诊断')
  })
})

describe('Harness presets in settings', () => {
  const preset = (id: string, found?: boolean) =>
    ({ ...AGENT_PRESETS.find(item => item.id === id)!, ...(found === undefined ? {} : { detected: { found } }) }) as AgentPresetSettings

  it('stands a found preset with what is installed, never under 可以安装', () => {
    const { found, installable } = presetGroups([preset('codex', true), preset('pi', false), preset('goose')], [])
    expect(found.map(item => item.id)).toEqual(['codex'])
    expect(presetGroups([preset('codex', true)], [{ presetId: 'codex', account: true }]).found).toHaveLength(1)
    expect(installable.map(item => item.id)).toEqual(['pi', 'goose'])
  })

  it('leaves out a preset that already has a definition, found or not', () => {
    const { found, installable } = presetGroups([preset('codex', true), preset('pi', false)], [{ presetId: 'codex' }, { presetId: 'pi' }])
    expect(found).toEqual([])
    expect(installable).toEqual([])
  })
})
