import { describe, expect, it } from 'vitest'
import { folderOf, highlightParts, parseContentResults, resultSummary, uncheckedNote } from '../src/preview/contentSearch.ts'

const reply = (extra: Record<string, unknown> = {}) => ({
  files: [
    {
      root: 'default',
      path: 'src/main.ts',
      name: 'main.ts',
      lines: [
        { line: 3, text: 'const needle = 1', ranges: [[6, 12]] },
        {
          line: 9,
          text: 'needle needle',
          ranges: [
            [0, 6],
            [7, 13],
          ],
          after: true,
        },
      ],
    },
  ],
  count: 2,
  scanned: 14,
  skipped: { large: 0, binary: 0 },
  ...extra,
})

describe('content search results', () => {
  it('accepts the Host answer as drawn, and nothing else', () => {
    expect(parseContentResults(reply())).toMatchObject({
      count: 2,
      files: [{ path: 'src/main.ts', lines: [{ line: 3 }, { line: 9, after: true }] }],
    })
    // A count that does not add up, a range outside the text or out of order, an absolute path, an unknown stop.
    expect(parseContentResults(reply({ count: 3 }))).toBeUndefined()
    const bad = (line: Record<string, unknown>) =>
      parseContentResults({ ...reply(), count: 1, files: [{ root: 'default', path: 'a.ts', name: 'a.ts', lines: [line] }] })
    expect(bad({ line: 1, text: 'abc', ranges: [[1, 9]] })).toBeUndefined()
    expect(
      bad({
        line: 1,
        text: 'abcdef',
        ranges: [
          [3, 4],
          [0, 1],
        ],
      }),
    ).toBeUndefined()
    expect(bad({ line: 1, text: 'abc', ranges: [[1, 1]] })).toBeUndefined()
    expect(bad({ line: 0, text: 'abc', ranges: [[0, 1]] })).toBeUndefined()
    expect(bad({ line: 1, text: 'x'.repeat(241), ranges: [[0, 1]] })).toBeUndefined()
    expect(bad({ line: 1, text: 'abc', ranges: [[0, 1]] })).toMatchObject({ count: 1 })
    expect(parseContentResults({ ...reply(), files: [{ ...reply().files[0], path: '/etc/passwd' }] })).toBeUndefined()
    expect(parseContentResults(reply({ stopped: 'whenever' }))).toBeUndefined()
    expect(parseContentResults(reply({ stopped: 'time' }))?.stopped).toBe('time')
  })

  it('cuts a line into plain and marked parts', () => {
    expect(
      highlightParts('a needle b needle', [
        [2, 8],
        [11, 17],
      ]),
    ).toEqual([
      { text: 'a ', match: false },
      { text: 'needle', match: true },
      { text: ' b ', match: false },
      { text: 'needle', match: true },
    ])
    expect(highlightParts('needle', [[0, 6]])).toEqual([{ text: 'needle', match: true }])
  })

  it('says how many, whether more exist, and what was left out', () => {
    expect(resultSummary(parseContentResults(reply())!)).toEqual({ text: '2 处 · 1 个文件' })
    expect(resultSummary(parseContentResults(reply({ stopped: 'results' }))!)).toMatchObject({ partial: '结果较多，只显示前一部分' })
    expect(resultSummary(parseContentResults({ ...reply(), files: [{ ...reply().files[0], more: true }] })!).partial).toBeDefined()
    expect(resultSummary(parseContentResults({ files: [], count: 0, scanned: 3, skipped: { large: 1, binary: 2 } })!)).toEqual({
      text: '没有找到',
      skipped: '未搜索 1 个大文件、2 个非文本文件',
    })
    expect(
      resultSummary(
        parseContentResults({ files: [], count: 0, scanned: 3, skipped: { large: 0, binary: 0, unchecked: 4, uncheckedFolders: 2 } })!,
      ).unchecked,
    ).toEqual({ label: '6 项未核对', detail: '2 个文件夹（连同其中内容）和 4 个文件的忽略规则没有核对完，按已忽略处理，没有搜索。' })
    expect(uncheckedNote(0, 1)?.detail).toBe('1 个文件夹（连同其中内容）的忽略规则没有核对完，按已忽略处理，没有搜索。')
    expect(folderOf('src/deep/main.ts')).toBe('src/deep')
    expect(folderOf('main.ts')).toBe('')
  })
})
