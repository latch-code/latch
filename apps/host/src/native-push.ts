import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { escapeSecurityText } from '@latch/protocol'
import type { Approval, DeviceScope, ToolKind } from '@latch/protocol'
import { redactKnownSecrets, writeFileAtomic } from '@latch/core/node-kit'
import {
  appleSender,
  approvalAgent,
  approvalCommand,
  approvalManifest,
  approvalTargetLimit,
  pushRoute,
  pushTicket,
  pushToken,
  readPushFile,
  type AppleSend,
  type ApprovalPreview,
} from './apple-push.ts'

const previewKey = z
  .base64()
  .length(44)
  .refine(key => {
    const bytes = Buffer.from(key, 'base64')
    return bytes.length === 32 && bytes.toString('base64') === key
  })
const enable = z.strictObject({ route: pushRoute, token: pushToken, start: pushToken.optional(), previewKey: previewKey.optional() })
const activity = z.strictObject({ route: pushRoute, ticket: pushTicket, update: pushToken })
const lookup = z.strictObject({ route: pushRoute, ticket: pushTicket })
export const pushChange = z.union([enable, activity, z.strictObject({ disabled: z.literal(true) })])
export const pushLookup = lookup
const saved = enable.extend({ current: pushTicket.optional(), update: pushToken.optional() })
const records = z.record(z.string().min(1).max(256), saved)
type Subscription = z.infer<typeof saved>
export interface PendingPush {
  sessionId: string
  id: string
  kind: 'approval' | 'question'
  private: boolean
  scope: DeviceScope
  approvalPreview?: ApprovalPreview
  sessionPreview?: { title: string; fileName?: string | undefined }
}
interface PushOptions {
  active(deviceId: string): { private: boolean; scopes: DeviceScope[] } | undefined
  privateNow?(sessionId: string): boolean
  settledApproval(id: string): boolean
  pending(): Promise<PendingPush[]>
}
const refused = () => new AppError(409, 'push-unavailable', '这台电脑未配置 Apple 推送，或推送登记暂时不可用。')

const fileOperations = { read: 'readFile', edit: 'editFile', delete: 'deleteFile', move: 'moveFile' } as const
const knownTools = new Map<string, ToolKind>([
  ['write_file', 'edit'],
  ['apply_patch', 'edit'],
  ['read_file', 'read'],
  ['shell', 'execute'],
])
const fileTypes = new Map<string, NonNullable<ApprovalPreview['approvalFileType']>>([
  ['swift', 'Swift'],
  ['ts', 'TypeScript'],
  ['tsx', 'TypeScript'],
  ['js', 'JavaScript'],
  ['jsx', 'JavaScript'],
  ['py', 'Python'],
  ['rs', 'Rust'],
  ['go', 'Go'],
  ['json', 'JSON'],
  ['md', 'Markdown'],
  ['toml', 'TOML'],
  ['yml', 'YAML'],
  ['yaml', 'YAML'],
])
const sensitiveFilePart =
  /credential|password|secret|token|private[._-]?key|api[._-]?key|^id_|^\.(?:aws|azure|config|docker|env|gnupg|latch|ssh)(?:$|[._-])/iu

function plainFileName(path: string): string | undefined {
  const parts = path.split('/')
  const name = parts.at(-1) ?? ''
  if (
    path.includes('\\')
    || escapeSecurityText(path) !== path
    || !/^[a-z0-9][a-z0-9_.-]{0,79}$/iu.test(name)
    || !parts.every(part => !sensitiveFilePart.test(part))
    || redactKnownSecrets(name) !== name
    || !(approvalManifest.safeParse(name).success || (name.includes('.') && fileTypes.has(name.split('.').at(-1) ?? '')))
  )
    return undefined
  return name
}

function sealSessionPreview(
  key: string,
  route: string,
  ticket: string,
  preview: NonNullable<PendingPush['sessionPreview']>,
): string | undefined {
  const title = Array.from(escapeSecurityText(redactKnownSecrets(preview.title)))
    .slice(0, 96)
    .join('')
    .trim()
  if (!title) return undefined
  const fileName = preview.fileName && plainFileName(preview.fileName) === preview.fileName ? preview.fileName : undefined
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), nonce)
  cipher.setAAD(Buffer.from(`latch-ios-approval-session:v1\n${route}\n${ticket}`))
  const sealed = Buffer.concat([cipher.update(JSON.stringify({ title, fileName })), cipher.final()])
  return Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString('base64')
}
const outsideSandbox = '允许后，这条命令在沙箱之外运行'
const stdinGrant = '允许后，Codex 向这个正在运行的命令写入内容'
const structuredInput = z.record(z.string(), z.unknown())
const commandInput = z.strictObject({
  command: z.string(),
  args: z.array(z.string()).max(4).optional(),
  cwd: z.string().optional(),
  workdir: z.string().optional(),
  description: z.string().optional(),
  reason: z.string().optional(),
  timeout: z.number().optional(),
  timeout_ms: z.number().optional(),
  grants: z.tuple([z.enum(['允许后运行这条命令', outsideSandbox])]).optional(),
})

function approvalInput(raw: string): Record<string, unknown> | undefined {
  if (raw.length > 64 * 1024) return undefined
  try {
    return structuredInput.safeParse(JSON.parse(raw)).data
  } catch {
    return undefined
  }
}

function commandPreview(
  inputs: (Record<string, unknown> | undefined)[],
  codex: boolean,
): Pick<ApprovalPreview, 'approvalCommand' | 'approvalOutsideSandbox'> {
  let display: ApprovalPreview['approvalCommand']
  let outside = false
  for (const value of inputs) {
    const args = commandInput.safeParse(value).data
    if (!args || (args.grants && !codex)) return {}
    const parts = [args.command, ...(args.args ?? [])]
    if (args.args?.length && parts.some(part => /\s/u.test(part))) return {}
    const command = approvalCommand.safeParse(parts.join(' ')).data
    if (!command || (display && command !== display)) return {}
    display = command
    outside ||= args.grants?.[0] === outsideSandbox
  }
  return display ? { approvalCommand: display, ...(outside ? { approvalOutsideSandbox: true } : {}) } : {}
}

/** Only the fixed preview may travel in clear. A safe basename, when proven, may be sealed for the subscribed phone. */
export function approvalPresentation(
  approval: Pick<Approval, 'tool' | 'toolName' | 'arguments' | 'risk' | 'advisory' | 'plan'>,
  verifiedPresetId?: string,
  builtinWriter = false,
): { preview?: ApprovalPreview; fileName?: string | undefined } {
  const tool = approval.tool
  const kind = tool?.kind ?? knownTools.get(approval.toolName)
  const agent = approvalAgent.safeParse(verifiedPresetId).data
  const labels = {
    ...(agent ? { approvalAgent: agent } : {}),
    ...(approval.risk === 'R2' && !approval.advisory ? { approvalRisk: 'elevated' as const } : {}),
  }
  const inputs = [...new Set([approval.arguments, tool?.input])].flatMap(raw => (raw === undefined ? [] : [approvalInput(raw)]))
  if (approval.plan || tool?.plan) return { preview: { ...labels, approvalOperation: 'reviewPlan' } }
  if (agent === 'codex') {
    if (inputs.some(input => input && Object.hasOwn(input, 'network'))) return { preview: { ...labels, approvalOperation: 'allowNetwork' } }
    if (inputs.some(input => input && Object.hasOwn(input, 'grantRoot')))
      return { preview: { ...labels, approvalOperation: 'grantAccess' } }
    if (inputs.some(input => Array.isArray(input?.grants) && input.grants[0] === stdinGrant))
      return { preview: { ...labels, approvalOperation: 'provideInput' } }
  }
  switch (kind) {
    case 'read':
    case 'edit':
    case 'delete':
    case 'move': {
      const base = { ...labels, approvalOperation: fileOperations[kind] }
      const locations = tool?.locations ?? []
      const diffs = tool?.diffs ?? []
      if (!Array.isArray(locations) || !Array.isArray(diffs)) return { preview: base }
      // ACP limits the projected location and diff lists. At the limit a count could understate the request.
      if (approval.advisory && (locations.length >= 64 || diffs.length >= 32)) return { preview: base }
      const places = new Set(locations)
      const changes = new Set(diffs.map(diff => diff?.path))
      // Drivers can spell the same path differently in each list. Report a count only when their evidence agrees.
      if (places.size && changes.size && (places.size !== changes.size || [...places].some(path => !changes.has(path))))
        return { preview: base }
      let reported = [...(places.size ? places : changes)]
      if (!reported.length) {
        const expectedClaudeTool =
          (kind === 'edit' && ['Edit', 'Write'].includes(approval.toolName)) || (kind === 'read' && approval.toolName === 'Read')
        const expectedBuiltinTool =
          !approval.advisory
          && ((kind === 'edit' && approval.toolName === 'write_file') || (kind === 'read' && approval.toolName === 'read_file'))
        const key = expectedClaudeTool && agent === 'claude-agent' ? 'file_path' : expectedBuiltinTool ? 'path' : undefined
        if (key && inputs.length > 0) {
          const values = inputs.map(input => input?.[key])
          const only = values[0]
          if (typeof only === 'string' && values.every(value => value === only)) reported = [only]
        }
      }
      const usable = reported.every(path => typeof path === 'string' && path.trim() && !path.endsWith('/') && !/:\d+$/u.test(path))
      if (!reported.length || reported.length > approvalTargetLimit || !usable) return { preview: base }
      // The built-in writer distinguishes a missing file from an unreadable one. Agent diffs are their own claims.
      const diff = diffs[0]
      let change: ApprovalPreview['approvalFileChange']
      if (
        kind === 'edit'
        && builtinWriter
        && !approval.advisory
        && reported.length === 1
        && diffs.length === 1
        && diff?.path === reported[0]
        && typeof diff.newText === 'string'
      ) {
        if (diff.previous === 'none' && diff.oldText === undefined) change = 'create'
        if (diff.previous === 'text' && typeof diff.oldText === 'string' && diff.oldText !== diff.newText) change = 'modify'
      }
      const file = { ...base, ...(change ? { approvalFileChange: change } : {}) }
      const names = reported.map(path => path.split('/').at(-1) ?? '')
      const fileName = kind === 'edit' && (builtinWriter || agent) && reported.length === 1 ? plainFileName(reported[0]!) : undefined
      const manifest = names.length === 1 ? approvalManifest.safeParse(names[0]).data : undefined
      if (manifest) return { preview: { ...file, approvalManifest: manifest }, fileName }
      const types = names.map(name => (name.includes('.') ? fileTypes.get(name.split('.').at(-1) ?? '') : undefined))
      const type = types[0]
      return {
        preview: {
          ...file,
          approvalTargetCount: reported.length,
          ...(type && types.every(current => current === type) ? { approvalFileType: type } : {}),
        },
        fileName,
      }
    }
    case 'search':
      return { preview: { ...labels, approvalOperation: 'search' } }
    case 'execute':
      return { preview: { ...labels, approvalOperation: 'runCommand', ...commandPreview(inputs, agent === 'codex') } }
    case 'fetch':
      return { preview: { ...labels, approvalOperation: 'fetch' } }
  }
  return {}
}

/** One outstanding nudge per phone. Only an authenticated body window may resolve the opaque ticket to a live decision. */
export class NativePush {
  private serial: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private running = false
  private again = false
  private closed = false
  private readonly changing = new Set<string>()
  private readonly sending = new Map<string, { abort: AbortController; item?: PendingPush; publicPreview: boolean }>()
  private readonly delayedUntil = new Map<string, number>()
  private soon = false
  private failed = 0
  constructor(
    private readonly options: PushOptions,
    private readonly send: AppleSend,
    private readonly key: Buffer,
    private readonly entries: Record<string, Subscription>,
    private readonly save: (entries: Record<string, Subscription>) => Promise<void>,
  ) {}

  static async open(dir: string, options: PushOptions, connectApple?: Parameters<typeof appleSender>[1]): Promise<NativePush | undefined> {
    const send = await appleSender(dir, connectApple)
    if (!send) return undefined
    try {
      const folder = join(dir, 'identity'),
        path = join(folder, 'apns-devices.enc'),
        keyPath = join(folder, 'apns-devices.key')
      const contents = await readPushFile(path)
      let key = await readPushFile(keyPath)
      if (key) key = Buffer.from(key.toString(), 'base64')
      if (!key && !contents) {
        key = randomBytes(32)
        await writeFileAtomic(keyPath, key.toString('base64'))
      }
      if (!key || key.length !== 32) throw refused()
      let entries: Record<string, Subscription> = {}
      if (contents) {
        const bytes = Buffer.from(contents.toString(), 'base64')
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
        decipher.setAuthTag(bytes.subarray(12, 28))
        const decoded = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
        entries = records.parse(JSON.parse(decoded.toString('utf8')))
      }
      return new NativePush(options, send, key, entries, async values => {
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(values)), cipher.final()])
        if (encrypted.length + 28 > 192 * 1024) throw refused()
        await writeFileAtomic(path, Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'))
      })
    } catch {
      throw refused()
    }
  }

  private ticket(deviceId: string, route: string, item: PendingPush): string {
    return createHmac('sha256', this.key)
      .update(JSON.stringify([deviceId, route, item.sessionId, item.kind, item.id]))
      .digest('hex')
      .slice(0, 32)
  }
  private visible(deviceId: string, all: PendingPush[]) {
    const access = this.options.active(deviceId)
    return access
      ? all.filter(
          item =>
            access.scopes.includes(item.scope)
            && (access.private || !this.isPrivate(item))
            // A driver's detail may still show the request after the Host kept the decision receipt.
            && (item.kind !== 'approval' || !this.options.settledApproval(item.id)),
        )
      : []
  }
  private isPrivate(item: PendingPush): boolean {
    return item.private || this.options.privateNow?.(item.sessionId) === true
  }
  private persist(): Promise<void> {
    const snapshot = structuredClone(this.entries)
    const next = this.serial.then(() => this.save(snapshot))
    this.serial = next.catch(() => {})
    return next
  }
  async change(deviceId: string, input: z.infer<typeof pushChange>, authorize: () => void): Promise<void> {
    authorize()
    if ('disabled' in input) {
      await this.remove(deviceId)
      return
    }
    if (this.changing.has(deviceId)) throw new AppError(409, 'push-busy', '正在更新这台设备的通知登记，请重试。')
    if (!this.options.active(deviceId)) throw refused()
    const old = this.entries[deviceId]
    if ('update' in input) {
      if (!old || old.route !== input.route || old.current !== input.ticket) throw refused()
      this.entries[deviceId] = { ...old, update: input.update }
    } else {
      if (Object.values(this.entries).some(entry => entry !== old && (entry.route === input.route || entry.token === input.token)))
        throw refused()
      const same = old?.route === input.route
      if (old && (!same || old.previewKey !== input.previewKey)) this.sending.get(deviceId)?.abort.abort()
      this.entries[deviceId] = {
        ...input,
        ...(same && old.current ? { current: old.current } : {}),
        ...(same && old.update ? { update: old.update } : {}),
      }
    }
    const next = this.entries[deviceId]
    this.changing.add(deviceId)
    try {
      await this.persist()
      authorize()
      if (this.entries[deviceId] !== next) throw refused()
    } catch (error) {
      if (this.entries[deviceId] === next) {
        if (old) this.entries[deviceId] = old
        else delete this.entries[deviceId]
        await this.persist().catch(() => {})
      }
      throw error
    } finally {
      this.changing.delete(deviceId)
    }
    this.schedule()
  }
  async remove(deviceId: string) {
    this.sending.get(deviceId)?.abort.abort()
    delete this.entries[deviceId]
    this.delayedUntil.delete(deviceId)
    await this.persist()
  }
  async resolve(deviceId: string, hint: z.infer<typeof lookup>, authorize: () => void) {
    authorize()
    const sub = this.entries[deviceId]
    if (sub?.route !== hint.route || !this.options.active(deviceId)) return undefined
    const all = await this.options.pending()
    authorize()
    if (this.entries[deviceId] !== sub || this.changing.has(deviceId)) return undefined
    return this.visible(deviceId, all).find(item => this.ticket(deviceId, sub.route, item) === hint.ticket)
  }
  schedule() {
    for (const [id, flight] of this.sending) {
      if (
        !this.options.active(id)
        || (flight.item && (!this.visible(id, [flight.item]).length || (flight.publicPreview && this.isPrivate(flight.item))))
      )
        flight.abort.abort()
    }
    if (this.closed || !Object.keys(this.entries).length) return
    if (this.running) {
      this.again = true
      return
    }
    if (this.soon) return
    this.soon = true
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.soon = false
      this.timer = undefined
      void this.flush()
    }, 350)
    this.timer.unref()
  }
  async flush() {
    if (this.running || this.closed) return
    clearTimeout(this.timer)
    this.soon = false
    this.running = true
    try {
      const all = await this.options.pending()
      for (const [id, sub] of Object.entries(this.entries)) {
        if (this.closed) break
        if (this.changing.has(id) || !this.options.active(id) || this.entries[id] !== sub || (this.delayedUntil.get(id) ?? 0) > Date.now())
          continue
        const visible = this.visible(id, all)
        if (sub.current && visible.some(item => this.ticket(id, sub.route, item) === sub.current)) continue
        const candidate = visible[0]
        const ending = sub.current && sub.update
        if (!ending && !candidate && !sub.current) continue
        if (!ending && !candidate) {
          delete sub.current
          await this.persist()
          continue
        }
        const ticket = ending ? sub.current! : this.ticket(id, sub.route, candidate!)
        const token = ending || sub.start || sub.token
        const kind = ending ? 'end' : sub.start ? 'start' : 'alert'
        const publicApproval = kind === 'start' && candidate?.kind === 'approval' && !this.isPrivate(candidate) ? candidate : undefined
        const preview = publicApproval?.approvalPreview
        const session =
          sub.previewKey && publicApproval?.sessionPreview
            ? sealSessionPreview(sub.previewKey, sub.route, ticket, publicApproval.sessionPreview)
            : undefined
        const abort = new AbortController()
        this.sending.set(id, { abort, ...(!ending && candidate ? { item: candidate } : {}), publicPreview: !!(preview || session) })
        try {
          const outcome = await this.send(
            {
              kind,
              token,
              route: sub.route,
              ticket,
              attention: candidate?.kind ?? 'approval',
              approvalPreview: preview,
              approvalSession: session,
            },
            abort.signal,
          )
          if (abort.signal.aborted || this.entries[id] !== sub) continue
          if (outcome === 'retry') {
            this.delayedUntil.set(id, Date.now() + 30_000)
            continue
          }
          if (ending) {
            delete sub.current
            delete sub.update
          } else if (outcome === 'accepted') {
            sub.current = ticket
            delete sub.update
          } else if (sub.start) {
            delete sub.start
            delete sub.current
          } else {
            delete this.entries[id]
          }
          await this.persist()
          this.again = true
        } finally {
          this.sending.delete(id)
        }
      }
      this.failed = 0
    } catch {
      this.failed = Math.min(this.failed + 1, 4)
    } finally {
      this.running = false
      if (!this.closed && Object.keys(this.entries).length) {
        this.timer = setTimeout(
          () => {
            this.soon = false
            this.timer = undefined
            void this.flush()
          },
          this.again ? 350 : 30_000 * (1 + this.failed),
        )
        this.timer.unref()
      }
      this.again = false
    }
  }
  close() {
    this.closed = true
    clearTimeout(this.timer)
    for (const flight of this.sending.values()) flight.abort.abort()
    return this.serial
  }
}
