import { dirname, isAbsolute } from 'node:path'
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
    certificateFile: z.string().min(1).optional(),
    keyFile: z.string().min(1).optional(),
    relaySigningSeedFile: z.string().min(1).optional(),
    behindProxy: z.boolean().default(false),
    acme: z
      .object({
        domain: z.string().min(1).max(253),
        directoryUrl: z.string().url().max(512).optional(),
        email: z.string().min(3).max(254).optional(),
      })
      .strict()
      .optional(),
    selfSignedTls: z
      .object({
        target: z.string().min(1).max(253),
      })
      .strict()
      .optional(),
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
        source: z.enum(['iface', 'relay']).optional(),
        iface: z
          .string()
          .regex(/^[a-zA-Z0-9_.:-]{1,15}$/u)
          .refine(value => !['lo', '.', '..', 'relay'].includes(value))
          .optional(),
        burstBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        stopRatio: z.union([z.literal(0.85), z.literal(0.9)]),
      })
      .strict()
      .refine(value => (value.source === 'relay' ? value.iface === undefined : value.iface !== undefined))
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
    const loopback = ['127.0.0.1', '::1'].includes(value.host)
    const production = !loopback || value.behindProxy
    if (!value.openRegistration && !value.registrationTokenFile)
      context.addIssue({ code: 'custom', message: 'Registration token required' })
    if (value.behindProxy && (!loopback || value.gateway || value.acme || value.selfSignedTls || !value.relaySigningSeedFile))
      context.addIssue({ code: 'custom', message: 'Behind-proxy relay must bind loopback with a relay signing seed and no TLS gateway' })
    if (!value.behindProxy && (!value.certificateFile || !value.keyFile))
      context.addIssue({ code: 'custom', message: 'TLS certificate and key files required unless behindProxy is enabled' })
    if (value.acme && (!value.gateway || !value.relaySigningSeedFile || value.behindProxy || value.selfSignedTls))
      context.addIssue({ code: 'custom', message: 'ACME requires the TLS gateway and a relay signing seed' })
    if (value.selfSignedTls && (value.behindProxy || value.acme || value.relaySigningSeedFile))
      context.addIssue({ code: 'custom', message: 'Self-signed TLS pins SPKI and cannot be combined with behindProxy, ACME or edge seed' })
    if (!loopback && !value.gateway) context.addIssue({ code: 'custom', message: 'Public relay requires ticket-free gateway' })
    if (production && (!value.quota || !value.fairness || !value.memory || !value.maxStateBytes))
      context.addIssue({ code: 'custom', message: 'Public relay requires quota, fairness and measured memory/state capacity' })
    if (production && !value.registrationWork)
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
async function readTlsFile(path: string, maximum = 65_536): Promise<Buffer> {
  const { constants } = await import('node:fs'),
    { lstat, open } = await import('node:fs/promises')
  if (!isAbsolute(path)) throw new Error('TLS paths must be absolute')
  const myUid = process.getuid?.()
  const parent = await lstat(dirname(path))
  if (
    !parent.isDirectory()
    || parent.isSymbolicLink()
    || (parent.mode & 0o022) !== 0
    || (myUid !== undefined && parent.uid !== myUid && parent.uid !== 0)
  )
    throw new Error('Invalid TLS directory permissions')
  const validStat = (stat: import('node:fs').Stats): boolean => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) return false
    if (stat.uid === 0) return (stat.mode & 0o037) === 0
    if (myUid !== undefined && stat.uid !== myUid) return false
    return (stat.mode & 0o077) === 0
  }
  const info = await lstat(path)
  if (!validStat(info)) throw new Error('Invalid TLS file permissions')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const actual = await handle.stat()
    if (actual.dev !== info.dev || actual.ino !== info.ino || !validStat(actual)) throw new Error('TLS file changed')
    const bytes = Buffer.alloc(maximum + 1)
    let size = 0
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    const after = await handle.stat()
    if (size > maximum || after.size !== size || after.mtimeMs !== actual.mtimeMs || !validStat(after)) throw new Error('TLS file changed')
    return bytes.subarray(0, size)
  } finally {
    await handle.close()
  }
}
export async function readRelayTls(certificateFile: string, keyFile: string): Promise<{ cert: Buffer; key: Buffer }> {
  if (![certificateFile, keyFile].every(isAbsolute)) throw new Error('TLS paths must be absolute')
  const cert = await readTlsFile(certificateFile),
    key = await readTlsFile(keyFile)
  createSecureContext({ cert, key, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' })
  return { cert, key }
}
export async function loadRelayConfig(path: string) {
  const config = configSchema.parse(JSON.parse((await privateFile(path)).toString('utf8')) as unknown)
  const tls =
    config.behindProxy || !config.certificateFile || !config.keyFile
      ? undefined
      : await readRelayTls(config.certificateFile, config.keyFile)
  // Registration tokens and relay signing seeds are arbitrary 32-byte secrets, unlike PEM/config text.
  const registrationToken = config.registrationTokenFile ? await privateBinary(config.registrationTokenFile) : undefined
  const relaySigningSeed = config.relaySigningSeedFile ? await privateBinary(config.relaySigningSeedFile) : undefined
  if (config.gateway) await checkGateway(config.gateway.binary)
  return {
    ...config,
    relayId: unhex(config.relayId, 16),
    cert: tls?.cert,
    key: tls?.key,
    registrationToken,
    relaySigningSeed,
  }
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
