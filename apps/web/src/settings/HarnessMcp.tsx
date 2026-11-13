import { useState } from 'react'
import type { HarnessInfo, HarnessMcpServer, HarnessMcpState } from '@latch/protocol'
import { Button, CopyButton, GlobeGlyph, InlineNotice, StatusWord, TerminalGlyph, type StatusTone } from '@latch/ui'
import { api, inlineError } from '../core/api.ts'
import { harnessName } from '../composerChoice.ts'
import { HarnessTile } from '../components/BrandTile.tsx'
import { dateTime } from '../format.ts'
import { IconTile, NoteLine, SettingsGroup, SettingsRow } from './common.tsx'

/** Where a person looks for a Harness's own MCP servers and it cannot say which it has. */
export const NOT_REPORTED = '这个 Harness 不报告自己的 MCP'

const STATE: Readonly<Record<HarnessMcpState, { tone: StatusTone; text: string }>> = {
  ready: { tone: 'done', text: '可用' },
  starting: { tone: 'running', text: '正在启动' },
  'needs-login': { tone: 'warn', text: '需要登录' },
  failed: { tone: 'failed', text: '失败' },
  cancelled: { tone: 'neutral', text: '已取消' },
  disabled: { tone: 'neutral', text: '已停用' },
  'not-started': { tone: 'neutral', text: '未启动' },
  unknown: { tone: 'neutral', text: '状态未知' },
}

/** A Harness's server in a few words: its state, with the tool count once it is up. */
export function harnessMcpWord(server: Pick<HarnessMcpServer, 'state' | 'tools'>): { tone: StatusTone; text: string } {
  const word = STATE[server.state]
  return server.state === 'ready' && server.tools !== undefined ? { ...word, text: `${word.text} · ${server.tools} 个工具` } : word
}

const READ_NOTE = {
  label: '读取会启动它配置的服务器',
  detail:
    'Latch 不读写 Harness 自己的配置文件，只显示它经协议报告的服务器。读取时 Harness 在一个空文件夹里启动它配置的每个 MCP 服务器；会话里的状态随它的报告更新。这些服务器的调用不经过 Latch，没有记录。',
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
}: {
  harness: HarnessInfo
  title: string
  /** This device may start sessions, so it may ask for 读取, which starts the same program. */
  run: boolean
  /** Latch's own servers: one of the same name replaces the Harness's in Latch's sessions. */
  latchNames?: readonly string[]
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const own = harness.ownMcp
  if (!own)
    return (
      <SettingsGroup title={title}>
        <SettingsRow dim title={NOT_REPORTED} />
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
        run && (
          <Button
            variant="link"
            size="xs"
            loading={reading}
            disabled={reading || harness.status !== 'ready'}
            onClick={() => {
              void read()
            }}>
            读取
          </Button>
        )
      }
      caption={
        last ? `${last.via === 'read' ? '读取' : '会话报告'}于 ${dateTime(last.at)}${last.truncated ? ' · 只列出一部分' : ''}` : undefined
      }
      note={<NoteLine brief={READ_NOTE} />}>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {!error && own.failed && (!last || own.failed.at > last.at) && (
        <InlineNotice tone="error">{`读取失败：${own.failed.message}`}</InlineNotice>
      )}
      {!last && <SettingsRow title={reading ? '正在读取…' : '还没有报告'} />}
      {last?.servers.length === 0 && <SettingsRow title="没有 MCP 服务器" />}
      {last?.servers.map(server => {
        const word = harnessMcpWord(server)
        return (
          <div key={server.name} data-harness-mcp={server.name}>
            <SettingsRow
              leading={<IconTile icon={server.origin ? GlobeGlyph : TerminalGlyph} />}
              title={<code className="settings-mono">{server.name}</code>}
              description={shadowed.has(server.name.toLowerCase()) ? '会话里用 Latch 的同名服务器' : server.origin}
              trailing={<StatusWord tone={word.tone}>{word.text}</StatusWord>}
            />
            {server.login && (
              <SettingsRow
                title="登录命令"
                description={<span className="settings-mono">{server.login}</span>}
                trailing={<CopyButton text={server.login} label={`复制 ${server.name} 的登录命令`} />}
              />
            )}
          </div>
        )
      })}
    </SettingsGroup>
  )
}

/** 设置 › MCP's lower half: each external Harness's own servers, or that it does not report them. */
export function HarnessesMcp({
  harnesses,
  run,
  latchNames,
}: {
  harnesses: readonly HarnessInfo[]
  run: boolean
  latchNames: readonly string[]
}) {
  const external = harnesses.filter(harness => harness.editable && !harness.offer)
  const silent = external.filter(harness => !harness.ownMcp)
  return (
    <>
      {external
        .filter(harness => harness.ownMcp)
        .map(harness => (
          <HarnessMcpGroup
            key={harness.id}
            harness={harness}
            title={`${harnessName(harness)} 自己的 MCP`}
            run={run}
            latchNames={latchNames}
          />
        ))}
      {silent.length > 0 && (
        <SettingsGroup title="Harness 自己的 MCP">
          {silent.map(harness => (
            <SettingsRow
              key={harness.id}
              dim
              leading={<HarnessTile harness={harness} size={24} />}
              title={harnessName(harness)}
              description={NOT_REPORTED}
            />
          ))}
        </SettingsGroup>
      )}
    </>
  )
}
