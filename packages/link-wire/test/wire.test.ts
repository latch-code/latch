import { describe, expect, it } from 'vitest'
import {
  concat,
  decodeMessage,
  decodePass,
  encodeFrame,
  encodeMessage,
  encodePass,
  PathGeneration,
  Reader,
  ResumeLog,
  uint,
  WebSocketParser,
  type AdmissionPass,
  type RelayMessage,
} from '../src/index.ts'

describe('bounded binary link records', () => {
  it('rejects overflows, truncated, reserved and trailing fields', () => {
    expect(() => uint(Number.MAX_SAFE_INTEGER + 1, 8)).toThrow()
    expect(() => new Reader(new Uint8Array(1)).number(2)).toThrow()
    expect(() => decodeMessage(new Uint8Array([32, 1, 0]))).toThrow()
    expect(() => decodeMessage(new Uint8Array([65, ...new Uint8Array(48), 3]))).toThrow()
    expect(() => decodeMessage(new Uint8Array([255]))).toThrow()
    const pass: AdmissionPass = {
      pairing: false,
      relayId: new Uint8Array(16),
      day: 1,
      notBefore: 1,
      notAfter: 2,
      routePub: new Uint8Array(32),
      holderPub: new Uint8Array(32),
      tag: new Uint8Array(16),
      signature: new Uint8Array(64),
    }
    expect(encodePass(pass)).toHaveLength(174)
    const reserved = encodePass(pass)
    reserved[1] = 2
    expect(() => decodePass(reserved)).toThrow()
    expect(() => decodePass(concat(encodePass(pass), uint(0, 1)))).toThrow()
  })
  it('round trips every control class with coalesced and fragmented network chunks', () => {
    const messages: RelayMessage[] = [
      { type: 'hello' },
      { type: 'challenge', relayId: new Uint8Array(16), nonce: new Uint8Array(32), timeMs: 1_700_000_000_000, requiresToken: true },
      {
        type: 'register',
        previous: new Uint8Array(32),
        day: 10,
        routePub: new Uint8Array(32),
        signature: new Uint8Array(64),
        regMac: new Uint8Array(16),
        alternate: false,
      },
      { type: 'registration-work', routeId: new Uint8Array(16), nonce: new Uint8Array(32), bits: 22 },
      { type: 'registration-proof', routeId: new Uint8Array(16), nonce: new Uint8Array(32), solution: new Uint8Array(8) },
      { type: 'registered', token: new Uint8Array(32), routeId: new Uint8Array(16), status: 4 },
      { type: 'open', connection: new Uint8Array(8), routeId: new Uint8Array(16) },
      { type: 'attach', routeId: new Uint8Array(16), connection: new Uint8Array(8), nonce: new Uint8Array(16), mac: new Uint8Array(16) },
      { type: 'attached' },
      { type: 'admitted' },
      { type: 'deny', routeId: new Uint8Array(16), tags: [new Uint8Array(16)] },
      { type: 'deny-ack', routeId: new Uint8Array(16), digest: new Uint8Array(32), count: 8192 },
      { type: 'drop', routeId: new Uint8Array(16) },
      { type: 'depart', state: 2 },
      { type: 'unavailable', state: 1, since: 1 },
      { type: 'goaway', reason: 3, retryAfterMs: 5000 },
      { type: 'spliced', connection: new Uint8Array(8), passTag: new Uint8Array(16) },
      { type: 'data', data: new Uint8Array(16_384).fill(7) },
    ]
    const bytes = concat(
      ...messages.map(message => encodeFrame({ opcode: 2, payload: encodeMessage(message) }, new Uint8Array([4, 3, 2, 1]))),
    )
    for (const size of [1, 7, bytes.length]) {
      const parser = new WebSocketParser(true),
        output: RelayMessage[] = []
      for (let at = 0; at < bytes.length; at += size)
        for (const frame of parser.feed(bytes.slice(at, at + size))) output.push(decodeMessage(frame.payload))
      expect(output).toEqual(messages)
    }
    expect(() => new WebSocketParser(true).feed(new Uint8Array([0x82, 0]))).toThrow()
    expect(() => new WebSocketParser(false).feed(new Uint8Array([0x02, 0]))).toThrow()
    expect(() => new WebSocketParser(false).feed(new Uint8Array([0x82, 127, 0, 0, 0, 0, 0, 2, 0, 0]))).toThrow()
  })
  it('returns missed events or an explicit checkpoint across compaction and Host epochs', () => {
    const log = new ResumeLog<string>('boot-a', 2)
    log.append('one')
    log.append('two')
    log.append('three')
    expect(log.resume('boot-a', 1, () => 'snapshot')).toMatchObject({
      kind: 'events',
      events: [
        { sequence: 2, value: 'two' },
        { sequence: 3, value: 'three' },
      ],
    })
    expect(log.resume('boot-a', 0, () => 'snapshot')).toMatchObject({ kind: 'snapshot', value: 'snapshot', sequence: 3 })
    expect(log.resume('boot-old', 3, () => 'snapshot')).toMatchObject({ kind: 'snapshot' })
    const generation = new PathGeneration(),
      first = generation.begin()
    generation.changeNetwork()
    expect(generation.current(first)).toBe(false)
  })
  it('evicts by bytes as well as event count and never accepts an oversized or invalid measurement', () => {
    const log = new ResumeLog<string>('bounded', 4, { maxBytes: 5, measure: value => value.length })
    log.append('123')
    log.append('456')
    expect(log.currentSequence()).toBe(2)
    expect(log.resume('bounded', 0, () => 'snapshot').kind).toBe('snapshot')
    expect(log.resume('bounded', 1, () => 'snapshot')).toMatchObject({ kind: 'events', events: [{ sequence: 2, value: '456' }] })
    expect(() => log.append('123456')).toThrow()
    expect(log.currentSequence()).toBe(2)
    expect(() => new ResumeLog('invalid', 1, { maxBytes: 0, measure: () => 0 })).toThrow()
  })
})
