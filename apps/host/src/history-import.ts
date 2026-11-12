/**
 * Bringing a session a harness had before Latch into Latch (docs/HARNESSES.md#接入已有会话): list it, preview it with one
 * explicit load, and import it once, natively (bound to the harness's own session) or as text. Everything goes through
 * the harness's own adapter; the Host never reads a harness's files. Only devices with `run` and data scope `all`.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import type {
  HistoryImportResult,
  HistoryList,
  HistoryPreview,
  HistoryPreviewMessage,
  HistoryRow,
  HistorySources,
  Message,
  TaskDetail,
} from '@latch/protocol'
import { AppError, type Bridge, type ExternalSessionLoad, type ProjectFolder } from '@latch/sdk'
import { canonicalJson, redactSecrets, sha256Hex, writeFileAtomic } from '@latch/core/node-kit'
import { forkSeed } from './forks.ts'
import type { HarnessHub } from './hub.ts'
import type { ImportedMeta } from './session-meta.ts'
import type { DeviceCaller, RouteContext } from './routes/registry.ts'

export const HISTORY_IMPORTS_FILE = 'history-imports.json'
const MAX_RECEIPTS = 10_000
/** A row's handle and a preview's load live this long. */
export const HISTORY_HANDLE_MS = 10 * 60_000
export const HISTORY_ROWS = 50
export const PREVIEW_MESSAGES = 40
export const PREVIEW_MESSAGE_BYTES = 4 * 1024
export const PREVIEW_BYTES = 256 * 1024
const TITLE_LIMIT = 200

const requestIdText = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const harnessIdText = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u)
const projectIdText = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)
const handleText = z.string().regex(/^hh_[a-f0-9]{32}$/u)
const previewIdText = z.string().regex(/^hp_[a-f0-9]{32}$/u)
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)

const listBody = z.strictObject({ projectId: projectIdText, harnessId: harnessIdText })
const previewBody = z.strictObject({ handle: handleText })
const importBody = z
  .strictObject({
    requestId: requestIdText,
    previewId: previewIdText.optional(),
    handle: handleText.optional(),
    /** A session brought in natively whose harness lost it: rebuilt as text. */
    fromTaskId: z.string().min(1).max(256).optional(),
    /** The harness to continue in; absent: the one the session came from. */
    harnessId: harnessIdText.optional(),
  })
  .refine(body => [body.previewId, body.handle, body.fromTaskId].filter(Boolean).length === 1, '请指定一个要接入的会话。')

/**
 * Written before anything of an import happens, so that a retry with the same request (after a timeout or a Host restart)
 * finishes or answers the same import instead of starting another. Keyed by `requestId` alone, which a device with data
 * scope `all` sends again from its new credential after a restart; a different body under it is refused. `taskId` is
 * known first for a native import.
 */
const receiptSchema = z.strictObject({
  requestId: requestIdText,
  deviceId: z.string().min(1).max(64),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  from: harnessIdText,
  harnessId: harnessIdText,
  mode: z.enum(['native', 'text']),
  state: z.enum(['pending', 'done']),
  workspaceId: projectIdText.optional(),
  agentSessionId: z.string().min(1).max(512).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  fromTaskId: z.string().min(1).max(256).optional(),
  /** Only while pending, with `cwd`: a finished receipt keeps only what answers a retry. */
  title: z.string().max(TITLE_LIMIT).optional(),
  taskId: z.string().min(1).max(256).optional(),
  at: isoTime,
})
type Receipt = z.infer<typeof receiptSchema>
const fileSchema = z.object({ version: z.literal(1), imports: z.array(receiptSchema).max(MAX_RECEIPTS) })

/** The import receipts, one file, written atomically; a failed write leaves the previous receipts in memory and on disk. */
export class HistoryReceipts {
  private queue: Promise<void> = Promise.resolve()

  private constructor(
    private readonly path: string,
    private receipts: Map<string, Receipt>,
  ) {}

  static async open(dataDir: string): Promise<HistoryReceipts> {
    const path = join(dataDir, HISTORY_IMPORTS_FILE)
    const text = await readFile(path, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    const receipts = new Map<string, Receipt>()
    if (text !== undefined) {
      let parsed: z.infer<typeof fileSchema>
      try {
        parsed = fileSchema.parse(JSON.parse(text))
      } catch {
        throw new AppError(500, 'config-corrupt', `接入记录文件 ${path} 无法读取，原文件已保留；请修复或移走后重启`)
      }
      for (const receipt of parsed.imports) receipts.set(receipt.requestId, receipt)
    }
    return new HistoryReceipts(path, receipts)
  }

  get(requestId: string): Receipt | undefined {
    const receipt = this.receipts.get(requestId)
    return receipt && structuredClone(receipt)
  }

  put(receipt: Receipt): Promise<void> {
    return this.change(next => {
      next.delete(receipt.requestId)
      next.set(receipt.requestId, receiptSchema.parse(receipt))
      // The oldest finished ones go first; a pending one is kept until it is finished or undone.
      for (const [key, value] of next) {
        if (next.size <= MAX_RECEIPTS) break
        if (value.state === 'done') next.delete(key)
      }
      if (next.size > MAX_RECEIPTS) throw new AppError(409, 'history-receipt-limit', '未完成的接入过多，请稍后再试。')
    })
  }

  delete(requestId: string): Promise<void> {
    return this.change(next => void next.delete(requestId))
  }

  private change(edit: (next: Map<string, Receipt>) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const next = new Map(this.receipts)
      edit(next)
      await writeFileAtomic(this.path, JSON.stringify({ version: 1, imports: [...next.values()] }) + '\n', {
        prefix: `${HISTORY_IMPORTS_FILE}.`,
      })
      this.receipts = next
    })
    this.queue = run.then(
      () => {},
      () => {},
    )
    return run
  }
}

interface Source {
  deviceId: string
  harnessId: string
  workspaceId: string
  agentSessionId: string
  /** As the harness listed it. */
  cwd: string
  title: string
  expiresAt: number
}

interface Preview {
  previewId: string
  source: Source
  load: ExternalSessionLoad
  timer: NodeJS.Timeout
}

export interface HistoryProject {
  id: string
  folders: ReadonlyArray<ProjectFolder>
}

export interface HistoryDeps {
  /** A saved project, or undefined. */
  project(id: string): HistoryProject | undefined
  /** Refuses a project whose folders are gone or disabled, as a new session would be refused. */
  assertProjectUsable(id: string): Promise<void>
  /**
   * Starts an ordinary private session as `POST /tasks` would, but with no turn: `seed` waits for the person's first
   * message, whose sending is the consent to send it to the model service.
   */
  startText(
    caller: DeviceCaller,
    input: { requestId: string; seed: string; harnessId: string; workspaceId: string; title: string; privateFrom: string },
    res: ServerResponse,
  ): Promise<{ sessionId: string }>
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/** At most `limit` UTF-8 bytes, never half a character. */
function clipBytes(text: string, limit: number): { text: string; clipped: boolean } {
  if (Buffer.byteLength(text) <= limit) return { text, clipped: false }
  return { text: Buffer.from(text).subarray(0, limit).toString('utf8').replace(/�+$/u, ''), clipped: true }
}

function toolStatus(state: Message['state']): HistoryPreviewMessage['status'] {
  if (state === 'running' || state === 'completed' || state === 'failed' || state === 'cancelled') return state
  return undefined
}

/** What a preview shows: the last messages, user and agent text and tool calls without output, everything redacted. */
export function previewMessages(messages: readonly Message[]): { messages: HistoryPreviewMessage[]; cut: boolean } {
  const shown = messages.filter(message => message.role === 'user' || message.role === 'assistant' || message.role === 'tool')
  let cut = shown.length > PREVIEW_MESSAGES
  const out: HistoryPreviewMessage[] = shown.slice(-PREVIEW_MESSAGES).map(message => {
    if (message.role === 'tool') {
      const title = clipBytes(redactSecrets(message.tool?.title ?? message.toolName ?? '工具'), PREVIEW_MESSAGE_BYTES)
      const status = toolStatus(message.state)
      return { role: 'tool', text: title.text, outputHidden: true, ...(status ? { status } : {}) }
    }
    const text = clipBytes(redactSecrets(message.text), PREVIEW_MESSAGE_BYTES)
    return { role: message.role as 'user' | 'assistant', text: text.text, ...(text.clipped ? { clipped: true as const } : {}) }
  })
  // Room for the rest of the answer; the messages give way from the oldest.
  let bytes = Buffer.byteLength(JSON.stringify(out))
  while (out.length && bytes > PREVIEW_BYTES - 4 * 1024) {
    bytes -= Buffer.byteLength(JSON.stringify(out.shift())) + 1
    cut = true
  }
  return { messages: out, cut }
}

/** The text of a session for a new one: user and agent messages only, through the fork's seed, marked as a rebuild. */
export function textSeed(
  messages: readonly Message[],
  label: string,
): { text: string; prefixLength: number; truncated: boolean } | undefined {
  const kept = messages
    .filter(message => (message.role === 'user' || message.role === 'assistant') && message.text.trim())
    .map((message, index) => ({ id: `m${index}`, role: message.role, text: redactSecrets(message.text) }))
  if (!kept.length) return undefined
  const detail = { summary: { id: 'history', status: 'idle' }, messages: kept } as unknown as TaskDetail
  const seed = forkSeed(
    detail,
    kept.at(-1)!.id,
    (title, turn) => `以下是从 ${label} 接入的会话「${title}」到第 ${turn} 轮为止的对话文字（按文字重建，不是原样恢复）`,
  )
  return { text: seed.text, prefixLength: seed.context.prefixLength, truncated: seed.context.truncated === true }
}

export class HistoryImports {
  private readonly sources = new Map<string, Source>()
  private readonly previews = new Map<string, Preview>()
  private readonly inflight = new Map<string, { payloadHash: string; promise: Promise<HistoryImportResult> }>()
  /** Imports of one external session run one after another. */
  private readonly serials = new Map<string, Promise<unknown>>()

  constructor(
    private readonly context: RouteContext,
    private readonly receipts: HistoryReceipts,
    private readonly deps: HistoryDeps,
  ) {}

  private get hub(): HarnessHub {
    return this.context.hub
  }

  /** `run`, and data scope `all`: what is brought in was never under Latch's authority. */
  allData(caller: Parameters<RouteContext['requireScope']>[0]): asserts caller is DeviceCaller {
    this.context.requireScope(caller, 'run')
    this.context.recheck(caller, 'run')
    if (this.context.devices.get(caller.device.id)?.dataScope !== 'all')
      throw new AppError(403, 'history-scope', '接入已有会话需要这台设备能查看全部数据。')
  }

  close(): void {
    for (const preview of this.previews.values()) void this.closePreview(preview)
  }

  listSources(caller: DeviceCaller, projectId: string | null): HistorySources {
    this.allData(caller)
    if (projectId !== null && !this.deps.project(projectIdText.parse(projectId)))
      throw new AppError(409, 'workspace-unavailable', '找不到所选项目')
    return {
      sources: this.hub.historyDrivers().map(driver => ({
        harnessId: driver.id,
        label: driver.label,
        available: driver.ready,
        ...(driver.ready ? {} : { reason: 'unavailable' as const }),
      })),
    }
  }

  private bridge(harnessId: string): Bridge {
    const driver = this.hub.historyDrivers().find(item => item.id === harnessId)
    if (!driver) throw new AppError(409, 'history-not-supported', '这个 Harness 不能接入已有会话。')
    if (!driver.ready || !driver.bridge) throw new AppError(409, 'harness-unavailable', `${driver.label} 当前不可用`)
    return driver.bridge
  }

  private async usableProject(projectId: string): Promise<HistoryProject> {
    const project = this.deps.project(projectId)
    if (!project?.folders.length) throw new AppError(409, 'workspace-unavailable', '找不到所选项目')
    await this.deps.assertProjectUsable(projectId)
    return project
  }

  /**
   * Which record an external session ID belongs to: the store the harness's adapter reads, as the driver names it (for
   * ACP, its command: definitions running the same adapter read the same store), else the harness.
   */
  private storeOf(harnessId: string): string {
    return this.hub.historyStoreOf(harnessId) ?? `harness:${harnessId}`
  }

  private sameSource(imported: ImportedMeta, store: string, agentSessionId: string): boolean {
    return imported.agentSessionId === agentSessionId && (imported.store ?? `harness:${imported.from}`) === store
  }

  /** The Latch session already brought in from this external session, if it still exists. */
  private async importedBy(from: string, agentSessionId: string): Promise<string | undefined> {
    const store = this.storeOf(from)
    for (const { sessionId, imported } of this.hub.importedSessions()) {
      if (!this.sameSource(imported, store, agentSessionId)) continue
      const exists = await this.hub.harnessOf(sessionId).then(
        () => true,
        () => false,
      )
      if (exists) return sessionId
    }
    return undefined
  }

  async list(caller: DeviceCaller, body: unknown): Promise<HistoryList> {
    this.allData(caller)
    const input = listBody.parse(body)
    const project = await this.usableProject(input.projectId)
    const bridge = this.bridge(input.harnessId)
    if (!bridge.listExternalSessions) throw new AppError(409, 'history-not-supported', '这个 Harness 不能接入已有会话。')
    await this.context.audited({
      action: 'history.list',
      actor: this.context.actorOf(caller),
      stepup: 'none',
      detail: { harnessId: input.harnessId, workspaceId: project.id },
    })
    this.allData(caller)
    // One listing process per harness at a time.
    const listed = await this.serial(`list\n${input.harnessId}`, () => bridge.listExternalSessions!())
    this.allData(caller)
    const own = new Set(this.hub.agentSessionIds())
    const imported = new Map<string, string>()
    for (const { sessionId, imported: record } of this.hub.importedSessions())
      if (record.agentSessionId && this.sameSource(record, this.storeOf(input.harnessId), record.agentSessionId))
        imported.set(record.agentSessionId, sessionId)
    const main = await realpath(project.folders[0]!.path)
    const others = (await Promise.all(project.folders.slice(1).map(folder => realpath(folder.path).catch(() => undefined)))).filter(
      (path): path is string => path !== undefined,
    )
    const found: Array<Omit<HistoryRow, 'handle'> & { agentSessionId: string; cwd: string; at: number }> = []
    let otherFolders = 0
    for (const session of listed.sessions) {
      // A session Latch started is Latch's to continue, not to bring in.
      if (own.has(session.agentSessionId)) continue
      const real = isAbsolute(session.cwd) ? await realpath(session.cwd).catch(() => undefined) : undefined
      if (!real) continue
      if (within(main, real)) {
        const at = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN
        const importedTaskId = imported.get(session.agentSessionId)
        found.push({
          agentSessionId: session.agentSessionId,
          cwd: session.cwd,
          title:
            redactSecrets(session.title ?? '')
              .slice(0, TITLE_LIMIT)
              .trim() || '未命名会话',
          ...(Number.isFinite(at) ? { updatedAt: new Date(at).toISOString() } : {}),
          subdir: relative(main, real),
          ...(importedTaskId ? { importedTaskId } : {}),
          at: Number.isFinite(at) ? at : 0,
        })
      } else if (others.some(folder => within(folder, real))) otherFolders++
      // Outside the project: not returned, not counted.
    }
    found.sort((a, b) => b.at - a.at)
    // A device's handles are those of its latest listing.
    for (const [handle, source] of this.sources) if (source.deviceId === caller.device.id) this.sources.delete(handle)
    this.expire()
    const expiresAt = this.context.now() + HISTORY_HANDLE_MS
    const rows = found.slice(0, HISTORY_ROWS).map(({ agentSessionId, cwd, at: _at, ...row }) => {
      const handle = `hh_${randomBytes(16).toString('hex')}`
      this.sources.set(handle, {
        deviceId: caller.device.id,
        harnessId: input.harnessId,
        workspaceId: project.id,
        agentSessionId,
        cwd,
        title: row.title,
        expiresAt,
      })
      return { handle, ...row }
    })
    return { rows, otherFolders, scanned: listed.sessions.length, truncated: listed.truncated }
  }

  private expire(): void {
    const now = this.context.now()
    for (const [handle, source] of this.sources) if (source.expiresAt <= now) this.sources.delete(handle)
  }

  private sourceOf(caller: DeviceCaller, handle: string): Source {
    this.expire()
    const source = this.sources.get(handle)
    if (!source || source.deviceId !== caller.device.id) throw new AppError(410, 'history-handle-expired', '列表已过期，请重新打开。')
    return source
  }

  async preview(caller: DeviceCaller, body: unknown): Promise<HistoryPreview> {
    this.allData(caller)
    const { handle } = previewBody.parse(body)
    const source = this.sourceOf(caller, handle)
    const project = await this.usableProject(source.workspaceId)
    const bridge = this.bridge(source.harnessId)
    if (!bridge.loadExternalSession) throw new AppError(409, 'history-not-supported', '这个 Harness 不能接入已有会话。')
    await this.context.audited({
      action: 'history.preview',
      actor: this.context.actorOf(caller),
      stepup: 'none',
      detail: { harnessId: source.harnessId, workspaceId: project.id, agentSessionHash: sha256Hex(source.agentSessionId) },
    })
    this.allData(caller)
    // One preview per device: the agent holds the session while a load has it open.
    for (const preview of this.previews.values()) if (preview.source.deviceId === caller.device.id) await this.closePreview(preview)
    const load = await bridge.loadExternalSession({
      agentSessionId: source.agentSessionId,
      cwd: source.cwd,
      workspaceId: project.id,
      folders: project.folders.map(({ id, path }) => ({ id, path })),
    })
    const previewId = `hp_${randomBytes(16).toString('hex')}`
    const preview: Preview = {
      previewId,
      source: { ...source, expiresAt: this.context.now() + HISTORY_HANDLE_MS },
      load,
      timer: setTimeout(() => void this.closePreview(preview), HISTORY_HANDLE_MS),
    }
    preview.timer.unref()
    this.previews.set(previewId, preview)
    try {
      this.allData(caller)
    } catch (error) {
      await this.closePreview(preview)
      throw error
    }
    const shown = previewMessages(load.messages)
    return {
      previewId,
      title: source.title,
      ...(load.model ? { model: redactSecrets(load.model).slice(0, TITLE_LIMIT) } : {}),
      turns: load.turns,
      messages: shown.messages,
      truncated: shown.cut || load.droppedBefore > 0,
    }
  }

  async closePreviewOf(caller: DeviceCaller, previewId: string): Promise<void> {
    this.context.requireScope(caller, 'run')
    const preview = this.previews.get(previewIdText.parse(previewId))
    if (preview && preview.source.deviceId === caller.device.id) await this.closePreview(preview)
  }

  private async closePreview(preview: Preview): Promise<void> {
    if (this.previews.get(preview.previewId) !== preview) return
    this.previews.delete(preview.previewId)
    clearTimeout(preview.timer)
    const driver = this.hub.historyDrivers().find(item => item.id === preview.source.harnessId)
    await driver?.bridge?.closeExternalSession?.(preview.load.loadId).catch(() => {})
  }

  async receipt(caller: DeviceCaller, requestId: string): Promise<HistoryImportResult | { requestId: string; state: 'pending' }> {
    this.allData(caller)
    const receipt = this.receipts.get(requestIdText.parse(requestId))
    if (!receipt) throw new AppError(404, 'history-import-not-found', '没有这次接入的记录。')
    if (receipt.state === 'pending' || !receipt.taskId) return { requestId: receipt.requestId, state: 'pending' }
    return { requestId: receipt.requestId, taskId: receipt.taskId, mode: receipt.mode }
  }

  /** Idempotent by `requestId` for this device: a retry, also after a restart, finishes or answers the same import. */
  import(caller: DeviceCaller, body: unknown, res: ServerResponse): Promise<HistoryImportResult> {
    this.allData(caller)
    const input = importBody.parse(body)
    const payloadHash = sha256Hex(canonicalJson(input))
    const key = input.requestId
    const running = this.inflight.get(key)
    if (running) {
      if (running.payloadHash !== payloadHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同的接入')
      return running.promise
    }
    const promise = this.importOnce(caller, input, payloadHash, res).finally(() => this.inflight.delete(key))
    this.inflight.set(key, { payloadHash, promise })
    return promise
  }

  private async importOnce(
    caller: DeviceCaller,
    input: z.infer<typeof importBody>,
    payloadHash: string,
    res: ServerResponse,
  ): Promise<HistoryImportResult> {
    const known = this.receipts.get(input.requestId)
    if (known) {
      if (known.payloadHash !== payloadHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同的接入')
      if (known.state === 'done' && known.taskId) {
        const exists = await this.hub.harnessOf(known.taskId).then(
          () => true,
          () => false,
        )
        if (!exists) throw new AppError(410, 'task-deleted', '接入的会话已删除。')
        return { requestId: known.requestId, taskId: known.taskId, mode: known.mode }
      }
    }
    let preview: Preview | undefined
    const receipt: Receipt = known ?? (await this.newReceipt(caller, input, payloadHash, found => (preview = found)))
    const sourceKey = receipt.agentSessionId ? `${receipt.from}\n${receipt.agentSessionId}` : `task\n${receipt.fromTaskId}`
    return this.serial(sourceKey, () => this.run(caller, input, receipt, !known, preview, res))
  }

  private async newReceipt(
    caller: DeviceCaller,
    input: z.infer<typeof importBody>,
    payloadHash: string,
    using: (preview: Preview) => void,
  ): Promise<Receipt> {
    const base = {
      requestId: input.requestId,
      deviceId: caller.device.id,
      payloadHash,
      state: 'pending' as const,
      at: new Date(this.context.now()).toISOString(),
    }
    if (input.fromTaskId) {
      const detail = await this.hub.detail(input.fromTaskId)
      const imported = detail.summary.imported
      if (!imported || imported.mode !== 'native') throw new AppError(409, 'history-not-imported', '这个会话不是接入的会话。')
      const harnessId = input.harnessId ?? detail.summary.harnessId
      return {
        ...base,
        from: imported.from,
        harnessId,
        mode: 'text',
        fromTaskId: detail.summary.id,
        ...(detail.summary.workspaceId ? { workspaceId: detail.summary.workspaceId } : {}),
        title: redactSecrets(detail.summary.title).slice(0, TITLE_LIMIT),
      }
    }
    let source: Source
    if (input.previewId) {
      const found = this.previews.get(input.previewId)
      if (!found || found.source.deviceId !== caller.device.id)
        throw new AppError(410, 'history-handle-expired', '预览已过期，请重新打开。')
      using(found)
      source = found.source
    } else source = this.sourceOf(caller, input.handle!)
    const harnessId = input.harnessId ?? source.harnessId
    const mode = harnessId === source.harnessId ? 'native' : 'text'
    return {
      ...base,
      from: source.harnessId,
      harnessId,
      mode,
      workspaceId: source.workspaceId,
      agentSessionId: source.agentSessionId,
      cwd: source.cwd,
      title: source.title,
      ...(mode === 'native' ? { taskId: `task-${randomUUID()}` } : {}),
    }
  }

  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.serials.get(key) ?? Promise.resolve()
    const next = previous.then(work, work)
    const settled = next.then(
      () => {},
      () => {},
    )
    this.serials.set(key, settled)
    void settled.then(() => {
      if (this.serials.get(key) === settled) this.serials.delete(key)
    })
    return next
  }

  private async run(
    caller: DeviceCaller,
    input: z.infer<typeof importBody>,
    receipt: Receipt,
    fresh: boolean,
    preview: Preview | undefined,
    res: ServerResponse,
  ): Promise<HistoryImportResult> {
    this.allData(caller)
    if (receipt.agentSessionId) {
      const taken = await this.importedBy(receipt.from, receipt.agentSessionId)
      if (taken && taken !== receipt.taskId)
        throw new AppError(409, 'history-already-imported', '这个会话已经接入过了。', { taskId: taken })
      if (this.hub.agentSessionIds().includes(receipt.agentSessionId))
        throw new AppError(409, 'history-latch-session', '这是 Latch 自己开始的会话，直接在 Latch 里打开它。')
    }
    if (receipt.workspaceId) await this.usableProject(receipt.workspaceId)
    const harness = this.hub.info(receipt.harnessId)
    if (!harness || !this.hub.has(receipt.harnessId) || harness.status !== 'ready')
      throw new AppError(409, 'harness-unavailable', harness?.statusMessage ?? `Harness ${receipt.harnessId} 当前不可用`)
    if (receipt.mode === 'text' && !this.hub.acceptsSeed(receipt.harnessId))
      throw new AppError(409, 'history-not-supported', `${harness.capabilities.display.label} 还不能按文字接入。`)
    // On record before anything happens; nothing happens without it.
    await this.context.audited({
      action: 'history.import',
      actor: this.context.actorOf(caller),
      ...(receipt.taskId ? { target: receipt.taskId } : {}),
      stepup: 'none',
      detail: {
        harnessId: receipt.harnessId,
        from: receipt.from,
        mode: receipt.mode,
        requestHash: sha256Hex(receipt.requestId),
        ...(receipt.workspaceId ? { workspaceId: receipt.workspaceId } : {}),
        ...(receipt.agentSessionId ? { agentSessionHash: sha256Hex(receipt.agentSessionId) } : {}),
        ...(receipt.fromTaskId ? { fromTaskId: receipt.fromTaskId } : {}),
        ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
      },
    })
    this.allData(caller)
    if (fresh) await this.receipts.put(receipt)
    try {
      const taskId = receipt.mode === 'native' ? await this.native(receipt, preview) : await this.text(caller, input, receipt, preview, res)
      const { title: _title, cwd: _cwd, ...kept } = receipt
      await this.receipts.put({ ...kept, state: 'done', taskId })
      if (preview) await this.closePreview(preview)
      return { requestId: receipt.requestId, taskId, mode: receipt.mode }
    } catch (error) {
      // Undone only when it surely did not happen; otherwise a retry with the same request finishes it.
      if (error instanceof AppError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        if (receipt.mode === 'native' && receipt.taskId) await this.hub.forgetImported(receipt.taskId).catch(() => {})
        await this.receipts.delete(receipt.requestId).catch(() => {})
      }
      throw error
    }
  }

  private async native(receipt: Receipt, preview: Preview | undefined): Promise<string> {
    const project = await this.usableProject(receipt.workspaceId!)
    const taskId = receipt.taskId!
    // Private from the moment it exists: the record comes first.
    await this.hub.recordImported(
      taskId,
      { from: receipt.from, store: this.storeOf(receipt.from), mode: 'native', agentSessionId: receipt.agentSessionId! },
      project.id,
    )
    await this.hub.adoptExternal(receipt.harnessId, {
      sessionId: taskId,
      agentSessionId: receipt.agentSessionId!,
      cwd: receipt.cwd!,
      workspaceId: project.id,
      folders: project.folders.map(({ id, path }) => ({ id, path })),
      title: receipt.title ?? '',
      ...(preview && preview.source.agentSessionId === receipt.agentSessionId ? { loadId: preview.load.loadId } : {}),
    })
    return taskId
  }

  private async text(
    caller: DeviceCaller,
    input: z.infer<typeof importBody>,
    receipt: Receipt,
    preview: Preview | undefined,
    res: ServerResponse,
  ): Promise<string> {
    const label = this.hub.info(receipt.from)?.capabilities.display.label ?? receipt.from
    let messages: Message[]
    let workspaceId = receipt.workspaceId
    if (receipt.fromTaskId) {
      const detail = await this.hub.detail(receipt.fromTaskId)
      messages = detail.messages
      workspaceId ??= detail.summary.workspaceId ?? 'default'
    } else if (preview && preview.source.agentSessionId === receipt.agentSessionId) messages = preview.load.messages
    else {
      const project = await this.usableProject(receipt.workspaceId!)
      const bridge = this.bridge(receipt.from)
      const load = await bridge.loadExternalSession!({
        agentSessionId: receipt.agentSessionId!,
        cwd: receipt.cwd!,
        workspaceId: project.id,
        folders: project.folders.map(({ id, path }) => ({ id, path })),
      })
      await bridge.closeExternalSession?.(load.loadId).catch(() => {})
      messages = load.messages
    }
    const seed = textSeed(messages, label)
    if (!seed) throw new AppError(409, 'history-empty', '这个会话里没有可以带上的对话文字。')
    this.allData(caller)
    const created = await this.deps.startText(
      caller,
      {
        // The same import starts the same session, also after a restart.
        requestId: `hist_${sha256Hex(receipt.requestId).slice(0, 40)}`,
        seed: seed.text,
        harnessId: receipt.harnessId,
        workspaceId: workspaceId ?? 'default',
        title: receipt.title ?? '',
        privateFrom: receipt.fromTaskId ?? `history:${receipt.from}:${sha256Hex(receipt.agentSessionId ?? '')}`,
      },
      res,
    )
    await this.hub.recordImported(created.sessionId, {
      from: receipt.from,
      ...(receipt.agentSessionId ? { store: this.storeOf(receipt.from) } : {}),
      mode: 'text',
      ...(receipt.agentSessionId ? { agentSessionId: receipt.agentSessionId } : {}),
      ...(receipt.fromTaskId ? { fromTaskId: receipt.fromTaskId } : {}),
      prefixLength: seed.prefixLength,
      ...(seed.truncated ? { truncated: true as const } : {}),
    })
    return created.sessionId
  }
}
