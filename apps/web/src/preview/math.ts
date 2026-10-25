interface MathTree {
  type: string
  value?: string
  children?: MathTree[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}
/** Preserve code verbatim while accepting the common escaped TeX delimiters. */
export function normalizeMathDelimiters(text: string): string {
  let output = '',
    index = 0,
    fence = '',
    inline = ''
  while (index < text.length) {
    if (index === 0 || text[index - 1] === '\n') {
      const end = text.indexOf('\n', index),
        line = text.slice(index, end < 0 ? undefined : end + 1),
        marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1]
      if (marker && !inline) {
        if (!fence) fence = marker
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''
        output += line
        index += line.length
        continue
      }
    }
    if (fence) {
      output += text[index++]
      continue
    }
    if (text[index] === '`') {
      const run = /^`+/u.exec(text.slice(index))![0]
      if (!inline) inline = run
      else if (inline === run) inline = ''
      output += run
      index += run.length
      continue
    }
    if (
      !inline
      && text[index] === '\\'
      && (index === 0 || text[index - 1] !== '\\')
      && (text[index + 1] === '(' || text[index + 1] === '[')
    ) {
      const display = text[index + 1] === '[',
        end = text.indexOf(display ? '\\]' : '\\)', index + 2),
        body = end < 0 ? '' : text.slice(index + 2, end)
      if (end >= 0 && body.length <= 20_000 && (display || !body.includes('\n'))) {
        output += display ? `\n$$\n${body}\n$$\n` : `$${body}$`
        index = end + 2
        continue
      }
    }
    output += text[index++]
  }
  return output
}
/** Single-dollar math must touch non-whitespace on both sides. Currency stays text. */
export function restrictInlineMath() {
  return (tree: MathTree, file: { value?: unknown }) => {
    const source = String(file.value ?? '')
    const visit = (node: MathTree) => {
      for (const child of node.children ?? []) {
        if (child.type === 'inlineMath' && (!child.value || /^\s|\s$/u.test(child.value))) {
          const start = child.position?.start.offset,
            end = child.position?.end.offset
          child.type = 'text'
          child.value = start !== undefined && end !== undefined ? source.slice(start, end) : `$${child.value ?? ''}$`
          Reflect.deleteProperty(child, 'data')
        }
        visit(child)
      }
    }
    visit(tree)
  }
}
const htmlTags = new Set(['span']),
  mathTags = new Set([
    'math',
    'semantics',
    'mrow',
    'mi',
    'mo',
    'mn',
    'mtext',
    'mspace',
    'msup',
    'msub',
    'msubsup',
    'mfrac',
    'msqrt',
    'mroot',
    'mover',
    'munder',
    'munderover',
    'mtable',
    'mtr',
    'mtd',
    'mpadded',
    'mphantom',
    'menclose',
    'mstyle',
    'annotation',
    'mmultiscripts',
    'mprescripts',
    'none',
  ]),
  svgTags = new Set(['svg', 'path', 'line'])
const attributes = new Set([
  'class',
  'style',
  'aria-hidden',
  'encoding',
  'display',
  'linethickness',
  'xmlns',
  'width',
  'height',
  'viewBox',
  'd',
  'preserveAspectRatio',
  'x1',
  'x2',
  'y1',
  'y2',
  'stroke-width',
  'mathvariant',
  'stretchy',
  'fence',
  'separator',
  'accent',
  'accentunder',
  'columnalign',
  'rowspacing',
  'columnspacing',
  'displaystyle',
  'scriptlevel',
  'lspace',
  'rspace',
  'minsize',
  'maxsize',
  'rowalign',
  'columnlines',
  'rowlines',
])
export function validMathDom(root: Element): boolean {
  let count = 0
  const visit = (node: Node, depth: number): boolean => {
    if (++count > 20_000 || depth > 128) return false
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent?.length ?? 0) <= 100_000
    if (!(node instanceof Element)) return false
    const allowed =
      node.namespaceURI === 'http://www.w3.org/1998/Math/MathML'
        ? mathTags
        : node.namespaceURI === 'http://www.w3.org/2000/svg'
          ? svgTags
          : node.namespaceURI === 'http://www.w3.org/1999/xhtml'
            ? htmlTags
            : undefined
    if (!allowed?.has(node.localName)) return false
    if (
      ![...node.attributes].every(
        attr =>
          attributes.has(attr.name)
          && attr.value.length < 200_000
          && !/(?:url\s*\(|expression\s*\(|@import|javascript:)/iu.test(attr.value),
      )
    )
      return false
    return [...node.childNodes].every(child => visit(child, depth + 1))
  }
  return visit(root, 0)
}
