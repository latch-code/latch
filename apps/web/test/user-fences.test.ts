import { expect, it } from 'vitest'
import { reviewNotesMessage } from '@latch/protocol'
import { fencedParts } from '../src/components/MentionedText.tsx'

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
  expect(parts.filter(part => part.kind === 'code')).toEqual([{ kind: 'code', text: 'const a = `x`\ncall(a)' }])
  expect(parts.map(part => part.text).join('')).not.toContain('```')
  expect(parts.at(-1)).toEqual({ kind: 'text', text: '这里改成常量' })
})

it('keeps a fence that never closes, or a shorter closing run, as typed', () => {
  expect(fencedParts('看这个\n```ts\nopen')).toEqual([{ kind: 'text', text: '看这个\n```ts\nopen' }])
  expect(fencedParts('````\na\n```\n````')).toEqual([{ kind: 'code', text: 'a\n```' }])
  expect(fencedParts('plain `code` text')).toEqual([{ kind: 'text', text: 'plain `code` text' }])
})
