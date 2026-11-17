import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AUDIT_KIND_LABELS,
  AUDIT_KINDS,
  type AuditEntry,
  type AuditKind,
  type AuditPage,
  type DataExportState,
  type DataInventory,
} from '@latch/protocol'
import { ActionMenu, Button, Dialog, Hint, InlineNotice, SelectButton, Spinner, StatusWord, FilterPills } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { shellFolders } from '../core/shell.ts'
import { absoluteTime, formatSize, relativeTime } from '../format.ts'
import { Loading, MiddleEllipsis, NavRow, SettingsGroup, SettingsRow } from './common.tsx'
import { SettingsPages } from './navigation.tsx'

/** What is not Latch's to keep or delete, said once where it matters. */
const NOT_LATCH =
  '各 Harness 自己保存的会话（例如它的会话文件）和模型服务那边的历史不归 Latch 管：Latch 不读、不导出，删除会话时也只按「删除」里说的处理。'

/** 设置 › 数据: what Latch keeps on this Mac, where, how much and how long; 审计记录; 导出全部. */
export function DataSettings() {
  const [page, setPage] = useState<'audit' | null>(null)
  return (
    <SettingsPages
      main={<DataMain onAudit={() => setPage('audit')} />}
      levels={page === 'audit' ? [{ key: 'audit', title: '审计记录', content: <AuditView />, onBack: () => setPage(null) }] : []}
    />
  )
}

function sizeText(kind: DataInventory['kinds'][number]): string | undefined {
  if (kind.bytes === undefined) return undefined
  return `${kind.truncated ? '至少 ' : ''}${formatSize(kind.bytes)}`
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
        title="保存在这台电脑上"
        meta={
          counting ? (
            <span className="data-sized">
              <Spinner size={12} /> 正在统计
            </span>
          ) : inventory.sizedAt ? (
            <span className="data-sized">
              <span title={absoluteTime(Date.parse(inventory.sizedAt))}>统计于{relativeTime(inventory.sizedAt)}</span>
              <Button size="xs" variant="ghost" onClick={() => void count()}>
                重新统计
              </Button>
            </span>
          ) : undefined
        }>
        <SettingsRow
          className="data-location"
          title="数据目录"
          description={<MiddleEllipsis text={inventory.dataDir} />}
          trailing={
            folders?.revealData ? (
              <Button size="sm" variant="outline" onClick={() => void folders.revealData?.()}>
                在访达中显示
              </Button>
            ) : undefined
          }
        />
        {inventory.kinds.map(kind => (
          <SettingsRow
            key={kind.id}
            className="data-kind"
            title={<Hint label={kind.label}>{kind.entries.join('、')}</Hint>}
            description={kind.retention}
            trailing={sizeText(kind) !== undefined ? <span className="data-size">{sizeText(kind)}</span> : undefined}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup title="数据目录之外">
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
        <Hint label="不归 Latch 管的">{NOT_LATCH}</Hint>
      </div>
      <SettingsGroup title="记录与导出">
        <NavRow title="审计记录" description="谁在什么时候做了什么" onClick={onAudit} />
        {folders?.exportData && <ExportRow start={folders.exportData} />}
      </SettingsGroup>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </div>
  )
}

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
    } else if (result.status === 'failed') setError(`没有导出（${result.code}）`)
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
        title="导出全部"
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
                  <StatusWord tone="done">已导出</StatusWord>
                  <span>
                    {job.name} · {job.files} 个文件{job.skipped ? ` · ${job.skipped} 个会话读不到` : ''}
                  </span>
                </>
              ) : (
                <StatusWord tone={job.state === 'cancelled' ? 'neutral' : 'failed'}>
                  {job.state === 'cancelled' ? '已取消' : '没有导出'}
                </StatusWord>
              )}
            </span>
          ) : (
            '会话、记忆、待办与设置，写成文件'
          )
        }
        trailing={
          running ? (
            <Button size="sm" variant="ghost" loading={cancelling} loadingLabel="取消中…" onClick={() => void cancel()}>
              取消
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setAsking(true)}>
              导出…
            </Button>
          )
        }
      />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {asking && (
        <Dialog
          open
          size="lg"
          title="导出全部"
          onClose={() => setAsking(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAsking(false)}>
                取消
              </Button>
              <Button variant="primary" onClick={() => void begin()}>
                选择位置…
              </Button>
            </>
          }>
          <div className="data-export-dialog">
            <p>在你选择的文件夹里新建「Latch 导出」文件夹，写入：</p>
            <ul>
              <li>会话：你和 Agent 说的话，Markdown 与 JSON 各一份；工具只写名称与状态</li>
              <li>我的 Agent 与「通用」：指令与记忆</li>
              <li>待办与讨论</li>
              <li>设置里的数据：外观、提示模板、项目与文件夹</li>
              <li>manifest.json：写了哪些文件</li>
            </ul>
            <p>不导出：</p>
            <ul>
              <li>模型密钥、MCP 服务器与它们的秘密值、Harness 的环境变量：里面可以有密钥</li>
              <li>设备登记、凭据、连接码与中继密钥：只在这台电脑上有效</li>
              <li>审计记录：它是这台电脑的安全记录</li>
              <li>工具的输出与模型的思考：里面可以有 Agent 读到的任何内容</li>
              <li>附件与改动快照的内容；Harness 自己保存的会话</li>
            </ul>
            <p>对话里形状可辨的密钥（Latch 知道的密钥值与常见的密钥格式）会被遮住，其他的不会。导出的文件不加密，放在哪里由你决定。</p>
          </div>
        </Dialog>
      )}
    </>
  )
}

type Span = 'all' | 'day' | 'week' | 'month'
const SPANS: ReadonlyArray<{ value: Span; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'day', label: '今天' },
  { value: 'week', label: '7 天' },
  { value: 'month', label: '30 天' },
]
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
  if (entry.actor.kind === 'cli') return '命令行'
  return entry.actor.name ?? `已移除的设备 ${entry.actor.short ?? ''}`
}

/** 审计记录: read-only, newest first, filtered by time, who and what, a page at a time. */
export function AuditView() {
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
      ? '所有人'
      : actor === 'host'
        ? 'Latch'
        : actor === 'cli'
          ? '命令行'
          : (actors.find(item => item.id === actor)?.name ?? '设备')
  return (
    <div className="audit-view">
      <div className="audit-filters">
        <FilterPills label="时间" value={span} options={SPANS} onValueChange={setSpan} />
        <ActionMenu
          label="谁"
          selection
          sections={[
            {
              id: 'who',
              items: [
                { id: '', label: '所有人', checked: actor === '', onSelect: () => setActor('') },
                { id: 'host', label: 'Latch', checked: actor === 'host', onSelect: () => setActor('host') },
                { id: 'cli', label: '命令行', checked: actor === 'cli', onSelect: () => setActor('cli') },
                ...actors.map(item => ({ id: item.id, label: item.name, checked: actor === item.id, onSelect: () => setActor(item.id) })),
              ],
            },
          ]}
          trigger={props => <SelectButton {...props}>{actorLabel}</SelectButton>}
        />
        <ActionMenu
          label="类别"
          selection
          sections={[
            {
              id: 'kind',
              items: [
                { id: '', label: '全部类别', checked: kind === '', onSelect: () => setKind('') },
                ...AUDIT_KINDS.map(item => ({
                  id: item,
                  label: AUDIT_KIND_LABELS[item],
                  checked: kind === item,
                  onSelect: () => setKind(item),
                })),
              ],
            },
          ]}
          trigger={props => <SelectButton {...props}>{kind === '' ? '全部类别' : AUDIT_KIND_LABELS[kind]}</SelectButton>}
        />
      </div>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {entries === null ? (
        <Loading />
      ) : entries.length === 0 ? (
        <p className="audit-empty">没有符合条件的记录</p>
      ) : (
        <ol className="audit-list" aria-label="审计记录">
          {entries.map(entry => (
            <AuditRow key={entry.seq} entry={entry} />
          ))}
        </ol>
      )}
      {next !== undefined && entries !== null && (
        <Button variant="ghost" className="audit-more" loading={loading} onClick={() => void load(next)}>
          更早的记录
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
          <span className="audit-label">{entry.label}</span>
          {target && <span className="audit-target">{target}</span>}
        </summary>
        <dl className="audit-fields">
          <dt>时间</dt>
          <dd>{absoluteTime(Date.parse(entry.at))}</dd>
          <dt>类别</dt>
          <dd>{AUDIT_KIND_LABELS[entry.kind]}</dd>
          <dt>操作</dt>
          <dd>
            <code>{entry.action}</code>
          </dd>
          {entry.stepup !== 'none' && (
            <>
              <dt>确认</dt>
              <dd>{entry.stepup === 'preset' ? '预设，无需确认' : entry.stepup === 'offline' ? '离线连接码' : '这台电脑上确认'}</dd>
            </>
          )}
          {entry.fields.map(field => (
            <FieldRow key={field.name} name={field.name} value={field.value} />
          ))}
          <dt>序号</dt>
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
      <dd>{typeof value === 'boolean' ? (value ? '是' : '否') : String(value)}</dd>
    </>
  )
}
