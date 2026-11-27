import { z } from 'zod'
import { CUSTOM_AGENT_ID, looksSecret, type WorkPostRemote } from '@latch/protocol'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { AppError } from '@latch/sdk'

const agentId = z.string().regex(CUSTOM_AGENT_ID)
export const remoteWorkTarget = z.strictObject({ customAgentId: agentId, hostId: z.string().regex(/^[a-z2-7]{52}$/u), agentId })
const revision = z.number().int().positive().safe()
const resultRef = z
  .string()
  .regex(/^[A-Za-z0-9_.:@+-]{1,256}$/u)
  .refine(id => !looksSecret(id))
const status = z.enum(['prepared', 'offline', 'unknown', 'running', 'waiting-approval', 'completed', 'failed', 'cancelled', 'interrupted'])
const observation = z.strictObject({
  status,
  deviceId: z
    .string()
    .regex(/^dev_[A-Za-z0-9_-]{22}$/u)
    .optional(),
  mentionId: z.string().uuid().optional(),
  sessionId: resultRef.optional(),
  messageId: resultRef.optional(),
})
const terminal = (state: WorkPostRemote['status']) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(state)
const awaitingDelivery = (state: WorkPostRemote['status']) => ['prepared', 'offline', 'unknown'].includes(state)
export const remoteWorkReceipt = remoteWorkTarget.extend({ revision, ...observation.shape }).refine(remote => {
  if (remote.status === 'prepared' || remote.status === 'offline') return !remote.mentionId && !remote.sessionId && !remote.messageId
  if (remote.status !== 'unknown' && !remote.deviceId) return false
  if (remote.mentionId && !remote.deviceId) return false
  if (!remote.mentionId && remote.status !== 'failed' && remote.status !== 'unknown') return false
  if (remote.sessionId && !remote.mentionId) return false
  return !remote.messageId || (!!remote.sessionId && terminal(remote.status))
})
export const remoteWorkReport = observation.extend({ baseRevision: revision }).refine(report => {
  if (report.status === 'prepared' && !report.deviceId) return false
  if ((report.status === 'prepared' || report.status === 'offline') && (report.mentionId || report.sessionId || report.messageId))
    return false
  return [report.sessionId, report.messageId].every(id => id === undefined || redactKnownSecrets(id) === id)
})
export type RemoteWorkTarget = z.infer<typeof remoteWorkTarget>
const changed = () => new AppError(409, 'remote-post-changed', '投递回执已变化，请重新读取。')

/** Apply an observation only to the receipt it came from. Replaying the same evidence is harmless after a lost response. */
export function updateRemoteWorkPost(previous: WorkPostRemote, report: z.infer<typeof remoteWorkReport>): WorkPostRemote {
  const next = { ...previous, status: report.status }
  for (const key of ['deviceId', 'mentionId', 'sessionId', 'messageId'] as const) {
    const value = report[key]
    if (value === undefined) continue
    if (previous[key] && previous[key] !== value) throw changed()
    next[key] = value
  }
  // Losing contact only affects reachability. Keep a confirmed execution state until the same destination supplies new evidence.
  if (awaitingDelivery(report.status) && !awaitingDelivery(previous.status)) next.status = previous.status
  if (previous.status === 'unknown' && (report.status === 'prepared' || report.status === 'offline')) next.status = 'unknown'
  if (terminal(previous.status) && previous.status !== next.status) throw changed()
  if (!remoteWorkReceipt.safeParse(next).success) throw new AppError(400, 'remote-post-invalid', '远端回执缺少对应的设备、提及或会话。')
  if (
    next.status === previous.status
    && next.deviceId === previous.deviceId
    && next.mentionId === previous.mentionId
    && next.sessionId === previous.sessionId
    && next.messageId === previous.messageId
  )
    return previous
  if (previous.revision !== report.baseRevision) throw changed()
  return { ...next, revision: previous.revision + 1 }
}
