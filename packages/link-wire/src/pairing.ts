import { ascii, concat, field, fixed, Reader } from './bytes.ts'
import type { LinkCrypto } from './crypto.ts'

export async function nativeKnockSecret(
  crypto: LinkCrypto,
  invitationHash: Uint8Array,
  connectionSpki: Uint8Array,
  verificationSpki: Uint8Array,
): Promise<Uint8Array> {
  if (connectionSpki.length > 256 || verificationSpki.length > 256) throw new RangeError('Pairing key too large')
  return crypto.derive(
    fixed(invitationHash, 32),
    await crypto.hash(connectionSpki),
    concat(ascii('latch-native-knock-key-v1\0'), field(verificationSpki)),
    32,
  )
}

export async function pairingCode(
  crypto: LinkCrypto,
  invitationHash: Uint8Array,
  connectionSpki: Uint8Array,
  verificationSpki: Uint8Array,
): Promise<string> {
  if (connectionSpki.length > 256 || verificationSpki.length > 256) throw new RangeError('Pairing key too large')
  const digest = await crypto.hash(
    concat(ascii('latch-native-pair-code-v1\0'), fixed(invitationHash, 32), field(connectionSpki), field(verificationSpki)),
  )
  return String(new Reader(digest.slice(0, 4)).number(4) % 1_000_000).padStart(6, '0')
}

export function nativeVerificationText(hostId: string, deviceId: string, nonce: string, expiresAt: number, appOpenId: string): string {
  if (
    !/^[a-z2-7]{52}$/u.test(hostId)
    || !/^dev_[A-Za-z0-9_-]{22}$/u.test(deviceId)
    || !/^[A-Za-z0-9_-]{16,80}$/u.test(nonce)
    || !/^[A-Za-z0-9_-]{16,80}$/u.test(appOpenId)
    || !Number.isSafeInteger(expiresAt)
    || expiresAt < 0
  )
    throw new RangeError('Invalid native verification statement')
  return `latch-native-verify-v1\n${hostId}\n${deviceId}\n${nonce}\n${expiresAt}\n${appOpenId}`
}

/** Derived before sending a verification, so a lost acknowledgement never requires a second signature. */
export async function nativeRecoverySecret(crypto: LinkCrypto, statement: string, signature: Uint8Array): Promise<Uint8Array> {
  if (statement.length > 512 || !statement.startsWith('latch-native-verify-v1\n'))
    throw new RangeError('Invalid native verification statement')
  return crypto.hash(concat(ascii('latch-native-recovery-v1\0'), field(ascii(statement)), fixed(signature, 64)))
}

/** The boot-only issuer key lets the Host reissue the same receipt while retaining only secret hashes. */
export async function nativeWindowSecret(crypto: LinkCrypto, issuerKey: Uint8Array, recoveryHash: Uint8Array): Promise<Uint8Array> {
  return crypto.hmac(fixed(issuerKey, 32), concat(ascii('latch-native-window-v1\0'), fixed(recoveryHash, 32)))
}
