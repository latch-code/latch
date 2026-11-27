import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FILE_EDIT_LIMIT, isFileMetadata, type FileMetadata } from '@latch/protocol'
import { FileEditor } from '../src/preview/FileEditor.tsx'
import { decodeEditable, editHash, mixedLineEndings } from '../src/preview/editText.ts'
import { needsRecheck, notePersonEdit } from '../src/preview/personEdits.ts'
import {
  answerLeave,
  editDraft,
  hasUnsaved,
  requestDrop,
  requestLeave,
  retainOpenEditors,
  setEditDraft,
} from '../src/preview/editDrafts.ts'
import { eviction, type FileTab } from '../src/preview/useFileTabs.ts'

const file: FileMetadata = {
  handle: 'A'.repeat(22),
  name: 'notes.txt',
  root: 'default',
  path: 'notes.txt',
  ext: 'txt',
  kind: 'text',
  mime: 'text/plain',
  size: 8,
  mtime: 0,
  etag: `"${'a'.repeat(32)}"`,
  limit: 2 * 1024 * 1024,
  secret: false,
  actions: { reveal: false, quicklook: false, open: false, download: true, preview: true, edit: true },
}

const editor = (extra: Partial<Parameters<typeof FileEditor>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(FileEditor, {
      sessionId: 's',
      file,
      text: 'one\ntwo\nthree',
      baseHash: 'b'.repeat(64),
      running: false,
      phone: false,
      onSaved: () => {},
      onClose: () => {},
      ...extra,
    }),
  )

describe('file editor', () => {
  it('takes only UTF-8 text without NUL within the limit, and hashes the bytes it read', async () => {
    expect(decodeEditable(new TextEncoder().encode('héllo\n'))).toBe('héllo\n')
    expect(decodeEditable(new Uint8Array([0x63, 0xe9]))).toBeUndefined()
    expect(decodeEditable(new TextEncoder().encode('a\u0000b'))).toBeUndefined()
    expect(decodeEditable(new Uint8Array(FILE_EDIT_LIMIT + 1).fill(0x61))).toBeUndefined()
    expect(await editHash(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('accepts the edit action from a Host that offers it, and a malformed one never', () => {
    expect(isFileMetadata(file)).toBe(true)
    const { edit: _edit, ...older } = file.actions
    expect(isFileMetadata({ ...file, actions: older })).toBe(true)
    expect(isFileMetadata({ ...file, actions: { ...file.actions, edit: 'yes' } })).toBe(false)
  })

  it('draws 取消, 保存 and a line number per line; 保存 waits for a change and for the turn to end', () => {
    const html = editor()
    expect(html).toContain('取消')
    expect(html).toContain('保存')
    expect(html).toMatch(/class="file-editor-gutter"[^>]*>1\n2\n3</u)
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>保存/u)
    const running = editor({ running: true })
    expect(running).toContain('Agent 运行中')
    expect(editor({ phone: true })).toContain('data-phone=""')
  })

  it('on a conflict keeps both versions and offers only 复制我的修改 and 载入最新: nothing is written over the other change', () => {
    const html = editor({ initial: { draft: 'mine', phase: 'conflict', theirs: { hash: 'c'.repeat(64), text: 'theirs' } } })
    expect(html).toContain('文件已在别处修改')
    expect(html).toContain('复制我的修改')
    expect(html).toContain('载入最新')
    expect(html).toContain('theirs')
    expect(html).toContain('mine')
    expect(html).not.toContain('覆盖')
    expect(html).not.toMatch(/>保存</u)
  })

  it('keeps an unanswered save for 重试保存 and edits from the loaded version after 载入最新', () => {
    const unknown = editor({
      initial: { draft: 'x', phase: 'unknown', sent: { requestId: 'r'.repeat(16), baseHash: 'b'.repeat(64), content: 'x' } },
    })
    expect(unknown).toContain('重试保存')
    expect(unknown).toContain('结果未知')
    // The loaded version is the base: the same text there is not a change, so 保存 waits.
    const loaded = editor({ initial: { draft: 'theirs', phase: 'editing', base: { text: 'theirs', hash: 'c'.repeat(64) } } })
    expect(loaded).not.toContain('未保存')
    expect(loaded).toMatch(/<button[^>]*aria-disabled="true"[^>]*>保存/u)
  })

  it('marks a result checked before the last saved edit as needing a re-check', () => {
    expect(needsRecheck(undefined, 5)).toBe(false)
    expect(needsRecheck(5, undefined)).toBe(false)
    expect(needsRecheck(5, 4)).toBe(false)
    expect(needsRecheck(5, 6)).toBe(true)
    notePersonEdit('s', 10)
  })

  it('keeps an editor per session and tab, and asks before leaving a session with unsaved text', () => {
    const base = { file, text: 'a', hash: 'b'.repeat(64) }
    setEditDraft('s1', 'tab', { ...base, state: { draft: 'a', phase: 'editing' } })
    expect(hasUnsaved('s1')).toBe(false)
    let left = 0
    expect(requestLeave('s1', () => left++)).toBe(false)
    setEditDraft('s1', 'tab', { ...base, state: { draft: 'a', phase: 'conflict', theirs: { hash: 'c'.repeat(64), text: 'x' } } })
    expect(editDraft('s1', 'tab')?.state.theirs?.text).toBe('x')
    expect(requestLeave('s1', () => left++)).toBe(true)
    answerLeave(false)
    expect([left, hasUnsaved('s1')]).toEqual([0, true])
    expect(requestLeave('s1', () => left++)).toBe(true)
    answerLeave(true)
    expect([left, hasUnsaved('s1'), editDraft('s1', 'tab')]).toEqual([1, false, undefined])
  })

  it('reclaims clean editors only after their session tabs have been evicted', () => {
    const base = { file, text: 'original', hash: 'a'.repeat(64) }
    const latest = { text: 'updated', hash: 'b'.repeat(64) }
    setEditDraft('retained', 'tab', { ...base, state: { draft: base.text, phase: 'editing' } })
    setEditDraft('evicted', 'clean', { ...base, state: { draft: latest.text, base: latest, phase: 'editing' } })
    setEditDraft('evicted', 'dirty', { ...base, state: { draft: base.text, base: latest, phase: 'editing' } })
    setEditDraft('evicted', 'pending', { ...base, state: { draft: base.text, phase: 'unknown' } })
    retainOpenEditors(new Set(['retained']))
    expect(editDraft('retained', 'tab')).toBeDefined()
    expect(editDraft('evicted', 'clean')).toBeUndefined()
    expect(editDraft('evicted', 'dirty')).toBeDefined()
    expect(editDraft('evicted', 'pending')).toBeDefined()
    for (const key of ['dirty', 'pending']) setEditDraft('evicted', key, undefined)
    setEditDraft('retained', 'tab', undefined)
  })

  it('closes a tab with unsaved text only after asking, and takes a clean draft with the tab', () => {
    const base = { file, text: 'a', hash: 'b'.repeat(64) }
    setEditDraft('s2', 'clean', { ...base, state: { draft: 'a', phase: 'editing' } })
    let closed = 0
    expect(requestDrop('s2', ['clean'], () => closed++)).toBe(false)
    expect(editDraft('s2', 'clean')).toBeUndefined()
    setEditDraft('s2', 'dirty', { ...base, state: { draft: 'changed', phase: 'editing' } })
    setEditDraft('s2', 'other', { ...base, state: { draft: 'changed too', phase: 'editing' } })
    expect(requestDrop('s2', ['dirty'], () => closed++)).toBe(true)
    answerLeave(false)
    expect([closed, editDraft('s2', 'dirty')?.state.draft]).toEqual([0, 'changed'])
    expect(requestDrop('s2', ['dirty'], () => closed++)).toBe(true)
    answerLeave(true)
    // Only that file's draft goes; the session's other editor stays.
    expect([closed, editDraft('s2', 'dirty'), editDraft('s2', 'other')?.state.draft]).toEqual([1, undefined, 'changed too'])
  })

  it('makes room in a full strip with the oldest tab that has no editor, and asks when every tab has one', () => {
    const tabs: FileTab[] = Array.from({ length: 6 }, (_, index) => ({
      id: `t${index}`,
      target: { kind: 'session', sessionId: 's', reference: `${index}.txt` } as FileTab['target'],
    }))
    expect(eviction(tabs.slice(0, 5), () => true)).toBeUndefined()
    expect(eviction(tabs, tab => tab.id === 't0' || tab.id === 't1')).toEqual({ id: 't2', ask: false })
    expect(eviction(tabs, () => true)).toEqual({ id: 't0', ask: true })
  })

  it('finds mixed line endings across the whole file, as the Host does', () => {
    const late = new TextEncoder().encode(`${'a\n'.repeat(40_000)}b\r\n`)
    expect(mixedLineEndings(late)).toBe(true)
    expect(mixedLineEndings(new TextEncoder().encode('a\r\nb\r\n'))).toBe(false)
    expect(decodeEditable(late)).toBeDefined()
  })
})
