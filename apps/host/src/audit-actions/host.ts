import { z } from 'zod'
import { AUDIT_FILE_TYPES } from '../files/kinds.ts'
import { count, hex64, opaqueId, prefixed } from './fields.ts'

const presenceAction = z.enum([
  'plugin.package.apply',
  'device.enroll',
  'device.enroll-native',
  'device.grant',
  'task.start-l3',
  'task.mode-widen',
  'agent.define',
  'agent.probe',
  'policy.change',
  'provider.set-key',
  'provider.confirm-origin',
  'approval.r2',
])
const fieldPath = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/u)
  .max(128)
const policyChange = z.strictObject({
  before: z.union([hex64, z.literal('')]),
  after: hex64,
  fields: z.array(fieldPath).max(64),
  lowering: z.boolean(),
})
const workspaceChange = z.strictObject({ workspaceId: opaqueId, pathHash: hex64 })
const folderId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/u)
const folderVia = z.enum(['picker', 'drop', 'cli'])
/** A desktop file action: the session, the real path's hash and the file's type (an allowed extension, other or none). */
const fileContext = { sessionId: opaqueId.optional(), workspaceId: opaqueId.optional(), harnessId: opaqueId.optional() }
const fileAction = z.strictObject({ ...fileContext, pathHash: hex64, type: z.enum(AUDIT_FILE_TYPES) })

/** The Host itself: startup, settings, policy and local confirmation, model services, projects, files and plugins. */
export const HOST_ACTIONS = {
  'plugin.package.changed': z.strictObject({
    operation: z.enum(['create', 'save', 'trust', 'apply', 'enable', 'disable', 'delete']),
    before: hex64,
    after: hex64,
  }),
  'presence.launch-trusted': z.strictObject({ keyHash: hex64 }),
  'host.started': z.strictObject({
    hostId: z.string().regex(/^[a-z2-7]{52}$/u),
    version: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/u),
    policyHash: hex64,
    settingsHash: hex64,
    devMode: z.boolean(),
  }),
  'audit.torn-tail-removed': z.strictObject({ bytes: count }),
  'policy.created': policyChange,
  'policy.changed': policyChange,
  'policy.changed-outside': z.strictObject({ expected: hex64, actual: hex64 }),
  'presence.helper.pinned': z.strictObject({ cdhash: z.string().regex(/^[0-9a-f]{40}$/u) }),
  'presence.result': z.strictObject({
    confirmationId: prefixed('cfm'),
    action: presenceAction,
    result: z.enum(['denied', 'timeout', 'cancelled', 'error']),
  }),
  'provider.secret.set': z.strictObject({ providerId: opaqueId, originHash: hex64 }),
  'provider.secret.cleared': z.strictObject({
    providerId: opaqueId,
    reason: z.enum(['origin-changed', 'path-changed', 'manual', 'deleted']),
  }),
  /**
   * A new project; `pathHash` is its primary folder's, `foldersHash` the canonical list of all its folders. `session`:
   * a session's own folder that the desktop saved as a project.
   */
  'workspace.added': z.strictObject({
    workspaceId: opaqueId,
    pathHash: hex64,
    folderCount: count.optional(),
    foldersHash: hex64.optional(),
    via: z.enum([...folderVia.options, 'session']).optional(),
  }),
  'workspace.removed': workspaceChange,
  /** A folder joined a project, or (`replacesFolder`) took the place of one of its folders, keeping its ID. */
  'workspace.folder-added': z.strictObject({
    workspaceId: opaqueId,
    folderId,
    pathHash: hex64,
    via: folderVia,
    replacesFolder: z.boolean(),
  }),
  'workspace.folder-removed': z.strictObject({ workspaceId: opaqueId, folderId, pathHash: hex64 }),
  /** A rename, a new glyph or a new folder order; the folder set is unchanged. */
  'workspace.changed': z.strictObject({
    workspaceId: opaqueId,
    renamed: z.boolean(),
    glyphChanged: z.boolean(),
    primaryChanged: z.boolean(),
    reordered: z.boolean(),
  }),
  /** A saved project that became unusable (a folder failing the rules, missing or unreadable); it stays in settings. */
  'workspace.disabled': z.strictObject({
    workspaceId: opaqueId,
    reason: z.enum(['overlap', 'code-root', 'protected', 'invalid', 'missing', 'permission']),
    folderIndex: count.optional(),
  }),
  /** A settings write by the Host, with the canonical hashes before and after. */
  'settings.changed': z.strictObject({ before: z.union([hex64, z.literal('')]), after: hex64 }),
  'settings.changed-outside': z.strictObject({ expected: z.union([hex64, z.literal('')]), actual: hex64 }),
  /** Written before the desktop app shows a file in Finder, previews it with Quick Look or opens it with its default app. */
  'file.reveal': fileAction,
  'file.quicklook': fileAction,
  'file.open': fileAction,
  'file.view': fileAction.extend({ bytes: count }),
  'file.list': z.strictObject({ ...fileContext, rootHash: hex64, dirHash: hex64, hidden: z.boolean(), count, truncated: z.boolean() }),
  /** Best-effort follow-up when an action audited before taking effect then failed to commit. */
  'action.failed': z.strictObject({ refSeq: z.number().int().min(1) }),
} as const
