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
  /** A handoff is on record before its target starts; the materials and requirements are only counted and hashed. */
  'handoff.created': z.strictObject({
    handoffId: opaqueId,
    sourceSessionId: opaqueId,
    target: z.enum(['new-session', 'session']),
    targetSessionId: opaqueId.optional(),
    materials: count,
    files: count,
    decisions: count,
    returnScope: z.enum(['none', 'summary', 'summary-and-evidence']),
    promptHash: hex64,
  }),
  'handoff.returned': z.strictObject({
    handoffId: opaqueId,
    sourceSessionId: opaqueId,
    targetSessionId: opaqueId,
    evidence: count,
    summaryHash: hex64,
  }),
  /** Withdrawn before a target existed, or closed once it had (`started`). */
  'handoff.withdrawn': z.strictObject({ handoffId: opaqueId, from: z.enum(['start-failed', 'start-unknown', 'started']) }),
  'task.question.answered': z.strictObject({ sessionId: opaqueId, questionId: opaqueId }),
  'task.prompt.queued': z.strictObject({ sessionId: opaqueId, itemId: opaqueId }),
  'task.prompt.sent': z.strictObject({ sessionId: opaqueId, itemId: opaqueId }),
  'task.prompt.edited': z.strictObject({ sessionId: opaqueId, itemId: opaqueId }),
  'task.prompt.removed': z.strictObject({ sessionId: opaqueId, itemId: opaqueId }),
  'attachment.add': attachmentEvent,
  'attachment.view': attachmentEvent,
  /** A device let go of its own uploads reserved for submissions it gave up; only those no saved message needs. */
  'attachment.released': z.strictObject({ requestId: opaqueId, count, bytes: count }),
  'approval.decided': z.strictObject({
    approvalId: opaqueId,
    sessionId: opaqueId,
    harnessId: opaqueId,
    risk,
    advisory: z.boolean(),
    decision: z.enum(['allow', 'reject']),
    optionKind: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
    previewHash: hex64.optional(),
    /** The tool call it was asked for, as the session records it, to find the same call in `browser.call`. */
    toolCallId: opaqueId.optional(),
  }),
  'approval.stale': z.strictObject({ approvalId: opaqueId }),
  /** Written before a full-access session is spawned; nothing is spawned without it. */
  'task.l3.start-requested': z.strictObject({
    harnessId: opaqueId,
    launchHash: hex64,
    promptHash: hex64.optional(),
    folderCount: count.optional(),
    /** What the start chose from the harness's own options, its mode among them. */
    configHash: hex64.optional(),
    /** A harness on its own models whose requests go through the gateway: the service, and the route the launch covers. */
    providerId: opaqueId.optional(),
    routeHash: hex64.optional(),
  }),
  /** `definitionHash`: the launch fingerprint without the project's configuration, from drivers that report it. */
  'task.l3.started': z.strictObject({
    promptHash: hex64.optional(),
    sessionId: opaqueId,
    harnessId: opaqueId,
    launchHash: hex64,
    definitionHash: hex64.optional(),
    folderCount: count.optional(),
    configHash: hex64.optional(),
    providerId: opaqueId.optional(),
    routeHash: hex64.optional(),
  }),
  'task.l3.start-failed': z.strictObject({ harnessId: opaqueId, launchHash: hex64 }),
  /**
   * Bringing in a harness's own earlier sessions (docs/HARNESSES.md#接入已有会话), each step on record before it runs: the
   * external session only by its hash, never a title, a path or any content.
   */
  'history.list': z.strictObject({ harnessId: opaqueId, workspaceId: opaqueId }),
  'history.preview': z.strictObject({ harnessId: opaqueId, workspaceId: opaqueId, agentSessionHash: hex64 }),
  'history.import': z.strictObject({
    /** The harness the session continues in; `from` is the one whose record it came from. */
    harnessId: opaqueId,
    from: opaqueId,
    mode: z.enum(['native', 'text']),
    requestHash: hex64,
    workspaceId: opaqueId.optional(),
    agentSessionHash: hex64.optional(),
    /** A text rebuild of a session brought in earlier. */
    fromTaskId: opaqueId.optional(),
    /** Native: the ID the Host chose for the new session. */
    taskId: opaqueId.optional(),
  }),
  'task.cancelled': z.strictObject({ sessionId: opaqueId, runId: opaqueId.optional() }),
  'task.config.changed': z.strictObject({ sessionId: opaqueId, configIdHash: hex64, toHash: hex64 }),
  'task.mode.widened': z.strictObject({ sessionId: opaqueId, toHash: hex64 }),
  'task.permission-drift': z.strictObject({ sessionId: opaqueId, observedHash: hex64 }),
  /** A turn of a session on a gateway route had a reply, and none of its requests came through the gateway. */
  'task.model.bypassed': z.strictObject({ sessionId: opaqueId }),
  'task.approval-auto-rejected': z.strictObject({
    sessionId: opaqueId,
    reason: z.enum(['persistent-only', 'unknown-kind', 'subagent-wider', 'harness-declined']),
  }),
  /** A person stopped one subagent of the session; `subagentId` is its row's message ID. */
  'task.subagent.stopped': z.strictObject({ sessionId: opaqueId, subagentId: opaqueId }),
  /** A call no person was asked about, in a mode where the harness's own model decides; written after the fact. */
  'task.tool.judged': z.strictObject({
    sessionId: opaqueId,
    callHash: hex64,
    modeHash: hex64,
    kind: z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other']),
    outcome: z.enum(['approved', 'denied', 'timed-out', 'aborted', 'unknown', 'ran-unasked']),
    source: z.enum(['agent-report', 'no-ask-seen']),
  }),
} as const
