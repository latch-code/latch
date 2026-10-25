const tags = new Set([
  'svg',
  'g',
  'defs',
  'style',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'marker',
  'pattern',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'title',
  'desc',
  'use',
])
const attrs = new Set([
  'xmlns',
  'xmlns:xlink',
  'id',
  'class',
  'style',
  'role',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-roledescription',
  'viewBox',
  'preserveAspectRatio',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'dx',
  'dy',
  'd',
  'points',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'lengthAdjust',
  'textLength',
  'marker-start',
  'marker-mid',
  'marker-end',
  'markerWidth',
  'markerHeight',
  'refX',
  'refY',
  'orient',
  'markerUnits',
  'clip-path',
  'clipPathUnits',
  'mask',
  'patternUnits',
  'patternTransform',
  'gradientUnits',
  'gradientTransform',
  'offset',
  'stop-color',
  'stop-opacity',
  'href',
  'xlink:href',
  'tabindex',
  'focusable',
  'data-id',
  'data-node',
  'data-look',
])
function safeValue(value: string): boolean {
  if (/[&\\\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value) || /@|(?:javascript|data|https?|file)\s*:/iu.test(value)) return false
  return !/url\s*\(/iu.test(value.replace(/url\(\s*['"]?#[A-Za-z0-9_.:-]+['"]?\s*\)/giu, ''))
}
/** A bounded XML lexer, so the Trusted Types protected parent never parses SVG into DOM. */
export function isSafeDiagramSvg(svg: string): boolean {
  if (
    svg.length > 2_000_000
    || !svg.trimStart().startsWith('<svg')
    || /<\?|<!|&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});)/iu.test(svg)
  )
    return false
  const stack: string[] = [],
    token = /<[^>]*>|[^<]+/gu
  let end = 0,
    count = 0,
    root = false
  for (const match of svg.matchAll(token)) {
    if (match.index !== end || ++count > 50_000) return false
    end = match.index + match[0].length
    const value = match[0]
    if (!value.startsWith('<')) {
      if (!stack.length && value.trim()) return false
      if (stack.at(-1) === 'style' && !safeValue(value)) return false
      continue
    }
    const parsed = /^<(\/)?([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/)?>$/u.exec(value)
    if (!parsed || !tags.has(parsed[2]!)) return false
    const name = parsed[2]!
    if (parsed[1]) {
      if (parsed[3]!.trim() || parsed[4] || stack.pop() !== name) return false
      continue
    }
    if (!root) {
      if (name !== 'svg') return false
      root = true
    } else if (!stack.length) return false
    let rest = parsed[3]!,
      attributes = 0
    while (rest.trim()) {
      const attr = /^\s+([A-Za-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(rest)
      if (!attr || ++attributes > 100 || !attrs.has(attr[1]!) || attr[0].length > 200_000) return false
      const text = attr[2] ?? attr[3] ?? ''
      if ((!attr[1]!.startsWith('xmlns') && !safeValue(text)) || text.includes('<')) return false
      if ((attr[1] === 'href' || attr[1] === 'xlink:href') && !/^#[A-Za-z0-9_.:-]+$/u.test(text)) return false
      if (attr[1] === 'xmlns' && text !== 'http://www.w3.org/2000/svg') return false
      if (attr[1] === 'xmlns:xlink' && text !== 'http://www.w3.org/1999/xlink') return false
      rest = rest.slice(attr[0].length)
    }
    if (!parsed[4]) {
      stack.push(name)
      if (stack.length > 128) return false
    }
  }
  return end === svg.length && root && !stack.length
}
export function validDiagramSource(source: string): boolean {
  return new TextEncoder().encode(source).length <= 50_000 && !/%%\s*\{|^\s*---|^\s*(?:click|linkStyle|classDef|style)\s/imu.test(source)
}
