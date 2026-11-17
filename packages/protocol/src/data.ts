/**
 * 设置 › 数据 (docs/ARCHITECTURE.md#数据保留与导出): what Latch keeps on this Mac by kind, where, how much and for how
 * long; the audit log as people read it; and 导出全部. Never contents, never secrets.
 */

/** The kinds of what Latch keeps, in the order the page lists them. */
export const DATA_KINDS = [
  'sessions',
  'snapshots',
  'memory',
  'work',
  'attachments',
  'automations',
  'usage',
  'audit',
  'devices',
  'plugins',
  'settings',
  'secrets',
  'logs',
] as const
export type DataKindId = (typeof DATA_KINDS)[number]

export interface DataKind {
  id: DataKindId
  label: string
  /** The entries of the data directory it is kept in, relative to it. */
  entries: string[]
  /** How long it stays, as the code keeps it today; 「一直保留」 where nothing expires it. */
  retention: string
  /** Bytes and files, from the last count (`DataInventory.sizedAt`); absent before one. */
  bytes?: number
  files?: number
  /** The count stopped at its bound: at least this much. */
  truncated?: true
}

/** What Latch keeps outside the data directory: named, never counted. */
export interface DataElsewhere {
  label: string
  where: string
  retention: string
}

/** `GET /link/api/data`. `POST /link/api/data/sizes` counts again (bounded, rate-limited) and answers the same. */
export interface DataInventory {
  dataDir: string
  kinds: DataKind[]
  elsewhere: DataElsewhere[]
  /** When sizes were last counted; absent until a count has run. */
  sizedAt?: string
}

/** What an audit record is about, for 审计记录's filter. */
export const AUDIT_KINDS = ['sessions', 'agents', 'devices', 'projects', 'models', 'git', 'tools', 'mcp', 'plugins', 'host'] as const
export type AuditKind = (typeof AUDIT_KINDS)[number]
export const AUDIT_KIND_LABELS: Readonly<Record<AuditKind, string>> = {
  sessions: '会话',
  agents: 'Agent',
  devices: '设备与连接',
  projects: '项目与文件',
  models: '模型',
  git: 'Git',
  tools: '终端与浏览器',
  mcp: 'MCP',
  plugins: '插件',
  host: '这台电脑',
}

/** Something a record names, as the reader may see it: a resolved name, or a short id where none is known. */
export interface AuditRef {
  kind: 'session' | 'device' | 'agent' | 'project' | 'harness' | 'other'
  /** Absent when the Host knows no name for it (deleted, or never named). */
  name?: string
  /** The first characters of the id or hash. */
  short: string
}

/** One record of `audit/audit.jsonl` as 审计记录 shows it: never its payload as written, never a whole hash. */
export interface AuditEntry {
  seq: number
  at: string
  /** Who: a device by name, the Host itself or the command line. */
  actor: { kind: 'device' | 'host' | 'cli'; name?: string; short?: string }
  action: string
  /** The action's human name. */
  label: string
  kind: AuditKind
  target?: AuditRef
  /** How a confirmation was asked: `none`, a preset, the Mac's confirmation or an offline code. */
  stepup: 'none' | 'preset' | 'lpc-local' | 'shell-local' | 'offline'
  /** The record's other fields: enums, booleans and counts as written; ids and hashes as short ids. */
  fields: Array<{ name: string; value: string | number | boolean; ref?: AuditRef }>
}

/** `GET /link/api/audit/records?before&kind&actor&since&until&limit`: newest first. */
export interface AuditPage {
  entries: AuditEntry[]
  /** Pass as `before` for older records; absent when there are none. */
  next?: number
  /** The devices that may be picked as `actor` (every one the Host lists, by name). */
  actors: Array<{ id: string; name: string }>
}

/** 导出全部: what may go out. Allow-listed kinds; secrets have no kind, so they cannot be chosen. */
export const EXPORT_KINDS = ['sessions', 'memory', 'work', 'settings'] as const
export type ExportKind = (typeof EXPORT_KINDS)[number]

/** An export under way or just ended (`GET /link/api/data/export/:id`). */
export interface DataExportState {
  id: string
  state: 'running' | 'done' | 'failed' | 'cancelled'
  /** The folder made inside the chosen one. */
  name: string
  startedAt: string
  progress: { done: number; total: number }
  /** `done`: files written, and sessions that could not be read (kept out, counted in the manifest). */
  files?: number
  skipped?: number
  code?: 'export-failed' | 'export-cancelled' | 'export-folder-exists'
}
