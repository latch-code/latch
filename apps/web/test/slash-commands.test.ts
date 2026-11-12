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
  it('names a template made in 设置 by its name, never its random ID', () => {
    const id = '65aad3f9-54a6-43a4-a9df-ccd0bb1cb6cc'
    const templates = [{ id, name: '代码审查', content: '审查这次改动。', scope: { kind: 'all' as const } }]
    const [option] = slashOptions('/', [], templates)
    expect(option).toMatchObject({ id: `template:${id}`, label: '/代码审查', text: '审查这次改动。' })
    expect(slashOptions('/代码', [], templates)[0]?.label).toBe('/代码审查')
    expect(slashOptions('/65aad3f9', [], templates)).toEqual([])
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
  it("lists Latch's own actions first, runs them on choice and inserts nothing", () => {
    const clear = { name: 'clear', description: '清空上下文', run: () => {} }
    const result = slashOptions('/cl', [{ name: 'clear', description: 'Harness clear' }, { name: 'close' }], [], [clear])
    expect(result.map(option => [option.kind, option.label])).toEqual([
      ['action', '/clear'],
      ['command', '/clear'],
      ['command', '/close'],
    ])
    expect(result[0]).toMatchObject({ text: '', run: clear.run })
    expect(slashOptions('/clear now', [], [], [clear])).toEqual([])
  })
})
