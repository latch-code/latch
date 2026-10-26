import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { nodeCrypto } from '@latch/link-client/crypto'
import {
  decodeRelayDirectory,
  decodeSignedRelayDirectory,
  encodeRelayAuthority,
  encodeRelayDirectory,
  encodeSignedRelayDirectory,
  relayAuthorityInput,
  relayDirectoryInput,
  unhex,
  verifyRelayAuthority,
  verifyRelayDirectory,
} from '@latch/link-wire'
import { readPrivate, writePrivate } from './private-store.ts'

const hex32 = z.string().regex(/^[a-f0-9]{64}$/u),
  id = z.string().regex(/^[a-f0-9]{32}$/u),
  integer = z.int().nonnegative(),
  generation = z.int().positive()
const checkpoint = z.strictObject({ generation, hash: hex32 })
const ledgerSchema = z.strictObject({
  version: z.literal(1),
  publicKey: hex32,
  root: checkpoint.optional(),
  online: checkpoint.extend({ rootGeneration: generation, rootHash: hex32 }).optional(),
  outputs: z
    .array(z.strictObject({ pathHash: hex32, hash: hex32 }))
    .max(32)
    .optional(),
})
const keySchema = z.strictObject({ version: z.literal(1), role: z.enum(['root', 'online']), privateKey: z.string().max(4096) })
const authoritySchema = z.strictObject({
  generation,
  issuedAt: integer,
  expiresAt: integer,
  keys: z
    .array(z.strictObject({ publicKey: hex32, notBefore: integer, notAfter: integer }))
    .min(1)
    .max(4),
  revokedKeys: z.array(hex32).max(16),
  nodes: z
    .array(
      z.strictObject({
        relayId: id,
        region: z.string().min(1).max(64),
        spkiHashes: z.array(hex32).min(1).max(2),
        ports: z.array(z.int().min(1).max(65535)).max(4),
      }),
    )
    .max(4),
})
const addressesSchema = z.strictObject({
  generation,
  issuedAt: integer,
  expiresAt: integer,
  nodes: z
    .array(
      z.strictObject({
        relayId: id,
        host: z.string().max(253),
        port: z.int().min(1).max(65535),
        addresses: z.array(z.string().max(45)).min(1).max(8),
      }),
    )
    .max(4),
})
const signedAuthoritySchema = z.strictObject({
  version: z.literal(1),
  authority: z.string().max(22000),
  rootSignature: z.string().max(128),
})
type Ledger = z.infer<typeof ledgerSchema>

async function privateDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new Error('Explicit private directory required')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory),
    uid = process.getuid?.()
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || (uid !== undefined && info.uid !== uid))
    throw new Error('Private signer directory required')
  return realpath(directory)
}
async function publicBytes(path: string): Promise<Uint8Array> {
  if (!isAbsolute(path)) throw new Error('Absolute manifest path required')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 32_768) throw new Error('Manifest limit')
    const bytes = Buffer.alloc(32_769)
    let count = 0
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, count)
      if (!result.bytesRead) break
      count += result.bytesRead
    }
    if (count > 32_768) throw new Error('Manifest limit')
    const after = await file.stat()
    if (after.size !== count || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('Manifest changed')
    return bytes.subarray(0, count)
  } finally {
    await file.close()
  }
}
async function publicFile(path: string): Promise<unknown> {
  return JSON.parse(Buffer.from(await publicBytes(path)).toString('utf8')) as unknown
}
async function publishNew(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`,
    file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    // link is atomic and never replaces an existing operator file, even when another signer races this output.
    await link(temporary, path)
    const folder = await open(dirname(path), 'r')
    try {
      await folder.sync()
    } finally {
      await folder.close()
    }
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
const binary = (value: string, maximum: number) => {
  const bytes = Buffer.from(value, 'base64url')
  if (!value || bytes.length > maximum || bytes.toString('base64url') !== value) throw new Error('Invalid signed authority')
  return bytes
}
function publicKey(key: KeyObject): string {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 signer required')
  return createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
}
async function loadKey(directory: string) {
  const path = join(directory, 'directory-key.json'),
    text = await readPrivate(path, 8192),
    uid = process.getuid?.(),
    info = await lstat(path)
  if (!text || (uid !== undefined && info.uid !== uid)) throw new Error('Private signer required')
  const value = keySchema.parse(JSON.parse(text)),
    key = createPrivateKey(value.privateKey)
  return { role: value.role, key, publicKey: publicKey(key) }
}
async function locked<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const path = join(directory, 'directory.lock'),
    file = await open(path, 'wx', 0o600)
  let owned: Awaited<ReturnType<typeof file.stat>> | undefined
  try {
    owned = await file.stat()
    await file.writeFile(JSON.stringify({ pid: process.pid }))
    await file.sync()
    return await operation()
  } finally {
    await file.close()
    const actual = await lstat(path).catch(() => undefined)
    if (owned && actual?.ino === owned.ino && actual.dev === owned.dev) await unlink(path)
  }
}
function monotonic(previous: z.infer<typeof checkpoint> | undefined, next: z.infer<typeof checkpoint>): void {
  if (previous && (next.generation < previous.generation || (next.generation === previous.generation && next.hash !== previous.hash)))
    throw new Error('Signer rollback or conflict')
}

/** Offline/publication tooling only. Host and relay serving never open these private keys. */
export async function runDirectoryCommand(args: string[]): Promise<Record<string, unknown>> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      'data-dir': { type: 'string' },
      input: { type: 'string' },
      output: { type: 'string' },
      authority: { type: 'string' },
      previous: { type: 'string' },
      'root-key': { type: 'string' },
      help: { type: 'boolean' },
    },
  })
  if (values.help)
    return {
      usage:
        'directory init root|online; public-key; sign-authority --input --output; sign-addresses --authority --root-key --input --output; publish-authority --authority --previous --output; every operation requires --data-dir <absolute-private-directory>',
    }
  const directoryInput = values['data-dir'],
    command = positionals[0]
  if (!directoryInput || !isAbsolute(directoryInput)) throw new Error('Explicit signer directory required')
  const directory = await privateDirectory(directoryInput)
  if (command === 'init') {
    const role = z.enum(['root', 'online']).parse(positionals[1])
    if (positionals.length !== 2 || values.input || values.output || values.authority || values.previous || values['root-key'])
      throw new Error('Invalid signer initialization')
    return locked(directory, async () => {
      const keyPath = join(directory, 'directory-key.json')
      const existing = await lstat(keyPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      })
      if (existing) throw new Error('Signer already initialized')
      const { privateKey } = generateKeyPairSync('ed25519'),
        identity = publicKey(privateKey)
      await publishNew(join(directory, 'directory-state.json'), Buffer.from(JSON.stringify({ version: 1, publicKey: identity })))
      const file = await open(keyPath, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify({ version: 1, role, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }))
        await file.sync()
      } finally {
        await file.close()
      }
      const folder = await open(directory, 'r')
      try {
        await folder.sync()
      } finally {
        await folder.close()
      }
      return { initialized: true, role, publicKey: identity }
    })
  }
  if (positionals.length !== 1 || !['public-key', 'sign-authority', 'sign-addresses', 'publish-authority'].includes(command ?? ''))
    throw new Error('Invalid directory command')
  return locked(directory, async () => {
    const signer = await loadKey(directory)
    if (command === 'public-key') {
      if (values.input || values.output || values.authority || values.previous || values['root-key'])
        throw new Error('Invalid public key command')
      return { role: signer.role, publicKey: signer.publicKey }
    }
    if ((!values.input && command !== 'publish-authority') || !values.output || !isAbsolute(values.output))
      throw new Error('Explicit distinct input and output required')
    const outputPath = join(await privateDirectory(dirname(resolve(values.output))), basename(values.output))
    if (
      [
        join(directory, 'directory-key.json'),
        join(directory, 'directory-state.json'),
        join(directory, 'directory.lock'),
        ...(values.input ? [await realpath(values.input)] : []),
        ...(values.authority ? [await realpath(values.authority)] : []),
        ...(values.previous ? [await realpath(values.previous)] : []),
      ].includes(outputPath)
    )
      throw new Error('Output cannot replace signer state or input')
    const statePath = join(directory, 'directory-state.json'),
      prior = await readPrivate(statePath, 8192),
      state: Ledger = prior
        ? ledgerSchema.parse(JSON.parse(prior))
        : (() => {
            throw new Error('Signer state unavailable')
          })()
    if (state.publicKey !== signer.publicKey) throw new Error('Signer identity changed')
    const now = Date.now()
    let output: string | Uint8Array, result: Record<string, unknown>
    if (command === 'publish-authority') {
      if (signer.role !== 'root' || !values.authority || !values.previous || values.input || values['root-key'])
        throw new Error('Offline Root publication required')
      const artifact = signedAuthoritySchema.parse(await publicFile(values.authority)),
        authority = binary(artifact.authority, 16_384),
        rootSignature = binary(artifact.rootSignature, 64),
        anchor = unhex(signer.publicKey, 32)
      const checked = await verifyRelayAuthority(nodeCrypto, authority, rootSignature, [anchor], now),
        previous = decodeSignedRelayDirectory(await publicBytes(values.previous))
      const historical = await verifyRelayDirectory(nodeCrypto, previous, [anchor], decodeRelayDirectory(previous.directory).issuedAt)
      const next = { generation: checked.checkpoint.generation, hash: Buffer.from(checked.checkpoint.hash).toString('hex') }
      monotonic(
        { generation: historical.checkpoint.rootGeneration, hash: Buffer.from(historical.checkpoint.rootHash).toString('hex') },
        next,
      )
      monotonic(state.root, next)
      state.root = next
      output = encodeSignedRelayDirectory({ ...previous, authority, rootSignature })
      result = { published: true, rootOnly: true, ...next }
    } else if (command === 'sign-authority') {
      if (signer.role !== 'root' || values.authority || values.previous || values['root-key'] || !values.input)
        throw new Error('Offline Root role required')
      const input = authoritySchema.parse(await publicFile(values.input))
      if (input.keys.some(item => item.publicKey === signer.publicKey)) throw new Error('Online delegation must use a distinct key')
      const authority = encodeRelayAuthority({
        ...input,
        keys: input.keys.map(item => ({ ...item, publicKey: unhex(item.publicKey, 32) })),
        revokedKeys: input.revokedKeys.map(item => unhex(item, 32)),
        nodes: input.nodes.map(item => ({
          ...item,
          relayId: unhex(item.relayId, 16),
          spkiHashes: item.spkiHashes.map(pin => unhex(pin, 32)),
        })),
      })
      const signature = sign(null, relayAuthorityInput(authority), signer.key),
        verified = await verifyRelayAuthority(nodeCrypto, authority, signature, [unhex(signer.publicKey, 32)], now)
      const next = { generation: verified.checkpoint.generation, hash: Buffer.from(verified.checkpoint.hash).toString('hex') }
      monotonic(state.root, next)
      state.root = next
      output = JSON.stringify({
        version: 1,
        authority: Buffer.from(authority).toString('base64url'),
        rootSignature: signature.toString('base64url'),
      })
      result = { signed: true, role: 'root', ...next }
    } else {
      if (signer.role !== 'online' || !values.authority || !values['root-key'] || values.previous || !values.input)
        throw new Error('Online role and fixed offline Root required')
      const anchor = unhex(hex32.parse(values['root-key']), 32),
        input = addressesSchema.parse(await publicFile(values.input)),
        root = signedAuthoritySchema.parse(await publicFile(values.authority))
      const authority = binary(root.authority, 16_384),
        rootSignature = binary(root.rootSignature, 64),
        checked = await verifyRelayAuthority(nodeCrypto, authority, rootSignature, [anchor], now)
      const directoryBytes = encodeRelayDirectory({
        ...input,
        rootGeneration: checked.checkpoint.generation,
        rootHash: checked.checkpoint.hash,
        key: unhex(signer.publicKey, 32),
        nodes: input.nodes.map(item => ({ ...item, relayId: unhex(item.relayId, 16) })),
      })
      const signature = sign(null, relayDirectoryInput(directoryBytes), signer.key),
        bundle = { authority, rootSignature, directory: directoryBytes, signature }
      const verified = await verifyRelayDirectory(nodeCrypto, bundle, [anchor], now),
        next = {
          generation: verified.checkpoint.generation,
          hash: Buffer.from(verified.checkpoint.hash).toString('hex'),
          rootGeneration: verified.checkpoint.rootGeneration,
          rootHash: Buffer.from(verified.checkpoint.rootHash).toString('hex'),
        }
      if (state.online) {
        monotonic(
          { generation: state.online.rootGeneration, hash: state.online.rootHash },
          { generation: next.rootGeneration, hash: next.rootHash },
        )
        if (next.rootGeneration === state.online.rootGeneration) monotonic(state.online, next)
      }
      state.online = next
      output = encodeSignedRelayDirectory(bundle)
      result = { signed: true, role: 'online', ...next }
    }
    const bytes = typeof output === 'string' ? Buffer.from(output) : output,
      hash = createHash('sha256').update(bytes).digest('hex'),
      pathHash = createHash('sha256').update('latch-directory-output-v1\0').update(outputPath).digest('hex'),
      exists = await lstat(outputPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      })
    if (exists) {
      const receipt = state.outputs?.find(item => item.pathHash === pathHash)
      if (!receipt || receipt.hash !== hash || !exists.isFile() || exists.isSymbolicLink())
        throw new Error('Output must be a new versioned file')
      if (
        createHash('sha256')
          .update(await publicBytes(outputPath))
          .digest('hex') !== hash
      )
        throw new Error('Published output changed')
    }
    state.outputs = [...(state.outputs ?? []).filter(item => item.pathHash !== pathHash), { pathHash, hash }].slice(-32)
    // Commit the anti-equivocation ledger before publication. An unknown write never permits a lower retry.
    await writePrivate(statePath, JSON.stringify(ledgerSchema.parse(state)))
    if (!exists) await publishNew(outputPath, bytes)
    return result
  })
}
