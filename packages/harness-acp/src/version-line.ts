/**
 * A program's own `--version` answer when its first line is the version alone, `v` allowed: `0.2.1-rc.2`, `v1.5.0`.
 * Anything else, such as an update notice naming two versions, is no answer.
 */
export function bareVersion(stdout: string): string | undefined {
  const first = stdout.split(/\r?\n/u).find(line => line.trim()) ?? ''
  return /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s*$/u.exec(first)?.[1]
}
