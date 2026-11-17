const V4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/u

function ipv6Groups(address: string): string[] | undefined {
  if (address.length > 45 || !/^[0-9a-f:.]+$/u.test(address)) return undefined
  let text = address,
    extra = 0
  const lastColon = text.lastIndexOf(':')
  if (text.includes('.')) {
    if (!V4.test(text.slice(lastColon + 1))) return undefined
    text = `${text.slice(0, lastColon + 1)}0:0`
    extra = 0
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(':') : [],
    tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if ([...head, ...tail].some(group => !/^[0-9a-f]{1,4}$/u.test(group))) return undefined
  const gap = 8 - head.length - tail.length - extra
  if (halves.length === 1 ? gap !== 0 : gap < 1) return undefined
  return [...head, ...Array.from({ length: gap }, () => '0'), ...tail]
}

/**
 * The fairness prefix of a client address, as the self-hosted relay computes it: /24 for IPv4 (IPv4-mapped included) and
 * /48 for IPv6. The Worker turns `CF-Connecting-IP` into this and passes only the prefix on; the full address is never
 * stored, logged or sent to the node object. Throws on anything that is not an address.
 */
export function edgeAddressPrefix(input: string): string {
  let address = input.toLowerCase()
  if (address.startsWith('::ffff:') && V4.test(address.slice(7))) address = address.slice(7)
  if (V4.test(address)) return `${address.split('.').slice(0, 3).join('.')}.0/24`
  const groups = ipv6Groups(address)
  if (!groups) throw new RangeError('Invalid peer address')
  return `${groups
    .slice(0, 3)
    .map(value => Number.parseInt(value, 16).toString(16))
    .join(':')}::/48`
}
