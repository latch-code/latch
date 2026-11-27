import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { FileChange } from '@latch/protocol'
import { OutputNotes, ProducedFiles } from '../src/components/FileOutputs.tsx'
import { OutputsOpenContext } from '../src/conversation/changesLink.ts'
import { producedFiles, turnSummary } from '../src/conversation/turnChanges.ts'

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
    expect(html).toContain('aria-label="显示文件" aria-expanded="false"')
    expect(html).toContain('data-state="closed"')
    expect(html).toContain('&lt;report&gt;.pptx')
    expect(html).toContain('2 KB')
    expect(html).not.toContain('<a ')
  })
  it('excludes gitignored created files from changed-file fallback while surfacing them in producedFiles and offering panel cleanup', () => {
    const outputs: FileChange[] = [
      { root: 'main', path: 'src/view.tsx', change: 'created', kind: 'code', size: 512 },
      { root: 'main', path: 'test-results/shot-1.png', change: 'created', kind: 'image', size: 4096, gitIgnored: true },
      { root: 'main', path: 'test-results/report.json', change: 'modified', fresh: true, kind: 'code', size: 256, gitIgnored: true },
    ]
    expect(producedFiles(outputs).map(item => item.path)).toEqual(['test-results/shot-1.png', 'test-results/report.json'])
    const summary = turnSummary({ key: 't1', replies: [] }, undefined, outputs)
    expect(summary.files.map(item => item.path)).toEqual(['src/view.tsx'])

    const openOutputs = vi.fn()
    const html = renderToStaticMarkup(
      createElement(
        OutputsOpenContext.Provider,
        { value: openOutputs },
        createElement(ProducedFiles, {
          files: producedFiles(outputs),
          turnId: 'run-1',
          messageId: 'msg-1',
        }),
      ),
    )
    expect(html).toContain('生成了 2 个文件')
    expect(html).toContain('临时产物')
    expect(html).toContain('查看与清理')
  })
})
