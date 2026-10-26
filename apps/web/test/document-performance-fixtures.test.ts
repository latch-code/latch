import { describe, expect, it } from 'vitest'
import { documentFixtures, performanceDocumentFixtures } from '@latch/testkit'
import { strToU8, strFromU8, zipSync, unzipSync } from 'fflate'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const output = resolve('test-results/document-performance')
async function save(kind: string, bytes: Uint8Array) {
  await mkdir(output, { recursive: true })
  await writeFile(resolve(output, `input.${kind}`), bytes)
}
const zip = (files: Record<string, string>) =>
    zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), {
      level: 6,
      mtime: new Date(2020, 0, 1),
    }),
  fixtures = performanceDocumentFixtures(zip)
describe('real document performance inputs', () => {
  it('preserves the small fixtures and generates a complete 30-slide relationship graph', async () => {
    const bytes = fixtures.presentation()
    await save('pptx', bytes)
    const small = documentFixtures(files => Array.from(zip(files))),
      legacy = unzipSync(new Uint8Array(small.presentation())),
      ppt = unzipSync(bytes)
    expect(Object.keys(legacy).filter(name => /^ppt\/slides\/slide\d+\.xml$/u.test(name))).toHaveLength(25)
    expect(strFromU8(legacy['ppt/slides/slide1.xml']!)).toContain('Page 1')
    expect(new TextDecoder().decode(new Uint8Array(small.pdf()))).toContain('/Count 1')
    expect(Object.keys(ppt).filter(name => /^ppt\/slides\/slide\d+\.xml$/u.test(name))).toHaveLength(30)
    expect(strFromU8(ppt['[Content_Types].xml']!)).toContain('/ppt/theme/theme1.xml')
    expect(strFromU8(ppt['ppt/slideMasters/_rels/slideMaster1.xml.rels']!)).toContain('../theme/theme1.xml')
    for (let i = 1; i <= 30; i++) {
      expect(strFromU8(ppt[`ppt/slides/slide${i}.xml`]!)).toContain(`Performance slide ${String(i).padStart(2, '0')}`)
      expect(strFromU8(ppt[`ppt/slides/_rels/slide${i}.xml.rels`]!)).toContain('../slideLayouts/slideLayout1.xml')
    }
  })
  it('generates 200 real PDF page/content objects with byte-correct xref offsets and lengths', async () => {
    const bytes = fixtures.pdf(),
      source = strFromU8(bytes),
      xref = Number(/startxref\n(\d+)/u.exec(source)?.[1])
    await save('pdf', bytes)
    expect(source.slice(xref, xref + 4)).toBe('xref')
    expect(source.match(/\/Type \/Page /gu)).toHaveLength(200)
    expect(source).toContain('/Count 200')
    const offsets = source.slice(xref).split('\n').slice(3, 406)
    expect(offsets).toHaveLength(403)
    for (const [index, line] of offsets.entries())
      expect(source.slice(Number(line.slice(0, 10)))).toMatch(new RegExp(`^${index + 1} 0 obj\\n`, 'u'))
    for (const match of source.matchAll(/\/Length (\d+) >>\nstream\n([\s\S]*?)endstream/gu))
      expect(new TextEncoder().encode(match[2]).length).toBe(Number(match[1]))
    expect(source).toContain('Performance PDF page 200')
    expect(source).not.toContain('%padding')
  })
  it('contains at least 10 MiB of valid compressed workbook data, with a bounded populated worksheet and no padding entries', async () => {
    const bytes = fixtures.workbook(),
      files = unzipSync(bytes),
      sheet = files['xl/worksheets/sheet1.xml']!,
      xml = strFromU8(sheet)
    await save('xlsx', bytes)
    await writeFile(
      resolve(output, 'fixture-metadata.json'),
      JSON.stringify({ xlsxBytes: bytes.length, worksheetBytes: sheet.length, rows: 12001, cells: 12001 * 8 }, null, 2) + '\n',
    )
    expect(bytes.length).toBeGreaterThanOrEqual(10 * 1024 * 1024)
    expect(sheet.length).toBeLessThanOrEqual(32 * 1024 * 1024)
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ])
    expect(xml.match(/<row r=/gu)).toHaveLength(12001)
    expect(xml.match(/<c r=/gu)).toHaveLength(12001 * 8)
    expect(xml).toContain('<dimension ref="A1:H12001"/>')
    expect(xml).toContain('Record 12000')
    expect(xml).not.toContain('padding')
    expect(xml.match(/<t>[A-Za-z0-9_-]{256}<\/t>/gu)).toHaveLength(12000 * 5)
  }, 15000)
})
