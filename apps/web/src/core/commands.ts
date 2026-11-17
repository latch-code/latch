/** The application packager marks its HTML, including the page served to unenrolled browsers. */
const installed = typeof document !== 'undefined' && document.documentElement.dataset.latchDistribution === 'installed'
export const LATCH_COMMAND = installed ? 'latch' : 'pnpm latch'

/** One shell word for the executable supplied by the local desktop bridge. */
export function latchExecutableWord(path: string): string | undefined {
  if (!path.startsWith('/') || /[\x00-\x1f\x7f]/u.test(path)) return undefined
  return `'${path.replaceAll("'", "'\\''")}'`
}
