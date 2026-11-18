import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AUDIT_KINDS,
  type AgentFolderResult,
  type AuditEntry,
  type AuditKind,
  type AuditPage,
  type DataExportState,
  type DataInventory,
  type LeftoverAgentFolder,
} from '@latch/protocol'
import { ActionMenu, Button, ConfirmDialog, Dialog, Hint, InlineNotice, SelectButton, Spinner, StatusWord, FilterPills } from '@latch/ui'
import { api, errorMessage, MessageError, newRequestId } from '../core/api.ts'
import { folderNotice, useFolderExport } from '../agents/AgentDeleteDialog.tsx'
import { shellFolders } from '../core/shell.ts'
import { absoluteTime, formatSize, relativeTime } from '../format.ts'
import { Loading, MiddleEllipsis, NavRow, SettingsGroup, SettingsRow } from './common.tsx'
import { SettingsPages } from './navigation.tsx'
import { auditActionLabel, auditKindLabel } from './auditCopy.ts'
import { currentLocale, defineCopy, formatNumber, plural, useLocale } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    externalData:
      '各 Harness 自己保存的会话（例如它的会话文件）和模型服务那边的历史不归 Latch 管：Latch 不读、不导出，删除会话时也只按「删除」里说的处理。',
    audit: '安全记录',
    onComputer: '保存在这台电脑上',
    calculating: '正在统计',
    recalculate: '重新统计',
    dataDirectory: '数据目录',
    reveal: '在访达中显示',
    outsideDataDirectory: '数据目录之外',
    external: '不归 Latch 管的',
    recordsAndExport: '记录与导出',
    auditHint: '谁在什么时候做了什么',
    exportAgain: '没有导出，请重试。',
    exportAll: '导出全部',
    exported: '已导出',
    cancelled: '已取消',
    couldNotExport: '没有导出',
    exportDescription: '会话、记忆、待办与设置，写成文件',
    cancelling: '取消中…',
    cancel: '取消',
    export: '导出…',
    chooseLocation: '选择位置…',
    exportStructure: '在你选择的文件夹里新建「Latch 导出」文件夹，写入：',
    exportSessions: '会话：你和 Agent 说的话，Markdown 与 JSON 各一份；工具只写名称与状态',
    exportAgents: '我的 Agent 与「通用」：指令与记忆',
    exportTasks: '待办与讨论',
    exportSettings: '设置里的数据：外观、提示模板、项目与文件夹',
    exportManifest: 'manifest.json：写了哪些文件',
    excluded: '不导出：',
    excludedSecrets: '模型密钥、MCP 服务器与它们的秘密值、Harness 的环境变量：里面可以有密钥',
    excludedDevice: '设备连接记录、凭据、连接码与转发服务密钥：只在这台电脑上有效',
    excludedAudit: '安全记录：保存在这台电脑上',
    excludedTools: '工具的输出与模型的思考：里面可以有 Agent 读到的任何内容',
    excludedFiles: '附件与改动快照的内容；Harness 自己保存的会话',
    exportSecurity: '对话里形状可辨的密钥（Latch 知道的密钥值与常见的密钥格式）会被遮住，其他的不会。导出的文件不加密，放在哪里由你决定。',
    badDirectory: '选择的位置不能用来导出，换一个文件夹。',
    directoryExists: '这个位置已有同名的导出文件夹，换一个位置。',
    busy: '另一次导出还在进行，等它结束后再试。',
    invalidPath: '文件夹路径里有不可显示的字符，换一个文件夹。',
    insufficientScope: '这台设备不能读取全部数据，不能导出。',
    unreachable: '连不上 Latch 服务，请重试。',
    all: '全部',
    today: '今天',
    sevenDays: '7 天',
    thirtyDays: '30 天',
    terminal: '命令行',
    everyone: '所有人',
    devices: '设备',
    time: '时间',
    who: '谁',
    category: '类别',
    allCategories: '全部类别',
    noMatches: '没有符合条件的记录',
    olderEntries: '更早的记录',
    action: '操作',
    confirmation: '确认',
    preset: '内置选项，无需确认',
    offlineCode: '离线连接码',
    confirmedHere: '这台电脑上确认',
    sequence: '序号',
    yes: '是',
    no: '否',
    atLeast: (size: string) => `至少 ${size}`,
    tallyAt: (time: string) => `统计于${time}`,
    files: (count: number) => `${formatNumber(count)} 个文件`,
    skipped: (count: number) => `${formatNumber(count)} 个会话读不到`,
    removedDevice: (name: string) => `已移除的设备 ${name}`,
  },
  {
    externalData:
      'Each Harness and model service keeps its own session history. Latch cannot read or export it. Deletions follow the scope shown in Delete.',
    audit: 'Audit log',
    onComputer: 'Stored on this computer',
    calculating: 'Calculating',
    recalculate: 'Recalculate',
    dataDirectory: 'Data directory',
    reveal: 'Show in Finder',
    outsideDataDirectory: 'Outside the data directory',
    external: 'Managed elsewhere',
    recordsAndExport: 'Logs and export',
    auditHint: 'Who did what and when',
    exportAgain: 'Couldn’t export. Try again.',
    exportAll: 'Export all',
    exported: 'Exported',
    cancelled: 'Cancelled',
    couldNotExport: 'Couldn’t export',
    exportDescription: 'Export your sessions, memory, tasks and settings as files',
    cancelling: 'Cancelling…',
    cancel: 'Cancel',
    export: 'Export…',
    chooseLocation: 'Choose location…',
    exportStructure: 'The export creates a folder named “Latch 导出” in the location you choose. It contains:',
    exportSessions: 'Conversations with Agents in Markdown and JSON. Tools are listed by name and status.',
    exportAgents: 'Instructions and memory for My Agents and General.',
    exportTasks: 'Tasks and their discussions.',
    exportSettings: 'Appearance, prompt templates, projects and folders.',
    exportManifest: 'A manifest.json that lists the exported files.',
    excluded: 'The export excludes the following items.',
    excludedSecrets: 'Model keys, MCP servers and their secrets, and Harness environment variables that may contain keys.',
    excludedDevice: 'Device enrollments, credentials, connection codes and relay keys, which only work on this computer.',
    excludedAudit: 'This computer’s security audit log.',
    excludedTools: 'Tool output and model reasoning that can contain anything an Agent read.',
    excludedFiles: 'Attachment and change snapshot contents, and the sessions each Harness keeps.',
    exportSecurity:
      'Latch redacts known secret values and common key formats in conversations. Other values can remain. Exported files are unencrypted, so choose where you store them.',
    badDirectory: 'Choose a different folder for the export.',
    directoryExists: 'An export folder with that name already exists here. Choose a different location.',
    busy: 'An export is already running. Wait for it to finish, then try again.',
    invalidPath: 'The folder path has undisplayable characters. Choose a different folder.',
    insufficientScope: 'Export requires access to all data on this device.',
    unreachable: 'Couldn’t reach the Latch service. Try again.',
    all: 'All',
    today: 'Today',
    sevenDays: '7 days',
    thirtyDays: '30 days',
    terminal: 'Command line',
    everyone: 'Everyone',
    devices: 'Devices',
    time: 'Time',
    who: 'Who',
    category: 'Category',
    allCategories: 'All categories',
    noMatches: 'No matching entries',
    olderEntries: 'Older entries',
    action: 'Action',
    confirmation: 'Confirmation',
    preset: 'Built-in option, confirmation not required',
    offlineCode: 'Offline connection code',
    confirmedHere: 'Confirmed on this computer',
    sequence: 'Sequence',
    yes: 'Yes',
    no: 'No',
    atLeast: (size: string) => `At least ${size}`,
    tallyAt: (time: string) => `Calculated ${time}`,
    files: (count: number) => plural(count, { one: '{n} file', other: '{n} files' }),
    skipped: (count: number) => plural(count, { one: '{n} unreadable session', other: '{n} unreadable sessions' }),
    removedDevice: (name: string) => `Removed device ${name}`,
  },
)

const KIND_COPY = defineCopy<Partial<Record<DataInventory['kinds'][number]['id'], string>>>(
  {},
  {
    sessions: 'Sessions and conversations',
    snapshots: 'Change snapshots',
    memory: 'My Agents and memory',
    work: 'Tasks and discussions',
    attachments: 'Attachments',
    automations: 'Schedules and handoffs',
    usage: 'Usage records',
    audit: 'Audit log',
    devices: 'Device enrollment',
    plugins: 'Plugins and app data',
    settings: 'Settings',
    secrets: 'Secrets and credentials',
    logs: 'Logs',
  },
)

/** What is not Latch's to keep or delete, said once where it matters. */
/** 设置 › 数据: what Latch keeps on this Mac, where, how much and how long; 安全记录; 导出全部. */
export function DataSettings() {
  useLocale()
  const [page, setPage] = useState<'audit' | null>(null)
  return (
    <SettingsPages
      main={<DataMain onAudit={() => setPage('audit')} />}
      levels={page === 'audit' ? [{ key: 'audit', title: COPY.audit, content: <AuditView />, onBack: () => setPage(null) }] : []}
    />
  )
}

function sizeText(kind: DataInventory['kinds'][number]): string | undefined {
  if (kind.bytes === undefined) return undefined
  const size = formatSize(kind.bytes)
  return kind.truncated ? COPY.atLeast(size) : size
}

function DataMain({ onAudit }: { onAudit: () => void }) {
  const [inventory, setInventory] = useState<DataInventory | null>(null)
  const [error, setError] = useState('')
  const [counting, setCounting] = useState(false)
  const folders = shellFolders()
  const count = useCallback(async () => {
    setCounting(true)
    try {
      setInventory(await api<DataInventory>('data/sizes', { method: 'POST', body: {} }))
      setError('')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setCounting(false)
    }
  }, [])
  useEffect(() => {
    let live = true
    void api<DataInventory>('data')
      .then(view => {
        if (!live) return
        setInventory(view)
        // Counted once per Host run: later visits show that count until someone asks again.
        if (!view.sizedAt) void count()
      })
      .catch((cause: unknown) => {
        if (live) setError(errorMessage(cause))
      })
    return () => {
      live = false
    }
  }, [count])
  if (!inventory) return error ? <InlineNotice tone="error">{error}</InlineNotice> : <Loading />
  return (
    <div className="data-settings">
      <SettingsGroup
        title={COPY.onComputer}
        meta={
          counting ? (
            <span className="data-sized">
              <Spinner size={12} /> {COPY.calculating}
            </span>
          ) : inventory.sizedAt ? (
            <span className="data-sized">
              <span title={absoluteTime(Date.parse(inventory.sizedAt))}>{COPY.tallyAt(relativeTime(inventory.sizedAt))}</span>
              <Button size="xs" variant="ghost" onClick={() => void count()}>
                {COPY.recalculate}
              </Button>
            </span>
          ) : undefined
        }>
        <SettingsRow
          className="data-location"
          title={COPY.dataDirectory}
          description={<MiddleEllipsis text={inventory.dataDir} />}
          trailing={
            folders?.revealData ? (
              <Button size="sm" variant="outline" onClick={() => void folders.revealData?.()}>
                {COPY.reveal}
              </Button>
            ) : undefined
          }
        />
        {inventory.kinds.map(kind => (
          <SettingsRow
            key={kind.id}
            className="data-kind"
            title={<Hint label={KIND_COPY[kind.id] ?? kind.label}>{kind.entries.join(currentLocale() === 'zh-CN' ? '、' : ', ')}</Hint>}
            description={kind.retention}
            trailing={sizeText(kind) !== undefined ? <span className="data-size">{sizeText(kind)}</span> : undefined}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup title={COPY.outsideDataDirectory}>
        {inventory.elsewhere.map(place => (
          <SettingsRow
            key={place.label}
            title={place.label}
            description={place.retention}
            trailing={<MiddleEllipsis className="data-where" text={place.where} />}
          />
        ))}
      </SettingsGroup>
      <div className="settings-note">
        <Hint label={COPY.external}>{COPY.externalData}</Hint>
      </div>
      <LeftoverFolders />
      <SettingsGroup title={COPY.recordsAndExport}>
        <NavRow title={COPY.audit} description={COPY.auditHint} onClick={onAudit} />
        {folders?.exportData && <ExportRow start={folders.exportData} />}
      </SettingsGroup>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </div>
  )
}

/**
 * 已删除 Agent 的文件夹: homes whose Agent is already gone, still where the Host made them. Shown only when there are
 * some; each goes only when the person presses, exported first (the desktop app) or for good.
 */
function LeftoverFolders() {
  const [folders, setFolders] = useState<LeftoverAgentFolder[]>([])
  const read = useCallback(() => {
    void api<{ folders: LeftoverAgentFolder[] }>('data/agent-folders')
      .then(({ folders: found }) => setFolders(found))
      .catch(() => setFolders([]))
  }, [])
  useEffect(read, [read])
  if (!folders.length) return null
  return (
    <SettingsGroup title={LEFTOVER_COPY.title(formatNumber(folders.length))}>
      {folders.map(folder => (
        <LeftoverRow key={folder.key} folder={folder} onDone={read} />
      ))}
    </SettingsGroup>
  )
}

function LeftoverRow({ folder, onDone }: { folder: LeftoverAgentFolder; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState('')
  const exporting = useFolderExport({ folder: folder.key }, result => {
    setNotice(folderNotice(result) ?? '')
    onDone()
  })
  const remove = async () => {
    const { folder: result } = await api<{ folder: AgentFolderResult }>(`data/agent-folders/${folder.key}`, {
      method: 'DELETE',
      body: { requestId: newRequestId() },
    })
    const left = folderNotice(result)
    if (left) throw new MessageError(left)
    onDone()
  }
  return (
    <>
      <SettingsRow
        className="data-leftover"
        title={<MiddleEllipsis text={folder.path} />}
        description={
          exporting.running ? (
            <span className="data-export-status" role="status">
              <Spinner size={12} /> {exporting.state?.phase === 'delete' ? LEFTOVER_COPY.deleting : LEFTOVER_COPY.exporting}
            </span>
          ) : folder.contents === 'empty' ? (
            LEFTOVER_COPY.empty
          ) : undefined
        }
        trailing={
          <span className="data-leftover-actions">
            {folder.contents === 'files' && exporting.available && (
              <Button size="sm" variant="outline" disabled={exporting.running} onClick={() => void exporting.start()}>
                {LEFTOVER_COPY.exportThenDelete}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={exporting.running} onClick={() => setConfirming(true)}>
              {LEFTOVER_COPY.deleteForGood}
            </Button>
          </span>
        }
      />
      {(exporting.error || notice) && <InlineNotice tone="error">{exporting.error || notice}</InlineNotice>}
      {confirming && (
        <ConfirmDialog
          title={LEFTOVER_COPY.confirmTitle}
          message={LEFTOVER_COPY.confirmMessage}
          danger
          confirmLabel={LEFTOVER_COPY.deleteForGood}
          onClose={() => setConfirming(false)}
          onConfirm={remove}
        />
      )}
    </>
  )
}

const LEFTOVER_COPY = defineCopy(
  {
    title: (count: string) => `已删除 Agent 的文件夹（${count}）`,
    empty: '空文件夹',
    exportThenDelete: '导出后删除',
    deleteForGood: '永久删除',
    exporting: '正在导出…',
    deleting: '正在删除…',
    confirmTitle: '永久删除这个文件夹？',
    confirmMessage: '文件夹和里面的文件会删除，无法恢复。',
  },
  {
    title: (count: string) => `Folders of deleted Agents (${count})`,
    empty: 'Empty folder',
    exportThenDelete: 'Export, then delete',
    deleteForGood: 'Delete permanently',
    exporting: 'Exporting…',
    deleting: 'Deleting…',
    confirmTitle: 'Delete this folder permanently?',
    confirmMessage: 'The folder and the files in it are deleted and can’t be recovered.',
  },
)

/** 导出全部: what goes and what never does, then the native picker; progress and 取消 while it runs. */
function ExportRow({ start }: { start: NonNullable<NonNullable<ReturnType<typeof shellFolders>>['exportData']> }) {
  const [asking, setAsking] = useState(false)
  const [job, setJob] = useState<DataExportState | null>(null)
  const [error, setError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const poll = useCallback((id: string) => {
    timer.current = setTimeout(() => {
      void api<{ export: DataExportState }>(`data/export/${encodeURIComponent(id)}`)
        .then(({ export: state }) => {
          setJob(state)
          if (state.state === 'running') poll(id)
        })
        .catch((cause: unknown) => setError(errorMessage(cause)))
    }, 400)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])
  const begin = async () => {
    setAsking(false)
    setError('')
    const result = await start()
    if (result.status === 'exporting') {
      setJob({ id: result.id, state: 'running', name: result.name, startedAt: new Date().toISOString(), progress: { done: 0, total: 0 } })
      poll(result.id)
    } else if (result.status === 'failed') setError(COPY[EXPORT_FAILURES[result.code] ?? 'exportAgain'])
  }
  const cancel = async () => {
    if (!job) return
    setCancelling(true)
    try {
      setJob(
        (await api<{ export: DataExportState }>(`data/export/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: {} })).export,
      )
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setCancelling(false)
    }
  }
  const running = job?.state === 'running'
  return (
    <>
      <SettingsRow
        className="data-export"
        title={COPY.exportAll}
        description={
          job ? (
            <span className="data-export-status" role="status">
              {running ? (
                <>
                  <Spinner size={12} />
                  <span>{job.name}</span>
                  <span>
                    {job.progress.done} / {job.progress.total || '…'}
                  </span>
                </>
              ) : job.state === 'done' ? (
                <>
                  <StatusWord tone="done">{COPY.exported}</StatusWord>
                  <span>
                    {job.name}
                    {job.files === undefined ? '' : ` · ${COPY.files(job.files)}`}
                    {job.skipped ? ` · ${COPY.skipped(job.skipped)}` : ''}
                  </span>
                </>
              ) : (
                <StatusWord tone={job.state === 'cancelled' ? 'neutral' : 'failed'}>
                  {job.state === 'cancelled' ? COPY.cancelled : COPY.couldNotExport}
                </StatusWord>
              )}
            </span>
          ) : (
            COPY.exportDescription
          )
        }
        trailing={
          running ? (
            <Button size="sm" variant="ghost" loading={cancelling} loadingLabel={COPY.cancelling} onClick={() => void cancel()}>
              {COPY.cancel}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setAsking(true)}>
              {COPY.export}
            </Button>
          )
        }
      />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {asking && (
        <Dialog
          open
          size="lg"
          title={COPY.exportAll}
          onClose={() => setAsking(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAsking(false)}>
                {COPY.cancel}
              </Button>
              <Button variant="primary" onClick={() => void begin()}>
                {COPY.chooseLocation}
              </Button>
            </>
          }>
          <div className="data-export-dialog">
            <p>{COPY.exportStructure}</p>
            <ul>
              <li>{COPY.exportSessions}</li>
              <li>{COPY.exportAgents}</li>
              <li>{COPY.exportTasks}</li>
              <li>{COPY.exportSettings}</li>
              <li>{COPY.exportManifest}</li>
            </ul>
            <p>{COPY.excluded}</p>
            <ul>
              <li>{COPY.excludedSecrets}</li>
              <li>{COPY.excludedDevice}</li>
              <li>{COPY.excludedAudit}</li>
              <li>{COPY.excludedTools}</li>
              <li>{COPY.excludedFiles}</li>
            </ul>
            <p>{COPY.exportSecurity}</p>
          </div>
        </Dialog>
      )}
    </>
  )
}

/** Why main or the Host did not start an export, in words. */
const EXPORT_FAILURES: Partial<
  Record<string, 'badDirectory' | 'directoryExists' | 'busy' | 'invalidPath' | 'insufficientScope' | 'unreachable'>
> = {
  'export-folder-invalid': 'badDirectory',
  'export-folder-exists': 'directoryExists',
  'export-busy': 'busy',
  'workspace-folder-unprintable': 'invalidPath',
  'agent-scope-required': 'insufficientScope',
  'host-unavailable': 'unreachable',
}

type Span = 'all' | 'day' | 'week' | 'month'
const SPAN_MS: Record<Exclude<Span, 'all'>, number> = { day: 0, week: 7 * 864e5, month: 30 * 864e5 }

function sinceOf(span: Span): string | undefined {
  if (span === 'all') return undefined
  if (span === 'day') {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return start.toISOString()
  }
  return new Date(Date.now() - SPAN_MS[span]).toISOString()
}

function actorText(entry: AuditEntry): string {
  if (entry.actor.kind === 'host') return 'Latch'
  if (entry.actor.kind === 'cli') return COPY.terminal
  return entry.actor.name ?? COPY.removedDevice(entry.actor.short ?? '')
}

/** 安全记录: read-only, newest first, filtered by time, who and what, a page at a time. */
export function AuditView() {
  useLocale()
  const [span, setSpan] = useState<Span>('all')
  const [actor, setActor] = useState<string>('')
  const [kind, setKind] = useState<AuditKind | ''>('')
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [actors, setActors] = useState<AuditPage['actors']>([])
  const [next, setNext] = useState<number | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(
    async (before?: number) => {
      setLoading(true)
      const params = new URLSearchParams()
      if (before !== undefined) params.set('before', String(before))
      const since = sinceOf(span)
      if (since) params.set('since', since)
      if (actor) params.set('actor', actor)
      if (kind) params.set('kind', kind)
      try {
        const page = await api<AuditPage>(`audit/records?${params.toString()}`)
        setEntries(previous => (before === undefined ? page.entries : [...(previous ?? []), ...page.entries]))
        setActors(page.actors)
        setNext(page.next)
        setError('')
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setLoading(false)
      }
    },
    [span, actor, kind],
  )
  useEffect(() => {
    void load()
  }, [load])
  const actorLabel =
    actor === ''
      ? COPY.everyone
      : actor === 'host'
        ? 'Latch'
        : actor === 'cli'
          ? COPY.terminal
          : (actors.find(item => item.id === actor)?.name ?? COPY.devices)
  return (
    <div className="audit-view">
      <h1 className="settings-title audit-title">{COPY.audit}</h1>
      <div className="audit-filters">
        <FilterPills
          label={COPY.time}
          value={span}
          options={[
            { value: 'all', label: COPY.all },
            { value: 'day', label: COPY.today },
            { value: 'week', label: COPY.sevenDays },
            { value: 'month', label: COPY.thirtyDays },
          ]}
          onValueChange={setSpan}
        />
        <ActionMenu
          label={COPY.who}
          selection
          sections={[
            {
              id: 'who',
              items: [
                { id: '', label: COPY.everyone, checked: actor === '', onSelect: () => setActor('') },
                { id: 'host', label: 'Latch', checked: actor === 'host', onSelect: () => setActor('host') },
                { id: 'cli', label: COPY.terminal, checked: actor === 'cli', onSelect: () => setActor('cli') },
                ...actors.map(item => ({ id: item.id, label: item.name, checked: actor === item.id, onSelect: () => setActor(item.id) })),
              ],
            },
          ]}
          trigger={props => <SelectButton {...props}>{actorLabel}</SelectButton>}
        />
        <ActionMenu
          label={COPY.category}
          selection
          sections={[
            {
              id: 'kind',
              items: [
                { id: '', label: COPY.allCategories, checked: kind === '', onSelect: () => setKind('') },
                ...AUDIT_KINDS.map(item => ({
                  id: item,
                  label: auditKindLabel[item],
                  checked: kind === item,
                  onSelect: () => setKind(item),
                })),
              ],
            },
          ]}
          trigger={props => <SelectButton {...props}>{kind === '' ? COPY.allCategories : auditKindLabel[kind]}</SelectButton>}
        />
      </div>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {entries === null ? (
        <Loading />
      ) : entries.length === 0 ? (
        <p className="audit-empty">{COPY.noMatches}</p>
      ) : (
        <ol className="audit-list" aria-label={COPY.audit}>
          {entries.map(entry => (
            <AuditRow key={entry.seq} entry={entry} />
          ))}
        </ol>
      )}
      {next !== undefined && entries !== null && (
        <Button variant="ghost" className="audit-more" loading={loading} onClick={() => void load(next)}>
          {COPY.olderEntries}
        </Button>
      )}
    </div>
  )
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const target = entry.target ? (entry.target.name ?? entry.target.short) : undefined
  return (
    <li className="audit-row" data-seq={entry.seq}>
      <details>
        <summary>
          <time dateTime={entry.at} title={absoluteTime(Date.parse(entry.at))}>
            {relativeTime(entry.at)}
          </time>
          <span className="audit-actor">{actorText(entry)}</span>
          <span className="audit-label">{auditActionLabel(entry)}</span>
          {target && <span className="audit-target">{target}</span>}
        </summary>
        <dl className="audit-fields">
          <dt>{COPY.time}</dt>
          <dd>{absoluteTime(Date.parse(entry.at))}</dd>
          <dt>{COPY.category}</dt>
          <dd>{auditKindLabel[entry.kind]}</dd>
          <dt>{COPY.action}</dt>
          <dd>
            <code>{entry.action}</code>
          </dd>
          {entry.stepup !== 'none' && (
            <>
              <dt>{COPY.confirmation}</dt>
              <dd>{entry.stepup === 'preset' ? COPY.preset : entry.stepup === 'offline' ? COPY.offlineCode : COPY.confirmedHere}</dd>
            </>
          )}
          {entry.fields.map(field => (
            <FieldRow key={field.name} name={field.name} value={field.value} />
          ))}
          <dt>{COPY.sequence}</dt>
          <dd>{entry.seq}</dd>
        </dl>
      </details>
    </li>
  )
}

function FieldRow({ name, value }: { name: string; value: string | number | boolean }) {
  return (
    <>
      <dt>
        <code>{name}</code>
      </dt>
      <dd>{typeof value === 'boolean' ? (value ? COPY.yes : COPY.no) : String(value)}</dd>
    </>
  )
}
