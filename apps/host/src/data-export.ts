// 导出全部 (docs/ARCHITECTURE.md#导出全部): the person's own data out as files, into a new folder the Host makes inside
// one the desktop's native picker chose.
//
// What goes is an allow-list by construction: each kind below builds fresh objects from named fields of the Host's own
// records and nothing is spread from a record, so a field added to a store later does not go out until it is named here.
// Secrets have no kind: model keys (providers.json), MCP secret values and definitions, device credentials and
// registrations (auth/), the Host identity, phone connection seeds (native/), gateway credentials, audit records and
// Harness launch settings (their environment can hold keys) are never read for an export. Every exported string still
// passes `redactKnownSecrets`, which masks the Host's own key values and credential shapes should a person have pasted
// one into a conversation. Sessions are read through the hub, never from a Harness's own files.
//
// Writing: audited first; the folder is made by the Host (non-recursive mkdir, never an existing folder), its identity
// is checked before every file, and each file is created exclusively without following a link, under a name made of
// ids, never of titles. A failed or cancelled export removes the folder it made, and nothing else.
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@latch/sdk'
import { EXPORT_KINDS, type DataExportState, type ExportKind, type Message, type TaskDetail, type TaskSummary } from '@latch/protocol'
import { redactKnownSecrets, sha256Hex } from '@latch/core/node-kit'

/** How long a finished export's state stays readable. */
const KEEP_MS = 10 * 60_000
/** Names tried for the new folder: `Latch 导出 <time>`, then ` 2` to ` 20`. */
const NAME_TRIES = 20
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

/** The Host's records an export reads; each answers only what the person's own data is. */
export interface ExportSources {
  sessions: () => Promise<TaskSummary[]>
  detail: (sessionId: string) => Promise<TaskDetail>
  harnessName: (harnessId: string) => string | undefined
  /** 我的 Agent and 通用: the definition's own words and the memories. */
  owners: () => Array<{
    id: string
    name: string
    description?: string
    instructions: string
    harnessId?: string
    memories: Array<{ content: string; createdAt: string; updatedAt: string; origin: 'user' | 'agent' | 'imported'; external: boolean }>
  }>
  workItems: () => Array<{
    id: string
    title: string
    prompt: string
    tags?: string[]
    priority?: string
    closedAt?: string
    createdAt: string
    updatedAt: string
    sessionIds: string[]
    posts: Array<{ at: string; text: string; sessionId?: string; customAgentId?: string }>
  }>
  settings: () => {
    appearance: unknown
    templates: Array<{ name: string; content: string; scope: string }>
    projects: Array<{ name: string; folders: string[] }>
    shortcuts?: unknown
  }
}

export interface ExportHooks {
  /** Written before anything is made; when it throws, nothing is made. */
  audit: (detail: { exportHash: string; pathHash: string; kinds: ExportKind[] }) => Promise<void>
  /** Written after; a failure is only logged. */
  result: (detail: {
    exportHash: string
    outcome: 'done' | 'failed' | 'cancelled'
    files: number
    skipped: number
    removed?: boolean
  }) => Promise<void>
  /** Re-checks the device between files: a revoked or narrowed device stops the export. */
  recheck: () => void
}

interface Job {
  state: DataExportState
  deviceId: string
  folder: string
  identity: { dev: number; ino: number }
  cancelled: boolean
  ended: Promise<void>
}

/** What `redactKnownSecrets` leaves of a string: every string that goes out passes it. */
const clean = (text: string): string => redactKnownSecrets(text)

/**
 * A message as it goes out: the person's and the agent's words, who said them and when. A tool row is its name and
 * state only: its output can be anything the agent read (an `env`, a `.env` file), which no masking by shape can be
 * trusted to catch. Reasoning stays out for the same reason.
 */
function messageOut(message: Message) {
  const base = {
    id: message.id,
    role: message.role,
    ...(message.createdAt ? { at: message.createdAt } : {}),
    ...(message.state ? { state: message.state } : {}),
  }
  if (message.role === 'tool') return { ...base, ...(message.toolName ? { tool: clean(message.toolName) } : {}) }
  return {
    ...base,
    text: clean(message.text),
    ...(message.model ? { model: clean(message.model) } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments.map(item => ({ name: clean(item.name), size: item.size })) } : {}),
  }
}

/** A session as it goes out: what it was, and its conversation. */
export function sessionOut(summary: TaskSummary, detail: TaskDetail, harnessName: string | undefined) {
  return {
    id: summary.id,
    title: clean(summary.title),
    harness: clean(harnessName ?? summary.harnessId),
    ...(summary.model ? { model: clean(summary.model) } : {}),
    ...(summary.cwd ? { folder: clean(summary.cwd) } : {}),
    ...(summary.createdAt ? { createdAt: summary.createdAt } : {}),
    updatedAt: summary.updatedAt,
    ...(summary.imported ? { imported: true } : {}),
    messages: detail.messages.map(messageOut),
  }
}

const ROLE_WORDS: Record<Message['role'], string> = { user: '你', assistant: 'Agent', tool: '工具', system: 'Latch' }

/** The same session as Markdown, for reading. */
export function sessionMarkdown(session: ReturnType<typeof sessionOut>): string {
  const lines = [`# ${session.title || '未命名会话'}`, '', `- Harness：${session.harness}`, `- 会话：${session.id}`]
  if (session.createdAt) lines.push(`- 开始：${session.createdAt}`)
  lines.push(`- 最后更新：${session.updatedAt}`, '')
  for (const message of session.messages) {
    if (message.role === 'tool') {
      lines.push(`> 工具 ${'tool' in message ? (message.tool ?? '') : ''}${message.state ? `（${message.state}）` : ''}`, '')
      continue
    }
    lines.push(`## ${ROLE_WORDS[message.role]}${message.at ? ` · ${message.at}` : ''}`, '', 'text' in message ? message.text : '', '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

const EXCLUDED = [
  { kind: '模型密钥', why: '密钥只在这台电脑上使用' },
  { kind: 'MCP 服务器的定义与秘密值', why: '定义里可以有密钥和令牌' },
  { kind: 'Harness 的启动方式与环境变量', why: '环境变量里可以有密钥' },
  { kind: '设备登记、凭据与连接码', why: '凭据只在这台电脑上有效' },
  { kind: '手机连接与中继的密钥', why: '凭据只在这台电脑上有效' },
  { kind: '审计记录', why: '它是这台电脑的安全记录，其中有从中继密钥算出的哈希' },
  { kind: '工具的输出与模型的思考', why: '里面可以有 Agent 读到的任何内容；工具只写名称与状态' },
  { kind: '附件与改动快照的内容', why: '只导出对话，附件只写名称与大小' },
  { kind: 'Harness 自己保存的会话', why: '那是其他程序的文件，Latch 不读' },
]

/** The exports under way and recently ended; one at a time on this computer. */
export class DataExports {
  private readonly jobs = new Map<string, Job>()
  private closing = false
  private starting = false

  constructor(private readonly options: { sources: ExportSources; now?: () => number; log: (text: string) => void }) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /**
   * Makes `<parent>/Latch 导出 <time>` after the audit, answers at once, and writes in the background (`get`, `cancel`).
   * `parent` is taken by its real path.
   */
  async start(input: { deviceId: string; parent: string; hooks: ExportHooks }): Promise<DataExportState> {
    if (this.closing) throw new AppError(503, 'host-closing', '运行节点正在关闭')
    this.forgetOld()
    if (this.starting || [...this.jobs.values()].some(job => job.state.state === 'running'))
      throw new AppError(409, 'export-busy', '另一次导出还在进行，等它结束后再试。')
    // Taken before the first await, so two starts at once cannot both pass the check above.
    this.starting = true
    try {
      return await this.begin(input)
    } finally {
      this.starting = false
    }
  }

  private async begin(input: { deviceId: string; parent: string; hooks: ExportHooks }): Promise<DataExportState> {
    const parent = await realpath(input.parent).catch(() => undefined)
    const info = parent === undefined ? undefined : await lstat(parent).catch(() => undefined)
    if (!parent || !info?.isDirectory()) throw new AppError(400, 'export-folder-invalid', '选择的位置不是一个文件夹。')
    const id = randomUUID()
    const exportHash = sha256Hex(id)
    const kinds = [...EXPORT_KINDS]
    await input.hooks.audit({ exportHash, pathHash: sha256Hex(parent), kinds })
    const stamp = new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ').replace(':', '')
    let made: { folder: string; name: string } | undefined
    for (let index = 1; index <= NAME_TRIES && !made; index++) {
      const name = `Latch 导出 ${stamp}${index > 1 ? ` ${index}` : ''}`
      try {
        await mkdir(join(parent, name), { mode: 0o700 })
        made = { folder: join(parent, name), name }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
          await this.report(input.hooks, { exportHash, outcome: 'failed', files: 0, skipped: 0, removed: false })
          throw new AppError(409, 'export-folder-invalid', '不能在这个位置新建文件夹。')
        }
      }
    }
    if (!made) {
      await this.report(input.hooks, { exportHash, outcome: 'failed', files: 0, skipped: 0, removed: false })
      throw new AppError(409, 'export-folder-exists', '这个位置已有同名的导出文件夹，换一个位置。')
    }
    const stat = await lstat(made.folder)
    const job: Job = {
      state: { id, state: 'running', name: made.name, startedAt: new Date(this.now()).toISOString(), progress: { done: 0, total: 0 } },
      deviceId: input.deviceId,
      folder: made.folder,
      identity: { dev: stat.dev, ino: stat.ino },
      cancelled: false,
      ended: Promise.resolve(),
    }
    this.jobs.set(id, job)
    job.ended = this.run(job, exportHash, input.hooks)
    return this.get(input.deviceId, id)
  }

  /** The export as its own device sees it. */
  get(deviceId: string, id: string): DataExportState {
    const job = this.jobs.get(id)
    if (!job || job.deviceId !== deviceId) throw new AppError(404, 'export-not-found', '找不到这次导出。')
    return { ...job.state, progress: { ...job.state.progress } }
  }

  /** Stops between files and answers once the folder it made is removed. */
  async cancel(deviceId: string, id: string): Promise<DataExportState> {
    const job = this.jobs.get(id)
    if (!job || job.deviceId !== deviceId) throw new AppError(404, 'export-not-found', '找不到这次导出。')
    if (job.state.state === 'running') {
      job.cancelled = true
      await job.ended
    }
    return this.get(deviceId, id)
  }

  async close(): Promise<void> {
    this.closing = true
    const running = [...this.jobs.values()].filter(job => job.state.state === 'running')
    for (const job of running) job.cancelled = true
    await Promise.all(running.map(job => job.ended))
  }

  private forgetOld(): void {
    for (const [id, job] of this.jobs)
      if (job.state.state !== 'running' && this.now() - Date.parse(job.state.startedAt) > KEEP_MS) this.jobs.delete(id)
  }

  private async report(hooks: ExportHooks, detail: Parameters<ExportHooks['result']>[0]): Promise<void> {
    await hooks.result(detail).catch(error => {
      this.options.log(`导出结束的审计记录没有写入：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** The folder it made is still that folder: not replaced, not a link. */
  private async same(job: Job): Promise<boolean> {
    const info = await lstat(job.folder).catch(() => undefined)
    return !!info && info.isDirectory() && !info.isSymbolicLink() && info.dev === job.identity.dev && info.ino === job.identity.ino
  }

  private async remove(job: Job): Promise<boolean> {
    if (!(await this.same(job))) return false
    await rm(job.folder, { recursive: true, force: true })
    return true
  }

  private async run(job: Job, exportHash: string, hooks: ExportHooks): Promise<void> {
    const written: Array<{ path: string; bytes: number; sha256: string }> = []
    const skipped: Array<{ session: string; reason: string }> = []
    const madeDirs = new Set<string>()
    const stop = () => {
      if (job.cancelled) throw new AppError(409, 'export-cancelled', '导出已取消')
      hooks.recheck()
    }
    /** One file inside the folder, under a name made here; created exclusively, never through a link. */
    const write = async (dir: string | undefined, name: string, text: string) => {
      stop()
      if (!(await this.same(job))) throw new AppError(409, 'export-folder-changed', '导出文件夹在导出时被移动或替换，已停止。')
      let base = job.folder
      if (dir !== undefined) {
        base = join(job.folder, dir)
        if (!madeDirs.has(dir)) {
          await mkdir(base, { mode: 0o700 })
          madeDirs.add(dir)
        }
        const info = await lstat(base)
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new AppError(409, 'export-folder-changed', '导出文件夹在导出时被修改，已停止。')
      }
      const body = Buffer.from(text, 'utf8')
      const handle = await open(join(base, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        await handle.writeFile(body)
      } finally {
        await handle.close()
      }
      written.push({
        path: dir === undefined ? name : `${dir}/${name}`,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      })
      job.state.progress.done++
    }
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
    const fileId = (id: string) => (SAFE_ID.test(id) ? id : sha256Hex(id).slice(0, 32))
    let outcome: 'done' | 'failed' | 'cancelled' = 'done'
    try {
      const { sources } = this.options
      const sessions = await sources.sessions()
      const owners = sources.owners()
      const items = sources.workItems()
      job.state.progress.total = sessions.length * 2 + owners.length + (items.length ? 1 : 0) + 2
      for (const summary of sessions) {
        stop()
        let detail: TaskDetail
        try {
          detail = await sources.detail(summary.id)
        } catch {
          skipped.push({ session: summary.id, reason: '读不到这个会话的记录' })
          job.state.progress.done += 2
          continue
        }
        const session = sessionOut(summary, detail, sources.harnessName(summary.harnessId))
        const name = fileId(summary.id)
        await write('sessions', `${name}.json`, json(session))
        await write('sessions', `${name}.md`, sessionMarkdown(session))
      }
      for (const owner of owners)
        await write(
          'memory',
          `${fileId(owner.id)}.json`,
          json({
            id: owner.id,
            name: clean(owner.name),
            ...(owner.description ? { description: clean(owner.description) } : {}),
            instructions: clean(owner.instructions),
            ...(owner.harnessId ? { harness: clean(sources.harnessName(owner.harnessId) ?? owner.harnessId) } : {}),
            memories: owner.memories.map(memory => ({
              content: clean(memory.content),
              origin: memory.origin,
              external: memory.external,
              createdAt: memory.createdAt,
              updatedAt: memory.updatedAt,
            })),
          }),
        )
      if (items.length)
        await write(
          undefined,
          'work.json',
          json(
            items.map(item => ({
              id: item.id,
              title: clean(item.title),
              prompt: clean(item.prompt),
              ...(item.tags?.length ? { tags: item.tags.map(clean) } : {}),
              ...(item.priority ? { priority: item.priority } : {}),
              ...(item.closedAt ? { closedAt: item.closedAt } : {}),
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              sessions: [...item.sessionIds],
              thread: item.posts.map(post => ({
                at: post.at,
                text: clean(post.text),
                ...(post.sessionId ? { session: post.sessionId } : {}),
                ...(post.customAgentId ? { agent: post.customAgentId } : {}),
              })),
            })),
          ),
        )
      const settings = sources.settings()
      await write(
        undefined,
        'settings.json',
        json({
          appearance: settings.appearance,
          ...(settings.shortcuts !== undefined ? { shortcuts: settings.shortcuts } : {}),
          templates: settings.templates.map(template => ({
            name: clean(template.name),
            content: clean(template.content),
            scope: template.scope,
          })),
          projects: settings.projects.map(project => ({ name: clean(project.name), folders: project.folders.map(clean) })),
        }),
      )
      stop()
      await write(
        undefined,
        'manifest.json',
        json({
          format: 'latch-export',
          version: 1,
          exportedAt: new Date(this.now()).toISOString(),
          kinds: EXPORT_KINDS,
          files: written,
          skipped,
          excluded: EXCLUDED,
        }),
      )
    } catch (error) {
      outcome = job.cancelled ? 'cancelled' : 'failed'
      if (outcome === 'failed') this.options.log(`导出失败：${error instanceof AppError ? error.message : '写入出错'}`)
    }
    const removed = outcome === 'done' ? undefined : await this.remove(job).catch(() => false)
    job.state = {
      ...job.state,
      state: outcome,
      ...(outcome === 'done'
        ? { files: written.length, skipped: skipped.length }
        : { code: outcome === 'cancelled' ? 'export-cancelled' : 'export-failed' }),
    }
    await this.report(hooks, {
      exportHash,
      outcome,
      files: written.length,
      skipped: skipped.length,
      ...(removed !== undefined ? { removed } : {}),
    })
  }
}
