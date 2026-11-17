// 设置 › 数据 (docs/ARCHITECTURE.md#数据保留与导出): what Latch keeps in its data directory by kind, where, how much and
// how long. Retention is built from the constants the stores themselves use, so the page cannot say other than the code
// does. Sizes come from walking only the entries each kind names, with lstat (a symbolic link is counted as itself and
// never followed), within fixed bounds, and are kept until counted again: opening the page does not walk the disk.
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CUSTOMIZATION_REVISION_LIMIT,
  DATA_KINDS,
  MEMORY_UNDO_DAYS,
  type DataElsewhere,
  type DataInventory,
  type DataKind,
  type DataKindId,
} from '@latch/protocol'
import { GENERATIONS_KEPT } from './app-data.ts'
import { ATTACHMENT_TTL } from './attachments.ts'
import { ATTACHMENT_UPLOAD_TTL } from './attachment-uploads.ts'
import { PRUNE_AFTER } from './auth.ts'
import { MAX_RESULTS, MAX_RUNS } from './automations.ts'
import { DEFAULT_LIMITS } from './changes/engine.ts'
import { MAX_HANDOFFS } from './handoffs.ts'
import { ROLLBACK_REVISIONS } from './plugin-assets.ts'
import { USAGE_KEEP_DAYS } from './usage-log.ts'

const DAY_MS = 24 * 60 * 60_000
const minutes = (ms: number) => `${Math.round(ms / 60_000)} 分钟`
const days = (ms: number) => `${Math.round(ms / DAY_MS)} 天`
const gib = (bytes: number) => `${Math.round(bytes / 1024 ** 3)} GiB`

/** The kinds, their entries in the data directory and their retention as the code keeps it today. */
export function dataKinds(): Array<Omit<DataKind, 'bytes' | 'files' | 'truncated'>> {
  const kinds: Record<DataKindId, { label: string; entries: string[]; retention: string }> = {
    sessions: {
      label: '会话与对话记录',
      entries: [
        'sessions',
        'harnesses',
        'sessions-meta.json',
        'queues.json',
        'questions.json',
        'review-notes',
        'file-references',
        'session-folders.json',
        'history-imports.json',
      ],
      retention: '一直保留，直到删除会话',
    },
    snapshots: {
      label: '改动快照',
      entries: ['snapshots'],
      retention: `每个会话最近 ${DEFAULT_LIMITS.turnsPerSession} 轮，每个项目最多 ${gib(DEFAULT_LIMITS.projectBytes)}，超出先删最早的；删除会话时删除`,
    },
    memory: {
      label: '我的 Agent 与记忆',
      entries: ['agents'],
      retention: `一直保留，直到删除；删除的记忆可撤销 ${MEMORY_UNDO_DAYS} 天，之后文字删去`,
    },
    work: { label: '待办与讨论', entries: ['work'], retention: '一直保留，直到删除待办' },
    attachments: {
      label: '附件',
      entries: ['attachments'],
      retention: `发出的随会话保留，删除会话时删除；没发出的 ${minutes(ATTACHMENT_TTL)}，中断的上传 ${minutes(ATTACHMENT_UPLOAD_TTL)}`,
    },
    automations: {
      label: '定时任务与交接',
      entries: ['automations.json', 'handoffs'],
      retention: `每个定时任务最近 ${MAX_RUNS} 次运行（另记最近 ${MAX_RUNS} 次错过或跳过的），结果最多 ${MAX_RESULTS} 条；交接最多 ${MAX_HANDOFFS} 个，超出先删最早结束的`,
    },
    usage: {
      label: '用量记录',
      entries: ['gateway', 'usage'],
      retention: `明细 ${USAGE_KEEP_DAYS} 天，按月删去更早的；单价与预算一直保留`,
    },
    audit: { label: '审计记录', entries: ['audit'], retention: '一直保留' },
    devices: {
      label: '设备登记',
      entries: ['auth'],
      retention: `撤销或凭据过期 ${days(PRUNE_AFTER)} 后删去登记；撤销记录一直保留`,
    },
    plugins: {
      label: '插件与应用数据',
      entries: ['plugin-packages', 'plugin-data'],
      retention: `每个插件保留 ${ROLLBACK_REVISIONS} 个可回退版本、${GENERATIONS_KEPT} 代应用数据；删除插件时可一并删除数据`,
    },
    settings: {
      label: '设置',
      entries: [
        'settings.json',
        'policy.json',
        'customization.json',
        'shortcuts.json',
        'prompt-templates.json',
        'project-context.json',
        'mcp-ended.json',
      ],
      retention: `一直保留；外观保留最近 ${CUSTOMIZATION_REVISION_LIMIT} 个修订`,
    },
    secrets: {
      label: '密钥与连接凭据',
      entries: ['providers.json', 'mcp', 'identity', 'native'],
      retention: '一直保留，直到你删除；只在这台电脑，从不导出',
    },
    logs: { label: '运行日志', entries: ['host.log'], retention: '一直保留，不轮转' },
  }
  return DATA_KINDS.map(id => ({ id, ...kinds[id] }))
}

/** Outside the data directory: named, never walked. */
function dataElsewhere(paths: { worktrees: string; agents: string }): DataElsewhere[] {
  return [
    { label: '会话的工作树', where: paths.worktrees, retention: '一直保留，直到你在「项目」里移除' },
    { label: 'Agent 的家', where: paths.agents, retention: '一直保留；删除 Agent 时也保留' },
    { label: '录屏、截图与临时文件', where: '系统临时目录', retention: '用完后删除，Latch 启动时清理残留' },
  ]
}

/** The walk's bounds: what one count may visit. */
const SIZE_LIMITS = { entries: 200_000, depth: 16 } as const

interface Tally {
  bytes: number
  files: number
  visited: number
  truncated: boolean
}

/** Adds up regular files under `path` without following links; stops at the bounds and says so. */
async function tally(path: string, depth: number, into: Tally): Promise<void> {
  if (into.visited >= SIZE_LIMITS.entries || depth > SIZE_LIMITS.depth) {
    into.truncated = true
    return
  }
  into.visited++
  const info = await lstat(path).catch(() => undefined)
  if (!info) return
  if (info.isFile()) {
    into.bytes += info.size
    into.files++
    return
  }
  if (!info.isDirectory()) return
  const names = await readdir(path).catch(() => [] as string[])
  for (const name of names) {
    await tally(join(path, name), depth + 1, into)
    if (into.truncated) return
  }
}

/**
 * Counts each kind's entries. An entry name never leaves the list above (no `..`, no separators), so nothing outside the
 * data directory is visited even when an entry is a link: lstat sees the link, not where it points.
 */
export async function countSizes(dataDir: string): Promise<Map<DataKindId, { bytes: number; files: number; truncated: boolean }>> {
  const sizes = new Map<DataKindId, { bytes: number; files: number; truncated: boolean }>()
  for (const kind of dataKinds()) {
    const into: Tally = { bytes: 0, files: 0, visited: 0, truncated: false }
    for (const entry of kind.entries) {
      if (entry.includes('/') || entry.includes('\\') || entry === '..' || entry === '.') continue
      await tally(join(dataDir, entry), 0, into)
      if (into.truncated) break
    }
    sizes.set(kind.id, { bytes: into.bytes, files: into.files, truncated: into.truncated })
  }
  return sizes
}

/** The page's inventory, with the sizes of the last count; a new count replaces them, one at a time. */
export class DataInventoryService {
  private sizes: Map<DataKindId, { bytes: number; files: number; truncated: boolean }> | undefined
  private sizedAt: number | undefined
  private counting: Promise<void> | undefined

  constructor(private readonly options: { dataDir: string; worktrees: string; agents: string; now: () => number }) {}

  view(): DataInventory {
    return {
      dataDir: this.options.dataDir,
      kinds: dataKinds().map(kind => {
        const size = this.sizes?.get(kind.id)
        return size ? { ...kind, bytes: size.bytes, files: size.files, ...(size.truncated ? { truncated: true as const } : {}) } : kind
      }),
      elsewhere: dataElsewhere(this.options),
      ...(this.sizedAt !== undefined ? { sizedAt: new Date(this.sizedAt).toISOString() } : {}),
    }
  }

  /** Counts again; a count already under way is shared rather than started twice. */
  async count(): Promise<DataInventory> {
    this.counting ??= countSizes(this.options.dataDir)
      .then(sizes => {
        this.sizes = sizes
        this.sizedAt = this.options.now()
      })
      .finally(() => {
        this.counting = undefined
      })
    await this.counting
    return this.view()
  }
}
