import { useState, type ReactNode } from 'react'
import { Anchor } from 'lucide-react'
import type { HarnessHook, HarnessInfo, HarnessMcpServer, HarnessMcpState } from '@latch/protocol'
import { Button, CopyButton, GlobeGlyph, InlineNotice, StatusWord, TerminalGlyph, type StatusTone } from '@latch/ui'
import { api, inlineError } from '../core/api.ts'
import { defineCopy, plural } from '../core/i18n.ts'
import { dateTime } from '../format.ts'
import { IconTile, NoteLine, SettingsGroup, SettingsRow } from './common.tsx'
import { EXTENSION_COPY } from './extensions.ts'

const TONE: Readonly<Record<HarnessMcpState, StatusTone>> = {
  ready: 'done',
  starting: 'running',
  'needs-login': 'warn',
  failed: 'failed',
  cancelled: 'neutral',
  disabled: 'neutral',
  'not-started': 'neutral',
  unknown: 'neutral',
}

const COPY = defineCopy(
  {
    state: {
      ready: '可用',
      starting: '正在启动',
      'needs-login': '需要登录',
      failed: '失败',
      cancelled: '已取消',
      disabled: '已停用',
      'not-started': '未启动',
      unknown: '状态未知',
    },
    tools: (count: number) => plural(count, { other: '{n} 个工具' }),
    readNote: {
      label: '读取会在空文件夹里运行 Harness',
      detail:
        'Latch 不改 Harness 自己的配置文件，只显示它经协议报告的服务器。读取时 Harness 在一个空文件夹里运行，可能启动它配置的 MCP 服务器；会话里的状态随它的报告更新。这些服务器的调用不经过 Latch，没有记录。',
    },
    hooks: '钩子',
    hooksNote: {
      label: '每个会话都会运行',
      detail:
        '这些钩子在 Harness 自己的会话里运行，经 Latch 开的会话也一样。由管理策略加的你关不掉。Latch 不显示它们的命令，它们做什么不经过 Latch，没有记录。',
    },
    noHooks: '没有钩子',
    hooksPartial: '只列出一部分',
    event: {
      preToolUse: '调用工具前',
      postToolUse: '调用工具后',
      permissionRequest: '请求权限时',
      userPromptSubmit: '你发送消息时',
      sessionStart: '会话开始时',
      sessionEnd: '会话结束时',
      stop: '一轮结束时',
      interrupt: '停止时',
      preCompact: '压缩前',
      postCompact: '压缩后',
      subagentStart: '子 Agent 开始时',
      subagentStop: '子 Agent 结束时',
      preModelRequest: '请求模型前',
      postModelRequest: '请求模型后',
    } as Record<string, string>,
    source: {
      system: '系统配置',
      mdm: '设备管理',
      user: '你的配置',
      project: '项目配置',
      plugin: '插件',
      sessionFlags: '启动参数',
      cloudRequirements: '云端策略',
      cloudManagedConfig: '云端配置',
      legacyManagedConfigFile: '管理员配置文件',
      legacyManagedConfigMdm: '设备管理',
    } as Record<string, string>,
    managed: '管理策略',
    hookOff: '已停用',
    untrusted: '未信任',
    modified: '已改动',
    namesOnly: { label: '只有名字', detail: '开一个会话后才有状态' },
    read: '读取',
    reading: '正在读取…',
    readAt: (at: string, truncated: boolean) => `读取于 ${at}${truncated ? ' · 只列出一部分' : ''}`,
    reportAt: (at: string, truncated: boolean) => `会话报告于 ${at}${truncated ? ' · 只列出一部分' : ''}`,
    failed: (message: string) => `读取失败：${message}`,
    none: '没有 MCP 服务器',
    notYet: '还没有报告',
    replacement: '会话里用 Latch 的同名服务器',
    login: '登录命令',
    copyLogin: (name: string) => `复制 ${name} 的登录命令`,
  },
  {
    state: {
      ready: 'Ready',
      starting: 'Starting',
      'needs-login': 'Sign-in required',
      failed: 'Failed',
      cancelled: 'Cancelled',
      disabled: 'Disabled',
      'not-started': 'Not started',
      unknown: 'Status unknown',
    },
    tools: (count: number) => plural(count, { one: '{n} tool', other: '{n} tools' }),
    readNote: {
      label: 'Read runs the Harness in an empty folder',
      detail:
        'Latch displays servers from the Harness protocol and leaves its configuration files untouched. Read runs the Harness in an empty folder and may start its configured MCP servers. Sessions update as the Harness reports changes. These calls happen outside Latch and are absent from its records.',
    },
    hooks: 'Hooks',
    hooksNote: {
      label: 'Runs in every session',
      detail:
        'These hooks run in the Harness’s own sessions, including those Latch starts. Hooks added by a managed policy cannot be turned off. Latch does not show their commands, and what they do happens outside Latch and is absent from its records.',
    },
    noHooks: 'No hooks',
    hooksPartial: 'Partial list',
    event: {
      preToolUse: 'Before a tool call',
      postToolUse: 'After a tool call',
      permissionRequest: 'On a permission request',
      userPromptSubmit: 'When you send a message',
      sessionStart: 'When a session starts',
      sessionEnd: 'When a session ends',
      stop: 'When a turn ends',
      interrupt: 'On stop',
      preCompact: 'Before compaction',
      postCompact: 'After compaction',
      subagentStart: 'When a subagent starts',
      subagentStop: 'When a subagent ends',
      preModelRequest: 'Before a model request',
      postModelRequest: 'After a model request',
    } as Record<string, string>,
    source: {
      system: 'System configuration',
      mdm: 'Device management',
      user: 'Your configuration',
      project: 'Project configuration',
      plugin: 'Plugin',
      sessionFlags: 'Launch arguments',
      cloudRequirements: 'Cloud policy',
      cloudManagedConfig: 'Cloud configuration',
      legacyManagedConfigFile: 'Administrator configuration file',
      legacyManagedConfigMdm: 'Device management',
    } as Record<string, string>,
    managed: 'Managed policy',
    hookOff: 'Disabled',
    untrusted: 'Not trusted',
    modified: 'Changed',
    namesOnly: { label: 'Names only', detail: 'Open a session to see status' },
    read: 'Read',
    reading: 'Reading…',
    readAt: (at: string, truncated: boolean) => `Read at ${at}${truncated ? ' · Partial list' : ''}`,
    reportAt: (at: string, truncated: boolean) => `Session report at ${at}${truncated ? ' · Partial list' : ''}`,
    failed: (message: string) => `Couldn’t read servers. ${message}`,
    none: 'No MCP servers',
    notYet: 'No report yet',
    replacement: 'Sessions use Latch’s server with this name',
    login: 'Sign-in command',
    copyLogin: (name: string) => `Copy sign-in command for ${name}`,
  },
)

/** A Harness's server in a few words: its state, with the tool count once it is up. */
export function harnessMcpWord(server: Pick<HarnessMcpServer, 'state' | 'tools'>): { tone: StatusTone; text: string } {
  const text = COPY.state[server.state]
  return {
    tone: TONE[server.state],
    text: server.state === 'ready' && server.tools !== undefined ? `${text} · ${COPY.tools(server.tools)}` : text,
  }
}

/**
 * A Harness's own MCP servers, read-only: as it reports them (a session, or 读取 here), with its own login command where
 * it says one is needed; or that it does not report them.
 */
export function HarnessMcpGroup({
  harness,
  title,
  run,
  latchNames = [],
  sourceHeading,
  remove,
  meta,
  note,
  children,
}: {
  harness: HarnessInfo
  title: string
  /** This device may start sessions, so it may ask for 读取, which starts the same program. */
  run: boolean
  /** Latch's own servers: one of the same name replaces the Harness's in Latch's sessions. */
  latchNames?: readonly string[]
  /** 设置 › 扩展: a heading for the Harness's group. */
  sourceHeading?: ReactNode
  /** The vendor's command that removes a server, typed in for the person; absent for none. */
  remove?: (name: string) => ReactNode
  /** Beside 读取 in the head. */
  meta?: ReactNode
  /** Under the group in place of the read note. */
  note?: ReactNode
  /** Rows after the Harness's own: what Latch gives it, and the vendor's commands. */
  children?: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const own = harness.ownMcp
  if (!own)
    return (
      <SettingsGroup title={title} {...(meta ? { meta } : {})} {...(note ? { note } : {})}>
        {sourceHeading}
        <SettingsRow dim title={EXTENSION_COPY.notReported} />
        {children}
      </SettingsGroup>
    )
  const reading = busy || own.running === true
  const read = async () => {
    setBusy(true)
    setError('')
    try {
      await api(`agents/${encodeURIComponent(harness.id)}/mcp`, { method: 'POST', body: {} })
    } catch (cause) {
      setError(inlineError(cause))
    } finally {
      setBusy(false)
    }
  }
  const last = own.last
  const shadowed = new Set(latchNames.map(name => name.toLowerCase()))
  return (
    <SettingsGroup
      title={title}
      meta={
        (run || meta) && (
          <span className="extension-meta">
            {meta}
            {run && (
              <Button
                variant="link"
                size="xs"
                loading={reading}
                disabled={reading || harness.status !== 'ready'}
                onClick={() => {
                  void read()
                }}>
                {COPY.read}
              </Button>
            )}
          </span>
        )
      }
      caption={last ? (last.via === 'read' ? COPY.readAt : COPY.reportAt)(dateTime(last.at), last.truncated === true) : undefined}
      note={
        <>
          <NoteLine brief={COPY.readNote} />
          {note}
        </>
      }>
      {sourceHeading}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {!error && own.failed && (!last || own.failed.at > last.at) && (
        <InlineNotice tone="error">{COPY.failed(own.failed.message)}</InlineNotice>
      )}
      {!last && <SettingsRow title={reading ? COPY.reading : COPY.notYet} />}
      {last?.servers.length === 0 && <SettingsRow title={COPY.none} />}
      {last?.namesOnly && last.servers.length > 0 && <NoteLine brief={COPY.namesOnly} />}
      {last?.servers.map(server => {
        const word = harnessMcpWord(server)
        return (
          <div key={server.name} data-harness-mcp={server.name}>
            <SettingsRow
              leading={<IconTile icon={server.origin ? GlobeGlyph : TerminalGlyph} />}
              title={<code className="settings-mono">{server.name}</code>}
              description={shadowed.has(server.name.toLowerCase()) ? COPY.replacement : server.origin}
              trailing={
                last.namesOnly && !remove ? undefined : (
                  <span className="extension-trailing">
                    {!last.namesOnly && <StatusWord tone={word.tone}>{word.text}</StatusWord>}
                    {remove?.(server.name)}
                  </span>
                )
              }
            />
            {server.login && (
              <SettingsRow
                title={COPY.login}
                description={<span className="settings-mono">{server.login}</span>}
                trailing={<CopyButton text={server.login} label={COPY.copyLogin(server.name)} />}
              />
            )}
          </div>
        )
      })}
      {children}
    </SettingsGroup>
  )
}

/** What a hook's state says beside it: managed, disabled, or not trusted (Codex then does not run it). */
function hookWord(hook: HarnessHook): { tone: StatusTone; text: string } | undefined {
  if (!hook.enabled) return { tone: 'neutral', text: COPY.hookOff }
  if (hook.trust === 'untrusted') return { tone: 'neutral', text: COPY.untrusted }
  if (hook.trust === 'modified') return { tone: 'warn', text: COPY.modified }
  if (hook.managed) return { tone: 'neutral', text: COPY.managed }
  return undefined
}

/**
 * The hooks a Harness runs in its sessions, as the same read or session reported them (`HarnessMcpReport.hooks`): when
 * each runs and where it is configured, never its command. Absent when the Harness did not say.
 */
export function HarnessHooksGroup({ harness }: { harness: HarnessInfo }) {
  const last = harness.ownMcp?.last
  if (!last?.hooks) return null
  return (
    <SettingsGroup
      title={COPY.hooks}
      {...(last.hooksTruncated ? { caption: COPY.hooksPartial } : {})}
      note={<NoteLine brief={COPY.hooksNote} />}>
      {last.hooks.length === 0 && <SettingsRow title={COPY.noHooks} />}
      {last.hooks.map((hook, index) => {
        const word = hookWord(hook)
        return (
          <div key={index} data-harness-hook={hook.event}>
            <SettingsRow
              leading={<IconTile icon={Anchor} />}
              title={COPY.event[hook.event] ?? hook.event}
              description={COPY.source[hook.source] ?? hook.source}
              {...(word ? { trailing: <StatusWord tone={word.tone}>{word.text}</StatusWord> } : {})}
            />
          </div>
        )
      })}
    </SettingsGroup>
  )
}
