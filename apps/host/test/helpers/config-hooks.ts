import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * A Git that runs hooks from configuration (`hook.<name>.command` and `.event`, Git 2.54 and later), or undefined.
 * The developer tools' copy is named by its real path: /usr/bin/git may only offer to install them.
 */
export function configHookGit(): string | undefined {
  for (const candidate of [
    '/Library/Developer/CommandLineTools/usr/bin/git',
    '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
  ]) {
    if (!existsSync(candidate)) continue
    try {
      const match = /git version (\d+)\.(\d+)/u.exec(
        execFileSync(candidate, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }),
      )
      if (match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 54))) return candidate
    } catch {
      // Not a working Git.
    }
  }
  return undefined
}
