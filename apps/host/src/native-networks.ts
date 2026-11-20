import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { sha256Hex, writeFileAtomic } from '@latch/core/node-kit'
import { parseIp, subnetBytes } from '@latch/link-wire'
import type { NativeNetworkInterface } from './native-network-backend.ts'

const schema = z.strictObject({ version: z.literal(1), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(32) })
/** Gateway IP/SSID is insufficient. This Host-private key includes the observed unicast gateway MAC and masked subnet. */
export function knownNetworkHash(row: NativeNetworkInterface, gatewayMac: string): string {
  if (
    !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u.test(gatewayMac)
    || gatewayMac === '00:00:00:00:00:00'
    || Number.parseInt(gatewayMac.slice(0, 2), 16) & 1
  )
    throw new RangeError('Invalid network gateway')
  const ip = parseIp(row.address)
  return sha256Hex(
    Buffer.concat([
      Buffer.from('latch-known-network-v1\0'),
      Buffer.from([ip.family, row.prefixLength]),
      Buffer.from(subnetBytes(ip, row.prefixLength)),
      Buffer.from(gatewayMac.replaceAll(':', ''), 'hex'),
    ]),
  )
}
/** A cable hotspot proven without the neighbour table: named by its subnet, since there is no gateway MAC to name it by. */
export function knownTetherHash(row: NativeNetworkInterface): string {
  const ip = parseIp(row.address)
  return sha256Hex(
    Buffer.concat([
      Buffer.from('latch-known-tether-v1\0'),
      Buffer.from([ip.family, row.prefixLength]),
      Buffer.from(subnetBytes(ip, row.prefixLength)),
    ]),
  )
}
export class NativeNetworks {
  private tail = Promise.resolve()
  private constructor(
    private readonly path: string,
    private hashes: string[],
  ) {}
  static async open(dataDir: string): Promise<NativeNetworks> {
    const directory = join(dataDir, 'native'),
      path = join(directory, 'networks.json'),
      uid = process.getuid?.()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const folder = await lstat(directory)
    if (!folder.isDirectory() || folder.isSymbolicLink() || folder.mode & 0o077 || (uid !== undefined && folder.uid !== uid))
      throw new AppError(500, 'native-network-private', '手机连接配置目录必须只有本人可访问')
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 4096 || stat.mode & 0o077 || (uid !== undefined && stat.uid !== uid))
          throw new Error('Invalid network file')
        return new NativeNetworks(path, schema.parse(JSON.parse(await file.readFile('utf8'))).hashes)
      } finally {
        await file.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AppError(500, 'native-network-invalid', '手机连接网络记录无效，原文件已保留')
      await writeFileAtomic(path, `${JSON.stringify({ version: 1, hashes: [] })}\n`)
      return new NativeNetworks(path, [])
    }
  }
  has(hash: string): boolean {
    return this.hashes.includes(hash)
  }
  remember(hash: string): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.has(hash)) return
      const hashes = schema.parse({ version: 1, hashes: [...this.hashes.slice(-31), hash] }).hashes
      await writeFileAtomic(this.path, `${JSON.stringify({ version: 1, hashes })}\n`)
      this.hashes = hashes
    })
    this.tail = operation.catch(() => {})
    return operation
  }
}
