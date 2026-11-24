import { expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { reviewNotesMessage } from '@latch/protocol'
import { UserText } from '../src/components/MentionedText.tsx'
import { fencedParts } from '../src/conversation/fencedParts.ts'

it('cuts a sent line feedback at its quoted lines, so they show as code and not as fences', () => {
  const text = reviewNotesMessage([
    {
      path: 'src/a.ts',
      range: { start: 3, end: 4 },
      side: 'new',
      anchor: { lines: ['const a = `x`', 'call(a)'] } as never,
      text: '这里改成常量',
    },
  ])
  const parts = fencedParts(text)
  expect(parts.filter(part => part.kind === 'code')).toEqual([
    { kind: 'code', text: 'const a = `x`\ncall(a)', from: text.indexOf('const') },
  ])
  expect(parts.map(part => part.text).join('')).not.toContain('```')
  expect(parts.at(-1)).toEqual({ kind: 'text', text: '这里改成常量', from: text.indexOf('这里') })
})

it('keeps a fence that never closes, or a shorter closing run, as typed', () => {
  expect(fencedParts('看这个\n```ts\nopen')).toEqual([{ kind: 'text', text: '看这个\n```ts\nopen', from: 0 }])
  expect(fencedParts('````\na\n```\n````')).toEqual([{ kind: 'code', text: 'a\n```', from: 5 }])
  expect(fencedParts('plain `code` text')).toEqual([{ kind: 'text', text: 'plain `code` text', from: 0 }])
})

it('renders reply citations only outside fenced code in a sent message', () => {
  const marker = '[引用回复 session/example@0]'
  const text = [
    '[引用回复 session/first@12]\n> 引用前文',
    reviewNotesMessage([
      {
        path: 'example.md',
        range: { start: 1, end: 3 },
        side: 'new',
        anchor: { lines: ['```', marker, '> 示例文字'] } as never,
        text: '请保留原示例',
      },
    ]),
    '[引用回复 session/last@25]\n> 引用后文\n> ```',
  ].join('\n\n')
  const html = renderToStaticMarkup(createElement(UserText, { text }))
  expect(html).toContain('<pre class="user-code"><code>```\n' + marker + '\n&gt; 示例文字</code></pre>')
  expect(html.match(/class="user-reply-quote"/gu)).toHaveLength(2)
  expect(html).toContain('class="user-reply-quote">引用前文</span>')
  expect(html).toContain('class="user-reply-quote">引用后文\n```</span>')
})

it('keeps file chips, reply citations and ordinary code alongside multiple terminal excerpts', () => {
  const fence = '`'.repeat(3)
  const source = (label: string, body: string) => [label, fence + 'text', body, fence].join('\n')
  const text = [
    '看 @web:report.txt',
    source('终端 1 · 最近报错', 'Error: @web:report.txt\n    at a()'),
    '[引用回复 session/message@0]\n> 原句',
    source('Terminal 2 · Latest error', 'Error: file\u202Ename'),
    fence,
    'code sample',
    fence,
  ].join('\n')
  const html = renderToStaticMarkup(createElement(UserText, { text, refs: [{ root: 'web', path: 'report.txt' }] }))
  expect(html.match(/<figure /gu)).toHaveLength(2)
  expect(html.match(/class="file-chip prompt-chip"/gu)).toHaveLength(1)
  expect(html).toContain('Error: @web:report.txt')
  expect(html).toContain('class="user-reply-quote">原句')
  expect(html).toContain('<pre class="user-code"><code>code sample</code></pre>')
  expect(html).toContain('class="hidden-char"')
  expect(html).not.toContain('\u202E')
  expect(html).not.toContain(fence)
})

it('retains original blank lines around a reply quote when the message has no terminal excerpt', () => {
  const text = '\n前文\n\n[引用回复 session/message@0]\n> 原句\n\n后文\n'
  expect(renderToStaticMarkup(createElement(UserText, { text }))).toBe('\n前文\n\n<span class="user-reply-quote">原句</span>\n\n后文\n')
  expect(renderToStaticMarkup(createElement(UserText, { text: 'before\n```ts\nlet i = 0\n```\nafter' }))).toBe(
    'before<pre class="user-code"><code>let i = 0</code></pre>after',
  )
})
