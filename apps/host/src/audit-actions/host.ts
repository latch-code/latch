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
  'automation.grant',
  'policy.change',
  'provider.set-key',
  'provider.confirm-origin',
  'approval.r2',
  'mcp.server.apply',
  'harness.command.apply',
])
/** Plugin, page, project and Harness IDs as manifests and projects spell them. */
const pageId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)
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
    operation: z.enum(['create', 'save', 'import', 'dev', 'trust', 'apply', 'rollback', 'enable', 'disable', 'delete']),
    before: hex64,
    after: hex64,
  }),
  /** A page draft built with the Host's fixed tools: the result and the bundles' hashes, never the source. */
  'plugin.package.build': z.strictObject({
    revision: hex64,
    result: z.enum(['ok', 'failed', 'timeout']),
    bundleHashes: z.array(hex64).max(4),
    bytes: count,
    diagnostics: count,
    typeChecked: z.boolean(),
  }),
  /**
   * How a package's pages came to be trusted: `confirmed` by this computer's confirmation, or `capabilities-approved`
   * because they ask for no more than was confirmed before. Written before the apply or rollback.
   */
  'plugin.package.app-trust': z.strictObject({
    operation: z.enum(['apply', 'rollback']),
    trust: z.enum(['confirmed', 'capabilities-approved']),
    revision: hex64,
    capabilitiesHash: hex64,
  }),
  /** A plugin page started a session; the start's own audits follow. `requestHash` covers the page and its request ID. */
  'app.task.start': z.strictObject({
    pluginId: pageId,
    appId: pageId,
    revision: hex64,
    requestHash: hex64,
    workspaceId: pageId,
    harnessId: pageId.optional(),
  }),
  'app.data.migrate': z.strictObject({
    pluginId: pageId,
    fromGeneration: count,
    toGeneration: count,
    fromVersion: count,
    toVersion: count,
    documents: count,
  }),
  /** A plugin deleted together with its data. */
  'app.data.removed': z.strictObject({ pluginId: pageId, documents: count }),
  'presence.launch-trusted': z.strictObject({ keyHash: hex64 }),
  'host.started': z.strictObject({
    hostId: z.string().regex(/^[a-z2-7]{52}$/u),
    version: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/u),
    policyHash: hex64,
    settingsHash: hex64,
    devMode: z.boolean(),
  }),
  'audit.torn-tail-removed': z.strictObject({ bytes: count }),
  /** The desktop app's install window (docs/UPDATES.md): new starts refused while it is open. */
  'host.update-window': z.strictObject({
    state: z.enum(['entered', 'committed', 'left']),
    reason: z.enum(['cancelled', 'installing', 'failed', 'expired']).optional(),
    busy: count,
    planned: z.boolean().optional(),
  }),
  /** Plugin packages a new version held off on its first start because their format is not one it loads. */
  'host.update.plugins-held': z.strictObject({ count }),
  'policy.created': policyChange,
  'policy.changed': policyChange,
  'policy.changed-outside': z.strictObject({ expected: hex64, actual: hex64 }),
  'presence.helper.pinned': z.strictObject({ cdhash: z.string().regex(/^[0-9a-f]{40}$/u) }),
  'presence.result': z.strictObject({
    confirmationId: prefixed('cfm'),
    action: presenceAction,
    result: z.enum(['denied', 'timeout', 'cancelled', 'error']),
  }),
  /**
   * The prices a person entered for one model were saved, changed or (`removed`) forgotten: which service, the model's
   * name as a hash, and which of the five fields differ. Never an amount.
   */
  'model.prices.changed': z.strictObject({
    providerId: opaqueId,
    modelHash: hex64,
    fields: z.array(z.enum(['currency', 'input', 'output', 'cacheRead', 'cacheWrite'])).max(5),
    removed: z.boolean(),
  }),
  /**
   * The monthly budget of a service or an Agent was set, changed or (`removed`) taken away: whose and which fields
   * differ, never an amount. `widening`: more may be spent than before.
   */
  'model.budget.changed': z.strictObject({
    scope: z.enum(['service', 'agent']),
    id: opaqueId,
    fields: z.array(z.enum(['unit', 'currency', 'limit'])).max(3),
    removed: z.boolean(),
    widening: z.boolean(),
  }),
  'provider.secret.set': z.strictObject({ providerId: opaqueId, originHash: hex64 }),
  /**
   * 「出错时改用」 of a service's models was edited: where its sessions' requests may go from then on. Only IDs and
   * counts: `models` whose lists changed, the services the new lists name, and `widened` when anything was added or
   * moved (an edit that only removes entries is a tightening, never blocked by this record).
   */
  'provider.fallbacks.changed': z.strictObject({
    providerId: opaqueId,
    models: count,
    candidates: z.array(opaqueId).max(64),
    widened: z.boolean(),
  }),
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
    /** The project's 默认模型 was set, changed or cleared. */
    modelChanged: z.boolean().optional(),
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
  /** Written before the desktop app shows a file in Finder, previews it with Quick Look, opens it with its default app or in the chosen editor. */
  'file.reveal': fileAction,
  'file.quicklook': fileAction,
  'file.open': fileAction,
  'file.editor': fileAction,
  'file.view': fileAction.extend({ bytes: count }),
  /** Written before the person's edit of a session file replaces it; sizes only, never the content. */
  'file.edit': z.strictObject({
    sessionId: opaqueId,
    pathHash: hex64,
    type: z.enum(AUDIT_FILE_TYPES),
    /** `protected-path`: a path Latch writes only at R2 (hooks, manifests, CI, agent settings), by an approve:elevated device. */
    protection: z.enum(['none', 'protected-path']),
    before: count,
    after: count,
  }),
  'file.list': z.strictObject({ ...fileContext, rootHash: hex64, dirHash: hex64, hidden: z.boolean(), count, truncated: z.boolean() }),
  /** 诊断导出: written before the bundle is answered; counts only, never what it holds. */
  'diagnostics.exported': z.strictObject({ logLines: count, errors: count, harnesses: count, plugins: count }),
  /** Best-effort follow-up when an action audited before taking effect then failed to commit. */
  'action.failed': z.strictObject({ refSeq: z.number().int().min(1) }),
} as const
