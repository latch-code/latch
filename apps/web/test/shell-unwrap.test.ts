import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { homeOf, tildeHome, unwrapShell } from '../src/core/shellUnwrap.ts'

interface Case {
  name: string
  reported: string
  command: string
  shell: string | null
}

describe('shell wrappers', () => {
  it('shows the wrapped command for the shared vectors and leaves every other shape as reported', async () => {
    const { cases } = JSON.parse(await readFile('packages/testkit/vectors/shell-unwrap-v1.json', 'utf8')) as { cases: Case[] }
    expect(cases.length).toBeGreaterThan(30)
    for (const item of cases) {
      const shown = unwrapShell(item.reported)
      expect({ name: item.name, command: shown.command, shell: shown.shell ?? null }).toEqual({
        name: item.name,
        command: item.command,
        shell: item.shell,
      })
    }
  })

  it('never unwraps twice: a wrapper inside a wrapper stays the inner command as written', () => {
    expect(unwrapShell(`zsh -lc "bash -lc 'ls'"`)).toEqual({ command: "bash -lc 'ls'", shell: 'zsh -lc' })
  })

  it("reads the home directory off the session's own folders and assumes none elsewhere", () => {
    expect(homeOf(['/Users/me/Latch/workspace/a'])).toBe('/Users/me')
    expect(homeOf(['/home/dev/src', undefined, '/home/dev/other'])).toBe('/home/dev')
    expect(homeOf(['/Users/me'])).toBe('/Users/me')
    expect(homeOf(['/Users/me/a', '/Users/you/b'])).toBeUndefined()
    expect(homeOf(['/Users/Shared/project'])).toBeUndefined()
    expect(homeOf(['/Volumes/work/project'])).toBeUndefined()
    expect(homeOf(['/Users/me/a', '/srv/b'])).toBeUndefined()
    expect(homeOf([])).toBeUndefined()
  })

  it('writes the home directory as ~ only where a path begins with it', () => {
    const home = '/Users/me'
    expect(tildeHome('ls -ld /Users/me/Desktop; ls /Users/me', home)).toBe('ls -ld ~/Desktop; ls ~')
    expect(tildeHome("cat '/Users/me/a b.txt' --out=/Users/me/out", home)).toBe("cat '~/a b.txt' --out=~/out")
    expect(tildeHome('ls /Users/melody /mnt/Users/me/x', home)).toBe('ls /Users/melody /mnt/Users/me/x')
    expect(tildeHome('ls /Users/me/x', undefined)).toBe('ls /Users/me/x')
  })
})
