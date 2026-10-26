import { ascii, concat, equal, fixed, uint } from './bytes.ts'
import { type LinkCrypto, UTC_DAY } from './crypto.ts'

/** A stable, non-secret cache hint; book issuance and task revisions never change it. */
export function discoveryEpochInput(key: Uint8Array): Uint8Array {
  return concat(ascii('latch-discovery-epoch-v1\0'), fixed(key, 32))
}

/** Names are base32(digest).lowercase().slice(0, 12), using each platform's existing shared base32 implementation. */
export function mdnsSigningInput(day: number, alternate = false): Uint8Array {
  return concat(ascii(alternate ? 'latch-mdns-alt-v1' : 'latch-mdns-v1'), uint(day, 4))
}
export async function mdnsDigest(crypto: LinkCrypto, key: Uint8Array, day: number, alternate = false): Promise<Uint8Array> {
  return fixed(await crypto.hmac(fixed(key, 32), mdnsSigningInput(day, alternate)), 32)
}
export function mdnsTarget(instance: string): string {
  if (!/^[a-z2-7]{12}$/u.test(instance)) throw new RangeError('Invalid discovery instance')
  return `l-${instance}.local`
}
/** Current device-clock date and its nearest neighbor; never an unbounded search of past names. */
export function discoveryDays(timeMs: number): [number, number] {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0) throw new RangeError('Invalid discovery time')
  const seconds = Math.floor(timeMs / 1000),
    day = Math.floor(seconds / UTC_DAY)
  uint(day, 4)
  return [day, day === 0 || seconds % UTC_DAY >= UTC_DAY / 2 ? day + 1 : day - 1]
}
export interface IpAddress {
  family: 4 | 6
  bytes: Uint8Array
}
export function parseIp(value: string): IpAddress {
  if (value.length < 2 || value.length > 45) throw new RangeError('Invalid network address')
  const v4 = (text: string): Uint8Array => {
    const parts = text.split('.')
    if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/u.test(part) || Number(part) > 255))
      throw new RangeError('Invalid IPv4 address')
    return Uint8Array.from(parts, Number)
  }
  if (!value.includes(':')) return { family: 4, bytes: v4(value) }
  let text = value.toLowerCase()
  if (!/^[a-f0-9:.]+$/u.test(text)) throw new RangeError('Invalid IPv6 address')
  if (text.includes('.')) {
    const at = text.lastIndexOf(':'),
      tail = v4(text.slice(at + 1))
    text = `${text.slice(0, at + 1)}${(tail[0]! * 256 + tail[1]!).toString(16)}:${(tail[2]! * 256 + tail[3]!).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) throw new RangeError('Invalid IPv6 address')
  const left = halves[0] ? halves[0].split(':') : [],
    right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if ([...left, ...right].some(part => !/^[a-f0-9]{1,4}$/u.test(part))) throw new RangeError('Invalid IPv6 address')
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) throw new RangeError('Invalid IPv6 address')
  const groups = [
    ...left.map(part => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map(part => Number.parseInt(part, 16)),
  ]
  const bytes = Uint8Array.from(groups.flatMap(group => [group >> 8, group & 255]))
  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 255 && bytes[11] === 255) return { family: 4, bytes: bytes.slice(12) }
  return { family: 6, bytes }
}
export function subnetBytes(address: IpAddress, prefixLength: number): Uint8Array {
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > address.bytes.length * 8)
    throw new RangeError('Invalid network prefix')
  return address.bytes.map((byte, index) => {
    const bits = Math.max(0, Math.min(8, prefixLength - index * 8))
    return byte & (bits === 0 ? 0 : 256 - 2 ** (8 - bits))
  })
}
export function sameSubnet(first: string, second: string, prefixLength: number): boolean {
  try {
    const a = parseIp(first),
      b = parseIp(second)
    return a.family === b.family && equal(subnetBytes(a, prefixLength), subnetBytes(b, prefixLength))
  } catch {
    return false
  }
}
/** Discovery may dial only another usable host in the current interface's subnet. */
export function isDiscoveryPeer(value: string, local: string, prefixLength: number, own: readonly string[]): boolean {
  try {
    const peer = parseIp(value),
      address = parseIp(local)
    if (
      !isPrivateDiscoveryAddress(value)
      || !sameSubnet(value, local, prefixLength)
      || own.some(item => {
        try {
          const ip = parseIp(item)
          return ip.family === peer.family && equal(ip.bytes, peer.bytes)
        } catch {
          return false
        }
      })
    )
      return false
    if (peer.family === 4 && prefixLength < 31) {
      const network = subnetBytes(address, prefixLength)
      if (
        equal(peer.bytes, network)
        || equal(
          peer.bytes,
          network.map((byte, index) => byte | (255 ^ subnetBytes({ family: 4, bytes: new Uint8Array(4).fill(255) }, prefixLength)[index]!)),
        )
      )
        return false
    }
    return true
  } catch {
    return false
  }
}
export function isPrivateDiscoveryAddress(value: string): boolean {
  try {
    const ip = parseIp(value),
      bytes = ip.bytes
    if (ip.family === 4) {
      if (equal(bytes, new Uint8Array([169, 254, 169, 254]))) return false
      return (
        bytes[0] === 10
        || (bytes[0] === 172 && bytes[1]! >= 16 && bytes[1]! <= 31)
        || (bytes[0] === 192 && bytes[1] === 168)
        || (bytes[0] === 100 && bytes[1]! >= 64 && bytes[1]! <= 127)
        || (bytes[0] === 169 && bytes[1] === 254)
      )
    }
    const metadata = new Uint8Array([253, 0, 14, 194, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 84])
    if (equal(bytes, metadata)) return false
    return (bytes[0]! & 254) === 252 || (bytes[0] === 254 && (bytes[1]! & 192) === 128)
  } catch {
    return false
  }
}
/** Length-free, fixed-family fields avoid different textual spellings and concatenation ambiguity. */
export function gatewaySigningInput(address: string, prefixLength: number, gateway: string): Uint8Array {
  const ip = parseIp(address),
    router = parseIp(gateway)
  if (ip.family !== router.family) throw new RangeError('Gateway address family mismatch')
  return concat(ascii('latch-network-gateway-v1\0'), uint(ip.family, 1), uint(prefixLength, 1), subnetBytes(ip, prefixLength), router.bytes)
}
export async function gatewayHash(crypto: LinkCrypto, address: string, prefixLength: number, gateway: string): Promise<Uint8Array> {
  return fixed(await crypto.hash(gatewaySigningInput(address, prefixLength, gateway)), 32)
}
