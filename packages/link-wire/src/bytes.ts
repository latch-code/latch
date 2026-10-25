export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0)
  if (size > 1_048_576) throw new RangeError('Link record too large')
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
export function ascii(text: string): Uint8Array {
  if (!/^[\x00-\x7f]*$/u.test(text)) throw new RangeError('Expected ASCII')
  return Uint8Array.from(text, char => char.charCodeAt(0))
}
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}
export function unhex(text: string, size?: number): Uint8Array {
  if (!/^(?:[a-f0-9]{2})*$/u.test(text) || (size !== undefined && text.length !== size * 2)) throw new RangeError('Invalid hex')
  return Uint8Array.from(text.match(/../gu) ?? [], value => Number.parseInt(value, 16))
}
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  let difference = a.length ^ b.length
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
  return difference === 0
}
export function fixed(bytes: Uint8Array, size: number): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== size) throw new RangeError('Invalid link field size')
  return bytes
}
export function uint(value: number, size: 1 | 2 | 4 | 8): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || (size < 8 && value >= 2 ** (size * 8))) throw new RangeError('Invalid link integer')
  const bytes = new Uint8Array(size)
  let rest = value
  for (let index = size - 1; index >= 0; index--) {
    bytes[index] = rest % 256
    rest = Math.floor(rest / 256)
  }
  return bytes
}
export function field(bytes: Uint8Array): Uint8Array {
  return concat(uint(bytes.length, 2), bytes)
}
export class Reader {
  private position = 0
  readonly bytes: Uint8Array
  constructor(bytes: Uint8Array, maximum = 65_536) {
    if (bytes.length > maximum) throw new RangeError('Link record too large')
    this.bytes = bytes
  }
  take(size: number): Uint8Array {
    if (!Number.isSafeInteger(size) || size < 0 || this.position + size > this.bytes.length) throw new RangeError('Truncated link record')
    const out = this.bytes.slice(this.position, this.position + size)
    this.position += size
    return out
  }
  number(size: 1 | 2 | 4 | 8): number {
    let value = 0
    for (const byte of this.take(size)) value = value * 256 + byte
    if (!Number.isSafeInteger(value)) throw new RangeError('Link integer overflow')
    return value
  }
  field(maximum: number): Uint8Array {
    const size = this.number(2)
    if (size > maximum) throw new RangeError('Link field too large')
    return this.take(size)
  }
  done(): void {
    if (this.position !== this.bytes.length) throw new RangeError('Trailing link bytes')
  }
}
