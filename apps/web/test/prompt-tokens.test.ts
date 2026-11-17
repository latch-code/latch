import { describe, expect, it } from 'vitest'
import type { SessionSkill } from '@latch/protocol'
import { markBeforeCaret, promptMarks, type PromptCatalogue } from '../src/composer/prompt-tokens.ts'

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

describe('whole-token backspace', () => {
  const text = '请 $check 和 $lark-apps'
  const marks = promptMarks(text, codex)
  it('takes the mark right before a collapsed caret', () => {
    expect(markBeforeCaret(marks, 8, 8)).toMatchObject({ start: 2, end: 8 })
    expect(markBeforeCaret(marks, text.length, text.length)).toMatchObject({ start: 11, end: text.length })
  })
  it('leaves other positions and selections to the input', () => {
    expect(markBeforeCaret(marks, 7, 7)).toBeUndefined()
    expect(markBeforeCaret(marks, 9, 9)).toBeUndefined()
    expect(markBeforeCaret(marks, 2, 8)).toBeUndefined()
  })
})
