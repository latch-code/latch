import Foundation

/** Only verified books enter this decision. Renewed passes and metadata do not invalidate a fixed relay identity. */
public enum NativeBookPathChange {
    public static func requiresMigration(previous: NativeAddressBook?, current: NativeAddressBook) -> Bool {
        guard let previous else { return true }
        return previous.hostId != current.hostId || previous.deviceId != current.deviceId
            || previous.discoveryKey != current.discoveryKey || identities(previous) != identities(current)
    }
    private struct RelayIdentity: Hashable {
        let id: Data
        let spki: Data
        let profile: String?
        let relayKey: Data?
        let shard: Int?
    }
    private static func identities(_ book: NativeAddressBook) -> Set<RelayIdentity> {
        Set(book.relays.map { RelayIdentity(id: $0.relayId, spki: $0.spkiHash, profile: $0.profile?.rawValue, relayKey: $0.edge?.relayKey, shard: $0.edge?.shard) })
    }
}
