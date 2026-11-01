import { z } from 'zod'
import { attachmentId, count, hex64, opaqueId } from './fields.ts'

const risk = z.enum(['R0', 'R1', 'R2'])
const attachmentEvent = z.strictObject({
  attachmentId,
  contentHash: hex64,
  bytes: count,
  type: z.enum(['image', 'text']),
})

/** Sessions: prompts, queue, questions, attachments, approvals, cancels and full-access starts. */
export const SESSION_ACTIONS = {
  'task.question.answered': z.strictObject({ sessionId: opaqueId, questionId: opaqueId }),
  'task.prompt.queued': z.strictObject({ sessionId: opaqueId, itemId: opaqueId }),
  'task.prompt.sent': z.strictObject({ sessionId: opaqueId, itemId: opaqueId }),
  'task.prompt.edited': z.strictObject({ sessionId: opaqueId, itemId: opaqueId }),
  'task.prompt.removed': z.strictObject({ sessionId: opaqueId, itemId: opaqueId }),
  'attachment.add': attachmentEvent,
  'attachment.view': attachmentEvent,
  'approval.decided': z.strictObject({
    approvalId: opaqueId,
    sessionId: opaqueId,
    harnessId: opaqueId,
    risk,
    advisory: z.boolean(),
    decision: z.enum(['allow', 'reject']),
    optionKind: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
    previewHash: hex64.optional(),
  }),
  'approval.stale': z.strictObject({ approvalId: opaqueId }),
  /** Written before a full-access session is spawned; nothing is spawned without it. */
  'task.l3.start-requested': z.strictObject({
    harnessId: opaqueId,
    launchHash: hex64,
    promptHash: hex64.optional(),
    folderCount: count.optional(),
  }),
  /** `definitionHash`: the launch fingerprint without the project's configuration, from drivers that report it. */
  'task.l3.started': z.strictObject({
    promptHash: hex64.optional(),
    sessionId: opaqueId,
    harnessId: opaqueId,
    launchHash: hex64,
    definitionHash: hex64.optional(),
    folderCount: count.optional(),
  }),
  'task.l3.start-failed': z.strictObject({ harnessId: opaqueId, launchHash: hex64 }),
  'task.cancelled': z.strictObject({ sessionId: opaqueId, runId: opaqueId.optional() }),
  'task.config.changed': z.strictObject({ sessionId: opaqueId, configIdHash: hex64, toHash: hex64 }),
  'task.mode.widened': z.strictObject({ sessionId: opaqueId, toHash: hex64 }),
  'task.permission-drift': z.strictObject({ sessionId: opaqueId, observedHash: hex64 }),
  'task.approval-auto-rejected': z.strictObject({ sessionId: opaqueId, reason: z.enum(['persistent-only', 'unknown-kind']) }),
} as const
