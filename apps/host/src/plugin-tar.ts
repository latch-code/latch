const BLOCK = 512
const ZERO_BLOCK = Buffer.alloc(BLOCK)

function field(header: Buffer, start: number, end: number, invalid: () => Error): string {
  const bytes = header.subarray(start, end)
  const nul = bytes.indexOf(0)
  if (nul !== -1 && bytes.subarray(nul).some(byte => byte !== 0)) throw invalid()
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(nul === -1 ? bytes : bytes.subarray(0, nul))
  } catch {
    throw invalid()
  }
}

export function tarPath(name: string, directory: boolean, invalid: () => Error): string {
  const path = directory ? name.replace(/\/$/u, '') : name
  if (/[\\\p{Cc}]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw invalid()
  return path
}

/** Frames bounded USTAR input. Each package format interprets its own allowed entry types. */
export function* tarEntries(tar: Buffer, maxEntries: number, invalid: () => Error) {
  if (tar.length % BLOCK !== 0) throw invalid()
  let count = 0
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.equals(ZERO_BLOCK)) {
      if (tar.length - offset < 2 * BLOCK || tar.subarray(offset).some(byte => byte !== 0)) throw invalid()
      return
    }
    const sizeField = field(header, 124, 136, invalid).trim()
    const storedChecksum = header.toString('ascii', 148, 156).replace(/\0/g, '').trim()
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (
      !/^[0-7]+$/u.test(sizeField)
      || !/^[0-7]+$/u.test(storedChecksum)
      || parseInt(storedChecksum, 8) !== checksum
      || header.toString('ascii', 257, 262) !== 'ustar'
    )
      throw invalid()
    const size = parseInt(sizeField, 8)
    const start = offset + BLOCK
    offset = start + Math.ceil(size / BLOCK) * BLOCK
    if (offset > tar.length || ++count > maxEntries) throw invalid()
    const prefix = field(header, 345, 500, invalid)
    const name = field(header, 0, 100, invalid)
    yield { name: prefix ? `${prefix}/${name}` : name, type: String.fromCharCode(header[156]!), bytes: tar.subarray(start, start + size) }
  }
  throw invalid()
}
