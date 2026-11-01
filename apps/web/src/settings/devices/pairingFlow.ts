import type { NativePairingStatus } from '@latch/protocol'

/** The QR changes without notice; the one before it stays valid until it expires, so a scan in progress still lands. */
export const QR_REFRESH_MS = 60_000

export interface IssuedQr {
  id: string
  at: number
}

export type PairingRead =
  /** The Host ended every QR of this sheet, and removed any phone it paired, even during the question. */
  | { kind: 'contended' }
  | { kind: 'done'; id: string; device: string; deviceId?: string }
  /** Only the QRs that were used: a sibling is still live, and closing the sheet must still reach it. */
  | { kind: 'ended'; ids: string[]; state: 'cancelled' | 'timeout' }
  /** A device is being confirmed: the QR stands still, so a second phone scans the same one and burns the sheet. */
  | { kind: 'busy'; state: 'confirming' | 'approved'; device?: string }
  | { kind: 'refresh' }
  | { kind: 'idle' }

/** What the sheet does next, from the Host's answer about each QR it has issued, oldest first. */
export function readPairing(issued: readonly IssuedQr[], answers: ReadonlyArray<NativePairingStatus | null>, now: number): PairingRead {
  if (answers.some(answer => answer?.state === 'contended')) return { kind: 'contended' }
  const finished = answers.findIndex(answer => answer?.state === 'done')
  if (finished >= 0) {
    const answer = answers[finished]!
    return {
      kind: 'done',
      id: issued[finished]!.id,
      device: answer.device ?? '',
      ...(answer.deviceId ? { deviceId: answer.deviceId } : {}),
    }
  }
  const ended = answers.flatMap((answer, index) =>
    answer?.state === 'cancelled' || answer?.state === 'timeout' ? [{ id: issued[index]!.id, state: answer.state }] : [],
  )
  if (ended.length > 0) return { kind: 'ended', ids: ended.map(item => item.id), state: ended[0]!.state }
  const busy = answers.find(answer => answer?.state === 'confirming' || answer?.state === 'approved')
  if (busy) return { kind: 'busy', state: busy.state as 'confirming' | 'approved', ...(busy.device ? { device: busy.device } : {}) }
  const newest = issued.at(-1)
  if (newest && (answers.at(-1)?.state === 'expired' || now - newest.at >= QR_REFRESH_MS)) return { kind: 'refresh' }
  return { kind: 'idle' }
}
