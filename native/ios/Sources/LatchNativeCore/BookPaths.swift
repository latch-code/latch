import Foundation

/** Only verified books enter this decision. Renewed passes and metadata do not invalidate a fixed relay identity. */
public enum NativeBookPathChange {
    public static func requiresMigration(previous: NativeAddressBook?, current: NativeAddressBook) -> Bool {
        guard let previous else { return true }
        return previous.hostId != current.hostId || previous.deviceId != current.deviceId
            || previous.discoveryKey != current.discoveryKey || identities(previous) != identities(current)
    }
    /**
     * Whether `current` invalidates the path currently installed on the workspace, requiring an immediate dial round
     * (which cancels in-flight file transfers). Changes to unused relays or try-order leave an active direct path or an
     * unchanged installed relay running until the workspace is quiet.
     */
    public static func invalidatesInstalledPath(
        previous: NativeAddressBook?,
        current: NativeAddressBook,
        installedKind: NativePathCandidate.Kind?,
        installedPathId: String?
    ) -> Bool {
        guard let previous, let installedKind else { return true }
        if previous.hostId != current.hostId || previous.deviceId != current.deviceId { return true }
        switch installedKind {
        case .direct:
            return previous.discoveryKey != current.discoveryKey
        case .relay:
            guard let installedPathId,
                  let prior = previous.relays.first(where: { LinkBytes.hex($0.relayId) == installedPathId }),
                  let next = current.relays.first(where: { LinkBytes.hex($0.relayId) == installedPathId }) else { return true }
            return identity(of: prior) != identity(of: next)
        }
    }
    private struct RelayIdentity: Hashable {
        let id: Data
        let spki: Data
        let profile: String?
        let relayKey: Data?
        let shard: Int?
    }
    private static func identity(of relay: NativeRelayAddress) -> RelayIdentity {
        RelayIdentity(id: relay.relayId, spki: relay.spkiHash, profile: relay.profile?.rawValue,
            relayKey: relay.edge?.relayKey, shard: relay.edge?.shard)
    }
    private static func identities(_ book: NativeAddressBook) -> Set<RelayIdentity> {
        Set(book.relays.map(identity(of:)))
    }
}
