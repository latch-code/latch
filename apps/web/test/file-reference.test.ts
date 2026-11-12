import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { FileImage, FileSpreadsheet, Presentation } from 'lucide-react'
import { FileGlyph, FolderGlyph, PageGlyph } from '@latch/ui'
import { MessageContent } from '../src/MessageContent.tsx'
import { FileSession } from '../src/components/FileChip.tsx'
import { FILE_COPY, fileNote, fileRefusalText } from '../src/core/securityCopy.ts'
import { shellFiles } from '../src/core/shell.ts'
import { absoluteReference, linkTarget, namesPath, referenceIcon, referenceName, referenceText, splitPath } from '../src/fileReference.ts'

function render(text: string, sessionId?: string) {
  const content = createElement(MessageContent, { text })
  return renderToStaticMarkup(
    sessionId ? createElement(FileSession.Provider, { value: { id: sessionId, folder: '/Users/me/project' } }, content) : content,
  )
}

/** A desktop shell in the page's global scope, as the Electron preload puts it there. */
function desktopShell(files: Record<string, unknown> | undefined) {
  Reflect.set(globalThis, 'window', { latchShell: { kind: 'electron', devMode: true, platform: 'darwin', ...(files ? { files } : {}) } })
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('link targets in replies', () => {
  it.each([
    ['https://example.com/a', { kind: 'web' }],
    ['HTTP://example.com', { kind: 'web' }],
    ['mailto:team@example.com', { kind: 'mail' }],
    ['report.md', { kind: 'path', path: 'report.md' }],
    ['./out/deck.pptx', { kind: 'path', path: './out/deck.pptx' }],
    ['../notes/plan.md', { kind: 'path', path: '../notes/plan.md' }],
    ['/Users/me/project/data.xlsx', { kind: 'path', path: '/Users/me/project/data.xlsx' }],
    ['file:///Users/me/My%20Deck.pptx', { kind: 'path', path: '/Users/me/My Deck.pptx' }],
    ['file://localhost/tmp/a.txt', { kind: 'path', path: '/tmp/a.txt' }],
    ['file:///tmp/a.ts#L12', { kind: 'path', path: '/tmp/a.ts#L12' }],
    ['%E6%8A%A5%E5%91%8A.md', { kind: 'path', path: '报告.md' }],
    ['src/app.ts:12', { kind: 'path', path: 'src/app.ts:12' }],
    // A file name with a line number only looks like a scheme.
    ['report.md:12', { kind: 'path', path: 'report.md:12' }],
    ['main.py:42:5', { kind: 'path', path: 'main.py:42:5' }],
    ['Makefile:12', { kind: 'path', path: 'Makefile:12' }],
    ['www.example.com', { kind: 'text' }],
    ['tel:123', { kind: 'text' }],
    ['javascript:1', { kind: 'text' }],
    ['README.md#install', { kind: 'path', path: 'README.md' }],
    ['src/app.ts#L7', { kind: 'path', path: 'src/app.ts#L7' }],
    ['notes.md?raw=1', { kind: 'path', path: 'notes.md' }],
    ['#result', { kind: 'text' }],
    ['?q=1', { kind: 'text' }],
    ['file://example.com/etc/hosts', { kind: 'text' }],
    ['javascript:alert(1)', { kind: 'text' }],
    ['C:/Users/me/a.md', { kind: 'text' }],
    ['//example.com/x', { kind: 'text' }],
  ])('%s', (href, expected) => {
    expect(linkTarget(href, 'r1-')).toEqual(expected)
  })

  it("treats only this reply's own footnotes as anchors", () => {
    expect(linkTarget('#r1-fn-1', 'r1-')).toEqual({ kind: 'anchor' })
    expect(linkTarget('#r1-fn-1', '')).toEqual({ kind: 'text' })
    expect(linkTarget('#pair=abc', 'r1-')).toEqual({ kind: 'text' })
  })

  it('refuses control characters even when escaped', () => {
    expect(referenceText('a%00b.md')).toBeUndefined()
    expect(referenceText('a%0Ab.md')).toBeUndefined()
    expect(referenceText('   ')).toBeUndefined()
    expect(referenceText('100%.md')).toBe('100%.md')
  })

  it('tells a link text that is its own path, written another way', () => {
    expect(namesPath('site/index.html', './site/index.html')).toBe(true)
    expect(namesPath('deck.pptx', '/Users/me/acme/deck.pptx')).toBe(true)
    expect(namesPath('acme/deck.pptx', '/Users/me/acme/deck.pptx')).toBe(true)
    expect(namesPath('上一版', '../archive/old.md')).toBe(false)
    expect(namesPath('deck', '/Users/me/acme/deck.pptx')).toBe(false)
  })

  it('names the file and picks its glyph by extension', () => {
    expect(referenceName('out/deck.pptx:3')).toBe('deck.pptx')
    expect(referenceName('/tmp/a.ts#L12')).toBe('a.ts')
    expect(referenceName('src/')).toBe('src')
    expect(referenceIcon('deck.pptx')).toBe(Presentation)
    expect(referenceIcon('chart.svg')).toBe(FileImage)
    expect(referenceIcon('data.CSV')).toBe(FileSpreadsheet)
    expect(referenceIcon('report.md')).toBe(FileGlyph)
    expect(referenceIcon('src/')).toBe(FolderGlyph)
    expect(referenceIcon('Makefile')).toBe(PageGlyph)
  })
})

describe('path chips', () => {
  it('render a file name with a line number as a chip, never as text or a link', () => {
    const html = render('见 [main.py:42](main.py:42) 与 [report.md:12](report.md:12)，参考 [example.com](www.example.com)', 'task-1')
    expect(html).not.toContain('href=')
    expect(html.match(/data-file-chip=""/g)).toHaveLength(2)
    expect(html).toContain('main.py:42</span>')
    expect(html).toContain('<span>example.com</span>')
  })

  it('render every file reference without an href, as a menu that copies its path and says where to open it', () => {
    const html = render(
      [
        '- [report.md](report.md)：复盘文档',
        '- [复盘](../notes/plan.md)',
        '- [deck.pptx](file:///Users/me/project/deck.pptx)',
        '- [](/Users/me/project/data.xlsx)',
        '- ![趋势图](chart.svg)',
        '- ![](out/q1.png)',
        '- [bad](javascript:alert%281%29)',
      ].join('\n'),
      'task-1',
    )
    expect(html).not.toMatch(/href="(?!https?:|mailto:)/u)
    expect(html.match(/data-file-chip=""/g)).toHaveLength(6)
    // The label is the link's text; a path or file name is set in the mono face, words are not.
    expect(html).toContain('<span class="file-chip-text" data-mono="">report.md</span>')
    expect(html).toContain('<span class="file-chip-text">复盘</span>')
    expect(html).toContain('aria-label="/Users/me/project/deck.pptx"')
    // A long path gives way in its folders and keeps the file name whole.
    expect(html).toContain(
      '<span class="file-chip-text file-chip-path" data-mono=""><span class="file-chip-folders">/Users/me/project/</span><span class="file-chip-name">data.xlsx</span></span>',
    )
    // An image reads its description first and its file name after it, quieter.
    expect(html).toContain('<span class="file-chip-text">趋势图</span><span class="file-chip-meta" data-mono="">chart.svg</span>')
    expect(html).toContain('aria-label="图片「趋势图」：chart.svg"')
    expect(html).toContain('<span class="file-chip-folders">out/</span><span class="file-chip-name">q1.png</span>')
    // Every chip opens the same kind of menu: the file name, 复制路径, and where it can be opened.
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(6)
    expect(html).toContain('aria-label="文件：report.md"')
    expect(html.match(new RegExp(FILE_COPY.elsewhere(), 'gu'))).toHaveLength(6)
    expect(html).toContain('latch-glyph-lock')
    expect(html).toContain('<span>bad</span>')
  })

  it('open the desktop menu only in the desktop app, inside a session, with a shell that has every file action', () => {
    const action = () => Promise.resolve({ status: 'shown' })
    const files = { inspect: action, reveal: action, quickLook: action, open: action }
    desktopShell(files)
    expect(shellFiles()).toBe(files)
    const html = render('[deck.pptx](out/deck.pptx)', 'task-1')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="out/deck.pptx"')
    expect(html).toContain(FILE_COPY.checking)
    expect(html).not.toContain(FILE_COPY.elsewhere())
    expect(html).not.toContain('href=')
    // An older shell without file actions says a restart brings them, with the info glyph rather than the lock.
    desktopShell({ inspect: action, reveal: action })
    expect(shellFiles()).toBeNull()
    const older = render('[deck.pptx](out/deck.pptx)', 'task-1')
    expect(older).toContain(FILE_COPY.shellOutdated)
    expect(older).toContain('latch-glyph-info')
    expect(older).not.toContain('latch-glyph-lock')
  })

  it('copy the whole path on the computer that runs Latch, and split a path label before its file name', () => {
    expect(absoluteReference('report.md', '/Users/me/project')).toBe('/Users/me/project/report.md')
    expect(absoluteReference('./out/deck.pptx:3', '/Users/me/project')).toBe('/Users/me/project/out/deck.pptx')
    expect(absoluteReference('../outside.md#L2', '/Users/me/project/')).toBe('/Users/me/outside.md')
    expect(absoluteReference('site/', '/Users/me/project')).toBe('/Users/me/project/site/')
    expect(absoluteReference('/Users/me/Desktop/deck.pptx', '/Users/me/project')).toBe('/Users/me/Desktop/deck.pptx')
    expect(absoluteReference('~/Desktop/a.md', '/Users/me/project')).toBe('~/Desktop/a.md')
    expect(absoluteReference('report.md', undefined)).toBe('report.md')
    expect(splitPath('/Users/me/acme/out/deck.pptx')).toEqual(['/Users/me/acme/out/', 'deck.pptx'])
    expect(splitPath('deck.pptx')).toEqual(['', 'deck.pptx'])
    expect(splitPath('site/')).toEqual(['', 'site/'])
  })

  it('mark a refusal with the lock and a failure or a way forward without it, and give a reason with every refusal', () => {
    for (const code of ['file-secret', 'file-protected', 'file-type-refused', 'file-outside-folders', 'file-preview-unverified'])
      expect(fileNote(code).tone, code).toBe('lock')
    for (const code of ['file-missing', 'open-failed', 'busy', 'audit-unavailable', 'file-changed', 'something-new'])
      expect(fileNote(code).tone, code).toBe('alert')
    for (const code of ['file-folder', 'host-outdated']) expect(fileNote(code).tone, code).toBe('info')
    expect(fileNote('file-folder', { platform: 'darwin' }).text).toBe('这是文件夹；Latch 只在访达中显示项目的文件夹。')
    expect(fileRefusalText('file-type-refused', { name: 'slides.html', platform: 'darwin' })).toBe(
      'Latch 不直接打开：网页和 SVG 用浏览器打开时可以联网；可以在访达中显示后自己打开。',
    )
    expect(fileRefusalText('file-type-refused', { name: 'logo.SVG', platform: 'darwin' })).toContain('可以联网')
    expect(fileRefusalText('file-type-refused', { name: 'old.ppt', platform: 'darwin' })).toContain('宏')
    expect(fileRefusalText('file-type-refused', { name: 'run.command', platform: 'darwin' })).toContain('不打开程序')
    expect(fileRefusalText('file-outside-folders', { platform: 'darwin' })).toContain('在访达中按 ⇧⌘G 前往')
    expect(fileRefusalText('file-outside-folders', { platform: 'linux' })).toContain('在文件管理器中前往')
  })

  it('explain every refusal in plain words, never with the Host text', () => {
    for (const code of [
      'file-missing',
      'file-outside-folders',
      'file-folder-removed',
      'file-protected',
      'file-not-regular',
      'file-folder',
      'file-invalid',
      'file-secret',
      'file-type-refused',
      'file-preview-unverified',
      'file-content-mismatch',
      'file-changed',
      'open-failed',
      'unsupported',
      'host-outdated',
      'audit-unavailable',
    ])
      expect(fileRefusalText(code), code).toMatch(/[\u4e00-\u9fff]/u)
    expect(fileRefusalText('something-new')).toBe('没有完成，请重试。')
  })
})
