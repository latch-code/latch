import { z } from 'zod'
import { LISTENER_CLASSES } from '@latch/protocol'
import { count, deviceId, prefixed } from './fields.ts'

const listener = z.enum(LISTENER_CLASSES)
const scopes = z.array(z.enum(['view', 'run', 'approve:standard', 'approve:elevated', 'admin', 'secrets'])).max(6)
const dataScope = z.enum(['work', 'all'])
const deviceOnly = z.strictObject({ deviceId })
const ticket = z.strictObject({ ticketId: prefixed('chl') })

/** Devices: enrollment, invitations, offline codes, credentials, scopes and revocation. */
export const DEVICE_ACTIONS = {
  'device.enroll.requested': z.strictObject({
    enrollmentId: prefixed('enr'),
    listener,
    fingerprint: z.string().regex(/^[A-Z2-7]{20}$/u),
    scopes,
    invitationId: prefixed('inv').optional(),
  }),
  'device.enrolled': z.strictObject({
    deviceId,
    enrollmentId: prefixed('enr'),
    listener,
    method: z.enum(['lpc', 'offline', 'invitation']),
    scopes,
    dataScope,
    pairedByDeviceId: deviceId.optional(),
  }),
  'device.enroll.failed': z.strictObject({
    enrollmentId: prefixed('enr'),
    reason: z.enum(['denied', 'expired', 'cancelled', 'signature', 'commit']),
  }),
  'device.revoked': z.strictObject({ deviceId, reason: z.enum(['manual', 'self', 'replay', 'cascade', 'migration']), cascaded: count }),
  'device.review': z.strictObject({ deviceId, causeDeviceId: deviceId }),
  'device.scopes.changed': z.strictObject({ deviceId, added: scopes, removed: scopes, dataScope: dataScope.optional() }),
  'device.renamed': deviceOnly,
  /** A renewal answered with a new credential; it replaces the current one only when first used. */
  'device.credential.issued': deviceOnly,
  'device.native.verified': deviceOnly,
  /** The renewed credential was used for the first time and became current. */
  'device.credential.rotated': deviceOnly,
  /**
   * `listener` is where the invitation can be used; records written before invitations were bound to one have none.
   * `dataScope` only appears in records from when a pairing could choose one.
   */
  'pairing.invited': z.strictObject({
    invitationId: prefixed('inv'),
    scopes,
    listener: listener.optional(),
    dataScope: dataScope.optional(),
  }),
  /** Two sets of keys presented one pairing QR: what came from it was cancelled and removed. */
  'pairing.contended': z.strictObject({ invitationId: prefixed('inv'), cancelled: count, removed: count }),
  'offline.ticket.created': ticket,
  'offline.ticket.consumed': ticket,
  'migration.devices.v2': z.strictObject({ revoked: count, legacy: count }),
  /** An unterminated, unparsable last line of auth/revocations.jsonl (an append cut short) was moved aside. */
  'device.revocations.torn-tail-removed': z.strictObject({ bytes: count }),
} as const
