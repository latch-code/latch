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
        "agentDots": value["snapshots"].array.map { [PhoneTabs.agentsDot($0, current: .code), PhoneTabs.agentsDot($0, current: .agents)] },
        "spaces": snapshot["tasks"].array.map { PhoneSpaces.of($0).rawValue },
        "codeTasks": PhoneSpaces.tasks(snapshot, in: .code).compactMap { $0["id"].string },
        "agentTasks": PhoneSpaces.tasks(snapshot, in: .agents).compactMap { $0["id"].string },
        "unsplit": [PhoneSpaces.tasks(value["unsplit"], in: .code).count, PhoneSpaces.tasks(value["unsplit"], in: .agents).count],
        "elsewhere": ["a", "d", "missing"].map { PhoneSpaces.belongsElsewhere(snapshot, sessionId: $0, from: .code) },
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
        "topics": ([PhoneAgents.generalId] + agents.compactMap { $0["id"].string }).map { id -> [String: Any] in
            let topics = PhoneAgentChat.topics(snapshot["tasks"].array, id: id)
            return ["open": topics.open.compactMap { $0["id"].string }, "archived": topics.archived.compactMap { $0["id"].string },
                    "current": PhoneAgentChat.current(snapshot["tasks"].array, id: id)?["id"].string ?? NSNull()]
        },
        "topicWords": snapshot["tasks"].array.map { PhoneAgentChat.topicWords($0, frozen: false) ?? "" },
        "placeholder": PhoneAgentChat.placeholder("代码审阅"),
        "generalChoice": { let choice = PhoneAgentChat.generalChoice(catalog); return [choice.harnessId ?? "", choice.workspaceId ?? "", choice.model?.model ?? ""] }(),
        "generalFields": PhoneAgents.harnesses(catalog).map { harness -> Any in
            let choice = PhoneStartChoice(harnessId: harness.id, workspaceId: "latch", model: PhoneStart.models(catalog).first)
            return (try? fieldValue(.object(PhoneAgentChat.generalFields(catalog, choice: choice, prompt: "你好")))) ?? NSNull()
        },
        "generalBlockers": [PhoneAgentChat.generalBlocker(catalog, choice: PhoneAgentChat.generalChoice(catalog), connected: true, canRun: true) ?? "",
            PhoneAgentChat.generalBlocker(catalog, choice: PhoneStartChoice(harnessId: "gone"), connected: true, canRun: true) ?? "",
            PhoneAgentChat.generalBlocker(catalog, choice: PhoneAgentChat.generalChoice(catalog), connected: false, canRun: true) ?? ""],
        "kits": agents.map { PhoneAgentChat.kitWords(catalog, agent: $0) },
        "owners": snapshot["tasks"].array.map { PhoneAgents.ownerName(snapshot, task: $0) ?? "" },
        "closedWindow": [PhoneAgents.entries(snapshot, windowOpen: false).count, PhoneAgents.automations(snapshot, id: PhoneAgents.generalId, windowOpen: false) == nil ? 0 : 1,
            PhoneAgents.withoutPrivate(snapshot)["customAgents"] == .null && PhoneAgents.withoutPrivate(snapshot)["automations"] == .null
                && PhoneAgents.withoutPrivate(snapshot)["agentProposals"] == .null ? 0 : 1],
        "ownersClosed": snapshot["tasks"].array.map { PhoneAgents.ownerName(snapshot, task: $0, windowOpen: false) ?? "" },
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
        "proposals": proposalCases(value),
        "memoryChanges": memoryCases(value),
        "decisions": [
            write { try PhoneProposals.save(owner: memoryOwner, proposalId: "prp_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d") },
            write { try PhoneProposals.dismiss(owner: PhoneAgents.generalId, proposalId: "prp_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d") },
            write { try PhoneProposals.save(owner: memoryOwner, proposalId: "prp_../x") },
            write { try PhoneMemories.undo(owner: memoryOwner, memoryId: memory["id"].string ?? "", baseRevision: 3) },
            write { try PhoneMemories.forget(owner: memoryOwner, memoryId: memory["id"].string ?? "", baseRevision: 2) },
            write { try PhoneScheduleWrite.enabled(snapshot["automations"].array[0], on: false) },
            write { try PhoneScheduleWrite.enabled(.object(["id": .string("auto_x"), "revision": .number(1)]), on: true) },
        ],
        "scheduleBlockers": [
            PhoneScheduleWrite.blocker(agent: agents[0], connected: true, canRun: true) ?? "",
            PhoneScheduleWrite.blocker(agent: agents[1], connected: true, canRun: true) ?? "",
            PhoneScheduleWrite.blocker(agent: .null, connected: true, canRun: true) ?? "",
            PhoneScheduleWrite.blocker(agent: agents[1], connected: false, canRun: true) ?? "",
            PhoneScheduleWrite.blocker(agent: agents[1], connected: true, canRun: false) ?? "",
        ],
        "pendingKinds": [
            write { try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["prompt": .string("x")]) },
            write { try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["prompt": .string("x"), "customAgentId": .string(memoryOwner)]) },
            write { try NativePendingWrite(method: .post, path: "/link/api/tasks/ses_1/prompt", fields: ["prompt": .string("x")]) },
            write { try NativePendingWrite(method: .post, path: "/link/api/tasks/ses_1/config", fields: ["configId": .string("model")]) },
            write { try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["prompt": .string("x"), "customAgentId": .string(PhoneAgents.generalId)]) },
        ],
        "delivered": try deliveredCases(),
        "queued": try queuedCases(),
        "joined": [PhonePending.joined("  ", "回来的"), PhonePending.joined("新写的", "回来的")],
    ]
}

/** Proposals as the conversation and the 记忆 section place and word them; hidden characters are drawn, never kept. */
private func proposalCases(_ value: NativeJSON) -> [String: Any] {
    let proposals = PhoneProposals.parse(value["proposals"])
    let detail = value["topicDetail"]
    let messages = detail["messages"].array
    let turns = PhoneConversation.turns(messages).map(\.id)
    let placed = PhoneProposals.place(proposals + PhoneProposals.refusals(detail), sessionId: detail["summary"]["id"].string ?? "", messages: messages, turnIds: turns)
    return [
        "parsed": proposals.map { [$0.id, $0.content, $0.reason ?? "", $0.origin, $0.external ? "external" : "", $0.state.rawValue] },
        "pending": PhoneProposals.pending(proposals).map(\.id),
        "placed": placed.mapValues { $0.map(\.id) },
        "refused": PhoneProposals.refusals(detail).map { [$0.id, $0.content, $0.refused ? "refused" : ""] },
        "origins": [PhoneProposals.originWords("user"), PhoneProposals.originWords("agent")],
        "effects": [PhoneProposals.effectWords(.object(["agentContext": .string("private")])), PhoneProposals.effectWords(.object(["agentContext": .string("first-turn")]))],
        "signature": [PhoneProposals.signature(value["snapshot"], owner: "general"), PhoneProposals.signature(.null, owner: "general")],
    ]
}

/** 撤销 and 清除 from the Host's last change of each memory, and each memory's source. */
private func memoryCases(_ value: NativeJSON) -> [String: Any] {
    let detail = value["memoryDetail"]
    return [
        "deleted": PhoneMemories.deleted(detail).compactMap { $0["memoryId"].string },
        "edited": detail["memories"].array.map { PhoneMemories.edited(detail, memoryId: $0["id"].string ?? "") },
        "sources": detail["memories"].array.map { memory -> Any in
            guard let source = PhoneMemories.source(memory) else { return NSNull() }
            return [source.words, source.external ? "external" : "", source.sessionId ?? ""]
        },
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

/** A new topic, 「记住…」 and its proposal, 撤销, a schedule's switch and 记忆 from the phone's actual workspace against a real Host: same request, same answer; a stale edit is not retried. */
@MainActor func runNativeAgents(_ input: [String: Any]) async throws -> [String: Any] {
    let invitation = try PairingInvitation.parse(input["payload"] as? String ?? "", privateOnly: false), port = try fixturePort(input), keys = try FixtureKeys()
    guard let agentId = input["agentId"] as? String, let automationId = input["automationId"] as? String else { throw NativeFailure.invalidRecord }
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
        // A new topic through the same start path; the retry of the same request answers with the same session.
        let delegation = try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: PhoneAgents.fields(catalog, agent: agent, choice: choice, prompt: "Review from the phone"))
        // The Agent has no project of its own, so the start folder goes as picked; since 45740a5d the Host takes it.
        guard PhonePending.kind(delegation) == .topic(owner: agentId), PhonePending.prompt(delegation) == "Review from the phone",
              try NativeJSON.decode(delegation.body)["workspaceId"].string == choice.workspaceId, choice.workspaceId == "default" else { throw NativeFailure.invalidRecord }
        guard let sessionId = try await workspace.submit(delegation)["sessionId"].string else { throw NativeFailure.invalidRecord }
        let settled = try await settle(sessionId)
        guard settled["summary"]["agent"]["customAgentId"].string == agentId,
              settled["messages"].array.first?["requestId"].string == delegation.requestId,
              try await workspace.submit(delegation)["sessionId"].string == sessionId else { throw NativeFailure.identityMismatch }
        let after = try await workspace.snapshot()
        guard let task = after["tasks"].array.first(where: { $0["id"].string == sessionId }),
              PhoneAgents.ownerName(after, task: task) == "代码审阅", PhoneAgents.ownerName(after, task: task, windowOpen: false) == "我的 Agent",
              PhoneAgentChat.current(after["tasks"].array, id: agentId)?["id"].string == sessionId,
              !PhoneSpaces.tasks(after, in: .code).contains(where: { $0["id"].string == sessionId }),
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
        // 「记住：…」 in the topic becomes a pending proposal; 保存 makes it a memory with its source, and a retry is answered alike.
        let remember = try NativePendingWrite(method: .post, path: "/link/api/tasks/" + sessionId + "/prompt", fields: ["prompt": .string("记住：发版前先跑 pnpm check")])
        _ = try await workspace.submit(remember)
        _ = try await settle(sessionId)
        let proposals = PhoneProposals.parse(try await workspace.read("/link/api/custom-agents/" + agentId + "/proposals", body: true))
        guard let proposal = proposals.first, proposals.count == 1, proposal.state == .pending, proposal.origin == "user", !proposal.external,
              proposal.content == "发版前先跑 pnpm check", proposal.sessionId == sessionId,
              PhoneProposals.turn(proposal, messages: try await workspace.detail(sessionId)["messages"].array) != nil else { throw NativeFailure.invalidRecord }
        let save = try PhoneProposals.save(owner: agentId, proposalId: proposal.id)
        guard PhonePending.kind(save) == .proposal(owner: agentId) else { throw NativeFailure.invalidRecord }
        let saved = try await workspace.submit(save)
        guard try await workspace.submit(save)["memoryId"] == saved["memoryId"], saved["memoryId"].string != nil else { throw NativeFailure.identityMismatch }
        var decided = false
        do { _ = try await workspace.submit(PhoneProposals.dismiss(owner: agentId, proposalId: proposal.id)) } catch { decided = error is NativeFailure }
        detail = try await workspace.read("/link/api/custom-agents/" + agentId, body: true)
        guard decided, let kept = detail["memories"].array.first(where: { $0["id"] == saved["memoryId"] }),
              PhoneMemories.source(kept)?.words == "你说的", PhoneMemories.source(kept)?.sessionId == sessionId else { throw NativeFailure.invalidRecord }
        // An edit, then 撤销 with the revision shown: the text and the source come back.
        _ = try await workspace.submit(PhoneMemoryWrite.change(owner: agentId, memory: kept, text: "发版前跑 pnpm check 与 e2e"))
        detail = try await workspace.read("/link/api/custom-agents/" + agentId, body: true)
        guard let changed = detail["memories"].array.first(where: { $0["id"] == kept["id"] }), PhoneMemories.edited(detail, memoryId: kept["id"].string ?? ""),
              PhoneMemories.source(changed) == nil, let changedRevision = changed["revision"].integer else { throw NativeFailure.invalidRecord }
        var staleUndo = false
        do { _ = try await workspace.submit(PhoneMemories.undo(owner: agentId, memoryId: kept["id"].string ?? "", baseRevision: Int(changedRevision) - 1)) }
        catch { staleUndo = (error as? NativeFailure) == .changedElsewhere }
        _ = try await workspace.submit(PhoneMemories.undo(owner: agentId, memoryId: kept["id"].string ?? "", baseRevision: Int(changedRevision)))
        detail = try await workspace.read("/link/api/custom-agents/" + agentId, body: true)
        guard staleUndo, let undone = detail["memories"].array.first(where: { $0["id"] == kept["id"] }), undone["content"].string == "发版前先跑 pnpm check",
              PhoneMemories.source(undone) != nil, !PhoneMemories.edited(detail, memoryId: kept["id"].string ?? "") else { throw NativeFailure.invalidRecord }
        // A delete leaves 撤销 and 清除; 清除 takes the text now.
        _ = try await workspace.submit(PhoneMemoryWrite.remove(owner: agentId, memoryId: kept["id"].string ?? ""))
        detail = try await workspace.read("/link/api/custom-agents/" + agentId, body: true)
        // The earlier memory's delete is listed too; each has its own 撤销 and 清除.
        guard let gone = PhoneMemories.deleted(detail).first(where: { $0["memoryId"] == kept["id"] }), PhoneMemories.deleted(detail).count == 2, let goneRevision = gone["previous"]["revision"].integer else { throw NativeFailure.invalidRecord }
        _ = try await workspace.submit(PhoneMemories.forget(owner: agentId, memoryId: kept["id"].string ?? "", baseRevision: Int(goneRevision)))
        detail = try await workspace.read("/link/api/custom-agents/" + agentId, body: true)
        guard PhoneMemories.deleted(detail).map({ $0["memoryId"] }) == [memory["id"]] else { throw NativeFailure.invalidRecord }
        // 即将进行's switch, with the revision shown and the same request on retry.
        let before = try await workspace.snapshot()
        guard let automation = before["automations"].array.first(where: { $0["id"].string == automationId }), automation["enabled"].bool else { throw NativeFailure.invalidRecord }
        let off = try PhoneScheduleWrite.enabled(automation, on: false)
        guard PhonePending.kind(off) == .schedule(id: automationId) else { throw NativeFailure.invalidRecord }
        _ = try await workspace.submit(off)
        _ = try await workspace.submit(off)
        var staleSwitch = false
        do { _ = try await workspace.submit(PhoneScheduleWrite.enabled(automation, on: true)) } catch { staleSwitch = (error as? NativeFailure) == .changedElsewhere }
        guard staleSwitch, try await workspace.snapshot()["automations"].array.first(where: { $0["id"].string == automationId })?["enabled"].bool == false else { throw NativeFailure.invalidRecord }
        // 通用: its first message starts a conversation without a project, marked as 通用's.
        let generalStart = try NativePendingWrite(method: .post, path: "/link/api/tasks",
            fields: PhoneAgentChat.generalFields(catalog, choice: PhoneAgentChat.generalChoice(catalog), prompt: "你好"))
        guard PhonePending.kind(generalStart) == .topic(owner: PhoneAgents.generalId),
              let generalSession = try await workspace.submit(generalStart)["sessionId"].string else { throw NativeFailure.invalidRecord }
        _ = try await settle(generalSession)
        let withGeneral = try await workspace.snapshot()
        guard PhoneAgentChat.current(withGeneral["tasks"].array, id: PhoneAgents.generalId)?["id"].string == generalSession,
              PhoneSpaces.tasks(withGeneral, in: .agents).contains(where: { $0["id"].string == generalSession }),
              try await workspace.cachedSnapshot()?["tasks"].array.first(where: { $0["id"].string == generalSession })?["generalChat"].bool == true else { throw NativeFailure.invalidRecord }
        _ = try await workspace.submit(NativePendingWrite(method: .delete, path: "/link/api/tasks/" + generalSession, fields: [:]))
        // 通用 has its own memories through the same routes.
        _ = try await workspace.submit(PhoneMemoryWrite.create(owner: PhoneAgents.generalId, text: "回答用中文"))
        let general = try await workspace.read("/link/api/custom-agents/general", body: true)
        guard general["memories"].array.count == 1, general["general"]["id"].string == PhoneAgents.generalId,
              try await workspace.pendingWrites().isEmpty else { throw NativeFailure.invalidRecord }
        _ = try await workspace.submit(NativePendingWrite(method: .delete, path: "/link/api/tasks/" + sessionId, fields: [:]))
        await workspace.closeOpening(); await vault.lock()
        return ["delegated": true, "sameSession": true, "memoryReceipts": true, "staleRefused": true, "general": true, "cachedTabs": true,
                "proposalSaved": true, "undone": true, "scheduleSwitched": true, "generalTopic": true]
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

/** A queue item with the same text is named, waiting or parked; the queue shows no request IDs or devices. */
private func queuedCases() throws -> [String] {
    let queued = try NativePendingWrite(method: .post, path: "/link/api/tasks/ses_1/prompt", fields: ["prompt": .string("排队的话"), "queue": .bool(true)])
    let plain = try NativePendingWrite(method: .post, path: "/link/api/tasks/ses_1/prompt", fields: ["prompt": .string("排队的话")])
    func detail(_ state: String, text: String) throws -> NativeJSON {
        try NativeJSON.decode(JSONSerialization.data(withJSONObject: [
            "summary": ["id": "ses_1"], "messages": [], "queue": [["id": "queue-1", "text": text, "queuedAt": "2026-11-12T00:00:00.000Z", "state": state]],
        ]))
    }
    return [
        PhonePending.queuedTwin(queued, detail: try detail("waiting", text: "排队的话")) ?? "",
        PhonePending.queuedTwin(queued, detail: try detail("parked", text: "排队的话")) ?? "",
        PhonePending.queuedTwin(queued, detail: try detail("dropped", text: "排队的话")) ?? "",
        PhonePending.queuedTwin(queued, detail: try detail("waiting", text: "别的")) ?? "",
        PhonePending.queuedTwin(plain, detail: try detail("waiting", text: "排队的话")) ?? "",
    ]
}

/** The review's cases: what a page shows, the input after a start, where a retry is offered, the proposal store, the sheet after expiry. */
func phoneAgentPagesFixture(_ input: [String: Any]) throws -> [String: Any] {
    let value = try NativeJSON.decode(JSONSerialization.data(withJSONObject: input))
    let tasks = value["tasks"].array, owner = value["owner"].string ?? ""
    let topic = try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["prompt": .string("你好"), "customAgentId": .string(owner)])
    let other = try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["prompt": .string("别的"), "customAgentId": .string(PhoneAgents.generalId)])
    let proposal = try PhoneProposals.save(owner: owner, proposalId: "prp_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
    let schedule = try PhoneScheduleWrite.enabled(.object(["id": .string("auto_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"), "revision": .number(2)]), on: false)
    let prompt = try NativePendingWrite(method: .post, path: "/link/api/tasks/ses_1/prompt", fields: ["prompt": .string("x")])
    // 放弃 after an unknown start: the input was emptied when the request was held, so the text comes back once.
    let held = PhoneAgentChat.promptAfterStart("你好", pending: [topic], owner: owner, started: false)
    var store = PhoneProposalStore()
    let list = value["proposals"]
    let first = store.begin(owner), second = store.begin(owner)
    let staleAdopted = store.finish(owner, token: first, list: .object(["proposals": .array([])]), windowOpen: true)
    let freshAdopted = store.finish(owner, token: second, list: list, windowOpen: true)
    let adoptedCount = store[owner]?.count ?? -1
    let inFlight = store.begin(owner)
    store.clear()
    let afterClear = store.finish(owner, token: inFlight, list: list, windowOpen: true)
    var closed = PhoneProposalStore()
    let closedToken = closed.begin(owner)
    let closedAdopted = closed.finish(owner, token: closedToken, list: list, windowOpen: false)
    return [
        "shown": [
            PhoneAgentChat.shown(tasks, owner: owner, picked: nil, newTopic: false) ?? "",
            PhoneAgentChat.shown(tasks, owner: owner, picked: "old", newTopic: false) ?? "",
            PhoneAgentChat.shown(tasks, owner: owner, picked: "code", newTopic: false) ?? "",
            PhoneAgentChat.shown(tasks, owner: owner, picked: "theirs", newTopic: false) ?? "",
            PhoneAgentChat.shown(tasks, owner: owner, picked: "gone", newTopic: false) ?? "",
            PhoneAgentChat.shown(tasks, owner: owner, picked: "old", newTopic: true) ?? "",
            PhoneAgentChat.shown(tasks, owner: PhoneAgents.generalId, picked: "code", newTopic: false) ?? "",
        ],
        "prompts": [held, PhonePending.joined(held, "你好"), PhoneAgentChat.promptAfterStart("你好", pending: [], owner: owner, started: false),
            PhoneAgentChat.promptAfterStart("你好", pending: [other], owner: owner, started: false), PhoneAgentChat.promptAfterStart("你好", pending: [], owner: owner, started: true)],
        "abandonable": [PhonePending.prompt(topic) ?? "", PhonePending.prompt(proposal) ?? "", PhonePending.prompt(schedule) ?? ""],
        "retried": [topic, other, proposal, schedule, prompt].map { write in
            [PhonePending.retried(write, at: .session("ses_1")), PhonePending.retried(write, at: .newTopic(owner)), PhonePending.retried(write, at: .list)]
        },
        "topicOwners": [PhonePending.topicOwner(topic) ?? "", PhonePending.topicOwner(prompt) ?? ""],
        // Unknown results stay with their row: the held write is found again by the row that sent it.
        "held": [PhoneProposals.held([schedule, proposal], owner: owner, proposalId: "prp_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")?.saving == true,
            PhoneProposals.held([schedule], owner: owner, proposalId: "prp_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d") == nil,
            PhoneScheduleWrite.held([proposal, schedule], automationId: "auto_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")?.requestId == schedule.requestId,
            PhoneScheduleWrite.held([proposal], automationId: "auto_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d") == nil],
        "store": [staleAdopted, freshAdopted, adoptedCount == 1, afterClear, store.isEmpty, closedAdopted, closed[owner] == nil],
        "contentChange": [PhoneContentChange.next(windowOpen: false, showing: true), PhoneContentChange.next(windowOpen: true, showing: true),
            PhoneContentChange.next(windowOpen: false, showing: false)].map { "\($0)" },
    ]
}
