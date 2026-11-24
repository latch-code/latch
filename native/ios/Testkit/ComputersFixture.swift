import Foundation
import LatchNativeCore

/** Several computers' 等你处理, names and menu words from synthetic lists, as plain values. */
func phoneComputersFixture(_ input: [String: Any]) throws -> [String: Any] {
    let value = try NativeJSON.decode(JSONSerialization.data(withJSONObject: input))
    try checkQuestionAttention()
    let subject = NativeJSON.object(["session": .string("same-session"), "kind": .string("approval"), "id": .string("exact-approval")])
    guard let target = PhonePushTarget(subject),
          PhonePushHint(route: UUID().uuidString, ticket: String(repeating: "b", count: 32), reject: true)?.reject == true,
          PhonePushHint(route: "unknown", ticket: "other") == nil else { throw NativeFailure.invalidRecord }
    func pushDetail(_ session: String, _ ids: [String]) -> NativeJSON {
        .object(["summary": .object(["id": .string(session)]), "approvals": .array(ids.map { .object(["id": .string($0)]) })])
    }
    guard target.record(in: pushDetail("same-session", ["other", "exact-approval"]))?["id"].string == "exact-approval",
          target.record(in: pushDetail("same-session", ["other"])) == nil,
          target.record(in: pushDetail("other-session", ["exact-approval"])) == nil else { throw NativeFailure.invalidRecord }
    let snapshot = value["snapshot"]
    let items = PhoneComputers.attention(snapshot)
    let sessions = PhoneSessions.shelves(tasks: snapshot["tasks"].array, workspaces: []).first { $0.id == "waiting" }?.tasks.compactMap { $0["id"].string } ?? []
    let named = PhoneComputers.names(value["computers"].array.map { ($0["id"].string ?? "", $0["hostId"].string ?? "", $0["name"].string ?? "") })
    let seen = Date(timeIntervalSince1970: 1_793_000_000)
    func state(_ text: String?) -> NativeComputerState? { text.flatMap(NativeComputerState.init(rawValue:)) }
    let groups = PhoneComputers.groups(value["readings"].array.map { ($0["id"].string ?? "", $0["name"].string ?? "", state($0["state"].string), $0["list"]) })
    return [
        "items": items.map { ["id": $0.taskId, "title": $0.title, "kind": $0.kind.rawValue, "words": $0.kind.words] },
        "sessionsWaiting": sessions,
        "titleLengths": items.map { $0.title.unicodeScalars.count },
        "names": named,
        "states": ["connecting", "online", "offline", "revoked", "wrong-host", "none"].map { PhoneComputers.stateWords(state($0), lastSeen: $0 == "offline" ? seen : nil) },
        "lines": [
            PhoneComputers.menuLine(state: .online, lastSeen: seen, waiting: 2),
            PhoneComputers.menuLine(state: .offline, lastSeen: seen, waiting: 3),
            PhoneComputers.menuLine(state: .revoked, lastSeen: seen, waiting: 3),
            PhoneComputers.menuLine(state: .online, lastSeen: seen, waiting: 0),
        ],
        "clock": PhoneTime.clock(seen),
        "groups": groups.map { ["id": $0.id, "name": $0.name, "live": $0.live, "count": $0.items.count] },
        "freshFirst": PhoneComputers.fresh(previous: nil, now: items),
        "freshSame": PhoneComputers.fresh(previous: Set(items.map(\.taskId)), now: items),
        "freshNew": PhoneComputers.fresh(previous: Set(items.dropFirst().map(\.taskId)), now: items),
        "body": PhoneComputers.notificationBody(named["b"] ?? ""),
        "rows": try JSONSerialization.jsonObject(with: NativeListWatcher.rows(snapshot).encoded()),
        "desk": deskFixture(),
        "notices": noticeFixture(),
    ]
}

private func checkQuestionAttention() throws {
    func list(_ count: Int, complete: Bool = true, scope: String = "run") -> NativeJSON {
        func task(_ id: String, count: Int, status: String = "running", archived: Bool = false, cancelling: Bool = false) -> NativeJSON {
            .object(["id": .string(id), "pendingQuestions": .number(Double(count)), "status": .string(status), "archived": .bool(archived),
                     "live": .object(["activity": .string(cancelling ? "cancelling" : "working")])])
        }
        return .object(["device": .object(["status": .string("active"), "scopes": .array([.string("view"), .string(scope)])]),
                        "tasksComplete": .bool(complete),
                        "tasks": .array([task("one", count: count), task("two", count: count),
                                         task("archived", count: 1, archived: true), task("cancelled", count: 1, cancelling: true),
                                         task("idle", count: 1, status: "idle"), task("bad id", count: 1)])])
    }
    guard let first = PhoneQuestionAttention(computer: "mac", snapshot: list(1)),
          let next = PhoneQuestionAttention(computer: "mac", snapshot: list(2)),
          let done = PhoneQuestionAttention(computer: "mac", snapshot: list(0)),
          let switched = PhoneQuestionAttention(computer: "other", snapshot: list(2)),
          first.sessions == ["one", "two"], done.entries.isEmpty,
          first.newlyWaiting(since: nil, excluding: nil) == nil,
          first.newlyWaiting(since: first, excluding: nil) == nil,
          done.newlyWaiting(since: next, excluding: nil) == nil,
          switched.newlyWaiting(since: first, excluding: nil) == nil,
          next.newlyWaiting(since: first, excluding: "one")?.session == "two",
          next.newlyWaiting(since: first, excluding: nil)?.count == 2,
          PhoneQuestionAttention(computer: "mac", snapshot: list(1, complete: false)) == nil,
          PhoneQuestionAttention(computer: "mac", snapshot: list(1, scope: "manage")) == nil else { throw NativeFailure.invalidRecord }
}

/** The App's guards on readings: token, selected and watched computers, baselines, and what a switch forgets. */
private func deskFixture() -> [String] {
    func list(_ ids: [String]) -> NativeJSON {
        .object(["tasks": .array(ids.map { .object(["id": .string($0), "title": .string($0), "status": .string("waiting-approval"), "updatedAt": .string("2026-11-01T10:00:00Z")]) })])
    }
    func words(_ outcome: PhoneComputerDesk.Outcome) -> String {
        switch outcome {
        case .dropped: "dropped"; case .kept: "kept"
        case let .notify(session): "notify:" + session
        case .retire: "retire"
        }
    }
    var desk = PhoneComputerDesk(), result: [String] = []
    let first = desk.watch(selected: "a", others: ["a", "b", "c"])
    func read(_ token: UUID, _ id: String, _ state: NativeComputerState = .online, _ ids: [String] = ["x"], notifying: Bool = true) -> String {
        words(desk.receive(NativeWatchReading(token: token, id: id, state: state, list: list(ids), lastSeen: nil), notifying: notifying))
    }
    result.append(read(UUID(), "b"))                  // another watch's token
    result.append(read(first, "a"))                   // the selected computer
    result.append(read(first, "z"))                   // not watched
    result.append(read(first, "b"))                   // first reading: the baseline
    result.append(read(first, "b"))                   // nothing new
    result.append(read(first, "b", .online, ["x", "y"]))
    result.append(read(first, "b", .online, ["x", "y", "w"], notifying: false))
    let second = desk.watch(selected: "b", others: ["a", "c"])
    result.append(read(first, "c"))                   // late, from before the switch
    result.append(read(second, "b", .online, ["x", "y", "w", "v"]))
    result.append(desk.readings["b"] == nil ? "pruned" : "kept-b")
    let third = desk.watch(selected: "a", others: ["b", "c"])
    result.append(read(third, "b", .online, ["x", "y", "w", "v"])) // back again: a baseline, not a notification
    result.append(read(third, "b", .offline, ["x"]))
    result.append(desk.readings["b"]?.state.rawValue ?? "none")
    return result
}

private func noticeFixture() -> [String] {
    var targets = PhoneNoticeTargets(), result: [String] = []
    let first = targets.add(computer: "b", session: "s1")
    let other = targets.add(computer: "c", session: "s2")
    result.append(targets.take(first).map { $0.computer + "/" + $0.session } ?? "none")
    result.append(targets.take(first).map { $0.computer } ?? "none")
    result.append(targets.take("unknown").map { $0.computer } ?? "none")
    let preserved = targets.add(computer: "b", session: "s3")
    result.append(targets.forget(computer: "c") == [other] ? "only-c" : "wrong-ids")
    result.append(targets.take(other).map { $0.computer } ?? "none")
    result.append(targets.take(preserved).map { $0.computer + "/" + $0.session } ?? "none")
    let oldest = targets.add(computer: "b", session: "old")
    for index in 0..<32 { _ = targets.add(computer: "b", session: "s\(index)") }
    result.append(targets.take(oldest).map { $0.session } ?? "none")
    return result
}

/** What the watcher published, in order, with the moments the test changed what it watches. */
final class WatchLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [(token: UUID, id: String, state: NativeComputerState, titles: [String], marker: String?)] = []
    func add(_ reading: NativeWatchReading) {
        lock.lock(); defer { lock.unlock() }
        entries.append((reading.token, reading.id, reading.state, reading.list["tasks"].array.compactMap { $0["title"].string }, nil))
        readings.append(reading)
    }
    func mark(_ name: String) { lock.lock(); defer { lock.unlock() }; entries.append((UUID(), "", .connecting, [], name)) }
    var all: [(token: UUID, id: String, state: NativeComputerState, titles: [String], marker: String?)] { lock.lock(); defer { lock.unlock() }; return entries }
    private var readings: [NativeWatchReading] = []
    /** The readings themselves, oldest first, each handed out once. */
    func take() -> [NativeWatchReading] { lock.lock(); defer { lock.unlock() }; let value = readings; readings = []; return value }
}

private func pairFixture(payload: String, port: UInt16, keys: FixtureKeys) async throws -> PreparedNativeDevice {
    let invitation = try PairingInvitation.parse(payload, privateOnly: false)
    let pairing = try NativePairing(invitation: invitation, keys: keys)
    let temporary = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey)
    defer { Task { await temporary.close() } }
    _ = try await pairing.begin(on: temporary, name: "Swift watcher fixture", gatewayHash: Data(repeating: 0, count: 32))
    for _ in 0..<60 {
        if let view = try await pairing.status(on: temporary), view.status == "approved" {
            return try await pairing.complete(on: temporary) { _ in }
        }
        try await Task.sleep(for: .milliseconds(50))
    }
    throw NativeFailure.unavailable
}

private func directTarget(_ id: String, device: PreparedNativeDevice, keys: FixtureKeys, port: UInt16, gate: FixtureGate? = nil) -> NativeWatchTarget {
    NativeWatchTarget(id: id, device: device) {
        [try NativePathCandidate(id: "direct", kind: .direct) {
            // Detached, so the watcher's cancellation does not stop it: a gated connection really arrives late.
            try await Task.detached {
                if let gate { try await gate.wait() }
                return try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
            }.value
        }]
    }
}

/** A device record with one field changed, to stand for a computer that is not the one this profile names. */
private func altered(_ device: PreparedNativeDevice, deviceId: String? = nil, rootSpki: Data? = nil) throws -> PreparedNativeDevice {
    var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(device)) as? [String: Any] ?? [:]
    if let deviceId { object["deviceId"] = deviceId }
    if let rootSpki { object["rootSpki"] = rootSpki.base64EncodedString() }
    return try JSONDecoder().decode(PreparedNativeDevice.self, from: JSONSerialization.data(withJSONObject: object))
}

private func waitFor(_ seconds: Double = 8, _ condition: () async -> Bool) async throws -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline { if await condition() { return true }; try await Task.sleep(for: .milliseconds(25)) }
    return await condition()
}

/**
 * Two real Hosts watched by `NativeListWatcher`: with room for one the readings alternate and never hold more than one
 * connection, each names only its own computer's sessions, a snapshot still on its way when the watched set changes is
 * never published, an unreachable computer and a wrong Root are 不在线 (not 不是这台电脑) and back off, a snapshot naming
 * another device is 不是这台电脑 with nothing kept, and B's waiting session, seen while A is selected, opens on B and
 * not on A. The Host side records what the watching devices sent.
 */
func runNativeListWatcher(_ input: [String: Any]) async throws -> [String: Any] {
    guard let hosts = input["hosts"] as? [[String: Any]], hosts.count == 2, let codes = input["codeDir"] as? String else { throw NativeFailure.invalidRecord }
    // A Host keeps one pairing sheet at a time, so the test writes each code only after the previous one was used.
    func code(_ name: String) async throws -> String {
        let file = URL(fileURLWithPath: codes).appendingPathComponent(name)
        for _ in 0..<800 {
            if let text = try? String(contentsOf: file, encoding: .utf8), !text.isEmpty { return text }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw NativeFailure.unavailable
    }
    var devices: [PreparedNativeDevice] = [], keyring: [FixtureKeys] = [], ports: [UInt16] = []
    var openers: [(PreparedNativeDevice, FixtureKeys)] = []
    for (index, host) in hosts.enumerated() {
        let port = try fixturePort(host), keys = try FixtureKeys(), opener = try FixtureKeys()
        devices.append(try await pairFixture(payload: try await code("watcher-\(index)"), port: port, keys: keys))
        openers.append((try await pairFixture(payload: try await code("opener-\(index)"), port: port, keys: opener), opener))
        keyring.append(keys); ports.append(port)
    }
    func target(_ index: Int, gate: FixtureGate? = nil) -> NativeWatchTarget {
        directTarget(["a", "b"][index], device: devices[index], keys: keyring[index], port: ports[index], gate: gate)
    }
    let log = WatchLog()
    let watcher = NativeListWatcher(limit: 1, interval: .milliseconds(150), rotation: .milliseconds(400)) { log.add($0) }
    // Alternation: one at a time, each with its own list, never two connections.
    let first = UUID()
    await watcher.watch([target(0), target(1)], token: first)
    var turns: [String] = [], most = 0
    for _ in 0..<320 {
        most = max(most, await watcher.openConnections())
        turns = log.all.filter { $0.token == first && $0.state == .online }.map(\.id).reduce(into: [String]()) { if $1 != $0.last { $0.append($1) } }
        if turns.count >= 4 { break }
        try await Task.sleep(for: .milliseconds(25))
    }
    let online = log.all.filter { $0.state == .online }
    let ownLists = online.allSatisfy { entry in entry.titles.allSatisfy { $0.hasPrefix(entry.id == "a" ? "Alpha" : "Beta") || $0.hasPrefix("permission") && entry.id == "b" } }
        && online.contains { $0.id == "a" && $0.titles.contains("Alpha waits") } && online.contains { $0.id == "b" && $0.titles.contains("Beta waits") }
    // A switch while B's connection is still being made: whatever B answers later belongs to nothing on screen.
    let slow = FixtureGate()
    await watcher.close()
    let second = UUID()
    await watcher.watch([target(1, gate: slow)], token: second)
    _ = try await waitFor { await slow.waiting }
    let third = UUID()
    await watcher.watch([target(0)], token: third)
    log.mark("switched")
    await slow.release()
    _ = try await waitFor { log.all.contains { $0.token == third && $0.state == .online } }
    try await Task.sleep(for: .milliseconds(400))
    let afterLate = await watcher.openConnections()
    // A new network closes every connection and reads again.
    await watcher.networkChanged()
    let closedOnNetwork = await watcher.openConnections() == 0
    _ = try await waitFor { await watcher.openConnections() == 1 }
    await watcher.close()
    log.mark("closed")
    try await Task.sleep(for: .milliseconds(400))
    let entries = log.all
    let switched = entries.firstIndex { $0.marker == "switched" } ?? 0, closed = entries.firstIndex { $0.marker == "closed" } ?? 0
    let late = entries[switched...].filter { $0.marker == nil && ($0.token != third || $0.id != "a") }
    let afterClose = entries[closed...].filter { $0.marker == nil }

    // Ways in that fail, and a computer that is not the one named.
    let other = WatchLog()
    let checks = NativeListWatcher(limit: 3, interval: .milliseconds(150), rotation: .seconds(60), backoffCap: .milliseconds(600)) { other.add($0) }
    let downDevice = devices[0], downKeys = keyring[0]
    let down = NativeWatchTarget(id: "down", device: downDevice) {
        [try NativePathCandidate(id: "closed", kind: .direct) {
            try await NativeHTTPConnection.open(host: "127.0.0.1", port: 9, rootSpki: downDevice.rootSpki, knockKey: downDevice.knockKey, identity: downKeys.identity())
        }]
    }
    // A's profile dialled at B's address: B cannot prove A's Root, so the way in fails.
    let wrongRoot = directTarget("wrong-root", device: devices[0], keys: keyring[0], port: ports[1])
    // B's own credential and Root, under a profile that names A's device: B's snapshot names another device.
    let notThat = directTarget("not-that", device: try altered(devices[1], deviceId: devices[0].deviceId), keys: keyring[1], port: ports[1])
    await checks.watch([down, wrongRoot, notThat], token: UUID())
    _ = try await waitFor { Set(other.all.filter { $0.state != .connecting }.map(\.id)).count == 3 }
    try await Task.sleep(for: .milliseconds(1500))
    await checks.close()
    func last(_ id: String) -> (state: NativeComputerState, titles: [String])? { other.all.last { $0.id == id }.map { ($0.state, $0.titles) } }
    let downDials = await checks.dialCount("down")

    // While A is selected, B's waiting session shows under B, and opens on B, never on A.
    let waiting = try await code("waiting")
    var desk = PhoneComputerDesk()
    let deskLog = WatchLog()
    let deskWatcher = NativeListWatcher(limit: 3, interval: .milliseconds(150)) { deskLog.add($0) }
    let deskToken = desk.watch(selected: "a", others: ["b"])
    await deskWatcher.watch([target(1)], token: deskToken)
    var seenOnB = false
    for _ in 0..<320 where !seenOnB {
        for reading in deskLog.take() { _ = desk.receive(reading, notifying: false) }
        let groups = PhoneComputers.groups(desk.readings.map { ($0.key, $0.key, $0.value.state, $0.value.list) })
        seenOnB = groups.count == 1 && groups[0].id == "b" && groups[0].items.contains { $0.taskId == waiting }
        if !seenOnB { try await Task.sleep(for: .milliseconds(25)) }
    }
    await deskWatcher.close()
    func workspace(_ index: Int) async throws -> (NativeWorkspace, EncryptedVault, URL) {
        let (device, keys) = openers[index], port = ports[index]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-watch-" + UUID().uuidString)
        let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: device.hostId)
        let value = try NativeWorkspace(device: device, keys: keys, vault: vault)
        _ = try await value.install { try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity()) }
        _ = try await value.verify()
        return (value, vault, directory)
    }
    let (onB, vaultB, directoryB) = try await workspace(1)
    let openedOnB = try await onB.detail(waiting)["summary"]["id"].string == waiting
    await onB.closeOpening(); await vaultB.lock(); try? FileManager.default.removeItem(at: directoryB)
    let (onA, vaultA, directoryA) = try await workspace(0)
    var notOnA = false
    do { _ = try await onA.detail(waiting) } catch { notOnA = true }
    await onA.closeOpening(); await vaultA.lock(); try? FileManager.default.removeItem(at: directoryA)

    let requests = await watcher.requests() + checks.requests() + deskWatcher.requests()
    return [
        "alternated": turns.count >= 4,
        "oneConnection": most <= 1 && afterLate <= 1,
        "ownLists": ownLists,
        "lateDropped": late.isEmpty,
        "silentAfterClose": afterClose.isEmpty,
        "secondOnline": entries.contains { $0.token == second && $0.state == .online },
        "networkClosed": closedOnNetwork,
        "down": last("down")?.state.rawValue ?? "",
        "wrongRoot": last("wrong-root")?.state.rawValue ?? "",
        "notThat": last("not-that")?.state.rawValue ?? "",
        "notThatEmpty": last("not-that")?.titles.isEmpty ?? false,
        "backedOff": downDials >= 2 && downDials <= 6,
        "seenOnB": seenOnB,
        "openedOnB": openedOnB,
        "notOnA": notOnA,
        "readOnly": !requests.isEmpty && requests.allSatisfy { ["GET /link/api/native/revocation", "GET /link/api/snapshot"].contains($0) },
        "watcherDevices": devices.map(\.deviceId),
    ]
}

/** A computer that removed this device: the watcher hands over the verified proof once, never dials again, and the profile retires with it. */
func runNativeListWatcherRevoked(_ input: [String: Any]) async throws -> [String: Any] {
    let port = try fixturePort(input), keys = try FixtureKeys()
    let device = try await pairFixture(payload: input["payload"] as? String ?? "", port: port, keys: keys)
    // The device removes itself here; for the watcher a removal by the Mac reads the same.
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-revoked-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: device.hostId)
    let remover = try NativeWorkspace(device: device, keys: keys, vault: vault)
    _ = try await remover.install { try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity()) }
    await remover.removeThisDevice(); await remover.closeOpening()
    let log = WatchLog()
    let watcher = NativeListWatcher(limit: 3, interval: .milliseconds(100)) { log.add($0) }
    var desk = PhoneComputerDesk()
    let token = desk.watch(selected: "a", others: ["b"])
    await watcher.watch([directTarget("b", device: device, keys: keys, port: port)], token: token)
    var proof: VerifiedNativeRevocation?
    _ = try await waitFor {
        for reading in log.take() { if case let .retire(value) = desk.receive(reading, notifying: false) { proof = value } }
        return proof != nil
    }
    let dialled = await watcher.dialCount("b")
    try await Task.sleep(for: .milliseconds(800))
    let redialled = await watcher.dialCount("b") != dialled
    // The same watch hands the removal over once; a new watch once more, still without dialling.
    let reported = log.all.filter { $0.state == .revoked }.count
    await watcher.watch([directTarget("b", device: device, keys: keys, port: port)], token: UUID())
    try await Task.sleep(for: .milliseconds(400))
    let reportedAgain = log.all.filter { $0.state == .revoked }.count == reported + 1
    let stillNotDialled = await watcher.dialCount("b") == dialled
    await watcher.close()
    // The proof retires exactly this profile: keys erased, record gone.
    let erased = FixtureCounter()
    let profiles = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-profiles-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: profiles) }
    let store = try await NativeProfileStore.open(directory: profiles, key: LinkBytes.random(32), eraseKeys: { _ in await erased.increment() })
    let reference = DeviceKeyReference(connectionTag: Data("fixture.watcher.connection".utf8), verificationTag: Data("fixture.watcher.verification".utf8), connectionSpki: keys.connectionSpki, verificationSpki: keys.verificationSpki)
    let saved = NativeRegisteredHost(name: "b", device: device, keys: reference, prepared: false)
    try await store.save(saved)
    if let proof { try await store.retire(saved, proof: proof) }
    let retired = await store.list().isEmpty
    for _ in 0..<40 { if await erased.value > 0 { break }; try await Task.sleep(for: .milliseconds(25)) }
    let erasedKeys = await erased.value
    await store.lock()
    return [
        "proof": proof?.deviceId == device.deviceId && proof?.hostId == device.hostId,
        "dialledOnce": dialled == 1 && !redialled && stillNotDialled,
        "reportedOnce": reported == 1 && reportedAgain,
        "retired": retired && erasedKeys >= 1,
        "readOnly": await watcher.requests().allSatisfy { ["GET /link/api/native/revocation", "GET /link/api/snapshot"].contains($0) },
    ]
}

actor FixtureGate {
    var waiting = false
    private var released = false
    func wait() async throws {
        waiting = true
        while !released { try await Task.sleep(for: .milliseconds(5)) }
    }
    func release() { released = true }
}

func profileForgetFixture(directory: URL, key: Data, profiles: [NativeRegisteredHost], draft: NativePairingDraft) async throws {
    let kept = profiles[0], removed = profiles[1], erased = FixtureCounter()
    let store = try await NativeProfileStore.open(directory: directory, key: key, eraseKeys: { keys in
        await erased.increment()
        if keys.connectionTag == kept.keys.connectionTag { throw NativeFailure.storageUnavailable }
    })
    try await store.save(kept)
    try await store.save(removed)
    var updated = removed; updated.name = "Updated computer"
    try await store.update(updated)
    guard await store.list().contains(where: { $0.id == removed.id && $0.name == updated.name }) else {
        throw NativeFailure.storageUnavailable
    }

    let keptCache = try await store.hostVault(kept), removedCache = try await store.hostVault(removed)
    try await keptCache.storeMetadata(Data("kept cache".utf8), name: "sample")
    try await removedCache.storeMetadata(Data("removed cache".utf8), name: "sample")
    let otherDraft = NativePairingDraft(payload: draft.payload, keys: DeviceKeyReference(
        connectionTag: removed.keys.connectionTag, verificationTag: kept.keys.verificationTag,
        connectionSpki: removed.keys.connectionSpki, verificationSpki: kept.keys.verificationSpki), name: draft.name)
    try await store.saveDraft(otherDraft)
    try await store.forget(removed.id)
    guard await store.list().map(\.id) == [kept.id], await erased.value == 1,
          try await store.draft()?.keys.verificationTag == kept.keys.verificationTag,
          try await keptCache.metadata(name: "sample") == Data("kept cache".utf8),
          !FileManager.default.fileExists(atPath: directory.appendingPathComponent("cache").appendingPathComponent(removed.id).path)
    else { throw NativeFailure.storageUnavailable }
    do { try await store.update(updated); throw NativeFailure.invalidRecord }
    catch NativeFailure.contextChanged {}
    do { _ = try await removedCache.metadata(name: "sample"); throw NativeFailure.invalidRecord }
    catch NativeFailure.storageUnavailable {}
    do { _ = try await store.hostVault(removed); throw NativeFailure.invalidRecord }
    catch NativeFailure.storageUnavailable {}

    try await store.clearDraft(matching: otherDraft.payload)
    try await store.saveDraft(draft)
    do { try await store.forget(kept.id); throw NativeFailure.invalidRecord }
    catch NativeFailure.storageUnavailable {}
    guard await store.list().isEmpty, try await store.draft() == nil, await erased.value == 2 else {
        throw NativeFailure.storageUnavailable
    }
    await store.lock()
    let reopened = try await NativeProfileStore.open(directory: directory, key: key, eraseKeys: { _ in await erased.increment() })
    guard await reopened.list().isEmpty, await erased.value == 3 else { throw NativeFailure.storageUnavailable }
    await reopened.lock()
}
