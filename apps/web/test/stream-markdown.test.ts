import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { describe, expect, it, vi } from 'vitest'
import { renderMarkdown, MessageContent } from '../src/MessageContent.tsx'
import { closeInline } from '../src/markdown/closeInline.ts'
import { splitStreamBlocks } from '../src/markdown/streamBlocks.ts'
import { createStreamingMarkdown } from '../src/markdown/renderBlocks.tsx'

const markdown = (source: string) => renderMarkdown({ children: source, remarkPlugins: [remarkGfm, remarkMath], skipHtml: true })
const html = (source: string) => renderToStaticMarkup(markdown(source))
const samples = [
  '普通中文',
  '第一段\n\n第二段',
  'a\n\nb\n\nc',
  '# 标题\n\n正文',
  '标题\n===\n\n正文',
  '标题\n---\n\n正文',
  '*斜体*',
  '**粗体**',
  '***粗斜体***',
  '_斜体_',
  '__粗体__',
  '~~删除~~',
  'a **b *c* d** e',
  '*a **b** c*',
  'a_b_c',
  'a*b*c',
  '\\*原样\\*',
  '`inline`\n\n正文',
  '``a ` b``',
  '```ts\na()\n```\n\n正文',
  '~~~ts\na()\n~~~\n\n正文',
  '````md\n```ts\na\n```\n````\n\n正文',
  '```\n\n段落\n\n```\n\n后文',
  '- a\n- b\n\n后文',
  '- a\n\n- b\n\n后文',
  '1. a\n2. b\n\n后文',
  '1. a\n\n2. b',
  '- a\n  - b\n\n后文',
  '- a\n\n  b\n\n后文',
  '- a\n\n  ```ts\n  x\n  ```\n\n后文',
  '- a\n\n    ```ts\n    x\n    ```\n\n后文',
  '- a\n\n    code\n\n后文',
  '    code\n\n    more\n\n后文',
  '> a\n>\n> b\n\n后文',
  '> a\n\nlazy',
  '- > a\n  > b\n\n后文',
  '1. > a\n\n   > b',
  '| a | b |\n| --- | --- |\n| x | y |\n\n后文',
  'a | b\n--- | ---\nx | y\n\n后文',
  '| a |\n| --- |\n| `x|y` |',
  '- [x] done\n- [ ] next\n\n后文',
  '---\n\n正文',
  '***\n\n正文',
  '[链接](https://example.com)\n\n正文',
  '[a][b]\n\n[b]: https://example.com',
  '[a][long\nname]\n\n[long\nname]: /url',
  '![图](./file.png)\n\n正文',
  '<https://example.com>\n\n正文',
  'mail@example.com\n\n正文',
  'a[^1]\n\n[^1]: note',
  '<div>\n\ntext\n\n</div>',
  '<!-- a\n\nb -->',
  '<details>\n\ntext\n\n</details>',
  'a\r\n\r\nb',
  '\uFEFF# heading\n\ntext',
  '$x$\n\n正文',
  '$$\nx\n$$\n\n正文',
  '\\[x\\]\n\n正文',
  ':::note\n\n正文\n\n:::',
  'a  \nb\n\n后文',
  'a\\\nb\n\n后文',
  '中文😀\n\n**重点**\n\n尾部',
  '*a\n\nb*',
  '**a\n\nb**',
  '``a\n\nb``',
  '[a](url\n\nrest)',
]

describe('streaming Markdown blocks', () => {
  it.each(samples)('keeps the full parser result at every prefix of %j', source => {
    for (let end = 0; end <= source.length; end++) {
      const prefix = source.slice(0, end)
      const blocks = splitStreamBlocks(prefix)
      if (blocks === null) continue
      expect(blocks.map(block => block.text).join('')).toBe(prefix)
      const split = blocks
        .map(block => html(block.text))
        .filter(Boolean)
        .join('\n')
      expect(split, `prefix ${end}: ${JSON.stringify(prefix)}`).toBe(html(prefix))
    }
  })

  it('does not freeze a trailing blank line before its following block is known', () => {
    expect(splitStreamBlocks('- first\n\n')).toHaveLength(1)
    expect(splitStreamBlocks('- first\n\n- second')).toHaveLength(1)
    expect(splitStreamBlocks('- first\n\nparagraph')).toHaveLength(2)
    expect(splitStreamBlocks('```\n\nparagraph')).toHaveLength(1)
  })

  it('memoizes a closed prefix, then parses the final unmodified document in full', () => {
    const parse = vi.fn(markdown)
    const render = createStreamingMarkdown(parse, (_source, child, index) => createElement(Fragment, { key: index }, child))
    void render('first\n\n**second', true)
    expect(parse.mock.calls.map(call => call[0])).toEqual(['first\n\n', '**second**'])
    parse.mockClear()
    void render('first\n\n**second word', true)
    expect(parse.mock.calls.map(call => call[0])).toEqual(['**second word**'])
    parse.mockClear()
    const final = 'first\n\n**second word'
    expect(renderToStaticMarkup(render(final, false))).toBe(html(final))
    expect(parse.mock.calls.map(call => call[0])).toEqual([final])
  })

  it('invalidates cached interpretations when document-wide context arrives', () => {
    const render = createStreamingMarkdown(markdown, (_source, child, index) => createElement(Fragment, { key: index }, child))
    void render('[name]\n\nparagraph', true)
    const source = '[name]\n\nparagraph\n\n[name]: https://example.com'
    expect(renderToStaticMarkup(render(source, true))).toBe(html(source))
  })
})

describe('display-only inline completion', () => {
  it.each([
    ['**重点', '**重点**'],
    ['*重点', '*重点*'],
    ['_重点', '_重点_'],
    ['__重点', '__重点__'],
    ['~~旧内容', '~~旧内容~~'],
    ['**重点 *内部', '**重点 *内部***'],
    ['`const x', '`const x`'],
    ['``a ` b', '``a ` b``'],
    ['``a`', '``a``'],
    ['[说明](https://exa', '说明'],
    ['前 [说明](', '前 说明'],
    ['下一段 **', '下一段 '],
  ])('completes %j only for display', (source, expected) => expect(closeInline(source)).toBe(expected))

  it.each([
    '**完整**',
    '*完整*',
    '***完整***',
    '_完整_',
    '__完整__',
    '~~完整~~',
    '*a **b** c*',
    '**a *b* c**',
    'a_b_c',
    'a*b*c',
    '\\*原样',
    '`*原样*`',
    '``a ` b``',
    '`[link](unfinished`',
    '```ts\n*literal',
    '![图](partial',
    '\\[文字](partial',
    '$a',
    '[a](https://example.com/a_b*c)',
    '[a](https://example.com/a_(b))',
  ])('keeps literal or complete syntax %j', source => expect(closeInline(source)).toBe(source))

  it('uses the original Markdown again when streaming ends', () => {
    const text = '**重点'
    const render = (streaming: boolean) => renderToStaticMarkup(createElement(MessageContent, { text, streaming }))
    expect(render(true)).toContain('<strong>重点</strong>')
    expect(render(false)).toContain('<p>**重点</p>')
  })

  it('previews an unfinished table header as words, preserving escaped and inline-code pipes', () => {
    expect(closeInline('| 名称 | 结果 |')).toBe('名称   结果')
    expect(closeInline('| 名称 | 结果 |\n|')).toBe('名称   结果')
    expect(closeInline('| 名称 | 结果 |\n| -')).toBe('名称   结果')
    expect(closeInline('| `a|b` | a\\|b |')).toBe('`a|b`   a\\|b')
    const table = '| 名称 | 结果 |\n| --- | --- |'
    expect(closeInline(table)).toBe(table)
  })

  it('does not flash paired markers next to Chinese punctuation at any prefix', () => {
    const source = '说明：**中文重点**，`代码`和[链接](https://example.com)。'
    for (let end = 0; end <= source.length; end++) {
      const rendered = html(closeInline(source.slice(0, end)))
      const visible = rendered.replace(/<[^>]*>/gu, '')
      expect(visible, `prefix ${end}`).not.toMatch(/\*\*|`|\]\(/u)
    }
  })

  it.each([true, false])('waits for actual diagram and display-math closing delimiters (streaming=%s)', streaming => {
    const render = (text: string) => renderToStaticMarkup(createElement(MessageContent, { text, streaming, renderFrame: () => null }))
    expect(render('```mermaid\ngraph TD\n A-->B')).not.toContain('message-diagram')
    expect(render('```mermaid\ngraph TD\n A-->B\n```')).toContain('message-diagram')
    expect(render('$$\nx^2')).not.toContain('message-math')
    expect(render('$$\nx^2\n$$')).toContain('message-math is-display')
    expect(render('$$\nx^2\n$')).not.toContain('message-math')
    expect(render('$$$$\nx^2\n$$')).not.toContain('message-math')
    expect(render('> $$\n> x^2\n> $$')).toContain('message-math is-display')
    expect(render('- item\n\n  $$\n  x^2\n  $$')).toContain('message-math is-display')
  })
})
