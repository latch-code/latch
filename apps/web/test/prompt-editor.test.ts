// @vitest-environment happy-dom
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import type { FileMention, SessionSkill } from '@latch/protocol'
import { PromptEditor, promptInputOf, type PromptEditorProps, type PromptInput } from '../src/composer/PromptEditor.tsx'
import type { PromptCatalogue } from '../src/composer/prompt-tokens.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const catalogue: PromptCatalogue = {
  commands: [{ name: 'compact', description: '压缩上下文' }],
  skills: [{ name: 'lark-apps', invocation: '$lark-apps', description: '飞书应用' }] satisfies SessionSkill[],
  members: [
    { token: '@输出-1', name: '输出一', title: '列出改动' },
    { token: '@输出-4', name: '输出四', title: '核对接口' },
  ],
}
/** ⌘ on a Mac, Ctrl elsewhere, as CodeMirror reads `Mod`. */
const mod = /Mac/u.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
const refs: FileMention[] = [{ root: 'default', path: 'src/vitest.browser.config.ts' }]

let root: Root | undefined
let host: HTMLElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
})

/** The editor as the composer mounts it, its draft held outside like the composer's `draft` state. */
function mount(initial: string, overrides: Partial<PromptEditorProps> = {}) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const inputRef = createRef<PromptInput>()
  const state = { draft: initial, changes: [] as string[] }
  const props = (extra: Partial<PromptEditorProps> = {}): PromptEditorProps => ({
    inputRef,
    value: state.draft,
    onChange: value => {
      state.draft = value
      state.changes.push(value)
    },
    catalogue,
    refs,
    attributes: { label: '继续对话' },
    placeholder: '输入消息',
    disabled: false,
    ...overrides,
    ...extra,
  })
  const render = (extra: Partial<PromptEditorProps> = {}) => act(() => root!.render(createElement(PromptEditor, props(extra))))
  render()
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
  const chips = () =>
    [...host!.querySelectorAll<HTMLElement>('.prompt-chip')].map(chip => [
      chip.dataset.kind,
      chip.querySelector('.prompt-chip-label')!.textContent,
    ])
  const key = (pressed: string, init: KeyboardEventInit = {}, type = 'keydown') =>
    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent(type, { key: pressed, bubbles: true, cancelable: true, ...init }))
    })
  const paste = (text: string, file?: File) => {
    const data = new DataTransfer()
    if (text) data.setData('text/plain', text)
    if (file) data.items.add(file)
    act(() => {
      view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
  }
  return { state, view, input: () => inputRef.current!, chips, key, paste, render }
}

describe('the prompt editor', () => {
  it('keeps a terminal error editable with its indentation and literal tokens, while hiding its Markdown delimiters', () => {
    const draft = [
      '请用 $lark-apps 检查',
      '终端 1 · 最近报错',
      '```text',
      'TypeError: $lark-apps',
      '    at render (app.ts:5:2)',
      '```',
      '再试一次',
    ].join('\n')
    const { view, input, state, render, key, chips } = mount(draft)
    expect(view.contentDOM.querySelector('.terminal-excerpt-heading')?.textContent).toBe('终端 1 · 最近报错')
    expect(view.contentDOM.querySelector('.terminal-excerpt-detail')?.textContent).toBe('    at render (app.ts:5:2)')
    expect(view.contentDOM.textContent).not.toContain('```')
    expect(chips()).toEqual([['skill', 'lark-apps']])
    expect(input().value).toBe(draft)
    const index = draft.indexOf('render')
    act(() => view.dispatch({ changes: { from: index, to: index + 6, insert: 'load' }, userEvent: 'input.type' }))
    expect(input().value).toBe(draft.replace('render', 'load'))
    key('z', mod)
    expect(input().value).toBe(draft)
    state.draft = '另一个草稿'
    render()
    expect(view.contentDOM.querySelector('.terminal-excerpt')).toBeNull()
  })

  it('holds the draft as its document and draws every kind of token as a chip, in Chinese and over lines', () => {
    const text = '/compact 看看 @src 和 @default:src/vitest.browser.config.ts\n请 @输出-1 @输出-4 用 $lark-apps 检查\n\n结尾 $lark-apps。'
    const { view, input, chips } = mount(text)
    expect(view.state.doc.toString()).toBe(text)
    expect(input().value).toBe(text)
    expect(chips()).toEqual([
      ['command', 'compact'],
      ['file', 'vitest.browser.config.ts'],
      ['member', '输出一'],
      ['member', '输出四'],
      ['skill', 'lark-apps'],
    ])
    const file = host!.querySelector<HTMLElement>('.prompt-chip[data-kind="file"]')!
    expect(file.title).toBe('default:src/vitest.browser.config.ts')
    // Assistive technology reads the token as written; the name it shows is decoration.
    expect(file.querySelector('.prompt-chip-token')!.textContent).toBe('@default:src/vitest.browser.config.ts')
    expect(file.querySelector('.prompt-chip-label')!.getAttribute('aria-hidden')).toBe('true')
    expect(view.contentDOM.getAttribute('role')).toBe('textbox')
    expect(view.contentDOM.getAttribute('aria-label')).toBe('继续对话')
    expect(view.contentDOM.getAttribute('aria-multiline')).toBe('true')
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('true')
    expect(view.contentDOM.getAttribute('autocorrect')).toBe('on')
  })

  it('draws a chip once the catalogue arrives after the text', () => {
    const { chips, render } = mount('请用 $lark-apps 写', { catalogue: {}, refs: [] })
    expect(chips()).toEqual([])
    render({ catalogue, refs })
    expect(chips()).toEqual([['skill', 'lark-apps']])
  })

  it('takes a chip whole with Backspace and Delete, and one undo brings it back', () => {
    const text = '请用 $lark-apps 写'
    const end = text.indexOf(' 写')
    const { view, state, key, chips } = mount(text)
    act(() => view.dispatch({ selection: { anchor: end } }))
    key('Backspace')
    expect(state.draft).toBe('请用  写')
    expect(chips()).toEqual([])
    key('z', mod)
    expect(state.draft).toBe(text)
    expect(chips()).toEqual([['skill', 'lark-apps']])
    act(() => view.dispatch({ selection: { anchor: text.indexOf('$') } }))
    key('Delete')
    expect(state.draft).toBe('请用  写')
  })

  it('applies a draft changed outside without making it a step of undo', () => {
    const { view, state, input, render } = mount('first')
    act(() => view.dispatch({ changes: { from: 5, insert: '!' }, userEvent: 'input.type' }))
    expect(state.draft).toBe('first!')
    // Another session's draft (or the next one after a send): undo has nothing of the earlier text to bring back.
    state.draft = 'first! from elsewhere'
    render()
    expect(input().value).toBe('first! from elsewhere')
    expect(state.changes).toEqual(['first!'])
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ...mod, bubbles: true, cancelable: true }))
    expect(input().value).toBe('first! from elsewhere')
  })

  it('puts the caret after a draft that fills an empty input, as ↑ recalls the last message', () => {
    const { state, input, render } = mount('')
    state.draft = '上一条消息'
    render()
    expect(input().selectionStart).toBe('上一条消息'.length)
  })

  it('leaves the caret after text put in where it stands, and elsewhere where it was', () => {
    const { state, input, render, view } = mount('/bt')
    act(() => view.dispatch({ selection: { anchor: 3 } }))
    state.draft = '/btw '
    render()
    expect(input().selectionStart).toBe(5)
    act(() => view.dispatch({ selection: { anchor: 1 } }))
    state.draft = '/btw 追加'
    render()
    expect(input().selectionStart).toBe(1)
  })

  it('puts a menu edit in with its caret, as one step of undo', () => {
    const { input, state, chips } = mount('请 @输')
    act(() => input().edit('请 @输出-1 ', { start: 8, end: 8 }))
    expect(state.draft).toBe('请 @输出-1 ')
    expect(input().selectionStart).toBe(8)
    expect(chips()).toEqual([['member', '输出一']])
  })

  it.each([{ metaKey: true }, { ctrlKey: true }, { metaKey: true, altKey: true, code: 'KeyV', key: '◊' }])(
    'pastes long plain text inline with %o and undoes it in one step',
    shortcut => {
      const onPaste = vi.fn(() => true)
      const { state, view, input, key, paste } = mount('before item after', { onPaste })
      act(() => {
        view.dispatch({ changes: { from: 0, insert: '>' }, userEvent: 'input.type' })
        input().setSelectionRange(8, 12)
      })
      const text = '日志\r\n'.repeat(1024)
      key('V', { ...shortcut, shiftKey: true })
      paste(text)
      expect(state.draft).toBe(`>before ${text.replaceAll('\r\n', '\n')} after`)
      expect(input().selectionStart).toBe(8 + text.replaceAll('\r\n', '\n').length)
      expect(input().selectionEnd).toBe(input().selectionStart)
      expect(onPaste).not.toHaveBeenCalled()
      key('z', mod)
      expect(state.draft).toBe('>before item after')
      expect([input().selectionStart, input().selectionEnd]).toEqual([8, 12])
      key('z', mod)
      expect(state.draft).toBe('before item after')
    },
  )

  it('leaves file-only and ordinary pastes to attachments after a plain-text shortcut', () => {
    const onPaste = vi.fn(() => true)
    const { state, view, key, paste } = mount('draft', { onPaste })
    const shortcut = { ...mod, shiftKey: true }
    key('V', shortcut)
    const file = new File(['image bytes'], 'shot.png', { type: 'image/png' })
    paste('', file)
    paste('log '.repeat(1024))
    key('V', shortcut)
    key('V', shortcut, 'keyup')
    paste('log '.repeat(1024))
    key('V', shortcut)
    act(() => {
      view.contentDOM.dispatchEvent(new FocusEvent('blur'))
    })
    paste('log '.repeat(1024))
    expect(onPaste).toHaveBeenCalledTimes(4)
    expect(state.changes).toEqual([])
  })

  it('does not change the draft or add attachments from a paste while the editor is closed to edits', () => {
    const onPaste = vi.fn(() => true)
    const { state, input, key, paste } = mount('draft', { disabled: true, onPaste })
    key('V', { ...mod, shiftKey: true })
    paste('log '.repeat(1024))
    paste('file only')
    expect(input().insertText('restored')).toBe(false)
    expect(onPaste).not.toHaveBeenCalled()
    expect(state.changes).toEqual([])
  })

  it('never turns a dropped file into text, and leaves the drop to the attachments', () => {
    const { view, state } = mount('hi @输出-1 ')
    const outer = vi.fn((event: Event) => event.type)
    host!.addEventListener('drop', outer)
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' }))
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: data })
    act(() => {
      view.contentDOM.dispatchEvent(drop)
    })
    expect(outer).toHaveBeenCalledTimes(1)
    expect(drop.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe('hi @输出-1 ')
    expect(state.changes).toEqual([])
  })

  it('gives its keys to the composer first and is found from the page', () => {
    const onKeyDown = vi.fn((event: KeyboardEvent) => {
      if (event.key !== 'Enter') return false
      event.preventDefault()
      return true
    })
    const { state, key } = mount('send me', { onKeyDown })
    key('Enter')
    expect(onKeyDown).toHaveBeenCalled()
    expect(state.draft).toBe('send me')
    expect(promptInputOf(host!.querySelector('.cm-content'))?.value).toBe('send me')
  })
})
