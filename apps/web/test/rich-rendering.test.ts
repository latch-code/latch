import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkMath from 'remark-math'
import { MessageContent, plainTextNote } from '../src/MessageContent.tsx'
import { SyntaxLine } from '../src/preview/HighlightedCode.tsx'
import { TextPreview } from '../src/preview/TextPreview.tsx'
import { canHighlight, isSyntaxLines, languageForPath } from '../src/preview/highlight-protocol.ts'
import { normalizeMathDelimiters } from '../src/preview/math.ts'
import { isSafeDiagramSvg, validDiagramSource } from '../src/preview/diagram-svg.ts'

vi.mock('react-markdown', { spy: true })

const markdown = vi.mocked(Markdown)

describe('math syntax in replies', () => {
  it('renders a dollar-free reply exactly as with math registered', async () => {
    const text = [
      '普通文字 &dollar;，和 [无效跳转](javascript:alert%281%29)。',
      '| 检查 | 结果 |\n| --- | --- |\n| 内容 | 正常 |',
      '```ts\nconst value = 1 // 看得见的控制符：\u202E\n```',
      '<script>不执行</script>',
    ].join('\n\n')
    markdown.mockClear()
    const actual = renderToStaticMarkup(createElement(MessageContent, { text }))
    expect(markdown.mock.calls).toHaveLength(1)
    const [options] = markdown.mock.calls[0]!
    const [gfm, ...guards] = options.remarkPlugins!
    expect(guards).not.toContain(remarkMath)
    const { default: parse } = await vi.importActual<typeof import('react-markdown')>('react-markdown')
    expect(renderToStaticMarkup(parse(options))).toBe(
      renderToStaticMarkup(parse({ ...options, remarkPlugins: [gfm!, remarkMath, ...guards] })),
    )
    expect(actual).toContain('<table>')
    expect(actual).toContain('const value = 1')
    expect(actual).toContain('&lt;script&gt;')
    expect(actual).toContain('\\u{202E}')
    expect(actual).not.toContain('href="javascript:')
  })

  it.each([
    ['价格 $5。', '价格 $5。'],
    ['先保留 \\$x\\$。', '$x$'],
    ['内联 \\(x^2\\)。', 'class="message-math"'],
    ['\\[x+y\\]', 'class="message-math is-display"'],
  ])('keeps the same parser for %s', (text, visible) => {
    markdown.mockClear()
    expect(renderToStaticMarkup(createElement(MessageContent, { text }))).toContain(visible)
    expect(markdown.mock.calls[0]?.[0].remarkPlugins).toContain(remarkMath)
  })

  it('uses the full math path in its own live block and when the reply settles', () => {
    const prefix = '`fixed`\n\n| 检查 | 结果 |\n| --- | --- |\n| 内容 | 正常 |\n\n'
    const render = (text: string, streaming: boolean) => renderToStaticMarkup(createElement(MessageContent, { text, streaming }))
    markdown.mockClear()
    expect(render(prefix + '开始推导', true)).not.toContain('class="message-math"')
    expect(markdown.mock.calls.every(([options]) => !options.remarkPlugins?.includes(remarkMath))).toBe(true)
    const text = prefix + '开始推导 \\(x+y\\)。'
    markdown.mockClear()
    const live = render(text, true)
    expect(markdown.mock.calls.map(([options]) => options.remarkPlugins?.includes(remarkMath))).toEqual([false, false, true])
    expect(live).toContain('class="message-math"')
    markdown.mockClear()
    const settled = render(text, false)
    expect(markdown.mock.calls.map(([options]) => options.remarkPlugins?.includes(remarkMath))).toEqual([true])
    expect(live.replace(' aria-busy="true"', '')).toBe(settled)
  })

  it('still shows the original reply as inert text if parsing fails', () => {
    markdown.mockImplementationOnce(() => {
      throw new Error('Fixture parser failure')
    })
    const actual = renderToStaticMarkup(createElement(MessageContent, { text: '<script>原文</script>\u202E' }))
    expect(actual).toContain(plainTextNote())
    expect(actual).toContain('&lt;script&gt;原文&lt;/script&gt;')
    expect(actual).toContain('\\u{202E}')
    expect(actual).not.toContain('<script>')
  })
})

describe('the file preview', () => {
  it('splits CRLF text into lines without marking the line endings', () => {
    const html = renderToStaticMarkup(createElement(TextPreview, { text: 'one\r\ntwo\r\n', path: 'a.txt' }))
    expect(html).toContain('one')
    expect(html).toContain('two')
    expect(html).not.toContain('u{000D}')
    expect(html).not.toContain('\r')
  })
  it('still marks a carriage return inside a line', () => {
    const html = renderToStaticMarkup(createElement(TextPreview, { text: 'one\rtwo', path: 'a.txt' }))
    expect(html).toContain('u{000D}')
  })
})

describe('bounded rich rendering', () => {
  it('retains original text and rejects invented roles, missing characters and large highlight jobs', () => {
    expect(isSyntaxLines([[{ text: 'let x', role: 'keyword' }], [{ text: '', role: 'plain' }]], 'let x\n')).toBe(true)
    expect(isSyntaxLines([[{ text: 'let x', role: 'red' }]], 'let x')).toBe(false)
    expect(isSyntaxLines([[{ text: 'x', role: 'plain' }]], 'let x')).toBe(false)
    expect(canHighlight('x'.repeat(200_001))).toBe(false)
    expect(canHighlight('x'.repeat(1001))).toBe(true)
    expect(canHighlight('x\n'.repeat(100_001))).toBe(false)
  })
  it('takes a language only from a file extension it knows', () => {
    expect(languageForPath('src/main.rs')).toBe('rust')
    expect(languageForPath('C:\\work\\page.HTML')).toBe('html')
    expect(languageForPath('Dockerfile')).toBe('dockerfile')
    for (const path of ['go', 'src/constructor', 'a.constructor', 'notes.unknown', '']) expect(languageForPath(path), path).toBeUndefined()
  })
  it('never lets a token boundary change which characters are marked as hidden', () => {
    const line = (text: string, ...cuts: string[]) =>
      renderToStaticMarkup(createElement(SyntaxLine, { text, tokens: cuts.map(cut => ({ text: cut, role: 'keyword' as const })) }))
    const marks = '\u0301'.repeat(3)
    // Six marks in a row are marked from the fifth on; cut in half neither piece alone would be.
    expect(line(`a${marks}${marks}`, `a${marks}`, marks)).toContain('hidden-char')
    expect(line(`a${marks}${marks}`, `a${marks}`, marks)).not.toContain('syn-keyword')
    expect(line('let\u202ex', 'let', '\u202ex')).toContain('\\u{202E}')
    expect(line('let x', 'let', ' x')).toContain('<span class="syn-keyword">let</span>')
  })
  it('accepts escaped TeX delimiters outside code and keeps currency and unclosed source readable', () => {
    expect(normalizeMathDelimiters('\\(x^2\\) `\\(code\\)`\n```tex\n\\(raw\\)\n```')).toBe('$x^2$ `\\(code\\)`\n```tex\n\\(raw\\)\n```')
    const html = renderToStaticMarkup(createElement(MessageContent, { text: 'Price $5 和 $10. Math $x^2$.' }))
    expect(html).toContain('Price $5 和 $10.')
    expect(html).toContain('class="message-math"')
  })
  it('accepts self-contained SVG and refuses active, external or ambiguous SVG content', () => {
    const safe =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><marker id="tip"><path d="M0 0L1 1"/></marker></defs><path style="stroke:#333;marker-end:url(#tip)" d="M0 0L10 10"/></svg>'
    expect(isSafeDiagramSvg(safe)).toBe(true)
    for (const payload of [
      '<script/>',
      '<foreignObject/>',
      '<image href="https://invalid/x"/>',
      '<path onclick="bad()"/>',
      '<use href="https://invalid/#x"/>',
      '<style>@import "https://invalid/x";</style>',
      '<path style="fill:url(https://invalid/x)"/>',
      '<animate attributeName="href"/>',
    ])
      expect(isSafeDiagramSvg(`<svg>${payload}</svg>`), payload).toBe(false)
    expect(isSafeDiagramSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]><svg>&x;</svg>')).toBe(false)
    expect(validDiagramSource('%%{init:{"securityLevel":"loose"}}%%\ngraph TD;A-->B')).toBe(false)
    expect(validDiagramSource('---\nconfig: {}\n---\ngraph TD;A-->B')).toBe(false)
    expect(validDiagramSource('graph TD;A-->B')).toBe(true)
    expect(isSafeDiagramSvg('<svg><style>path{fill:u&#114;l(https://invalid/x)}</style></svg>')).toBe(false)
    expect(normalizeMathDelimiters('\\[x\n+y\\]')).toBe('\n$$\nx\n+y\n$$\n')
  })
})
