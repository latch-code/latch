import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FileOutputs } from '../src/components/FileOutputs.tsx'
describe('observed files presentation', () => {
  it('leaves empty observations quiet and describes missing coverage without implying Agent attribution', () => {
    expect(renderToStaticMarkup(createElement(FileOutputs, { files: [], pending: true }))).toBe('')
    const html = renderToStaticMarkup(createElement(FileOutputs, { files: [], unavailable: true, truncated: true }))
    expect(html).toContain('运行期间有变化的文件')
    expect(html).toContain('未能完整观察')
    expect(html).toContain('只记录了部分变化')
  })
  it('bounds the collapsed list, preserves escaped relative names and shows deletion without an open control', () => {
    const html = renderToStaticMarkup(
      createElement(FileOutputs, {
        files: [
          { root: 'main', path: '<report>.md', change: 'deleted' },
          ...Array.from({ length: 6 }, (_, i) => ({ root: 'other', path: `src/file-${i}.ts`, change: 'modified' as const, size: 2048 })),
        ],
        pending: true,
      }),
    )
    expect(html).toContain('&lt;report&gt;.md')
    expect(html).toContain('已删除')
    expect(html).toContain('正在核对')
    expect(html).toContain('2 KB')
    expect(html).toContain('查看全部 7 个文件')
    expect(html).not.toContain('src/file-5.ts')
    expect(html).not.toContain('<a ')
  })
})
