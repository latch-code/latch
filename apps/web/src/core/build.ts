import type { UpdateState } from './shell.ts'

declare const __LATCH_BUILD__: string | undefined

/** This page's build ID (vite.config.ts); empty in the development server and in tests. */
export const PAGE_BUILD = typeof __LATCH_BUILD__ === 'string' ? __LATCH_BUILD__ : ''

/** A build ID as `vite.config.ts` writes it: its UTC time, then six hex digits. */
const BUILD_ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/u

/**
 * Whether the Host is running an older build than this page: it reports the build of the page that was there when it
 * started (`AppSnapshot.build`), and a Host from before builds were reported reports none. A page older than its Host
 * (a tab left open across a restart) is not this case. IDs begin with their UTC build time, so they sort by age.
 */
export function hostIsOlder(hostBuild: string | undefined, pageBuild: string = PAGE_BUILD): boolean {
  if (!pageBuild) return false
  if (hostBuild === undefined) return true
  return hostBuild !== pageBuild && hostBuild < pageBuild
}

/** The notice's words for `computer` (`computerLabel`): what, what to do, and how behind ⓘ. */
export function oldHostWords(computer: string): { title: string; label: string; detail: string } {
  return {
    title: `${computer} 上的 Latch 还是旧版本`,
    label: '重启 Latch 后才能用新功能',
    detail: `在 ${computer} 上停止 Latch；若确认组件也更新了，运行 pnpm latch presence repin；再启动 Latch。`,
  }
}

/**
 * The build of the page the Host serves now (`build.json` beside it, read again on every call): a rebuild since this
 * page loaded shows here. Null when it cannot be read or is not a build ID.
 */
export async function readServedBuild(): Promise<string | null> {
  try {
    const response = await fetch('/link/build.json', { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) return null
    const value = ((await response.json()) as { build?: unknown }).build
    return typeof value === 'string' && BUILD_ID.test(value) ? value : null
  } catch {
    return null
  }
}

/** A build ID as people read it: its random part. */
export function shortBuild(id: string): string {
  return id.slice(id.lastIndexOf('-') + 1)
}

/**
 * What 检查更新 found. `app`: the desktop app's own updater has a release (Settings › 关于 moves it on); `page`: the Host
 * serves a newer page than this one (reload); `host`: this page is newer than the Host (restart Latch); `dev`: a page
 * without a build ID, nothing to compare; `failed`: the served build could not be read.
 */
export type BuildStatus =
  | { kind: 'checking' }
  | { kind: 'app'; version: string | undefined }
  | { kind: 'page' }
  | { kind: 'host' }
  | { kind: 'current'; build: string }
  | { kind: 'dev' }
  | { kind: 'failed'; build: string }

/** The desktop updater's states that hold a release on its way to being installed. */
const APP_RELEASE: ReadonlySet<UpdateState> = new Set(['available', 'downloading', 'ready', 'waiting', 'installing'])

/**
 * One answer from the three builds and the desktop updater. `served` is undefined before the first read, null when it
 * failed. A newer page wins over an older Host: after the reload the page itself says the Host is older.
 */
export function buildStatus(input: {
  page: string
  host: string | undefined
  served: string | null | undefined
  checking: boolean
  app?: { state: UpdateState; version?: string | undefined } | null | undefined
}): BuildStatus {
  const { page, host, served, app } = input
  if (input.checking || app?.state === 'checking') return { kind: 'checking' }
  if (app && APP_RELEASE.has(app.state)) return { kind: 'app', version: app.version }
  if (!page) return { kind: 'dev' }
  if ((served && served > page) || (host && host > page)) return { kind: 'page' }
  if (hostIsOlder(host, page)) return { kind: 'host' }
  if (served === null) return { kind: 'failed', build: page }
  return { kind: 'current', build: page }
}

/** The icon's tooltip for a status; the ones that ask for something carry the dot. */
export function buildStatusWords(status: BuildStatus): { tooltip: string; dot: boolean } {
  switch (status.kind) {
    case 'checking':
      return { tooltip: '正在检查更新…', dot: false }
    case 'app':
      return { tooltip: status.version ? `Latch ${status.version} 可更新` : 'Latch 有更新', dot: true }
    case 'page':
      return { tooltip: '有新版页面 · 重新载入', dot: true }
    case 'host':
      return { tooltip: 'Latch 服务是旧版本 · 重启 Latch', dot: true }
    case 'dev':
      return { tooltip: '检查更新 · 开发运行，无构建号', dot: false }
    case 'failed':
      return { tooltip: `未能检查 · 构建 ${shortBuild(status.build)}`, dot: false }
    case 'current':
      return { tooltip: `已是最新 · 构建 ${shortBuild(status.build)}`, dot: false }
  }
}
