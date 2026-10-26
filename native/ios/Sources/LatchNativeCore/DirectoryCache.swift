import Foundation

public struct NativeDirectoryStorage: Sendable {
    public let read: @Sendable () async throws -> Data?
    public let write: @Sendable (Data) async throws -> Void
    public init(read: @escaping @Sendable () async throws -> Data?, write: @escaping @Sendable (Data) async throws -> Void) {
        self.read = read; self.write = write
    }
    public static func encrypted(_ vault: EncryptedVault, source: NativeDirectorySource) -> NativeDirectoryStorage {
        let anchors = source.anchors.sorted { LinkBytes.hex($0) < LinkBytes.hex($1) }.reduce(into: Data()) { $0.append($1) }
        let legacy = "directory-" + LinkBytes.hex(LinkBytes.hash(anchors)), name = "directory-trust"
        return NativeDirectoryStorage(read: {
            if let value = try await vault.metadata(name: name) { return value }
            if let value = try await vault.metadata(name: legacy) {
                try await vault.storeMetadata(value, name: name); return value
            }
            return nil
        }, write: { try await vault.storeMetadata($0, name: name) })
    }
}
public struct NativeDirectoryBundle: Codable, Sendable {
    public let authority: Data
    public let rootSignature: Data
    public let addresses: Data
    public let signature: Data
    public static func decode(_ bytes: Data) throws -> NativeDirectoryBundle {
        var reader = try LinkReader(bytes, maximum: 32_768)
        let value = try NativeDirectoryBundle(authority: reader.field(16_384), rootSignature: reader.take(64), addresses: reader.field(16_384), signature: reader.take(64))
        try reader.done(); return value
    }
}
/** Only a verified directory plus an already-authorized book endpoint can create this dialing target. */
public struct NativeDirectoryTarget: Sendable {
    public let endpoint: NativeRelayAddress
    public let address: String
}

/** Root revocations and both signed floors survive lock/restart; no cached address is an identity or a body window. */
public actor NativeDirectoryCache {
    private struct Root: Codable, Sendable { let authority: Data; let rootSignature: Data }
    private struct State: Codable, Sendable { var version = 1; var root: Root?; var last: NativeDirectoryBundle? }
    private let source: NativeDirectorySource
    private let storage: NativeDirectoryStorage
    private let now: @Sendable () -> UInt64
    private var state = State()
    private var root: NativeAuthorityCheckpoint?
    private var last: NativeDirectoryCheckpoint?
    private var live: VerifiedRelayDirectory?
    private var uncertain = false
    private var writer: Task<Void, Error>?
    private var writerId: UUID?
    private init(source: NativeDirectorySource, storage: NativeDirectoryStorage, now: @escaping @Sendable () -> UInt64) {
        self.source = source; self.storage = storage; self.now = now
    }
    public static func open(source: NativeDirectorySource, storage: NativeDirectoryStorage,
        now: @escaping @Sendable () -> UInt64 = { UInt64(max(0, Date().timeIntervalSince1970 * 1000)) }) async throws -> NativeDirectoryCache {
        let checked = try NativeDirectorySource(anchors: source.anchors, mirrors: source.mirrors, minimum: source.minimum, minimumOnline: source.minimumOnline)
        let cache = NativeDirectoryCache(source: checked, storage: storage, now: now)
        try await cache.restore(); return cache
    }
    private func restore() async throws {
        guard let bytes = try await storage.read() else { return }
        guard bytes.count <= 98_304 else { throw NativeFailure.storageUnavailable }
        let value = try NativeJSON.decode(bytes)
        guard Set(value.object.keys).isSubset(of: ["version", "root", "last"]) else { throw NativeFailure.storageUnavailable }
        if value["root"] != .null { guard Set(value["root"].object.keys) == Set(["authority", "rootSignature"]) else { throw NativeFailure.storageUnavailable } }
        if value["last"] != .null { guard Set(value["last"].object.keys) == Set(["authority", "rootSignature", "addresses", "signature"]) else { throw NativeFailure.storageUnavailable } }
        state = try JSONDecoder().decode(State.self, from: bytes)
        guard state.version == 1 else { throw NativeFailure.storageUnavailable }
        if let stored = state.root {
            var reader = try LinkReader(stored.authority, maximum: 16_384)
            guard try reader.integer(1) == 1 else { throw NativeFailure.invalidRecord }
            _ = try reader.integer(8); let issued = try reader.integer(8)
            root = try NativeRelayDirectory.verifyAuthority(stored.authority, signature: stored.rootSignature, anchors: source.anchors, nowMs: issued).checkpoint
        }
        if let stored = state.last {
            var reader = try LinkReader(stored.addresses, maximum: 16_384)
            guard try reader.integer(1) == 1 else { throw NativeFailure.invalidRecord }
            _ = try reader.integer(8); let issued = try reader.integer(8)
            let historical = try NativeRelayDirectory.verify(authority: stored.authority, rootSignature: stored.rootSignature,
                addresses: stored.addresses, signature: stored.signature, anchors: source.anchors, nowMs: issued)
            guard let root, root.generation >= historical.checkpoint.rootGeneration,
                  root.generation != historical.checkpoint.rootGeneration || LinkBytes.equal(root.hash, historical.checkpoint.rootHash) else { throw NativeFailure.storageUnavailable }
            last = historical.checkpoint
            do {
                _ = try NativeRelayDirectory.verifyAuthority(stored.authority, signature: stored.rootSignature, anchors: source.anchors, nowMs: now(), prior: floor())
                live = try NativeRelayDirectory.verify(authority: stored.authority, rootSignature: stored.rootSignature,
                    addresses: stored.addresses, signature: stored.signature, anchors: source.anchors, nowMs: now(), prior: prior())
            } catch { live = nil }
        }
    }
    private func floor() throws -> NativeAuthorityCheckpoint? {
        guard let minimum = source.minimum else { return root }
        if let root, root.generation > minimum.generation { return root }
        if let root, root.generation == minimum.generation, !LinkBytes.equal(root.hash, minimum.hash) { throw NativeFailure.invalidRecord }
        return minimum
    }
    private func onlineFloor() throws -> NativeAuthorityCheckpoint? {
        let root = try floor()
        let matched = last.flatMap { value in root?.generation == value.rootGeneration && root?.hash == value.rootHash ? value : nil }
        let actual = try matched.map { try NativeAuthorityCheckpoint(generation: $0.generation, hash: $0.hash) }
        guard source.minimum?.generation == root?.generation, let minimum = source.minimumOnline else { return actual }
        if let actual, actual.generation > minimum.generation { return actual }
        if let actual, actual.generation == minimum.generation, !LinkBytes.equal(actual.hash, minimum.hash) { throw NativeFailure.invalidRecord }
        return minimum
    }
    private func prior() throws -> NativeDirectoryCheckpoint? {
        guard let root = try floor(), let online = try onlineFloor() else { return nil }
        return try NativeDirectoryCheckpoint(rootGeneration: root.generation, rootHash: root.hash, generation: online.generation, hash: online.hash)
    }
    public func sources() throws -> NativeDirectorySource {
        guard !uncertain else { throw NativeFailure.resultUnknown }
        return try NativeDirectorySource(anchors: source.anchors, mirrors: source.mirrors, minimum: floor(), minimumOnline: onlineFloor())
    }
    private func save() async throws {
        uncertain = true; live = nil
        do { try await storage.write(JSONEncoder().encode(state)); uncertain = false }
        catch { throw NativeFailure.resultUnknown }
    }
    public func adopt(_ bytes: Data) async throws {
        let bundle = try NativeDirectoryBundle.decode(bytes), previous = writer, id = UUID()
        let task = Task {
            _ = try? await previous?.value
            try await self.adoptOnce(bundle)
        }
        writer = task; writerId = id
        do { try await task.value; if writerId == id { writer = nil; writerId = nil } }
        catch { if writerId == id { writer = nil; writerId = nil }; throw error }
    }
    private func adoptOnce(_ bundle: NativeDirectoryBundle) async throws {
        let checked = try NativeRelayDirectory.verifyAuthority(bundle.authority, signature: bundle.rootSignature, anchors: source.anchors, nowMs: now(), prior: floor())
        if root == nil || checked.checkpoint.generation > root!.generation || uncertain {
            root = checked.checkpoint; state.root = Root(authority: bundle.authority, rootSignature: bundle.rootSignature)
            try await save()
        }
        let verified = try NativeRelayDirectory.verify(authority: bundle.authority, rootSignature: bundle.rootSignature,
            addresses: bundle.addresses, signature: bundle.signature, anchors: source.anchors, nowMs: now(), prior: prior())
        state.last = bundle; last = verified.checkpoint
        try await save(); live = verified
    }
    public func candidates(for endpoint: NativeRelayAddress) -> [NativeDirectoryTarget] {
        guard !uncertain, let live, live.expiresAt > now(),
              let node = live.nodes.first(where: { LinkBytes.equal($0.relayId, endpoint.relayId) }),
              node.spkiHashes.contains(where: { LinkBytes.equal($0, endpoint.spkiHash) }),
              let entry = live.addresses.first(where: { LinkBytes.equal($0.relayId, endpoint.relayId) }), let url = try? entry.url else { return [] }
        return entry.addresses.map { NativeDirectoryTarget(endpoint: NativeRelayAddress(relayId: endpoint.relayId,
            url: url, spkiHash: endpoint.spkiHash, passes: endpoint.passes, profile: endpoint.profile), address: $0) }
    }
    public func settled() async { _ = try? await writer?.value }
    /** Exact authenticated evidence survives an unknown commit; source replacement cannot clear its fence. */
    public func retryPersistence() async throws {
        let previous = writer, id = UUID()
        let task = Task { _ = try? await previous?.value; if self.uncertain { try await self.save() } }
        writer = task; writerId = id
        do { try await task.value; if writerId == id { writer = nil; writerId = nil } }
        catch { if writerId == id { writer = nil; writerId = nil }; throw error }
    }
}
