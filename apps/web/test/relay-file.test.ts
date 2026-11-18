import { expect, it } from 'vitest'
import { readRelayProfile } from '../src/settings/RelaySettings.tsx'

const self = { relayId: 'a'.repeat(32), url: 'https://relay.example/', spkiHash: 'b'.repeat(64) }
const edge = { relayId: 'c'.repeat(32), url: 'https://relay.example/', kind: 'edge', relayKey: 'd'.repeat(64) }

it('reads only relay addresses the Host and the signed address book accept', () => {
  expect(readRelayProfile(JSON.stringify({ version: 1, profile: self }))).toEqual(self)
  expect(readRelayProfile(JSON.stringify({ version: 2, profile: { ...edge, extraUrls: ['https://other.example:8443/'] } }))).toEqual({
    ...edge,
    extraUrls: ['https://other.example:8443/'],
  })
  for (const url of ['https://relay.example/?', 'https://relay.example/#', 'https://a_b.example/', 'https://Relay.example/']) {
    expect(() => readRelayProfile(JSON.stringify({ version: 1, profile: { ...self, url } }))).toThrow()
    expect(() => readRelayProfile(JSON.stringify({ version: 2, profile: { ...edge, extraUrls: [url] } }))).toThrow()
  }
})
