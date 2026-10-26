import { isAbsolute } from 'node:path'
import { isIP } from 'node:net'
import { createSecureContext } from 'node:tls'
import { z } from 'zod'
import { unhex } from '@latch/link-wire'
import { readPrivate } from './private-store.ts'
import { checkGateway } from './gateway.ts'
import { registrationWorkSchema, REGISTRATION_WORK_MEMORY } from './registration-work.ts'

const configSchema = z
  .object({
    version: z.literal(1),
    host: z.string().refine(value => isIP(value) !== 0),
    port: z.number().int().min(0).max(65535),
    adminPort: z.number().int().min(0).max(65535),
    relayId: z.string().regex(/^[a-f0-9]{32}$/u),
    certificateFile: z.string().min(1),
    keyFile: z.string().min(1),
    registrationTokenFile: z.string().min(1).optional(),
    openRegistration: z.boolean().default(false),
    maxConnections: z.number().int().min(1).max(20_000).default(1024),
    maxRoutes: z.number().int().min(1).max(2048).default(512),
    maxPerPrefix: z.number().int().min(1).max(20_000).default(64),
    maxStateBytes: z
      .number()
      .int()
      .min(300_000)
      .max(1024 * 1024 * 1024)
      .optional(),
    registrationWork: registrationWorkSchema.optional(),
    quota: z
      .object({
        monthlyBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        resetDay: z.number().int().min(1).max(31),
        timezone: z.string().min(1).max(100),
        count: z.enum(['in+out', 'out']),
        iface: z
          .string()
          .regex(/^[a-zA-Z0-9_.:-]{1,15}$/u)
          .refine(value => !['lo', '.', '..'].includes(value)),
        burstBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        stopRatio: z.union([z.literal(0.85), z.literal(0.9)]),
      })
      .strict()
      .optional(),
    fairness: z
      .object({ prefixDailyShare: z.number().gt(0).max(1).default(0.01), overageFactor: z.number().gt(0).lt(1) })
      .strict()
      .optional(),
    memory: z
      .object({
        bufferBytes: z.number().int().min(16_384).max(Number.MAX_SAFE_INTEGER),
        limitBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .refine(value => value.bufferBytes < value.limitBytes / 2)
      .optional(),
    gateway: z
      .object({
        binary: z.string().min(1),
        maxHandshakes: z.number().int().min(1).max(4096),
        handshakesPerSecond: z.number().min(1).max(100_000),
        handshakeBurst: z.number().min(1).max(4096),
        prefixFraction: z.number().gt(0).max(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.openRegistration && !value.registrationTokenFile)
      context.addIssue({ code: 'custom', message: 'Registration token required' })
    if (!['127.0.0.1', '::1'].includes(value.host) && !value.gateway)
      context.addIssue({ code: 'custom', message: 'Public relay requires ticket-free gateway' })
    if (!['127.0.0.1', '::1'].includes(value.host) && (!value.quota || !value.fairness || !value.memory || !value.maxStateBytes))
      context.addIssue({ code: 'custom', message: 'Public relay requires quota, fairness and measured memory/state capacity' })
    if (!['127.0.0.1', '::1'].includes(value.host) && !value.registrationWork)
      context.addIssue({ code: 'custom', message: 'Public relay requires measured registration work capacity' })
    if (value.registrationWork) {
      const hardRoutes = Math.floor(value.maxRoutes * (value.gateway?.prefixFraction ?? 1))
      if (value.registrationWork.softRoutesPerPrefix >= hardRoutes)
        context.addIssue({ code: 'custom', message: 'Registration soft limit must leave room within the prefix resource share' })
      if (
        value.memory
        && value.memory.bufferBytes + value.registrationWork.maxConcurrent * REGISTRATION_WORK_MEMORY >= value.memory.limitBytes / 2
      )
        context.addIssue({ code: 'custom', message: 'Registration work must fit the measured memory budget' })
    }
    if (value.quota) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value.quota.timezone }).format(0)
      } catch {
        context.addIssue({ code: 'custom', message: 'Invalid provider timezone' })
      }
    }
    const g = value.gateway
    if (
      g
      && (g.maxHandshakes > value.maxConnections
        || g.handshakeBurst > g.maxHandshakes
        || g.prefixFraction * value.maxConnections < 1
        || g.prefixFraction * g.maxHandshakes < 1)
    )
      context.addIssue({ code: 'custom', message: 'Invalid measured gateway capacity' })
  })
async function privateFile(path: string, maximum = 65_536): Promise<Buffer> {
  const content = await readPrivate(path, maximum)
  if (content === undefined) throw new Error('Private relay file unavailable')
  return Buffer.from(content, 'utf8')
}
export async function readRelayTls(certificateFile: string, keyFile: string): Promise<{ cert: Buffer; key: Buffer }> {
  if (![certificateFile, keyFile].every(isAbsolute)) throw new Error('TLS paths must be absolute')
  const cert = await privateFile(certificateFile),
    key = await privateFile(keyFile)
  createSecureContext({ cert, key, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' })
  return { cert, key }
}
export async function loadRelayConfig(path: string) {
  const config = configSchema.parse(JSON.parse((await privateFile(path)).toString('utf8')) as unknown)
  const { cert, key } = await readRelayTls(config.certificateFile, config.keyFile)
  // Registration tokens are arbitrary bytes, unlike PEM/config text.
  const registrationToken = config.registrationTokenFile ? await privateBinary(config.registrationTokenFile) : undefined
  if (config.gateway) await checkGateway(config.gateway.binary)
  return { ...config, relayId: unhex(config.relayId, 16), cert, key, registrationToken }
}
async function privateBinary(path: string): Promise<Buffer> {
  const { constants } = await import('node:fs'),
    { lstat, open } = await import('node:fs/promises')
  if (!isAbsolute(path)) throw new Error('Private path must be absolute')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size !== 32) throw new Error('Invalid registration token file')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const actual = await handle.stat(),
      bytes = Buffer.alloc(33)
    const result = await handle.read(bytes, 0, 33, 0)
    const after = await handle.stat()
    if (
      actual.ino !== info.ino
      || actual.dev !== info.dev
      || actual.mode & 0o077
      || result.bytesRead !== 32
      || after.size !== 32
      || after.mtimeMs !== actual.mtimeMs
    )
      throw new Error('Registration token changed')
    return bytes.subarray(0, 32)
  } finally {
    await handle.close()
  }
}
