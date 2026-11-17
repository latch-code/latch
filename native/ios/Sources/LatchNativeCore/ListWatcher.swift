import Foundation

/** Another computer the list looks at: its own pinned identity and its own ways in, never the selected computer's. */
public struct NativeWatchTarget: Sendable {
    public let id: String
    public let device: PreparedNativeDevice
    public let candidates: @Sendable () async throws -> [NativePathCandidate]
    public init(id: String, device: PreparedNativeDevice, candidates: @escaping @Sendable () async throws -> [NativePathCandidate]) {
        self.id = id; self.device = device; self.candidates = candidates
    }
}

public enum NativeComputerState: String, Sendable, Equatable {
    case connecting, online, offline, revoked
    case wrongHost = "wrong-host"
}

/** What one other computer's own snapshot said, under the `token` of the `watch` call it was read for. */
public struct NativeWatchReading: Sendable {
    public let token: UUID
    public let id: String
    public let state: NativeComputerState
    /** Rows only (`NativeListWatcher.rows`), from the last snapshot this computer answered; kept while it is away, empty once it is not that computer or has removed this device. */
    public let list: NativeJSON
    public let lastSeen: Date?
    /** The Root-signed removal of this device, bound to that computer and this device; the App retires the profile with it. */
    public let revocation: VerifiedNativeRevocation?
    public init(token: UUID, id: String, state: NativeComputerState, list: NativeJSON, lastSeen: Date?, revocation: VerifiedNativeRevocation? = nil) {
        self.token = token; self.id = id; self.state = state; self.list = list; self.lastSeen = lastSeen; self.revocation = revocation
    }
}

/**
 * Read-only list connections to the computers that are not selected: `GET /link/api/snapshot`, which the Host answers
 * outside a content window, after `GET /link/api/native/revocation`, and nothing else. No window is opened, no detail
 * read, no event stream subscribed and no write sent, not even a revocation acknowledgement; a verified revocation is
 * handed to the App with the reading, and that computer is never dialled again. At most `limit` connections are open:
 * the computers of the current batch are read every `interval`, and with more computers the batch moves on every
 * `rotation`, closing the connections that leave it. A computer that does not answer is tried again after a back-off
 * that doubles up to `backoffCap`. Each read rechecks the token of the `watch` call it belongs to after every wait, so a
 * snapshot that arrives after a change is dropped, and a reading is published under the same isolation as `watch`,
 * `close` and `networkChanged`, never after one of them returned.
 */
public actor NativeListWatcher {
    public static let paths: Set<String> = ["/link/api/native/revocation", "/link/api/snapshot"]
    private struct Known {
        var state: NativeComputerState
        var list: NativeJSON = .null
        var lastSeen: Date?
        var instance: String?
        var revision: UInt64 = 0
        var revocation: VerifiedNativeRevocation?
        /** The watch token the removal was last handed over under: once per watch. */
        var reported: UUID?
        var failures = 0
        var due = ContinuousClock.now
    }
    /** Not that computer: the snapshot names another device. A failed dial is never this; it says only that the way in did not work. */
    private struct NotThatComputer: Error {}
    private let limit: Int
    private let interval: Duration
    private let rotation: Duration
    private let backoffCap: Duration
    private let dialTimeout: Duration
    private let requestTimeout: Int64
    private let publish: @Sendable (NativeWatchReading) -> Void
    private var token = UUID()
    private var targets: [NativeWatchTarget] = []
    private var start = 0
    private var connections: [String: NativeHTTPConnection] = [:]
    private var known: [String: Known] = [:]
    private var loop: Task<Void, Never>?
    private var sent: [String] = []
    private var dials: [String: Int] = [:]
    public init(limit: Int = 3, interval: Duration = .seconds(15), rotation: Duration = .seconds(60), backoffCap: Duration = .seconds(300),
        dialTimeout: Duration = .seconds(6), requestTimeout: Int64 = 8, publish: @escaping @Sendable (NativeWatchReading) -> Void) {
        self.limit = max(1, min(limit, 3)); self.interval = interval; self.rotation = rotation; self.backoffCap = backoffCap
        self.dialTimeout = dialTimeout; self.requestTimeout = max(1, min(requestTimeout, 15)); self.publish = publish
    }
    /** Replaces the computers looked at; connections to the ones left out close now. */
    public func watch(_ next: [NativeWatchTarget], token value: UUID) {
        token = value
        let keep = Set(next.map(\.id))
        for (id, connection) in connections where !keep.contains(id) { connections[id] = nil; Task { await connection.close() } }
        known = known.filter { keep.contains($0.key) }
        targets = Array(next.prefix(16)); start = 0
        restart()
    }
    /** The network changed: every connection closes, back-offs reset, and the same computers are read again on the new path. */
    public func networkChanged() {
        for connection in connections.values { Task { await connection.close() } }
        connections = [:]
        for id in known.keys { known[id]?.failures = 0; known[id]?.due = .now }
        restart()
    }
    /** Background or a lock: every connection closes and nothing more is published until the next `watch`. */
    public func close() {
        token = UUID(); loop?.cancel(); loop = nil; targets = []
        for connection in connections.values { Task { await connection.close() } }
        connections = [:]
    }
    /** Method and path of every request sent, oldest first, at most 64; and how often each computer was dialled. For tests. */
    public func requests() -> [String] { sent }
    public func dialCount(_ id: String) -> Int { dials[id] ?? 0 }
    public func openConnections() -> Int { connections.count }
    /** What the list keeps of a snapshot: the rows 等你处理 is judged from, and nothing of a session's content, path or project. */
    public static func rows(_ value: NativeJSON) -> NativeJSON {
        func select(_ value: NativeJSON, _ keys: [String]) -> NativeJSON {
            .object(Dictionary(uniqueKeysWithValues: keys.compactMap { value[$0] == .null ? nil : ($0, value[$0]) }))
        }
        let tasks = value["tasks"].array.prefix(2_000).map { task -> NativeJSON in
            var row = select(task, ["id", "title", "status", "updatedAt", "archived", "pendingQuestions"]).object
            let live = task["live"]
            if live != .null {
                var kept = select(live, ["activity", "silent", "lastEventAt"]).object
                if live["unrecognized"]["at"] != .null { kept["unrecognized"] = .object(["at": live["unrecognized"]["at"]]) }
                row["live"] = .object(kept)
            }
            return .object(row)
        }
        return .object(["instanceId": value["instanceId"], "revision": value["revision"], "hostTime": value["hostTime"],
            "device": select(value["device"], ["id", "status"]), "tasks": .array(Array(tasks))])
    }
    /** One relay way in from this computer's own signed address book and admission pass, for a list read; no directory lookup. */
    public static func relayCandidates(device: PreparedNativeDevice, keys: any NativeIdentityProvider) -> [NativePathCandidate] {
        let now = UInt64(max(0, Date().timeIntervalSince1970 * 1000))
        guard let book = try? AddressBookCodec.verify(device.signedAddressBook, rootSpki: device.rootSpki, deviceId: device.deviceId,
            nowMs: now, priorGeneration: device.bookGeneration, priorHash: device.bookHash) else { return [] }
        return NativeRelayOrder.ordered(book).prefix(1).compactMap { endpoint in
            guard let pass = try? NativeRelayAdmission.current(endpoint: endpoint, bookExpiresAt: book.expiresAt, nowMs: now) else { return nil }
            return try? NativePathCandidate(id: "relay-" + LinkBytes.hex(endpoint.relayId), kind: .relay) {
                try await NativeHTTPConnection.relay(endpoint: endpoint, admission: pass, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
            }
        }
    }
    private func restart() {
        loop?.cancel(); loop = nil
        guard !targets.isEmpty else { return }
        let current = token
        loop = Task { await self.run(current) }
    }
    private func run(_ current: UUID) async {
        var moved = ContinuousClock.now
        while !Task.isCancelled, token == current {
            let active = window(), ids = Set(active.map(\.id))
            // Only the batch holds connections: never more than `limit` open.
            for (id, connection) in connections where !ids.contains(id) { connections[id] = nil; await connection.close() }
            guard token == current, !Task.isCancelled else { return }
            await withTaskGroup(of: Void.self) { group in
                for target in active { group.addTask { await self.poll(target, current) } }
            }
            guard !Task.isCancelled, token == current else { return }
            if targets.count > limit, moved.duration(to: .now) >= rotation {
                start = (start + limit) % max(1, targets.count); moved = .now
                continue
            }
            try? await Task.sleep(for: interval)
        }
    }
    private func window() -> [NativeWatchTarget] {
        guard targets.count > limit else { return targets }
        return (0..<limit).map { targets[(start + $0) % targets.count] }
    }
    private func current(_ id: String, _ value: UUID) -> Bool { token == value && !Task.isCancelled && targets.contains { $0.id == id } }
    private func emit(_ id: String, _ value: UUID) {
        guard current(id, value), let entry = known[id] else { return }
        publish(NativeWatchReading(token: value, id: id, state: entry.state, list: entry.list, lastSeen: entry.lastSeen, revocation: entry.revocation))
    }
    private func poll(_ target: NativeWatchTarget, _ value: UUID) async {
        // A removal is final for this identity: it is never dialled again, only reported once more to a new watch.
        if let entry = known[target.id], entry.state == .revoked {
            if entry.reported != value { known[target.id]?.reported = value; emit(target.id, value) }
            return
        }
        if let entry = known[target.id], ContinuousClock.now < entry.due { return }
        if known[target.id] == nil { known[target.id] = Known(state: .connecting); emit(target.id, value) }
        do {
            let connection = try await connection(target, value)
            let response = try await get(connection, "/link/api/snapshot", target.id, value)
            // Removed while connected: the same connection still reads the removal, so it is known without dialling again.
            if [401, 403].contains(response.status) { try await readRevocation(connection, target, value) }
            guard response.status == 200 else { throw NativeFailure.unavailable }
            let snapshot = try NativeJSON.decode(response.body)
            guard current(target.id, value), connections[target.id] === connection else { return }
            // The connection is pinned to this computer's Root and this device's credential; the snapshot names the same device.
            guard snapshot["device"]["id"].string == target.device.deviceId else { throw NotThatComputer() }
            guard let instance = snapshot["instanceId"].string, LinkBytes.matches(instance, "[A-Za-z0-9_-]{1,128}"),
                  let revision = snapshot["revision"].integer else { throw NativeFailure.invalidRecord }
            var entry = known[target.id] ?? Known(state: .online)
            entry.failures = 0; entry.due = .now
            if entry.instance == instance, revision < entry.revision { known[target.id] = entry; return }
            entry.state = .online; entry.list = Self.rows(snapshot); entry.lastSeen = Date(); entry.instance = instance; entry.revision = revision
            known[target.id] = entry; emit(target.id, value)
        } catch {
            guard current(target.id, value) else { return }
            if let connection = connections.removeValue(forKey: target.id) { Task { await connection.close() } }
            var entry = known[target.id] ?? Known(state: .offline)
            if let proof = (error as? Revoked)?.proof {
                entry.state = .revoked; entry.list = .null; entry.revocation = proof; entry.reported = value
            } else if error is NotThatComputer {
                // Nothing it said is shown as that computer's; it is looked at again after the back-off.
                entry.state = .wrongHost; entry.list = .null
            } else { entry.state = .offline }
            entry.failures += 1
            // As the desktop's: the interval, doubling on each failure up to the cap.
            entry.due = ContinuousClock.now.advanced(by: min(backoffCap, interval * (1 << min(entry.failures - 1, 10))))
            known[target.id] = entry; emit(target.id, value)
        }
    }
    private struct Revoked: Error { let proof: VerifiedNativeRevocation }
    private func get(_ connection: NativeHTTPConnection, _ path: String, _ id: String, _ value: UUID) async throws -> NativeHTTPResponse {
        guard Self.paths.contains(path) else { throw NativeFailure.invalidRecord }
        sent.append("GET " + path); if sent.count > 64 { sent.removeFirst(sent.count - 64) }
        let response = try await connection.request(.get, path: path, timeoutSeconds: requestTimeout)
        guard current(id, value) else { throw CancellationError() }
        return response
    }
    /** The removal notice: a Root-signed proof bound to this computer and this device throws `Revoked`; none returns. */
    private func readRevocation(_ connection: NativeHTTPConnection, _ target: NativeWatchTarget, _ value: UUID) async throws {
        let notice = try await get(connection, "/link/api/native/revocation", target.id, value)
        if notice.status == 200 {
            let body = try NativeJSON.decode(notice.body)
            guard Set(body.object.keys) == Set(["revocation"]) else { throw NativeFailure.invalidRecord }
            if body["revocation"] != .null {
                // Verified against this computer's Root, its hostId and this device: nothing less clears a profile.
                guard let proof = try? VerifiedNativeRevocation.verify(body["revocation"], rootSpki: target.device.rootSpki,
                    hostId: target.device.hostId, deviceId: target.device.deviceId) else { throw NativeFailure.invalidRecord }
                throw Revoked(proof: proof)
            }
        } else if ![401, 403, 404].contains(notice.status) { throw NativeFailure.unavailable }
    }
    private func dial(_ candidate: NativePathCandidate) async throws -> NativeHTTPConnection {
        let limit = dialTimeout
        let opened = await withTaskGroup(of: NativeHTTPConnection?.self) { group -> NativeHTTPConnection? in
            group.addTask { try? await candidate.connect() }
            group.addTask { try? await Task.sleep(for: limit); return nil }
            let first = await group.next() ?? nil
            group.cancelAll()
            // A connection that finished after the time ran out is closed, never kept.
            for await late in group { if let late { await late.close() } }
            return first
        }
        guard let opened else { throw NativeFailure.unavailable }
        return opened
    }
    private func connection(_ target: NativeWatchTarget, _ value: UUID) async throws -> NativeHTTPConnection {
        if let open = connections[target.id] { return open }
        var candidates = try await target.candidates()
        // Bonjour answers a moment after a browse starts.
        for _ in 0..<8 where candidates.isEmpty {
            try await Task.sleep(for: .milliseconds(250))
            guard current(target.id, value) else { throw CancellationError() }
            candidates = try await target.candidates()
        }
        let ordered = Array((candidates.filter { $0.kind == .direct }.prefix(2) + candidates.filter { $0.kind == .relay }.prefix(1)))
        for candidate in ordered {
            guard current(target.id, value) else { throw CancellationError() }
            dials[target.id, default: 0] += 1
            // Like the workspace's own dial: a way in that fails (the transport reports every failure alike) is only unavailable.
            guard let opened = try? await dial(candidate) else { continue }
            guard current(target.id, value), connections[target.id] == nil else { await opened.close(); throw CancellationError() }
            do { try await readRevocation(opened, target, value) } catch { await opened.close(); throw error }
            connections[target.id] = opened
            return opened
        }
        throw NativeFailure.unavailable
    }
}
