import { describe, expect, it } from 'vitest'
import { slashMatches, slashOptions } from '../src/composer/SlashCommands.tsx'
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
  it('ranks exact, prefix, word-start and substring commands, preserving discovery order for ties', () => {
    const offered = ['preinit', 'project-init', 'init-more', 'init', 'initial'].map(name => ({ name }))
    expect(slashMatches('/init', offered).map(item => item.name)).toEqual(['init', 'init-more', 'initial', 'project-init', 'preinit'])
  })
  it('finds a translated template by slash ID or display name and keeps it editable', () => {
    const templates = [{ id: 'review', name: '检查改动', content: '先检查改动，再给出建议。', scope: { kind: 'all' as const } }]
    const result = slashOptions('/review', commands, templates)
    expect(result.map(option => option.kind)).toEqual(['template', 'command'])
    expect(result[0]?.text).toBe(templates[0]?.content)
    expect(slashOptions('/检查', commands, templates)[0]?.id).toBe('template:review')
    expect(slashOptions('/review arguments', commands, templates)).toEqual([])
    expect(slashOptions('/missing', commands, templates)).toEqual([])
  })
})
