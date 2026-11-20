import Foundation

/** Bounded, Sendable JSON for Host-owned optional fields; unrecognized capabilities never become enabled actions. */
public enum NativeJSON: Codable, Sendable, Equatable {
    case object([String: NativeJSON]), array([NativeJSON]), string(String), number(Double), bool(Bool), null
    public init(from decoder: any Decoder) throws {
        guard decoder.codingPath.count <= 48 else { throw NativeFailure.invalidRecord }
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let result = try? value.decode(Bool.self) { self = .bool(result) }
        else if let result = try? value.decode(String.self), result.utf8.count <= 1_048_576 { self = .string(result) }
        else if let result = try? value.decode(Double.self), result.isFinite, abs(result) <= Double(LinkBytes.maximumInteger) { self = .number(result) }
        else if let result = try? value.decode([NativeJSON].self), result.count <= 10_000 { self = .array(result) }
        else if let result = try? value.decode([String: NativeJSON].self), result.count <= 512, result.keys.allSatisfy({ $0.utf8.count <= 256 }) { self = .object(result) }
        else { throw NativeFailure.invalidRecord }
    }
    public func encode(to encoder: any Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case let .object(result): try value.encode(result)
        case let .array(result): try value.encode(result)
        case let .string(result): try value.encode(result)
        case let .number(result): guard result.isFinite else { throw NativeFailure.invalidRecord }; try value.encode(result)
        case let .bool(result): try value.encode(result)
        case .null: try value.encodeNil()
        }
    }
    public subscript(_ key: String) -> NativeJSON { if case let .object(value) = self { return value[key] ?? .null }; return .null }
    public var string: String? { if case let .string(value) = self { value } else { nil } }
    public var array: [NativeJSON] { if case let .array(value) = self { value } else { [] } }
    public var object: [String: NativeJSON] { if case let .object(value) = self { value } else { [:] } }
    public var bool: Bool { if case let .bool(value) = self { value } else { false } }
    public var integer: UInt64? {
        if case let .number(value) = self, value >= 0, value.rounded(.down) == value, value <= Double(LinkBytes.maximumInteger) { return UInt64(value) }; return nil
    }
    public static func decode(_ data: Data) throws -> NativeJSON {
        guard data.count <= 1_048_576 else { throw NativeFailure.invalidRecord }
        return try JSONDecoder().decode(Self.self, from: data)
    }
    public func encoded() throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let value = try encoder.encode(self)
        guard value.count <= 1_048_576 else { throw NativeFailure.invalidRecord }; return value
    }
}

public struct NativePendingWrite: Codable, Sendable {
    public let requestId: String
    public let method: String
    public let path: String
    public let body: Data
    public init(method: NativeHTTPMethod, path: String, fields: [String: NativeJSON], requestId: String = UUID().uuidString) throws {
        guard method != .get && method != .head, LinkBytes.matches(requestId, "[A-Za-z0-9_-]{16,80}"),
              path.hasPrefix("/link/api/"), path.utf8.count <= 1024, !path.contains("?"), !path.contains("#"),
              path.utf8.allSatisfy({ $0 >= 33 && $0 < 127 }), !path.contains("..") else { throw NativeFailure.invalidRecord }
        var input = fields
        if method == .patch && LinkBytes.matches(path, "/link/api/tasks/[A-Za-z0-9_-]{1,160}/queue/[A-Za-z0-9_-]{1,160}") { input.removeValue(forKey: "requestId") }
        else { input["requestId"] = .string(requestId) }
        self.requestId = requestId; self.method = method.rawValue; self.path = path
        body = try NativeJSON.object(input).encoded()
    }
}

public struct NativeWorkspaceEvents: Sendable {
    public let events: AsyncThrowingStream<NativeEvent, Error>
    fileprivate let stream: NativeEventStream
    fileprivate let epoch: UUID
    fileprivate let selection: String
    fileprivate let lease: BodyLease?
    fileprivate let bodyReading: UUID?
    public func cancel() async { await stream.cancel() }
}
struct QualifiedNativePath: Sendable {
    let connection: NativeHTTPConnection
    let snapshot: NativeJSON
    let window: PreparedWindowRestore
    let ticket: UUID
    let reopen: (@Sendable () async throws -> NativeHTTPConnection)?
}

/** The selected transport, independently of its restored body lease. */
public final class NativeTransportEpoch: @unchecked Sendable, Hashable {
    let id = UUID()
    private let lock = NSRecursiveLock()
    private var active = true

    fileprivate init() {}
    public static func == (lhs: NativeTransportEpoch, rhs: NativeTransportEpoch) -> Bool { lhs === rhs }
    public func hash(into hasher: inout Hasher) { hasher.combine(id) }
    public var valid: Bool { whileCurrent { true } == true }

    /** Serializes publication with transport replacement. The callback is synchronous and must not do I/O. */
    public func whileCurrent<Value>(_ apply: () -> Value) -> Value? {
        lock.lock(); defer { lock.unlock() }
        return active ? apply() : nil
    }

    fileprivate func withdraw() {
        lock.lock(); defer { lock.unlock() }
        active = false
    }
}

public struct NativeInstalledTransport: Sendable {
    public let epoch: NativeTransportEpoch
    public let snapshot: NativeJSON
    public let lease: BodyLease?
}

/** One App opening owns window receipts, connection epochs, checkpoints and immutable retry bodies. */
public actor NativeWorkspace {
    public let device: PreparedNativeDevice
    private let keys: any NativeIdentityProvider
    private let vault: EncryptedVault
    private let verification: NativeVerification
    private let onRevoked: (@Sendable (VerifiedNativeRevocation) -> Void)?
    private let onTransportInstalled: (@MainActor @Sendable (NativeInstalledTransport) -> Void)?
    private var connection: NativeHTTPConnection?
    private var epoch = UUID()
    private var installedTransport: NativeTransportEpoch?
    private var closingOpening: Task<Bool, Never>?
    private var attempt = UUID()
    private var instance: String?
    private var revision: UInt64 = 0
    private var metadata = NativeJSON.null
    private var snapshotOrder: UInt64 = 0
    private var acceptedSnapshot: NativeSnapshotWrite?
    private var writes = Set<String>()
    private var controlBusy = false
    private var revocation: VerifiedNativeRevocation?
    private var bookDevice: PreparedNativeDevice
    private var bookUpdating = false
    private let directoryResolver: NativeDirectoryResolver
    private var reopen: (@Sendable () async throws -> NativeHTTPConnection)?
    private var bulk: (connection: NativeHTTPConnection, handle: String, etag: String, size: Int, started: ContinuousClock.Instant)?
    private var bulkBusy = false
    private var bulkCover: Task<Void, Never>?
    private var bulkClosing: Task<Void, Never>?
    private var bulkRun: Task<Data, Error>?
    private var uploading = false
    private struct AppliedCursor: Codable, Sendable {
        let selection: String
        let cursor: NativeEventCursor
        let revision: UInt64
    }
    private var cursors: [AppliedCursor] = []
    private var cursorsLoaded = false
    private var cursorTail: Task<Void, Never>?
    private var detailRevisions: [String: UInt64] = [:]
    private var detailOrder: [String] = []
    private var appliedRevisions: [String: UInt64] = [:]
    private let bodyOwner = UUID()
    private var bodyAttempt = UUID()
    private var bodyState: NativeBodyState?
    public init(device: PreparedNativeDevice, keys: any NativeIdentityProvider, vault: EncryptedVault,
        onRevoked: (@Sendable (VerifiedNativeRevocation) -> Void)? = nil,
        onTransportInstalled: (@MainActor @Sendable (NativeInstalledTransport) -> Void)? = nil) throws {
        guard LinkBytes.base32(LinkBytes.hash(device.rootSpki)) == device.hostId,
              LinkBytes.matches(device.deviceId, "dev_[A-Za-z0-9_-]{22}"), device.knockKey.count == 32 else { throw NativeFailure.identityMismatch }
        self.device = device; self.keys = keys; self.vault = vault
        directoryResolver = NativeDirectoryResolver(vault: vault)
        bookDevice = device
        self.onRevoked = onRevoked; self.onTransportInstalled = onTransportInstalled
        verification = NativeVerification(hostId: device.hostId, deviceId: device.deviceId)
    }
    public func install(_ candidate: @escaping @Sendable () async throws -> NativeHTTPConnection) async throws -> NativeJSON {
        let id = await beginPathRound()
        let next = try await candidate()
        let qualified = try await qualify(next, ticket: id, reopen: candidate)
        return try await installQualified(qualified)
    }
    func beginPathRound() async -> UUID { await cancelFileTransfer(); let id = UUID(); attempt = id; return id }
    func qualify(_ next: NativeHTTPConnection, ticket id: UUID, reopen: (@Sendable () async throws -> NativeHTTPConnection)? = nil) async throws -> QualifiedNativePath {
        guard revocation == nil else { await next.close(); throw NativeFailure.revoked }
        guard closingOpening == nil else { await next.close(); throw NativeFailure.unavailable }
        guard attempt == id, !Task.isCancelled else { await next.close(); throw NativeFailure.unavailable }
        do {
            let notice = try await next.request(.get, path: "/link/api/native/revocation")
            guard attempt == id, !Task.isCancelled else { throw NativeFailure.unavailable }
            if notice.status == 200 {
                let value = try NativeJSON.decode(notice.body)
                guard Set(value.object.keys) == Set(["revocation"]) else { throw NativeFailure.invalidRecord }
                if value["revocation"] != .null {
                    let verified = try VerifiedNativeRevocation.verify(value["revocation"], rootSpki: device.rootSpki,
                        hostId: device.hostId, deviceId: device.deviceId)
                    revocation = verified
                    installedTransport?.withdraw()
                    await verification.closeOpening()
                    onRevoked?(verified)
                    await verified.acknowledge(on: next)
                    throw NativeFailure.revoked
                }
            } else if ![401, 403, 404].contains(notice.status) { throw NativeFailure.unavailable }
            let window = try await verification.prepareRestore(on: next)
            let response = try await next.request(.get, path: "/link/api/snapshot")
            guard attempt == id, !Task.isCancelled else { throw NativeFailure.unavailable }
            return QualifiedNativePath(connection: next, snapshot: try parseCheckpoint(response), window: window, ticket: id, reopen: reopen)
        } catch { await next.close(); throw error }
    }
    func installQualified(_ path: QualifiedNativePath) async throws -> NativeJSON {
        do {
            guard revocation == nil else { throw NativeFailure.revoked }
            guard path.ticket == attempt, !Task.isCancelled else { throw NativeFailure.unavailable }
            await cancelFileTransfer()
            guard revocation == nil else { throw NativeFailure.revoked }
            guard path.ticket == attempt, !Task.isCancelled else { throw NativeFailure.unavailable }
            let lease = try await verification.installPrepared(prepare: path.window, on: path.connection)
            guard revocation == nil else { throw NativeFailure.revoked }
            guard path.ticket == attempt, !Task.isCancelled else { throw NativeFailure.unavailable }
            let next = path.snapshot
            let value = next["instanceId"].string == instance && (next["revision"].integer ?? 0) <= revision ? metadata : next
            let write = try acceptSnapshot(value)
            let old = connection, transport = NativeTransportEpoch()
            installedTransport?.withdraw()
            installedTransport = transport
            connection = path.connection; reopen = path.reopen; epoch = transport.id
            bodyState?.authority.replaceConnection(); bodyState?.resetStream(); bodyState?.offers.removeAll()
            if let old { Task { await old.close() } }
            let installed = try await persistCurrentSnapshot(write, epoch: transport.id)
            if let onTransportInstalled {
                await onTransportInstalled(NativeInstalledTransport(epoch: transport, snapshot: installed, lease: lease))
                guard epoch == transport.id, transport.valid else { throw NativeFailure.unavailable }
            }
            return installed
        } catch {
            if connection === path.connection {
                installedTransport?.withdraw(); installedTransport = nil
                connection = nil; reopen = nil; epoch = UUID()
                bodyAttempt = UUID(); bodyState?.withdraw(); bodyState = nil
            }
            await path.connection.close(); throw error
        }
    }
    public func verify() async throws -> BodyLease {
        guard let connection else { throw NativeFailure.unavailable }
        let current = epoch
        let lease = try await verification.verify(on: connection) { [keys] text in try await keys.signVerification(text) }
        guard epoch == current else { throw NativeFailure.unavailable }; return lease
    }
    public func lease() async -> BodyLease? { await verification.currentLease() }
    public func verifiedRevocation() -> VerifiedNativeRevocation? { revocation }
    public func discoveryEpoch() throws -> String {
        let time = Date().timeIntervalSince1970 * 1000
        guard time >= 0, time <= Double(LinkBytes.maximumInteger) else { throw NativeFailure.expired }
        let key = try AddressBookCodec.discoveryKey(bookDevice.signedAddressBook, rootSpki: device.rootSpki, deviceId: device.deviceId,
            nowMs: UInt64(time), priorGeneration: bookDevice.bookGeneration, priorHash: bookDevice.bookHash)
        return try NativeDiscoveryWire.epoch(key: key)
    }
    public func directoryEpoch() throws -> String { try currentBook().directory?.epoch ?? NativeDirectorySource.absentEpoch }
    private func currentBook() throws -> NativeAddressBook {
        try AddressBookCodec.verify(bookDevice.signedAddressBook, rootSpki: device.rootSpki, deviceId: device.deviceId,
            nowMs: UInt64(max(0, Date().timeIntervalSince1970 * 1000)), priorGeneration: bookDevice.bookGeneration, priorHash: bookDevice.bookHash)
    }
    /** The PathOwner remains the only retry owner; each invocation rechecks the current signed book and admission date. */
    public func relayCandidate(relayId: Data) throws -> NativePathCandidate {
        guard relayId.count == 16, let endpoint = try NativeRelayOrder.available(currentBook()).first(where: { LinkBytes.equal($0.relayId, relayId) }) else { throw NativeFailure.invalidRecord }
        let pin = endpoint.spkiHash, profile = endpoint.profile, edge = endpoint.edge
        return try NativePathCandidate(id: LinkBytes.hex(relayId), kind: .relay) { [weak self] in
            guard let self else { throw NativeFailure.unavailable }; return try await self.connectRelay(relayId: relayId, spkiHash: pin, profile: profile, edge: edge)
        }
    }
    private func connectRelay(relayId: Data, spkiHash: Data, profile: NativeRelayProfile?, edge: NativeEdgeIdentity?) async throws -> NativeHTTPConnection {
        guard revocation == nil, !Task.isCancelled else { throw NativeFailure.unavailable }
        let book = try currentBook(), round = attempt, hash = bookDevice.bookHash
        if book.directory == nil { try await directoryResolver.configure(nil) }
        guard round == attempt, !Task.isCancelled else { throw NativeFailure.unavailable }
        guard let endpoint = book.relays.first(where: { LinkBytes.equal($0.relayId, relayId) }), LinkBytes.equal(endpoint.spkiHash, spkiHash), endpoint.profile == profile,
              endpoint.edge == edge else { throw NativeFailure.contextChanged }
        let admission = try NativeRelayAdmission.current(endpoint: endpoint, bookExpiresAt: book.expiresAt, nowMs: UInt64(max(0, Date().timeIntervalSince1970 * 1000)))
        func current() -> Bool { round == attempt && LinkBytes.equal(hash, bookDevice.bookHash) && revocation == nil && !Task.isCancelled }
        do {
            let connection = try await NativeHTTPConnection.relay(endpoint: endpoint, admission: admission, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
            guard current() else { await connection.close(); throw NativeFailure.unavailable }; return connection
        } catch {
            // The address directory pins self-hosted nodes by TLS key and IP; an edge node is reached only by its origins.
            guard current(), endpoint.edge == nil, let source = book.directory else { throw error }
            try await directoryResolver.configure(source)
            guard current() else { throw NativeFailure.unavailable }
            await directoryResolver.refresh()
            for target in await directoryResolver.targets(for: endpoint) {
                guard current(), try currentBook().expiresAt > UInt64(max(0, Date().timeIntervalSince1970 * 1000)) else { throw NativeFailure.unavailable }
                do {
                    let freshPass = try NativeRelayAdmission.current(endpoint: endpoint, bookExpiresAt: book.expiresAt, nowMs: UInt64(max(0, Date().timeIntervalSince1970 * 1000)))
                    let connection = try await NativeHTTPConnection.relay(target: target, admission: freshPass, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
                    guard current() else { await connection.close(); throw NativeFailure.unavailable }
                    try await directoryResolver.retain(connection, target: target)
                    guard current() else { await connection.close(); throw NativeFailure.unavailable }; return connection
                } catch { if !current() { throw NativeFailure.unavailable } }
            }
            throw NativeFailure.unavailable
        }
    }
    /** A Host may remember its independently checked network. This never changes local authority or blocks dialing. */
    public func noteProximity(gatewayHash: Data) async -> Bool {
        do {
            guard gatewayHash.count == 32 else { return false }
            let (connection, current) = try transport()
            guard let lease = await verification.currentLease() else { return false }; try lease.requireValid()
            let body = try NativeJSON.object(["gatewayHash": .string(LinkBytes.hex(gatewayHash))]).encoded()
            let response = try await connection.request(.post, path: "/link/api/native/proximity", body: body)
            guard epoch == current, lease.valid, response.status == 200 else { return false }
            let value = try NativeJSON.decode(response.body)
            return Set(value.object.keys) == Set(["nearby"]) && value["nearby"].bool
        } catch { return false }
    }
    /** Offline list projection only. It never installs a connection, body lease or authoritative checkpoint. */
    public func cachedSnapshot() async throws -> NativeJSON? {
        guard revocation == nil else { throw NativeFailure.revoked }
        guard let data = try await vault.metadata(name: "snapshot") else { return nil }
        let value = try NativeJSON.decode(data)
        guard value["device"]["id"].string == device.deviceId, let instance = value["instanceId"].string,
              LinkBytes.matches(instance, "[A-Za-z0-9_-]{1,128}"), value["revision"].integer != nil else { throw NativeFailure.storageUnavailable }
        return listMetadata(value)
    }
    public func refreshAddressBook(persist: @escaping @Sendable (PreparedNativeDevice) async throws -> Void) async throws -> PreparedNativeDevice {
        let (connection, current) = try transport()
        guard !bookUpdating else { throw NativeFailure.unavailable }
        bookUpdating = true; defer { bookUpdating = false }
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        try lease.requireValid()
        let response = try await connection.request(.post, path: "/link/api/native/address-book", body: Data("{}".utf8))
        guard epoch == current else { throw NativeFailure.unavailable }
        guard response.status == 200 else { throw await responseFailure(response, lease: lease) }
        try lease.requireValid()
        let value = try NativeJSON.decode(response.body)
        guard Set(value.object.keys) == Set(["addressBook"]), let encoded = value["addressBook"].string else { throw NativeFailure.invalidRecord }
        let time = Date().timeIntervalSince1970 * 1000
        guard time >= 0, time <= Double(LinkBytes.maximumInteger) else { throw NativeFailure.expired }
        let next = try bookDevice.replacingAddressBook(encoded, nowMs: UInt64(time))
        try await persist(next)
        guard epoch == current else { throw NativeFailure.unavailable }; try lease.requireValid()
        bookDevice = next
        let source = try currentBook().directory
        try? await directoryResolver.configure(source)
        guard epoch == current else { throw NativeFailure.unavailable }; try lease.requireValid()
        return next
    }
    public func snapshot() async throws -> NativeJSON {
        let (connection, current) = try transport()
        let response = try await connection.request(.get, path: "/link/api/snapshot")
        guard epoch == current, revocation == nil else { throw NativeFailure.unavailable }
        try Task.checkCancellation()
        let value = try parseCheckpoint(response)
        // A Host instance changes only when a newly qualified transport is installed.
        guard value["instanceId"].string == instance else { throw NativeFailure.invalidRecord }
        let write = try acceptSnapshot(value)
        return try await persistCurrentSnapshot(write, epoch: current)
    }
    public func detail(_ id: String) async throws -> NativeJSON {
        guard LinkBytes.matches(id, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord }
        let current = epoch
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        try lease.requireValid()
        let value = try await read("/link/api/tasks/" + id, body: true)
        guard epoch == current else { throw NativeFailure.unavailable }
        guard value["summary"]["id"].string == id, value["sync"]["instanceId"].string == instance,
              let next = value["sync"]["revision"].integer, next >= (detailRevisions[id] ?? 0) else { throw NativeFailure.invalidRecord }
        detailRevisions[id] = next; detailOrder.removeAll { $0 == id }; detailOrder.append(id)
        while detailOrder.count > 16 { detailRevisions.removeValue(forKey: detailOrder.removeFirst()) }
        try await vault.storeBody(value.encoded(), name: "detail-" + id, lease: lease)
        guard epoch == current else { throw NativeFailure.unavailable }
        try lease.requireValid()
        return value
    }
    /** What this window last read of a session, for when the Mac has gone away. It opens no window, and never outlives one. */
    public func cachedDetail(_ id: String) async throws -> NativeJSON? {
        guard LinkBytes.matches(id, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord }
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        guard let data = try await vault.body(name: "detail-" + id, lease: lease) else { return nil }
        let value = try NativeJSON.decode(data)
        guard value["summary"]["id"].string == id else { throw NativeFailure.storageUnavailable }
        try lease.requireValid()
        return value
    }
    /** Read-only GETs whose query the Host needs: their path before `?` is fixed and the query only names a scope, file or session. */
    public static func readable(_ path: String) -> Bool {
        let base = path.firstIndex(of: "?").map { String(path[..<$0]) } ?? path
        // A `..` segment never leaves the route; a file named `[...slug].tsx` is encoded in the query and is fine.
        guard !base.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == ".." || $0 == "." }) else { return false }
        guard let mark = path.firstIndex(of: "?") else { return !path.contains("#") }
        let query = String(path[path.index(after: mark)...])
        guard !query.isEmpty, !query.contains("#"), !query.contains("?"), path.utf8.count <= 4096 else { return false }
        return LinkBytes.matches(base, "/link/api/tasks/[A-Za-z0-9_-]{1,160}/changes(/file)?") || base == "/link/api/handoffs"
            || base == "/link/api/history/sources"
            || (LinkBytes.matches(base, "/link/api/custom-agents/(general|agt_[a-f0-9-]{36})/(activity|library)") && query.hasPrefix("before=") && !query.contains("&"))
    }
    public func read(_ path: String, body: Bool, on expectedTransport: NativeTransportEpoch? = nil) async throws -> NativeJSON {
        guard Self.readable(path) else { throw NativeFailure.invalidRecord }
        let (connection, current) = try transport()
        if let expectedTransport, expectedTransport !== installedTransport || !expectedTransport.valid { throw CancellationError() }
        let lease = await verification.currentLease()
        if body { guard let lease else { throw NativeFailure.expired }; try lease.requireValid() }
        let response = try await connection.request(.get, path: path)
        guard epoch == current else { throw NativeFailure.unavailable }
        if body { try lease?.requireValid() }
        guard response.status == 200 else {
            if response.status == 503, (try? NativeJSON.decode(response.body))?["error"].string == "agent-write-unknown" {
                throw NativeReadFailure.agentWriteUnknown
            }
            if response.status == 408 || response.status >= 500 { throw NativeReadFailure.failed }
            throw await responseFailure(response, lease: lease)
        }
        return try NativeJSON.decode(response.body)
    }
    /** Task content uses the existing lease, including delivery's read-only POST. */
    public func readWork(_ read: PhoneWorkRead, on expectedTransport: NativeTransportEpoch) async throws -> NativeJSON {
        guard expectedTransport === installedTransport, expectedTransport.valid else { throw CancellationError() }
        let request = try read.request()
        let (connection, current) = try transport()
        guard PhoneWorkItems.supported(metadata) else { throw NativeFailure.unsupported }
        let device = metadata["device"], instance = self.instance
        guard device["status"].string == "active", device["scopes"].array.contains(.string("view")),
              !read.fileScope || PhoneWorkItems.canReadFiles(metadata) else { throw NativeFailure.forbidden }
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        func check() throws {
            try Task.checkCancellation()
            guard epoch == current, expectedTransport.valid else { throw CancellationError() }
            guard self.instance == instance else { throw NativeFailure.unavailable }
            try lease.requireValid()
            let latest = metadata["device"]
            guard ["id", "status", "scopes", "dataScope"].allSatisfy({ latest[$0] == device[$0] }),
                  PhoneWorkItems.supported(metadata),
                  read.sessionIds.allSatisfy({ PhoneWorkItems.sourceVisibility(metadata, sessionId: $0) == .readable }) else {
                throw NativeReadFailure.bodyAccessChanged
            }
        }
        try check()
        let response = try await connection.request(request.method, path: request.path, body: request.body, timeoutSeconds: request.timeout)
        try check()
        if response.status == 404 {
            let code = (try? NativeJSON.decode(response.body))?["error"].string
            switch code {
            case "item-not-found": throw PhoneWorkReadFailure.itemMissing
            case "post-not-found", "post-page-not-found": throw PhoneWorkReadFailure.postMissing
            case "post-reply-not-found": throw PhoneWorkReadFailure.replyMissing
            case "pr-check-not-found": throw PhoneWorkReadFailure.checkChanged
            default: break
            }
        }
        guard response.status == 200 else {
            if response.status == 408 || response.status >= 500 { throw NativeReadFailure.failed }
            throw await responseFailure(response, lease: lease)
        }
        return try NativeJSON.decode(response.body)
    }
    public func resolveFile(sessionId: String, reference: String, rootId: String?) async throws -> NativeJSON {
        guard LinkBytes.matches(sessionId, "[A-Za-z0-9_-]{1,160}"), !reference.isEmpty, reference.utf8.count <= 4096 else { throw NativeFailure.invalidRecord }
        let (connection, current) = try transport()
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        var fields: [String: NativeJSON] = ["paths": .array([.string(reference)])]
        if let rootId {
            guard LinkBytes.matches(rootId, "[A-Za-z0-9_-]{1,32}") else { throw NativeFailure.invalidRecord }; fields["rootId"] = .string(rootId)
        }
        let response = try await connection.request(.post, path: "/link/api/tasks/\(sessionId)/files/resolve", body: NativeJSON.object(fields).encoded())
        guard epoch == current else { throw NativeFailure.unavailable }
        guard response.status == 200 else { throw await responseFailure(response, lease: lease) }; try lease.requireValid()
        return try NativeJSON.decode(response.body)
    }
    /** `attachment`: a handle from `resolveAttachment`, read from the attachment content route, never through a bulk companion. */
    public func fileBytes(handle: String, etag: String, offset: Int, count: Int, explicitOpen: Bool = false, attachment: Bool = false,
        progress: (@Sendable (Int, Int) -> Void)? = nil) async throws -> Data {
        guard LinkBytes.matches(handle, "[A-Za-z0-9_-]{22}"), LinkBytes.matches(etag, "\"[a-f0-9]{32}\""),
              offset >= 0, offset <= 8_388_608, count > 0, count <= 1_048_576 else { throw NativeFailure.invalidRecord }
        let (primary, current) = try transport()
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }; try lease.requireValid()
        let useBulk = !attachment && explicitOpen && primary.usesRelay && count >= 131_072 && metadata["catalog"]["features"]["nativeBulk"].bool
        guard !useBulk || !bulkBusy else { throw NativeFailure.unavailable }
        if !useBulk {
            return try await readFile(connection: primary, handle: handle, etag: etag, offset: offset, count: count,
                epoch: current, lease: lease, attachment: attachment, progress: progress)
        }
        bulkBusy = true
        let operation = Task { try await self.readBulk(handle: handle, etag: etag, offset: offset, count: count,
            epoch: current, lease: lease, progress: progress) }
        bulkRun = operation
        defer { bulkRun = nil; bulkBusy = false }
        return try await withTaskCancellationHandler { try await operation.value } onCancel: { operation.cancel() }
    }
    private func readBulk(handle: String, etag: String, offset: Int, count: Int, epoch current: UUID, lease: BodyLease,
        progress: (@Sendable (Int, Int) -> Void)?) async throws -> Data {
        do {
            let connection = try await companion(handle: handle, etag: etag, minimum: offset + count, epoch: current, lease: lease)
            let result: Data
            if metadata["catalog"]["features"]["nativeBulkStream"].bool, let bulk, bulk.connection === connection {
                result = try await connection.fileRange(handle: handle, etag: etag, offset: offset, count: count, total: bulk.size, lease: lease, progress: progress)
                try Task.checkCancellation(); try lease.requireValid()
                guard epoch == current else { throw NativeFailure.unavailable }
            } else {
                result = try await readFile(connection: connection, handle: handle, etag: etag, offset: offset, count: count,
                    epoch: current, lease: lease, progress: progress)
            }
            coverCompanion()
            return result
        } catch { await closeCompanion(); if Task.isCancelled { throw CancellationError() }; throw error }
    }
    private func companion(handle: String, etag: String, minimum: Int, epoch current: UUID, lease: BodyLease) async throws -> NativeHTTPConnection {
        await bulkClosing?.value
        bulkCover?.cancel(); bulkCover = nil
        if let bulk, bulk.handle == handle, bulk.etag == etag, bulk.started.duration(to: .now) < .seconds(55) {
            try lease.requireValid(); guard epoch == current else { throw NativeFailure.unavailable }; return bulk.connection
        }
        await closeCompanion()
        guard let reopen else { throw NativeFailure.unavailable }
        let next = try await NativeHTTPConnection.$fileTransferBuffer.withValue(true) { try await reopen() }
        do {
            guard next.usesRelay, epoch == current, !Task.isCancelled else { throw NativeFailure.unavailable }
            let original = try await verification.attachCompanion(on: next)
            try original.requireValid(); try lease.requireValid()
            guard epoch == current else { throw NativeFailure.unavailable }
            let response = try await next.request(.post, path: "/link/api/native/bulk", body: NativeJSON.object([
                "handle": .string(handle), "etag": .string(etag), "requestId": .string(UUID().uuidString),
            ]).encoded())
            guard response.status == 200, epoch == current, !Task.isCancelled else { throw NativeFailure.unavailable }
            try lease.requireValid()
            let value = try NativeJSON.decode(response.body)
            guard Set(value.object.keys) == Set(["size", "expiresAt"]), let size = value["size"].integer,
                  size >= max(131_072, minimum), let expiry = value["expiresAt"].string,
                  let until = Self.bulkDate(expiry), until > Date(),
                  until <= lease.verifiedUntil, until.timeIntervalSinceNow <= 60 else { throw NativeFailure.invalidRecord }
            guard size <= 8_388_608 else { throw NativeFailure.invalidRecord }
            bulk = (next, handle, etag, Int(size), .now)
            return next
        } catch { await next.close(); throw error }
    }
    private static func bulkDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }
    private func coverCompanion() {
        guard let bulk else { return }
        let connection = bulk.connection, end = bulk.started.advanced(by: .seconds(5))
        bulkCover?.cancel()
        bulkCover = Task {
            do { try await Task.sleep(until: end, clock: .continuous); try Task.checkCancellation() }
            catch { return }
            await self.closeCompanion(ifSame: connection)
        }
    }
    private func closeCompanion(ifSame connection: NativeHTTPConnection) async {
        guard bulk?.connection === connection else { return }; await closeCompanion()
    }
    private func readFile(connection: NativeHTTPConnection, handle: String, etag: String, offset: Int, count: Int,
        epoch current: UUID, lease: BodyLease, attachment: Bool = false, progress: (@Sendable (Int, Int) -> Void)?) async throws -> Data {
        // The first bounded block can render before the rest. At most four independently checked ranges are in flight.
        let first = min(16_384, count)
        let initial = try await fileChunk(connection: connection, handle: handle, etag: etag, start: offset, amount: first, epoch: current, lease: lease, attachment: attachment)
        let total = initial.1
        guard total >= offset + count else { throw NativeFailure.invalidRecord }
        var result = initial.0, received = first
        progress?(received, count)
        var ranges: [(Int, Int)] = [], at = first
        while at < count { let amount = min(65_536, count - at); ranges.append((offset + at, amount)); at += amount }
        try await withThrowingTaskGroup(of: (Int, Data).self) { group in
            var next = 0, completed: [Int: Data] = [:], append = 0
            func enqueue(_ index: Int) {
                let range = ranges[index]
                group.addTask {
                    let chunk = try await self.fileChunk(connection: connection, handle: handle, etag: etag,
                        start: range.0, amount: range.1, epoch: current, lease: lease, attachment: attachment)
                    guard chunk.1 == total else { throw NativeFailure.invalidRecord }; return (index, chunk.0)
                }
            }
            while next < min(4, ranges.count) { enqueue(next); next += 1 }
            while let (index, chunk) = try await group.next() {
                try Task.checkCancellation(); try lease.requireValid()
                guard epoch == current else { throw NativeFailure.unavailable }
                completed[index] = chunk; received += chunk.count; progress?(received, count)
                while let bytes = completed.removeValue(forKey: append) { result.append(bytes); append += 1 }
                if next < ranges.count { enqueue(next); next += 1 }
            }
        }
        try Task.checkCancellation(); try lease.requireValid()
        guard epoch == current, result.count == count else { throw NativeFailure.unavailable }; return result
    }
    private func fileChunk(connection: NativeHTTPConnection, handle: String, etag: String, start: Int, amount: Int,
        epoch current: UUID, lease: BodyLease, attachment: Bool = false) async throws -> (Data, Int) {
        try Task.checkCancellation(); try lease.requireValid()
        guard epoch == current else { throw NativeFailure.unavailable }
        let response = try await connection.request(.get, path: attachment ? "/link/api/attachments/" + handle + "/content" : "/link/api/files/" + handle,
            headers: ["if-match": etag, "range": "bytes=\(start)-\(start + amount - 1)"], maximum: max(amount, 8192))
        try Task.checkCancellation(); try lease.requireValid()
        guard epoch == current else { throw NativeFailure.unavailable }
        guard response.status == 206 else { throw await responseFailure(response, lease: lease) }
        guard response.headers["etag"] == etag, let range = response.headers["content-range"],
              LinkBytes.matches(range, "bytes \(start)-\(start + amount - 1)/[0-9]+"), response.body.count == amount,
              let size = range.split(separator: "/").last.flatMap({ Int($0) }), size >= start + amount else { throw NativeFailure.invalidRecord }
        return (response.body, size)
    }
    /** What this composer's Harness and model take; inside a body window, as every other read of a session's setup. */
    public func attachmentCapabilities(selection: NativeJSON, sessionId: String?) async throws -> PhoneAttachCaps {
        if let sessionId { guard LinkBytes.matches(sessionId, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord } }
        let (connection, current) = try transport()
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }; try lease.requireValid()
        let body = try NativeJSON.object(PhoneAttachments.context(selection: selection, sessionId: sessionId)).encoded()
        let response = try await connection.request(.post, path: "/link/api/attachments/capabilities", body: body, maximum: 65_536)
        guard epoch == current else { throw NativeFailure.unavailable }
        guard response.status == 200 else { throw await responseFailure(response, lease: lease) }
        guard let caps = PhoneAttachCaps.parse(try NativeJSON.decode(response.body)) else { throw NativeFailure.invalidRecord }
        return caps
    }
    /**
     * One attachment's bytes, one at a time. The Host keeps an upload by device and requestId, so a retry of the same
     * bytes after an unknown answer gets the same attachment; nothing here retries by itself. A refusal comes back as the
     * Host's own code and words. A file larger than one stream goes in parts (`uploadInParts`). The bytes are read from
     * the row's staged file, at most one stream's worth at a time.
     */
    public func uploadAttachment(_ draft: PhoneAttachDraft, selection: NativeJSON, sessionId: String?,
        progress: (@Sendable (Int, Int) -> Void)? = nil, started: (@Sendable (String) -> Void)? = nil) async throws -> NativeJSON {
        guard LinkBytes.matches(draft.requestId, "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"),
              (1...PhoneAttachments.largestFile).contains(draft.size) else { throw NativeFailure.invalidRecord }
        if let sessionId { guard LinkBytes.matches(sessionId, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord } }
        guard let file = draft.file, file.size == draft.size else { throw NativeFailure.invalidRecord }
        if draft.size > PhoneAttachments.streamBytes {
            return try await uploadInParts(draft, selection: selection, sessionId: sessionId, progress: progress, started: started)
        }
        let header = try PhoneAttachments.header(draft, selection: selection, sessionId: sessionId)
        let (connection, current) = try transport()
        guard !uploading else { throw NativeFailure.busy }
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }; try lease.requireValid()
        uploading = true; defer { uploading = false }
        let body = try PhoneAttachStage.read(file, offset: 0, count: draft.size)
        let response = try await connection.upload(metadata: header, body: body, lease: lease, timeoutSeconds: 60, progress: progress)
        // A path replacement leaves this upload unknown; the same requestId tells the Host it is the same one.
        guard epoch == current else { throw NativeFailure.resultUnknown }
        if response.status == 201 {
            guard let ref = try? NativeJSON.decode(response.body)["attachment"], PhoneAttachments.validRef(ref) else { throw NativeFailure.resultUnknown }
            return ref
        }
        if response.status == 408 || response.status >= 500 { throw NativeFailure.resultUnknown }
        let failure = await responseFailure(response, lease: lease)
        if failure != .expired, let refusal = NativeHostRefusal.parse(status: response.status, body: response.body) { throw refusal }
        throw failure
    }
    /**
     * A file larger than one stream, in parts of 1 MiB, each its own stream with the same per-chunk checks. The start
     * names the request, so starting again after an unknown answer finds the same upload on the Host and sends only the
     * parts it lacks, from the next one it asks for; a part it has is not sent again. Cancel closes the part's stream,
     * waits for it, then aborts the upload on the Host. The start itself is not cut off by a cancel: its answer names
     * the upload, which is then aborted. `started` hears the upload's ID, so a row removed later can abort it too.
     */
    private func uploadInParts(_ draft: PhoneAttachDraft, selection: NativeJSON, sessionId: String?,
        progress: (@Sendable (Int, Int) -> Void)?, started report: (@Sendable (String) -> Void)?) async throws -> NativeJSON {
        let start = try PhoneAttachments.uploadStart(draft, selection: selection, sessionId: sessionId)
        guard let file = draft.file else { throw NativeFailure.invalidRecord }
        let (connection, current) = try transport()
        guard !uploading else { throw NativeFailure.busy }
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }; try lease.requireValid()
        uploading = true; defer { uploading = false }
        var started: String?
        do {
            for _ in 0..<2 {
                // Outside this task, so a cancel meanwhile still hears which upload the Host began.
                let begun = try await Task { try await connection.request(.post, path: "/link/api/attachments/uploads", body: start, maximum: 65_536) }.value
                guard epoch == current else { throw NativeFailure.resultUnknown }
                guard begun.status == 201 else { throw await uploadFailure(begun, lease: lease) }
                guard var upload = PhoneAttachUpload.parse(try NativeJSON.decode(begun.body), size: draft.size) else { throw NativeFailure.resultUnknown }
                if let ref = upload.attachment { return ref }
                started = upload.id
                report?(upload.id)
                try Task.checkCancellation()
                let base = "/link/api/attachments/uploads/" + upload.id
                var steps = 0
                parts: while true {
                    steps += 1
                    guard steps <= upload.parts * 2 + 4 else { throw NativeFailure.resultUnknown }
                    guard let next = upload.next else {
                        var fields: [String: NativeJSON] = [:]
                        if draft.secretAcknowledged { fields["secretAcknowledged"] = .bool(true) }
                        let done = try await connection.request(.post, path: base + "/complete", body: try NativeJSON.object(fields).encoded(),
                            maximum: 65_536, timeoutSeconds: 60)
                        guard epoch == current else { throw NativeFailure.resultUnknown }
                        if done.status == 201 {
                            guard let ref = try? NativeJSON.decode(done.body)["attachment"], PhoneAttachments.validRef(ref) else { throw NativeFailure.resultUnknown }
                            return ref
                        }
                        // The Host lacks a part after all: it says which one to send next.
                        let refusal = NativeHostRefusal.parse(status: done.status, body: done.body)
                        if refusal?.code == "attachment-incomplete", let missing = refusal?.details["next"].integer, missing < UInt64(upload.parts) {
                            upload.next = Int(missing); continue parts
                        }
                        if refusal?.code == "upload-missing" { started = nil; break parts }
                        throw await uploadFailure(done, lease: lease)
                    }
                    let offset = next * PhoneAttachments.streamBytes, end = min(offset + PhoneAttachments.streamBytes, draft.size)
                    let body = try PhoneAttachStage.read(file, offset: offset, count: end - offset)
                    let total = draft.size
                    let response = try await connection.upload(metadata: nil, part: base + "/parts/\(next)", body: body, lease: lease, timeoutSeconds: 60) { done, _ in
                        progress?(offset + done, total)
                    }
                    guard epoch == current else { throw NativeFailure.resultUnknown }
                    if response.status == 200 {
                        guard let parsed = PhoneAttachUpload.parse(try NativeJSON.decode(response.body), size: draft.size) else { throw NativeFailure.resultUnknown }
                        if let ref = parsed.attachment { return ref }
                        guard parsed.id == upload.id else { throw NativeFailure.resultUnknown }
                        upload = parsed; continue
                    }
                    let refusal = NativeHostRefusal.parse(status: response.status, body: response.body)
                    if refusal?.code == "upload-part-order", let missing = refusal?.details["next"].integer, missing < UInt64(upload.parts) {
                        upload.next = Int(missing); continue
                    }
                    // Expired on the Host meanwhile: start once more, from the first part.
                    if refusal?.code == "upload-missing" { started = nil; break parts }
                    throw await uploadFailure(response, lease: lease)
                }
            }
            throw NativeFailure.resultUnknown
        } catch {
            if Task.isCancelled {
                if let started { await abortUpload(connection, started) }
                throw CancellationError()
            }
            throw error
        }
    }
    /** Aborts this device's unfinished chunked upload on the Host (a row removed before it finished); best effort. */
    public func abortAttachmentUpload(_ id: String) async {
        guard LinkBytes.matches(id, "[A-Za-z0-9_-]{22}"), let (connection, _) = try? transport() else { return }
        await abortUpload(connection, id)
    }
    /** Not under the cancelled task, so the abort itself still goes; briefly, as the parts expire on the Host anyway. */
    private func abortUpload(_ connection: NativeHTTPConnection, _ id: String) async {
        await Task { _ = try? await connection.request(.delete, path: "/link/api/attachments/uploads/" + id, maximum: 65_536, timeoutSeconds: 5) }.value
    }
    private func uploadFailure(_ response: NativeHTTPResponse, lease: BodyLease) async -> any Error {
        if response.status == 408 || response.status >= 500 { return NativeFailure.resultUnknown }
        let failure = await responseFailure(response, lease: lease)
        if failure != .expired, let refusal = NativeHostRefusal.parse(status: response.status, body: response.body) { return refusal }
        return failure
    }
    /** Drops this device's unsent upload on the Host; a draft it cannot drop expires there within the hour. */
    public func removeAttachment(_ id: String) async throws {
        guard LinkBytes.matches(id, "[A-Za-z0-9_-]{22}") else { throw NativeFailure.invalidRecord }
        let (connection, current) = try transport()
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }; try lease.requireValid()
        let response = try await connection.request(.delete, path: "/link/api/attachments/" + id, maximum: 65_536)
        guard epoch == current else { throw NativeFailure.unavailable }
        guard response.status == 200 || response.status == 404 else { throw await responseFailure(response, lease: lease) }
    }
    /** A short-lived handle for a sent attachment's bytes, bound to this device; the same metadata a file preview reads. */
    public func resolveAttachment(_ id: String) async throws -> NativeJSON {
        guard LinkBytes.matches(id, "[A-Za-z0-9_-]{22}") else { throw NativeFailure.invalidRecord }
        let (connection, current) = try transport()
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }; try lease.requireValid()
        let response = try await connection.request(.post, path: "/link/api/attachments/" + id + "/resolve", body: Data("{}".utf8), maximum: 65_536)
        guard epoch == current else { throw NativeFailure.unavailable }
        guard response.status == 200 else { throw await responseFailure(response, lease: lease) }
        try lease.requireValid()
        return try NativeJSON.decode(response.body)["file"]
    }
    /**
     * `timeoutSeconds`: how long this write may take on the Host, at most eleven minutes (a commit's hooks). `explain`: a
     * refusal comes back as the Host's own code, words and details. `retryAnswered`: which refusals of a retry of this write
     * the Host answered from its receipt, so they settle it rather than leave it unknown.
     */
    public func submit(_ pending: NativePendingWrite, timeoutSeconds: Int64 = 15, explain: Bool = false, retryAnswered: (@Sendable (NativeHostRefusal) -> Bool)? = nil) async throws -> NativeJSON {
        guard (1...660).contains(timeoutSeconds) else { throw NativeFailure.invalidRecord }
        let (connection, current) = try transport()
        // In flight from before the first await, so settlePending refuses it for the whole of this attempt.
        guard writes.isEmpty else { throw NativeFailure.expired }
        writes.insert(pending.requestId); defer { writes.remove(pending.requestId) }
        guard let lease = await verification.currentLease(), let method = NativeHTTPMethod(rawValue: pending.method),
              method != .get && method != .head else { throw NativeFailure.expired }
        try lease.requireValid()
        let decoded = try NativeJSON.decode(pending.body)
        let queueEdit = method == .patch && LinkBytes.matches(pending.path, "/link/api/tasks/[A-Za-z0-9_-]{1,160}/queue/[A-Za-z0-9_-]{1,160}")
        guard queueEdit || decoded["requestId"].string == pending.requestId else { throw NativeFailure.invalidRecord }
        var index = try await pendingIndex()
        let retry = index.contains(pending.requestId)
        if retry {
            guard let data = try await vault.body(name: "pending-" + pending.requestId, lease: lease) else { throw NativeFailure.storageUnavailable }
            let previous = try JSONDecoder().decode(NativePendingWrite.self, from: data)
            guard previous.method == pending.method, previous.path == pending.path, previous.body == pending.body else { throw NativeFailure.invalidRecord }
        } else { try await vault.storeBody(JSONEncoder().encode(pending), name: "pending-" + pending.requestId, lease: lease) }
        guard index.contains(pending.requestId) || index.count < 64 else { throw NativeFailure.storageUnavailable }
        if !index.contains(pending.requestId) { index.append(pending.requestId) }
        try await vault.storeMetadata(JSONEncoder().encode(index), name: "pending-index")
        guard epoch == current, lease.valid else { throw NativeFailure.resultUnknown }
        let response: NativeHTTPResponse
        do { response = try await connection.request(method, path: pending.path, body: pending.body, timeoutSeconds: timeoutSeconds) }
        catch { throw NativeFailure.resultUnknown }
        // Even a path replacement leaves the original write unknown; it must never become a new request.
        guard epoch == current else { throw NativeFailure.resultUnknown }
        if (200..<300).contains(response.status) {
            guard let value = try? NativeJSON.decode(response.body) else { throw NativeFailure.resultUnknown }
            if PhoneHelperCreate.isCreation(pending), (try? PhoneHelperCreate.createdId(value, for: pending)) == nil {
                throw NativeFailure.resultUnknown
            }
            try? await removePending(pending.requestId)
            return value
        }
        // A 5xx whose code says the Host accepted nothing (a Harness that could not start) is a refusal, not unknown.
        if NativeHostRefusal.leavesUnknown(status: response.status, body: response.body) { throw NativeFailure.resultUnknown }
        let refusal = NativeHostRefusal.parse(status: response.status, body: response.body)
        // A retry's denial says nothing about whether the first submission ran before permissions changed, unless the
        // Host answered it from the first one's receipt.
        if retry, !(refusal.map { retryAnswered?($0) ?? false } ?? false) {
            // Still unknown; with `explain` the Host's words come along for the line under the row.
            if explain, let refusal { throw NativeUnsettledRefusal(refusal: refusal) }
            throw NativeFailure.resultUnknown
        }
        try? await removePending(pending.requestId)
        // Its own words: the generic failure of a 5xx would say nothing of the Harness that could not start.
        if response.status >= 500, let refusal { throw refusal }
        let failure = await responseFailure(response, lease: lease)
        if explain, let refusal, failure != .expired { throw refusal }
        throw failure
    }
    /**
     * Drops this device's copy of a write the Host now holds and answers itself (an open review-note send). The caller
     * shows what the Host lists; nothing is sent again from here.
     */
    public func settlePending(_ requestId: String) async throws {
        guard LinkBytes.matches(requestId, "[A-Za-z0-9_-]{16,80}"), !writes.contains(requestId) else { throw NativeFailure.invalidRecord }
        try await removePending(requestId)
    }
    /** What this device has looked at on this computer, kept in its encrypted vault and never on the Host. */
    public func seen() async throws -> PhoneSeen {
        guard revocation == nil else { throw NativeFailure.revoked }
        if let data = try await vault.metadata(name: "review-seen"), let value = PhoneSeen.decode(data) { return value }
        let fresh = PhoneSeen.fresh()
        try await vault.storeMetadata(JSONEncoder().encode(fresh), name: "review-seen")
        return fresh
    }
    public func storeSeen(_ value: PhoneSeen) async throws {
        guard revocation == nil, value.seen.count <= PhoneSeen.limit else { throw NativeFailure.invalidRecord }
        try await vault.storeMetadata(JSONEncoder().encode(value), name: "review-seen")
    }
    public func pendingWrites() async throws -> [NativePendingWrite] {
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        var result: [NativePendingWrite] = []
        for id in try await pendingIndex() {
            guard let body = try await vault.body(name: "pending-" + id, lease: lease) else { throw NativeFailure.storageUnavailable }
            let pending = try JSONDecoder().decode(NativePendingWrite.self, from: body)
            guard pending.requestId == id, pending.body.count <= 1_048_576 else { throw NativeFailure.storageUnavailable }
            // An earlier build's write for an assistant, group or routine: the Host refuses it now, and a retry's refusal stays unknown for good.
            if pending.path.hasPrefix("/link/api/personal/")
                || pending.path == "/link/api/tasks" && ((try? NativeJSON.decode(pending.body))?["assistantId"] ?? .null) != .null {
                try await removePending(id); continue
            }
            result.append(pending)
        }
        return result
    }
    private func pendingIndex() async throws -> [String] {
        guard let data = try await vault.metadata(name: "pending-index") else { return [] }
        let ids = try JSONDecoder().decode([String].self, from: data)
        guard ids.count <= 64, Set(ids).count == ids.count,
              ids.allSatisfy({ LinkBytes.matches($0, "[A-Za-z0-9_-]{16,80}") }) else { throw NativeFailure.storageUnavailable }
        return ids
    }
    private func removePending(_ id: String) async throws {
        let index = try await pendingIndex().filter { $0 != id }
        try await vault.storeMetadata(JSONEncoder().encode(index), name: "pending-index")
        try await vault.remove(name: "pending-" + id, body: true)
    }
    /** Free cancel/reject/pause do not require a body window. No arbitrary note or allow field is accepted. */
    public func freeAction(path: String, fields: [String: NativeJSON]) async throws -> NativeJSON {
        let cancel = LinkBytes.matches(path, "/link/api/tasks/[A-Za-z0-9_-]{1,160}/cancel")
        let reject = LinkBytes.matches(path, "/link/api/approvals/[A-Za-z0-9_-]{1,160}") && fields["decision"] == .string("reject")
        guard cancel || reject,
              Set(fields.keys).isSubset(of: cancel ? ["requestId", "runId"] : ["requestId", "decision"]) else { throw NativeFailure.invalidRecord }
        guard let id = fields["requestId"]?.string, LinkBytes.matches(id, "[A-Fa-f0-9-]{36}"), !controlBusy else { throw NativeFailure.invalidRecord }
        if let run = fields["runId"]?.string { guard LinkBytes.matches(run, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord } }
        controlBusy = true
        defer { controlBusy = false }
        let previous = try await pendingControl()
        if let previous {
            guard previous["fields"]["requestId"].string == fields["requestId"]?.string else { throw NativeFailure.resultUnknown }
            guard previous["path"].string == path, previous["fields"] == .object(fields) else { throw NativeFailure.invalidRecord }
        }
        let (connection, current) = try transport()
        try await vault.storeMetadata(NativeJSON.object(["path": .string(path), "fields": .object(fields)]).encoded(), name: "control-pending")
        let response: NativeHTTPResponse
        // The Host answers a stop only once the run has settled, and it force-stops a run at 30 seconds.
        do { response = try await connection.request(.post, path: path, body: NativeJSON.object(fields).encoded(), timeoutSeconds: reject ? 15 : 45) }
        catch { throw NativeFailure.resultUnknown }
        guard epoch == current else { throw NativeFailure.resultUnknown }
        guard response.status == 200 else {
            if previous != nil { throw NativeFailure.resultUnknown }
            if (400..<500).contains(response.status) && response.status != 408 { try? await vault.remove(name: "control-pending", body: false) }
            throw response.status >= 500 || response.status == 408 ? NativeFailure.resultUnknown : NativeFailure.unavailable
        }
        let value = try NativeJSON.decode(response.body)
        try? await vault.remove(name: "control-pending", body: false)
        return value
    }
    /**
     * Stops one subagent alone. It narrows like a cancel and the Host's schema takes no requestId, so nothing is kept to
     * replay: a lost answer leaves the row to say what the subagent reports. It still needs the content window.
     */
    public func stopSubagent(sessionId: String, subagentId: String) async throws -> NativeJSON {
        guard LinkBytes.matches(sessionId, "[A-Za-z0-9_-]{1,160}"), !subagentId.isEmpty, subagentId.utf8.count <= 256,
              subagentId.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 }) else { throw NativeFailure.invalidRecord }
        let (connection, current) = try transport()
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        try lease.requireValid()
        let body = try NativeJSON.object(["subagentId": .string(subagentId)]).encoded()
        let response: NativeHTTPResponse
        do { response = try await connection.request(.post, path: "/link/api/tasks/\(sessionId)/stop-subagent", body: body) }
        catch { throw NativeFailure.resultUnknown }
        guard epoch == current else { throw NativeFailure.resultUnknown }
        guard response.status == 200 else { throw await responseFailure(response, lease: lease) }
        try lease.requireValid()
        return try NativeJSON.decode(response.body)
    }
    /**
     * Rename, pin, archive or delete, as the web sends them: inside the window, no requestId and nothing kept to replay.
     * A lost answer is unknown; the caller reads the list again, and what the Host lists is the truth.
     */
    public func sessionAction(_ request: PhoneSessionRequest) async throws -> NativeJSON {
        guard request.method == .patch || request.method == .delete, LinkBytes.matches(request.path, "/link/api/tasks/[A-Za-z0-9_-]{1,160}"),
              request.fields["requestId"] == nil else { throw NativeFailure.invalidRecord }
        let (connection, current) = try transport()
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        try lease.requireValid()
        let body = request.method == .delete ? nil : try NativeJSON.object(request.fields).encoded()
        let response: NativeHTTPResponse
        do { response = try await connection.request(request.method, path: request.path, body: body) }
        catch { throw NativeFailure.resultUnknown }
        guard epoch == current else { throw NativeFailure.resultUnknown }
        guard (200..<300).contains(response.status) else { throw await responseFailure(response, lease: lease) }
        return (try? NativeJSON.decode(response.body)) ?? .null
    }
    /** The Host's full-text search. Its hits are content: read inside a window, returned, never stored. */
    public func search(_ query: String) async throws -> NativeJSON {
        guard let q = PhoneSearch.query(query) else { throw NativeFailure.invalidRecord }
        let (connection, current) = try transport()
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        try lease.requireValid()
        let body = try NativeJSON.object(["q": .string(q), "limit": .number(Double(PhoneSearch.limit))]).encoded()
        let response = try await connection.request(.post, path: "/link/api/search", body: body)
        guard epoch == current else { throw NativeFailure.unavailable }
        guard response.status == 200 else { throw await responseFailure(response, lease: lease) }
        try lease.requireValid()
        return try NativeJSON.decode(response.body)
    }
    /**
     * 接入已有会话's listing and preview: POSTs that put nothing on record (the Host audits them) and carry no requestId,
     * read inside the window like content and never stored. A refusal comes back as the Host's own code and words.
     */
    public func historyRead(_ request: PhoneHistoryRead) async throws -> NativeJSON {
        guard request.path == "/link/api/history/list" || request.path == "/link/api/history/previews", (1...120).contains(request.timeoutSeconds),
              request.fields["requestId"] == nil else { throw NativeFailure.invalidRecord }
        let (connection, current) = try transport()
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        try lease.requireValid()
        let response = try await connection.request(.post, path: request.path, body: NativeJSON.object(request.fields).encoded(), timeoutSeconds: request.timeoutSeconds)
        // Too late to show: a preview the Host opened still holds the session, so the caller lets go of it.
        guard epoch == current, lease.valid else {
            if (200..<300).contains(response.status), let id = (try? NativeJSON.decode(response.body))?["previewId"].string,
               LinkBytes.matches(id, "hp_[a-f0-9]{32}") { throw NativeDroppedPreview(previewId: id) }
            throw epoch == current ? NativeFailure.expired : NativeFailure.unavailable
        }
        guard (200..<300).contains(response.status) else {
            let failure = await responseFailure(response, lease: lease)
            if failure != .expired, let refusal = NativeHostRefusal.parse(status: response.status, body: response.body) { throw refusal }
            throw failure
        }
        try lease.requireValid()
        return try NativeJSON.decode(response.body)
    }
    /** The Host's receipt of an unanswered import, for 核对并放下: done, still under way, or never started. Inside the window. */
    public func historyReceipt(_ write: NativePendingWrite) async throws -> PhoneImportReceipt {
        guard let path = PhoneHistory.receiptPath(write) else { throw NativeFailure.invalidRecord }
        let (connection, current) = try transport()
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        try lease.requireValid()
        let response = try await connection.request(.get, path: path)
        guard epoch == current else { throw NativeFailure.unavailable }
        if response.status == 404, NativeHostRefusal.parse(status: 404, body: response.body)?.code == "history-import-not-found" { return .none }
        if response.status == 202 { return .pending }
        guard response.status == 200 else { throw await responseFailure(response, lease: lease) }
        let value = try NativeJSON.decode(response.body)
        guard value["requestId"].string == write.requestId, let taskId = PhoneHistory.importedTask(value) else { throw NativeFailure.invalidRecord }
        return .done(taskId: taskId)
    }
    /** Lets go of a preview the Host holds open. Best effort: the Host closes it by itself after ten minutes. */
    public func closeHistoryPreview(_ previewId: String) async throws {
        let path = try PhoneHistory.closePath(previewId)
        let (connection, current) = try transport()
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        try lease.requireValid()
        let response = try await connection.request(.delete, path: path)
        guard epoch == current else { throw NativeFailure.unavailable }
        guard (200..<300).contains(response.status) else { throw await responseFailure(response, lease: lease) }
    }
    /** Only ever lengthens how long the Host stays quiet about silence; it needs view scope, not a write identity. */
    public func keepWaiting(sessionId: String, runId: String, thresholdMs: UInt64) async throws -> NativeJSON {
        guard LinkBytes.matches(sessionId, "[A-Za-z0-9_-]{1,160}"), LinkBytes.matches(runId, "[A-Za-z0-9_-]{1,160}"), thresholdMs > 0, thresholdMs <= LinkBytes.maximumInteger else { throw NativeFailure.invalidRecord }
        let (connection, current) = try transport()
        let lease = await verification.currentLease()
        let body = try NativeJSON.object(["runId": .string(runId), "thresholdMs": .number(Double(thresholdMs))]).encoded()
        let response = try await connection.request(.post, path: "/link/api/tasks/\(sessionId)/keep-waiting", body: body)
        guard epoch == current else { throw NativeFailure.unavailable }
        guard response.status == 200 else { throw await responseFailure(response, lease: lease) }
        return try NativeJSON.decode(response.body)
    }
    /**
     * Asks the Host to remove this phone. It needs no window, and the Host closes this connection as it does so, so a lost
     * answer proves nothing: only the Root-signed tombstone on the next connection lets the caller wipe anything.
     */
    public func removeThisDevice() async {
        guard let (connection, _) = try? transport() else { return }
        _ = try? await connection.request(.delete, path: "/link/api/devices/current")
    }
    public func pendingControl() async throws -> NativeJSON? {
        guard let data = try await vault.metadata(name: "control-pending") else { return nil }
        let value = try NativeJSON.decode(data)
        guard Set(value.object.keys) == Set(["path", "fields"]), let path = value["path"].string,
              LinkBytes.matches(path, "/link/api/(tasks/[A-Za-z0-9_-]{1,160}/cancel|approvals/[A-Za-z0-9_-]{1,160})"),
              Set(value["fields"].object.keys).isSubset(of: ["requestId", "runId", "decision"]) else { throw NativeFailure.storageUnavailable }
        return value
    }
    /** Selects one body without opening a verification window. A new selection invalidates every earlier candidate. */
    public func beginBody(_ sessionId: String) async throws -> NativeBodyReading {
        guard LinkBytes.matches(sessionId, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord }
        let (_, current) = try transport()
        let intent = UUID(); bodyAttempt = intent
        let previous = bodyState?.stream, opening = bodyState?.opening
        bodyState?.withdraw(); bodyState = nil
        if let opening, let opened = try? await opening.value { await opened.cancel() }
        await previous?.cancel()
        guard let instance, let lease = await verification.currentLease() else { throw NativeFailure.expired }
        try lease.requireValid()
        let authority = NativeBodyAuthority()
        let publication = await NativeBodyPublication(instanceId: instance, sessionId: sessionId, authority: authority)
        guard bodyAttempt == intent, epoch == current, lease.valid else { authority.invalidate(); throw NativeFailure.expired }
        let reading = NativeBodyReading(publication: publication, owner: bodyOwner, sessionId: sessionId, authority: authority, lease: lease)
        let state = NativeBodyState(reading: reading, instanceId: instance, authority: authority, lease: lease)
        bodyState = state
        state.expiry = Task { [weak self] in
            do { try await lease.waitForInvalidation() } catch { return }
            await self?.expireBody(reading.id)
        }
        return reading
    }

    private func body(_ reading: NativeBodyReading) throws -> NativeBodyState {
        guard reading.owner == bodyOwner, let state = bodyState, state.reading.id == reading.id,
              instance?.utf8.elementsEqual(state.instanceId.utf8) == true else { try bodyUnavailable(reading) }
        try state.lease.requireValid()
        return state
    }
    private func bodyUnavailable(_ reading: NativeBodyReading) throws -> Never {
        guard reading.owner == bodyOwner else { throw NativeFailure.expired }
        // Only a checkpoint this Workspace validated can mark access changes. Expired/rejected windows still win.
        try reading.lease.requireValid()
        if reading.authority.accessWasChanged() { throw NativeReadFailure.bodyAccessChanged }
        throw NativeFailure.expired
    }
    /** Classifies a closed reader without opening a stream, reading content, signing or acknowledging progress. */
    public func checkBodyReading(_ reading: NativeBodyReading) throws { _ = try body(reading) }

    private func expireBody(_ id: UUID) async {
        guard let state = bodyState, state.reading.id == id else { return }
        let stream = state.stream, opening = state.opening
        state.withdraw(); bodyState = nil
        if let opening, let opened = try? await opening.value { await opened.cancel() }
        await stream?.cancel()
    }

    public func endBody(_ reading: NativeBodyReading) async {
        guard reading.owner == bodyOwner else { return }
        await expireBody(reading.id)
    }

    /** A logical reading may repair once. Reopening it afterwards always requests complete states. */
    public func events(for reading: NativeBodyReading, incremental: Bool = false) async throws -> NativeWorkspaceEvents {
        let state = try body(reading), current = epoch
        let previous = state.stream, opening = state.opening
        state.resetStream()
        let intent = state.streamAttempt
        if let opening, let opened = try? await opening.value { await opened.cancel() }
        await previous?.cancel()
        guard bodyState === state, state.streamAttempt == intent, epoch == current, state.lease.valid else { try bodyUnavailable(reading) }
        let operation = Task { try await self.openEvents(sessionId: reading.sessionId, expectedLease: state.lease,
            incremental: incremental && !state.repaired, reading: reading.id) }
        state.opening = operation
        defer { if state.streamAttempt == intent { state.opening = nil } }
        let stream = try await withTaskCancellationHandler { try await operation.value } onCancel: { operation.cancel() }
        guard bodyState === state, state.streamAttempt == intent, epoch == current, state.lease.valid else { await stream.cancel(); try bodyUnavailable(reading) }
        state.origin = stream.stream.origin; state.authority.bindStream(stream.stream.origin); state.stream = stream
        return stream
    }

    /** A real HTTP read is an offer only: it neither seeds the stream shadow nor advances applied revisions. */
    public func readBody(for reading: NativeBodyReading) async throws -> NativeBodyUpdate {
        try await readBody(reading, notice: nil)
    }

    public func refreshBody(for reading: NativeBodyReading, after notice: NativeBodyNotice) async throws -> NativeBodyUpdate {
        try await readBody(reading, notice: notice)
    }

    private func readBody(_ reading: NativeBodyReading, notice: NativeBodyNotice?) async throws -> NativeBodyUpdate {
        let state = try body(reading), current = epoch
        if let notice {
            guard notice.reading == reading.id, state.pending.contains(where: { $0.id == notice.id }),
                  notice.event.provenance?.origin === state.origin else { throw NativeFailure.invalidRecord }
        }
        let evidence = try state.authority.issue(lease: state.lease)
        let snapshot = notice == nil ? nil : try await self.snapshot()
        guard bodyState === state, epoch == current, state.authority.accepts(evidence) else { try bodyUnavailable(reading) }
        let detail = try await read("/link/api/tasks/" + reading.sessionId, body: true)
        guard bodyState === state, epoch == current, state.authority.accepts(evidence) else { try bodyUnavailable(reading) }
        var check = NativeTaskPublicationGate(instanceId: state.instanceId, sessionId: reading.sessionId)
        let ticket = check.capture()
        guard try check.acceptHTTP(detail.encoded(), ticket: ticket) != nil else { throw NativeFailure.invalidRecord }
        return try state.offer(NativeBodyUpdate(http: detail, snapshot: snapshot, evidence: evidence), priority: 1)
    }

    /** Each actual frame reaches the shadow before a publication revision can suppress it. */
    public func receive(_ event: NativeEvent, from stream: NativeWorkspaceEvents, for reading: NativeBodyReading) async throws -> NativeBodyEventResult {
        let state = try body(reading)
        guard stream.bodyReading == reading.id, stream.epoch == epoch,
              state.origin === stream.stream.origin, let provenance = event.provenance,
              provenance.origin === stream.stream.origin else { return .ignore }
        if provenance.ordinal <= state.ordinal { return .ignore }
        var cause = NativeBodyRepair.Cause.ordinal
        do {
            guard provenance.ordinal == state.ordinal + 1 else { throw NativeFailure.invalidRecord }
            state.ordinal = provenance.ordinal
            cause = .cursor
            if let cursor = event.cursor {
                guard cursor.epoch.utf8.elementsEqual(state.instanceId.utf8), cursor.sequence >= state.cursor else { throw NativeFailure.invalidRecord }
                state.cursor = cursor.sequence
            }
            cause = .control
            if event.type == "heartbeat" || event.type == "resumed" {
                guard event.data.isEmpty, event.cursor != nil else { throw NativeFailure.invalidRecord }
                cause = .ledger
                _ = try state.record(ordinal: provenance.ordinal, cursor: event.cursor, requirement: .none)
                cause = .receipt
                try await advanceBody(reading.id)
                return .ignore
            }
            if event.type == "task-state" || event.type == "task-delta" {
                cause = .cursor
                guard event.cursor != nil else { throw NativeFailure.invalidRecord }
                cause = .projection
                switch state.shadow.receive(type: event.type, data: event.data) {
                case .repair: throw NativeFailure.invalidRecord
                case .ignore: return .ignore
                case let .candidate(candidate):
                    cause = .ledger
                    let position = try state.record(ordinal: provenance.ordinal, cursor: event.cursor, requirement: .body(candidate.revision))
                    if state.covered(position) { cause = .receipt; try await advanceBody(reading.id); return .ignore }
                    cause = .authority
                    let evidence = try state.authority.issue(lease: state.lease, origin: provenance.origin)
                    cause = .offer
                    return .update(try state.offer(NativeBodyUpdate(stream: candidate, evidence: evidence), priority: 2))
                }
            }
            cause = .metadata
            let value = try NativeJSON.decode(event.data)
            guard value["type"].string == event.type else { throw NativeFailure.invalidRecord }
            if event.type == "host-state", event.cursor == nil {
                guard value["instanceId"].string?.utf8.elementsEqual(state.instanceId.utf8) == true else { return .ignore }
                return .hostState(event)
            }
            guard ["refresh", "tasks-invalidated"].contains(event.type),
                  value["instanceId"].string?.utf8.elementsEqual(state.instanceId.utf8) == true,
                  let revision = value["revision"].integer else { throw NativeFailure.invalidRecord }
            cause = .ledger
            let position = try state.record(ordinal: provenance.ordinal, cursor: event.cursor, requirement: .snapshot(revision))
            if state.covered(position) { cause = .receipt; try await advanceBody(reading.id); return .ignore }
            return .notice(NativeBodyNotice(event: event, reading: reading.id, id: position.id))
        } catch {
            guard bodyState === state, state.origin === provenance.origin else { try bodyUnavailable(reading) }
            let diagnostic = NativeBodyRepair(cause: cause, state: state)
            let failed = state.stream
            let repeated = state.repaired
            state.repaired = true; state.resetStream()
            await failed?.cancel()
            if repeated { throw error }
            return .repair(diagnostic)
        }
    }

    /** No caller-provided event, revision or cursor is accepted here. */
    public func applied(_ receipt: NativeBodyApplied) async throws {
        try await serializeCursor { try await self.applyBodyReceipt(receipt) }
    }

    private func applyBodyReceipt(_ receipt: NativeBodyApplied) async throws {
        guard let state = bodyState, state.authority.accepts(receipt.evidence) else { throw NativeFailure.expired }
        guard var offer = state.offers[receipt.evidence.id], offer.evidence === receipt.evidence else { return }
        if receipt.body {
            if state.bodyRevision == nil || offer.bodyRevision > state.bodyRevision!
                || offer.bodyRevision == state.bodyRevision && offer.priority > state.bodyPriority {
                state.bodyRevision = offer.bodyRevision; state.bodyPriority = offer.priority
            }
            detailRevisions[state.reading.sessionId] = max(detailRevisions[state.reading.sessionId] ?? 0, offer.bodyRevision)
            detailOrder.removeAll { $0 == state.reading.sessionId }; detailOrder.append(state.reading.sessionId)
            while detailOrder.count > 16 { detailRevisions.removeValue(forKey: detailOrder.removeFirst()) }
        }
        if receipt.snapshot, let revision = offer.snapshotRevision { state.snapshotRevision = max(state.snapshotRevision ?? 0, revision) }
        offer.applied = true; state.offers[receipt.evidence.id] = offer
        if receipt.body, let latest = state.latest, latest.evidence === receipt.evidence {
            let current = epoch
            try await vault.storeBody(latest.detail.encoded(), name: "detail-" + state.reading.sessionId, lease: state.lease)
            guard bodyState === state, epoch == current, state.authority.accepts(receipt.evidence) else { throw NativeFailure.expired }
        }
        try await persistBodyProgress(state.reading.id)
    }

    private func advanceBody(_ id: UUID) async throws {
        try await serializeCursor { try await self.persistBodyProgress(id) }
    }

    private func persistBodyProgress(_ id: UUID) async throws {
        guard let state = bodyState, state.reading.id == id else { throw NativeFailure.expired }
        try state.lease.requireValid()
        let prefix = state.pending.prefix(while: state.covered)
        guard let last = prefix.last else { state.pruneOffers(); return }
        if let cursor = prefix.compactMap(\.cursor).last {
            guard let applied = state.bodyRevision, applied <= (detailRevisions[state.reading.sessionId] ?? 0) else { return }
            let current = epoch, intent = state.streamAttempt
            try await loadCursors()
            guard bodyState === state, state.streamAttempt == intent, epoch == current, state.lease.valid else { throw NativeFailure.expired }
            let selected = state.reading.sessionId
            if let previous = cursors.first(where: { $0.selection == selected && $0.cursor.epoch == state.instanceId }),
               cursor.sequence < previous.cursor.sequence { throw NativeFailure.invalidRecord }
            var next = cursors.filter { $0.selection != selected }
            next.append(AppliedCursor(selection: selected, cursor: cursor, revision: applied))
            if next.count > 16 { next.removeFirst(next.count - 16) }
            try await vault.storeMetadata(JSONEncoder().encode(next), name: "event-cursors")
            guard bodyState === state, state.streamAttempt == intent, epoch == current, state.lease.valid else { throw NativeFailure.expired }
            cursors = next; appliedRevisions[selected] = applied
            if appliedRevisions.count > 16 { appliedRevisions = Dictionary(uniqueKeysWithValues: cursors.map { ($0.selection, $0.revision) }) }
        }
        state.persisted(through: last.ordinal)
    }

    public func events(sessionId: String? = nil, expectedLease: BodyLease? = nil) async throws -> NativeWorkspaceEvents {
        try await openEvents(sessionId: sessionId, expectedLease: expectedLease)
    }
    private func openEvents(sessionId: String?, expectedLease: BodyLease?, incremental: Bool = false, reading: UUID? = nil) async throws -> NativeWorkspaceEvents {
        let (connection, current) = try transport()
        try await loadCursors()
        let selected = sessionId ?? "", cursor = cursors.first { $0.selection == selected && $0.cursor.epoch == instance }
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        if let expectedLease, !lease.sameWindow(as: expectedLease) { throw NativeFailure.expired }
        let stream = try await connection.events(sessionId: sessionId, lease: lease, cursor: cursor?.cursor, incremental: incremental)
        guard epoch == current else { await stream.cancel(); throw NativeFailure.unavailable }
        return NativeWorkspaceEvents(events: stream.events, stream: stream, epoch: current, selection: selected, lease: lease, bodyReading: reading)
    }
    /** Closes only the matching body authorization; the authenticated transport and encrypted pending writes remain. */
    public func invalidateContentWindow(_ lease: BodyLease) async { _ = await verification.invalidate(lease) }
    public func accepts(_ event: NativeEvent, from stream: NativeWorkspaceEvents, sessionId: String?) throws -> Bool {
        let selected = sessionId ?? ""
        guard stream.bodyReading == nil, stream.epoch == epoch, stream.selection == selected else { return false }
        guard let provenance = event.provenance, provenance.origin === stream.stream.origin else { return false }
        if stream.lease?.valid != true { return false }
        let value = event.data.isEmpty ? NativeJSON.null : try NativeJSON.decode(event.data)
        let reset = event.type == "refresh" && value["type"].string == "refresh" && value["resumeRequired"].bool
        let saved = cursors.first { $0.selection == selected && $0.cursor.epoch == instance }
        if event.type != "heartbeat" && event.type != "resumed" {
            guard value["type"].string == event.type else { return false }
        }
        if let cursor = event.cursor {
            guard cursor.epoch == instance else { return reset && value["instanceId"].string == cursor.epoch }
            if !reset, let saved, cursor.sequence <= saved.cursor.sequence { return false }
        }
        if event.type == "heartbeat" || event.type == "resumed" { return event.cursor?.epoch == instance }
        guard ["refresh", "tasks-invalidated", "task-state", "host-state"].contains(event.type) else { return false }
        if event.type == "refresh", value["instanceId"].string != nil, value["instanceId"].string != instance { return true }
        guard value["instanceId"].string == instance else { return false }
        let applied = max(saved?.revision ?? 0, appliedRevisions[selected] ?? 0)
        if event.type != "host-state" { guard let next = value["revision"].integer, reset || next >= applied else { return false } }
        if event.type == "task-state" { return value["sessionId"].string == sessionId }
        return true
    }
    public func acknowledge(_ event: NativeEvent, from stream: NativeWorkspaceEvents, sessionId: String?, appliedRevision: UInt64) async throws {
        let selected = sessionId ?? ""
        try await serializeCursor { try await self.applyAcknowledgement(event, from: stream, selected: selected, revision: appliedRevision) }
    }
    public func forgetCursor(sessionId: String?) async throws {
        let selected = sessionId ?? ""
        try await serializeCursor { try await self.removeCursor(selected) }
    }
    private func serializeCursor(_ operation: @escaping @Sendable () async throws -> Void) async throws {
        let previous = cursorTail
        let task = Task { if let previous { await previous.value }; try await operation() }
        cursorTail = Task { _ = try? await task.value }
        try await task.value
    }
    private func applyAcknowledgement(_ event: NativeEvent, from stream: NativeWorkspaceEvents, selected: String, revision applied: UInt64) async throws {
        guard stream.bodyReading == nil, stream.epoch == epoch, stream.selection == selected, applied <= LinkBytes.maximumInteger,
              let currentInstance = instance else { throw NativeFailure.unavailable }
        guard let provenance = event.provenance, provenance.origin === stream.stream.origin else { throw NativeFailure.invalidRecord }
        guard let lease = stream.lease else { throw NativeFailure.expired }; try lease.requireValid()
        try await loadCursors()
        let fetched = selected.isEmpty ? revision : detailRevisions[selected] ?? 0
        guard applied <= fetched, applied >= (appliedRevisions[selected] ?? 0) else { throw NativeFailure.invalidRecord }
        if !event.data.isEmpty, event.type != "host-state" {
            let value = try NativeJSON.decode(event.data)
            guard value["instanceId"].string == currentInstance, let next = value["revision"].integer, next <= applied else { throw NativeFailure.invalidRecord }
        }
        if let cursor = event.cursor {
            guard cursor.epoch == currentInstance else { throw NativeFailure.invalidRecord }
            if let saved = cursors.first(where: { $0.selection == selected && $0.cursor.epoch == currentInstance }) {
                guard cursor.sequence >= saved.cursor.sequence, applied >= saved.revision else { throw NativeFailure.invalidRecord }
            }
            var next = cursors.filter { $0.selection != selected }
            next.append(AppliedCursor(selection: selected, cursor: cursor, revision: applied))
            if next.count > 16 { next.removeFirst(next.count - 16) }
            try await vault.storeMetadata(JSONEncoder().encode(next), name: "event-cursors")
            guard stream.epoch == epoch else { throw NativeFailure.unavailable }; cursors = next
        }
        appliedRevisions[selected] = applied
        if appliedRevisions.count > 16 { appliedRevisions = Dictionary(uniqueKeysWithValues: cursors.map { ($0.selection, $0.revision) }) }
    }
    private func removeCursor(_ selected: String) async throws {
        try await loadCursors()
        let next = cursors.filter { $0.selection != selected }
        try await vault.storeMetadata(JSONEncoder().encode(next), name: "event-cursors")
        cursors = next; appliedRevisions.removeValue(forKey: selected)
    }
    private func loadCursors() async throws {
        guard !cursorsLoaded else { return }
        let data = try await vault.metadata(name: "event-cursors")
        guard !cursorsLoaded else { return }
        let decoded = try data.map { try JSONDecoder().decode([AppliedCursor].self, from: $0) } ?? []
        guard decoded.count <= 16, Set(decoded.map(\.selection)).count == decoded.count else { throw NativeFailure.storageUnavailable }
        for value in decoded {
            guard value.selection.isEmpty || LinkBytes.matches(value.selection, "[A-Za-z0-9_-]{1,160}"), value.revision <= LinkBytes.maximumInteger else { throw NativeFailure.storageUnavailable }
            _ = try NativeEventCursor.parse("\(value.cursor.epoch):\(value.cursor.sequence)")
        }
        cursors = decoded; cursorsLoaded = true
    }
    @discardableResult public func closeOpening() async -> Bool {
        if let closingOpening { return await closingOpening.value }
        let previous = connection, lastSnapshot = acceptedSnapshot
        connection = nil; reopen = nil; acceptedSnapshot = nil
        installedTransport?.withdraw(); installedTransport = nil
        attempt = UUID(); epoch = UUID(); instance = nil; revision = 0
        bodyAttempt = UUID(); bodyState?.withdraw(); bodyState = nil
        metadata = .null
        detailRevisions = [:]; detailOrder = []; appliedRevisions = [:]
        let closing = Task {
            await verification.closeOpening()
            await directoryResolver.close()
            await cancelFileTransfer()
            await previous?.close()
            // The regular writer may still be crossing to the vault. Flush the last accepted projection before locking it.
            var cacheSafe = revocation == nil
            if let lastSnapshot, cacheSafe {
                do { try await vault.storeSnapshot(lastSnapshot) }
                catch {
                    do { try await vault.remove(name: "snapshot", body: false) }
                    catch { cacheSafe = false }
                }
            }
            await vault.lock()
            return cacheSafe
        }
        closingOpening = closing
        return await closing.value
    }
    func cancelFileTransfer() async {
        if let operation = bulkRun { operation.cancel(); _ = try? await operation.value }
        await closeCompanion()
    }
    func closeCompanion() async {
        bulkCover?.cancel(); bulkCover = nil
        if let closing = bulkClosing { await closing.value; return }
        let previous = bulk; bulk = nil
        guard let previous else { return }
        let closing = Task { await previous.connection.close() }; bulkClosing = closing
        await closing.value; bulkClosing = nil
    }
    private func transport() throws -> (NativeHTTPConnection, UUID) {
        guard revocation == nil else { throw NativeFailure.revoked }
        guard let connection else { throw NativeFailure.unavailable }; return (connection, epoch)
    }
    private func responseFailure(_ response: NativeHTTPResponse, lease: BodyLease?) async -> NativeFailure {
        let value = try? NativeJSON.decode(response.body)
        let code = value?["error"].string
        if ["native-verification-required", "native-verification-invalid", "native-verification-superseded"].contains(code ?? "") {
            // An old response cannot invalidate a newer local verification lease.
            _ = await verification.invalidate(lease)
            return .expired
        }
        if ["workspace-changed", "workspace-disabled", "permission-drift"].contains(code ?? "") { return .contextChanged }
        if ["agent-changed", "agent-memory-deleted", "automation-changed"].contains(code ?? "") { return .changedElsewhere }
        if code == "terminal-running" { return .terminalOpen }
        if response.status == 429 { return .busy }
        if code == "subagent-not-stoppable" { return .notStoppable }
        if code == "harness-session-lost" { return .sessionLost }
        if response.status == 401 || response.status == 403 { return .forbidden }
        if response.status == 408 || response.status >= 500 { return .resultUnknown }
        return .unsupported
    }
    /** Allocate the write in the same actor turn as the checkpoint adoption. */
    private func acceptSnapshot(_ value: NativeJSON) throws -> NativeSnapshotWrite {
        guard let instance = value["instanceId"].string, let revision = value["revision"].integer else { throw NativeFailure.invalidRecord }
        let bytes = try listMetadata(value).encoded()
        try adoptCheckpoint(value)
        snapshotOrder += 1
        let write = NativeSnapshotWrite(order: snapshotOrder, instance: instance, revision: revision, bytes: bytes)
        acceptedSnapshot = write
        return write
    }
    private func persistCurrentSnapshot(_ write: NativeSnapshotWrite, epoch expected: UUID) async throws -> NativeJSON {
        var pending = write
        for _ in 0..<8 {
            try await vault.storeSnapshot(pending)
            guard epoch == expected, installedTransport?.valid == true, let latest = acceptedSnapshot else {
                throw NativeFailure.unavailable
            }
            // A newer snapshot may have arrived while the vault was busy. Return only the current, stored projection.
            if pending.order == latest.order { return metadata }
            pending = latest
        }
        throw NativeFailure.unavailable
    }

    private func parseCheckpoint(_ response: NativeHTTPResponse) throws -> NativeJSON {
        guard response.status == 200 else { throw NativeFailure.unavailable }
        let value = try NativeJSON.decode(response.body)
        guard value["device"]["id"].string == device.deviceId, let id = value["instanceId"].string,
              LinkBytes.matches(id, "[A-Za-z0-9_-]{1,128}"), value["revision"].integer != nil else { throw NativeFailure.identityMismatch }
        return value
    }
    private func adoptCheckpoint(_ value: NativeJSON) throws {
        guard let id = value["instanceId"].string, let next = value["revision"].integer else { throw NativeFailure.invalidRecord }
        if instance == id, next < revision { throw NativeFailure.invalidRecord }
        let changedAccess = metadata != .null && ["status", "scopes", "dataScope"].contains { metadata["device"][$0] != value["device"][$0] }
        if instance != id || changedAccess {
            let previous = bodyState?.stream
            bodyAttempt = UUID(); bodyState?.withdraw(accessChanged: instance == id && changedAccess); bodyState = nil
            if let previous { Task { await previous.cancel() } }
        }
        if instance != id { detailRevisions = [:]; detailOrder = []; appliedRevisions = [:] }
        instance = id; revision = next; metadata = value
    }
    private func listMetadata(_ value: NativeJSON) -> NativeJSON {
        func select(_ value: NativeJSON, keys: [String]) -> NativeJSON {
            .object(Dictionary(uniqueKeysWithValues: keys.map { ($0, value[$0]) }))
        }
        var result: [String: NativeJSON] = ["instanceId": value["instanceId"], "revision": value["revision"], "approvals": .array([]),
            "device": select(value["device"], keys: ["id", "status", "scopes", "dataScope"]),
            "tasks": .array(value["tasks"].array.map { select($0, keys: ["id", "title", "status", "updatedAt", "pinned", "archived", "pendingQuestions", "harnessId", "workspaceId", "runId", "level", "personal", "pluginIds", "mode", "branch", "runOutcome", "runEnd", "permissionDrift", "agent", "generalChat", "automationId"]) }),
            // Enough to draw the shelves, the tabs and the engine's name offline; paths, models and settings stay out.
            "catalog": .object(["workspaces": .array(value["catalog"]["workspaces"].array.map { select($0, keys: ["id", "name"]) }),
                "harnesses": .array(value["catalog"]["harnesses"].array.map { .object(["id": $0["id"], "level": $0["level"], "capabilities": .object(["display": $0["capabilities"]["display"]])]) }),
                "features": select(value["catalog"]["features"], keys: ["customAgents", "automations", "appPages", "workItems", "workItemTurns"])]),
            "apps": .array(value["apps"].array.map { select($0, keys: ["pluginId", "appId", "title", "icon", "pluginName", "status"]) }),
            "hostTime": value["hostTime"]]
        if PhoneWorkItems.supported(value) { result["items"] = PhoneWorkItems.withoutBody(value)["items"] }
        return .object(result)
    }
}
