import { readFile } from 'node:fs/promises'
import { scryptSync, createPublicKey, verify, X509Certificate } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  ascii,
  decodePass,
  hex,
  holder,
  knock,
  makeProof,
  routeKey,
  serverBinding,
  unhex,
  verifyKnock,
  verifyProof,
  decodeAddressBook,
  encodeAddressBook,
  addressBookSigningInput,
  decodeMessage,
  encodeMessage,
  denyBatchInput,
  denyBatchDigest,
  discoveryEpochInput,
  registrationWorkInput,
  workDigestMeetsBits,
  REGISTRATION_WORK,
  mdnsDigest,
  mdnsSigningInput,
  mdnsTarget,
  gatewaySigningInput,
  gatewayHash,
  encodePaddingCell,
  verifyRelayDirectory,
  relayAuthorityInput,
  relayDirectoryInput,
} from '@latch/link-wire'
import { NativeAddressBookCache } from '../src/address-book.ts'
import { nodeCrypto } from '../src/crypto.ts'
import { verifyNativeRevocation } from '../src/revocation.ts'
import { nativeRevocationInput } from '@latch/link-wire'
import { nativeKnockSecret, nativeRecoverySecret, nativeVerificationText, nativeWindowSecret, pairingCode } from '@latch/link-wire'

it('matches offline authority and online directory signing bytes with the shared Swift vector', async () => {
  const { directory: v } = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as {
    directory: Record<string, string | number>
  }
  const bytes = (key: string) => unhex(String(v[key]))
  expect(hex(relayAuthorityInput(bytes('authority')))).toBe(v.authorityInput)
  expect(hex(relayDirectoryInput(bytes('addresses')))).toBe(v.addressesInput)
  const checked = await verifyRelayDirectory(
    nodeCrypto,
    { authority: bytes('authority'), rootSignature: bytes('rootSignature'), directory: bytes('addresses'), signature: bytes('signature') },
    [bytes('root')],
    Number(v.now),
  )
  expect(hex(checked.checkpoint.rootHash)).toBe(v.rootHash)
  expect(hex(checked.checkpoint.hash)).toBe(v.hash)
})

it('matches authenticated padding cell bytes with the shared Swift vector', async () => {
  const { padding } = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as {
    padding: { payload: string; small: string; largeDummyHash: string }
  }
  expect(hex(encodePaddingCell(unhex(padding.payload)))).toBe(padding.small)
  expect(hex(await nodeCrypto.hash(encodePaddingCell(new Uint8Array(), true)))).toBe(padding.largeDummyHash)
})

it('accepts credential removal only for the fixed Root and current device revocation vector', async () => {
  const { nativeRevocation: vector } = JSON.parse(
    await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8'),
  ) as {
    nativeRevocation: {
      rootSpki: string
      hostId: string
      deviceId: string
      revokedAt: number
      input: string
      tombstoneHash: string
      signature: string
    }
  }
  const { rootSpki, input, tombstoneHash, ...revocation } = vector,
    identity = { ...revocation, rootSpki: unhex(rootSpki) }
  expect(hex(nativeRevocationInput(vector.hostId, vector.deviceId, vector.revokedAt))).toBe(input)
  expect(hex(await nodeCrypto.hash(unhex(input)))).toBe(tombstoneHash)
  expect(verifyNativeRevocation(revocation, identity)).toEqual(revocation)
  for (const item of [
    { ...revocation, deviceId: `dev_${'X'.repeat(22)}` },
    { ...revocation, revokedAt: revocation.revokedAt + 1 },
    { ...revocation, signature: 'A'.repeat(86) },
  ])
    expect(() => verifyNativeRevocation(item, identity)).toThrow()
  expect(() => verifyNativeRevocation(revocation, { ...identity, rootSpki: new Uint8Array(91) })).toThrow()
})

it('matches private discovery and durable DENY acknowledgement shared vectors', async () => {
  const vector = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as {
    discovery: {
      key: string
      day: number
      epoch: { input: string; hash: string }
      names: Array<{ alternate: boolean; input: string; digest: string; label: string; target: string }>
      gateways: Array<{ address: string; prefixLength: number; gateway: string; input: string; hash: string }>
    }
    denyAck: { routeId: string; tags: string[]; input: string; digest: string; count: number; encoded: string }
  }
  expect(hex(discoveryEpochInput(unhex(vector.discovery.key)))).toBe(vector.discovery.epoch.input)
  expect(hex(await nodeCrypto.hash(discoveryEpochInput(unhex(vector.discovery.key))))).toBe(vector.discovery.epoch.hash)
  for (const name of vector.discovery.names) {
    expect(hex(mdnsSigningInput(vector.discovery.day, name.alternate))).toBe(name.input)
    expect(hex(await mdnsDigest(nodeCrypto, unhex(vector.discovery.key), vector.discovery.day, name.alternate))).toBe(name.digest)
    expect(mdnsTarget(name.label)).toBe(name.target)
  }
  for (const network of vector.discovery.gateways) {
    expect(hex(gatewaySigningInput(network.address, network.prefixLength, network.gateway))).toBe(network.input)
    expect(hex(await gatewayHash(nodeCrypto, network.address, network.prefixLength, network.gateway))).toBe(network.hash)
  }
  const ack = vector.denyAck,
    id = unhex(ack.routeId),
    batch = ack.tags.map(tag => unhex(tag))
  expect(hex(denyBatchInput(id, batch))).toBe(ack.input)
  expect(hex(await denyBatchDigest(nodeCrypto, id, batch))).toBe(ack.digest)
  expect(hex(encodeMessage({ type: 'deny-ack', routeId: id, digest: unhex(ack.digest), count: ack.count }))).toBe(ack.encoded)
  expect(decodeMessage(unhex(ack.encoded))).toEqual({ type: 'deny-ack', routeId: id, digest: unhex(ack.digest), count: ack.count })
})

it('matches the signed connection-book and route membership removal vectors', async () => {
  const vector = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as {
    addressBook: {
      rootSpki: string
      hostId: string
      deviceId: string
      generation: number
      issuedAt: number
      expiresAt: number
      payload: string
      signingInput: string
      payloadHash: string
      encoded: string
    }
    drop: { routeId: string; encoded: string }
  }
  const item = vector.addressBook,
    payload = unhex(item.payload),
    book = decodeAddressBook(payload)
  expect(hex(encodeAddressBook(book))).toBe(item.payload)
  expect(hex(addressBookSigningInput(payload))).toBe(item.signingInput)
  expect(book.deviceId).toBe(item.deviceId)
  vi.useFakeTimers()
  try {
    vi.setSystemTime(item.issuedAt)
    const cache = new NativeAddressBookCache()
    const verified = cache.accept(item.encoded, unhex(item.rootSpki), item)
    expect(verified.generation).toBe(item.generation)
    expect(cache.current()?.hash).toBe(item.payloadHash)
  } finally {
    vi.useRealTimers()
  }
  expect(hex(encodeMessage({ type: 'drop', routeId: unhex(vector.drop.routeId) }))).toBe(vector.drop.encoded)
  expect(decodeMessage(unhex(vector.drop.encoded)).type).toBe('drop')
})

it('retains the registered SPKI across the shared expired and renewed device certificate vectors', async () => {
  const { deviceCertificates: vector } = JSON.parse(
    await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8'),
  ) as {
    deviceCertificates: {
      connectionSpki: string
      issuerSpki: string
      enrolled: string
      renewed: string
      anchor: string
      renewalTimeMs: number
    }
  }
  const old = new X509Certificate(Buffer.from(vector.enrolled, 'hex')),
    renewed = new X509Certificate(Buffer.from(vector.renewed, 'hex')),
    anchor = new X509Certificate(Buffer.from(vector.anchor, 'hex'))
  for (const certificate of [old, renewed, anchor])
    expect(certificate.publicKey.export({ format: 'der', type: 'spki' }).toString('hex')).toBe(vector.connectionSpki)
  expect(Date.parse(old.validTo)).toBeLessThan(vector.renewalTimeMs)
  expect(Date.parse(renewed.validFrom)).toBeLessThanOrEqual(vector.renewalTimeMs)
  expect(Date.parse(renewed.validTo)).toBeGreaterThan(vector.renewalTimeMs)
  expect(renewed.verify(renewed.publicKey)).toBe(true)
  expect(anchor.verify(createPublicKey({ key: Buffer.from(vector.issuerSpki, 'hex'), format: 'der', type: 'spki' }))).toBe(true)
  expect(renewed.issuer).toBe(anchor.subject)
  expect(renewed.ca).toBe(false)
  expect(anchor.ca).toBe(true)
})

it('matches the cross-platform KDF, pass, proof and knock vectors and rejects path substitution', async () => {
  const vector = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as Record<
    string,
    string | number
  >
  const bytes = (name: string) => unhex(String(vector[name]))
  const crypto = { ...nodeCrypto, random: (size: number) => new Uint8Array(size).fill(85) },
    day = Number(vector.day),
    timeMs = Number(vector.timeMs)
  expect(hex(await routeKey(crypto, bytes('seed'), bytes('relayId'), day))).toBe(vector.routeKey)
  const device = await holder(crypto, bytes('seed'), bytes('relayId'), ascii(String(vector.deviceId)), day)
  expect(hex(device.seed)).toBe(vector.holderSeed)
  expect(hex(device.tag)).toBe(vector.tag)
  expect(hex(await crypto.publicKey(device.seed))).toBe(vector.holderPub)
  const proof = await makeProof(crypto, device.seed, bytes('pass'), timeMs)
  expect(hex(proof.signature)).toBe(vector.proof)
  expect(await verifyProof(crypto, bytes('relayId'), proof, timeMs)).toEqual(decodePass(bytes('pass')))
  expect(await verifyProof(crypto, bytes('relayId'), proof, timeMs + 180_000)).toBeNull()
  const altered = bytes('pass')
  altered[94] = altered[94]! ^ 1
  expect(await verifyProof(crypto, bytes('relayId'), { ...proof, pass: altered }, timeMs)).toBeNull()
  expect(hex(await knock(crypto, bytes('knockKey'), { path: 'direct' }, timeMs, bytes('nonce')))).toBe(vector.knock)
  expect(await verifyKnock(crypto, bytes('knockKey'), { path: 'direct' }, timeMs + 60_000, bytes('knock'))).toBe(true)
  expect(
    await verifyKnock(
      crypto,
      bytes('knockKey'),
      { path: 'relay', relayId: bytes('relayId'), routeId: new Uint8Array(16) },
      timeMs,
      bytes('knock'),
    ),
  ).toBe(false)
  expect(hex(await serverBinding(crypto, bytes('knockKey'), { path: 'direct' }, bytes('nonce'), ascii(String(vector.certificate))))).toBe(
    vector.serverBinding,
  )
})

it('pins the native pairing code and P-256 verification statement across implementations', async () => {
  const vector = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as {
    pairing: {
      invitationHash: string
      connectionSpki: string
      verificationSpki: string
      code: string
      knockSecret: string
      knockHash: string
    }
    nativeVerification: {
      hostId: string
      deviceId: string
      nonce: string
      expiresAt: number
      appOpenId: string
      text: string
      verificationSpki: string
      signature: string
      recoverySecret: string
      recoveryHash: string
      issuerKey: string
      windowSecret: string
    }
  }
  const pair = vector.pairing,
    statement = vector.nativeVerification
  const secret = await nativeKnockSecret(nodeCrypto, unhex(pair.invitationHash), unhex(pair.connectionSpki), unhex(pair.verificationSpki))
  expect(hex(secret)).toBe(pair.knockSecret)
  expect(hex(await nodeCrypto.hash(secret))).toBe(pair.knockHash)
  expect(await pairingCode(nodeCrypto, unhex(pair.invitationHash), unhex(pair.connectionSpki), unhex(pair.verificationSpki))).toBe(
    pair.code,
  )
  expect(nativeVerificationText(statement.hostId, statement.deviceId, statement.nonce, statement.expiresAt, statement.appOpenId)).toBe(
    statement.text,
  )
  const recovery = await nativeRecoverySecret(nodeCrypto, statement.text, unhex(statement.signature))
  expect(hex(recovery)).toBe(statement.recoverySecret)
  const recoveryHash = await nodeCrypto.hash(ascii(`lnp1.${Buffer.from(recovery).toString('base64url')}`))
  expect(hex(recoveryHash)).toBe(statement.recoveryHash)
  expect(hex(await nativeWindowSecret(nodeCrypto, unhex(statement.issuerKey), recoveryHash))).toBe(statement.windowSecret)
  expect(await nativeRecoverySecret(nodeCrypto, statement.text, new Uint8Array(64))).not.toEqual(recovery)
  await expect(nativeRecoverySecret(nodeCrypto, statement.text, new Uint8Array(65))).rejects.toThrow()
  const key = createPublicKey({ key: Buffer.from(statement.verificationSpki, 'hex'), format: 'der', type: 'spki' })
  expect(verify('sha256', Buffer.from(statement.text), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(statement.signature, 'hex'))).toBe(
    true,
  )
  expect(
    verify('sha256', Buffer.from(`${statement.text}x`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(statement.signature, 'hex')),
  ).toBe(false)
})

it('matches the fixed memory-work registration transcript and scrypt vector', async () => {
  const vectors = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as {
    registrationWork: {
      relayId: string
      routeId: string
      helloNonce: string
      workNonce: string
      register: string
      solution: string
      bits: number
      input: string
      digest: string
      challenge: string
      proof: string
    }
  }
  const v = vectors.registrationWork,
    nonce = unhex(v.workNonce),
    route = unhex(v.relayId)
  const input = registrationWorkInput(route, unhex(v.helloNonce), nonce, unhex(v.register), unhex(v.solution))
  expect(hex(input)).toBe(v.input)
  const hash = scryptSync(input, nonce, REGISTRATION_WORK.keyLength, {
    N: REGISTRATION_WORK.N,
    r: REGISTRATION_WORK.r,
    p: REGISTRATION_WORK.p,
    maxmem: REGISTRATION_WORK.maxMemory,
  })
  expect(hash.toString('hex')).toBe(v.digest)
  expect(workDigestMeetsBits(hash, v.bits)).toBe(true)
  expect(decodeMessage(unhex(v.challenge))).toEqual({ type: 'registration-work', routeId: unhex(v.routeId), nonce, bits: v.bits })
  expect(decodeMessage(unhex(v.proof))).toEqual({
    type: 'registration-proof',
    routeId: unhex(v.routeId),
    nonce,
    solution: unhex(v.solution),
  })
})
