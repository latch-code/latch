import { expect, it } from 'vitest'
import {
  discoveryDays,
  discoveryEpochInput,
  gatewaySigningInput,
  hex,
  isPrivateDiscoveryAddress,
  isDiscoveryPeer,
  mdnsSigningInput,
  mdnsTarget,
  parseIp,
  sameSubnet,
  subnetBytes,
} from '../src/index.ts'

it('searches only the current date and the nearest adjacent date, without trusting network time', () => {
  expect(discoveryDays(20000 * 86400000 + 1000)).toEqual([20000, 19999])
  expect(discoveryDays(20000 * 86400000 + 80000000)).toEqual([20000, 20001])
  expect(discoveryDays(0)).toEqual([0, 1])
  expect(() => discoveryDays(-1)).toThrow()
  expect(hex(mdnsSigningInput(20000))).not.toBe(hex(mdnsSigningInput(20000, true)))
  expect(mdnsTarget('75253tsynaig')).toBe('l-75253tsynaig.local')
  expect(() => mdnsTarget('MacBook')).toThrow()
})
it('rejects stale subnet, own addresses and IPv4 network or broadcast discovery records', () => {
  for (const peer of ['192.168.1.0', '192.168.1.255', '192.168.1.4', '192.168.2.4', '8.8.8.8'])
    expect(isDiscoveryPeer(peer, '192.168.1.4', 24, ['192.168.1.4'])).toBe(false)
  expect(isDiscoveryPeer('192.168.1.5', '192.168.1.4', 24, ['192.168.1.4'])).toBe(true)
  expect(isDiscoveryPeer('fd01::5', 'fd01::4', 64, ['fd01::4'])).toBe(true)
})
it('normalizes equivalent IP spellings, rejects malformed addresses, and masks exact subnet boundaries', () => {
  expect(hex(parseIp('::ffff:192.168.1.4').bytes)).toBe('c0a80104')
  expect(hex(parseIp('fd00:0:0:0:0:0:0:1').bytes)).toBe(hex(parseIp('fd00::1').bytes))
  expect(hex(subnetBytes(parseIp('192.168.1.191'), 25))).toBe('c0a80180')
  expect(sameSubnet('192.168.1.128', '192.168.1.255', 25)).toBe(true)
  expect(sameSubnet('192.168.1.127', '192.168.1.128', 25)).toBe(false)
  expect(sameSubnet('fd00:1234::1', 'fd00:1234::ffff', 64)).toBe(true)
  for (const address of [':::', '1:2:3:4:5:6:7:8::', 'fd00::1::2', 'fe80::1%en0', '192.168.01.1', '256.1.1.1', '1.2.3', 'a:b', ':a', 'a:'])
    expect(() => parseIp(address)).toThrow()
})
it('admits only private or link-local discovery hints, excluding metadata, loopback, public and multicast', () => {
  for (const address of ['10.1.2.3', '192.168.1.4', '172.16.0.1', '100.64.0.1', '169.254.1.1', 'fd01::1', 'fe80::1'])
    expect(isPrivateDiscoveryAddress(address)).toBe(true)
  for (const address of ['127.0.0.1', '0.0.0.0', '8.8.8.8', '224.0.0.1', '169.254.169.254', 'fd00:ec2::254', '::1', 'ff02::1'])
    expect(isPrivateDiscoveryAddress(address)).toBe(false)
})
it('binds a gateway to the binary subnet and rejects a different gateway or family', () => {
  expect(hex(gatewaySigningInput('192.168.1.4', 24, '192.168.1.1'))).toBe(hex(gatewaySigningInput('192.168.1.230', 24, '192.168.1.1')))
  expect(hex(gatewaySigningInput('192.168.1.4', 24, '192.168.1.1'))).not.toBe(hex(gatewaySigningInput('192.168.1.4', 24, '192.168.1.2')))
  expect(() => gatewaySigningInput('fd00::1', 64, '192.168.1.1')).toThrow()
})

it('bounds the stable discovery cache hint input and separates it from daily anonymous names', () => {
  expect(() => discoveryEpochInput(new Uint8Array(31))).toThrow()
  expect(() => discoveryEpochInput(new Uint8Array(33))).toThrow()
  expect(discoveryEpochInput(new Uint8Array(32))).toHaveLength(57)
  expect(hex(discoveryEpochInput(new Uint8Array(32)))).not.toBe(hex(mdnsSigningInput(20000)))
})
