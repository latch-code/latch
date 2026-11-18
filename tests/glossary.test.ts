import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scanGlossary, scanRepository } from '../scripts/glossary.ts'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/u, '')
const words = (source: string, path = 'a.tsx', allowances: Parameters<typeof scanGlossary>[2] = []) =>
  scanGlossary(path, source, allowances).map(finding => finding.word)

describe('glossary', () => {
  it('finds banned words in strings, template text, JSX text and JSX attributes', () => {
    expect(words(`const a = '执行端'`)).toEqual(['执行端'])
    expect(words(`const a = { b: '执行端' } as const`)).toEqual(['执行端'])
    expect(words('const a = `在 ${x} 上的 Host 里`')).toEqual(['Host'])
    expect(words('const a = <p>设备指纹</p>')).toEqual(['指纹'])
    expect(words('const a = <p title="引擎" />')).toEqual(['引擎'])
  })

  it('checks English interface terminology without matching parts of identifiers', () => {
    expect(words("const copy = { label: 'Data scope', help: 'Open the execution computer' }")).toEqual(['data scope', 'execution computer'])
    expect(words("const internalDataScope = 'process-data-scope'")).toEqual([])
  })

  it('leaves out what a person cannot read', () => {
    expect(words(`import x from 'Host'\n// Host 指纹\nconst Host = 1\ntype T = '执行端'\nconsole.warn('Host')`)).toEqual([])
    expect(words(`const a = '在新会话中继续'`)).toEqual([])
    expect(words(`const a = { Host: 'ok', '指纹': 1 } as const; if (b === 'host-desktop') c()`)).toEqual([])
    expect(words(`const a = () => import('./Providers.tsx')`)).toEqual([])
  })

  it('allows a word only under the key and for the words named', () => {
    const allowance = [{ file: 'a.ts', key: 'COPY.', words: ['中继'], why: 'test' }]
    expect(words(`const COPY = { relay: '中继' }`, 'a.ts', allowance)).toEqual([])
    expect(words(`const COPY = { relay: '中继 Host' }`, 'a.ts', allowance)).toEqual(['Host'])
    expect(words(`const OTHER = { relay: '中继' }`, 'a.ts', allowance)).toEqual(['中继'])
  })

  it('does not allow other text at an exact search alias key', () => {
    const allowance = [{ file: 'a.ts', key: 'SEARCH_TERMS.relay', words: ['中继'], text: '中继 转发', why: 'search only' }]
    expect(words("const SEARCH_TERMS = { relay: '中继 转发' }", 'a.ts', allowance)).toEqual([])
    expect(words("const SEARCH_TERMS = { relay: '添加中继' }", 'a.ts', allowance)).toEqual(['中继'])
    expect(words("const COPY = { relay: '中继 转发' }", 'a.ts', allowance)).toEqual(['中继'])
    expect(words("const SEARCH_TERMS = { relay: '中继 转发' }", 'b.ts', allowance)).toEqual(['中继'])
  })

  it('finds none in the scanned files and directories', async () => {
    expect(await scanRepository(root)).toEqual([])
  })
})
