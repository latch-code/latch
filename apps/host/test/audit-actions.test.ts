import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUDIT_DETAIL, AuditLog, type AuditAction } from '../src/audit.ts'
import { AGENT_ACTIONS } from '../src/audit-actions/agents.ts'
import { BROWSER_ACTIONS } from '../src/audit-actions/browser.ts'
import { CHANGE_ACTIONS } from '../src/audit-actions/changes.ts'
import { DEVICE_ACTIONS } from '../src/audit-actions/devices.ts'
import { GIT_ACTIONS } from '../src/audit-actions/git.ts'
import { HOST_ACTIONS } from '../src/audit-actions/host.ts'
import { MCP_ACTIONS } from '../src/audit-actions/mcp.ts'
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
  'terminal.open': { sessionId: 'task_1', terminalId: 'term_1' },
  'browser.call': {
    sessionId,
    callId: '00000000-0000-4000-8000-000000000000',
    tool: 'browser_click',
    tabId: `brw_${'E'.repeat(22)}`,
    origin: 'loopback',
    originHash: hex,
    risk: 'R1',
    toolCallId: 'call_1',
    approvalId: 'approval-1',
  },
  'browser.provider.registered': {},
  'mcp.server.added': { serverId: `mcp_${'F'.repeat(22)}`, specHash: hex, envCount: 1, scope: 'all', projectCwd: false },
  'mcp.server.changed': { serverId: `mcp_${'F'.repeat(22)}`, kinds: ['spec', 'secret'], specHash: hex, enabled: true },
  'mcp.server.removed': { serverId: `mcp_${'F'.repeat(22)}` },
  'mcp.server.test': { serverId: `mcp_${'F'.repeat(22)}`, specHash: hex },
  'mcp.server.started': { serverId: `mcp_${'F'.repeat(22)}`, sessionId, specHash: hex },
  'mcp.tool.called': { serverId: `mcp_${'F'.repeat(22)}`, sessionId, callId: '00000000-0000-4000-8000-000000000000', toolHash: hex },
  'mcp.tool.settled': {
    serverId: `mcp_${'F'.repeat(22)}`,
    sessionId,
    callId: '00000000-0000-4000-8000-000000000000',
    result: 'ok',
    ms: 12,
  },
  'browser.provider.ended': {},
  'history.list': { harnessId: 'codex', workspaceId: 'proj' },
  'history.preview': { harnessId: 'codex', workspaceId: 'proj', agentSessionHash: hex },
  'history.import': {
    harnessId: 'codex',
    from: 'codex',
    mode: 'native',
    requestHash: hex,
    workspaceId: 'proj',
    agentSessionHash: hex,
    taskId: 'task-1',
  },
  'plugin.package.changed': { operation: 'apply', before: hex, after: hex },
  'plugin.package.build': { revision: hex, result: 'ok', bundleHashes: [hex], bytes: 1200, diagnostics: 0, typeChecked: true },
  'plugin.package.app-trust': { operation: 'apply', trust: 'confirmed', revision: hex, capabilitiesHash: hex },
  'app.task.start': { pluginId: 'release-check', appId: 'main', revision: hex, requestHash: hex, workspaceId: 'default' },
  'app.data.migrate': { pluginId: 'release-check', fromGeneration: 1, toGeneration: 2, fromVersion: 1, toVersion: 2, documents: 3 },
  'app.data.removed': { pluginId: 'release-check', documents: 3 },
  'change.undo': { sessionId, turnId: 'run-1', restore: 1, remove: 0, skipped: 0, planHash: hex },
  'change.redo': { sessionId, turnId: 'run-1', restore: 1, remove: 0, skipped: 0, planHash: hex },
  'change.discard': { sessionId, scope: 'uncommitted', restore: 1, remove: 1, skipped: 0, planHash: hex },
  'git.stage': { sessionId, requestHash: hex, files: 2, filtered: false },
  'git.unstage': { sessionId, requestHash: hex, files: 1 },
  'git.commit': {
    sessionId,
    requestHash: hex,
    preHead: 'b'.repeat(40),
    hooks: ['pre-commit'],
    skipHooks: false,
  },
  'git.push': {
    sessionId,
    requestHash: hex,
    localSha: 'b'.repeat(40),
    remote: 'origin',
    remoteHash: hex,
    refHash: hex,
    setUpstream: true,
    hooks: ['pre-push'],
  },
  'git.pr.create': { sessionId, requestHash: hex, remoteHash: hex, headHash: hex, baseHash: hex, draft: false },
  'git.pr.link': { sessionId, requestHash: hex, number: 12, remoteHash: hex, headHash: hex },
  'git.result': { sessionId, requestHash: hex, operation: 'push', outcome: 'failed', code: 'git-push-non-fast-forward' },
  'worktree.remove': {
    workspaceId: 'ws-1',
    sessionId,
    worktreeHash: hex,
    requestHash: hex,
    staged: 1,
    unstaged: 2,
    untracked: 3,
    forced: true,
    ownBranch: true,
    deleteBranch: true,
    merged: 'default',
    unpushed: 2,
  },
  'worktree.result': { workspaceId: 'ws-1', worktreeHash: hex, requestHash: hex, outcome: 'removed', branch: 'kept' },
  'presence.launch-trusted': { keyHash: hex },
  'host.started': { hostId: 'a'.repeat(52), version: '0.1.0', policyHash: hex, settingsHash: hex, devMode: true },
  'audit.torn-tail-removed': { bytes: 12 },
  'host.update-window': { state: 'left', reason: 'cancelled', busy: 2 },
  'host.update.plugins-held': { count: 1 },
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
  'file.editor': fileAction,
  'diagnostics.exported': { logLines: 12, errors: 1, harnesses: 2, plugins: 5 },
  'file.view': { ...fileAction, bytes: 2048 },
  'file.edit': { sessionId, pathHash: hex, type: 'other', protection: 'none', before: 10, after: 12 },
  'file.list': { workspaceId: 'ws-1', rootHash: hex, dirHash: hex, hidden: false, count: 3, truncated: false },
  'action.failed': { refSeq: 7 },
  'task.question.answered': { sessionId, questionId: 'q-1' },
  'task.prompt.queued': { sessionId, itemId: 'item-1' },
  'task.prompt.sent': { sessionId, itemId: 'item-1' },
  'task.prompt.edited': { sessionId, itemId: 'item-1' },
  'task.prompt.removed': { sessionId, itemId: 'item-1' },
  'attachment.add': { attachmentId: 'F'.repeat(22), contentHash: hex, bytes: 512, type: 'image' },
  'attachment.view': { attachmentId: 'F'.repeat(22), contentHash: hex, bytes: 512, type: 'text' },
  'attachment.released': { requestId: '6f1c2b1e-0a51-4f7e-9d0c-2b9b8f8f6b11', count: 2, bytes: 1024 },
  'approval.decided': {
    approvalId: 'approval-1',
    sessionId,
    harnessId: 'standard',
    risk: 'R2',
    advisory: false,
    decision: 'allow',
    optionKind: 'allow_once',
    previewHash: hex,
    toolCallId: 'call_1',
  },
  'approval.stale': { approvalId: 'approval-1' },
  'task.l3.start-requested': { harnessId: 'codex', launchHash: hex, folderCount: 1, configHash: hex },
  'task.l3.started': { sessionId, harnessId: 'codex', launchHash: hex, definitionHash: hex, folderCount: 1, configHash: hex },
  'task.l3.start-failed': { harnessId: 'codex', launchHash: hex },
  'task.cancelled': { sessionId, runId: 'run-1' },
  'task.config.changed': { sessionId, configIdHash: hex, toHash: hex },
  'task.mode.widened': { sessionId, toHash: hex },
  'task.permission-drift': { sessionId, observedHash: hex },
  'task.model.bypassed': { sessionId },
  'task.approval-auto-rejected': { sessionId, reason: 'persistent-only' },
  'task.subagent.stopped': { sessionId, subagentId: 'subagent:7c9e6679-7425-40de-944b-e07fc1f90ae7' },
  'task.tool.judged': { sessionId, callHash: hex, modeHash: hex, kind: 'execute', outcome: 'approved', source: 'agent-report' },
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
  'agent.catalogue.requested': { agentId: 'codex', auto: true },
  'agent.catalogue.read': { agentId: 'codex', ok: false },
  'agent.mcp.requested': { agentId: 'codex' },
  'agent.mcp.read': { agentId: 'codex', ok: true },
  'agent.models.changed': { agentId: 'codex', count: 2 },
  'agent.login.requested': { agentId: 'codex' },
  'agent.login.checked': { agentId: 'codex', status: 'unauthenticated' },
  'agent.login.opened': { agentId: 'codex', source: 'harness' },
  'agent.logout': { agentId: 'codex' },
  'agent.defined': { agentId: 'codex', definitionHash: hex, created: true },
  'agent.deleted': { agentId: 'codex' },
  'agent.changed': { kind: 'agent', operation: 'update', before: hex, after: hex, customAgentId: 'agt_1' },
  'agent.memory.proposed': { origin: 'agent', external: true, customAgentId: 'agt_1', kind: 'schedule' },
  'automation.changed': { operation: 'create', before: hex, after: hex },
  'automation.ran': { trigger: 'schedule', attempt: hex },
  'handoff.created': {
    handoffId: 'hof_1',
    sourceSessionId: sessionId,
    target: 'new-session',
    materials: 2,
    files: 1,
    decisions: 0,
    returnScope: 'summary',
    promptHash: hex,
  },
  'handoff.returned': { handoffId: 'hof_1', sourceSessionId: sessionId, targetSessionId: 'session-2', evidence: 1, summaryHash: hex },
  'handoff.withdrawn': { handoffId: 'hof_1', from: 'started' },
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
      BROWSER_ACTIONS,
      NATIVE_APPROVAL_ACTIONS,
      PUSH_ACTIONS,
      MCP_ACTIONS,
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
    // A subagent asking for more than the session's mode is refused on record under its own reason.
    expect(AUDIT_DETAIL['task.approval-auto-rejected'].safeParse({ sessionId, reason: 'subagent-wider' }).success).toBe(true)
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
