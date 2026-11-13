import { describe, expect, it } from 'vitest'
import { slashMatches, slashOptions } from '../src/composer/SlashCommands.tsx'
import { latchActionOf } from '../src/composer/latchActions.ts'
describe('advertised slash commands', () => {
  it('reserves all eight Latch actions even when not offered here, without intercepting paths or inline text', () => {
    expect(slashOptions('/', [{ name: 'clear' }, { name: 'MODEL' }, { name: 'init' }], [])).toMatchObject([{ label: '/init' }])
    expect(latchActionOf('／MODEL deepseek')).toEqual({ name: 'model', argument: 'deepseek' })
    expect(latchActionOf('/new 第一条\n第二行')).toEqual({ name: 'new', argument: '第一条\n第二行' })
    expect(latchActionOf('看看 /model')).toBeUndefined()
    expect(latchActionOf('/model/file')).toBeUndefined()
    expect(latchActionOf('/models')).toBeUndefined()
    expect(slashOptions('/qksxw', [], [], [{ name: 'clear', description: '清空上下文' }])[0]?.label).toBe('/clear')
  })
  const commands = [{ name: 'init', description: 'Prepare' }, { name: 'review' }]
  it('suggests only an initial slash token, filters case-insensitively, and never treats prose or arguments as commands', () => {
    expect(slashMatches('/', commands)).toEqual(commands)
    expect(slashMatches('/INIT', commands)).toEqual([commands[0]])
    expect(slashMatches('/init arguments', commands)).toEqual([])
    expect(slashMatches('explain /review', commands)).toEqual([])
    expect(
      slashMatches(
        '/',
        Array.from({ length: 200 }, (_, i) => ({ name: String(i) })),
      ),
    ).toHaveLength(200)
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
    expect(result.map(option => option.kind)).toEqual(['command', 'template'])
    expect(result[1]?.text).toBe(templates[0]?.content)
    expect(slashOptions('/检查', commands, templates)[0]?.id).toBe('template:review')
    expect(slashOptions('/review arguments', commands, templates)).toEqual([])
    expect(slashOptions('/missing', commands, templates)).toEqual([])
  })
  it('reserves Latch names and keeps client actions after Harness commands', () => {
    const clear = { name: 'clear', description: '清空上下文', run: () => {} }
    const result = slashOptions('/cl', [{ name: 'clear', description: 'Harness clear' }, { name: 'close' }], [], [clear])
    expect(result.map(option => [option.kind, option.label])).toEqual([
      ['command', '/close'],
      ['action', '/clear'],
    ])
    expect(result[1]).toMatchObject({ text: '/clear ', run: clear.run })
    expect(slashOptions('/clear now', [], [], [clear])).toEqual([])
  })
  it('keeps idle-only commands visible with a reason and limits inline queries to templates', () => {
    const offered = [{ name: 'compact', idleOnly: true as const }, { name: 'status' }]
    const running = slashOptions('/', offered, [], [], { running: true, session: true })
    expect(running.map(option => option.label)).toEqual(['/status', '/compact'])
    expect(running[1]).toMatchObject({ unavailable: true, description: '这一轮结束后可用' })
    expect(slashOptions('/compact', [], [], [], { session: true })[0]?.unavailable).toBe(true)
    const template = { id: 'review', name: '检查', content: '检查 $ARGUMENTS', scope: { kind: 'all' as const } }
    expect(slashOptions('请 /rev', commands, [template]).map(option => option.kind)).toEqual(['template'])
    expect(slashOptions('/review', commands, [], [], { firstTurn: true })[0]?.description).toBe('第一条消息之后可用')
  })
})
