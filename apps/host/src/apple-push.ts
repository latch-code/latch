import { createPrivateKey, sign } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { connect } from 'node:http2'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { AGENT_PRESETS } from '@latch/protocol'

const configSchema = z.strictObject({
  environment: z.enum(['sandbox', 'production']),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/u),
  keyId: z.string().regex(/^[A-Z0-9]{10}$/u),
  privateKey: z.string().min(1).max(4096),
})
export const pushToken = z.string().regex(/^(?:[0-9a-f]{2}){16,256}$/u)
export const pushRoute = z.uuid()
export const pushTicket = z.string().regex(/^[0-9a-f]{32}$/u)
const sealedApprovalSession = z.base64().min(40).max(768)
export const approvalManifest = z.enum(['package.json', 'Package.swift', 'pyproject.toml', 'Cargo.toml', 'go.mod'])
export const approvalCommand = z.enum([
  'pnpm test',
  'pnpm check:quick',
  'npm test',
  'swift test',
  'swift test --parallel',
  'git status',
  'git status --short',
  'git diff',
  'git diff --stat',
  'cargo test',
  'go test ./...',
  'python -m pytest',
])
export const approvalFileType = z.enum(['Swift', 'TypeScript', 'JavaScript', 'Python', 'Rust', 'Go', 'JSON', 'Markdown', 'TOML', 'YAML'])
export const approvalAgent = z.enum(AGENT_PRESETS.map(preset => preset.id))
export const approvalTargetLimit = 10_000
const approvalPreview = z.strictObject({
  approvalOperation: z.enum([
    'readFile',
    'editFile',
    'deleteFile',
    'moveFile',
    'search',
    'runCommand',
    'fetch',
    'allowNetwork',
    'grantAccess',
    'provideInput',
    'reviewPlan',
  ]),
  approvalManifest: approvalManifest.optional(),
  approvalCommand: approvalCommand.optional(),
  approvalTargetCount: z.int().positive().max(approvalTargetLimit).optional(),
  approvalFileType: approvalFileType.optional(),
  approvalFileChange: z.enum(['create', 'modify']).optional(),
  approvalAgent: approvalAgent.optional(),
  approvalRisk: z.literal('elevated').optional(),
  approvalOutsideSandbox: z.literal(true).optional(),
})
export type ApprovalPreview = z.infer<typeof approvalPreview>
type AppleDelivery = 'accepted' | 'invalid' | 'retry'
export type AppleSend = (message: AppleMessage, signal: AbortSignal) => Promise<AppleDelivery>
export interface AppleMessage {
  token: string
  attention: 'approval' | 'question'
  kind: 'alert' | 'start' | 'end'
  route: string
  ticket: string
  approvalPreview?: ApprovalPreview
  approvalSession?: string
}

export async function readPushFile(path: string): Promise<Buffer | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  try {
    const st = await handle.stat()
    if (!st.isFile() || st.nlink !== 1 || st.mode & 0o077 || st.uid !== process.getuid?.() || st.size > 256 * 1024)
      throw new Error('private-file')
    const data = Buffer.alloc(st.size)
    const { bytesRead } = await handle.read(data)
    if (bytesRead !== st.size) throw new Error('private-file')
    return data
  } finally {
    await handle.close()
  }
}

/** Public approval previews have a closed wire vocabulary. Session and decision identifiers stay on the Host. */
export function applePayload(message: AppleMessage, timestamp: number) {
  const alert = { title: 'Latch', body: message.attention === 'approval' ? '有审批等你处理，解锁后查看。' : 'Agent 有问题等你回答。' }
  if (message.kind === 'alert')
    return {
      aps: { alert, sound: 'default', ...(message.attention === 'approval' ? { category: 'latch.pending.approval' } : {}) },
      route: message.route,
      ticket: message.ticket,
    }
  if (message.kind === 'end') return { aps: { timestamp, event: 'end', 'content-state': {}, 'dismissal-date': timestamp } }
  const preview = message.attention === 'approval' ? approvalPreview.safeParse(message.approvalPreview).data : undefined
  const session = message.attention === 'approval' ? sealedApprovalSession.safeParse(message.approvalSession).data : undefined
  return {
    aps: {
      timestamp,
      event: 'start',
      alert,
      'attributes-type': 'LatchQuestionAttributes',
      attributes: { route: message.route, ticket: message.ticket, approval: message.attention === 'approval' },
      'content-state': { ...preview, ...(session ? { approvalSession: session } : {}) },
      'input-push-token': 1,
      'stale-date': timestamp + 120,
    },
  }
}

const encoded = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A local operator installs the matching Apple team's signing key in identity/apns.json. The destination and topic are fixed. */
export async function appleSender(dataDir: string, connectApple: typeof connect = connect): Promise<AppleSend | undefined> {
  try {
    const raw = await readPushFile(join(dataDir, 'identity', 'apns.json'))
    if (!raw) return undefined
    const config = configSchema.parse(JSON.parse(raw.toString('utf8')))
    const key = createPrivateKey(config.privateKey)
    if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('invalid-key')
    const origin = config.environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com'
    let bearer = '',
      issued = 0
    return async (message, signal) => {
      if (signal.aborted) return 'retry'
      const timestamp = Math.floor(Date.now() / 1000)
      if (!bearer || timestamp < issued || timestamp - issued >= 3000) {
        const claims = encoded({ alg: 'ES256', kid: config.keyId }) + '.' + encoded({ iss: config.teamId, iat: timestamp })
        bearer = claims + '.' + sign('sha256', Buffer.from(claims), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
        issued = timestamp
      }
      return new Promise<AppleDelivery>(resolve => {
        const session = connectApple(origin)
        let finished = false
        const finish = (result: AppleDelivery) => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          session.destroy()
          resolve(result)
        }
        const abort = () => finish('retry')
        const timer = setTimeout(abort, 8000)
        signal.addEventListener('abort', abort, { once: true })
        session.on('error', abort)
        const live = message.kind !== 'alert'
        const request = session.request({
          ':method': 'POST',
          ':path': '/3/device/' + message.token,
          authorization: 'bearer ' + bearer,
          'apns-topic': 'codes.latch.ios' + (live ? '.push-type.liveactivity' : ''),
          'apns-push-type': live ? 'liveactivity' : 'alert',
          'apns-priority': '10',
          'apns-expiration': String(timestamp + 120),
          'apns-collapse-id': message.ticket,
        })
        let status: number | undefined,
          response = ''
        request.on('response', headers => {
          status = Number(headers[':status'])
        })
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => {
          if (response.length < 1024) response += chunk.slice(0, 1024 - response.length)
        })
        request.on('error', abort)
        request.on('end', () => {
          let reason: unknown
          try {
            reason = JSON.parse(response).reason
          } catch {
            /* Successful APNs replies have an empty body. */
          }
          finish(
            status === 200
              ? 'accepted'
              : status === 410 || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic'
                ? 'invalid'
                : 'retry',
          )
        })
        request.end(JSON.stringify(applePayload(message, timestamp)))
      })
    }
  } catch {
    throw new AppError(500, 'push-config-invalid', '请核对 identity/apns.json 的内容、文件所有者和访问权限。')
  }
}
