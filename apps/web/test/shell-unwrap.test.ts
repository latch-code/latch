import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { unwrapShell } from '../src/core/shellUnwrap.ts'

interface Case {
  name: string
  reported: string
  command: string
  shell: string | null
}

describe('shell wrappers', () => {
  it('shows the wrapped command for the shared vectors and leaves every other shape as reported', async () => {
    const { cases } = JSON.parse(await readFile('packages/testkit/vectors/shell-unwrap-v1.json', 'utf8')) as { cases: Case[] }
    expect(cases.length).toBeGreaterThan(40)
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
})
