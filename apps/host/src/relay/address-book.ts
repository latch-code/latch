import {
  ascii,
  holder,
  issuePass,
  routeKey,
  UTC_DAY,
  encodeDirectorySource,
  type NativeAddressBook,
  type NativeDirectorySource,
  type NativeLanAddress,
} from '@latch/link-wire'
import { nodeCrypto, signAddressBook } from '@latch/link-client'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { AppError } from '@latch/sdk'
import type { HostIdentity } from '../identity.ts'
import { bookRelays, RelayProfiles, secretBytes } from './profiles.ts'

export class HostAddressBooks {
  private readonly profiles: RelayProfiles
  private readonly identity: HostIdentity
  private readonly lan: () => readonly NativeLanAddress[]
  private readonly issuing = new Map<string, Promise<string>>()
  /** When a phone last received a book naming each relay (this run of the Host only): 手机已拿到. */
  private readonly delivered = new Map<string, number>()
  deliveredAt(relayId: string): number | undefined {
    return this.delivered.get(relayId)
  }
  constructor(
    profiles: RelayProfiles,
    identity: HostIdentity,
    lan: () => readonly NativeLanAddress[],
    private readonly directory?: () => NativeDirectorySource | undefined,
    /** The region of the nearest official node as measured by the relay controller, when known. */
    private readonly region?: () => string | undefined,
  ) {
    this.profiles = profiles
    this.identity = identity
    this.lan = lan
  }
  issue(deviceId: string): Promise<string> {
    const previous = this.issuing.get(deviceId)
    if (previous) return previous
    if (this.issuing.size >= 96) throw new AppError(429, 'native-book-busy', '正在生成连接簿，请稍后重试')
    const pending = this.build(deviceId)
    this.issuing.set(deviceId, pending)
    void pending
      .finally(() => {
        if (this.issuing.get(deviceId) === pending) this.issuing.delete(deviceId)
      })
      .catch(() => {})
    return pending
  }
  private async build(deviceId: string): Promise<string> {
    const generation = await this.profiles.nextGeneration(),
      state = this.profiles.snapshot()
    const lan = [...this.lan()]
    const source = this.directory?.(),
      sourceHash = (value: NativeDirectorySource | undefined) => (value ? Buffer.from(encodeDirectorySource(value)).toString('hex') : '')
    const hostRegion = this.region?.()
    const fingerprint = sha256Hex(
      canonicalJson({
        discoveryKey: state.discoveryKey,
        profiles: state.profiles,
        officialOff: state.officialOff ?? false,
        ownFirst: state.ownFirst ?? false,
        lan,
        directory: sourceHash(source),
        hostRegion: hostRegion ?? null,
      }),
    )
    const now = Date.now(),
      day = Math.floor(now / 1000 / UTC_DAY)
    const book: NativeAddressBook = {
      hostId: this.identity.hostId,
      deviceId,
      generation,
      issuedAt: now,
      expiresAt: (day + 31) * UTC_DAY * 1000,
      discoveryKey: secretBytes(state.discoveryKey),
      lan,
      relays: [],
      ...(source ? { directory: source } : {}),
    }
    // At most four relays in the person's order of preference (official first unless they chose their own first, and
    // none while the official relay is off). The Host's region is signed in only when the official nodes lead: phones
    // try that node first, and it must not jump ahead of relays the person put first.
    const relays = bookRelays(state)
    if (!state.ownFirst && hostRegion !== undefined && relays.some(profile => profile.region === hostRegion)) book.hostRegion = hostRegion
    for (const profile of relays) {
      const relayId = Buffer.from(profile.relayId, 'hex'),
        passes = []
      for (let offset = 0; offset <= 30; offset++)
        for (const seed of [profile.seeds[profile.activeSlot], profile.seeds[profile.activeSlot === 0 ? 1 : 0]]) {
          const date = day + offset,
            key = await routeKey(nodeCrypto, secretBytes(seed), relayId, date)
          const device = await holder(nodeCrypto, secretBytes(seed), relayId, ascii(deviceId), date)
          const pass = await issuePass(nodeCrypto, key, {
            pairing: false,
            relayId,
            day: date,
            notBefore: date * UTC_DAY - 900,
            notAfter: (date + 1) * UTC_DAY + 900,
            routePub: await nodeCrypto.publicKey(key),
            holderPub: await nodeCrypto.publicKey(device.seed),
            tag: device.tag,
          })
          passes.push({ pass, holderSeed: device.seed })
        }
      book.relays.push(
        profile.kind === 'edge'
          ? {
              relayId,
              url: profile.url,
              spkiHash: new Uint8Array(32),
              passes,
              profile: 'outer-pad-v2',
              edge: { relayKey: Buffer.from(profile.relayKey!, 'hex'), shard: profile.shard ?? 0 },
              ...(profile.region ? { region: profile.region } : {}),
              ...(profile.extraUrls ? { extraUrls: [...profile.extraUrls] } : {}),
            }
          : { relayId, url: profile.url, spkiHash: Buffer.from(profile.spkiHash!, 'hex'), passes, profile: 'outer-pad-v2' },
      )
    }
    const current = this.profiles.snapshot()
    if (
      fingerprint
      !== sha256Hex(
        canonicalJson({
          discoveryKey: current.discoveryKey,
          profiles: current.profiles,
          officialOff: current.officialOff ?? false,
          ownFirst: current.ownFirst ?? false,
          lan: [...this.lan()],
          directory: sourceHash(this.directory?.()),
          hostRegion: this.region?.() ?? null,
        }),
      )
    )
      throw new AppError(409, 'native-book-changed', '中继配置已变化，请重新取得连接簿')
    const signed = signAddressBook(book, this.identity)
    for (const profile of relays) this.delivered.set(profile.relayId, Date.now())
    return signed
  }
}
