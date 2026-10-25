import { lstat, open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { unhex } from '@latch/link-wire'

const configSchema = z
  .object({
    version: z.literal(1),
    host: z.string().min(1).max(253),
    port: z.number().int().min(0).max(65535),
    adminPort: z.number().int().min(0).max(65535),
    relayId: z.string().regex(/^[a-f0-9]{32}$/u),
    certificateFile: z.string().min(1),
    keyFile: z.string().min(1),
    registrationTokenFile: z.string().min(1).optional(),
    openRegistration: z.boolean().default(false),
    maxConnections: z.number().int().min(1).max(4096).default(1024),
    maxRoutes: z.number().int().min(1).max(2048).default(512),
    maxPerPrefix: z.number().int().min(1).max(256).default(64),
  })
  .strict()
  .refine(value => value.openRegistration || Boolean(value.registrationTokenFile))

async function privateFile(path: string, maximum = 65_536): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error('Private file path must be absolute')
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > maximum)
    throw new Error('Private file must be a bounded 0600 regular file')
  const handle = await open(path, 'r')
  try {
    const actual = await handle.stat()
    if (actual.ino !== stat.ino || actual.dev !== stat.dev || (actual.mode & 0o077) !== 0 || actual.size > maximum)
      throw new Error('Private file changed')
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}
export async function loadRelayConfig(path: string) {
  const config = configSchema.parse(JSON.parse((await privateFile(path)).toString('utf8')) as unknown)
  if (!isAbsolute(config.certificateFile)) throw new Error('Certificate path must be absolute')
  const cert = await readFile(config.certificateFile),
    key = await privateFile(config.keyFile)
  const registrationToken = config.registrationTokenFile ? await privateFile(config.registrationTokenFile, 32) : undefined
  if (registrationToken && registrationToken.length !== 32) throw new Error('Invalid registration token file')
  return { ...config, relayId: unhex(config.relayId, 16), cert, key, registrationToken }
}
