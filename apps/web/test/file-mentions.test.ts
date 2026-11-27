import { describe, expect, it } from 'vitest'
import { hasFileMention, mentionRange } from '../src/fileMentions.ts'
import { activeAgentMention, activeFileMention, mentionActive, mentionKey } from '../src/hooks/useFileMentions.tsx'

describe('explicit file markers', () => {
  const ref = { root: 'web', path: 'report.txt' }
  it('drops edited prefixes and recognizes a complete selected marker at whitespace boundaries', () => {
    expect(hasFileMention('please @web:report.txt now', ref)).toBe(true)
    expect(hasFileMention('@web:report.txt.backup', ref)).toBe(false)
    expect(hasFileMention('user@web:report.txt', ref)).toBe(false)
    expect(mentionRange('  @web:report.txt\n', ref)).toEqual({ start: 2, end: 17 })
  })
  it('keeps spaces in selected paths, and never opens the file chooser for an email', () => {
    expect(hasFileMention('@web:meeting notes.txt ', { root: 'web', path: 'meeting notes.txt' })).toBe(true)
    expect(activeFileMention('user@example.com', 16)).toBeUndefined()
    expect(activeFileMention('look @rep later', 9)).toEqual({ start: 5, end: 9, query: 'rep' })
  })
  it('opens the personal Agent picker after Chinese text or a full-width at-sign, but never inside an email', () => {
    expect(activeAgentMention('请＠架构师帮忙', 4)).toEqual({ start: 1, end: 4, query: '架构' })
    expect(activeAgentMention('请@编辑', 4)).toEqual({ start: 1, end: 4, query: '编辑' })
    expect(activeAgentMention('me@example', 10)).toBeUndefined()
    expect(activeAgentMention('请@架构师。', 6)).toBeUndefined()
  })
})

describe('the @ file list, by the slash menu’s keys', () => {
  const key = (name: string, extra: Partial<Parameters<typeof mentionKey>[0]> = {}) =>
    mentionKey({ key: name, shift: false, count: 3, loading: false, query: 'rep', active: 0, ...extra })
  it('selects nothing after a bare @ until an arrow key, and the first file once something is typed', () => {
    expect(mentionActive({ count: 3, loading: false, query: '' })).toBe(-1)
    expect(mentionActive({ count: 3, loading: false, query: 'rep' })).toBe(0)
    expect(mentionActive({ count: 3, loading: false, query: '', selected: { query: '', index: 2 } })).toBe(2)
    // A choice made for other words, or past the end of a shorter list, does not carry over.
    expect(mentionActive({ count: 3, loading: false, query: 're', selected: { query: 'rep', index: 2 } })).toBe(0)
    expect(mentionActive({ count: 1, loading: false, query: '', selected: { query: '', index: 2 } })).toBe(-1)
    expect(mentionActive({ count: 3, loading: true, query: 'rep' })).toBe(-1)
  })
  it('completes with Tab, chooses with Enter, closes with Esc, and wraps with the arrows', () => {
    expect(key('Tab')).toEqual({ do: 'choose', index: 0 })
    expect(key('Enter', { active: 2 })).toEqual({ do: 'choose', index: 2 })
    expect(key('Escape')).toEqual({ do: 'close' })
    expect(key('ArrowDown', { active: 2 })).toEqual({ do: 'move', index: 0 })
    expect(key('ArrowUp', { active: 0 })).toEqual({ do: 'move', index: 2 })
    expect(key('ArrowDown', { active: -1, query: '' })).toEqual({ do: 'move', index: 0 })
    expect(key('ArrowUp', { active: -1, query: '' })).toEqual({ do: 'move', index: 2 })
  })
  it('keeps scrolling down at a page boundary and wraps up to the last loaded file', () => {
    expect(key('ArrowDown', { active: 2, hasNextPage: true })).toEqual({ do: 'choose', index: 2 })
    expect(key('ArrowUp', { active: -1, hasNextPage: true })).toEqual({ do: 'move', index: 1 })
  })
  it('leaves Enter, Tab and Shift+Enter to the input when no row is chosen, and holds Enter while typed results load', () => {
    expect(key('Enter', { active: -1, query: '' })).toEqual({ do: 'pass' })
    expect(key('Tab', { active: -1, query: '' })).toEqual({ do: 'pass' })
    expect(key('Enter', { shift: true })).toEqual({ do: 'pass' })
    expect(key('Enter', { count: 0, active: -1 })).toEqual({ do: 'pass' })
    expect(key('Enter', { loading: true, active: -1 })).toEqual({ do: 'wait' })
    expect(key('ArrowDown', { loading: true, active: -1 })).toEqual({ do: 'pass' })
    expect(key('a')).toEqual({ do: 'pass' })
  })
})
