import Foundation
import LatchNativeCore

/** 「电脑」, the notification switches and 到点前后保持唤醒 as the phone words and writes them, from synthetic Host JSON. */
func phoneAgentComputerFixture(_ input: [String: Any]) throws -> [String: Any] {
    let value = try NativeJSON.decode(JSONSerialization.data(withJSONObject: input))
    let owner = value["owner"].string ?? ""
    let snapshot = value["snapshot"]
    let now = PhoneTime.parse(value["now"]) ?? Date()
    let read = PhoneAgentComputer.parse(value["computer"])
    let agent = snapshot["customAgents"].array.first { $0["id"].string == owner } ?? .null
    func words(_ view: PhoneComputerView) -> [String: Any] {
        ["status": view.status, "tone": view.tone.rawValue, "awakeFor": view.awakeFor ?? NSNull(), "woke": view.woke ?? NSNull(),
         "missedTotal": view.missedTotal, "missed": view.missed.map { ["name": $0.name, "times": $0.times] as [String: Any] },
         "keepAwakeNote": view.keepAwakeNote ?? NSNull()]
    }
    func write(_ make: () throws -> NativePendingWrite) -> Any {
        guard let write = try? make() else { return "refused" }
        return ["method": write.method, "path": write.path, "body": (try? JSONSerialization.jsonObject(with: write.body)) ?? NSNull(),
            "words": PhonePending.words(write), "kind": "\(PhonePending.kind(write))", "handled": PhoneAgentWrites.handles(write)]
    }
    let keepAwake = try PhoneAgentComputer.keepAwakeWrite(agent, on: true)
    // Every switch on again goes back to the default; the first one off stores all three.
    let backToDefault = try PhoneAgentComputer.notificationsWrite(agent, kind: .completed, on: true)
    let firstOff = try PhoneAgentComputer.notificationsWrite(snapshot["customAgents"].array.first { $0["notifications"] == .null } ?? .null, kind: .waiting, on: false)
    let pending = [keepAwake]
    // A lock or a closed window takes the computer with the rest of 我的 Agent.
    var proposals = PhoneProposalStore(), results = PhoneResultStore()
    let taken = PhoneAgents.takeDown(snapshot, proposals: &proposals, results: &results)
    let moved = { () -> NativeJSON in
        guard case var .object(object) = snapshot else { return snapshot }
        object["computer"] = .object(["desktop": .bool(true), "keepAwake": .string("busy")])
        return .object(object)
    }()
    let ran = { () -> NativeJSON in
        guard case var .object(object) = snapshot else { return snapshot }
        object["automations"] = .array(snapshot["automations"].array.map { item in
            guard case var .object(row) = item else { return item }
            row["lastRun"] = .object(["at": .string("2026-11-13T12:00:00.000Z"), "state": .string("running")])
            return .object(row)
        })
        return .object(object)
    }()
    let signature = PhoneAgentComputer.signature(snapshot, owner: owner)
    var locked = snapshot.object; var device = snapshot["device"].object; device["dataScope"] = .string("work"); locked["device"] = .object(device)
    return [
        "online": words(PhoneAgentComputer.view(reachable: true, sleeping: false, read: read, keepAwakeOn: true, now: now)),
        "sleeping": words(PhoneAgentComputer.view(reachable: false, sleeping: true, read: read, keepAwakeOn: false, now: now)),
        "offline": words(PhoneAgentComputer.view(reachable: false, sleeping: false, read: nil, keepAwakeOn: true, now: now)),
        "awake": words(PhoneAgentComputer.view(reachable: true, sleeping: false, read: PhoneAgentComputer.parse(value["awake"]), keepAwakeOn: true, now: now)),
        "unparsed": PhoneAgentComputer.parse(.object(["missed": .array([])])) == nil,
        "path": (try? PhoneAgentComputer.path(owner: owner)) ?? "refused",
        "badPath": (try? PhoneAgentComputer.path(owner: "../x")) ?? "refused",
        "notifications": PhoneNotificationKind.allCases.map { ["label": $0.label, "on": PhoneAgentComputer.notifications(agent)[$0] ?? false] as [String: Any] },
        "keepAwake": PhoneAgentComputer.keepAwake(agent),
        "writes": [
            "keepAwake": write { keepAwake }, "backToDefault": write { backToDefault }, "firstOff": write { firstOff },
            "general": write { try PhoneAgentComputer.keepAwakeWrite(.object(["id": .string("general"), "revision": .number(1)]), on: true) },
        ],
        "held": [
            "keepAwake": PhoneAgentComputer.held(pending, agentId: owner, field: "keepAwakeForSchedules")?.requestId == keepAwake.requestId,
            "notifications": PhoneAgentComputer.held(pending, agentId: owner, field: "notifications") == nil,
        ],
        "locked": [
            PhoneAgentComputer.switchesLocked(pending: [], working: false, busy: false, connected: true, canRun: true),
            PhoneAgentComputer.switchesLocked(pending: [], working: true, busy: false, connected: true, canRun: true),
            PhoneAgentComputer.switchesLocked(pending: [], working: false, busy: true, connected: true, canRun: true),
            PhoneAgentComputer.switchesLocked(pending: pending, working: false, busy: false, connected: true, canRun: true),
            PhoneAgentComputer.switchesLocked(pending: [try PhoneResults.runNow(automationId: "auto_" + String(repeating: "a", count: 8) + "-aaaa-4aaa-8aaa-" + String(repeating: "a", count: 12))], working: false, busy: false, connected: true, canRun: true),
            PhoneAgentComputer.switchesLocked(pending: [], working: false, busy: false, connected: false, canRun: true),
            PhoneAgentComputer.switchesLocked(pending: [], working: false, busy: false, connected: true, canRun: false),
        ],
        // The row that spins on a retry: the switch the held write changes against what the Host shows now.
        "heldKind": [backToDefault, firstOff, keepAwake].map { write -> Any in
            let target = PhonePending.kind(write) == .agent(id: owner) ? agent : (snapshot["customAgents"].array.first { $0["notifications"] == .null } ?? .null)
            return PhoneAgentComputer.heldKind(write, agent: target)?.rawValue ?? NSNull()
        } + [PhoneAgentComputer.heldKind(backToDefault, agent: .object(["id": .string(owner)])).map { $0.rawValue } ?? "none"],
        "blocker": [PhoneAgentComputer.blocker(connected: false, canRun: true), PhoneAgentComputer.blocker(connected: true, canRun: false),
            PhoneAgentComputer.blocker(connected: true, canRun: true)].map { $0 as Any? ?? NSNull() },
        "shown": [PhoneAgentComputer.shown(snapshot, windowOpen: true), PhoneAgentComputer.shown(snapshot, windowOpen: false),
            PhoneAgentComputer.shown(.object(locked), windowOpen: true)],
        "private": [PhoneAgents.withoutPrivate(snapshot)["computer"] == .null, taken["computer"] == .null, snapshot["computer"] != .null],
        "signature": [PhoneAgentComputer.signature(moved, owner: owner) != signature, PhoneAgentComputer.signature(ran, owner: owner) != signature,
            PhoneAgentComputer.signature(snapshot, owner: owner) == signature],
        "when": ["2026-11-13T09:00:00.000Z", "2026-11-14T09:00:00.000Z", "2026-11-12T09:00:00.000Z", "2026-11-01T09:00:00.000Z", "2025-11-01T09:00:00.000Z"]
            .compactMap { PhoneTime.parse(.string($0)) }.map { PhoneAgentComputer.when($0, now: now) },
    ]
}

/** 「电脑」 from the actual Swift workspace against a real Host: the missed time, 立即运行, the switches and the window. */
@MainActor func runNativeAgentComputer(_ input: [String: Any]) async throws -> [String: Any] {
    let invitation = try PairingInvitation.parse(input["payload"] as? String ?? "", privateOnly: false), port = try fixturePort(input), keys = try FixtureKeys()
    guard let agentId = input["agentId"] as? String, let automationId = input["automationId"] as? String else { throw NativeFailure.invalidRecord }
    let pairing = try NativePairing(invitation: invitation, keys: keys)
    let temporary = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey)
    _ = try await pairing.begin(on: temporary, name: "Swift computer fixture", gatewayHash: Data(repeating: 0, count: 32))
    var approved = false
    for _ in 0..<60 {
        if let view = try await pairing.status(on: temporary), view.status == "approved" { approved = true; break }
        try await Task.sleep(for: .milliseconds(50))
    }
    guard approved else { throw NativeFailure.unavailable }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-computer-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: invitation.hostId)
    let device = try await pairing.complete(on: temporary) { device in try await vault.storeMetadata(JSONEncoder().encode(device), name: "device") }
    await temporary.close()
    let workspace = try NativeWorkspace(device: device, keys: keys, vault: vault)
    var stage = "install"
    do {
        let first = try await workspace.install {
            try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
        }
        // Outside a window neither the snapshot's computer nor the route answers.
        stage = "window"
        var windowRequired = false
        do { _ = try await workspace.read(PhoneAgentComputer.path(owner: agentId), body: true) } catch { windowRequired = (error as? NativeFailure) == .expired }
        guard windowRequired, first["computer"] == .null, !PhoneAgentComputer.shown(first, windowOpen: false) else { throw NativeFailure.identityMismatch }
        _ = try await workspace.verify()
        stage = "read"
        let snapshot = try await workspace.snapshot()
        guard PhoneAgentComputer.shown(snapshot, windowOpen: true), snapshot["computer"] != .null,
              let read = PhoneAgentComputer.parse(try await workspace.read(PhoneAgentComputer.path(owner: agentId), body: true)) else { throw NativeFailure.invalidRecord }
        let view = PhoneAgentComputer.view(reachable: true, sleeping: false, read: read, keepAwakeOn: false)
        guard view.missedTotal == 1, view.missed.first?.automationId == automationId, view.missed.first?.times.first?.hasSuffix("：Mac 在睡眠") == true,
              view.woke != nil, view.status == "在线" else { throw NativeFailure.invalidRecord }
        // 通知 › 完成 off from the phone, on the revision it saw: the first try never reaches the Host, and the retry is the
        // same request, applied once.
        stage = "notifications"
        guard let agent = snapshot["customAgents"].array.first(where: { $0["id"].string == agentId }) else { throw NativeFailure.invalidRecord }
        let off = try PhoneAgentComputer.notificationsWrite(agent, kind: .completed, on: false)
        var unknown = false
        do { _ = try await workspace.submit(off, explain: true, retryAnswered: PhoneAgentWrites.retryAnswered(off)) } catch { unknown = (error as? NativeFailure) == .resultUnknown }
        guard unknown, PhoneAgentComputer.held(try await workspace.pendingWrites(), agentId: agentId, field: "notifications")?.requestId == off.requestId,
              PhonePending.words(off) == "通知开关的结果待确认" else { throw NativeFailure.invalidRecord }
        _ = try await workspace.submit(off, explain: true, retryAnswered: PhoneAgentWrites.retryAnswered(off))
        let afterOff = try await workspace.snapshot()["customAgents"].array.first { $0["id"].string == agentId } ?? .null
        guard PhoneAgentComputer.notifications(afterOff)[.completed] == false, PhoneAgentComputer.notifications(afterOff)[.failed] == true,
              afterOff["revision"].integer == (agent["revision"].integer ?? 0) + 1, try await workspace.pendingWrites().isEmpty else { throw NativeFailure.invalidRecord }
        // A switch from the revision seen before: 已在别处修改, never applied.
        stage = "stale"
        let stale = try PhoneAgentComputer.keepAwakeWrite(agent, on: true)
        var refusal: NativeHostRefusal?
        do { _ = try await workspace.submit(stale, explain: true, retryAnswered: PhoneAgentWrites.retryAnswered(stale)) } catch { refusal = error as? NativeHostRefusal }
        guard let refusal, PhoneAgentWrites.outcome(stale, refusal: refusal, proposals: nil) == .changed else { throw NativeFailure.invalidRecord }
        _ = try? await workspace.settlePending(stale.requestId)
        // 到点前后保持唤醒 on, from the revision the Host now has.
        stage = "keepAwake"
        let wake = try PhoneAgentComputer.keepAwakeWrite(afterOff, on: true)
        _ = try await workspace.submit(wake, explain: true, retryAnswered: PhoneAgentWrites.retryAnswered(wake))
        let afterWake = try await workspace.snapshot()["customAgents"].array.first { $0["id"].string == agentId } ?? .null
        guard PhoneAgentComputer.keepAwake(afterWake), PhoneAgentComputer.notifications(afterWake)[.completed] == false,
              try await workspace.pendingWrites().isEmpty else { throw NativeFailure.invalidRecord }
        // 立即运行 of the schedule that missed: once it is a real run, the missed time is no longer counted.
        stage = "run"
        let run = try PhoneResults.runNow(automationId: automationId)
        _ = try await workspace.submit(run)
        var cleared = false
        for _ in 0..<200 {
            if let again = PhoneAgentComputer.parse(try await workspace.read(PhoneAgentComputer.path(owner: agentId), body: true)), again.missed.isEmpty { cleared = true; break }
            try await Task.sleep(for: .milliseconds(25))
        }
        guard cleared else { throw NativeFailure.invalidRecord }
        // The list kept for offline has no computer, and a closed window takes it from the snapshot.
        stage = "private"
        let latest = try await workspace.snapshot()
        guard let cached = try await workspace.cachedSnapshot(), cached["computer"] == .null, latest["computer"] != .null,
              PhoneAgents.withoutPrivate(latest)["computer"] == .null else { throw NativeFailure.storageUnavailable }
        await workspace.closeOpening(); await vault.lock()
        return ["missed": true, "notifications": true, "changed": true, "unknownThenRetry": true, "ranNow": true, "private": true]
    } catch {
        await workspace.closeOpening(); await vault.lock()
        throw FixtureStage(name: stage + " " + ((error as? NativeFailure)?.rawValue ?? (error as? NativeHostRefusal)?.code ?? "failure"))
    }
}
