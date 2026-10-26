import { ascii, concat, field, fixed, hex, Reader, uint } from './bytes.ts'
import { directoryEndpoint, type AuthorityCheckpoint } from './relay-directory.ts'

export interface NativeDirectorySource {
  anchors: Uint8Array[]
  mirrors: string[]
  minimum?: AuthorityCheckpoint
  minimumOnline?: AuthorityCheckpoint
}
/** Stable cache hint only; a received hint never changes a trust anchor, floor or permission. */
export function directoryEpochInput(source?: NativeDirectorySource): Uint8Array {
  return concat(ascii('latch-directory-epoch-v1\0'), source ? encodeDirectorySource(source) : new Uint8Array())
}
/** Mirror identity is approved on the Mac; response redirects, credentials and private destinations are never inferred. */
export function directoryMirror(value: string): void {
  const match = /^https:\/\/(\[[a-f0-9:]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?(\/[A-Za-z0-9._/-]*)$/u.exec(value)
  if (!match || value.length > 512 || match[3]!.includes('//') || match[3]!.split('/').some(part => part === '.' || part === '..'))
    throw new RangeError('Invalid directory mirror')
  directoryEndpoint(match[1]!.replace(/^\[|\]$/gu, ''), Number(match[2] ?? 443))
}
export function encodeDirectorySource(value: NativeDirectorySource): Uint8Array {
  if (
    value.anchors.length < 1
    || value.anchors.length > 2
    || new Set(value.anchors.map(hex)).size !== value.anchors.length
    || value.mirrors.length < 1
    || value.mirrors.length > 4
    || new Set(value.mirrors).size !== value.mirrors.length
  )
    throw new RangeError('Invalid directory sources')
  for (const mirror of value.mirrors) directoryMirror(mirror)
  for (const floor of [value.minimum, value.minimumOnline])
    if (floor && (!Number.isSafeInteger(floor.generation) || floor.generation < 1)) throw new RangeError('Invalid directory floor')
  if (value.minimumOnline && !value.minimum) throw new RangeError('Online floor requires an offline floor')
  return concat(
    uint(value.anchors.length, 1),
    ...value.anchors.map(anchor => fixed(anchor, 32)),
    uint(value.mirrors.length, 1),
    ...value.mirrors.map(mirror => field(ascii(mirror))),
    uint((value.minimum ? 1 : 0) | (value.minimumOnline ? 2 : 0), 1),
    ...(value.minimum ? [uint(value.minimum.generation, 8), fixed(value.minimum.hash, 32)] : []),
    ...(value.minimumOnline ? [uint(value.minimumOnline.generation, 8), fixed(value.minimumOnline.hash, 32)] : []),
  )
}
export function decodeDirectorySource(bytes: Uint8Array): NativeDirectorySource {
  const reader = new Reader(bytes, 2240),
    count = reader.number(1)
  if (count < 1 || count > 2) throw new RangeError('Directory anchor count')
  const anchors = Array.from({ length: count }, () => reader.take(32)),
    mirrorCount = reader.number(1)
  if (mirrorCount < 1 || mirrorCount > 4) throw new RangeError('Directory mirror count')
  const mirrors = Array.from({ length: mirrorCount }, () => {
      const encoded = reader.field(512)
      if (encoded.some(byte => byte < 33 || byte > 126)) throw new RangeError('Invalid directory mirror text')
      return String.fromCharCode(...encoded)
    }),
    floor = reader.number(1)
  if (floor > 3 || floor === 2) throw new RangeError('Directory source flags')
  const value = {
    anchors,
    mirrors,
    ...(floor & 1 ? { minimum: { generation: reader.number(8), hash: reader.take(32) } } : {}),
    ...(floor & 2 ? { minimumOnline: { generation: reader.number(8), hash: reader.take(32) } } : {}),
  }
  reader.done()
  encodeDirectorySource(value)
  return value
}
