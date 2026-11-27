import { describe, expect, it } from 'vitest'
import { testHarness } from '@latch/testkit'
import { emptyCommandList, harnessCommandSource, slashMatches, slashOptions } from '../src/composer/SlashCommands.tsx'
import { latchActionOf } from '../src/composer/latchActions.ts'
describe('advertised slash commands', () => {
  it('groups only declared skills, preserves native invocations and removes duplicate legacy skill commands', () => {
    const skills = [
      { name: 'review', invocation: '$review', description: '检查改动', scope: 'project' as const },
      { name: 'notes', invocation: '/skill:notes', scope: 'user' as const },
    ]
    const result = slashOptions('/', [{ name: 'review' }, { name: 'skill:notes' }, { name: 'skill:legacy' }], [], [], { skills })
    expect(result.map(option => [option.kind, option.label])).toEqual([
      ['command', '/review'],
      ['command', '/skill:legacy'],
      ['skill', '$review'],
      ['skill', '/skill:notes'],
    ])
    expect(result[2]).toMatchObject({ text: '$review ', source: '项目' })
    expect(result[3]).toMatchObject({ text: '/skill:notes ', source: '个人' })
    expect(slashOptions('请 /review', [{ name: 'review' }], [], [], { skills, firstTurn: true, running: true })).toMatchObject([
      { kind: 'skill', label: '$review', text: '$review ' },
    ])
    expect(slashOptions('/tmp/review', [], [], [], { skills })).toEqual([])
    expect(slashOptions('/检', [], [], [], { skills })[0]?.label).toBe('$review')
    expect(slashOptions('请 /notes', [], [], [], { skills })).toEqual([])
    expect(slashOptions('/公开', [{ name: 'skill:notes', description: '读取公开说明' }], [], [], { skills })).toMatchObject([
      { kind: 'skill', label: '/skill:notes', description: '读取公开说明' },
    ])
  })
  it('keeps every advertised skill reachable and never supplies an execution handler', () => {
    const skills = Array.from({ length: 200 }, (_, index) => ({ name: `proof-${index}`, invocation: `$proof-${index}` }))
    const result = slashOptions('/', [], [], [], { skills })
    expect(result).toHaveLength(200)
    expect(result.at(-1)).toMatchObject({ kind: 'skill', label: '$proof-199', text: '$proof-199 ' })
    expect(result.every(option => option.run === undefined && option.unavailable === undefined)).toBe(true)
    expect(slashOptions('/proof-199', [], [], [], { skills })[0]?.label).toBe('$proof-199')
  })
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

  it('tells an absent report from an empty one and a report with only reserved or grouped names', () => {
    expect(harnessCommandSource(testHarness('antigravity', { label: 'Antigravity' }), 'before-session')).toMatchObject({
      name: 'Antigravity',
      source: 'before-session',
    })
    expect(harnessCommandSource(testHarness('standard', { kind: 'builtin' }), 'before-session')?.source).toBe('unsupported')
    expect(emptyCommandList('before-session', undefined)).toBe('发送第一条消息后，可查看 Harness 返回的命令')
    expect(emptyCommandList('unsupported', undefined)).toBe('当前接入方式不提供 Harness 命令')
    expect(emptyCommandList('session', undefined)).toBe('当前连接尚未提供命令列表')
    expect(emptyCommandList('session', [])).toBe('当前会话没有可用的 Harness 命令')
    expect(emptyCommandList('previous-session', [])).toBe('上次会话没有列出命令')
    const reported = [{ name: 'model' }, { name: 'skill:notes' }]
    expect(emptyCommandList('session', reported)).toBe('没有可单独列出的 Harness 命令')
    const skills = [{ name: 'notes', invocation: '/skill:notes' }]
    expect(slashOptions('/', reported, [], [], { session: true, skills }).map(option => option.kind)).toEqual(['skill'])
    expect(slashOptions('/', [], [], [], { session: true })).toEqual([])
    expect(slashOptions('/', commands, [], [], { session: true }).map(option => option.label)).toEqual(['/init', '/review'])
  })
})
