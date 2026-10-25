import { describe, expect, it } from 'vitest'
import { documentFixtures } from '@latch/testkit'
describe('shared generated document cases', () => {
  it('generates bounded slide counts, speaker notes and the deliberate inactive DOCX payload', () => {
    let parts: Record<string, string> = {}
    const fixtures = documentFixtures(value => {
      parts = value
      return []
    })
    fixtures.presentation(100)
    expect(Object.keys(parts).filter(path => /^ppt\/slides\/slide\d+\.xml$/u.test(path))).toHaveLength(100)
    expect(parts['ppt/notesSlides/notesSlide1.xml']).toContain('Speaker note')
    expect(() => fixtures.presentation(501)).toThrow('fixture-page-limit')
    fixtures.word()
    expect(parts['word/document.xml']).toContain('altChunk')
    expect(parts['word/_rels/document.xml.rels']).toContain('TargetMode="External"')
    fixtures.workbook()
    expect(parts['xl/worksheets/sheet1.xml']).toContain('<f>1+1</f><v>999</v>')
    expect(new TextDecoder().decode(new Uint8Array(fixtures.pdf()))).toContain('/OpenAction')
  })
})
