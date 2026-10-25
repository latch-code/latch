import { strToU8, Unzip, UnzipInflate, zipSync } from 'fflate'
export const ZIP_LIMITS = { entries: 4000, entry: 32 * 1024 * 1024, total: 256 * 1024 * 1024, input: 50 * 1024 * 1024 } as const
export function inspectZip(data: Uint8Array): Map<string, number> {
  if (data.length > ZIP_LIMITS.input) throw new Error('zip-refused')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let end = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) throw new Error('zip-refused')
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    start = view.getUint32(end + 16, true)
  if (count > ZIP_LIMITS.entries || count === 65535 || start + size > end) throw new Error('zip-refused')
  let cursor = start,
    total = 0
  const names = new Set<string>()
  const sizes = new Map<string, number>()
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('zip-refused')
    const flags = view.getUint16(cursor + 8, true),
      method = view.getUint16(cursor + 10, true),
      compressed = view.getUint32(cursor + 20, true),
      expanded = view.getUint32(cursor + 24, true),
      len = view.getUint16(cursor + 28, true),
      extra = view.getUint16(cursor + 30, true),
      comment = view.getUint16(cursor + 32, true),
      local = view.getUint32(cursor + 42, true)
    if (
      flags & 1
      || ![0, 8].includes(method)
      || expanded > ZIP_LIMITS.entry
      || expanded === 0xffffffff
      || local === 0xffffffff
      || compressed === 0xffffffff
      || cursor + 46 + len + extra + comment > end
      || local + 30 > start
      || view.getUint32(local, true) !== 0x04034b50
    )
      throw new Error('zip-refused')
    const name = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(cursor + 46, cursor + 46 + len))
    if (
      names.has(name)
      || name.startsWith('/')
      || name.includes('\\')
      || name.split('/').some(part => part === '..')
      || name.includes('\0')
    )
      throw new Error('zip-refused')
    names.add(name)
    sizes.set(name, expanded)
    total += expanded
    if (total > ZIP_LIMITS.total || local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true) + compressed > start)
      throw new Error('zip-refused')
    cursor += 46 + len + extra + comment
  }
  if (cursor !== start + size) throw new Error('zip-refused')
  return sizes
}
export function xmlText(data: Uint8Array): string {
  const encoding = data[0] === 255 && data[1] === 254 ? 'utf-16le' : data[0] === 254 && data[1] === 255 ? 'utf-16be' : 'utf-8'
  return new TextDecoder(encoding, { fatal: true }).decode(data)
}
export function parseXml(text: string): Document {
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw new Error('zip-refused')
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('zip-refused')
  return doc
}
export function readOfficeZip(data: ArrayBuffer): Record<string, Uint8Array> {
  const bytes = new Uint8Array(data),
    expected = inspectZip(bytes),
    files: Record<string, Uint8Array> = Object.create(null)
  let total = 0
  const unzip = new Unzip(file => {
    if (!expected.has(file.name)) throw new Error('zip-refused')
    const chunks: Uint8Array[] = []
    let size = 0
    file.ondata = (error, chunk, final) => {
      if (error) throw new Error('zip-refused')
      size += chunk.length
      total += chunk.length
      if (size > ZIP_LIMITS.entry || total > ZIP_LIMITS.total || size > expected.get(file.name)!) throw new Error('zip-refused')
      chunks.push(chunk)
      if (final) {
        if (size !== expected.get(file.name)) throw new Error('zip-refused')
        const joined = new Uint8Array(size)
        let offset = 0
        for (const part of chunks) {
          joined.set(part, offset)
          offset += part.length
        }
        files[file.name] = joined
        chunks.length = 0
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  for (let offset = 0; offset < bytes.length; offset += 4096)
    unzip.push(bytes.subarray(offset, Math.min(bytes.length, offset + 4096)), offset + 4096 >= bytes.length)
  if (Object.keys(files).length !== expected.size) throw new Error('zip-refused')
  return files
}

export function sanitizeOfficeZip(data: ArrayBuffer): {
  data: Uint8Array
  files: Record<string, Uint8Array>
  blocked: number
  links: Record<string, string>
} {
  const files = readOfficeZip(data)
  for (const [name, bytes] of Object.entries(files))
    if (name.endsWith('.xml') && /<!DOCTYPE|<!ENTITY/iu.test(xmlText(bytes))) throw new Error('zip-refused')
  let blocked = 0
  const links: Record<string, string> = Object.create(null)
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith('.rels')) continue
    const doc = parseXml(xmlText(bytes))
    for (const relationship of Array.from(doc.getElementsByTagNameNS('*', 'Relationship'))) {
      const target = (relationship.getAttribute('Target') ?? '').trim()
      if (relationship.getAttribute('TargetMode')?.toLowerCase() === 'external' || /^[a-z][a-z0-9+.-]*:|^\/\//iu.test(target)) {
        // DOCX receives only an inert internal anchor; the parent can offer the original URL after a click.
        if (name.startsWith('word/') && relationship.getAttribute('Type')?.endsWith('/hyperlink') && Object.keys(links).length < 100) {
          let href: URL | undefined
          try {
            href = new URL(target)
          } catch {
            /* Invalid document links stay inert. */
          }
          if (href && ['https:', 'http:'].includes(href.protocol) && !href.username && !href.password && href.href.length <= 4096) {
            const source = name.replace('/_rels/', '/').replace(/\.rels$/u, ''),
              documentBytes = files[source]
            if (documentBytes) {
              const body = parseXml(xmlText(documentBytes)),
                id = relationship.getAttribute('Id')
              const marker = `latch-document-link-${Object.keys(links).length}`
              for (const link of Array.from(body.getElementsByTagNameNS('*', 'hyperlink'))) {
                const attribute = Array.from(link.attributes).find(item => item.localName === 'id' && item.value === id)
                if (attribute) {
                  link.removeAttributeNode(attribute)
                  link.setAttributeNS(link.namespaceURI, 'w:anchor', marker)
                  links[marker] = href.href
                }
              }
              files[source] = strToU8(new XMLSerializer().serializeToString(body))
            }
          }
        }
        relationship.remove()
        blocked++
      }
    }
    files[name] = strToU8(new XMLSerializer().serializeToString(doc))
  }
  return { data: blocked ? zipSync(files, { level: 0 }) : new Uint8Array(data), files, blocked, links }
}
export function resolvePart(base: string, target: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:|^\//iu.test(target)) return
  const parts = base.split('/')
  parts.pop()
  for (const part of target.split('/')) {
    if (part === '..') {
      if (!parts.length) return
      parts.pop()
    } else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}
