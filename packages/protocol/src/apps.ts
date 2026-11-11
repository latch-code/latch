/**
 * Plugin pages (`formatVersion: 2`, `apps[]`): what a page may ask the Host for, as its manifest declares it and the
 * Host approved it. A page never holds a credential; every call names `via` and the Host checks it against the applied
 * manifest. See docs/APP-PAGES.md.
 */

/** Storage scopes a page may use: the plugin's own documents, one project's, one session's. */
export type AppStorageScopeKind = 'plugin' | 'project' | 'session'

export interface AppCapabilities {
  /** Session summaries (no messages, paths or attachments). */
  'tasks.read'?: true
  /** Start sessions: in any project, or only in the projects listed. */
  'tasks.start'?: { projects: 'any' | string[] }
  /** New input to sessions this page started. */
  'tasks.continue'?: true
  /** The last reply and end state of sessions this page started. */
  'tasks.readOwn'?: true
  storage?: AppStorageScopeKind[]
}
export type AppCapabilityName = keyof AppCapabilities

export interface AppManifestEntry {
  id: string
  title: string
  icon?: string
  entry: string
  dataVersion: number
  capabilities: AppCapabilities
}

/** `app` is `<pluginId>/<appId>`; `revision` is the plugin's `appliedRevision` the page was loaded from. */
export interface AppVia {
  app: string
  revision: string
}

/** A session a page started: `requestId` is the page's own request ID, the one `lookup` answers. */
export interface SessionOrigin {
  app: string
  requestId: string
}

export type AppStatus = 'ready' | 'disabled' | 'migrating' | 'needs-migration' | 'data-newer'

/** One page in the snapshot (`AppSnapshot.apps`); present for every applied page, enabled or not. */
export interface AppSummary {
  pluginId: string
  appId: string
  title: string
  icon?: string
  pluginName: string
  version: string
  revision: string
  capabilities: AppCapabilities
  dataVersion: number
  status: AppStatus
  /**
   * SHA-256 (hex) of the page's built module, which `GET /link/api/app-modules/:pluginId/:appId/:bundleHash.js` serves;
   * absent while the page has no build.
   */
  bundleHash?: string
}

export interface AppDataDocument {
  scope: string
  key: string
  version: number
  value: unknown
  updatedAt: string
}

export interface AppDataStatus {
  generation: number
  /** The data version of the stored generation; absent before anything was written. */
  dataVersion?: number
  /** The applied code's data version. */
  codeVersion: number
  status: Exclude<AppStatus, 'disabled'>
  documents: number
  bytes: number
}

/** `POST /apps/:pluginId/data/migrate/lease`: every document of the current generation, for `migrate(from, docs)`. */
export interface AppMigrationLease {
  lease: string
  fromGeneration: number
  fromVersion: number
  toVersion: number
  expiresAt: string
  documents: AppDataDocument[]
}

/** SSE `app.data`: a document changed. Only to devices that may read it. */
export interface AppDataEvent {
  type: 'app.data'
  instanceId: string
  pluginId: string
  scope: string
  key: string
  /** 0: removed. */
  version: number
}

export type AppDiagnosticSource = 'build' | 'runtime' | 'handshake' | 'bridge' | 'migration'
export interface AppDiagnostic {
  id: string
  at: string
  appId: string
  source: AppDiagnosticSource
  code?: string
  message: string
}

export type AppLookup = { status: 'found'; sessionId: string } | { status: 'pending' } | { status: 'not-found' }

export interface AppLastReply {
  sessionId: string
  status: string
  runOutcome?: string
  reply?: { messageId: string; text: string; truncated?: true }
}

/** The fixed failure codes a page sees; the Host's own error text never reaches it. */
export const APP_ERROR_CODES = [
  'capability-denied',
  'forbidden',
  'offline',
  'unknown',
  'rate-limited',
  'invalid-input',
  'not-found',
] as const
