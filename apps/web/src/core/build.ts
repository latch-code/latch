declare const __LATCH_BUILD__: string | undefined

/** This page's build ID (vite.config.ts); empty in the development server and in tests. */
const PAGE_BUILD = typeof __LATCH_BUILD__ === 'string' ? __LATCH_BUILD__ : ''

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
