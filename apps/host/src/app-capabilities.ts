import { z } from 'zod'
import type { AppCapabilities, AppManifestEntry, AppStorageScopeKind, PluginPackageManifest } from '@latch/protocol'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'

/** Plugin pages per plugin, and projects one `tasks.start` may name. */
export const MAX_APPS = 4
const MAX_PROJECTS = 32
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u)
const projectId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)
const STORAGE_KINDS = ['plugin', 'project', 'session'] as const satisfies readonly AppStorageScopeKind[]

/** Strict: an unknown capability, or an unknown key in one, refuses the whole manifest. */
export const appCapabilitiesSchema = z
  .strictObject({
    'tasks.read': z.literal(true).optional(),
    'tasks.start': z
      .strictObject({
        projects: z.union([
          z.literal('any'),
          z
            .array(projectId)
            .min(1)
            .max(MAX_PROJECTS)
            .refine(list => new Set(list).size === list.length, '项目不能重复'),
        ]),
      })
      .optional(),
    'tasks.continue': z.literal(true).optional(),
    'tasks.readOwn': z.literal(true).optional(),
    storage: z
      .array(z.enum(STORAGE_KINDS))
      .min(1)
      .max(STORAGE_KINDS.length)
      .refine(list => new Set(list).size === list.length, '存储作用域不能重复')
      .optional(),
  })
  .refine(value => !value['tasks.continue'] || value['tasks.start'], '继续会话需要同时声明开始会话')

/** Quotes, colons and line breaks would let a name or title read as part of the confirmation's own wording. */
export const SHEET_TEXT = /^[^「」『』：:\r\n\u2028\u2029]*$/u
const sheetText = (max: number) => z.string().trim().min(1).max(max).regex(SHEET_TEXT, '名称不能包含「」『』、冒号或换行')

export const appEntrySchema = z.strictObject({
  id,
  title: sheetText(48),
  icon: z
    .string()
    .regex(/^[a-z0-9-]{1,48}$/u)
    .optional(),
  entry: z.string().min(1).max(256),
  dataVersion: z.number().int().min(1).max(1_000_000),
  capabilities: appCapabilitiesSchema,
  /** Sample sessions the preview shows instead of the fixed ones; never sent to the Host by a page. */
  preview: z
    .strictObject({
      tasks: z
        .array(
          z.strictObject({
            title: z.string().trim().min(1).max(120),
            status: z.enum(['idle', 'running', 'waiting-approval', 'cancelled', 'failed', 'interrupted']).optional(),
            projectName: z.string().trim().min(1).max(80).optional(),
          }),
        )
        .max(20),
    })
    .optional(),
})

/** The SDK range a page needs; the Host offers SDK 1. */
/** A format 2 package's name, which the confirmation sheet shows. */
export const appPluginNameSchema = sheetText(80)

export const appRequiresSchema = z.strictObject({ appSdk: z.string().regex(/^\^1(?:\.\d{1,4}){0,2}$/u, '需要更新 Latch') })

export const appsSchema = z
  .array(appEntrySchema)
  .min(1)
  .max(MAX_APPS)
  .refine(list => new Set(list.map(app => app.id)).size === list.length, '页面标识不能重复')
  // Storage is the plugin's, not a page's: all its pages read and migrate the same documents.
  .refine(list => new Set(list.map(app => app.dataVersion)).size === 1, '同一插件的页面必须使用同一个数据版本')

export type AppSet = Record<string, AppCapabilities>

/** The capability set of a manifest, by page ID; empty for format 1 and pages-free packages. */
export function capabilitySet(manifest: Pick<PluginPackageManifest, 'apps'>): AppSet {
  return Object.fromEntries((manifest.apps ?? []).map(app => [app.id, structuredClone(app.capabilities)]))
}

export function capabilitySetHash(set: AppSet): string {
  return sha256Hex(canonicalJson(set))
}

function projectsWithin(next: 'any' | string[], approved: 'any' | string[]): boolean {
  if (approved === 'any') return true
  if (next === 'any') return false
  return next.every(project => approved.includes(project))
}

/** Whether `next` asks for nothing beyond `approved`: a new page, a new capability, more projects or storage scopes are wider. */
export function withinApproved(next: AppSet, approved: AppSet | undefined): boolean {
  for (const [appId, wanted] of Object.entries(next)) {
    const granted = approved?.[appId]
    if (!granted) {
      if (Object.keys(wanted).length) return false
      continue
    }
    if (wanted['tasks.read'] && !granted['tasks.read']) return false
    if (wanted['tasks.continue'] && !granted['tasks.continue']) return false
    if (wanted['tasks.readOwn'] && !granted['tasks.readOwn']) return false
    if (
      wanted['tasks.start']
      && (!granted['tasks.start'] || !projectsWithin(wanted['tasks.start'].projects, granted['tasks.start'].projects))
    )
      return false
    if (wanted.storage?.some(kind => !granted.storage?.includes(kind))) return false
  }
  return true
}

const STORAGE_TEXT: Record<AppStorageScopeKind, string> = { plugin: '插件自己的', project: '按项目', session: '按会话' }

/** The confirmation's lines: one per page, every capability spelled out; 「开始会话（任何项目）」 is never softened. */
export function capabilityLines(
  apps: readonly AppManifestEntry[],
  projectName: (id: string) => string,
): Array<{ label: string; value: string }> {
  return apps.map(app => {
    const can: string[] = []
    const caps = app.capabilities
    if (caps['tasks.read']) can.push('查看会话列表')
    if (caps['tasks.start'])
      can.push(
        caps['tasks.start'].projects === 'any'
          ? '开始会话（任何项目）'
          : `开始会话（${caps['tasks.start'].projects.map(projectName).join('、')}）`,
      )
    if (caps['tasks.continue']) can.push('继续它开始的会话')
    if (caps['tasks.readOwn']) can.push('读它开始的会话的回复')
    if (caps.storage) can.push(`保存数据（${caps.storage.map(kind => STORAGE_TEXT[kind]).join('、')}）`)
    return { label: `页面「${app.title}」可以`, value: can.length ? can.join('；') : '只显示，不使用任何能力' }
  })
}

/**
 * What the pages may do, together, for the system sheet's reason (form `plugin.package.apply-pages`): the strongest
 * first, never longer than the form's slot, so the sheet never cuts it. Project names stay off the sheet; the lines name
 * them. `adoptsData`: the plugin takes over data a deleted plugin with its ID kept.
 */
export function capabilitySummary(apps: readonly AppManifestEntry[], adoptsData = false): string {
  const has = (name: keyof AppCapabilities) => apps.some(app => app.capabilities[name] !== undefined)
  const starts = apps.map(app => app.capabilities['tasks.start']).filter(item => item !== undefined)
  const parts: string[] = []
  if (starts.length) {
    const projects = new Set(starts.flatMap(item => (item.projects === 'any' ? [] : item.projects)))
    parts.push(starts.some(item => item.projects === 'any') ? '开始会话（任何项目）' : `开始会话（${projects.size} 个项目）`)
  }
  if (has('tasks.continue')) parts.push('继续它的会话')
  if (has('tasks.readOwn')) parts.push('读它的会话回复')
  if (has('tasks.read')) parts.push('查看会话列表')
  if (has('storage')) parts.push('保存数据')
  if (adoptsData) parts.push('接上保留的数据')
  return parts.length ? parts.join('、') : '只显示'
}
