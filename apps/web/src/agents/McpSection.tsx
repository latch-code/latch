import { useCallback, useEffect, useState } from 'react'
import type { HarnessInfo, McpServerView, McpServersResponse } from '@latch/protocol'
import { Hint, InlineNotice, Switch } from '@latch/ui'
import { api, inlineError, newRequestId } from '../core/api.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { McpStatusWord } from '../settings/McpSettings.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    builtInRemote: '内置 Harness 只用远程地址',
    unsupported: '这个 Harness 不接收 MCP 服务器',
    builtInDetail:
      '命令交给 Claude Agent、Codex 等外部 Harness；内置 Harness 要由 Latch 自己在这台 Mac 上运行命令，尚未实现。远程地址由 Latch 调用，每次都要你确认。',
    piDetail: 'pi 的 RPC 模式不接收 MCP 服务器。',
    settings: '在设置 › MCP 里添加',
    settingsDetail: '这个 Agent 的会话每次启动时拿到这里列出的服务器。挂上或取下只改服务器的「用在」。',
    empty: '没有 MCP 服务器',
    all: '所有会话',
    useFor: (name: string) => `${name} 用在这个 Agent`,
  },
  {
    builtInRemote: 'The built-in Harness uses remote addresses',
    unsupported: 'This Harness cannot receive MCP servers',
    builtInDetail:
      'External Harnesses such as Claude Agent and Codex run commands. To support commands in the built-in Harness, Latch would need to run them on this Mac. That support is not implemented yet. Latch calls remote servers and asks you each time.',
    piDetail: 'pi’s RPC mode does not accept MCP servers.',
    settings: 'Add in Settings › MCP',
    settingsDetail:
      'This Agent’s sessions receive these servers when they start. Adding or removing a server changes where that server is used.',
    empty: 'No MCP servers',
    all: 'All sessions',
    useFor: (name: string) => `Use ${name} for this Agent`,
  },
)

/** The servers an Agent's sessions get: used in every session, or chosen for it. */
export function agentServers(servers: readonly McpServerView[], agentId: string): McpServerView[] {
  return servers.filter(server => server.scope.all || server.scope.agents.includes(agentId))
}

/** What of Latch's servers this Agent's Harness does not get, or undefined when it gets them all. */
export function harnessNote(harness: HarnessInfo | undefined, builtin: boolean): string | undefined {
  if (!harness || harness.skills === 'server') return undefined
  return builtin ? COPY.builtInRemote : COPY.unsupported
}

/**
 * 「MCP」 of an Agent's profile: the servers its sessions get, each with its state; 所有会话 ones say so. The desktop app
 * on this Mac puts a server on this Agent or takes it off, which changes the server's 「用在」 and asks nothing. Adding a
 * server is in 设置 › MCP.
 */
export function McpSection({
  agentId,
  harness,
  builtin,
  access,
  disabled,
  assignable = true,
}: {
  agentId: string
  harness: HarnessInfo | undefined
  builtin: boolean
  access: Pick<DeviceAccess, 'local' | 'admin' | 'scopes'>
  disabled: boolean
  /** 通用 receives servers scoped to every session; it is not a custom Agent scope. */
  assignable?: boolean
}) {
  const [data, setData] = useState<McpServersResponse | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const canRead = access.scopes.has('view')
  const canAttach = assignable && access.local && access.admin
  const load = useCallback(async () => {
    try {
      setData(await api<McpServersResponse>('mcp/servers'))
    } catch (cause) {
      setError(inlineError(cause))
    }
  }, [])
  useEffect(() => {
    if (canRead) void load()
  }, [canRead, load])
  if (!canRead || data === null) return null
  const used = agentServers(data.servers, agentId)
  const others = canAttach ? data.servers.filter(server => !used.includes(server)) : []
  const note = harnessNote(harness, builtin)
  const attach = async (server: McpServerView, on: boolean) => {
    setBusy(server.id)
    setError('')
    try {
      const agents = on ? [...server.scope.agents, agentId] : server.scope.agents.filter(id => id !== agentId)
      await api(`mcp/servers/${encodeURIComponent(server.id)}`, {
        method: 'PATCH',
        body: { requestId: newRequestId(), baseRevision: server.revision, scope: { ...server.scope, agents } },
      })
      await load()
    } catch (cause) {
      setError(inlineError(cause))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="agent-profile-section agent-mcp" aria-label="MCP" role="group">
      <header className="agent-profile-heading">
        <h3>MCP</h3>
        {note ? (
          <Hint label={note}>{builtin ? COPY.builtInDetail : COPY.piDetail}</Hint>
        ) : (
          <Hint label={COPY.settings}>{COPY.settingsDetail}</Hint>
        )}
      </header>
      {used.length === 0 && others.length === 0 && <p className="agent-mcp-empty">{COPY.empty}</p>}
      <ul className="agent-mcp-list">
        {[...used, ...others].map(server => {
          const chosen = server.scope.agents.includes(agentId)
          return (
            <li key={server.id} data-mcp-server={server.name} data-dim={!used.includes(server) || !server.enabled ? '' : undefined}>
              <span className="agent-mcp-name">{server.name}</span>
              {server.scope.all ? <span className="agent-mcp-tag">{COPY.all}</span> : <McpStatusWord server={server} />}
              {canAttach && !server.scope.all && (
                <Switch
                  label={COPY.useFor(server.name)}
                  checked={chosen}
                  disabled={disabled || busy !== null}
                  onCheckedChange={on => {
                    void attach(server, on)
                  }}
                />
              )}
            </li>
          )
        })}
      </ul>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </div>
  )
}
