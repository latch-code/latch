import type { NativeRelayProfile } from './devices.ts'
import { isRelayEndpoint } from './relay-endpoint.ts'

export const RELAY_FILE_BYTES = 4096

type RelayUrl = new (value: string) => { href: string }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function origin(value: unknown, Url: RelayUrl): value is string {
  if (typeof value !== 'string' || !isRelayEndpoint(value)) return false
  try {
    return new Url(value).href === value
  } catch {
    return false
  }
}

function otherOrigins(value: unknown, primary: string, Url: RelayUrl): value is string[] {
  return (
    Array.isArray(value)
    && value.length >= 1
    && value.length <= 3
    && value.every(item => origin(item, Url))
    && !value.includes(primary)
    && new Set(value).size === value.length
  )
}

/** The v1 self-hosted and v2 Workers file formats. Callers limit the input bytes before decoding it. */
export function parseRelayFile(text: string, Url: RelayUrl): { profile: NativeRelayProfile } | { failure: 'not-relay' | 'version' } {
  let file: unknown
  try {
    file = JSON.parse(text) as unknown
  } catch {
    return { failure: 'not-relay' }
  }
  if (!record(file)) return { failure: 'not-relay' }
  if (file.version !== 1 && file.version !== 2) return { failure: 'version' }
  const profile = file.profile
  if (!record(profile)) return { failure: 'not-relay' }
  const { relayId, url, registrationKey, spkiHash, kind, relayKey, extraUrls, shard } = profile
  if (
    typeof relayId !== 'string'
    || !/^[a-f0-9]{32}$/u.test(relayId)
    || !origin(url, Url)
    || (registrationKey != null && (typeof registrationKey !== 'string' || !/^lrt1\.[A-Za-z0-9_-]{43}$/u.test(registrationKey)))
  )
    return { failure: 'not-relay' }

  // The Host hashes the submitted profile for retry receipts. Preserve a legacy explicit null in that input.
  const shared = { relayId, url, ...(registrationKey === undefined ? {} : { registrationKey }) }
  const fields = Object.keys(profile)
  if (file.version === 1) {
    if (
      typeof spkiHash !== 'string'
      || !/^[a-f0-9]{64}$/u.test(spkiHash)
      || fields.some(key => !['relayId', 'url', 'registrationKey', 'spkiHash'].includes(key))
    )
      return { failure: 'not-relay' }
    return { profile: { ...shared, spkiHash } }
  }

  if (
    kind !== 'edge'
    || typeof relayKey !== 'string'
    || !/^[a-f0-9]{64}$/u.test(relayKey)
    || (extraUrls !== undefined && !otherOrigins(extraUrls, url, Url))
    || (shard !== undefined && (typeof shard !== 'number' || !Number.isInteger(shard) || shard < 0 || shard > 15))
    || fields.some(key => !['relayId', 'url', 'registrationKey', 'kind', 'relayKey', 'extraUrls', 'shard'].includes(key))
  )
    return { failure: 'not-relay' }
  return {
    profile: {
      ...shared,
      kind,
      relayKey,
      ...(extraUrls === undefined ? {} : { extraUrls }),
      ...(shard === undefined ? {} : { shard }),
    },
  }
}
