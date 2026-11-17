import { concat, type LinkCrypto } from '@latch/link-wire'
import type { EdgeSubtle } from './platform.ts'

const PKCS8_ED25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function base64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) throw new RangeError('Invalid base64url')
  const out: number[] = []
  let bits = 0,
    value = 0
  for (const char of text) {
    value = (value << 6) | ALPHABET.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((value >> bits) & 255)
    }
  }
  return Uint8Array.from(out)
}

/** LinkCrypto over WebCrypto, which the Workers runtime and Node both provide; the tests compare it with Node's. */
export function webLinkCrypto(subtle: EdgeSubtle, random: (size: number) => Uint8Array): LinkCrypto {
  const privateKey = (seed: Uint8Array, extractable = false) => {
    if (seed.length !== 32) throw new RangeError('Expected Ed25519 seed')
    return subtle.importKey('pkcs8', concat(PKCS8_ED25519, seed), { name: 'Ed25519' }, extractable, ['sign'])
  }
  return {
    random,
    hash: async input => new Uint8Array(await subtle.digest('SHA-256', input)),
    hmac: async (key, input) => {
      const imported = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      return new Uint8Array(await subtle.sign('HMAC', imported, input))
    },
    derive: async (seed, salt, info, size) => {
      const imported = await subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits'])
      return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, imported, size * 8))
    },
    publicKey: async seed => {
      const jwk = await subtle.exportKey('jwk', await privateKey(seed, true))
      const key = base64url(jwk.x ?? '')
      if (key.length !== 32) throw new Error('Ed25519 export failed')
      return key
    },
    sign: async (seed, input) => new Uint8Array(await subtle.sign('Ed25519', await privateKey(seed), input)),
    verify: async (publicKey, input, signature) => {
      if (publicKey.length !== 32 || signature.length !== 64) return false
      try {
        const key = await subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify'])
        return await subtle.verify('Ed25519', key, signature, input)
      } catch {
        return false
      }
    },
  }
}
