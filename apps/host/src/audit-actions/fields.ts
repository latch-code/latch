import { z } from 'zod'

// Detail values are limited to ids, hashes, enums, booleans and counts: never names, titles, paths, commands or secrets.
export const hex64 = z.string().regex(/^[0-9a-f]{64}$/u)
export const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/u)
/** An attachment's 128-bit base64url id: unlike `opaqueId`, about one in 32 starts with `-` or `_`. */
export const attachmentId = z.string().regex(/^[A-Za-z0-9_-]{22}$/u)
export const deviceId = z.string().regex(/^dev_[A-Za-z0-9_-]{22}$/u)
export const prefixed = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{22}$`, 'u'))
export const count = z.number().int().min(0).max(1_000_000_000)
