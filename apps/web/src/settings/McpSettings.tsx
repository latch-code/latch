import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Cable } from 'lucide-react'
import {
  escapeSecurityText,
  isLoopbackHost,
  isMcpHeaderName,
  driverTelemetryOff,
  isMcpServerName,
  isMcpToolOn,
  isUnpinnedRunner,
  type AppSnapshot,
  type McpComputerCheck,
  type McpFailure,
  type McpHttpServerView,
  type McpOAuthFailure,
  type McpScope,
  type McpServerView,
  type McpServersResponse,
  type McpStdioServerView,
} from '@latch/protocol'
import {
  Badge,
  Button,
  Checkbox,
  CopyButton,
  Dialog,
  GlobeGlyph,
  LaptopGlyph,
  RefreshGlyph,
  Hint,
  InlineNotice,
  SegmentedControl,
  StatusWord,
  Switch,
  SwitchRow,
  TextAreaField,
  TextField,
  TerminalGlyph,
  WarningGlyph,
  Icon,
  type StatusTone,
} from '@latch/ui'
import { api, ApiError, errorMessage, inlineError, newRequestId } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { deviceAccess } from '../core/permissions.ts'
import { currentShell } from '../core/shell.ts'
import { ConfirmDialog } from '../components/overlays.tsx'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { TerminalFillButton } from '../components/TerminalFillButton.tsx'
import { dateTime } from '../format.ts'
import { IconTile, Loading, MiddleEllipsis, NoteLine, ObjectRow, SettingsGroup, SettingsRow } from './common.tsx'
import { SettingsPages, type SettingsLevel } from './navigation.tsx'
import { HarnessesMcp } from './HarnessMcp.tsx'
import { ImportDialog, importedForm } from './McpImport.tsx'

export const MCP_ICON = Cable

/** Why a server did not come up, in a few words; the detail is the server's own and stays on the Mac. */
export const MCP_FAILURE_TEXT: Readonly<Record<McpFailure, string>> = {
  'spawn-failed': '命令无法启动',
  exited: '进程已退出',
  timeout: '没有在时限内完成初始化',
  protocol: '回答不是 MCP',
  'list-failed': '没有列出工具',
  'output-too-large': '输出过大',
  'auth-required': '需要登录',
  unreachable: '无法连接',
  refused: 'Latch 没有连接这个地址',
}

const RUNS_AS_YOU = {
  label: '以你的身份运行',
  detail:
    '命令由 Agent 一侧的 latch-mcp 启动，以你的身份运行，Latch 不隔离它。经 Latch 的每次调用都有记录；Harness 自己的 MCP 不经过 Latch。',
}
/** Why a login did not finish or no longer holds: Latch's own words, never the authorization server's. */
export const MCP_LOGIN_FAILURE_TEXT: Readonly<Record<McpOAuthFailure, string>> = {
  discovery: '服务器没有说明去哪里登录',
  resource: '服务器说明的资源与它的地址不符',
  metadata: '读不到授权服务器的说明',
  endpoint: '授权服务器的端点不在确认过的地址上',
  pkce: '授权服务器不支持 PKCE',
  'client-required': '需要填写 Client ID',
  registration: '授权服务器没有接受注册',
  state: '回调与这次登录不符',
  issuer: '回调不是来自确认过的授权服务器',
  denied: '登录被拒绝或取消',
  expired: '登录超时',
  exchange: '授权服务器没有发出令牌',
  token: '授权服务器发出的令牌不合格式',
  scope: '范围超出确认过的',
  refused: 'Latch 没有连接这个地址',
  unreachable: '无法连接授权服务器',
  cancelled: '登录已取消',
  audit: '记录写不进',
  refresh: '续期被拒绝',
  rejected: '服务器不再接受这次登录',
  delete: '没能删除这台 Mac 上的登录',
}
const LOGIN_NOTE = {
  label: '令牌只留在这台 Mac',
  detail:
    'Latch 在系统浏览器里登录，令牌只存在这台 Mac 上，只发往这个地址与确认过的授权服务器，不交给 Agent 或其他设备。只能在这台 Mac 上登录与退出；移除服务器或退出登录时令牌会被撤销。',
}
const CLIENT_NOTE = '授权服务器不提供自动注册时填写。注册时回调地址填 http://127.0.0.1/callback（任意端口）。'

const REMOTE_NOTE = {
  label: '请求头只留在这台 Mac',
  detail:
    'Latch 是远程地址的客户端：请求头只发往确认过的地址，不交给 Agent，也不跟随重定向。内置 Harness 的每次调用都要你确认；外部 Harness 经 latch-mcp 交给 Latch 调用。经 Latch 的每次调用都有记录。',
}
const BUILTIN_NOTE = {
  label: '内置 Harness 只用远程地址',
  detail:
    '命令交给 Claude Agent、Codex 等外部 Harness；pi 不接收 MCP 服务器。内置 Harness 要由 Latch 自己在这台 Mac 上运行命令，尚未实现；远程地址由 Latch 调用，每次都要你确认。',
}

const COMPUTER_NOTE = {
  label: '以你的身份操作这台 Mac',
  detail:
    '它以你的身份点击、输入和读取这台 Mac 上的 App。这不是沙箱，Latch 不隔离它。先不要让它操作 Electron 应用（包括 Latch 与 VS Code）。Latch 的变量到不了它的后台服务：在终端运行 cua-driver telemetry disable 关掉它的遥测。',
}

/** A command the person runs: copy, and typed in at the prompt of a Latch terminal on this Mac's desktop. */
function CommandActions({ command, label }: { command: string; label: string }) {
  return (
    <span className="command-actions">
      <CopyButton text={command} label={label} />
      <TerminalFillButton command={command} detached />
    </span>
  )
}

/** Cua Driver's own telemetry, which the person switches off in its background service. */
function TelemetryRow({ command }: { command: string }) {
  const line = driverTelemetryOff(command)
  return (
    <SettingsRow
      title="关闭 Driver 的遥测"
      description={<code className="settings-mono">{line}</code>}
      trailing={<CommandActions command={line} label="复制关闭遥测的命令" />}
    />
  )
}

/** 「操控这台 Mac」 in a word: not there, too old, refused, or found with its version. */
export function computerWord(check: McpComputerCheck): { tone: StatusTone; text: string } {
  if (check.state === 'absent') return { tone: 'neutral', text: '未安装' }
  if (check.state === 'old') return { tone: 'warn', text: `版本太旧 · ${check.version ?? ''}` }
  if (check.state === 'refused') return { tone: 'failed', text: check.reason === 'version' ? '读不到版本' : '不是签名的 Cua Driver' }
  return { tone: 'done', text: `已找到 · ${check.version ?? ''}` }
}

/**
 * 「操控这台 Mac」, on this Mac's desktop app only: Cua Driver as Latch found it, with the command that installs or
 * upgrades it (the person runs it), or 添加, which goes through the same confirmation as any local command.
 */
function ComputerGroup({ revision, onAdded }: { revision: number; onAdded: (server: McpServerView) => void }) {
  const [check, setCheck] = useState<McpComputerCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const write = useWrite()
  const read = useCallback(async () => {
    setChecking(true)
    try {
      setCheck(await api<McpComputerCheck>('mcp/computer'))
    } catch {
      // Not on this Mac, or not macOS: no entry at all.
      setCheck(null)
    } finally {
      setChecking(false)
    }
  }, [])
  // Read again whenever the list changes: a removed server makes the entry come back.
  useEffect(() => {
    void read()
  }, [read, revision])
  if (!check || check.added) return null
  const word = computerWord(check)
  const add = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await write('computer', requestId =>
        withConfirmation(confirmation =>
          api<{ server: McpServerView }>('mcp/servers', {
            method: 'POST',
            // Used nowhere until the person chooses where, in 「用在」.
            body: { requestId, baseRevision: revision, preset: 'computer', scope: { all: false, agents: [], projects: [] } },
            ...(confirmation ? { confirmation } : {}),
          }),
        ),
      )
      onAdded(result.server)
    } catch (cause) {
      setError(inlineError(cause))
      void read()
    } finally {
      setBusy(false)
    }
  }
  const command = check.state === 'absent' || check.state === 'old' ? check.install : undefined
  return (
    <SettingsGroup
      title="操控这台 Mac"
      meta={
        <Button variant="ghost" size="xs" icon={RefreshGlyph} loading={checking} onClick={() => void read()}>
          重新检测
        </Button>
      }
      note={<NoteLine brief={COMPUTER_NOTE} />}>
      <div data-mcp-computer={check.state}>
        <SettingsRow
          leading={<IconTile icon={LaptopGlyph} />}
          title="Cua Driver"
          description={
            <StatusWord tone={word.tone} title={check.state === 'old' ? `需要 ${check.minimum} 或更高` : undefined}>
              {word.text}
            </StatusWord>
          }
          trailing={
            check.state === 'ok' ? (
              <Button size="sm" loading={busy} onClick={() => void add()}>
                添加…
              </Button>
            ) : command ? (
              <CommandActions command={command} label={check.state === 'old' ? '复制升级命令' : '复制安装命令'} />
            ) : undefined
          }
        />
        {command && (
          <SettingsRow
            title={check.state === 'old' ? '升级命令' : '安装命令'}
            description={<code className="settings-mono">{command}</code>}
          />
        )}
        {check.state === 'ok' && <TelemetryRow command={check.command} />}
      </div>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <InlineConfirm active={busy} rank={1} />
    </SettingsGroup>
  )
}

/** How a remote server's login stands, in a word: amber waits for the person, red is an attempt that failed. */
export function mcpLoginStatus(server: McpHttpServerView): { tone: StatusTone; text: string; reason?: string } | undefined {
  const oauth = server.oauth
  if (!oauth) return undefined
  // 退出登录 did not get the tokens off this Mac: said as it is, not as a login that failed.
  if (oauth.state === 'failed' && oauth.reason === 'delete') return { tone: 'failed', text: MCP_LOGIN_FAILURE_TEXT.delete }
  if (oauth.state === 'signing-in') return { tone: 'running', text: '登录中' }
  if (oauth.state === 'failed')
    return { tone: 'failed', text: '登录失败', reason: oauth.reason ? MCP_LOGIN_FAILURE_TEXT[oauth.reason] : '' }
  if (oauth.state === 'relogin')
    return { tone: 'warn', text: '需要重新登录', reason: oauth.reason ? MCP_LOGIN_FAILURE_TEXT[oauth.reason] : '' }
  if (oauth.state === 'signed-out') return { tone: 'warn', text: '未登录' }
  return { tone: 'done', text: '已登录' }
}

/** The state word of a server: 已停用, 未测试, 可用 · N 个工具, its login where that waits, or 失败 with the reason. */
export function mcpStatus(server: McpServerView): { tone: StatusTone; text: string; reason?: string } {
  if (!server.enabled) return { tone: 'neutral', text: '已停用' }
  const login = server.transport === 'http' ? mcpLoginStatus(server) : undefined
  // A login that is not there yet says more than the last test does.
  if (login && server.transport === 'http' && server.oauth?.state !== 'signed-in') return login
  const report = server.report
  if (!report) return login ?? { tone: 'neutral', text: '未测试' }
  // A login is something the person does, not a failure.
  if (report.status === 'failed' && report.reason === 'auth-required') return { tone: 'warn', text: '需要登录' }
  if (report.status === 'failed') return { tone: 'failed', text: '失败', reason: report.reason ? MCP_FAILURE_TEXT[report.reason] : '' }
  const on = report.tools.filter(tool => isMcpToolOn(server, tool)).length
  return { tone: 'done', text: `可用 · ${on} 个工具` }
}

export function McpStatusWord({ server }: { server: McpServerView }) {
  const status = mcpStatus(server)
  return (
    <StatusWord tone={status.tone} title={status.reason || undefined}>
      {status.text}
    </StatusWord>
  )
}

/** 「用在」 in a few words. */
export function scopeText(scope: McpScope, snapshot: Pick<AppSnapshot, 'customAgents' | 'catalog'>): string {
  if (scope.all) return '所有会话'
  // An Agent this device cannot read (or one since deleted) is counted, not named.
  const named = scope.agents.flatMap(id => snapshot.customAgents?.find(agent => agent.id === id)?.name ?? [])
  const unnamed = scope.agents.length - named.length
  const agents = [...named, ...(unnamed ? [`${unnamed} 个 Agent`] : [])]
  const projects = scope.projects.map(id =>
    projectLabel(
      snapshot.catalog?.workspaces.find(project => project.id === id),
      id,
    ),
  )
  const names = [...agents, ...projects]
  if (names.length === 0) return '还没有选'
  return names.length <= 2 ? names.join('、') : `${names.slice(0, 2).join('、')} 等 ${names.length} 处`
}

/** A write to a server with its request ID kept, so a retry after an unknown outcome is the same request. */
function useWrite() {
  const ids = useRef(new Map<string, string>())
  return useCallback(async <T,>(key: string, send: (requestId: string) => Promise<T>): Promise<T> => {
    const requestId = ids.current.get(key) ?? newRequestId()
    ids.current.set(key, requestId)
    try {
      const result = await send(requestId)
      ids.current.delete(key)
      return result
    } catch (cause) {
      // Refused for certain: the next try is a new request. Otherwise (no answer) the same ID goes again.
      if (cause instanceof ApiError && cause.status < 500) ids.current.delete(key)
      throw cause
    }
  }, [])
}

interface EnvRow {
  key: string
  value: string
  /** Kept only on this Mac and never shown again; a plain one is part of what is confirmed. */
  secret: boolean
}

const projectLabel = (project: { name: string } | undefined, id: string) => project?.name || (id === 'default' ? '无项目' : id)

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u
const HEADER = { test: isMcpHeaderName }

/** Whether the Host would keep this address: `https://`, or `http://` on this Mac's loopback; no query or fragment. */
export function remoteUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash || /[?#]/u.test(value)) return false
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))
  } catch {
    return false
  }
}
/**
 * Text a confirmation would have to escape (controls, bidi, line separators, invisible characters): a command or an
 * argument holding one reads differently than it runs, so the form refuses it.
 */
export const hiddenCharacters = (text: string) => escapeSecurityText(text) !== text
const HIDDEN = '含不可见或改变方向的字符'

const lines = (text: string) =>
  text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

/** The add form: a local command, its variables, where it starts and where it is used. Saving asks for Touch ID. */
function AddServer({
  snapshot,
  revision,
  onSaved,
  onCancel,
}: {
  snapshot: AppSnapshot
  revision: number
  onSaved: (server: McpServerView) => void
  onCancel: () => void
}) {
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>([])
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState<EnvRow[]>([])
  const [projectCwd, setProjectCwd] = useState(false)
  const [scope, setScope] = useState<McpScope>({ all: true, agents: [], projects: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  /** The project whose `.mcp.json` filled the form, named in the record of the addition. */
  const [importedFrom, setImportedFrom] = useState<string | undefined>(undefined)
  const write = useWrite()
  const nameError = name && !isMcpServerName(name) ? '字母、数字、- 与 _，不连写 __，不以 latch 开头' : undefined
  const badEnv = env.find(row => row.key.trim() && !ENV_NAME.test(row.key.trim()))
  const badHeader = headers.find(row => row.key.trim() && !HEADER.test(row.key.trim()))
  const remote = transport === 'http'
  const urlError = url.trim() && !remoteUrl(url.trim()) ? 'https:// 地址，或这台 Mac 上的 http://localhost' : undefined
  const commandError = hiddenCharacters(command) ? HIDDEN : undefined
  const argsError = args.split('\n').some(hiddenCharacters) ? HIDDEN : undefined
  const ready = remote ? !!url.trim() && !urlError && !badHeader : !!command.trim() && !badEnv && !commandError && !argsError
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !ready || nameError || busy) return
    setBusy(true)
    setError('')
    const from = importedFrom ? { importedFrom } : {}
    const body = remote
      ? {
          ...from,
          baseRevision: revision,
          transport: 'http',
          name: name.trim(),
          url: url.trim(),
          headers: Object.fromEntries(headers.filter(row => row.key.trim()).map(row => [row.key.trim(), row.value])),
          scope,
        }
      : {
          ...from,
          baseRevision: revision,
          name: name.trim(),
          command: command.trim(),
          args: lines(args),
          env: Object.fromEntries(env.filter(row => row.key.trim() && !row.secret).map(row => [row.key.trim(), row.value])),
          secrets: Object.fromEntries(env.filter(row => row.key.trim() && row.secret).map(row => [row.key.trim(), row.value])),
          projectCwd,
          scope,
        }
    try {
      const result = await write('add', requestId =>
        withConfirmation(confirmation =>
          api<{ server: McpServerView }>('mcp/servers', {
            method: 'POST',
            body: { requestId, ...body },
            ...(confirmation ? { confirmation } : {}),
          }),
        ),
      )
      onSaved(result.server)
    } catch (cause) {
      setError(inlineError(cause))
      setBusy(false)
    }
  }
  return (
    <form
      className="settings-subpage mcp-add"
      onSubmit={event => {
        void save(event)
      }}>
      <SegmentedControl<'stdio' | 'http'>
        label="MCP 服务器的类型"
        value={transport}
        options={[
          { value: 'stdio', label: '命令' },
          { value: 'http', label: '远程地址' },
        ]}
        onValueChange={setTransport}
      />
      {remote && (
        <>
          <SettingsGroup title="地址" note={<NoteLine brief={REMOTE_NOTE} />}>
            <div className="settings-card-body settings-fields">
              <TextField
                label="名称"
                value={name}
                spellCheck={false}
                autoComplete="off"
                placeholder="例如 github"
                error={nameError}
                onChange={event => {
                  setName(event.target.value)
                }}
              />
              <TextField
                label="URL"
                value={url}
                spellCheck={false}
                autoComplete="off"
                inputMode="url"
                placeholder="https://example.com/mcp"
                error={urlError}
                onChange={event => {
                  setUrl(event.target.value)
                }}
              />
            </div>
          </SettingsGroup>
          <SettingsGroup
            title="请求头"
            meta={
              <Button
                variant="link"
                size="xs"
                onClick={() => {
                  setHeaders(rows => [...rows, { key: '', value: '' }])
                }}>
                添加请求头
              </Button>
            }
            captionIcon="lock"
            caption="值只存在这台 Mac 上，只发往这个地址">
            {headers.length === 0 && <SettingsRow title="没有请求头" />}
            {headers.map((row, index) => (
              <div key={index} className="settings-card-body settings-fields mcp-env-row">
                <TextField
                  label="名称"
                  value={row.key}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="Authorization"
                  error={row.key.trim() && !HEADER.test(row.key.trim()) ? '不是可用的请求头名称' : undefined}
                  onChange={event => {
                    const key = event.target.value
                    setHeaders(rows => rows.map((item, at) => (at === index ? { ...item, key } : item)))
                  }}
                />
                <TextField
                  label="值"
                  type="password"
                  value={row.value}
                  placeholder="填写值"
                  spellCheck={false}
                  autoComplete="new-password"
                  onChange={event => {
                    const value = event.target.value
                    setHeaders(rows => rows.map((item, at) => (at === index ? { ...item, value } : item)))
                  }}
                />
                <Button
                  variant="ghost"
                  aria-label={`移除请求头 ${row.key || index + 1}`}
                  onClick={() => {
                    setHeaders(rows => rows.filter((_, at) => at !== index))
                  }}>
                  移除
                </Button>
              </div>
            ))}
          </SettingsGroup>
        </>
      )}
      {!remote && (
        <>
          <SettingsGroup title="命令" note={<NoteLine brief={RUNS_AS_YOU} />}>
            <div className="settings-card-body settings-fields">
              <TextField
                label="名称"
                value={name}
                spellCheck={false}
                autoComplete="off"
                placeholder="例如 github"
                error={nameError}
                onChange={event => {
                  setName(event.target.value)
                }}
              />
              <TextField
                label="命令"
                value={command}
                spellCheck={false}
                autoComplete="off"
                placeholder="例如 npx 或 /usr/local/bin/server"
                error={commandError}
                onChange={event => {
                  setCommand(event.target.value)
                }}
              />
              <TextAreaField
                label="参数"
                hint="每行一个；${workspaceFolder} 是会话的项目文件夹"
                rows={3}
                value={args}
                error={argsError}
                spellCheck={false}
                onChange={event => {
                  setArgs(event.target.value)
                }}
              />
              {isUnpinnedRunner(command.trim(), lines(args)) && <InlineNotice tone="warn">每次启动可能下载新版本</InlineNotice>}
            </div>
          </SettingsGroup>
          <SettingsGroup
            title="环境变量"
            meta={
              <Button
                variant="link"
                size="xs"
                onClick={() => {
                  setEnv(rows => [...rows, { key: '', value: '', secret: true }])
                }}>
                添加变量
              </Button>
            }
            captionIcon="lock"
            caption="秘密的值只存在这台 Mac 上，不再显示">
            {env.length === 0 && <SettingsRow title="没有环境变量" />}
            {env.map((row, index) => (
              <div key={index} className="settings-card-body settings-fields mcp-env-row">
                <TextField
                  label="变量名"
                  value={row.key}
                  spellCheck={false}
                  autoComplete="off"
                  error={row.key.trim() && !ENV_NAME.test(row.key.trim()) ? '只能包含字母、数字和下划线' : undefined}
                  onChange={event => {
                    const key = event.target.value
                    setEnv(rows => rows.map((item, at) => (at === index ? { ...item, key } : item)))
                  }}
                />
                <TextField
                  label="值"
                  type={row.secret ? 'password' : 'text'}
                  value={row.value}
                  placeholder={row.secret ? '填写值' : undefined}
                  spellCheck={false}
                  autoComplete={row.secret ? 'new-password' : 'off'}
                  onChange={event => {
                    const value = event.target.value
                    setEnv(rows => rows.map((item, at) => (at === index ? { ...item, value } : item)))
                  }}
                />
                <Checkbox
                  label="秘密"
                  checked={row.secret}
                  onChange={event => {
                    const secret = event.target.checked
                    setEnv(rows => rows.map((item, at) => (at === index ? { ...item, secret } : item)))
                  }}
                />
                <Button
                  variant="ghost"
                  aria-label={`移除变量 ${row.key || index + 1}`}
                  onClick={() => {
                    setEnv(rows => rows.filter((_, at) => at !== index))
                  }}>
                  移除
                </Button>
              </div>
            ))}
          </SettingsGroup>
          <SettingsGroup title="启动">
            <SwitchRow title="在项目文件夹里启动" checked={projectCwd} onCheckedChange={setProjectCwd} />
          </SettingsGroup>
        </>
      )}
      <ScopeGroup snapshot={snapshot} scope={scope} onChange={setScope} />
      <div className="settings-note">
        {importedFrom && (
          <span>{`来自 ${projectLabel(
            snapshot.catalog?.workspaces.find(project => project.id === importedFrom),
            importedFrom,
          )} 的 .mcp.json`}</span>
        )}
        <Button
          variant="link"
          size="xs"
          disabled={busy}
          onClick={() => {
            setImporting(true)
          }}>
          从项目导入…
        </Button>
      </div>
      <ImportDialog
        open={importing}
        snapshot={snapshot}
        onClose={() => {
          setImporting(false)
        }}
        onPick={(candidate, workspaceId) => {
          const form = importedForm(candidate)
          setTransport(form.transport)
          setName(form.name)
          setCommand(form.command)
          setArgs(form.args)
          setEnv(form.env)
          setUrl(form.url)
          setHeaders(form.headers)
          setImportedFrom(workspaceId)
          setError('')
        }}
      />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <InlineConfirm active={busy} rank={1} />
      <div className="settings-actions">
        <Button size="md" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button size="md" type="submit" variant="primary" loading={busy} disabled={!name.trim() || !ready || !!nameError}>
          添加
        </Button>
      </div>
    </form>
  )
}

/** 「用在」: every session, or the chosen Agents and projects. */
function ScopeGroup({
  snapshot,
  scope,
  disabled = false,
  onChange,
}: {
  snapshot: AppSnapshot
  scope: McpScope
  disabled?: boolean
  onChange: (scope: McpScope) => void
}) {
  const toggle = (list: 'agents' | 'projects', id: string, on: boolean) =>
    onChange({ ...scope, [list]: on ? [...scope[list], id] : scope[list].filter(item => item !== id) })
  const agents = snapshot.customAgents ?? []
  return (
    <SettingsGroup title="用在">
      <SwitchRow
        title="所有会话"
        checked={scope.all}
        disabled={disabled}
        onCheckedChange={all => {
          onChange({ ...scope, all })
        }}
      />
      {!scope.all && (
        <div className="settings-card-body mcp-scope">
          {agents.length > 0 && (
            <fieldset>
              <legend>Agent</legend>
              {agents.map(agent => (
                <Checkbox
                  key={agent.id}
                  label={agent.name}
                  checked={scope.agents.includes(agent.id)}
                  disabled={disabled}
                  onChange={event => {
                    toggle('agents', agent.id, event.target.checked)
                  }}
                />
              ))}
            </fieldset>
          )}
          <fieldset>
            <legend>项目</legend>
            {(snapshot.catalog?.workspaces ?? []).map(project => (
              <Checkbox
                key={project.id}
                label={projectLabel(project, project.id)}
                checked={scope.projects.includes(project.id)}
                disabled={disabled}
                onChange={event => {
                  toggle('projects', project.id, event.target.checked)
                }}
              />
            ))}
          </fieldset>
        </div>
      )}
    </SettingsGroup>
  )
}

/** One field's dialog: a variable's new value (no Touch ID), or a new variable (Touch ID). */
function EnvDialog({
  open,
  name: fixed,
  fixedSecret = true,
  header = false,
  onSubmit,
  onClose,
}: {
  open: boolean
  /** A remote server's request header: always secret, named as HTTP names headers. */
  header?: boolean
  /** Replacing this variable's value; absent, a new variable. */
  name?: string
  /** The variable being replaced is secret. */
  fixedSecret?: boolean
  onSubmit: (key: string, value: string, secret: boolean) => Promise<string>
  onClose: () => void
}) {
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [chosenSecret, setSecret] = useState(true)
  const secret = fixed ? fixedSecret : chosenSecret
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const name = fixed ?? key.trim()
  const invalid = !fixed && key.trim() !== '' && !(header ? HEADER : ENV_NAME).test(key.trim())
  const close = () => {
    setKey('')
    setValue('')
    setError('')
    onClose()
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name || invalid || busy) return
    setBusy(true)
    const failure = await onSubmit(name, value, secret)
    setBusy(false)
    if (failure) setError(failure)
    else close()
  }
  return (
    <Dialog
      open={open}
      size="lg"
      title={fixed ? `更换 ${fixed} 的值` : header ? '添加请求头' : '添加环境变量'}
      onClose={() => {
        if (!busy) close()
      }}
      footer={
        <>
          <Button size="md" disabled={busy} onClick={close}>
            取消
          </Button>
          <Button size="md" variant="primary" type="submit" form="mcp-env-form" disabled={!name || invalid} loading={busy}>
            保存
          </Button>
        </>
      }>
      <form
        id="mcp-env-form"
        className="settings-form"
        onSubmit={event => {
          void submit(event)
        }}>
        {!fixed && (
          <TextField
            label={header ? '名称' : '变量名'}
            value={key}
            spellCheck={false}
            autoComplete="off"
            error={invalid ? (header ? '不是可用的请求头名称' : '只能包含字母、数字和下划线') : undefined}
            onChange={event => {
              setKey(event.target.value)
            }}
          />
        )}
        <TextField
          label="值"
          type={secret ? 'password' : 'text'}
          value={value}
          spellCheck={false}
          autoComplete={secret ? 'new-password' : 'off'}
          onChange={event => {
            setValue(event.target.value)
          }}
        />
        {!fixed && !header && <Checkbox label="秘密" checked={chosenSecret} onChange={event => setSecret(event.target.checked)} />}
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <InlineConfirm active={busy} rank={1} />
      </form>
    </Dialog>
  )
}

/** Command, arguments and where it starts, edited in a dialog; a change asks for Touch ID. */
function CommandDialog({
  open,
  server,
  onSubmit,
  onClose,
}: {
  open: boolean
  server: McpStdioServerView
  onSubmit: (body: { command: string; args: string[]; projectCwd: boolean }) => Promise<string>
  onClose: () => void
}) {
  const [command, setCommand] = useState(server.command)
  const [args, setArgs] = useState(server.args.join('\n'))
  const [projectCwd, setProjectCwd] = useState(server.projectCwd)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!command.trim() || busy) return
    setBusy(true)
    const failure = await onSubmit({ command: command.trim(), args: lines(args), projectCwd })
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }
  return (
    <Dialog
      open={open}
      size="lg"
      title="编辑命令"
      onClose={() => {
        if (!busy) onClose()
      }}
      footer={
        <>
          <Button size="md" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button size="md" variant="primary" type="submit" form="mcp-command-form" disabled={!command.trim()} loading={busy}>
            保存
          </Button>
        </>
      }>
      <form
        id="mcp-command-form"
        className="settings-form"
        onSubmit={event => {
          void submit(event)
        }}>
        <TextField
          label="命令"
          value={command}
          spellCheck={false}
          autoComplete="off"
          onChange={event => {
            setCommand(event.target.value)
          }}
        />
        <TextAreaField
          label="参数"
          hint="每行一个"
          rows={3}
          value={args}
          spellCheck={false}
          onChange={event => {
            setArgs(event.target.value)
          }}
        />
        <SwitchRow title="在项目文件夹里启动" checked={projectCwd} onCheckedChange={setProjectCwd} />
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <InlineConfirm active={busy} rank={1} />
      </form>
    </Dialog>
  )
}

/** A remote server's address, edited in a dialog; another origin or path asks for Touch ID. */
function UrlDialog({
  server,
  onSubmit,
  onClose,
}: {
  server: McpHttpServerView
  onSubmit: (url: string) => Promise<string>
  onClose: () => void
}) {
  const [url, setUrl] = useState(server.url)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const invalid = url.trim() !== '' && !remoteUrl(url.trim())
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!url.trim() || invalid || busy) return
    setBusy(true)
    const failure = await onSubmit(url.trim())
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }
  return (
    <Dialog
      open
      size="lg"
      title="编辑地址"
      onClose={() => {
        if (!busy) onClose()
      }}
      footer={
        <>
          <Button size="md" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button size="md" variant="primary" type="submit" form="mcp-url-form" disabled={!url.trim() || invalid} loading={busy}>
            保存
          </Button>
        </>
      }>
      <form
        id="mcp-url-form"
        className="settings-form"
        onSubmit={event => {
          void submit(event)
        }}>
        <TextField
          label="URL"
          value={url}
          spellCheck={false}
          autoComplete="off"
          inputMode="url"
          error={invalid ? 'https:// 地址，或这台 Mac 上的 http://localhost' : undefined}
          onChange={event => {
            setUrl(event.target.value)
          }}
        />
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <InlineConfirm active={busy} rank={1} />
      </form>
    </Dialog>
  )
}

/** A client ID registered beforehand, for an authorization server that registers none itself. */
function ClientDialog({
  onSubmit,
  onClose,
}: {
  onSubmit: (clientId: string, clientSecret: string) => Promise<string>
  onClose: () => void
}) {
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const invalid = clientId !== '' && !/^[\x20-\x7E]{1,512}$/u.test(clientId.trim())
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!clientId.trim() || invalid || busy) return
    setBusy(true)
    const failure = await onSubmit(clientId.trim(), secret)
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }
  return (
    <Dialog
      open
      size="lg"
      title="Client ID"
      onClose={() => {
        if (!busy) onClose()
      }}
      footer={
        <>
          <Button size="md" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button size="md" variant="primary" type="submit" form="mcp-client-form" disabled={!clientId.trim() || invalid} loading={busy}>
            登录
          </Button>
        </>
      }>
      <form
        id="mcp-client-form"
        className="settings-form"
        onSubmit={event => {
          void submit(event)
        }}>
        <TextField
          label="Client ID"
          value={clientId}
          spellCheck={false}
          autoComplete="off"
          hint={<Hint label="在授权服务器注册的应用">{CLIENT_NOTE}</Hint>}
          error={invalid ? '只能是可见的 ASCII 字符' : undefined}
          onChange={event => {
            setClientId(event.target.value)
          }}
        />
        <TextField
          label="Client Secret（没有就留空）"
          type="password"
          value={secret}
          spellCheck={false}
          autoComplete="off"
          onChange={event => {
            setSecret(event.target.value)
          }}
        />
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <InlineConfirm active={busy} rank={1} />
      </form>
    </Dialog>
  )
}

/**
 * A remote server's login: how it stands for every device; 登录, 在浏览器中打开, 取消 and 退出登录 only on this Mac. The
 * browser is opened by the person's own click on the address the Host answered with; the page keeps that address only
 * while it is open.
 */
function LoginGroup({
  server,
  local,
  disabled,
  onChanged,
}: {
  server: McpHttpServerView
  local: boolean
  disabled: boolean
  onChanged: (server?: McpServerView) => void
}) {
  const oauth = server.oauth
  const [busy, setBusy] = useState<null | 'login' | 'logout'>(null)
  const [error, setError] = useState('')
  const [address, setAddress] = useState('')
  const [client, setClient] = useState(false)
  const write = useWrite()
  const state = oauth?.state
  const refresh = useRef(onChanged)
  refresh.current = onChanged
  // The browser's return reaches the Host, not this page: while a login waits, the page asks how it stands.
  useEffect(() => {
    if (state !== 'signing-in') {
      setAddress('')
      return
    }
    const timer = window.setInterval(() => refresh.current(), 2000)
    return () => window.clearInterval(timer)
  }, [state])
  if (!oauth) return null
  const status = mcpLoginStatus(server)!
  const path = `mcp/servers/${encodeURIComponent(server.id)}/oauth`
  const login = async (typed?: { clientId: string; clientSecret: string }): Promise<string> => {
    setBusy('login')
    setError('')
    try {
      const body = typed ? { clientId: typed.clientId, ...(typed.clientSecret ? { clientSecret: typed.clientSecret } : {}) } : {}
      const result = await write('login', requestId =>
        withConfirmation(confirmation =>
          api<{ authorizationUrl?: string; server?: McpServerView }>(`${path}/login`, {
            method: 'POST',
            body: { requestId, ...body },
            ...(confirmation ? { confirmation } : {}),
          }),
        ),
      )
      // A request sent again after its login was over comes back without an address.
      setAddress(result.authorizationUrl ?? '')
      onChanged(result.server)
      return ''
    } catch (cause) {
      onChanged()
      return inlineError(cause)
    } finally {
      setBusy(null)
    }
  }
  const logout = async () => {
    setBusy('logout')
    setError('')
    try {
      const result = await write('logout', requestId =>
        api<{ server?: McpServerView }>(`${path}/logout`, { method: 'POST', body: { requestId } }),
      )
      setAddress('')
      onChanged(result.server)
    } catch (cause) {
      setError(inlineError(cause))
    } finally {
      setBusy(null)
    }
  }
  const idle = disabled || busy !== null
  const needsClient = oauth.state === 'failed' && oauth.reason === 'client-required'
  const undeleted = oauth.state === 'failed' && oauth.reason === 'delete'
  const start = () => {
    if (needsClient) setClient(true)
    else void login().then(text => text && setError(text))
  }
  return (
    <SettingsGroup title="登录" note={<NoteLine brief={LOGIN_NOTE} />}>
      <SettingsRow
        className="mcp-login"
        title={
          <StatusWord tone={status.tone} title={status.reason || undefined}>
            {status.text}
          </StatusWord>
        }
        description={
          oauth.state === 'signed-in' && oauth.expiresAt
            ? `到期 ${dateTime(oauth.expiresAt)}`
            : oauth.state === 'signing-in'
              ? '在浏览器里完成'
              : status.reason || undefined
        }
        trailing={
          local && (
            <span className="mcp-row-actions">
              {oauth.state === 'signing-in' && address && (
                <Button
                  variant="primary"
                  disabled={idle}
                  onClick={() => {
                    window.open(address, '_blank', 'noopener,noreferrer')
                  }}>
                  在浏览器中打开
                </Button>
              )}
              {oauth.state === 'signing-in' && (
                <Button variant="ghost" disabled={idle} loading={busy === 'logout'} onClick={() => void logout()}>
                  取消
                </Button>
              )}
              {oauth.state === 'signed-in' && (
                <Button variant="ghost" disabled={idle} loading={busy === 'logout'} onClick={() => void logout()}>
                  退出登录
                </Button>
              )}
              {undeleted && (
                <Button variant="primary" disabled={idle} loading={busy === 'logout'} onClick={() => void logout()}>
                  重试
                </Button>
              )}
              {!undeleted && (oauth.state === 'signed-out' || oauth.state === 'failed' || oauth.state === 'relogin') && (
                <>
                  <Button variant="ghost" disabled={idle} onClick={() => setClient(true)}>
                    Client ID…
                  </Button>
                  <Button variant="primary" disabled={idle} loading={busy === 'login'} onClick={start}>
                    {oauth.state === 'relogin' ? '重新登录' : '登录'}
                  </Button>
                </>
              )}
            </span>
          )
        }
      />
      {oauth.issuer && <SettingsRow title="授权服务器" description={<MiddleEllipsis text={oauth.issuer} className="settings-mono" />} />}
      {oauth.scopes && oauth.scopes.length > 0 && (
        <SettingsRow title="范围" description={<code className="settings-mono">{oauth.scopes.join(' ')}</code>} />
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <InlineConfirm active={busy === 'login'} rank={1} />
      {client && <ClientDialog onSubmit={(clientId, clientSecret) => login({ clientId, clientSecret })} onClose={() => setClient(false)} />}
    </SettingsGroup>
  )
}

/** A remote server's address and request headers by name, with 编辑 and 更换 on this Mac. */
function RemoteGroups({
  server,
  local,
  busy,
  onEditUrl,
  onAddHeader,
  onReplace,
  onRemove,
}: {
  server: McpHttpServerView
  local: boolean
  busy: boolean
  onEditUrl: () => void
  onAddHeader: () => void
  onReplace: (name: string) => void
  onRemove: (name: string) => void
}) {
  return (
    <>
      <SettingsGroup
        title="地址"
        meta={
          local && (
            <Button variant="link" size="xs" disabled={busy} onClick={onEditUrl}>
              编辑…
            </Button>
          )
        }
        note={<NoteLine brief={REMOTE_NOTE} />}>
        <SettingsRow title="URL" description={<MiddleEllipsis text={server.url} className="settings-mono" />} />
      </SettingsGroup>
      <SettingsGroup
        title="请求头"
        meta={
          local && (
            <Button variant="link" size="xs" disabled={busy} onClick={onAddHeader}>
              添加…
            </Button>
          )
        }
        captionIcon="lock"
        caption="值只存在这台 Mac 上，只发往这个地址">
        {server.headers.length === 0 && <SettingsRow title="没有请求头" />}
        {server.headers.map(entry => (
          <SettingsRow
            key={entry.name}
            title={<code className="settings-mono">{entry.name}</code>}
            description={entry.set ? '已设置' : '未设置'}
            trailing={
              local && (
                <span className="mcp-row-actions">
                  <Button variant="ghost" disabled={busy} onClick={() => onReplace(entry.name)}>
                    更换…
                  </Button>
                  <Button variant="ghost" disabled={busy} aria-label={`移除 ${entry.name}`} onClick={() => onRemove(entry.name)}>
                    移除
                  </Button>
                </span>
              )
            }
          />
        ))}
      </SettingsGroup>
    </>
  )
}

/** A local command's groups: what runs and its variables by name. */
function StdioGroups({
  server,
  local,
  busy,
  setDialog,
  patch,
  setError,
}: {
  server: McpStdioServerView
  local: boolean
  busy: string | null
  setDialog: (dialog: 'command' | 'env' | { name: string; secret: boolean }) => void
  patch: (key: string, change: Record<string, unknown>, confirm?: boolean) => Promise<string>
  setError: (text: string) => void
}) {
  return (
    <>
      <SettingsGroup
        title="命令"
        meta={
          local && (
            <Button
              variant="link"
              size="xs"
              disabled={busy !== null}
              onClick={() => {
                setDialog('command')
              }}>
              编辑…
            </Button>
          )
        }
        note={<NoteLine brief={RUNS_AS_YOU} />}>
        <SettingsRow title="命令" description={<MiddleEllipsis text={server.command} className="settings-mono" />} />
        <SettingsRow
          title="参数"
          description={server.args.length ? <MiddleEllipsis text={server.args.join(' ')} className="settings-mono" /> : '无'}
        />
        <SettingsRow title="工作目录" description={server.projectCwd ? '会话的项目文件夹' : '会话的空文件夹'} />
        {server.preset === 'computer' && <TelemetryRow command={server.command} />}
        {server.unpinned && (
          <SettingsRow
            title={
              <span className="mcp-warn">
                <Icon icon={WarningGlyph} size={14} />
                每次启动可能下载新版本
              </span>
            }
          />
        )}
      </SettingsGroup>
      <SettingsGroup
        title="环境变量"
        meta={
          local && (
            <Button
              variant="link"
              size="xs"
              disabled={busy !== null}
              onClick={() => {
                setDialog('env')
              }}>
              添加…
            </Button>
          )
        }
        captionIcon="lock"
        caption="秘密的值只存在这台 Mac 上，不再显示">
        {server.env.length === 0 && <SettingsRow title="没有环境变量" />}
        {server.env.map(entry => (
          <SettingsRow
            key={entry.name}
            title={<code className="settings-mono">{entry.name}</code>}
            description={
              entry.secret ? (
                entry.set ? (
                  '秘密 · 已设置'
                ) : (
                  '秘密 · 未设置'
                )
              ) : (
                <MiddleEllipsis text={entry.value ?? ''} className="settings-mono" />
              )
            }
            trailing={
              local && (
                <span className="mcp-row-actions">
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => {
                      setDialog({ name: entry.name, secret: entry.secret })
                    }}>
                    更换…
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    aria-label={`移除 ${entry.name}`}
                    onClick={() => {
                      // A plain variable is part of what was confirmed: taking it away asks again.
                      void patch(`env-${entry.name}`, { [entry.secret ? 'secrets' : 'env']: { [entry.name]: null } }, !entry.secret).then(
                        text => text && setError(text),
                      )
                    }}>
                    移除
                  </Button>
                </span>
              )
            }
          />
        ))}
      </SettingsGroup>
    </>
  )
}

/** A server's page: what runs, its variables by name, its tools with switches, 「用在」, 测试, 停用 and 移除. */
function ServerPage({
  snapshot,
  server,
  local,
  onChanged,
  onRemoved,
}: {
  snapshot: AppSnapshot
  server: McpServerView
  /** The desktop app on this Mac: everything but 停用 is changed only here. */
  local: boolean
  onChanged: (server?: McpServerView) => void
  onRemoved: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<null | 'command' | 'url' | 'env' | { name: string; secret: boolean }>(null)
  const remote = server.transport === 'http'
  const [removing, setRemoving] = useState(false)
  /** Only offered when no other server or model service uses the allowance; taking it away asks nothing. */
  const [dropAllowance, setDropAllowance] = useState(true)
  const [tested, setTested] = useState<'ok' | 'failed' | null>(null)
  const write = useWrite()
  const patch = async (key: string, change: Record<string, unknown>, confirm = false): Promise<string> => {
    setBusy(key)
    setError('')
    try {
      const send = (requestId: string, confirmation?: string) =>
        api<{ server: McpServerView }>(`mcp/servers/${encodeURIComponent(server.id)}`, {
          method: 'PATCH',
          body: { requestId, baseRevision: server.revision, ...change },
          ...(confirmation ? { confirmation } : {}),
        })
      const result = await write(key, requestId =>
        confirm ? withConfirmation(confirmation => send(requestId, confirmation)) : send(requestId),
      )
      onChanged(result.server)
      return ''
    } catch (cause) {
      return inlineError(cause)
    } finally {
      setBusy(null)
    }
  }
  const test = async () => {
    setBusy('test')
    setError('')
    setTested(null)
    try {
      const result = await write('test', requestId =>
        api<{ status: 'ok' | 'failed'; server?: McpServerView }>(`mcp/servers/${encodeURIComponent(server.id)}/test`, {
          method: 'POST',
          body: { requestId },
        }),
      )
      setTested(result.status)
      onChanged(result.server)
    } catch (cause) {
      setError(inlineError(cause))
    } finally {
      setBusy(null)
    }
  }
  const tools = server.report?.tools ?? []
  const status = mcpStatus(server)
  const report = server.report
  return (
    <>
      <div className="settings-heading mcp-heading">
        <div>
          <h2>{server.name}</h2>
          <p>
            <McpStatusWord server={server} />
            {status.reason && <span className="mcp-reason">{status.reason}</span>}
            {report && <span className="mcp-when">{`${report.via === 'test' ? '测试' : '会话'} · ${dateTime(report.at)}`}</span>}
          </p>
        </div>
        <div className="mcp-actions">
          {local && server.enabled && (
            <Button
              size="sm"
              loading={busy === 'test'}
              disabled={busy !== null}
              onClick={() => {
                void test()
              }}>
              {busy === 'test' ? '测试中' : '测试'}
            </Button>
          )}
          {(local || server.enabled) && (
            <Button
              size="sm"
              loading={busy === 'enabled'}
              disabled={busy !== null}
              onClick={() => {
                void patch('enabled', { enabled: !server.enabled }).then(text => text && setError(text))
              }}>
              {server.enabled ? '停用' : '启用'}
            </Button>
          )}
          {local && (
            <Button
              size="sm"
              variant="danger"
              disabled={busy !== null}
              onClick={() => {
                setRemoving(true)
              }}>
              移除
            </Button>
          )}
        </div>
      </div>
      {tested === 'failed' && report?.status === 'failed' && (
        <InlineNotice tone="error">{`测试失败：${report.reason ? MCP_FAILURE_TEXT[report.reason] : '没有完成'}`}</InlineNotice>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {server.transport === 'http' && (
        <LoginGroup server={server} local={local && server.enabled} disabled={busy !== null} onChanged={onChanged} />
      )}
      {server.transport === 'http' ? (
        <RemoteGroups
          server={server}
          local={local}
          busy={busy !== null}
          onEditUrl={() => setDialog('url')}
          onAddHeader={() => setDialog('env')}
          onReplace={name => setDialog({ name, secret: true })}
          onRemove={name => {
            // Taking a header away narrows what is sent: on record, no confirmation.
            void patch(`header-${name}`, { headers: { [name]: null } }).then(text => text && setError(text))
          }}
        />
      ) : (
        <StdioGroups server={server} local={local} busy={busy} setDialog={setDialog} patch={patch} setError={setError} />
      )}
      <SettingsGroup title="工具" meta={tools.length > 0 ? `${tools.length} 个` : undefined}>
        {tools.length === 0 && <SettingsRow title={server.report ? '没有工具' : '测试后列出工具'} />}
        {tools.map(tool => {
          // A server that keeps new tools off: one it never listed before is new, and off until switched on.
          const known = server.transport === 'stdio' ? server.knownTools : undefined
          const fresh = known !== undefined && !known.includes(tool) && !server.disabledTools.includes(tool)
          return (
            <SettingsRow
              key={tool}
              title={
                <span className="mcp-tool">
                  <code className="settings-mono">{tool}</code>
                  {fresh && <Badge tone="warn">新</Badge>}
                </span>
              }
              trailing={
                <Switch
                  label={`使用 ${tool}`}
                  checked={isMcpToolOn(server, tool)}
                  disabled={!local || busy !== null}
                  onCheckedChange={on => {
                    const disabledTools = on ? server.disabledTools.filter(item => item !== tool) : [...server.disabledTools, tool]
                    const knownTools = known && !known.includes(tool) ? { knownTools: [...known, tool] } : {}
                    void patch('tools', { disabledTools, ...knownTools }).then(text => text && setError(text))
                  }}
                />
              }
            />
          )
        })}
      </SettingsGroup>
      <ScopeGroup
        snapshot={snapshot}
        scope={server.scope}
        disabled={!local || busy !== null}
        onChange={scope => {
          void patch('scope', { scope }).then(text => text && setError(text))
        }}
      />
      {dialog === 'command' && server.transport === 'stdio' && (
        <CommandDialog open server={server} onSubmit={body => patch('command', body, true)} onClose={() => setDialog(null)} />
      )}
      {dialog === 'url' && server.transport === 'http' && (
        <UrlDialog server={server} onSubmit={url => patch('url', { url }, url !== server.url)} onClose={() => setDialog(null)} />
      )}
      <EnvDialog
        open={dialog === 'env' || (typeof dialog === 'object' && dialog !== null)}
        header={remote}
        {...(typeof dialog === 'object' && dialog !== null ? { name: dialog.name, fixedSecret: dialog.secret } : {})}
        // A secret's new value asks nothing; a plain variable, or a new secret or header name, is confirmed.
        onSubmit={(key, value, secret) =>
          server.transport === 'http'
            ? patch(`header-${key}`, { headers: { [key]: value } }, !server.headers.some(entry => entry.name === key))
            : patch(
                `env-${key}`,
                { [secret ? 'secrets' : 'env']: { [key]: value } },
                !secret || !server.env.some(entry => entry.name === key),
              )
        }
        onClose={() => setDialog(null)}
      />
      {removing && (
        <ConfirmDialog
          title={`移除 ${server.name}？`}
          message={
            <>
              {`正在用它的会话立即失去它；它的${remote ? '请求头' : '环境变量'}的值一并删除${
                server.transport === 'http' && server.oauth?.state === 'signed-in' ? '，登录的令牌会被撤销' : ''
              }。`}
              {server.transport === 'http' && server.allowance && (
                <Checkbox
                  label={`同时移除出站许可 ${server.allowance}`}
                  checked={dropAllowance}
                  onChange={event => setDropAllowance(event.target.checked)}
                />
              )}
            </>
          }
          confirmLabel="移除"
          danger
          onConfirm={async () => {
            const drop = server.transport === 'http' && server.allowance && dropAllowance ? '?allowance=remove' : ''
            await api(`mcp/servers/${encodeURIComponent(server.id)}${drop}`, { method: 'DELETE' })
            onRemoved()
          }}
          onClose={() => setRemoving(false)}
        />
      )}
    </>
  )
}

export function McpSettings({ snapshot }: { snapshot: AppSnapshot }) {
  const [data, setData] = useState<McpServersResponse | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<null | { kind: 'new' } | { kind: 'server'; id: string }>(null)
  const access = deviceAccess(snapshot, currentShell())
  const local = access.local
  const load = useCallback(async () => {
    try {
      setData(await api<McpServersResponse>('mcp/servers'))
      setError('')
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])
  useEffect(() => {
    void load()
    const again = () => {
      if (document.visibilityState === 'visible') void load()
    }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [load])
  if (data === null) return error ? <InlineNotice tone="error">{error}</InlineNotice> : <Loading />
  const changed = (server?: McpServerView) => {
    if (server) setData(current => current && { ...current, servers: current.servers.map(item => (item.id === server.id ? server : item)) })
    void load()
  }
  const main = (
    <>
      <SettingsGroup
        title="Latch 的 MCP 服务器"
        meta={
          local && (
            <Button
              variant="link"
              size="xs"
              onClick={() => {
                setEditing({ kind: 'new' })
              }}>
              添加…
            </Button>
          )
        }
        note={<NoteLine brief={BUILTIN_NOTE} />}>
        {data.servers.length === 0 && <SettingsRow title="还没有 MCP 服务器" />}
        {data.servers.map(server => (
          <ObjectRow
            key={server.id}
            data={{ 'data-mcp-server': server.name }}
            leading={<IconTile icon={server.transport === 'http' ? GlobeGlyph : TerminalGlyph} />}
            title={server.name}
            description={scopeText(server.scope, snapshot)}
            dim={!server.enabled}
            label={`打开 ${server.name}`}
            trailing={<McpStatusWord server={server} />}
            onOpen={() => {
              setEditing({ kind: 'server', id: server.id })
            }}
          />
        ))}
      </SettingsGroup>
      {local && (
        <ComputerGroup
          revision={data.revision}
          onAdded={server => {
            setEditing({ kind: 'server', id: server.id })
            void load()
          }}
        />
      )}
      <HarnessesMcp
        harnesses={snapshot.catalog?.harnesses ?? []}
        run={access.scopes.has('run')}
        latchNames={data.servers.map(server => server.name)}
      />
      {!local && (
        <div className="settings-note">
          <Hint label="只在这台 Mac 上添加和修改">停用可以在任何能管理这台 Mac 的设备上做；添加、修改与移除只在这台 Mac 的 Latch 里。</Hint>
        </div>
      )}
    </>
  )
  const levels: SettingsLevel[] = []
  if (editing?.kind === 'new')
    levels.push({
      key: 'mcp:new',
      title: '添加 MCP 服务器',
      onBack: () => setEditing(null),
      content: (
        <AddServer
          snapshot={snapshot}
          revision={data.revision}
          onSaved={server => {
            setEditing({ kind: 'server', id: server.id })
            void load()
          }}
          onCancel={() => setEditing(null)}
        />
      ),
    })
  const open = editing?.kind === 'server' ? data.servers.find(item => item.id === editing.id) : undefined
  if (open)
    levels.push({
      key: `mcp:${open.id}`,
      title: open.name,
      onBack: () => setEditing(null),
      content: (
        <ServerPage
          key={open.id}
          snapshot={snapshot}
          server={open}
          local={local}
          onChanged={changed}
          onRemoved={() => {
            setEditing(null)
            void load()
          }}
        />
      ),
    })
  return <SettingsPages main={main} levels={levels} />
}
