import { createHash, createHmac, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, verify } from 'node:crypto'
import type { LinkCrypto } from '@latch/link-wire'
const prefix = Buffer.from('302e020100300506032b657004220420', 'hex')
const privateKey = (seed: Uint8Array) => {
  if (seed.length !== 32) throw new RangeError('Expected Ed25519 seed')
  return createPrivateKey({ key: Buffer.concat([prefix, seed]), format: 'der', type: 'pkcs8' })
}
export const nodeCrypto: LinkCrypto = {
  random: size => new Uint8Array(randomBytes(size)),
  hash: async input => new Uint8Array(createHash('sha256').update(input).digest()),
  hmac: async (key, input) => new Uint8Array(createHmac('sha256', key).update(input).digest()),
  derive: async (seed, salt, info, size) => new Uint8Array(hkdfSync('sha256', seed, salt, info, size)),
  publicKey: async seed => new Uint8Array(createPublicKey(privateKey(seed)).export({ format: 'der', type: 'spki' }).subarray(-32)),
  sign: async (seed, input) => new Uint8Array(sign(null, input, privateKey(seed))),
  verify: async (publicKey, input, signature) => {
    if (publicKey.length !== 32 || signature.length !== 64) return false
    try {
      const key = createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
        format: 'der',
        type: 'spki',
      })
      return verify(null, input, key, signature)
    } catch {
      return false
    }
  },
}
