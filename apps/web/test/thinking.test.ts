import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReasoningContent } from '../src/MessageContent.tsx'
import { ThinkingRow } from '../src/components/MessageRow.tsx'
import { reasoningSections } from '../src/conversation.ts'

const thought = (text: string) => renderToStaticMarkup(createElement(ReasoningContent, { text }))
const TWO = '**Checking browser and environment**\n\nI look at `AGENTS.md` first.\n\n**Planning the page**\n\n- core concepts\n- commands'

describe('reasoning sections', () => {
  it('splits a titled thought at its title lines and leaves an untitled one exactly as written', () => {
    expect(reasoningSections(TWO)).toEqual([
      { title: 'Checking browser and environment', body: 'I look at `AGENTS.md` first.' },
      { title: 'Planning the page', body: '- core concepts\n- commands' },
    ])
    expect(reasoningSections('  just thinking\n\nstill **thinking** here  ')).toEqual([
      { body: '  just thinking\n\nstill **thinking** here  ' },
    ])
    expect(reasoningSections('')).toEqual([])
    expect(reasoningSections('**', true)).toEqual([])
    // Words before the first title keep their place; a bold phrase inside a paragraph is no title.
    expect(reasoningSections('intro\n\n**Title**\n\nbody\n**not a title**')).toEqual([
      { body: 'intro' },
      { title: 'Title', body: 'body\n**not a title**' },
    ])
    // A title with nothing under it yet is still the section the thought is in.
    expect(reasoningSections('**One**\n\ntext\n\n**Two**')).toEqual([
      { title: 'One', body: 'text' },
      { title: 'Two', body: '' },
    ])
  })

  it('never shows a title that is still arriving', () => {
    for (const cut of [2, 3, 10, TWO.indexOf('**Planning') + 2, TWO.indexOf('**Planning') + 12, TWO.indexOf(' the page**') + 10]) {
      const sections = reasoningSections(TWO.slice(0, cut), true)
      for (const section of sections) {
        expect(section.body).not.toContain('**')
        expect(section.title ?? '').not.toContain('*')
      }
    }
    // Once whole, it is the current title.
    expect(reasoningSections('**One**\n\ntext\n\n**Two**', true).at(-1)).toEqual({ title: 'Two', body: '' })
    expect(reasoningSections('**One**\n\ntext\n\n**Tw', true)).toEqual([{ title: 'One', body: 'text' }])
  })
})

describe('reasoning Markdown', () => {
  it('draws emphasis, inline code, lists and paragraphs', () => {
    const html = thought('I **must** check `a.ts` *first*.\n\n- one\n- two\n\n1. first\n2. second')
    expect(html).toContain('<strong>must</strong>')
    expect(html).toContain('<code>a.ts</code>')
    expect(html).toContain('<em>first</em>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<ol>')
    expect(html).not.toContain('**')
  })

  it('reads links, images, headings, quotes, code blocks, tables and HTML as the text they were written with', () => {
    const source = [
      'See [the docs](https://example.com/a) and ![shot](https://example.com/x.png) and <https://example.com/auto>.',
      '# Heading',
      '> quoted',
      '```js\nalert(1)\n```',
      '| a | b |\n| - | - |\n| 1 | 2 |',
      '<script>alert(1)</script>',
      '<img src="x" onerror="alert(2)">',
      'inline <b onclick="x()">tag</b> and https://example.com/bare and ~~gone~~ and $x^2$',
      '[ref]: https://example.com/ref',
      '---',
    ].join('\n\n')
    const html = thought(source)
    expect(html).not.toMatch(/<(a|img|h1|blockquote|pre|table|script|b|del|hr|iframe)[\s>]/iu)
    expect(html).not.toMatch(/<[^>]*\s(?:href|src|onclick|onerror)=/iu)
    for (const kept of [
      '[the docs](https://example.com/a)',
      '![shot](https://example.com/x.png)',
      '&lt;https://example.com/auto&gt;',
      '# Heading',
      '&gt; quoted',
      'alert(1)',
      '| a | b |',
      '&lt;script&gt;alert(1)&lt;/script&gt;',
      '&lt;img src=&quot;x&quot; onerror=&quot;alert(2)&quot;&gt;',
      '&lt;b onclick=&quot;x()&quot;&gt;tag&lt;/b&gt;',
      'https://example.com/bare',
      '~~gone~~',
      '$x^2$',
      '[ref]: https://example.com/ref',
    ])
      expect(html).toContain(kept)
  })

  it('shows text with hidden characters plain, with each one marked', () => {
    const html = thought('**safe**‮evil')
    expect(html).toContain('class="reasoning-text"')
    expect(html).toContain('hidden-char')
    expect(html).not.toContain('<strong>')
  })

  it('shows a thought that nests too deeply as plain text', () => {
    const html = thought(`${'> '.repeat(400)}deep`)
    expect(html).toContain('class="reasoning-text"')
  })
})

describe('the thinking row', () => {
  it('names the current title on the live line and shows no unfinished mark while the thought arrives', () => {
    const text = `${TWO}\n\nThen **write the pa`
    for (let cut = 1; cut <= text.length; cut++) {
      const html = renderToStaticMarkup(createElement(ThinkingRow, { text: text.slice(0, cut), live: true, streaming: true }))
      expect(html).toContain('思考中')
      expect(html).not.toContain('**')
      expect(html).not.toContain('`')
    }
    const html = renderToStaticMarkup(createElement(ThinkingRow, { text, live: true, streaming: true }))
    expect(html).toContain('<span class="thinking-title">Planning the page</span>')
    expect(html).toContain('<p class="reasoning-heading">Checking browser and environment</p>')
    expect(html).toContain('<code>AGENTS.md</code>')
    expect(html).toContain('<strong>write the pa</strong>')
  })

  it('folds to the time it took, without a title, and parses nothing while folded', () => {
    const html = renderToStaticMarkup(createElement(ThinkingRow, { text: TWO, live: false, streaming: false, reasoningMs: 14_000 }))
    expect(html).toContain('思考了 14 秒')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('thinking-title')
    expect(html).not.toContain('reasoning-content')
    // The words stay in the document for the page's find.
    expect(html).toContain('<p class="reasoning-heading">Planning the page</p>')
  })

  it('leaves a thought without titles as one body', () => {
    const html = renderToStaticMarkup(createElement(ThinkingRow, { text: 'plain thinking', live: true, streaming: true }))
    expect(html).not.toContain('thinking-title')
    expect(html).not.toContain('reasoning-heading')
    expect(html).toContain('<div class="reasoning-content"><p>plain thinking</p></div>')
  })
})
