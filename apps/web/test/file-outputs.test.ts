import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OutputNotes, ProducedFiles } from '../src/components/FileOutputs.tsx'
describe('produced files', () => {
  it('draws nothing without documents, and says what the watch could not vouch for without implying Agent attribution', () => {
    expect(renderToStaticMarkup(createElement(ProducedFiles, { files: [] }))).toBe('')
    expect(renderToStaticMarkup(createElement(OutputNotes, {}))).toBe('')
    const html = renderToStaticMarkup(createElement(OutputNotes, { unavailable: true, truncated: true }))
    // A short label in view; what could not be vouched for is behind its ⓘ.
    expect(html).toContain('记录不完整')
    expect(html).toContain('aria-label="说明"')
  })
  it('names each document by its file name, escapes it, and has no link', () => {
    const html = renderToStaticMarkup(
      createElement(ProducedFiles, {
        files: [
          { root: 'main', path: 'out/<report>.pptx', change: 'created', kind: 'pptx', size: 2048 },
          { root: 'main', path: 'out/data.xlsx', change: 'created', kind: 'xlsx' },
        ],
      }),
    )
    expect(html).toContain('生成了 2 个文件')
    expect(html).toContain('&lt;report&gt;.pptx')
    expect(html).toContain('2 KB')
    expect(html).not.toContain('<a ')
  })
})
