import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DiffView, type DiffViewFile } from '../src/components/DiffView.tsx'
import { diffLines } from '../src/diff.ts'

const numbered = (count: number, change?: (index: number) => string | undefined) =>
  Array.from({ length: count }, (_, index) => change?.(index + 1) ?? `line ${index + 1}`).join('\n') + '\n'

const edit: DiffViewFile = {
  path: 'src/app.ts',
  oldText: numbered(60, index => (index === 30 ? 'const value = loadKey(name)' : undefined)),
  newText: numbered(60, index => (index === 30 ? 'const value = loadApiKey(name)' : undefined)),
  previous: 'text',
}
const created: DiffViewFile = { path: 'src/new.ts', newText: numbered(20), previous: 'none' }
const deleted: DiffViewFile = { path: 'src/old.ts', oldText: numbered(5), newText: '', previous: 'text', deleted: true }
const html = (props: Parameters<typeof DiffView>[0]) => renderToStaticMarkup(createElement(DiffView, props))
const open = { initiallyOpen: true }

describe('DiffView modes', () => {
  it('keeps every hunk under its header by default, unmarked, as a proposal must show it', () => {
    const out = html({ diffs: [edit], ...open })
    expect(out).toContain('@@ -27,7 +27,7 @@')
    expect(out).not.toContain('diff-word')
    expect(out).not.toContain('diff-gap')
    expect(out).toContain('+1')
  })

  it('reviews with bands of unchanged lines and marked words in full mode', () => {
    const out = html({ diffs: [edit], mode: 'full', ...open })
    expect(out).not.toContain('@@')
    expect(out).toContain('26 行未改动')
    expect(out).toContain('27 行未改动')
    expect(out).toContain('<span class="diff-word">')
    expect(out).toContain('src/')
  })

  it('draws a new or deleted file as the file itself, and never splits it', () => {
    const out = html({ diffs: [created, deleted], mode: 'full', layout: 'split', ...open })
    expect(out).toContain('新文件 · 20 行')
    expect(out).toContain('已删除 · 5 行')
    expect(out).toContain('data-whole="new"')
    expect(out).toContain('data-whole="deleted"')
    expect(out).not.toContain('data-layout="split"')
    expect(out).not.toContain('diff-split')
  })

  it('only calls a file deleted when its source says so', () => {
    const emptied: DiffViewFile = { path: 'src/emptied.ts', oldText: 'a\n', newText: '', previous: 'text' }
    const out = html({ diffs: [emptied], mode: 'full', ...open })
    expect(out).not.toContain('已删除')
    expect(out).not.toContain('data-whole')
  })

  it('splits a modified file when asked', () => {
    const out = html({ diffs: [edit], mode: 'full', layout: 'split', ...open })
    expect(out).toContain('data-layout="split"')
    expect(out).toContain('修改前')
  })

  it('says a rename and a binary file in words', () => {
    const out = html({
      diffs: [{ path: 'b.png', newText: '', previous: 'unavailable', binary: true, renamedFrom: 'a.png' }],
      mode: 'full',
      ...open,
    })
    expect(out).toContain('重命名自 a.png')
    expect(out).toContain('二进制文件，没有可比较的文字')
  })

  it('previews 12 changed lines at most, with no head and what is left in its foot', () => {
    const big: DiffViewFile = { path: 'a.ts', oldText: numbered(40), newText: numbered(40, index => `changed ${index}`), previous: 'text' }
    const out = html({ diffs: [big], mode: 'compact', fileActions: () => createElement('button', null, '在变更中打开') })
    expect(out).not.toContain('@@')
    expect(out).not.toContain('diff-file-header')
    expect(out.match(/diff-line diff-(add|remove)/gu)?.length).toBe(12)
    expect(out).toContain('还有 68 行改动')
    expect(out).toContain('在变更中打开')
  })

  it('previews the first 8 lines of a new file', () => {
    const out = html({ diffs: [created], mode: 'compact' })
    expect(out.match(/diff-line diff-add/gu)?.length).toBe(8)
    expect(out).toContain('还有 12 行')
    expect(out).not.toContain('还有 12 行改动')
  })

  it('fills the gutter and annotation slots only when given, and head actions beside the header, not inside it', () => {
    expect(html({ diffs: [edit], mode: 'full', ...open })).not.toContain('diff-gutter')
    const out = html({
      diffs: [edit],
      mode: 'full',
      ...open,
      gutter: () => createElement('button', null, '添加评论'),
      annotation: line => (line.newLine === 30 ? createElement('p', null, '这里') : null),
      fileActions: () => createElement('button', null, '打开文件'),
    })
    expect(out).toContain('diff-gutter')
    expect(out.match(/diff-annotation/gu)?.length).toBe(1)
    expect(/<button[^>]*diff-file-header[^>]*>(?:(?!<\/button>).)*打开文件/u.test(out)).toBe(false)
  })

  it('never lets a marked line carry a raw hidden character', () => {
    const tricky: DiffViewFile = { path: 'a.ts', oldText: 'const a = 1\n', newText: 'const a = 1‮2\n', previous: 'text' }
    const out = html({ diffs: [tricky], mode: 'full', ...open })
    expect(out).not.toContain('‮')
    expect(out).toContain('hidden-char')
    expect(out).not.toContain('diff-word')
  })
})

describe('DiffView says what it knows', () => {
  const binary: DiffViewFile = { path: 'logo.png', newText: '', previous: 'unavailable', binary: true }

  it('calls a binary file binary in the compact preview, not unchanged', () => {
    const out = html({ diffs: [binary], mode: 'compact' })
    expect(out).toContain('二进制文件')
    expect(out).not.toContain('内容没有变化')
  })

  it('keeps the warning about previous content it cannot see in the compact preview', () => {
    expect(html({ diffs: [{ path: 'a.ts', newText: 'a\n' }], mode: 'compact' })).toContain('执行端没有说明原内容')
    expect(html({ diffs: [{ path: 'a.ts', newText: 'a\n', previous: 'unavailable' }], mode: 'compact' })).toContain('该文件已存在')
    expect(html({ diffs: [{ path: 'a.ts', newText: 'a\n', previous: 'none' }], mode: 'compact' })).not.toContain('diff-note')
  })

  it('gives a new or deleted binary file no line count', () => {
    const out = html({ diffs: [{ ...binary, previous: 'none' }], mode: 'full', ...open })
    expect(out).toContain('新文件')
    expect(out).not.toContain('0 行')
  })

  it('counts only the lines left in the bar under a long diff', () => {
    const block = (name: string) => Array.from({ length: 200 }, (_, index) => `${name} ${index}`)
    const spacer = (at: number) => Array.from({ length: 20 }, (_, index) => `same ${at}.${index}`)
    const text = (name: string) =>
      [...block(`${name} a`), ...spacer(1), ...block(`${name} b`), ...spacer(2), ...block(`${name} c`)].join('\n') + '\n'
    const long: DiffViewFile = { path: 'long.ts', oldText: text('old'), newText: text('new'), previous: 'text' }
    const lines = diffLines(long.oldText, long.newText).hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
    expect(html({ diffs: [long], mode: 'full', ...open })).toContain(`展开其余 ${lines - 400} 行`)
    // The first hunk's header takes a row of the 400 here, and that hunk alone fills the rest.
    expect(html({ diffs: [long], ...open })).toContain(`展开其余 ${lines - 399} 行`)
  })
})

describe('DiffView annotations', () => {
  it('keeps the two sides of a split in line by setting a note across both', () => {
    const out = html({
      diffs: [edit],
      mode: 'full',
      layout: 'split',
      ...open,
      annotation: line => (line.kind === 'add' ? createElement('b', null, 'NOTE') : null),
    })
    expect(out.match(/class="diff-annotation"/gu)).toHaveLength(1)
    const [before, after] = out.split('<div class="diff-annotation">')
    // Everything above the note closes both sides, so their rows pair up; the rest of the hunk starts two sides anew.
    expect(before!.match(/class="diff-split-side"/gu)).toHaveLength(2)
    expect(before!.endsWith('</div></div></div>')).toBe(true)
    expect(after!.match(/class="diff-split-side"/gu)).toHaveLength(2)
  })

  it('keeps a note on a removed line in a split', () => {
    const removal: DiffViewFile = { path: 'a.ts', oldText: 'a\nb\nc\n', newText: 'a\nc\n', previous: 'text' }
    const out = html({
      diffs: [removal],
      mode: 'full',
      layout: 'split',
      ...open,
      annotation: line => (line.kind === 'remove' ? createElement('b', null, 'NOTE') : null),
    })
    expect(out).toContain('NOTE')
  })
})
