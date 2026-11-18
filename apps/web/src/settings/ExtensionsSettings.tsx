import { useEffect, useState, type ReactNode } from 'react'
import type {
  AppSnapshot,
  ExtensionCommands,
  ExtensionsResponse,
  HarnessInfo,
  McpServersResponse,
  PluginInfo,
  PluginPackageSummary,
} from '@latch/protocol'
import { Badge, Button, CopyButton, FoldHeader, Collapse, Hint, InlineNotice, Tooltip } from '@latch/ui'
import { api, inlineError } from '../core/api.ts'
import { harnessName } from '../composerChoice.ts'
import { HarnessTile } from '../components/BrandTile.tsx'
import { TerminalFillButton } from '../components/TerminalFillButton.tsx'
import { dateTime } from '../format.ts'
import { usePromptTemplates } from '../hooks/usePromptTemplates.ts'
import { HarnessMcpGroup } from './HarnessMcp.tsx'
import { Loading, NavRow, NoteLine, SettingsGroup, SettingsRow } from './common.tsx'
import { SettingsPages, type SettingsLevel } from './navigation.tsx'
import {
  NONE,
  NOT_REPORTED,
  NOT_IMPLEMENTED,
  NOT_YET,
  READING_REPORT,
  REPORT_UNAVAILABLE,
  UNREAD,
  extensionHarnesses,
  extensionReportKey,
  harnessKinds,
  harnessSummary,
  latchPlugins,
  pluginProvides,
  takesLatchServers,
  type ExtensionEntry,
  type KindView,
  type LatchContext,
} from './extensions.ts'

const COMMANDS_NOTE = (source: string) => ({
  label: '用 Harness 自己的命令',
  detail: `按下后命令填进 Latch 的终端，补上名字或来源再由你按回车；Latch 不运行它，也不读改 Harness 的配置。命令来源：${source}`,
})

const REPORT_NOTE = {
  label: '只列 Harness 报告的',
  detail: '命令、技能与插件名称来自最近一次普通会话的报告。报告随项目而变。',
}

const REPORT_ACTION = '用这个 Harness 新建普通会话并发送消息。收到报告后会在这里显示。'

const CODE_NOTE = {
  label: '可信的本机代码',
  detail:
    '这些插件在 Host 进程里运行，能做 Latch 能做的一切。Latch 不隔离它们。只给在这台 Mac 上开发插件的人；其他人用数据插件、MCP 定义与页面。',
}

const LATCH_NOTE = {
  label: 'Latch 的部分都是数据',
  detail:
    '技能与指引经 latch-skills 服务器给 Harness；MCP 服务器经每个会话的 MCP 列表（Codex 为线程配置）给；提示词模板由 Latch 填进输入框。数据面板与页面在 Latch 里显示，不交给 Harness。',
}

const NO_PAGES: ReadonlyMap<string, number> = new Map()

function ExtensionSource({ children }: { children: string }) {
  return <h4 className="extension-source">{children}</h4>
}

function LatchEntries({ entries }: { entries: readonly ExtensionEntry[] }) {
  if (!entries.length) return null
  return (
    <>
      <ExtensionSource>Latch 提供</ExtensionSource>
      {entries.map(entry => (
        <EntryRow key={entry.key} entry={entry} />
      ))}
    </>
  )
}

/** A command the person runs: copy, and typed in at the prompt of a Latch terminal on this Mac's desktop. */
function CommandButtons({ command, label }: { command: string; label: string }) {
  return (
    <span className="command-actions">
      <CopyButton text={command} label={label} size="xs" />
      <TerminalFillButton command={command} detached />
    </span>
  )
}

const ACTION_LABEL = { install: '安装', update: '更新', remove: '卸载' } as const

/** The vendor's commands for a kind as rows; a kind without any says so with the reason behind hover. */
function CommandRows({ commands }: { commands: ExtensionCommands | undefined }) {
  if (!commands) return null
  return (
    <>
      {(['install', 'update', 'remove'] as const).flatMap(action => {
        const command = commands[action]
        if (!command) return []
        return [
          <SettingsRow
            key={action}
            className="extension-command"
            title={ACTION_LABEL[action]}
            description={<code className="settings-mono">{command.trimEnd()}</code>}
            trailing={<CommandButtons command={command} label={`复制${ACTION_LABEL[action]}命令`} />}
          />,
        ]
      })}
    </>
  )
}

function kindNote(view: KindView): ReactNode {
  return view.commands ? (
    <NoteLine brief={COMMANDS_NOTE(view.commands.source)} />
  ) : (
    <NoteLine brief={{ label: '没有安装命令', detail: view.absent ?? '' }} />
  )
}

function EntryRow({ entry, plugin = false }: { entry: ExtensionEntry; plugin?: boolean }) {
  return (
    <div data-extension={entry.key}>
      <SettingsRow
        title={
          plugin ? (
            <Tooltip content={entry.name} describe={false}>
              <span className="extension-plugin-name" tabIndex={0}>
                {entry.name}
              </span>
            </Tooltip>
          ) : (
            <span className="extension-name">{entry.name}</span>
          )
        }
        description={entry.description}
        trailing={
          (entry.detail || entry.remove) && (
            <span className="extension-trailing">
              {entry.detail && <span className="settings-row-value">{entry.detail}</span>}
              {entry.remove && <CommandButtons command={entry.remove} label={`复制卸载 ${entry.name} 的命令`} />}
            </span>
          )
        }
      />
    </div>
  )
}

/** How many of a Harness's own entries show before 全部: a Codex with its user skills reports 200. */
const SHOWN = 12

function KindGroup({ view, caption, lead }: { view: KindView; caption?: string; lead?: ReactNode }) {
  const [all, setAll] = useState(false)
  const own = all ? view.own : view.own.slice(0, SHOWN)
  return (
    <SettingsGroup
      title={view.title}
      caption={view.status === 'reported' ? caption : undefined}
      note={
        <>
          {lead}
          {kindNote(view)}
        </>
      }>
      <ExtensionSource>Harness 自带</ExtensionSource>
      {view.status === 'not-reported' && <SettingsRow dim title={NOT_REPORTED} />}
      {view.status === 'not-yet' && <SettingsRow dim title={<Hint label={NOT_YET}>{REPORT_ACTION}</Hint>} />}
      {view.status === 'reading' && <Loading label={READING_REPORT} />}
      {view.status === 'unavailable' && <SettingsRow dim title={REPORT_UNAVAILABLE} />}
      {view.status === 'unread' && <SettingsRow dim title={UNREAD} />}
      {view.status === 'not-implemented' && <SettingsRow dim title={<Hint label={NOT_IMPLEMENTED}>{view.reason}</Hint>} />}
      {view.status === 'reported' && view.own.length === 0 && !view.truncated && <SettingsRow dim title={view.empty ?? NONE} />}
      {own.map(entry => (
        <EntryRow key={entry.key} entry={entry} plugin={view.kind === 'plugins'} />
      ))}
      {view.own.length > SHOWN && (
        <SettingsRow
          title={all ? `共 ${view.own.length} 个` : `还有 ${view.own.length - SHOWN} 个`}
          trailing={
            <Button variant="link" size="xs" onClick={() => setAll(value => !value)}>
              {all ? '收起' : '全部'}
            </Button>
          }
        />
      )}
      {view.truncated && <SettingsRow dim title={view.own.length ? '只列出一部分' : '没有可显示的条目'} />}
      <CommandRows commands={view.commands} />
      <LatchEntries entries={view.latch} />
    </SettingsGroup>
  )
}

function HarnessPage({
  harness,
  kinds,
  reportedAt,
  project,
  run,
}: {
  harness: HarnessInfo
  kinds: KindView[]
  reportedAt?: string
  project?: string
  run: boolean
}) {
  const caption = reportedAt ? `会话报告于 ${dateTime(reportedAt)}${project ? ` · ${project}` : ''}` : undefined
  const mcp = kinds.find(view => view.kind === 'mcp')!
  return (
    <div className="extensions-harness" data-extensions-harness={harness.id}>
      {kinds.map(view =>
        view.kind === 'mcp' ? (
          <HarnessMcpGroup
            key="mcp"
            harness={harness}
            title={view.title}
            run={run}
            latchNames={mcp.latch.map(entry => entry.name)}
            sourceHeading={<ExtensionSource>Harness 自带</ExtensionSource>}
            remove={name => {
              const entry = mcp.own.find(item => item.name === name)
              return entry?.remove ? <CommandButtons command={entry.remove} label={`复制卸载 ${name} 的命令`} /> : undefined
            }}
            note={kindNote(view)}>
            <CommandRows commands={view.commands} />
            <LatchEntries entries={view.latch} />
          </HarnessMcpGroup>
        ) : (
          <KindGroup
            key={view.kind}
            view={view}
            {...(caption ? { caption } : {})}
            {...(view.kind === 'skills' ? { lead: <NoteLine brief={REPORT_NOTE} /> } : {})}
          />
        ),
      )}
    </div>
  )
}

/** The Harnesses that receive something, as small tiles named on hover; the rest are not drawn. */
function Receivers({ harnesses }: { harnesses: readonly HarnessInfo[] }) {
  if (!harnesses.length) return <span className="settings-row-value">没有 Harness 接收</span>
  return (
    <span className="extension-receivers">
      {harnesses.map(harness => (
        <span key={harness.id} title={harnessName(harness)} aria-label={harnessName(harness)} role="img">
          <HarnessTile harness={harness} size={20} />
        </span>
      ))}
    </span>
  )
}

function LatchProvides({
  harnesses,
  latch,
  plugins,
  pages,
  onMcp,
  onPlugins,
}: {
  harnesses: readonly HarnessInfo[]
  latch: LatchContext
  plugins: PluginInfo[] | undefined
  pages: ReadonlyMap<string, number>
  onMcp?: () => void
  onPlugins?: () => void
}) {
  const [developer, setDeveloper] = useState(false)
  const servers = harnesses.filter(takesLatchServers)
  const enabled = (latch.mcpServers ?? []).filter(server => server.enabled)
  const { data, code } = latchPlugins(plugins ?? [])
  return (
    <>
      <SettingsGroup title="Latch 提供" note={<NoteLine brief={LATCH_NOTE} />}>
        <SettingsRow title="latch-skills" description="我的 Agent 的技能与 Latch 的指引" trailing={<Receivers harnesses={servers} />} />
        <SettingsRow
          title="latch-browser"
          description="这台 Mac 的预览浏览器，桌面端开着时有"
          trailing={<Receivers harnesses={servers} />}
        />
        {latch.mcpServers && (
          <SettingsRow
            title="MCP 服务器"
            description={`${enabled.length} 个开着`}
            trailing={
              <span className="extension-trailing">
                <Receivers harnesses={servers} />
                {onMcp && (
                  <Button variant="link" size="xs" onClick={onMcp}>
                    管理
                  </Button>
                )}
              </span>
            }
          />
        )}
        <SettingsRow
          title="提示词模板"
          description={`${latch.templates?.length ?? 0} 个`}
          trailing={<span className="settings-row-value">全部 Harness</span>}
        />
        {data.map(plugin => (
          <div key={plugin.id} data-latch-plugin={plugin.id}>
            <SettingsRow
              title={plugin.name}
              description={pluginProvides(plugin, pages.get(plugin.id))}
              trailing={
                <span className="extension-trailing">
                  <Badge>数据</Badge>
                  {onPlugins && (
                    <Button variant="link" size="xs" onClick={onPlugins}>
                      管理
                    </Button>
                  )}
                </span>
              }
            />
          </div>
        ))}
      </SettingsGroup>
      {code.length > 0 && (
        <section className="extension-developer">
          <FoldHeader open={developer} onOpenChange={setDeveloper} meta={`${code.length}`}>
            本机开发者
          </FoldHeader>
          <Collapse open={developer}>
            <SettingsGroup note={<NoteLine brief={CODE_NOTE} />}>
              {code.map(plugin => (
                <div key={plugin.id} data-latch-code={plugin.id}>
                  <SettingsRow
                    title={plugin.name}
                    description={pluginProvides(plugin, pages.get(plugin.id))}
                    trailing={<Badge tone="warn">可信的本机代码</Badge>}
                  />
                </div>
              ))}
            </SettingsGroup>
          </Collapse>
        </section>
      )}
    </>
  )
}

/**
 * 设置 › 扩展: reported skills, commands, MCP servers and plugins, grouped by source for each Harness.
 */
export function ExtensionsSettings({
  snapshot,
  initialHarness,
  onSection,
}: {
  snapshot: AppSnapshot
  initialHarness?: string
  onSection?: (section: 'mcp' | 'plugins') => void
}) {
  const [open, setOpen] = useState<string | undefined>(initialHarness)
  const [reportRead, setReportRead] = useState<{ key: string; reports?: ExtensionsResponse; error?: string }>()
  const [provisions, setProvisions] = useState<{
    key: string
    servers: McpServersResponse | undefined
    plugins: PluginInfo[] | undefined
    pages: ReadonlyMap<string, number>
  }>()
  const templates = usePromptTemplates(snapshot.catalog?.features?.promptTemplates === true, snapshot.catalog?.promptTemplatesVersion)
  const mcp = snapshot.catalog?.features?.mcp === true
  const harnesses = extensionHarnesses(snapshot.catalog?.harnesses ?? [])
  const admin = snapshot.device.scopes.includes('admin')
  const reportKey = admin ? extensionReportKey(snapshot, harnesses) : undefined
  const provisionsKey = JSON.stringify([
    snapshot.instanceId,
    snapshot.host.hostId,
    snapshot.device.id,
    snapshot.device.dataScope,
    snapshot.device.scopes.toSorted(),
    snapshot.catalog?.harnesses.map(harness => [harness.id, harness.ownMcp?.last?.at]),
  ])

  useEffect(() => {
    setReportRead(undefined)
    if (!reportKey) return
    let pending: AbortController | undefined
    const read = () => {
      if (document.hidden) return
      pending?.abort()
      const controller = new AbortController()
      pending = controller
      void api<ExtensionsResponse>('extensions', { signal: controller.signal }).then(
        reports => {
          if (!controller.signal.aborted) setReportRead({ key: reportKey, reports })
        },
        cause => {
          if (!controller.signal.aborted) setReportRead({ key: reportKey, error: inlineError(cause) })
        },
      )
    }
    const visibility = () => {
      if (document.hidden) pending?.abort()
      else read()
    }
    read()
    // A directory can be replaced on disk without a snapshot changing.
    const timer = window.setInterval(read, 30_000)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      pending?.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [reportKey])

  useEffect(() => {
    if (!admin) return
    const controller = new AbortController()
    const options = { signal: controller.signal }
    void Promise.all([
      mcp ? api<McpServersResponse>('mcp/servers', options).catch(() => undefined) : undefined,
      api<{ plugins: PluginInfo[] }>('plugins', options).catch(() => undefined),
      api<{ packages: PluginPackageSummary[] }>('plugin-packages', options).catch(() => undefined),
    ]).then(([servers, plugins, packages]) => {
      if (controller.signal.aborted) return
      setProvisions({
        key: provisionsKey,
        servers,
        plugins: plugins?.plugins,
        pages: new Map((packages?.packages ?? []).map(item => [item.id, item.pages ?? 0])),
      })
    })
    return () => controller.abort()
  }, [admin, mcp, provisionsKey])

  useEffect(() => {
    setOpen(initialHarness)
  }, [initialHarness])

  // Hide an obsolete result on the first render, before its effect cleanup runs.
  const read = reportKey && reportRead?.key === reportKey ? reportRead : undefined
  const reportState = read?.error ? 'unavailable' : reportKey && !read ? 'reading' : undefined
  const currentProvisions = provisions?.key === provisionsKey ? provisions : undefined
  const servers = currentProvisions?.servers
  const latch: LatchContext = { ...(servers ? { mcpServers: servers.servers } : {}), templates }
  const reportOf = (id: string) => read?.reports?.harnesses.find(item => item.harnessId === id)?.report
  const projectName = (id: string | undefined) => snapshot.catalog?.workspaces.find(workspace => workspace.id === id)?.name
  const run = snapshot.device.scopes?.includes('run') === true

  const main = (
    <>
      {read?.error && <InlineNotice tone="error">{read.error}</InlineNotice>}
      <SettingsGroup title="Harness">
        {harnesses.length === 0 && <SettingsRow dim title="没有外部 Harness" />}
        {harnesses.map(harness => (
          <NavRow
            key={harness.id}
            className="extension-harness-row"
            leading={<HarnessTile harness={harness} size={24} />}
            record
            title={harnessName(harness)}
            description={harnessSummary(harnessKinds(harness, reportOf(harness.id), latch, reportState))}
            onClick={() => {
              setOpen(harness.id)
            }}
          />
        ))}
      </SettingsGroup>
      <LatchProvides
        harnesses={harnesses}
        latch={latch}
        plugins={currentProvisions?.plugins}
        pages={currentProvisions?.pages ?? NO_PAGES}
        {...(onSection && mcp ? { onMcp: () => onSection('mcp') } : {})}
        {...(onSection ? { onPlugins: () => onSection('plugins') } : {})}
      />
    </>
  )

  const levels: SettingsLevel[] = []
  const chosen = harnesses.find(harness => harness.id === open)
  if (chosen) {
    const report = reportOf(chosen.id)
    const project = projectName(report?.projectId)
    levels.push({
      key: `harness:${chosen.id}`,
      title: harnessName(chosen),
      onBack: () => {
        setOpen(undefined)
      },
      content: (
        <HarnessPage
          harness={chosen}
          kinds={harnessKinds(chosen, report, latch, reportState)}
          {...(report?.reportedAt ? { reportedAt: report.reportedAt } : {})}
          {...(project ? { project } : {})}
          run={run}
        />
      ),
    })
  }
  return <SettingsPages main={main} levels={levels} />
}
