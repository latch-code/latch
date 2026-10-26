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
    public func cancel() async { await stream.cancel() }
}
struct QualifiedNativePath: Sendable {
    let connection: NativeHTTPConnection
    let snapshot: NativeJSON
    let window: PreparedWindowRestore
    let ticket: UUID
}

/** One App opening owns window receipts, connection epochs, checkpoints and immutable retry bodies. */
public actor NativeWorkspace {
    public let device: PreparedNativeDevice
    private let keys: any NativeIdentityProvider
    private let vault: EncryptedVault
    private let verification: NativeVerification
    private let onRevoked: (@Sendable (VerifiedNativeRevocation) -> Void)?
    private var connection: NativeHTTPConnection?
    private var epoch = UUID()
    private var attempt = UUID()
    private var instance: String?
    private var revision: UInt64 = 0
    private var metadata = NativeJSON.null
    private var writes = Set<String>()
    private var controlBusy = false
    private var revocation: VerifiedNativeRevocation?
    private var bookDevice: PreparedNativeDevice
    private var bookUpdating = false
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
    public init(device: PreparedNativeDevice, keys: any NativeIdentityProvider, vault: EncryptedVault,
        onRevoked: (@Sendable (VerifiedNativeRevocation) -> Void)? = nil) throws {
        guard LinkBytes.base32(LinkBytes.hash(device.rootSpki)) == device.hostId,
              LinkBytes.matches(device.deviceId, "dev_[A-Za-z0-9_-]{22}"), device.knockKey.count == 32 else { throw NativeFailure.identityMismatch }
        self.device = device; self.keys = keys; self.vault = vault
        bookDevice = device
        self.onRevoked = onRevoked
        verification = NativeVerification(hostId: device.hostId, deviceId: device.deviceId)
    }
    public func install(_ candidate: @escaping @Sendable () async throws -> NativeHTTPConnection) async throws -> NativeJSON {
        let id = beginPathRound()
        let next = try await candidate()
        let qualified = try await qualify(next, ticket: id)
        return try await installQualified(qualified)
    }
    func beginPathRound() -> UUID { let id = UUID(); attempt = id; return id }
    func qualify(_ next: NativeHTTPConnection, ticket id: UUID) async throws -> QualifiedNativePath {
        guard revocation == nil else { await next.close(); throw NativeFailure.revoked }
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
                    await verification.closeOpening()
                    onRevoked?(verified)
                    await verified.acknowledge(on: next)
                    throw NativeFailure.revoked
                }
            } else if ![401, 403, 404].contains(notice.status) { throw NativeFailure.unavailable }
            let window = try await verification.prepareRestore(on: next)
            let response = try await next.request(.get, path: "/link/api/snapshot")
            guard attempt == id, !Task.isCancelled else { throw NativeFailure.unavailable }
            return QualifiedNativePath(connection: next, snapshot: try parseCheckpoint(response), window: window, ticket: id)
        } catch { await next.close(); throw error }
    }
    func installQualified(_ path: QualifiedNativePath) async throws -> NativeJSON {
        do {
            guard revocation == nil else { throw NativeFailure.revoked }
            guard path.ticket == attempt, !Task.isCancelled else { throw NativeFailure.unavailable }
            try await vault.storeMetadata(listMetadata(path.snapshot).encoded(), name: "snapshot")
            guard path.ticket == attempt, !Task.isCancelled else { throw NativeFailure.unavailable }
            _ = try await verification.installPrepared(prepare: path.window, on: path.connection)
            guard path.ticket == attempt, !Task.isCancelled else { throw NativeFailure.unavailable }
            let next = path.snapshot
            let value = next["instanceId"].string == instance && (next["revision"].integer ?? 0) < revision ? metadata : next
            _ = try adoptCheckpoint(value)
            let old = connection; connection = path.connection; epoch = UUID()
            if let old { Task { await old.close() } }
            return value
        } catch { await path.connection.close(); throw error }
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
        bookDevice = next; return next
    }
    public func snapshot() async throws -> NativeJSON {
        let (connection, current) = try transport()
        let response = try await connection.request(.get, path: "/link/api/snapshot")
        guard epoch == current else { throw NativeFailure.unavailable }
        let value = try checkpoint(response)
        try await vault.storeMetadata(listMetadata(value).encoded(), name: "snapshot")
        guard epoch == current else { throw NativeFailure.unavailable }
        return value
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
    public func read(_ path: String, body: Bool) async throws -> NativeJSON {
        let (connection, current) = try transport()
        let lease = await verification.currentLease()
        if body { guard let lease else { throw NativeFailure.expired }; try lease.requireValid() }
        let response = try await connection.request(.get, path: path)
        guard epoch == current else { throw NativeFailure.unavailable }
        if body { try lease?.requireValid() }
        guard response.status == 200 else { throw await responseFailure(response, lease: lease) }
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
    public func fileBytes(handle: String, etag: String, offset: Int, count: Int, progress: (@Sendable (Int, Int) -> Void)? = nil) async throws -> Data {
        guard LinkBytes.matches(handle, "[A-Za-z0-9_-]{22}"), LinkBytes.matches(etag, "\"[a-f0-9]{32}\""),
              offset >= 0, offset <= 8_388_608, count > 0, count <= 1_048_576 else { throw NativeFailure.invalidRecord }
        let (connection, current) = try transport()
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }; try lease.requireValid()
        var result = Data(), total: Int?
        while result.count < count {
            try Task.checkCancellation(); try lease.requireValid()
            guard epoch == current else { throw NativeFailure.unavailable }
            let start = offset + result.count, amount = min(65_536, count - result.count)
            let response = try await connection.request(.get, path: "/link/api/files/" + handle,
                headers: ["if-match": etag, "range": "bytes=\(start)-\(start + amount - 1)"], maximum: max(amount, 8192))
            try Task.checkCancellation(); try lease.requireValid()
            guard epoch == current else { throw NativeFailure.unavailable }
            guard response.status == 206 else { throw await responseFailure(response, lease: lease) }
            guard response.headers["etag"] == etag, let range = response.headers["content-range"],
                  LinkBytes.matches(range, "bytes \(start)-\(start + amount - 1)/[0-9]+"), response.body.count == amount,
                  let size = range.split(separator: "/").last.flatMap({ Int($0) }), size >= offset + count,
                  total == nil || total == size else { throw NativeFailure.invalidRecord }
            total = size; result.append(response.body); progress?(result.count, count)
        }
        try Task.checkCancellation(); try lease.requireValid()
        guard epoch == current else { throw NativeFailure.unavailable }; return result
    }
    public func submit(_ pending: NativePendingWrite) async throws -> NativeJSON {
        let (connection, current) = try transport()
        guard let lease = await verification.currentLease(), let method = NativeHTTPMethod(rawValue: pending.method),
              method != .get && method != .head, writes.isEmpty else { throw NativeFailure.expired }
        try lease.requireValid()
        let decoded = try NativeJSON.decode(pending.body)
        let queueEdit = method == .patch && LinkBytes.matches(pending.path, "/link/api/tasks/[A-Za-z0-9_-]{1,160}/queue/[A-Za-z0-9_-]{1,160}")
        guard queueEdit || decoded["requestId"].string == pending.requestId else { throw NativeFailure.invalidRecord }
        writes.insert(pending.requestId); defer { writes.remove(pending.requestId) }
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
        do { response = try await connection.request(method, path: pending.path, body: pending.body) }
        catch { throw NativeFailure.resultUnknown }
        // Even a path replacement leaves the original write unknown; it must never become a new request.
        guard epoch == current else { throw NativeFailure.resultUnknown }
        if (200..<300).contains(response.status) {
            guard let value = try? NativeJSON.decode(response.body) else { throw NativeFailure.resultUnknown }
            try? await removePending(pending.requestId)
            return value
        }
        if response.status == 408 || response.status >= 500 { throw NativeFailure.resultUnknown }
        // A retry's denial says nothing about whether the first submission ran before permissions changed.
        if retry { throw NativeFailure.resultUnknown }
        try? await removePending(pending.requestId)
        throw await responseFailure(response, lease: lease)
    }
    public func pendingWrites() async throws -> [NativePendingWrite] {
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        var result: [NativePendingWrite] = []
        for id in try await pendingIndex() {
            guard let body = try await vault.body(name: "pending-" + id, lease: lease) else { throw NativeFailure.storageUnavailable }
            let pending = try JSONDecoder().decode(NativePendingWrite.self, from: body)
            guard pending.requestId == id, pending.body.count <= 1_048_576 else { throw NativeFailure.storageUnavailable }
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
        let pause = path == "/link/api/native/input/pause"
        guard cancel || reject || pause, Set(fields.keys).isSubset(of: cancel ? ["requestId", "runId"] : reject ? ["requestId", "decision"] : []) else { throw NativeFailure.invalidRecord }
        if !pause {
            guard let id = fields["requestId"]?.string, LinkBytes.matches(id, "[A-Fa-f0-9-]{36}"), !controlBusy else { throw NativeFailure.invalidRecord }
            if let run = fields["runId"]?.string { guard LinkBytes.matches(run, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord } }
            controlBusy = true
        }
        defer { if !pause { controlBusy = false } }
        let previous = !pause ? try await pendingControl() : nil
        if let previous {
            guard previous["fields"]["requestId"].string == fields["requestId"]?.string else { throw NativeFailure.resultUnknown }
            guard previous["path"].string == path, previous["fields"] == .object(fields) else { throw NativeFailure.invalidRecord }
        }
        let (connection, current) = try transport()
        if !pause { try await vault.storeMetadata(NativeJSON.object(["path": .string(path), "fields": .object(fields)]).encoded(), name: "control-pending") }
        let response: NativeHTTPResponse
        do { response = try await connection.request(.post, path: path, body: NativeJSON.object(fields).encoded()) }
        catch { throw NativeFailure.resultUnknown }
        guard epoch == current else { throw NativeFailure.resultUnknown }
        guard response.status == 200 else {
            if previous != nil { throw NativeFailure.resultUnknown }
            if !pause && (400..<500).contains(response.status) && response.status != 408 { try? await vault.remove(name: "control-pending", body: false) }
            throw response.status >= 500 || response.status == 408 ? NativeFailure.resultUnknown : NativeFailure.unavailable
        }
        let value = try NativeJSON.decode(response.body)
        if !pause { try? await vault.remove(name: "control-pending", body: false) }
        return value
    }
    public func pendingControl() async throws -> NativeJSON? {
        guard let data = try await vault.metadata(name: "control-pending") else { return nil }
        let value = try NativeJSON.decode(data)
        guard Set(value.object.keys) == Set(["path", "fields"]), let path = value["path"].string,
              LinkBytes.matches(path, "/link/api/(tasks/[A-Za-z0-9_-]{1,160}/cancel|approvals/[A-Za-z0-9_-]{1,160})"),
              Set(value["fields"].object.keys).isSubset(of: ["requestId", "runId", "decision"]) else { throw NativeFailure.storageUnavailable }
        return value
    }
    public func events(sessionId: String? = nil) async throws -> NativeWorkspaceEvents {
        let (connection, current) = try transport()
        try await loadCursors()
        let selected = sessionId ?? "", cursor = cursors.first { $0.selection == selected && $0.cursor.epoch == instance }
        guard let lease = await verification.currentLease() else { throw NativeFailure.expired }
        let stream = try await connection.events(sessionId: sessionId, lease: lease, cursor: cursor?.cursor)
        guard epoch == current else { await stream.cancel(); throw NativeFailure.unavailable }
        return NativeWorkspaceEvents(events: stream.events, stream: stream, epoch: current, selection: selected, lease: lease)
    }
    public func accepts(_ event: NativeEvent, from stream: NativeWorkspaceEvents, sessionId: String?) throws -> Bool {
        let selected = sessionId ?? ""
        guard stream.epoch == epoch, stream.selection == selected else { return false }
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
        guard stream.epoch == epoch, stream.selection == selected, applied <= LinkBytes.maximumInteger,
              let currentInstance = instance else { throw NativeFailure.unavailable }
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
    public func closeOpening() async {
        attempt = UUID(); epoch = UUID(); instance = nil; revision = 0
        metadata = .null
        detailRevisions = [:]; detailOrder = []; appliedRevisions = [:]
        await verification.closeOpening()
        let previous = connection; connection = nil
        await previous?.close(); await vault.lock()
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
            if lease?.valid != false { await verification.closeOpening() }
            return .expired
        }
        if ["workspace-changed", "workspace-disabled", "permission-drift"].contains(code ?? "") { return .contextChanged }
        if response.status == 401 || response.status == 403 { return .forbidden }
        if response.status == 408 || response.status >= 500 { return .resultUnknown }
        return .unsupported
    }
    private func checkpoint(_ response: NativeHTTPResponse) throws -> NativeJSON {
        try adoptCheckpoint(parseCheckpoint(response))
    }
    private func parseCheckpoint(_ response: NativeHTTPResponse) throws -> NativeJSON {
        guard response.status == 200 else { throw NativeFailure.unavailable }
        let value = try NativeJSON.decode(response.body)
        guard value["device"]["id"].string == device.deviceId, let id = value["instanceId"].string, !id.isEmpty, id.count <= 128,
              value["revision"].integer != nil else { throw NativeFailure.identityMismatch }
        return value
    }
    private func adoptCheckpoint(_ value: NativeJSON) throws -> NativeJSON {
        guard let id = value["instanceId"].string, let next = value["revision"].integer else { throw NativeFailure.invalidRecord }
        if instance == id, next < revision { throw NativeFailure.invalidRecord }
        if instance != id { detailRevisions = [:]; detailOrder = []; appliedRevisions = [:] }
        instance = id; revision = next; metadata = value
        return value
    }
    private func listMetadata(_ value: NativeJSON) -> NativeJSON {
        func select(_ value: NativeJSON, keys: [String]) -> NativeJSON {
            .object(Dictionary(uniqueKeysWithValues: keys.map { ($0, value[$0]) }))
        }
        return .object(["instanceId": value["instanceId"], "revision": value["revision"], "approvals": .array([]),
            "device": select(value["device"], keys: ["id", "status", "scopes", "dataScope"]),
            "tasks": .array(value["tasks"].array.map { select($0, keys: ["id", "title", "status", "updatedAt", "pinned", "archived", "pendingQuestions", "harnessId", "workspaceId", "runId", "level", "personal", "pluginIds"]) })])
    }
}
