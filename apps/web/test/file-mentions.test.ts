// @vitest-environment happy-dom
import { act, createElement, useRef, useState, type ChangeEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import * as client from '../src/core/api.ts'
import { hasFileMention, mentionRange } from '../src/fileMentions.ts'
import { activeFileMention, mentionActive, mentionKey, useFileMentions } from '../src/hooks/useFileMentions.tsx'

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
  it.each(['editing the token away', 'pressing Escape'])('starts a fresh bare @ list after %s', async close => {
    const search = vi.spyOn(client, 'api').mockResolvedValue({ files: [{ root: 'web', path: 'report.txt', name: 'report.txt' }] })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.useFakeTimers()

    function Input() {
      const [draft, setDraft] = useState('')
      const textarea = useRef<HTMLTextAreaElement>(null)
      const mentions = useFileMentions(
        draft,
        setDraft,
        textarea,
        { enabled: true, workspaceId: 'web', harnessId: 'standard', refs: [], onRefs: () => {} },
        textarea,
      )
      return createElement('textarea', {
        ref: textarea,
        value: draft,
        'aria-controls': mentions.open ? mentions.listId : undefined,
        'aria-activedescendant': mentions.activeId,
        onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
          const input = event.currentTarget
          mentions.setCaret(input.selectionStart)
          setDraft(input.value)
        },
        onKeyDown: mentions.keydown,
      })
    }

    try {
      await act(async () => root.render(createElement(Input)))
      const input = container.querySelector('textarea')!
      const fill = (text: string) =>
        act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
          input.setSelectionRange(text.length, text.length)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
      const press = (key: string) =>
        act(async () => {
          input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
        })
      await fill('@')
      await act(async () => vi.advanceTimersByTimeAsync(160))
      expect(search).toHaveBeenCalledTimes(1)
      expect(input.getAttribute('aria-activedescendant')).toBeNull()
      await press('ArrowDown')
      expect(input.getAttribute('aria-activedescendant')).toBeTruthy()
      if (close === 'pressing Escape') {
        await press('Escape')
        expect(input.getAttribute('aria-controls')).toBeNull()
      }
      await fill('')
      expect(input.getAttribute('aria-controls')).toBeNull()
      await fill('@')
      await act(async () => vi.advanceTimersByTimeAsync(160))
      expect(search).toHaveBeenCalledTimes(2)
      expect(input.getAttribute('aria-activedescendant')).toBeNull()
      await press('Enter')
      expect(input.value).toBe('@')
      await press('ArrowDown')
      expect(input.getAttribute('aria-activedescendant')).toBeTruthy()
    } finally {
      await act(async () => root.unmount())
      container.remove()
      vi.useRealTimers()
      vi.unstubAllGlobals()
      search.mockRestore()
    }
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
