import { parseAllDocuments, parseDocument, isMap, isScalar, isSeq } from 'yaml'
import { z } from 'zod'

/** Workspace settings whose entries let a package version past a supply-chain policy. */
const EXCEPTION_SETTINGS = ['minimumReleaseAgeExclude', 'trustPolicyExclude'] as const
type ExceptionSetting = typeof EXCEPTION_SETTINGS[number]

/** An exception may be dated at most this many days ahead, so every one comes back for review. */
const MAX_EXCEPTION_DAYS = 90

export interface ExceptionGroup {
  setting: ExceptionSetting
  reason: string
  reviewer: string
  expires: string
  entries: string[]
}

export interface ExceptionReport {
  groups: ExceptionGroup[]
  problems: string[]
}

const NAME = String.raw`(?:@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*`
const IDENTIFIER = String.raw`(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const VERSION = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-${IDENTIFIER}(?:\.${IDENTIFIER})*)?`
const EXACT_ENTRY = new RegExp(String.raw`^(${NAME})@(${VERSION}(?:\s*\|\|\s*${VERSION})*)$`)
const FIELD = /^(reason|reviewer|expires):\s*(.*)$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Today's date in UTC as YYYY-MM-DD, the calendar that `expires:` dates use. */
export function utcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/**
 * Checks every exception in pnpm-workspace.yaml: exact versions only, a reason, reviewer and expiry
 * date on each group, no expired or far-future dates, and every listed version still in the lockfile.
 */
export function checkExceptions(workspaceYaml: string, lockfileYaml: string | undefined, today: string): ExceptionReport {
  const problems: string[] = []
  const groups: ExceptionGroup[] = []
  const workspace = parseDocument(workspaceYaml)
  if (workspace.errors.length > 0 || !isMap(workspace.contents)) {
    return { groups, problems: [`pnpm-workspace.yaml 无法解析：${workspace.errors[0]?.message ?? '顶层不是映射'}`] }
  }
  const locked = lockedPackages(lockfileYaml, problems)
  for (const setting of EXCEPTION_SETTINGS) {
    const node = workspace.get(setting, true)
    if (node === undefined) continue
    if (!isSeq(node)) { problems.push(`${setting} 必须是逐行列出的列表`); continue }
    const seen = new Set<string>()
    let group: ExceptionGroup | undefined
    node.items.forEach((item, index) => {
      // The first comment block of a list is attached to the list itself, later ones to their first entry.
      const comment = (isScalar(item) ? item.commentBefore : undefined) ?? (index === 0 ? node.commentBefore : undefined)
      if (comment) {
        group = parseGroup(setting, comment, today, problems)
        groups.push(group)
      }
      if (!isScalar(item) || typeof item.value !== 'string') { problems.push(`${setting} 第 ${index + 1} 项不是字符串`); return }
      const entry = item.value
      if (!group) { problems.push(`${setting}：${entry} 前缺少 reason:、reviewer: 与 expires: 注释`); return }
      group.entries.push(entry)
      if (seen.has(entry)) problems.push(`${setting}：${entry} 重复`)
      seen.add(entry)
      const match = EXACT_ENTRY.exec(entry)
      if (!match) {
        problems.push(`${setting}：${entry} 不是 name@精确版本；只写包名、通配或版本范围会放行以后发布的版本`)
        return
      }
      for (const version of match[2]!.split('||').map(part => part.trim())) {
        if (locked && !locked.has(`${match[1]}@${version}`)) problems.push(`${setting}：${match[1]}@${version} 不在 pnpm-lock.yaml 中，删除这条例外`)
      }
    })
  }
  return { groups, problems }
}

function parseGroup(setting: ExceptionSetting, comment: string, today: string, problems: string[]): ExceptionGroup {
  const fields: Partial<Record<'reason' | 'reviewer' | 'expires', string>> = {}
  let current: keyof typeof fields | undefined
  for (const raw of comment.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const field = FIELD.exec(line)
    if (field) {
      current = field[1] as keyof typeof fields
      fields[current] = field[2]!.trim()
    } else if (current) {
      fields[current] = `${fields[current]} ${line}`.trim()
    } else {
      problems.push(`${setting}：例外注释必须以 reason: 开头（发现「${line}」）`)
    }
  }
  const group: ExceptionGroup = { setting, reason: fields.reason ?? '', reviewer: fields.reviewer ?? '', expires: fields.expires ?? '', entries: [] }
  const summary = group.reason || comment.trim().split('\n')[0]!.trim()
  const label = `${setting} 的例外「${summary.length > 60 ? `${summary.slice(0, 60)}…` : summary}」`
  if (!group.reason) problems.push(`${label} 缺少 reason:`)
  if (!group.reviewer) problems.push(`${label} 缺少 reviewer:`)
  if (!validDate(group.expires)) {
    problems.push(`${label} 的 expires: 必须是 YYYY-MM-DD 日期`)
  } else if (group.expires < today) {
    problems.push(`${label} 已于 ${group.expires} 到期：确认后删除，或重新审阅并更新到期日`)
  } else if (group.expires > addDays(today, MAX_EXCEPTION_DAYS)) {
    problems.push(`${label} 的到期日 ${group.expires} 超过 ${MAX_EXCEPTION_DAYS} 天`)
  }
  return group
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && utcDate(date) === value
}

function addDays(day: string, days: number): string {
  return utcDate(new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000))
}

/** `name@version` keys of every package in the lockfile, from all of its YAML documents. */
function lockedPackages(lockfileYaml: string | undefined, problems: string[]): Set<string> | undefined {
  if (lockfileYaml === undefined) { problems.push('找不到 pnpm-lock.yaml，无法核对例外'); return undefined }
  const keys = new Set<string>()
  for (const document of parseAllDocuments(lockfileYaml)) {
    if (document.errors.length > 0) { problems.push('pnpm-lock.yaml 无法解析'); return undefined }
    const packages = document.get('packages', true)
    if (isMap(packages)) for (const pair of packages.items) if (isScalar(pair.key)) keys.add(String(pair.key.value))
  }
  return keys
}

export interface PackageManagerPin {
  version: string
  /** Lowercase hex sha512 of the `pnpm` tarball, the form Corepack verifies. */
  sha512: string
}

const PIN = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.([0-9a-f]{128})$/

export function parsePackageManagerPin(value: unknown): PackageManagerPin | undefined {
  const match = typeof value === 'string' ? PIN.exec(value) : null
  return match ? { version: match[1]!, sha512: match[2]! } : undefined
}

const VersionDocument = z.object({
  name: z.literal('pnpm'),
  version: z.string(),
  dist: z.object({ integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/) }),
})

type FetchJson = (url: string) => Promise<unknown>

/** The public registry that Corepack downloads from; a local mirror must not decide what the pin means. */
export const PUBLIC_REGISTRY = 'https://registry.npmjs.org'

/**
 * Compares the sha512 in `packageManager` with the integrity the public registry publishes for that
 * pnpm release. pnpm's own version switch does not read this hash, so a wrong one would go unnoticed
 * until someone installs pnpm through Corepack.
 */
export async function checkPackageManagerPin(packageManager: unknown, fetchJson: FetchJson): Promise<{ pin?: PackageManagerPin, problems: string[] }> {
  const pin = parsePackageManagerPin(packageManager)
  if (!pin) return { problems: [`package.json 的 packageManager 必须写成 pnpm@<版本>+sha512.<128 位十六进制>，现为 ${JSON.stringify(packageManager)}`] }
  let document: z.infer<typeof VersionDocument>
  try {
    document = VersionDocument.parse(await fetchJson(`${PUBLIC_REGISTRY}/pnpm/${pin.version}`))
  } catch (error) {
    return { pin, problems: [`无法从 ${PUBLIC_REGISTRY} 读取 pnpm@${pin.version} 的完整性信息：${error instanceof Error ? error.message : String(error)}`] }
  }
  const published = Buffer.from(document.dist.integrity.slice('sha512-'.length), 'base64').toString('hex')
  if (document.version !== pin.version) return { pin, problems: [`registry 返回的版本 ${document.version} 与 packageManager 的 ${pin.version} 不一致`] }
  if (published !== pin.sha512) return { pin, problems: [`packageManager 的 sha512 与 ${PUBLIC_REGISTRY} 上 pnpm@${pin.version} 的完整性不一致`] }
  return { pin, problems: [] }
}
