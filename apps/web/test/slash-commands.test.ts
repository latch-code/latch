import { describe, expect, it } from 'vitest'
import { slashMatches } from '../src/components/SlashCommands.tsx'
describe('advertised slash commands', () => {
  const commands = [{ name: 'init', description: 'Prepare' }, { name: 'review' }]
  it('suggests only an initial slash token, filters case-insensitively, and never treats prose or arguments as commands', () => {
    expect(slashMatches('/', commands)).toEqual(commands)
    expect(slashMatches('/INIT', commands)).toEqual([commands[0]])
    expect(slashMatches('/init arguments', commands)).toEqual([])
    expect(slashMatches('explain /review', commands)).toEqual([])
    expect(
      slashMatches(
        '/',
        Array.from({ length: 100 }, (_, i) => ({ name: String(i) })),
      ),
    ).toHaveLength(20)
  })
})
