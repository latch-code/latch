import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentProbeResult, AgentSettings, TaskSummary } from '@latch/protocol'
import { agentUsage } from '../src/settings/AgentsSettings.tsx'
import { AgentProbe } from '../src/settings/AgentProbe.tsx'
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
  it('counts visible snapshot sessions by harness and uses their latest valid activity timestamp', () => {
    const tasks: TaskSummary[] = [
      { id: 'first', title: 'First', status: 'idle', harnessId: 'fake', updatedAt: '2026-10-24T06:00:00.000Z' },
      { id: 'second', title: 'Second', status: 'idle', harnessId: 'fake', updatedAt: '2026-10-25T06:00:00.000Z' },
      { id: 'elsewhere', title: 'Elsewhere', status: 'idle', harnessId: 'other', updatedAt: '2026-10-26T06:00:00.000Z' },
    ]
    expect(agentUsage(tasks, 'fake')).toEqual({ count: 2, lastUsedAt: '2026-10-25T06:00:00.000Z' })
    expect(agentUsage([], 'fake')).toEqual({ count: 0 })
  })

  it('labels an initialize success honestly even when login methods are advertised', () => {
    const html = render(base)
    expect(html).toContain('启动握手成功')
    expect(html).toContain('登录状态与模型访问尚未验证。')
    expect(html).toContain('声明支持：图片、恢复会话')
    expect(html).toContain('终端登录')
    expect(html).not.toContain('需要先登录')
  })
  it('explains where a remote device must go without suggesting it can run the test', () => {
    const html = render(undefined, '测试启动只能在运行 Latch 的电脑上，通过桌面端进行。')
    expect(html).toContain('通过桌面端进行')
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
