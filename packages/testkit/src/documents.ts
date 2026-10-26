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

/** Large, deterministic, actual document content. Small hostile fixtures above remain byte-for-byte unchanged. */
export function performanceDocumentFixtures(zip: (files: Record<string, string>) => Uint8Array): {
  presentation(): Uint8Array
  pdf(): Uint8Array
  workbook(): Uint8Array
} {
  const NS = 'http://schemas.openxmlformats.org/',
    rels = (body: string) => `<Relationships xmlns="${NS}package/2006/relationships">${body}</Relationships>`,
    relation = (id: string, type: string, target: string) =>
      `<Relationship Id="${id}" Type="${NS}officeDocument/2006/relationships/${type}" Target="${target}"/>`,
    group =
      '<p:nvGrpSpPr><p:cNvPr id="1" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>',
    palette = ['24548A', '4A749F', '6E91B4', '91ACC6', 'B2C5D8', 'D2DDE7'],
    shape = (id: number, text: string, x: number, y: number, w: number, h: number, color: string, size = 1600) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${size}"><a:solidFill><a:srgbClr val="${color === 'FFFFFF' ? '17212B' : 'FFFFFF'}"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${text}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`
  function presentation() {
    const count = 30,
      types = [
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
      ],
      files: Record<string, string> = {
        '_rels/.rels': rels(relation('office', 'officeDocument', 'ppt/presentation.xml')),
        'ppt/presentation.xml': `<p:presentation xmlns:p="${NS}presentationml/2006/main" xmlns:a="${NS}drawingml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="master"/></p:sldMasterIdLst><p:sldIdLst>${Array.from({ length: count }, (_, i) => `<p:sldId id="${256 + i}" r:id="s${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`,
        'ppt/_rels/presentation.xml.rels': rels(
          relation('master', 'slideMaster', 'slideMasters/slideMaster1.xml')
            + Array.from({ length: count }, (_, i) => relation(`s${i + 1}`, 'slide', `slides/slide${i + 1}.xml`)).join(''),
        ),
        'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster xmlns:p="${NS}presentationml/2006/main" xmlns:a="${NS}drawingml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="layout"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
        'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels(
          relation('layout', 'slideLayout', '../slideLayouts/slideLayout1.xml') + relation('theme', 'theme', '../theme/theme1.xml'),
        ),
        'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout xmlns:p="${NS}presentationml/2006/main" xmlns:a="${NS}drawingml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels(relation('master', 'slideMaster', '../slideMasters/slideMaster1.xml')),
      }
    const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
      font = '<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>'
    files['ppt/theme/theme1.xml'] =
      `<a:theme xmlns:a="${NS}drawingml/2006/main" name="Fixture"><a:themeElements><a:clrScheme name="Fixture">${['000000', 'FFFFFF', '17212B', 'F5F7F9', ...palette, '0563C1', '954F72'].map((color, i) => `<a:${['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'][i]}><a:srgbClr val="${color}"/></a:${['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'][i]}>`).join('')}</a:clrScheme><a:fontScheme name="Arial"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme><a:fmtScheme name="Fixture"><a:fillStyleLst>${solid.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[9525, 25400, 38100].map(width => `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr">${solid}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${solid.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`
    for (let i = 1; i <= count; i++) {
      types.push(
        `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
      )
      const title = shape(2, `Performance slide ${String(i).padStart(2, '0')}`, 420000, 280000, 8300000, 650000, 'FFFFFF', 2800),
        bars = palette
          .map((color, j) =>
            shape(
              j + 3,
              `Series ${j + 1}: ${(i * 17 + j * 11) % 100}`,
              650000,
              1300000 + j * 470000,
              2400000 + ((i + j) % 5) * 600000,
              340000,
              color,
            ),
          )
          .join(''),
        footer = shape(10, `Generated content - slide ${i} of ${count}`, 450000, 4500000, 8000000, 350000, 'FFFFFF', 1200)
      files[`ppt/slides/slide${i}.xml`] =
        `<p:sld xmlns:p="${NS}presentationml/2006/main" xmlns:a="${NS}drawingml/2006/main"><p:cSld name="Slide ${i}"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group}${title}${bars}${footer}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
      files[`ppt/slides/_rels/slide${i}.xml.rels`] = rels(relation('layout', 'slideLayout', '../slideLayouts/slideLayout1.xml'))
    }
    files['[Content_Types].xml'] = `<Types xmlns="${NS}package/2006/content-types">${types.join('')}</Types>`
    return zip(files)
  }
  function pdf() {
    const count = 200,
      objects: string[] = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ]
    for (let i = 1; i <= count; i++) {
      const stream =
        `0.95 0.97 0.99 rg 0 0 600 800 re f\n0.09 0.13 0.17 rg BT /F1 22 Tf 40 740 Td (Performance PDF page ${String(i).padStart(3, '0')}) Tj ET\n`
        + Array.from(
          { length: 16 },
          (_, j) =>
            `0.15 0.33 0.54 rg 40 ${680 - j * 34} ${150 + ((i * 13 + j * 19) % 370)} 15 re f\n0.1 0.1 0.1 rg BT /F1 10 Tf 40 ${671 - j * 34} Td (Page ${i} record ${j + 1}: ${i * 1000 + j}) Tj ET\n`,
        ).join('')
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (i - 1) * 2} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
      )
    }
    let source = '%PDF-1.4\n',
      offsets = [0]
    for (let i = 0; i < objects.length; i++) {
      offsets.push(source.length)
      source += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
    }
    const xref = source.length
    source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
      .slice(1)
      .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return new TextEncoder().encode(source)
  }
  function workbook() {
    let state = 0x13579bdf
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
      token = () =>
        Array.from({ length: 256 }, () => {
          state ^= state << 13
          state ^= state >>> 17
          state ^= state << 5
          return alphabet[(state >>> 0) & 63]
        }).join(''),
      text = (cell: string, value: string, style = 0) => `<c r="${cell}" s="${style}" t="inlineStr"><is><t>${value}</t></is></c>`,
      rows = [
        `<row r="1">${['Index', 'Recorded date', 'Record', 'Trace D', 'Trace E', 'Trace F', 'Trace G', 'Trace H'].map((value, i) => text(`${String.fromCharCode(65 + i)}1`, value, 2)).join('')}</row>`,
      ]
    for (let i = 1; i <= 12000; i++) {
      const row = i + 1
      rows.push(
        `<row r="${row}"><c r="A${row}"><v>${i}</v></c><c r="B${row}" s="1"><v>${45000 + (i % 365)}</v></c>${text(`C${row}`, `Record ${String(i).padStart(5, '0')}`)}${['D', 'E', 'F', 'G', 'H'].map(col => text(`${col}${row}`, token())).join('')}</row>`,
      )
    }
    return zip({
      '[Content_Types].xml': `<Types xmlns="${NS}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
      '_rels/.rels': rels(relation('office', 'officeDocument', 'xl/workbook.xml')),
      'xl/workbook.xml': `<workbook xmlns="${NS}spreadsheetml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="Performance data" sheetId="1" r:id="sheet"/></sheets><calcPr calcId="191029"/></workbook>`,
      'xl/_rels/workbook.xml.rels': rels(
        relation('sheet', 'worksheet', 'worksheets/sheet1.xml') + relation('styles', 'styles', 'styles.xml'),
      ),
      'xl/styles.xml': `<styleSheet xmlns="${NS}spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
      'xl/worksheets/sheet1.xml': `<worksheet xmlns="${NS}spreadsheetml/2006/main"><dimension ref="A1:H12001"/><sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="10" customWidth="1"/><col min="2" max="2" width="18" customWidth="1"/><col min="3" max="3" width="24" customWidth="1"/><col min="4" max="8" width="40" customWidth="1"/></cols><sheetData>${rows.join('')}</sheetData></worksheet>`,
    })
  }
  return { presentation, pdf, workbook }
}
