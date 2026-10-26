import { ascii } from './bytes.ts'

export function nativeRevocationInput(hostId: string, deviceId: string, revokedAt: number): Uint8Array {
  if (!/^[a-z2-7]{52}$/u.test(hostId) || !/^dev_[A-Za-z0-9_-]{22}$/u.test(deviceId) || !Number.isSafeInteger(revokedAt) || revokedAt < 0)
    throw new RangeError('Invalid native revocation')
  return ascii(`latch-native-revoked-v1\n${hostId}\n${deviceId}\n${revokedAt}`)
}
