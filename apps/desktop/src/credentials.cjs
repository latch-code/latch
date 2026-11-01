'use strict'
// Device key and credential storage for the Electron shell. The renderer never sees either:
// main generates the P-256 key, signs enrollment and renewal, and keeps both encrypted with safeStorage.
const crypto = require('node:crypto')
const { lstat, mkdir, open, readFile, rename, rm, chmod } = require('node:fs/promises')
const { join } = require('node:path')

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const HOST_ID = /^[a-z2-7]{52}$/
const DEVICE_ID = /^dev_[A-Za-z0-9_-]{22}$/
const CREDENTIAL = /^ldc1\.dev_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/
const NO_SECURE_STORAGE = '此系统没有可用的安全存储，Latch 桌面端拒绝保存设备凭据。'

function base32(bytes) {
  let output = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  return output
}

/** Same algorithm as the Host's deviceFingerprint: base32(sha256(SPKI)), first 20 chars, upper case, groups of 4. */
function deviceFingerprint(spkiDer) {
  const text = base32(crypto.createHash('sha256').update(spkiDer).digest()).toUpperCase().slice(0, 20)
  return /** @type {RegExpMatchArray} */ (text.match(/.{4}/g)).join(' ')
}

function enrollSigningText(hostId, enrollmentId, nonce) {
  return `latch-enroll-v1\n${hostId}\n${enrollmentId}\n${nonce}`
}
function renewSigningText(hostId, deviceId, nonce) {
  return `latch-renew-v1\n${hostId}\n${deviceId}\n${nonce}`
}
/** What main signs for a folder add: the nonce from `POST /folder-grants` and the hash of the body it sends. */
function foldersSigningText(hostId, deviceId, nonce, bodyHash) {
  return `latch-folders-v1\n${hostId}\n${deviceId}\n${nonce}\n${bodyHash}`
}

/**
 * The Host's canonicalJson (`packages/core/src/node-kit/digest.ts`) for the plain JSON main builds itself: object keys
 * sorted by UTF-16 code unit, no whitespace, primitives as JSON.stringify writes them, undefined members dropped.
 * Anything else throws rather than hashing something the Host would encode differently.
 */
function canonicalJson(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value
      .map(item => {
        if (item === undefined) throw new TypeError('canonicalJson: undefined array element')
        return canonicalJson(item)
      })
      .join(',')}]`
  }
  if (typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new TypeError('canonicalJson: not plain JSON')
  const members = Object.keys(value)
    .sort()
    .flatMap(key => (value[key] === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(value[key])}`]))
  return `{${members.join(',')}}`
}

/** The `bodyHash` of `foldersSigningText`: SHA-256 (lowercase hex) of the canonical body without `signature`. */
function foldersBodyHash(body) {
  return crypto.createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex')
}

function deviceKeyFrom(privateKey) {
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('设备密钥不是 P-256')
  }
  const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  return {
    publicKey: spki.toString('base64url'),
    fingerprint: deviceFingerprint(spki),
    /** ECDSA P-256 / SHA-256 in IEEE P1363 form (64 bytes), base64url. */
    sign(text) {
      return crypto.sign('sha256', Buffer.from(text, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    },
    exportPem() {
      return privateKey.export({ type: 'pkcs8', format: 'pem' })
    },
  }
}

function generateDeviceKey() {
  return deviceKeyFrom(crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey)
}

/** Returns the refusal message when credentials cannot be stored securely, otherwise undefined. */
function secureStorageProblem(safeStorage, platform = process.platform) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return NO_SECURE_STORAGE
    if (platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return NO_SECURE_STORAGE
    return undefined
  } catch {
    return NO_SECURE_STORAGE
  }
}

async function ensurePrivateDirectory(directory, uid) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stats = await lstat(directory)
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== uid) throw new Error(`设备凭据目录不安全：${directory}`)
  if ((stats.mode & 0o077) !== 0) await chmod(directory, 0o700)
}

/**
 * `<directory>/<hostId>.json` (0600): `{ v: 1, hostId, deviceId?, privateKey, credential? }` where
 * `privateKey` and `credential` are base64(safeStorage.encryptString(...)). A record that cannot be
 * read back (foreign file, other keychain, tampering) is ignored and replaced at the next enrollment.
 * A renewed credential is written before it is used: the Host keeps the stored one current until the
 * new one is first presented, so a renewal whose answer or write is lost leaves the file valid.
 * Older files may still carry `rotating: true`; it is ignored.
 * @param {{ directory: string, hostId: string, safeStorage: Electron.SafeStorage, uid?: number, log?: (message: string) => void }} options
 */
async function openCredentialStore({
  directory,
  hostId,
  safeStorage,
  uid = /** @type {() => number} */ (process.getuid)(),
  log = () => {},
}) {
  if (!HOST_ID.test(hostId)) throw new Error('hostId 格式不正确')
  await ensurePrivateDirectory(directory, uid)
  const file = join(directory, `${hostId}.json`)
  let record = await load()
  let writes = Promise.resolve()

  async function load() {
    let stats
    try {
      stats = await lstat(file)
    } catch {
      return undefined
    }
    if (stats.isSymbolicLink() || !stats.isFile() || stats.uid !== uid) {
      log('忽略不安全的设备凭据文件')
      return undefined
    }
    if ((stats.mode & 0o077) !== 0) await chmod(file, 0o600)
    try {
      const value = JSON.parse(await readFile(file, 'utf8'))
      if (value?.v !== 1 || value.hostId !== hostId || typeof value.privateKey !== 'string') throw new Error('format')
      const key = deviceKeyFrom(crypto.createPrivateKey(safeStorage.decryptString(Buffer.from(value.privateKey, 'base64'))))
      if (value.credential === undefined) return { key }
      const credential = safeStorage.decryptString(Buffer.from(value.credential, 'base64'))
      if (!DEVICE_ID.test(value.deviceId) || !CREDENTIAL.test(credential) || !credential.startsWith(`ldc1.${value.deviceId}.`))
        throw new Error('format')
      return { key, deviceId: value.deviceId, credential }
    } catch {
      log('设备凭据文件无法读取，需要重新连接')
      return undefined
    }
  }

  async function persist(next) {
    const value = { v: 1, hostId, privateKey: safeStorage.encryptString(next.key.exportPem()).toString('base64') }
    if (next.credential !== undefined) {
      value.deviceId = next.deviceId
      value.credential = safeStorage.encryptString(next.credential).toString('base64')
    }
    const temporary = join(directory, `.${hostId}-${crypto.randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(JSON.stringify(value))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, file)
    } catch (error) {
      // A full disk must not leave partial copies of the record behind.
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    // Resolves exactly when the record was replaced, so callers never use a credential the file lacks.
    try {
      const directoryHandle = await open(directory, 'r')
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    } catch {
      /* Directory fsync is advisory on some file systems. */
    }
  }

  function serialized(action) {
    const next = writes.then(action)
    writes = next.catch(() => {})
    return next
  }

  function requireCredential() {
    if (!record || record.credential === undefined) throw new Error('没有设备凭据')
    return record
  }

  return {
    hostId,
    file,
    /** `{ deviceId, credential }` when this shell holds a credential for the Host. */
    current() {
      return record?.credential === undefined ? undefined : { deviceId: record.deviceId, credential: record.credential }
    },
    sign(text) {
      if (!record) throw new Error('没有设备密钥')
      return record.key.sign(text)
    },
    /**
     * The signature of a folder add body (with its `nonce`, without `signature`) by this shell's device, read from one
     * record so the device ID and the key always belong together.
     */
    signFolders(body) {
      const current = requireCredential()
      return current.key.sign(foldersSigningText(hostId, current.deviceId, body.nonce, foldersBodyHash(body)))
    },
    /** Replaces key and credential after a completed enrollment (each enrollment uses a fresh key). */
    commit({ key, deviceId, credential }) {
      if (!DEVICE_ID.test(deviceId) || !CREDENTIAL.test(credential) || !credential.startsWith(`ldc1.${deviceId}.`)) {
        return Promise.reject(new Error('Host 返回的设备凭据格式不正确'))
      }
      return serialized(async () => {
        const next = { key, deviceId, credential }
        await persist(next)
        record = next
      })
    },
    /**
     * Stores a renewed credential for the same device and key. It becomes current only once the file holds
     * it; when the write fails the stored credential stays in use, which the Host still accepts.
     */
    setCredential(credential) {
      return serialized(async () => {
        const current = requireCredential()
        if (!CREDENTIAL.test(credential) || !credential.startsWith(`ldc1.${current.deviceId}.`))
          throw new Error('Host 返回的设备凭据格式不正确')
        const next = { key: current.key, deviceId: current.deviceId, credential }
        await persist(next)
        record = next
      })
    },
    /** Forgets the credential and the key, e.g. after revocation or expiry. */
    clear() {
      return serialized(async () => {
        record = undefined
        await rm(file, { force: true })
      })
    },
  }
}

module.exports = {
  NO_SECURE_STORAGE,
  base32,
  deviceFingerprint,
  enrollSigningText,
  renewSigningText,
  foldersSigningText,
  canonicalJson,
  foldersBodyHash,
  generateDeviceKey,
  deviceKeyFrom,
  secureStorageProblem,
  openCredentialStore,
}
