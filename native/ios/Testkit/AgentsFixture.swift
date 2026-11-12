import Foundation
import LatchNativeCore

/** The tabs, 我的 Agent and 应用 as the App derives them from synthetic Host JSON, in plain values to compare. */
func phoneAgentsFixture(_ input: [String: Any]) throws -> [String: Any] {
    let value = try NativeJSON.decode(JSONSerialization.data(withJSONObject: input))
    let snapshot = value["snapshot"], catalog = snapshot["catalog"]
    func fieldValue(_ json: NativeJSON) throws -> Any { try JSONSerialization.jsonObject(with: json.encoded(), options: .fragmentsAllowed) }
    let agents = snapshot["customAgents"].array
    let choices = agents.map { PhoneAgents.choice(catalog, agent: $0) }
    var fields: [Any] = []
    for (agent, choice) in zip(agents, choices) {
        fields.append((try? fieldValue(.object(PhoneAgents.fields(catalog, agent: agent, choice: choice, prompt: "看一下")))) ?? NSNull())
    }
    let memoryOwner = value["memoryOwner"].string ?? ""
    func write(_ make: () throws -> NativePendingWrite) -> Any {
        guard let write = try? make() else { return "refused" }
        return ["method": write.method, "path": write.path, "body": (try? JSONSerialization.jsonObject(with: write.body)) ?? NSNull(),
            "requestId": write.requestId, "words": PhonePending.words(write), "kind": "\(PhonePending.kind(write))",
            "prompt": PhonePending.prompt(write) ?? NSNull()]
    }
    let memory = value["memory"]
    return [
        "tabs": value["snapshots"].array.map { PhoneTabs.entries($0).map(\.label) },
        "dots": value["snapshots"].array.map { [PhoneTabs.codeDot($0, current: .agents), PhoneTabs.codeDot($0, current: .code)] },
        "access": value["snapshots"].array.map { [PhoneAgents.access($0).rawValue, PhoneAgents.access($0, windowOpen: false).rawValue] },
        "entries": PhoneAgents.entries(snapshot).map { entry -> [String: Any] in
            ["id": entry.id, "name": entry.name, "general": entry.general, "duty": entry.duty, "runs": entry.runs,
             "place": entry.place ?? NSNull(), "available": entry.available, "reason": entry.unavailableReason ?? NSNull(),
             "avatar": [entry.avatar.bracket, entry.avatar.eyes, entry.avatar.hue], "face": entry.face.rawValue]
        },
        "slots": faceSlots(),
        "faces": value["faceCases"].array.map { PhoneAgents.face($0["snapshot"], id: $0["id"].string ?? "", available: $0["available"].bool).rawValue },
        "harnesses": PhoneAgents.harnesses(catalog).map(\.id),
        "choices": choices.map { ["harness": $0.harnessId ?? "", "workspace": $0.workspaceId ?? "", "model": $0.model?.model ?? ""] },
        "blockers": zip(agents, choices).map { PhoneAgents.blocker(catalog, agent: $0, choice: $1, connected: true, canRun: true) ?? "" },
        "offline": agents.first.map { PhoneAgents.blocker(catalog, agent: $0, choice: choices[0], connected: false, canRun: true) ?? "" } ?? "",
        "cannotRun": agents.first.map { PhoneAgents.blocker(catalog, agent: $0, choice: choices[0], connected: true, canRun: false) ?? "" } ?? "",
        "fields": fields,
        "recent": agents.map { agent in PhoneAgents.recent(snapshot["tasks"].array, id: agent["id"].string ?? "").compactMap { $0["id"].string } },
        "generalRecent": PhoneAgents.recent(snapshot["tasks"].array, id: PhoneAgents.generalId).count,
        "delegated": snapshot["tasks"].array.map { PhoneAgents.delegated(snapshot, task: $0) ?? "" },
        "closedWindow": [PhoneAgents.entries(snapshot, windowOpen: false).count, PhoneAgents.automations(snapshot, id: PhoneAgents.generalId, windowOpen: false) == nil ? 0 : 1,
            PhoneAgents.withoutPrivate(snapshot)["customAgents"] == .null && PhoneAgents.withoutPrivate(snapshot)["automations"] == .null ? 0 : 1],
        "delegatedClosed": snapshot["tasks"].array.map { PhoneAgents.delegated(snapshot, task: $0, windowOpen: false) ?? "" },
        "automations": agents.map { PhoneAgents.automations(snapshot, id: $0["id"].string ?? "")?.compactMap { $0["name"].string } ?? [] },
        "generalAutomations": PhoneAgents.automations(snapshot, id: PhoneAgents.generalId)?.compactMap { $0["name"].string } ?? [],
        "schedules": snapshot["automations"].array.map { PhoneAgents.scheduleWords($0["schedule"]) + " · " + PhoneAgents.automationState($0) + " · " + PhoneAgents.runWords($0["lastRun"]["state"].string) },
        "skills": [PhoneAgents.skillWords(catalog, skills: .null), PhoneAgents.skillWords(catalog, skills: .array([])), PhoneAgents.skillWords(catalog, skills: .array([.string("kit:review"), .string("gone:x")]))],
        "apps": PhoneApps.listed(snapshot).map { [$0.id, $0.title, $0.plugin] },
        "memoryWrites": [
            write { try PhoneMemoryWrite.create(owner: memoryOwner, text: "  用 pnpm  ") },
            write { try PhoneMemoryWrite.change(owner: memoryOwner, memory: memory, text: "改过") },
            write { try PhoneMemoryWrite.remove(owner: memoryOwner, memoryId: memory["id"].string ?? "") },
            write { try PhoneMemoryWrite.create(owner: memoryOwner, text: "   ") },
            write { try PhoneMemoryWrite.create(owner: memoryOwner, text: String(repeating: "字", count: 4001)) },
            write { try PhoneMemoryWrite.create(owner: "agt_../../tasks", text: "x") },
            write { try PhoneMemoryWrite.remove(owner: memoryOwner, memoryId: "mem_../x") },
        ],
        "pendingKinds": [
            write { try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["prompt": .string("x")]) },
            write { try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["prompt": .string("x"), "customAgentId": .string(memoryOwner)]) },
            write { try NativePendingWrite(method: .post, path: "/link/api/tasks/ses_1/prompt", fields: ["prompt": .string("x")]) },
            write { try NativePendingWrite(method: .post, path: "/link/api/tasks/ses_1/config", fields: ["configId": .string("model")]) },
        ],
        "delivered": try deliveredCases(),
    ]
}

/** 放弃这次提交 checks first: a session that lists the message by its requestId had it delivered. */
private func deliveredCases() throws -> [Bool] {
    let requestId = "pending-escape-0001"
    let sent = try NativePendingWrite(method: .post, path: "/link/api/tasks/ses_1/prompt", fields: ["prompt": .string("你好")], requestId: requestId)
    let started = try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["prompt": .string("你好")], requestId: requestId)
    func detail(_ id: String, role: String, request: String) throws -> NativeJSON {
        try NativeJSON.decode(JSONSerialization.data(withJSONObject: [
            "summary": ["id": id], "messages": [["id": "m1", "role": role, "requestId": request, "text": "你好"]],
        ]))
    }
    return [
        PhonePending.delivered(sent, detail: try detail("ses_1", role: "user", request: requestId)),
        PhonePending.delivered(sent, detail: try detail("ses_2", role: "user", request: requestId)),
        PhonePending.delivered(sent, detail: try detail("ses_1", role: "assistant", request: requestId)),
        PhonePending.delivered(sent, detail: try detail("ses_1", role: "user", request: "another-request-01")),
        // A new session's ID comes only with the answer, so there is nothing to check.
        PhonePending.delivered(started, detail: try detail("ses_1", role: "user", request: requestId)),
    ]
}

/** 委托 and 记忆 from the phone's actual workspace against a real Host: same request, same answer; a stale edit is not retried. */
@MainActor func runNativeAgents(_ input: [String: Any]) async throws -> [String: Any] {
    let invitation = try PairingInvitation.parse(input["payload"] as? String ?? "", privateOnly: false), port = try fixturePort(input), keys = try FixtureKeys()
    guard let agentId = input["agentId"] as? String else { throw NativeFailure.invalidRecord }
    let pairing = try NativePairing(invitation: invitation, keys: keys)
    let temporary = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey)
    _ = try await pairing.begin(on: temporary, name: "Swift agents fixture", gatewayHash: Data(repeating: 0, count: 32))
    var approved = false
    for _ in 0..<60 {
        if let view = try await pairing.status(on: temporary), view.status == "approved" { approved = true; break }
        try await Task.sleep(for: .milliseconds(50))
    }
    guard approved else { throw NativeFailure.unavailable }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-agents-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: invitation.hostId)
    let device = try await pairing.complete(on: temporary) { device in try await vault.storeMetadata(JSONEncoder().encode(device), name: "device") }
    await temporary.close()
    let workspace = try NativeWorkspace(device: device, keys: keys, vault: vault)
    func settle(_ id: String) async throws -> NativeJSON {
        for _ in 0..<150 {
            let detail = try await workspace.detail(id)
            if detail["summary"]["status"].string == "idle" { return detail }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw NativeFailure.unavailable
    }
    do {
        let first = try await workspace.install {
            try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
        }
        // The tab is there before any window; the Agents themselves come only inside one.
        guard PhoneTabs.entries(first).map(\.id).contains(.agents), PhoneAgents.access(first, windowOpen: false) == .closed,
              PhoneAgents.entries(first).isEmpty else { throw NativeFailure.invalidRecord }
        var windowRequired = false
        do { _ = try await workspace.read("/link/api/custom-agents/" + agentId, body: true) } catch { windowRequired = (error as? NativeFailure) == .expired }
        guard windowRequired else { throw NativeFailure.identityMismatch }
        _ = try await workspace.verify()
        let snapshot = try await workspace.snapshot(), catalog = snapshot["catalog"]
        guard PhoneAgents.access(snapshot) == .ready, PhoneAgents.entries(snapshot).map(\.id) == [PhoneAgents.generalId, agentId] else { throw NativeFailure.invalidRecord }
        guard let agent = snapshot["customAgents"].array.first(where: { $0["id"].string == agentId }) else { throw NativeFailure.invalidRecord }
        let choice = PhoneAgents.choice(catalog, agent: agent)
        guard PhoneAgents.blocker(catalog, agent: agent, choice: choice, connected: true, canRun: true) == nil else { throw NativeFailure.invalidRecord }
        // 委托 through the same start path; the retry of the same request answers with the same session.
        let delegation = try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: PhoneAgents.fields(catalog, agent: agent, choice: choice, prompt: "Review from the phone"))
        // The Agent has no project of its own, so the start folder goes as picked; since 45740a5d the Host takes it.
        guard PhonePending.kind(delegation) == .delegation(agentId: agentId),
              try NativeJSON.decode(delegation.body)["workspaceId"].string == choice.workspaceId, choice.workspaceId == "default" else { throw NativeFailure.invalidRecord }
        guard let sessionId = try await workspace.submit(delegation)["sessionId"].string else { throw NativeFailure.invalidRecord }
        let settled = try await settle(sessionId)
        guard settled["summary"]["agent"]["customAgentId"].string == agentId,
              settled["messages"].array.first?["requestId"].string == delegation.requestId,
              try await workspace.submit(delegation)["sessionId"].string == sessionId else { throw NativeFailure.identityMismatch }
        let after = try await workspace.snapshot()
        guard let task = after["tasks"].array.first(where: { $0["id"].string == sessionId }),
              PhoneAgents.delegated(after, task: task) == "为 代码审阅 委托",
              PhoneAgents.recent(after["tasks"].array, id: agentId).compactMap({ $0["id"].string }) == [sessionId],
              after["tasks"].array.filter({ $0["agent"]["customAgentId"].string == agentId }).count == 1 else { throw NativeFailure.invalidRecord }
        // The list kept for offline still knows the session's Agent and the tabs.
        guard let cached = try await workspace.cachedSnapshot(), PhoneTabs.entries(cached).map(\.id).contains(.agents),
              cached["tasks"].array.contains(where: { $0["agent"]["customAgentId"].string == agentId }),
              cached["customAgents"] == .null, cached["automations"] == .null,
              PhoneAgents.access(snapshot, windowOpen: false) == .closed else { throw NativeFailure.storageUnavailable }
        // 记忆: a write keeps its request; the Host answers a retry by its receipt.
        let create = try PhoneMemoryWrite.create(owner: agentId, text: "这个仓库用 pnpm")
        _ = try await workspace.submit(create)
        _ = try await workspace.submit(create)
        var detail = try await workspace.read("/link/api/custom-agents/" + agentId, body: true)
        guard detail["memories"].array.count == 1, let memory = detail["memories"].array.first, memory["content"].string == "这个仓库用 pnpm" else { throw NativeFailure.invalidRecord }
        _ = try await workspace.submit(PhoneMemoryWrite.change(owner: agentId, memory: memory, text: "这个仓库只用 pnpm"))
        detail = try await workspace.read("/link/api/custom-agents/" + agentId, body: true)
        guard detail["memories"].array.first?["content"].string == "这个仓库只用 pnpm" else { throw NativeFailure.invalidRecord }
        var stale = false
        do { _ = try await workspace.submit(PhoneMemoryWrite.change(owner: agentId, memory: memory, text: "旧版本上的修改")) }
        catch { stale = (error as? NativeFailure) == .changedElsewhere }
        guard stale, try await workspace.pendingWrites().isEmpty else { throw NativeFailure.invalidRecord }
        let remove = try PhoneMemoryWrite.remove(owner: agentId, memoryId: memory["id"].string ?? "")
        _ = try await workspace.submit(remove)
        _ = try await workspace.submit(remove)
        detail = try await workspace.read("/link/api/custom-agents/" + agentId, body: true)
        guard detail["memories"].array.isEmpty else { throw NativeFailure.invalidRecord }
        // 通用 has its own memories through the same routes.
        _ = try await workspace.submit(PhoneMemoryWrite.create(owner: PhoneAgents.generalId, text: "回答用中文"))
        let general = try await workspace.read("/link/api/custom-agents/general", body: true)
        guard general["memories"].array.count == 1, general["general"]["id"].string == PhoneAgents.generalId,
              try await workspace.pendingWrites().isEmpty else { throw NativeFailure.invalidRecord }
        _ = try await workspace.submit(NativePendingWrite(method: .delete, path: "/link/api/tasks/" + sessionId, fields: [:]))
        await workspace.closeOpening(); await vault.lock()
        return ["delegated": true, "sameSession": true, "memoryReceipts": true, "staleRefused": true, "general": true, "cachedTabs": true]
    } catch {
        await workspace.closeOpening(); await vault.lock(); throw error
    }
}

/** Ten looping faces asking every quarter second for a minute: the most moving at once, and how many got a turn. */
func faceSlots() -> [String: Any] {
    var slots = PhoneFaceSlots(), peak = 0, turns = Set<Int>()
    for step in 0..<240 {
        let now = Double(step) * 0.25
        for face in 0..<10 where slots.take("face-\(face)", now: now, for: 6, resting: 4) { turns.insert(face) }
        peak = max(peak, slots.held(now: now))
    }
    var released = PhoneFaceSlots()
    _ = released.take("a", now: 0, for: 6); _ = released.take("b", now: 0, for: 6); _ = released.take("c", now: 0, for: 6)
    let fourthWaits = !released.take("d", now: 1, for: 6)
    released.release("a")
    return ["peak": peak, "turns": turns.count, "fourthWaits": fourthWaits, "afterRelease": released.take("d", now: 1, for: 6)]
}
