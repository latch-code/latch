/** Generated Office/PDF fixtures. The caller supplies its test ZIP encoder; no parser or fixture file ships in production. */
export function documentFixtures(zip: (files: Record<string, string>) => number[]): {
  word(): number[]
  workbook(): number[]
  presentation(count?: number): number[]
  pdf(): number[]
} {
  const NS = 'http://schemas.openxmlformats.org/'
  const word = () =>
    zip({
      '[Content_Types].xml': `<Types xmlns="${NS}package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      '_rels/.rels': `<Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="doc" Type="${NS}officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      'word/document.xml': `<w:document xmlns:w="${NS}wordprocessingml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p><w:p><w:hyperlink r:id="external"><w:r><w:t>External link</w:t></w:r></w:hyperlink></w:p><w:altChunk r:id="bad"/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
      'word/_rels/document.xml.rels': `<Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="bad" Type="${NS}officeDocument/2006/relationships/aFChunk" Target="chunk.html"/><Relationship Id="external" Type="${NS}officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="https://example.invalid/never-load"/></Relationships>`,
      'word/chunk.html': '<script>parent.PWNED=true</script><form><input></form>',
    })
  const workbook = () =>
    zip({
      'xl/workbook.xml': `<workbook xmlns="${NS}spreadsheetml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets><sheet name="数据" sheetId="1" r:id="one"/><sheet name="隐藏" state="hidden" sheetId="2" r:id="two"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="one" Target="worksheets/sheet1.xml"/><Relationship Id="two" Target="worksheets/sheet2.xml"/></Relationships>`,
      'xl/styles.xml': `<styleSheet xmlns="${NS}spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
      'xl/worksheets/sheet1.xml': `<worksheet xmlns="${NS}spreadsheetml/2006/main"><dimension ref="A1:C2"/><sheetViews><sheetView><pane state="frozen" xSplit="1" ySplit="1"/></sheetView></sheetViews><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>表格标题</t></is></c></row><row r="2"><c r="A2" s="1"><v>1</v></c><c r="B2"><f>1+1</f><v>999</v></c><c r="C2" t="inlineStr"><is><t>&lt;script&gt;bad&lt;/script&gt;</t></is></c></row></sheetData><mergeCells><mergeCell ref="A1:C1"/></mergeCells></worksheet>`,
      'xl/worksheets/sheet2.xml': `<worksheet xmlns="${NS}spreadsheetml/2006/main"><sheetData/></worksheet>`,
    })
  function presentation(count = 25) {
    if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('fixture-page-limit')
    const files: Record<string, string> = {
      '[Content_Types].xml': `<Types xmlns="${NS}package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
      'ppt/presentation.xml': `<p:presentation xmlns:p="${NS}presentationml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><p:sldIdLst>${Array.from({ length: count }, (_, i) => `<p:sldId id="${256 + i}" r:id="s${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${NS}package/2006/relationships">${Array.from({ length: count }, (_, i) => `<Relationship Id="s${i + 1}" Type="${NS}officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`,
      'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="note" Type="${NS}officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
      'ppt/notesSlides/notesSlide1.xml': `<p:notes xmlns:p="${NS}presentationml/2006/main" xmlns:a="${NS}drawingml/2006/main"><p:cSld><a:t>Speaker note</a:t></p:cSld></p:notes>`,
    }
    for (let i = 1; i <= count; i++)
      files[`ppt/slides/slide${i}.xml`] =
        `<p:sld xmlns:p="${NS}presentationml/2006/main" xmlns:a="${NS}drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="300000" y="300000"/><a:ext cx="8000000" cy="1000000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="2400"/><a:t>Page ${i}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    return zip(files)
  }
  function pdf() {
    const stream = 'BT /F1 18 Tf 50 740 Td (Hello PDF) Tj ET',
      objects = [
        `<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (globalThis.PWNED=true) >> >>`,
        `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
      ]
    let source = '%PDF-1.4\n',
      offsets = [0]
    for (let i = 0; i < objects.length; i++) {
      offsets.push(source.length)
      source += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
    }
    source += '%padding\n'.repeat(16000)
    const xref = source.length
    source += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map(value => `${String(value).padStart(10, '0')} 00000 n \n`)
      .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
    return Array.from(new TextEncoder().encode(source))
  }
  return { word, workbook, presentation, pdf }
}
