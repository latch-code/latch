import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isUnpinnedRunner, type AppSnapshot, type HarnessInfo, type McpHttpServerView, type McpServerView } from '@latch/protocol'
import { agentServers, harnessNote } from '../src/agents/McpSection.tsx'
import { detailsLeftOut } from '../src/components/InlineConfirm.tsx'
import { MCP_LOGIN_FAILURE_TEXT, McpStatusWord, mcpStatus, remoteUrl, scopeText } from '../src/settings/McpSettings.tsx'

const AGENT = `agt_${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`

function server(change: Partial<McpServerView> = {}): McpServerView {
  // A local command unless the change says otherwise; tests of a remote one pass its fields.
  return {
    id: `mcp_${'A'.repeat(22)}`,
    name: 'github',
    transport: 'stdio',
    command: '/opt/homebrew/bin/npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: [{ name: 'GITHUB_TOKEN', set: true, secret: true }],
    projectCwd: false,
    scope: { all: true, agents: [], projects: [] },
    enabled: true,
    disabledTools: [],
    revision: 1,
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
    ...change,
  } as McpServerView
}

const snapshot = {
  customAgents: [{ id: AGENT, name: '审阅员' }],
  catalog: {
    workspaces: [
      { id: 'default', name: '' },
      { id: 'web', name: 'Web 前端' },
    ],
  },
} as unknown as AppSnapshot

describe('设置 › MCP', () => {
  it('says a server’s state in a word: off, not tested, usable with the tools left on, or failed with why', () => {
    expect(mcpStatus(server({ enabled: false }))).toEqual({ tone: 'neutral', text: '已停用' })
    expect(mcpStatus(server())).toEqual({ tone: 'neutral', text: '未测试' })
    const report = { status: 'ok' as const, tools: ['a', 'b', 'c'], at: '2026-11-13T00:00:00.000Z', via: 'test' as const }
    expect(mcpStatus(server({ report, disabledTools: ['b'] }))).toEqual({ tone: 'done', text: '可用 · 2 个工具' })
    const failed = { ...report, status: 'failed' as const, tools: [], reason: 'timeout' as const }
    expect(mcpStatus(server({ report: failed }))).toEqual({ tone: 'failed', text: '失败', reason: '没有在时限内完成初始化' })
    expect(renderToStaticMarkup(createElement(McpStatusWord, { server: server({ report: failed }) }))).toContain('data-tone="failed"')
    // A remote server that asks for a login waits for the person, in amber.
    const login = { ...failed, reason: 'auth-required' as const }
    expect(mcpStatus(server({ report: login }))).toEqual({ tone: 'warn', text: '需要登录' })
  })

  it('says a remote server’s login in a word: 未登录, 登录中, 已登录, 需要重新登录, or 登录失败 with why', () => {
    const remote = (oauth: McpHttpServerView['oauth'], change: Partial<McpHttpServerView> = {}) =>
      server({ transport: 'http', url: 'https://mcp.example.com/mcp', headers: [], oauth, ...change } as Partial<McpServerView>)
    expect(mcpStatus(remote({ state: 'signed-out' }))).toEqual({ tone: 'warn', text: '未登录' })
    expect(mcpStatus(remote({ state: 'signing-in' }))).toEqual({ tone: 'running', text: '登录中' })
    expect(mcpStatus(remote({ state: 'failed', reason: 'issuer' }))).toEqual({
      tone: 'failed',
      text: '登录失败',
      reason: '回调不是来自确认过的授权服务器',
    })
    expect(mcpStatus(remote({ state: 'relogin', reason: 'refresh' }))).toEqual({ tone: 'warn', text: '需要重新登录', reason: '续期被拒绝' })
    // Logged in: the login itself until a test or a session says more, then the tools.
    expect(mcpStatus(remote({ state: 'signed-in' }))).toEqual({ tone: 'done', text: '已登录' })
    const report = { status: 'ok' as const, tools: ['a'], at: '2026-11-13T00:00:00.000Z', via: 'test' as const }
    expect(mcpStatus(remote({ state: 'signed-in' }, { report }))).toEqual({ tone: 'done', text: '可用 · 1 个工具' })
    // Switched off says so first; every reason has words.
    expect(mcpStatus(remote({ state: 'signed-out' }, { enabled: false }))).toEqual({ tone: 'neutral', text: '已停用' })
    for (const text of Object.values(MCP_LOGIN_FAILURE_TEXT)) expect(text.length).toBeGreaterThan(0)
    // 退出登录 that could not delete the tokens from this Mac says exactly that, even over a login that still stands.
    expect(mcpStatus(remote({ state: 'failed', reason: 'delete' }))).toEqual({ tone: 'failed', text: '没能删除这台 Mac 上的登录' })
  })

  it('lists a login’s authorization server and every scope in the confirmation, though the sentence was not cut', () => {
    const scopes = Array.from({ length: 64 }, (_, index) => `scope-${index}`).join(' ')
    const ticket = {
      reason: '让 Latch 连接 auth.example.com:443（MCP 服务器「docs」）',
      lines: [
        { label: '授权服务器', value: 'https://auth.example.com' },
        { label: '范围', value: `64 个：${scopes}` },
      ],
    } as unknown as Parameters<typeof detailsLeftOut>[0]
    expect(detailsLeftOut(ticket).map(line => line.value)).toEqual(['https://auth.example.com', `64 个：${scopes}`])
    // Any other confirmation keeps its rule: the lines show only when the sentence was cut.
    const plain = {
      reason: '让 Latch 连接 mcp.example.com:443（MCP 服务器「docs」）',
      lines: [{ label: '地址', value: 'https://mcp.example.com/mcp' }],
    }
    expect(detailsLeftOut(plain as unknown as Parameters<typeof detailsLeftOut>[0])).toEqual([])
  })

  it('takes https:// addresses, and http:// only on this Mac’s loopback, never with a query or credentials', () => {
    for (const url of ['https://mcp.example.com/mcp', 'http://127.0.0.1:3845/mcp', 'http://localhost:8080/', 'http://[::1]:9/x'])
      expect(remoteUrl(url), url).toBe(true)
    for (const url of [
      'http://example.com/mcp',
      'http://192.168.1.2/mcp',
      'https://a.b/mcp?token=x',
      'https://u:p@a.b/',
      'ftp://a.b/',
      'mcp',
    ])
      expect(remoteUrl(url), url).toBe(false)
  })

  it('names 「用在」 by the Agents and projects chosen', () => {
    expect(scopeText({ all: true, agents: [], projects: [] }, snapshot)).toBe('所有会话')
    expect(scopeText({ all: false, agents: [AGENT], projects: ['web'] }, snapshot)).toBe('审阅员、Web 前端')
    expect(scopeText({ all: false, agents: [AGENT], projects: ['web', 'default'] }, snapshot)).toBe('审阅员、Web 前端 等 3 处')
    expect(scopeText({ all: false, agents: [], projects: [] }, snapshot)).toBe('还没有选')
  })

  it('warns only of a package runner whose package names no version', () => {
    expect(isUnpinnedRunner('/opt/homebrew/bin/npx', ['-y', '@modelcontextprotocol/server-github'])).toBe(true)
    expect(isUnpinnedRunner('npx', ['-y', '@modelcontextprotocol/server-github@1.2.3'])).toBe(false)
    expect(isUnpinnedRunner('npx', ['server@latest'])).toBe(true)
    expect(isUnpinnedRunner('uvx', ['mcp-server-git'])).toBe(true)
    expect(isUnpinnedRunner('uvx', ['mcp-server-git==0.6.2'])).toBe(false)
    expect(isUnpinnedRunner('/usr/local/bin/server', ['--stdio'])).toBe(false)
  })
})

describe('the Agent profile’s MCP', () => {
  it('lists the servers its sessions get: every-session ones and those chosen for it', () => {
    const all = server()
    const mine = server({ id: `mcp_${'B'.repeat(22)}`, name: 'linear', scope: { all: false, agents: [AGENT], projects: [] } })
    const other = server({ id: `mcp_${'C'.repeat(22)}`, name: 'sentry', scope: { all: false, agents: [], projects: ['web'] } })
    expect(agentServers([all, mine, other], AGENT).map(item => item.name)).toEqual(['github', 'linear'])
  })

  it('says the built-in Harness takes remote addresses only, and a Harness without MCP that it takes none', () => {
    const acp = { id: 'claude', skills: 'server' } as HarnessInfo
    expect(harnessNote(acp, false)).toBeUndefined()
    expect(harnessNote({ id: 'standard', skills: 'native' } as HarnessInfo, true)).toBe('内置 Harness 只用远程地址')
    expect(harnessNote({ id: 'pi' } as HarnessInfo, false)).toBe('这个 Harness 不接收 MCP 服务器')
  })
})
