import { REGISTRATION_WORK, workDigestMeetsBits } from '@latch/link-wire'
import type { EdgeSubtle } from './platform.ts'

function salsa208(block: Uint32Array, x: Uint32Array): void {
  x.set(block)
  const r = (a: number, b: number) => (a << b) | (a >>> (32 - b))
  for (let i = 0; i < 8; i += 2) {
    x[4]! ^= r(x[0]! + x[12]!, 7)
    x[8]! ^= r(x[4]! + x[0]!, 9)
    x[12]! ^= r(x[8]! + x[4]!, 13)
    x[0]! ^= r(x[12]! + x[8]!, 18)
    x[9]! ^= r(x[5]! + x[1]!, 7)
    x[13]! ^= r(x[9]! + x[5]!, 9)
    x[1]! ^= r(x[13]! + x[9]!, 13)
    x[5]! ^= r(x[1]! + x[13]!, 18)
    x[14]! ^= r(x[10]! + x[6]!, 7)
    x[2]! ^= r(x[14]! + x[10]!, 9)
    x[6]! ^= r(x[2]! + x[14]!, 13)
    x[10]! ^= r(x[6]! + x[2]!, 18)
    x[3]! ^= r(x[15]! + x[11]!, 7)
    x[7]! ^= r(x[3]! + x[15]!, 9)
    x[11]! ^= r(x[7]! + x[3]!, 13)
    x[15]! ^= r(x[11]! + x[7]!, 18)
    x[1]! ^= r(x[0]! + x[3]!, 7)
    x[2]! ^= r(x[1]! + x[0]!, 9)
    x[3]! ^= r(x[2]! + x[1]!, 13)
    x[0]! ^= r(x[3]! + x[2]!, 18)
    x[6]! ^= r(x[5]! + x[4]!, 7)
    x[7]! ^= r(x[6]! + x[5]!, 9)
    x[4]! ^= r(x[7]! + x[6]!, 13)
    x[5]! ^= r(x[4]! + x[7]!, 18)
    x[11]! ^= r(x[10]! + x[9]!, 7)
    x[8]! ^= r(x[11]! + x[10]!, 9)
    x[9]! ^= r(x[8]! + x[11]!, 13)
    x[10]! ^= r(x[9]! + x[8]!, 18)
    x[12]! ^= r(x[15]! + x[14]!, 7)
    x[13]! ^= r(x[12]! + x[15]!, 9)
    x[14]! ^= r(x[13]! + x[12]!, 13)
    x[15]! ^= r(x[14]! + x[13]!, 18)
  }
  for (let i = 0; i < 16; i++) block[i] = (block[i]! + x[i]!) | 0
}

/** BlockMix with salsa20/8 over 2r 64-byte blocks, writing into `out`. */
function blockMix(input: Uint32Array, out: Uint32Array, r: number, t: Uint32Array, x: Uint32Array): void {
  t.set(input.subarray((2 * r - 1) * 16, 2 * r * 16))
  for (let i = 0; i < 2 * r; i++) {
    for (let j = 0; j < 16; j++) t[j]! ^= input[i * 16 + j]!
    salsa208(t, x)
    out.set(t, ((i & 1) * r + (i >> 1)) * 16)
  }
}

/**
 * scrypt (RFC 7914) for the registration-work parameters, in plain TypeScript over WebCrypto's PBKDF2. It runs only in
 * the stateless work Worker, never in a node object. The tests check it against Node's scrypt.
 */
export async function scrypt(subtle: EdgeSubtle, password: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const { N, r, p, keyLength } = REGISTRATION_WORK
  const words = 32 * r
  const key = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits'])
  const bytes = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1 }, key, p * 128 * r * 8))
  const view = new DataView(bytes.buffer)
  const v = new Uint32Array(N * words),
    xBlock = new Uint32Array(words),
    yBlock = new Uint32Array(words),
    t = new Uint32Array(16),
    scratch = new Uint32Array(16)
  for (let block = 0; block < p; block++) {
    const offset = block * 128 * r
    for (let i = 0; i < words; i++) xBlock[i] = view.getUint32(offset + i * 4, true)
    for (let i = 0; i < N; i++) {
      v.set(xBlock, i * words)
      blockMix(xBlock, yBlock, r, t, scratch)
      xBlock.set(yBlock)
    }
    for (let i = 0; i < N; i++) {
      const j = xBlock[(2 * r - 1) * 16]! & (N - 1)
      for (let k = 0; k < words; k++) xBlock[k]! ^= v[j * words + k]!
      blockMix(xBlock, yBlock, r, t, scratch)
      xBlock.set(yBlock)
    }
    for (let i = 0; i < words; i++) view.setUint32(offset + i * 4, xBlock[i]!, true)
  }
  const final = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes, iterations: 1 }, final, keyLength * 8))
}

/** The work Worker's request: bits[1] || salt[32] || input (16–512 bytes). Bounded before any computation. */
function decodeWorkRequest(body: Uint8Array): { bits: number; salt: Uint8Array; input: Uint8Array } | undefined {
  if (body.length < 1 + 32 + 16 || body.length > 1 + 32 + 512) return undefined
  const bits = body[0]!
  if (bits > REGISTRATION_WORK.maxBits) return undefined
  return { bits, salt: body.slice(1, 33), input: body.slice(33) }
}
export function encodeWorkRequest(request: { bits: number; salt: Uint8Array; input: Uint8Array }): Uint8Array {
  const out = new Uint8Array(33 + request.input.length)
  out[0] = request.bits
  out.set(request.salt, 1)
  out.set(request.input, 33)
  return out
}
export async function checkWork(subtle: EdgeSubtle, body: Uint8Array): Promise<boolean> {
  const request = decodeWorkRequest(body)
  if (!request) return false
  return workDigestMeetsBits(await scrypt(subtle, request.input, request.salt), request.bits)
}
