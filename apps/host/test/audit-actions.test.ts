import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUDIT_DETAIL, AuditLog, type AuditAction } from '../src/audit.ts'
import { AGENT_ACTIONS } from '../src/audit-actions/agents.ts'
import { CHANGE_ACTIONS } from '../src/audit-actions/changes.ts'
import { DEVICE_ACTIONS } from '../src/audit-actions/devices.ts'
import { GIT_ACTIONS } from '../src/audit-actions/git.ts'
import { HOST_ACTIONS } from '../src/audit-actions/host.ts'
import { NATIVE_APPROVAL_ACTIONS } from '../src/audit-actions/native-approvals.ts'
import { NATIVE_ACTIONS } from '../src/audit-actions/native.ts'
import { PERSONAL_ACTIONS } from '../src/audit-actions/personal.ts'
import { PUSH_ACTIONS } from '../src/audit-actions/push.ts'
import { SESSION_ACTIONS } from '../src/audit-actions/sessions.ts'
import { TERMINAL_ACTIONS } from '../src/audit-actions/terminal.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const hex = 'a'.repeat(64)
const deviceId = `dev_${'A'.repeat(22)}`
const enrollmentId = `enr_${'B'.repeat(22)}`
const invitationId = `inv_${'C'.repeat(22)}`
const ticketId = `chl_${'D'.repeat(22)}`
const sessionId = 'session-1'
const fileAction = { sessionId, pathHash: hex, type: 'other' }

/** One detail each action accepts. */
const SAMPLES: Record<AuditAction, Record<string, unknown>> = {
  'plugin.package.changed': { operation: 'apply', before: hex, after: hex },
  'change.undo': { sessionId, turnId: 'run-1', restore: 1, remove: 0, skipped: 0, planHash: hex },
  'change.redo': { sessionId, turnId: 'run-1', restore: 1, remove: 0, skipped: 0, planHash: hex },
  'change.discard': { sessionId, scope: 'uncommitted', restore: 1, remove: 1, skipped: 0, planHash: hex },
  'presence.launch-trusted': { keyHash: hex },
  'host.started': { hostId: 'a'.repeat(52), version: '0.1.0', policyHash: hex, settingsHash: hex, devMode: true },
  'audit.torn-tail-removed': { bytes: 12 },
  'policy.created': { before: '', after: hex, fields: ['local.maxLevel'], lowering: false },
  'policy.changed': { before: hex, after: hex, fields: [], lowering: true },
  'policy.changed-outside': { expected: hex, actual: hex },
  'presence.helper.pinned': { cdhash: 'b'.repeat(40) },
  'presence.result': { confirmationId: `cfm_${'E'.repeat(22)}`, action: 'agent.define', result: 'denied' },
  'provider.secret.set': { providerId: 'openai-compatible', originHash: hex },
  'provider.secret.cleared': { providerId: 'openai-compatible', reason: 'path-changed' },
  'workspace.added': { workspaceId: 'ws-1', pathHash: hex, folderCount: 2, foldersHash: hex, via: 'session' },
  'workspace.removed': { workspaceId: 'ws-1', pathHash: hex },
  'workspace.folder-added': { workspaceId: 'ws-1', folderId: 'f-2', pathHash: hex, via: 'drop', replacesFolder: false },
  'workspace.folder-removed': { workspaceId: 'ws-1', folderId: 'f-2', pathHash: hex },
  'workspace.changed': { workspaceId: 'ws-1', renamed: true, glyphChanged: false, primaryChanged: false, reordered: true },
  'workspace.disabled': { workspaceId: 'ws-1', reason: 'missing', folderIndex: 0 },
  'settings.changed': { before: '', after: hex },
  'settings.changed-outside': { expected: hex, actual: hex },
  'file.reveal': fileAction,
  'file.quicklook': fileAction,
  'file.open': fileAction,
  'file.view': { ...fileAction, bytes: 2048 },
  'file.list': { workspaceId: 'ws-1', rootHash: hex, dirHash: hex, hidden: false, count: 3, truncated: false },
  'action.failed': { refSeq: 7 },
  'task.question.answered': { sessionId, questionId: 'q-1' },
  'task.prompt.queued': { sessionId, itemId: 'item-1' },
  'task.prompt.sent': { sessionId, itemId: 'item-1' },
  'task.prompt.edited': { sessionId, itemId: 'item-1' },
  'task.prompt.removed': { sessionId, itemId: 'item-1' },
  'attachment.add': { attachmentId: 'F'.repeat(22), contentHash: hex, bytes: 512, type: 'image' },
  'attachment.view': { attachmentId: 'F'.repeat(22), contentHash: hex, bytes: 512, type: 'text' },
  'approval.decided': {
    approvalId: 'approval-1',
    sessionId,
    harnessId: 'standard',
    risk: 'R2',
    advisory: false,
    decision: 'allow',
    optionKind: 'allow_once',
    previewHash: hex,
  },
  'approval.stale': { approvalId: 'approval-1' },
  'task.l3.start-requested': { harnessId: 'codex', launchHash: hex, folderCount: 1 },
  'task.l3.started': { sessionId, harnessId: 'codex', launchHash: hex, definitionHash: hex, folderCount: 1 },
  'task.l3.start-failed': { harnessId: 'codex', launchHash: hex },
  'task.cancelled': { sessionId, runId: 'run-1' },
  'task.config.changed': { sessionId, configIdHash: hex, toHash: hex },
  'task.mode.widened': { sessionId, toHash: hex },
  'task.permission-drift': { sessionId, observedHash: hex },
  'task.approval-auto-rejected': { sessionId, reason: 'persistent-only' },
  'device.enroll.requested': { enrollmentId, listener: 'lan-tls', fingerprint: 'A'.repeat(20), scopes: ['view'], invitationId },
  'device.enrolled': {
    deviceId,
    enrollmentId,
    listener: 'native-direct',
    method: 'invitation',
    scopes: ['view', 'run'],
    dataScope: 'work',
    pairedByDeviceId: deviceId,
  },
  'device.enroll.failed': { enrollmentId, reason: 'signature' },
  'device.revoked': { deviceId, reason: 'cascade', cascaded: 2 },
  'device.review': { deviceId, causeDeviceId: deviceId },
  'device.scopes.changed': { deviceId, added: ['run'], removed: [], dataScope: 'all' },
  'device.renamed': { deviceId },
  'device.credential.issued': { deviceId },
  'device.native.verified': { deviceId },
  'device.credential.rotated': { deviceId },
  'pairing.invited': { invitationId, scopes: ['view'], listener: 'native-relay', dataScope: 'work' },
  'offline.ticket.created': { ticketId },
  'offline.ticket.consumed': { ticketId },
  'migration.devices.v2': { revoked: 1, legacy: 0 },
  'device.revocations.torn-tail-removed': { bytes: 40 },
  'native.relay.conflict': { relayHash: hex },
  'native.network.remembered': { networkHash: hex },
  'native.config.changed': { before: hex, after: hex, lowering: false, direct: true, relayCount: 1 },
  'native.inputs.paused': {},
  'native.inputs.resumed': {},
  'pairing.contended': { invitationId, cancelled: 1, removed: 0 },
  'personal.changed': { kind: 'routine', operation: 'start', before: hex, after: hex, assistantId: 'asst_1' },
  'agent.probe.requested': { agentId: 'codex', launchHash: hex },
  'agent.probed': { agentId: 'codex', launchHash: hex, status: 'authentication-required' },
  'agent.defined': { agentId: 'codex', definitionHash: hex, created: true },
  'agent.deleted': { agentId: 'codex' },
}

describe('audit actions', () => {
  it('assembles every action from exactly one area file', () => {
    const areas = [
      HOST_ACTIONS,
      SESSION_ACTIONS,
      DEVICE_ACTIONS,
      NATIVE_ACTIONS,
      PERSONAL_ACTIONS,
      AGENT_ACTIONS,
      CHANGE_ACTIONS,
      GIT_ACTIONS,
      TERMINAL_ACTIONS,
      NATIVE_APPROVAL_ACTIONS,
      PUSH_ACTIONS,
    ]
    const names = areas.flatMap(area => Object.keys(area))
    expect(new Set(names).size).toBe(names.length)
    expect(names.toSorted()).toEqual(Object.keys(AUDIT_DETAIL).toSorted())
    for (const area of areas) for (const [action, schema] of Object.entries(area)) expect(AUDIT_DETAIL[action as AuditAction]).toBe(schema)
  })

  it('accepts a detail for each action and rejects it with any field the schema does not name', () => {
    expect(Object.keys(SAMPLES).toSorted()).toEqual(Object.keys(AUDIT_DETAIL).toSorted())
    for (const [action, detail] of Object.entries(SAMPLES)) {
      const schema = AUDIT_DETAIL[action as AuditAction]
      expect(schema.safeParse(detail).success, action).toBe(true)
      expect(schema.safeParse({ ...detail, note: 'free text' }).success, action).toBe(false)
    }
  })

  it('writes each action through the log and refuses unknown actions and extra fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'latch-audit-actions-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const log = await AuditLog.open(join(root, 'audit'))
    cleanups.push(() => log.close())
    const actor = { listener: 'host' as const }
    for (const [action, detail] of Object.entries(SAMPLES))
      await log.append({ action: action as AuditAction, actor, detail: detail as never })
    expect(log.head().seq).toBe(Object.keys(SAMPLES).length)
    await expect(log.append({ action: 'device.renamed', actor, detail: { deviceId, name: 'Phone' } as never })).rejects.toMatchObject({
      code: 'audit-detail-invalid',
    })
    await expect(log.append({ action: 'device.nicknamed' as never, actor, detail: { deviceId } as never })).rejects.toMatchObject({
      code: 'audit-detail-invalid',
    })
    expect(log.head().seq).toBe(Object.keys(SAMPLES).length)
  })
})
