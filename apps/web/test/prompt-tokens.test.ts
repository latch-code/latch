import { describe, expect, it } from 'vitest'
import type { SessionSkill } from '@latch/protocol'
import { promptChips, promptMarks, type PromptCatalogue } from '../src/composer/prompt-tokens.ts'

const codex: PromptCatalogue = {
  commands: [{ name: 'compact', description: '压缩上下文' }, { name: 'usr' }],
  skills: [
    { name: 'lark-apps', invocation: '$lark-apps', description: '飞书应用', scope: 'user' },
    { name: 'check', invocation: '$check' },
  ] satisfies SessionSkill[],
  actions: [{ name: 'model', description: '换模型' }],
}
const pi: PromptCatalogue = {
  commands: [{ name: 'skill:review' }, { name: 'reload' }],
  skills: [{ name: 'review', invocation: '/skill:review' }],
}
const spans = (text: string, catalogue = codex) => promptMarks(text, catalogue).map(mark => [mark.kind, text.slice(mark.start, mark.end)])

describe('prompt marks', () => {
  it('marks catalogue skills anywhere between spaces and commands only as the first word', () => {
    expect(spans('$lark-apps')).toEqual([['skill', '$lark-apps']])
    expect(spans('/compact 请 $check 然后 $lark-apps\n$check')).toEqual([
      ['command', '/compact'],
      ['skill', '$check'],
      ['skill', '$lark-apps'],
      ['skill', '$check'],
    ])
    expect(promptMarks('$lark-apps', codex)[0]).toMatchObject({ name: 'lark-apps', description: '飞书应用' })
    expect(promptMarks('/compact', codex)[0]).toMatchObject({ name: 'compact', description: '压缩上下文' })
    expect(spans('先 /compact')).toEqual([])
    expect(spans(' /compact')).toEqual([])
  })

  it('leaves unknown names plain', () => {
    expect(spans('$lark $lark-apps-x /compactly /unknown')).toEqual([])
    expect(spans('$lark-apps', { commands: [], skills: [] })).toEqual([])
  })

  it('keeps CJK neighbours, punctuation and quotes as the Host reads them', () => {
    expect(spans('请用 $lark-apps 写一个页面')).toEqual([['skill', '$lark-apps']])
    expect(spans('请用　$lark-apps　写')).toEqual([['skill', '$lark-apps']])
    expect(spans('请用$lark-apps写')).toEqual([])
    expect(spans('$lark-apps。')).toEqual([])
    expect(spans('`$lark-apps` "$check"')).toEqual([])
  })

  it('never reads a $ inside a word or a path, or a / inside a URL or path', () => {
    expect(spans('a$check cost$check')).toEqual([])
    expect(spans('/tmp/$check ~/$check ./$check')).toEqual([])
    expect(spans('/usr/bin 打开')).toEqual([])
    expect(spans('看 https://example.com/compact')).toEqual([])
    expect(spans('/usr')).toEqual([['command', '/usr']])
  })

  it('limits pi skills and commands to the start', () => {
    expect(spans('/skill:review 这次改动', pi)).toEqual([['skill', '/skill:review']])
    expect(spans('请 /skill:review', pi)).toEqual([])
    expect(spans('/reload', pi)).toEqual([['command', '/reload']])
    expect(spans('$review', pi)).toEqual([])
  })

  it('marks a Latch action after leading space or a full-width slash', () => {
    expect(spans('/model')).toEqual([['command', '/model']])
    expect(spans('  ／model 换一个')).toEqual([['command', '／model']])
    expect(spans('/models')).toEqual([])
  })
})

describe('prompt chips', () => {
  const team: PromptCatalogue = {
    ...codex,
    members: [
      { token: '@输出-1', name: '输出一', title: '列出改动' },
      { token: '@输出-4', name: '输出四', title: '核对接口' },
    ],
  }
  const refs = [
    { root: 'default', path: 'vitest.browser.config.ts' },
    { root: 'docs', path: 'guide/中文 说明.md' },
  ]
  const chips = (text: string) => promptChips(text, team, refs).map(chip => [chip.kind, text.slice(chip.start, chip.end), chip.name])

  it('finds every kind in order, across Chinese text and lines, and keeps the text as written', () => {
    const text = '/compact 看看 @default:vitest.browser.config.ts\n请 @输出-1 @输出-4 用 $check 检查\n@default:vitest.browser.config.ts'
    expect(chips(text)).toEqual([
      ['command', '/compact', 'compact'],
      ['file', '@default:vitest.browser.config.ts', 'vitest.browser.config.ts'],
      ['member', '@输出-1', '输出一'],
      ['member', '@输出-4', '输出四'],
      ['skill', '$check', 'check'],
      ['file', '@default:vitest.browser.config.ts', 'vitest.browser.config.ts'],
    ])
  })

  it('takes a file only while it is referenced and stands on its own', () => {
    expect(chips('@default:vitest.browser.config.ts,')).toEqual([])
    expect(chips('看@default:vitest.browser.config.ts')).toEqual([])
    expect(promptChips('@default:vitest.browser.config.ts', team, [])).toEqual([])
    expect(chips('看 @docs:guide/中文 说明.md 吧')).toEqual([['file', '@docs:guide/中文 说明.md', '中文 说明.md']])
  })

  it('never overlaps: one range read two ways is one chip', () => {
    const text = '@输出-1 @default:a.ts @输出-1'
    const both = promptChips(text, { members: [{ token: '@default:a.ts', name: 'A', title: 'A' }] }, [{ root: 'default', path: 'a.ts' }])
    expect(both.map(chip => [chip.start, chip.end])).toEqual([[6, 19]])
  })
})
