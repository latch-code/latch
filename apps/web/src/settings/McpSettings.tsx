import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Cable } from 'lucide-react'
import {
  isUnpinnedRunner,
  type AppSnapshot,
  type McpFailure,
  type McpScope,
  type McpServerView,
  type McpServersResponse,
} from '@latch/protocol'
import {
  Button,
  Checkbox,
  Dialog,
  Hint,
  InlineNotice,
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
import { dateTime } from '../format.ts'
import { IconTile, Loading, MiddleEllipsis, NoteLine, ObjectRow, SettingsGroup, SettingsRow } from './common.tsx'
import { SettingsPages, type SettingsLevel } from './navigation.tsx'

export const MCP_ICON = Cable

/** Why a server did not come up, in a few words; the detail is the server's own and stays on the Mac. */
export const MCP_FAILURE_TEXT: Readonly<Record<McpFailure, string>> = {
  'spawn-failed': '命令无法启动',
  exited: '进程已退出',
  timeout: '没有在时限内完成初始化',
  protocol: '回答不是 MCP',
  'list-failed': '没有列出工具',
  'output-too-large': '输出过大',
}

const RUNS_AS_YOU = {
  label: '以你的身份运行',
  detail:
    '命令由 Agent 一侧的 latch-mcp 启动，以你的身份运行，Latch 不隔离它。经 Latch 的每次调用都有记录；Harness 自己的 MCP 不经过 Latch。',
}
const BUILTIN_NOTE = {
  label: '内置 Harness 尚未支持 MCP 命令',
  detail:
    '命令交给 Claude Agent、Codex 等外部 Harness；pi 不接收 MCP 服务器。内置 Harness 要由 Latch 自己在这台 Mac 上运行这个命令，尚未实现。',
}

/** The state word of a server: 已停用, 未测试, 可用 · N 个工具, or 失败 with the reason behind it. */
export function mcpStatus(server: McpServerView): { tone: StatusTone; text: string; reason?: string } {
  if (!server.enabled) return { tone: 'neutral', text: '已停用' }
  const report = server.report
  if (!report) return { tone: 'neutral', text: '未测试' }
  if (report.status === 'failed') return { tone: 'failed', text: '失败', reason: report.reason ? MCP_FAILURE_TEXT[report.reason] : '' }
  const on = report.tools.filter(tool => !server.disabledTools.includes(tool)).length
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
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u
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
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState<EnvRow[]>([])
  const [projectCwd, setProjectCwd] = useState(false)
  const [scope, setScope] = useState<McpScope>({ all: true, agents: [], projects: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const write = useWrite()
  const nameError = name && (!NAME.test(name) || name.toLowerCase().startsWith('latch')) ? '字母、数字、- 与 _，不以 latch 开头' : undefined
  const badEnv = env.find(row => row.key.trim() && !ENV_NAME.test(row.key.trim()))
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !command.trim() || nameError || badEnv || busy) return
    setBusy(true)
    setError('')
    const body = {
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
            onChange={event => {
              setCommand(event.target.value)
            }}
          />
          <TextAreaField
            label="参数"
            hint="每行一个；${workspaceFolder} 是会话的项目文件夹"
            rows={3}
            value={args}
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
      <ScopeGroup snapshot={snapshot} scope={scope} onChange={setScope} />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <InlineConfirm active={busy} rank={1} />
      <div className="settings-actions">
        <Button size="md" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          size="md"
          type="submit"
          variant="primary"
          loading={busy}
          disabled={!name.trim() || !command.trim() || !!nameError || !!badEnv}>
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
  onSubmit,
  onClose,
}: {
  open: boolean
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
  const invalid = !fixed && key.trim() !== '' && !ENV_NAME.test(key.trim())
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
      size="form"
      title={fixed ? `更换 ${fixed} 的值` : '添加环境变量'}
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
            label="变量名"
            value={key}
            spellCheck={false}
            autoComplete="off"
            error={invalid ? '只能包含字母、数字和下划线' : undefined}
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
        {!fixed && <Checkbox label="秘密" checked={chosenSecret} onChange={event => setSecret(event.target.checked)} />}
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
  server: McpServerView
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
      size="form"
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
  const [dialog, setDialog] = useState<null | 'command' | 'env' | { name: string; secret: boolean }>(null)
  const [removing, setRemoving] = useState(false)
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
      <SettingsGroup title="工具" meta={tools.length > 0 ? `${tools.length} 个` : undefined}>
        {tools.length === 0 && <SettingsRow title={server.report ? '没有工具' : '测试后列出工具'} />}
        {tools.map(tool => (
          <SettingsRow
            key={tool}
            title={<code className="settings-mono">{tool}</code>}
            trailing={
              <Switch
                label={`使用 ${tool}`}
                checked={!server.disabledTools.includes(tool)}
                disabled={!local || busy !== null}
                onCheckedChange={on => {
                  const disabledTools = on ? server.disabledTools.filter(item => item !== tool) : [...server.disabledTools, tool]
                  void patch('tools', { disabledTools }).then(text => text && setError(text))
                }}
              />
            }
          />
        ))}
      </SettingsGroup>
      <ScopeGroup
        snapshot={snapshot}
        scope={server.scope}
        disabled={!local || busy !== null}
        onChange={scope => {
          void patch('scope', { scope }).then(text => text && setError(text))
        }}
      />
      {dialog === 'command' && (
        <CommandDialog open server={server} onSubmit={body => patch('command', body, true)} onClose={() => setDialog(null)} />
      )}
      <EnvDialog
        open={dialog === 'env' || (typeof dialog === 'object' && dialog !== null)}
        {...(typeof dialog === 'object' && dialog !== null ? { name: dialog.name, fixedSecret: dialog.secret } : {})}
        // A secret's new value asks nothing; a plain variable, or a new secret name, is confirmed.
        onSubmit={(key, value, secret) =>
          patch(`env-${key}`, { [secret ? 'secrets' : 'env']: { [key]: value } }, !secret || !server.env.some(entry => entry.name === key))
        }
        onClose={() => setDialog(null)}
      />
      {removing && (
        <ConfirmDialog
          title={`移除 ${server.name}？`}
          message="正在用它的会话立即失去它；它的环境变量的值一并删除。"
          confirmLabel="移除"
          danger
          onConfirm={async () => {
            await api(`mcp/servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' })
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
  const local = deviceAccess(snapshot, currentShell()).local
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
            leading={<IconTile icon={TerminalGlyph} />}
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
