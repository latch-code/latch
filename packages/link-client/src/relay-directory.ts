import { z } from 'zod'
import {
  decodeRelayAuthority,
  decodeRelayDirectory,
  decodeSignedRelayDirectory,
  encodeDirectorySource,
  equal,
  verifyRelayAuthority,
  verifyRelayDirectory,
  type AuthorityCheckpoint,
  type DirectoryCheckpoint,
  type NativeDirectorySource,
  type SignedRelayDirectory,
} from '@latch/link-wire'
import { nodeCrypto } from './crypto.ts'

const binary = z
  .string()
  .max(22000)
  .regex(/^[A-Za-z0-9_-]+$/u)
const signedRoot = z.strictObject({ authority: binary, rootSignature: binary })
const signedBundle = signedRoot.extend({ directory: binary, signature: binary })
const record = z.strictObject({ version: z.literal(1), root: signedRoot.optional(), last: signedBundle.optional() })
type Stored = z.infer<typeof record>
export interface DirectoryStorage {
  read(): Promise<string | undefined>
  write(value: string): Promise<void>
}
const bytes = (value: string): Buffer => {
  const result = Buffer.from(value, 'base64url')
  if (result.toString('base64url') !== value) throw new Error('Invalid directory cache encoding')
  return result
}
const stored = (bundle: SignedRelayDirectory) => ({
  authority: Buffer.from(bundle.authority).toString('base64url'),
  rootSignature: Buffer.from(bundle.rootSignature).toString('base64url'),
  directory: Buffer.from(bundle.directory).toString('base64url'),
  signature: Buffer.from(bundle.signature).toString('base64url'),
})
const opened = (value: z.infer<typeof signedBundle>): SignedRelayDirectory => ({
  authority: bytes(value.authority),
  rootSignature: bytes(value.rootSignature),
  directory: bytes(value.directory),
  signature: bytes(value.signature),
})

/** Storage owns permissions and durability; this cache publishes no addresses before both signature layers and their floors stick. */
export class RelayDirectoryCache {
  private state: Stored = { version: 1 }
  private root?: AuthorityCheckpoint
  private last?: DirectoryCheckpoint
  private live?: Awaited<ReturnType<typeof verifyRelayDirectory>>
  private tail = Promise.resolve()
  private uncertain = false
  private constructor(
    private readonly source: NativeDirectorySource,
    private readonly storage: DirectoryStorage,
    private readonly now: () => number,
  ) {}
  static async open(source: NativeDirectorySource, storage: DirectoryStorage, now = Date.now): Promise<RelayDirectoryCache> {
    source = structuredClone(source)
    encodeDirectorySource(source)
    const cache = new RelayDirectoryCache(source, storage, now),
      text = await storage.read()
    if (text !== undefined) {
      if (Buffer.byteLength(text) > 98304) throw new Error('Directory cache limit')
      cache.state = record.parse(JSON.parse(text))
      if (cache.state.root) {
        const payload = bytes(cache.state.root.authority),
          decoded = decodeRelayAuthority(payload)
        // Expiry disables dialing, but an authenticated historical Root still prevents rollback after restart.
        cache.root = (
          await verifyRelayAuthority(nodeCrypto, payload, bytes(cache.state.root.rootSignature), source.anchors, decoded.issuedAt)
        ).checkpoint
      }
      if (cache.state.last) {
        const bundle = opened(cache.state.last),
          online = decodeRelayDirectory(bundle.directory)
        const checked = await verifyRelayDirectory(nodeCrypto, bundle, source.anchors, online.issuedAt)
        if (
          !cache.root
          || cache.root.generation < checked.checkpoint.rootGeneration
          || (cache.root.generation === checked.checkpoint.rootGeneration && !equal(cache.root.hash, checked.checkpoint.rootHash))
        )
          throw new Error('Directory cache authority mismatch')
        cache.last = checked.checkpoint
        try {
          await verifyRelayAuthority(nodeCrypto, bundle.authority, bundle.rootSignature, source.anchors, now(), cache.floor())
          cache.live = await verifyRelayDirectory(nodeCrypto, bundle, source.anchors, now(), cache.prior())
        } catch {
          /* Historical evidence keeps the floors even when it cannot supply live addresses. */
        }
      }
    }
    return cache
  }
  private floor(): AuthorityCheckpoint | undefined {
    const minimum = this.source.minimum
    if (!minimum || (this.root && this.root.generation > minimum.generation)) return this.root
    if (this.root?.generation === minimum.generation && !equal(this.root.hash, minimum.hash))
      throw new Error('Directory Root floor conflict')
    return minimum
  }
  private onlineFloor(): AuthorityCheckpoint | undefined {
    const root = this.floor()
    const minimum = root && this.source.minimum?.generation === root.generation ? this.source.minimumOnline : undefined,
      last = root && this.last?.rootGeneration === root.generation && equal(this.last.rootHash, root.hash) ? this.last : undefined
    if (!minimum || (last && last.generation > minimum.generation)) return last
    if (last?.generation === minimum.generation && !equal(last.hash, minimum.hash)) throw new Error('Directory online floor conflict')
    return minimum
  }
  private prior(): DirectoryCheckpoint | undefined {
    const root = this.floor(),
      online = this.onlineFloor()
    return root && online
      ? { rootGeneration: root.generation, rootHash: root.hash, generation: online.generation, hash: online.hash }
      : undefined
  }
  sources(): NativeDirectorySource {
    if (this.uncertain) throw new Error('Directory cache result unknown')
    const minimum = this.floor()
    const minimumOnline = this.onlineFloor()
    return structuredClone({
      anchors: this.source.anchors,
      mirrors: this.source.mirrors,
      ...(minimum ? { minimum } : {}),
      ...(minimumOnline ? { minimumOnline: { generation: minimumOnline.generation, hash: minimumOnline.hash } } : {}),
    })
  }
  private async save(): Promise<void> {
    this.uncertain = true
    this.live = undefined
    try {
      await this.storage.write(JSON.stringify(this.state))
      this.uncertain = false
    } catch {
      this.uncertain = true
      this.live = undefined
      throw new Error('Directory cache result unknown')
    }
  }
  adopt(encoded: Uint8Array): Promise<void> {
    // Snapshot before waiting for a previous writer; the network caller cannot mutate the queued transcript.
    const bundle = decodeSignedRelayDirectory(new Uint8Array(encoded))
    const operation = this.tail.then(async () => {
      const checked = await verifyRelayAuthority(
        nodeCrypto,
        bundle.authority,
        bundle.rootSignature,
        this.source.anchors,
        this.now(),
        this.floor(),
      )
      const next = stored(bundle)
      if (!this.root || checked.checkpoint.generation > this.root.generation || this.uncertain) {
        this.root = checked.checkpoint
        this.live = undefined
        this.state.root = { authority: next.authority, rootSignature: next.rootSignature }
        await this.save()
      }
      const verified = await verifyRelayDirectory(nodeCrypto, bundle, this.source.anchors, this.now(), this.prior())
      this.state.last = next
      this.last = verified.checkpoint
      await this.save()
      this.live = verified
    })
    this.tail = operation.catch(() => {})
    return operation
  }
  candidates(relayId: Uint8Array, spkiHash: Uint8Array): Array<{ url: string; address: string }> {
    const live = this.live
    if (this.uncertain || !live || live.authority.expiresAt <= this.now() || live.directory.expiresAt <= this.now()) return []
    const granted = live.authority.nodes.find(node => equal(node.relayId, relayId))
    if (!granted?.spkiHashes.some(pin => equal(pin, spkiHash))) return []
    const node = live.directory.nodes.find(value => equal(value.relayId, relayId))
    if (!node) return []
    const host = node.host.includes(':') ? `[${node.host}]` : node.host,
      url = `https://${host}${node.port === 443 ? '' : `:${node.port}`}/`
    return node.addresses.map(address => ({ url, address }))
  }
  async settled(): Promise<void> {
    await this.tail
  }
  /** Retry only authenticated state already owned by this instance; changing sources cannot discard an unknown writer. */
  retryPersistence(): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.uncertain) await this.save()
    })
    this.tail = operation.catch(() => {})
    return operation
  }
  /** Only public aggregate state is suitable for settings; no source bundle or signature is needed in task snapshots. */
  status(): { generation: number; rootGeneration: number; ready: boolean } {
    try {
      return {
        generation: this.onlineFloor()?.generation ?? 0,
        rootGeneration: this.floor()?.generation ?? 0,
        ready: this.candidatesForStatus(),
      }
    } catch {
      return { generation: 0, rootGeneration: this.root?.generation ?? 0, ready: false }
    }
  }
  private candidatesForStatus(): boolean {
    return !this.uncertain && !!this.live && this.live.authority.expiresAt > this.now() && this.live.directory.expiresAt > this.now()
  }
}
