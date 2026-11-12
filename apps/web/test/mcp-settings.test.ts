import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isUnpinnedRunner, type AppSnapshot, type HarnessInfo, type McpServerView } from '@latch/protocol'
import { agentServers, harnessNote } from '../src/agents/McpSection.tsx'
import { McpStatusWord, mcpStatus, scopeText } from '../src/settings/McpSettings.tsx'

const AGENT = `agt_${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`

function server(change: Partial<McpServerView> = {}): McpServerView {
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
  }
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

  it('says the built-in Harness does not take local commands yet, and a Harness without MCP that it takes none', () => {
    const acp = { id: 'claude', skills: 'server' } as HarnessInfo
    expect(harnessNote(acp, false)).toBeUndefined()
    expect(harnessNote({ id: 'standard', skills: 'native' } as HarnessInfo, true)).toBe('内置 Harness 尚未支持 MCP 命令')
    expect(harnessNote({ id: 'pi' } as HarnessInfo, false)).toBe('这个 Harness 不接收 MCP 服务器')
  })
})
