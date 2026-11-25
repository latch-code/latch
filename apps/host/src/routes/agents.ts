import { z } from 'zod'
import type {
  AgentComputer,
  AgentExportPreview,
  AgentFileSchedule,
  AgentHome,
  AgentImportPreview,
  AgentImportResult,
  ChangedFile,
  CustomAgentDetail,
  CustomAgentList,
  GeneralAgentDetail,
  HostFeatures,
  MemoryProposalList,
  ScheduleResultList,
  TaskDetail,
  TaskSummary,
} from '@latch/protocol'
import { AGENT_AVATAR_IMAGE, AGENT_FILE_BYTES, GENERAL_AGENT_ID, isNativeListener } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { parseAgentFile, type AgentActor, type AgentMutation, type CustomAgents } from '../custom-agents.ts'
import type { AgentMentions } from '../agent-mentions.ts'
import type { AgentFolders } from '../agent-folders.ts'
import type { AgentPlans } from '../agent-plans.ts'
import type { Automations } from '../automations.ts'
import type { HostComputer } from '../computer.ts'
import { activityPage, libraryPage, sessionOwner } from '../agent-activity.ts'
import { AvatarImages } from '../avatar-image.ts'
import { json, jsonBody } from '../http-util.ts'
import { CONFIG_BODY_LIMIT, type Caller, type DeviceCaller, type RouteContext, type RouteModule } from './registry.ts'

export interface AgentRouteDeps {
  agents: CustomAgents
  mentions: () => AgentMentions
  /** After an Agent is deleted: what other stores kept for it goes too. Never rejects. */
  removed?: (agentId: string) => Promise<void>
  plans: () => AgentPlans
  automations: () => Automations
  /** The same gate a session of an agent uses: its instructions and memories are private. */
  access: (caller: Caller, write?: boolean) => AgentActor
  sessions: () => Promise<TaskSummary[]>
  plugins: () => CustomAgentList['plugins']
  /** A session's detail and the files its turns changed, for 资料库. */
  detail: (sessionId: string) => Promise<TaskDetail>
  sessionFiles: (sessionId: string) => Promise<ChangedFile[] | undefined>
  computer: () => HostComputer
  home: (owner: string) => Promise<AgentHome>
  /** Starts the process of the Agent's one chat ahead of the next message; false when nothing was started. */
  warm?: (owner: string, caller: Caller) => Promise<boolean>
  /** The Agent's homes after it is deleted: removed for good, or exported first (desktop only). */
  folders: AgentFolders
  /** The desktop app on this computer: a device enrolled on host.sock, calling over host.sock. */
  requireDesktop: (caller: DeviceCaller) => void
  /** A body only the desktop's main process can sign, after its native picker. */
  signedBody: (req: Parameters<NonNullable<RouteModule['route']>>[0]['req'], caller: DeviceCaller) => Promise<Record<string, unknown>>
  /** The archive's name for an Agent: its own name, made safe for a file name. */
  archiveLabel: (owner: string) => string
}

const deletion = z.strictObject({ requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u) })
/**
 * Deleting an Agent: `folder: 'delete'` with `seen` removes for good the homes the dialog showed, each only if it still
 * holds what it showed. Without it (nothing was shown, or a page from before this choice) the homes are kept, and
 * 设置 › 数据 lists them.
 */
const agentDeletion = z
  .strictObject({
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
    folder: z.literal('delete').optional(),
    /** The homes the dialog showed (`GET …/folders`), by key with their counts: only these, only if unchanged, go. */
    seen: z
      .array(
        z.strictObject({
          key: z.string().regex(/^[0-9a-f]{32}$/u),
          entries: z.number().int().nonnegative().max(1_000_000_000),
          bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        }),
      )
      .max(64)
      .optional(),
  })
  .refine(body => (body.folder === 'delete') === (body.seen !== undefined), { message: 'folder and seen go together' })
/** 导出后删除, signed by the desktop's main process after its native picker chose `parent`. */
const folderExport = z.strictObject({
  nonce: z.string(),
  via: z.literal('agent-folder'),
  agentId: z.string().regex(/^agt_[a-f0-9-]{36}$/u),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  parent: z.string().min(1).max(4096),
})
const FOLDER_EXPORT = /^\/link\/api\/custom-agents\/(agt_[a-f0-9-]{36})\/folder-export$/u
const FOLDER_EXPORT_STATE = /^\/link\/api\/custom-agents\/folder-exports\/([A-Za-z0-9_-]{8,128})(\/cancel)?$/u
const AGENT = /^\/link\/api\/custom-agents\/(agt_[a-f0-9-]{36}|general)(?:\/memories(?:\/(mem_[a-f0-9-]{36})(\/undo|\/own)?)?)?$/u
const PROPOSALS = /^\/link\/api\/custom-agents\/(agt_[a-f0-9-]{36}|general)\/proposals(?:\/(prp_[a-f0-9-]{36})\/(save|dismiss))?$/u
/** Read-only views of an owner's own records: result cards waiting for a topic, 动态, 资料库 and 电脑. */
const VIEWS = /^\/link\/api\/custom-agents\/(agt_[a-f0-9-]{36}|general)\/(results|activity|library|computer|home|folders)$/u

/** A picture for an Agent: put in the face's place, or cleared. */
const AVATAR = /^\/link\/api\/custom-agents\/(agt_[a-f0-9-]{36})\/avatar-image$/u
/** The picture some Agent shows now, by the hash its avatar names: the handle a page reads it through. */
const AVATAR_IMAGE = /^\/link\/api\/custom-agents\/avatar-images\/([a-f0-9]{64})$/u
const avatarUpload = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  baseRevision: z.coerce.number().int().positive().safe(),
})
/** Opening an Agent's chat: its process may start before the person writes. */
const WARM = /^\/link\/api\/custom-agents\/(agt_[a-f0-9-]{36}|general)\/warm$/u
const MENTIONS = /^\/link\/api\/custom-agents\/(agt_[a-f0-9-]{36}|general)\/mentions$/u
const EXPORT = /^\/link\/api\/custom-agents\/(agt_[a-f0-9-]{36})\/export(\/preview)?$/u
const IMPORT = /^\/link\/api\/custom-agents\/import(\/preview)?$/u
/** Short enough that each schedule's own request, derived from it, still fits a request ID. */
const importSchema = z.strictObject({ requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u), file: z.unknown() })
const previewSchema = z.strictObject({ file: z.unknown() })
/** The file, and room for the request around it. */
const IMPORT_BODY_LIMIT = AGENT_FILE_BYTES + 64 * 1024

/** 我的 Agent and 通用. `/link/api/agents` keeps meaning engine definitions. */
export function createAgentRoutes(context: RouteContext, deps: AgentRouteDeps): RouteModule {
  const { agents } = deps
  const plans = { summary: (...args: Parameters<AgentPlans['summary']>) => deps.plans().summary(...args) }
  let store: Promise<AvatarImages> | undefined
  const images = () => (store ??= AvatarImages.open(context.dataDir))
  // One at a time: a picture just stored is named by its Agent before anything looks for pictures no Agent names.
  let avatarQueue: Promise<unknown> = Promise.resolve()
  const avatarTurn = <T>(work: (pictures: AvatarImages) => Promise<T>): Promise<T> => {
    const run = avatarQueue.catch(() => {}).then(async () => work(await images()))
    avatarQueue = run
    return run
  }
  /** Uploads taken in and not yet answered: each holds up to 2 MB and a turn of the decoder, so only a few wait. */
  const AVATAR_WAITING = { device: 2, all: 8 }
  const avatarUploads = new Map<string, number>()
  const sweepAvatars = () =>
    void avatarTurn(pictures => pictures.sweep(agents.avatarImages())).catch(error =>
      context.log(`不再使用的 Agent 头像没有清除：${String(error)}`),
    )
  // At start: a picture no Agent names (an upload cut short by a stop, a change made while a sweep failed) is removed,
  // and so is a file an upload left half-written.
  void avatarTurn(pictures => pictures.sweep(agents.avatarImages(), true)).catch(error =>
    context.log(`启动时没有清除不再使用的 Agent 头像：${String(error)}`),
  )
  return {
    features: () => ({ customAgents: true, agentWorkComputer: true, agentMentions: true }) satisfies HostFeatures,
    async route({ req, res, caller, path, method }) {
      if (path !== '/link/api/custom-agents' && !path.startsWith('/link/api/custom-agents/')) return false
      const actor = deps.access(caller, method !== 'GET')
      const mentions = MENTIONS.exec(path)
      if (mentions) {
        context.requireDevice(caller)
        res.setHeader('cache-control', 'no-store')
        if (method === 'GET') json(res, { mentions: await deps.mentions().list(caller, mentions[1]!) })
        else if (method === 'POST') {
          const body = await jsonBody(req, CONFIG_BODY_LIMIT)
          json(res, await deps.mentions().send(caller, mentions[1]!, body, undefined, res))
        } else throw new AppError(404, 'not-found', '接口不存在。')
        return true
      }
      const checkWorkComputer = (body: unknown) => {
        if (!body || typeof body !== 'object' || !('workComputer' in body)) return
        context.requireLocal(caller)
        const target = body.workComputer
        if (target && typeof target === 'object' && 'hostId' in target && target.hostId === context.hostId)
          throw new AppError(400, 'agent-work-computer-local', '请选择另一台电脑，或清除工作电脑以使用本机。')
      }
      const reply = <T>(result: AgentMutation<T>, code = 200) => {
        actor.authorize()
        if (!result.audited) res.setHeader('x-latch-audit', 'failed')
        context.refresh()
        json(res, result.value, code)
      }
      /** A change to what an agent's sessions and automations receive. */
      const edit = async <T>(owner: string, save: (pauseForMove: () => Promise<void>) => Promise<AgentMutation<T>>, code = 200) =>
        reply(
          await deps.automations().edit(owner === GENERAL_AGENT_ID ? undefined : owner, actor, save, () => agents.definitionHash(owner)),
          code,
        )
      /** As `edit`, without the answer: the caller answers once the pictures on disk match. */
      const saveAvatar = <T>(owner: string, save: () => Promise<AgentMutation<T>>) =>
        deps.automations().edit(owner, actor, save, () => agents.definitionHash(owner))
      if (method === 'GET') await agents.recover().catch(() => {})
      if (path === '/link/api/custom-agents') {
        if (method === 'GET') {
          const tasks = await deps.sessions()
          actor.authorize()
          const list: CustomAgentList = {
            general: { ...agents.general(), memoryCount: agents.memories(GENERAL_AGENT_ID).length },
            agents: agents.list().map(agent => plans.summary(agent, tasks)),
            plugins: deps.plugins(),
          }
          json(res, list)
          return true
        }
        if (method === 'POST') {
          const body = await jsonBody(req, CONFIG_BODY_LIMIT)
          checkWorkComputer(body)
          reply(await agents.create(body as Parameters<CustomAgents['create']>[0], actor), 201)
          return true
        }
        throw new AppError(404, 'not-found', '接口不存在。')
      }
      const picture = AVATAR_IMAGE.exec(path)
      if (picture) {
        if (method !== 'GET') throw new AppError(404, 'not-found', '接口不存在。')
        const hash = picture[1]!
        // Only what an Agent shows now, and only to a device that may read Agents (the access above).
        if (!agents.avatarImages().has(hash)) throw new AppError(404, 'agent-avatar-missing', '找不到这张头像。')
        const bytes = await (await images()).read(hash)
        actor.authorize()
        // Always the Host's own PNG, said as such; never guessed from the bytes, never run as a page.
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': bytes.length,
          'content-disposition': 'inline; filename="avatar.png"',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'",
          'cross-origin-resource-policy': 'same-origin',
          'cache-control': 'private, no-store',
        })
        res.end(bytes)
        return true
      }
      const avatar = AVATAR.exec(path)
      if (avatar) {
        const id = avatar[1]!
        if (method === 'PUT') {
          const query = new URL(req.url ?? '/', 'http://latch.invalid').searchParams
          const request = avatarUpload.parse({ requestId: query.get('requestId'), baseRevision: query.get('baseRevision') })
          // The declared type only says these are bytes; what they are is read from the bytes themselves.
          if (!req.headers['content-type']?.startsWith('application/octet-stream'))
            throw new AppError(415, 'content-type', '请用二进制内容上传图片。')
          // Refused before a byte is read: past a few waiting uploads, from one device or in all, the Host says it is busy.
          const device = actor.actor.deviceId
          const waiting = avatarUploads.get(device) ?? 0
          const total = [...avatarUploads.values()].reduce((sum, count) => sum + count, 0)
          if (waiting >= AVATAR_WAITING.device || total >= AVATAR_WAITING.all)
            throw new AppError(429, 'agent-avatar-busy', '正在处理别的图片，请稍后再试。')
          avatarUploads.set(device, waiting + 1)
          try {
            const chunks: Buffer[] = []
            let size = 0
            for await (const chunk of req) {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
              size += buffer.length
              if (size > AGENT_AVATAR_IMAGE.bytes)
                throw new AppError(413, 'agent-avatar-too-large', `图片太大，最多 ${AGENT_AVATAR_IMAGE.bytes / 1024 / 1024} MB。`, {
                  limit: 'bytes',
                })
              chunks.push(buffer)
            }
            agents.get(id)
            actor.authorize()
            // Stored, named by the Agent, and the picture it replaced removed, before the answer says it is saved.
            const saved = await avatarTurn(async pictures => {
              try {
                const image = await pictures.put(Buffer.concat(chunks))
                actor.authorize()
                return await saveAvatar(id, () => agents.setAvatarImage(id, { ...request, image }, actor))
              } finally {
                await pictures.sweep(agents.avatarImages()).catch(() => {})
              }
            })
            reply(saved)
          } finally {
            const left = (avatarUploads.get(device) ?? 1) - 1
            if (left > 0) avatarUploads.set(device, left)
            else avatarUploads.delete(device)
          }
        } else if (method === 'DELETE') {
          const body = (await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<CustomAgents['clearAvatarImage']>[1]
          const cleared = await avatarTurn(async pictures => {
            try {
              return await saveAvatar(id, () => agents.clearAvatarImage(id, body, actor))
            } finally {
              await pictures.sweep(agents.avatarImages()).catch(() => {})
            }
          })
          reply(cleared)
        } else throw new AppError(404, 'not-found', '接口不存在。')
        return true
      }
      const exported = EXPORT.exec(path)
      if (exported) {
        if (method !== 'GET') throw new AppError(404, 'not-found', '接口不存在。')
        const id = exported[1]!
        // Schedules as definitions: what and when. Their runs, grants, model and project stay here.
        const schedules: AgentFileSchedule[] = deps
          .automations()
          .list()
          .filter(item => item.customAgentId === id)
          .map(({ name, prompt, schedule, notify }) => ({ name, prompt, schedule, notify }))
        if (exported[2]) {
          // What the file would hold and leave out: read, nothing handed over yet.
          const preview: AgentExportPreview = agents.exportPreview(id, schedules)
          actor.authorize()
          res.setHeader('cache-control', 'no-store')
          json(res, preview)
          return true
        }
        const { file, body } = agents.exportFile(id, schedules)
        // Recorded before anything is handed over; without a record nothing is.
        await agents.noteExport(id, file, actor)
        // A fixed name: the Agent's own never goes into a header.
        res.setHeader('content-disposition', 'attachment; filename="agent.latch-agent.json"')
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('x-content-type-options', 'nosniff')
        res.setHeader('cache-control', 'no-store')
        res.end(body)
        return true
      }
      const imported = IMPORT.exec(path)
      if (imported) {
        if (method !== 'POST') throw new AppError(404, 'not-found', '接口不存在。')
        // The phone app reads and exports by its scope; it has no import yet. Any browser with the scope may import.
        if (isNativeListener(caller.connection.listener))
          throw new AppError(403, 'agent-import-device', '手机 App 里还不能导入，请在浏览器页面里导入。')
        const body = await jsonBody(req, IMPORT_BODY_LIMIT)
        const plan = deps.plans()
        if (imported[1]) {
          const file = parseAgentFile(previewSchema.parse(body).file)
          const { canSchedule, ...harness } = plan.harnessFor(file.agent.harnessId)
          actor.authorize()
          const preview: AgentImportPreview = {
            file,
            harness,
            canSchedule,
            nameTaken: agents.list().some(agent => agent.name === file.agent.name),
          }
          json(res, preview)
          return true
        }
        const request = importSchema.parse(body)
        const file = parseAgentFile(request.file)
        const harness = plan.harnessFor(file.agent.harnessId)
        // The Harness is fixed once the Agent exists, so one that is not here and ready creates nothing.
        if (!harness.ready)
          throw new AppError(409, 'agent-import-harness', '这台电脑上没有可用的这个 Harness，没有导入。', { harnessId: harness.id })
        const schedules = harness.canSchedule ? file.schedules : []
        const created = await agents.importAgent({ requestId: request.requestId, file, schedules: schedules.length }, actor)
        // Each schedule under a request derived from this one, switched off: a retry of the import creates none twice.
        let made = 0
        for (const [index, schedule] of schedules.entries()) {
          try {
            await deps
              .automations()
              .create({ ...schedule, customAgentId: created.value.id, enabled: false, requestId: `${request.requestId}-s${index}` }, actor)
            made++
          } catch (error) {
            // A full schedule list leaves this one out and says so in the count; anything else is the request's failure.
            if (!(error instanceof AppError) || error.code !== 'automation-limit') throw error
          }
        }
        const result: AgentImportResult = { agent: created.value, memories: file.memories.length, schedules: made }
        reply({ value: result, audited: created.audited }, 201)
        return true
      }
      const warm = WARM.exec(path)
      if (warm) {
        if (method !== 'POST') throw new AppError(404, 'not-found', '接口不存在。')
        const owner = warm[1]!
        // Only an owner that exists, and only a device that may run Agents (the write access above: run and scope all).
        agents.memories(owner)
        actor.authorize()
        const started = (await deps.warm?.(owner, caller)) ?? false
        actor.authorize()
        json(res, { started })
        return true
      }
      const view = VIEWS.exec(path)
      if (view) {
        if (method !== 'GET') throw new AppError(404, 'not-found', '接口不存在。')
        const owner = view[1]!,
          which = view[2]!
        // Each answers only for an owner that exists, and only to a device that may read Agents (the access above).
        agents.memories(owner)
        if (which === 'folders') {
          // What deleting it would find, counted by the helper: one process per home, so counted like a settings write.
          if (owner === GENERAL_AGENT_ID) throw new AppError(404, 'not-found', '接口不存在。')
          context.requireDevice(caller)
          context.limits.classC.take(caller.device.id)
          const folders = await deps.folders.view(owner)
          actor.authorize()
          json(res, folders)
          return true
        }
        if (which === 'home') {
          const hint = await deps.home(owner)
          actor.authorize()
          json(res, hint)
          return true
        }
        const params = new URL(req.url ?? '/', 'http://latch.invalid').searchParams
        const automations = deps.automations()
        if (which === 'results') {
          const list: ScheduleResultList = { results: automations.resultsOf(owner, null) }
          actor.authorize()
          json(res, list)
          return true
        }
        if (which === 'computer') {
          const computer = deps.computer()
          const view: AgentComputer = {
            computer: computer.view(),
            missed: automations.missedOf(owner).map(item => ({ ...item, cause: computer.cause(item.at) })),
          }
          actor.authorize()
          json(res, view)
          return true
        }
        // Its own sessions, by the owner each one ran for: a schedule moved to another Agent leaves its runs behind. A run
        // of 通用's schedule names no Agent and is no conversation with it, so it is 通用's while its schedule is.
        const general = new Set(owner === GENERAL_AGENT_ID ? automations.runsOf(owner).map(row => row.automation.id) : [])
        const sessions = (await deps.sessions()).filter(task => {
          const own = sessionOwner(task)
          return own === owner || (own === undefined && task.automationId !== undefined && general.has(task.automationId))
        })
        const page =
          which === 'activity'
            ? activityPage({
                sessions,
                automations: automations.runsOf(owner),
                results: automations.results().filter(item => item.owner === owner),
                memories: agents.memories(owner),
                changes: agents.memoryChanges(owner),
                proposals: agents.proposals(owner),
                recalls: agents.recalls(owner),
                before: params.get('before'),
              })
            : await libraryPage({
                sessions,
                detail: id => deps.detail(id),
                files: id => deps.sessionFiles(id),
                before: params.get('before'),
              })
        actor.authorize()
        json(res, page)
        return true
      }
      const proposal = PROPOSALS.exec(path)
      if (proposal) {
        const owner = proposal[1]!,
          proposalId = proposal[2],
          verb = proposal[3]
        if (method === 'GET' && !proposalId) {
          const list: MemoryProposalList = { proposals: agents.proposals(owner) }
          actor.authorize()
          json(res, list)
        } else if (method === 'POST' && proposalId && verb === 'save') {
          const { requestId } = deletion.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
          await edit(owner, () => agents.saveProposal(owner, proposalId, requestId, actor))
        } else if (method === 'POST' && proposalId && verb === 'dismiss') {
          const { requestId } = deletion.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
          reply(await agents.dismissProposal(owner, proposalId, requestId, actor))
        } else throw new AppError(404, 'not-found', '接口不存在。')
        return true
      }
      const exporting = FOLDER_EXPORT.exec(path)
      if (exporting && method === 'POST') {
        const owner = exporting[1]!
        context.requireDevice(caller)
        deps.requireDesktop(caller)
        const input = folderExport.parse(await deps.signedBody(req, caller))
        if (input.agentId !== owner) throw new AppError(400, 'invalid-request', '请求与 Agent 不一致。')
        actor.authorize()
        agents.get(owner)
        // The deletion that follows the export would be refused now: say so before anything is written.
        if (agents.chats()[owner]?.state === 'starting')
          throw new AppError(409, 'agent-chat-starting', '这个 Agent 的聊天还在确认是否开始。')
        const state = await deps.folders.startExport({
          deviceId: caller.device.id,
          requestId: input.requestId,
          target: { owner },
          label: deps.archiveLabel(owner),
          parent: input.parent,
          audit: event => context.audited({ ...event, actor: actor.actor, target: owner }).then(() => {}),
          recheck: () => actor.authorize(),
          // Every archive is verified: the Agent goes as any deletion does, under this request's ID.
          then: async () => {
            const removal = await deps.automations().edit(
              owner,
              actor,
              () => agents.remove(owner, input.requestId, actor),
              () => agents.definitionHash(owner),
            )
            if (!removal.audited) context.log('删除 Agent 的审计记录没有写入')
            context.refresh()
            sweepAvatars()
            await deps.removed?.(owner)
          },
          gone: () => !agents.list().some(agent => agent.id === owner),
        })
        json(res, { export: state }, 202)
        return true
      }
      const followed = FOLDER_EXPORT_STATE.exec(path)
      if (followed && ((method === 'GET' && !followed[2]) || (method === 'POST' && followed[2]))) {
        context.requireDevice(caller)
        deps.requireDesktop(caller)
        const requestId = followed[1]!
        const state = followed[2] ? await deps.folders.cancel(caller.device.id, requestId) : deps.folders.get(caller.device.id, requestId)
        if (state.state === 'done') context.refresh()
        json(res, { export: state })
        return true
      }
      const match = AGENT.exec(path)
      if (!match) throw new AppError(404, 'not-found', '接口不存在。')
      const id = match[1]!,
        memoryId = match[2],
        undo = match[3] === '/undo',
        own = match[3] === '/own',
        memories = path.includes('/memories'),
        general = id === GENERAL_AGENT_ID
      if (memories) {
        if (method === 'GET' && !memoryId) json(res, { memories: agents.memories(id) })
        else if (own && memoryId) {
          // 设为我说的: changes what the Agent's sessions receive, like any other change to a memory.
          if (method !== 'POST') throw new AppError(404, 'not-found', '接口不存在。')
          const body = (await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<CustomAgents['ownMemory']>[2]
          await edit(id, () => agents.ownMemory(id, memoryId, body, actor))
        } else if (method === 'POST' && memoryId && undo) {
          const body = (await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<CustomAgents['undoMemory']>[2]
          await edit(id, () => agents.undoMemory(id, memoryId, body, actor))
        } else if (method === 'DELETE' && memoryId && undo) {
          // 清除: a deleted memory's text goes now; nothing a session receives changes.
          const body = (await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<CustomAgents['forgetChange']>[2]
          reply(await agents.forgetChange(id, memoryId, body, actor))
        } else if (undo) throw new AppError(404, 'not-found', '接口不存在。')
        else if (method === 'POST' && !memoryId) {
          const body = (await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<CustomAgents['createMemory']>[1]
          await edit(id, () => agents.createMemory(id, body, actor), 201)
        } else if (method === 'PATCH' && memoryId) {
          const body = (await jsonBody(req, CONFIG_BODY_LIMIT)) as Parameters<CustomAgents['patchMemory']>[2]
          await edit(id, () => agents.patchMemory(id, memoryId, body, actor))
        } else if (method === 'DELETE' && memoryId) {
          const { requestId } = deletion.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
          await edit(id, () => agents.removeMemory(id, memoryId, requestId, actor))
        } else throw new AppError(404, 'not-found', '接口不存在。')
        return true
      }
      if (method === 'GET') {
        if (general) {
          const detail: GeneralAgentDetail = {
            general: agents.general(),
            memories: agents.memories(GENERAL_AGENT_ID),
            memoryChanges: agents.memoryChanges(GENERAL_AGENT_ID),
          }
          json(res, detail)
          return true
        }
        const tasks = await deps.sessions()
        actor.authorize()
        const agent = agents.get(id),
          { instructions, skills, tools, createdAt, updatedAt } = agent
        const detail: CustomAgentDetail = {
          agent: { ...plans.summary(agent, tasks), instructions, skills, ...(tools ? { tools } : {}), createdAt, updatedAt },
          memories: agents.memories(id),
          memoryChanges: agents.memoryChanges(id),
          sessions: tasks.filter(task => task.agent?.customAgentId === id),
        }
        json(res, detail)
      } else if (method === 'PATCH') {
        const body = await jsonBody(req, CONFIG_BODY_LIMIT)
        if (general) await edit(id, () => agents.patchGeneral(body as Parameters<CustomAgents['patchGeneral']>[0], actor))
        else {
          checkWorkComputer(body)
          await edit(id, pauseForMove => agents.patch(id, body as Parameters<CustomAgents['patch']>[1], actor, pauseForMove))
          // A face chosen in a picture's place leaves that picture unused.
          sweepAvatars()
        }
      } else if (method === 'DELETE' && !general) {
        const { requestId, folder, seen } = agentDeletion.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
        // A home being exported is not removed under that export: nothing happens, the Agent included.
        if (folder === 'delete') deps.folders.assertIdle(id)
        // Only this request's own deletion removes homes: a request for an Agent already gone (its homes kept by an older
        // page) never reaches them; those are 设置 › 数据's, for `admin` and `all`. A retry gets its first answer.
        const existed = agents.list().some(agent => agent.id === id)
        const result = await deps.automations().edit(
          id,
          actor,
          () => agents.remove(id, requestId, actor),
          () => agents.definitionHash(id),
        )
        sweepAvatars()
        await deps.removed?.(id)
        // The Agent is gone whatever its homes do: they are dealt with after, never on a path a client named.
        const folders = agents.list().some(agent => agent.id === id)
          ? undefined
          : await deps.folders.afterDeletion(id, requestId, existed ? seen : undefined, event =>
              context.audited({ ...event, actor: actor.actor, target: id }).then(() => {}),
            )
        actor.authorize()
        if (!result.audited) res.setHeader('x-latch-audit', 'failed')
        context.refresh()
        json(res, { ...result.value, ...(folders ? { folder: folders } : {}) })
      } else throw new AppError(404, 'not-found', '接口不存在。')
      return true
    },
  }
}
