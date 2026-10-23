import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '../core/errors.ts'
import { base32 } from './crypto.ts'

export interface HostIdentity {
  /** base32(sha256(SPKI DER)), lowercase, 52 characters. */
  hostId: string
  hostId8: string
  publicKeySpki: Buffer
  /** ECDSA P-256 / SHA-256, IEEE P1363. */
  sign(data: Uint8Array): Buffer
}

const DIRECTORY = 'identity'
const KEY_FILE = 'host-key.pem'

/** The Host ID derived from its public key. */
export function hostIdFromSpki(spkiDer: Uint8Array): string {
  return base32(createHash('sha256').update(spkiDer).digest())
}

function invalid(reason: string): AppError {
  return new AppError(500, 'identity-invalid', `Host 身份密钥 identity/${KEY_FILE} ${reason}，已拒绝启动。原文件已保留。`)
}

const uid = () => process.getuid?.()

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** The private key exists only in this file (PKCS#8 PEM, 0600); no other copy is ever written. */
export async function loadOrCreateHostIdentity(dataDir: string): Promise<HostIdentity> {
  const directory = join(dataDir, DIRECTORY)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (uid() !== undefined && directoryInfo.uid !== uid())) {
    throw new AppError(500, 'identity-invalid', 'Host 身份目录 identity/ 不是本用户拥有的目录，已拒绝启动。')
  }
  if (process.platform !== 'win32' && (directoryInfo.mode & 0o077) !== 0) await chmod(directory, 0o700)

  const path = join(directory, KEY_FILE)
  let pem: string | undefined
  try {
    pem = await readExisting(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (pem === undefined) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const created = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(created)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await syncDirectory(directory)
      pem = created
    } catch (error) {
      // Another process created it first: use that one.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      pem = await readExisting(path)
    }
  }
  let privateKey: KeyObject
  try {
    privateKey = createPrivateKey({ key: pem, format: 'pem' })
  } catch {
    throw invalid('无法解析')
  }
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw invalid('不是 P-256 密钥')
  const publicKeySpki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  const hostId = hostIdFromSpki(publicKeySpki)
  return {
    hostId,
    hostId8: hostId.slice(0, 8),
    publicKeySpki,
    sign: data => sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' }),
  }
}

async function readExisting(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw invalid('不是普通文件')
  if (uid() !== undefined && info.uid !== uid()) throw invalid('不属于当前用户')
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    await chmod(path, 0o600)
    if (((await lstat(path)).mode & 0o077) !== 0) throw invalid('可被其他用户读取')
  }
  try {
    return await readFile(path, 'utf8')
  } catch {
    throw invalid('无法读取')
  }
}
