import Foundation
import LatchNativeCore

/** Result cards, schedule proposals, 动态 and 资料库 as the phone words and places them, from synthetic Host JSON. */
func phoneAgentActivityFixture(_ input: [String: Any]) throws -> [String: Any] {
    let value = try NativeJSON.decode(JSONSerialization.data(withJSONObject: input))
    let owner = value["owner"].string ?? ""
    let results = PhoneResults.parse(value["results"])
    let detail = value["detail"]
    let turns = PhoneConversation.turns(detail["messages"].array)
    let snapshot = value["snapshot"]
    let tasks = snapshot["tasks"].array, automations = snapshot["automations"].array
    func write(_ make: () throws -> NativePendingWrite) -> Any {
        guard let write = try? make() else { return "refused" }
        return ["method": write.method, "path": write.path, "body": (try? JSONSerialization.jsonObject(with: write.body)) ?? NSNull(),
            "words": PhonePending.words(write), "kind": "\(PhonePending.kind(write))"]
    }
    let proposals = PhoneProposals.parse(value["proposals"])
    let schedule = proposals.first { $0.schedule != nil }
    let agent = snapshot["customAgents"].array.first { $0["id"].string == owner } ?? .null
    let now = PhoneTime.parse(value["now"]) ?? Date()
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "UTC")!
    let rows = PhoneActivity.rows(value["activity"])
    let groups = PhoneActivity.groups(value["library"])
    // A later page joins only the load it continues; a lock drops everything in flight.
    var paged = PhonePagedRead<String>()
    let first = paged.begin()
    let earlyMore = paged.beginMore() == nil
    paged.finish(first, rows: ["a", "b"], next: "2026-11-01T00:00:00.000Z|b", more: false, windowOpen: true)
    let more = paged.beginMore()
    let duplicate = paged.beginMore() == nil
    let reloaded = paged.begin()
    let staleMore = more.map { paged.finish($0.token, rows: ["stale"], next: nil, more: true, windowOpen: true) } ?? true
    paged.finish(reloaded, rows: ["a2"], next: "2026-11-01T00:00:00.000Z|a2", more: false, windowOpen: true)
    let again = paged.beginMore()
    let appended = again.map { paged.finish($0.token, rows: ["c"], next: nil, more: true, windowOpen: true) } ?? false
    let afterAppend = paged.rows
    let closedLoad = paged.begin()
    let closedAdopted = paged.finish(closedLoad, rows: ["x"], next: nil, more: false, windowOpen: false)
    paged.clear()
    // 加载更多 pressed right after a reload began: nothing to continue, so no page of the old load is asked for.
    var reloading = PhonePagedRead<String>()
    let firstLoad = reloading.begin()
    reloading.finish(firstLoad, rows: ["a"], next: "2026-11-01T00:00:00.000Z|a", more: false, windowOpen: true)
    let secondLoad = reloading.begin()
    let moreDuringReload = reloading.beginMore() == nil
    reloading.finish(secondLoad, rows: ["b"], next: "2026-11-01T00:00:00.000Z|b", more: false, windowOpen: true)
    let moreAfterReload = reloading.beginMore() != nil && !reloading.current(firstLoad) && reloading.current(secondLoad)
    var store = PhoneResultStore()
    let token = store.begin(owner)
    store.clear()
    let lateResults = store.finish(owner, token: token, value: results, windowOpen: true)
    return [
        "results": results.map { result -> [String: Any] in
            ["id": result.id, "name": result.name, "outcome": PhoneResults.outcomeWords(result.outcome).word, "tone": PhoneResults.outcomeWords(result.outcome).tone.rawValue,
             "reply": result.reply ?? NSNull(), "preview": result.reply.map { [PhoneResults.preview($0).short, PhoneResults.preview($0).more] as [Any] } ?? NSNull(),
             "files": result.files.map { [$0.shown, $0.change, $0.deleted ? "deleted" : ""] }, "more": result.filesMore, "reason": result.reason ?? NSNull(),
             "removed": result.contentRemoved, "run": PhoneResults.run(result, tasks: tasks) ?? NSNull(),
             "step": PhoneResults.nextStep(result, automations: automations, canRun: true, connected: true).map { "\($0)" } ?? NSNull(),
             "stepOffline": PhoneResults.nextStep(result, automations: automations, canRun: true, connected: false) == nil,
             "stepViewOnly": PhoneResults.nextStep(result, automations: automations, canRun: false, connected: true) == nil]
        },
        "placed": PhoneResults.place(results, turns: turns).mapValues { $0.map(\.id) },
        "stack": { let stack = PhoneResults.stack(results); return [stack.hidden, stack.shown.map(\.id)] as [Any] }(),
        "runNow": [write { try PhoneResults.runNow(automationId: automations.first?["id"].string ?? "") }, write { try PhoneResults.runNow(automationId: "auto_../x") }],
        "signature": [PhoneResults.signature(snapshot, owner: owner), PhoneResults.signature(.null, owner: owner)],
        "waiting": [PhoneResults.waiting(snapshot, owner: owner), PhoneResults.waiting(snapshot, owner: PhoneAgents.generalId)],
        "proposals": proposals.map { proposal in [proposal.id, proposal.schedule == nil ? "memory" : "schedule", proposal.schedule == nil ? proposal.content : PhoneScheduleProposals.line(proposal)] },
        "memoryPending": PhoneProposals.pending(proposals).map(\.id),
        "inputLine": schedule.map { PhoneScheduleProposals.inputLine($0.content) } ?? "",
        "locations": PhoneScheduleProposals.locations(snapshot["catalog"], harness: .null).map(\.id),
        "location": PhoneScheduleProposals.location(agent, catalog: snapshot["catalog"]) ?? NSNull(),
        "formBlockers": schedule.map { proposal in
            [PhoneScheduleProposals.blocker(proposal, location: nil, catalog: snapshot["catalog"], agent: agent, connected: true, canRun: true) ?? "",
             PhoneScheduleProposals.blocker(proposal, location: "gone", catalog: snapshot["catalog"], agent: agent, connected: true, canRun: true) ?? "",
             PhoneScheduleProposals.blocker(proposal, location: "default", catalog: snapshot["catalog"], agent: agent, connected: true, canRun: true) ?? "",
             PhoneScheduleProposals.blocker(proposal, location: "default", catalog: snapshot["catalog"], agent: agent, connected: false, canRun: true) ?? ""]
        } ?? [],
        "creates": schedule.map { proposal in
            [write { try PhoneScheduleProposals.create(owner: owner, proposal: proposal, location: "app", notify: true) },
             write { try PhoneScheduleProposals.create(owner: PhoneAgents.generalId, proposal: proposal, location: "default", notify: false) },
             write { try PhoneScheduleProposals.create(owner: owner, proposal: proposals.first { $0.schedule == nil }!, location: "default", notify: false) }]
        } ?? [],
        "heldCreate": schedule.map { proposal in
            let created = try? PhoneScheduleProposals.create(owner: owner, proposal: proposal, location: "default", notify: false)
            return [PhoneScheduleProposals.held(created.map { [$0] } ?? [], proposalId: proposal.id) != nil, PhoneScheduleProposals.held([], proposalId: proposal.id) == nil]
        } ?? [],
        "activity": rows.map { row -> [Any] in
            let target: String
            switch row.target {
            case let .session(id): target = "session:" + id
            case .memory: target = "memory"
            case .none: target = ""
            }
            return [row.lead, row.subject ?? "", row.state ?? "", row.tone.rawValue, target]
        },
        "buckets": PhoneActivity.bucketed(rows, now: now, calendar: calendar).map { [$0.label, $0.rows.map(\.id)] as [Any] },
        "library": groups.map { group -> [Any] in
            [group.title, group.run, group.files.map { [$0.shown, $0.words, $0.root, $0.reference, $0.openable, $0.image] as [Any] }, group.more]
        },
        "paths": [
            (try? PhoneActivity.path(owner: owner, part: "activity", before: nil)) ?? "refused",
            (try? PhoneActivity.path(owner: owner, part: "library", before: "2026-11-01T10:00:00.000Z|res:auto_1|x")) ?? "refused",
            (try? PhoneActivity.path(owner: owner, part: "activity", before: "nope&x=1")) ?? "refused",
            (try? PhoneActivity.path(owner: owner, part: "proposals", before: nil)) ?? "refused",
            (try? PhoneActivity.path(owner: "agt_../x", part: "activity", before: nil)) ?? "refused",
        ],
        "readable": [
            NativeWorkspace.readable((try? PhoneActivity.path(owner: owner, part: "library", before: "2026-11-01T10:00:00.000Z|res:auto_1|x")) ?? ""),
            NativeWorkspace.readable("/link/api/custom-agents/" + owner + "/activity?before=x&sessionId=y"),
            NativeWorkspace.readable("/link/api/custom-agents/" + owner + "/proposals?before=x"),
        ],
        "activitySignature": [PhoneActivity.signature(snapshot, owner: owner), PhoneActivity.signature(value["streaming"], owner: owner)],
        "paged": [earlyMore, duplicate, staleMore, appended, afterAppend, closedAdopted, paged.rows.isEmpty && !paged.more] as [Any],
        "storeAfterClear": lateResults,
        "reload": [moreDuringReload, moreAfterReload],
        "writes": writeCases(value, proposals: proposals, owner: owner),
        "locations2": value["locationCases"].array.map { item in
            PhoneScheduleProposals.locations(item["catalog"], harness: item["harness"]).map { [$0.id, $0.unavailable ?? "", $0.codeRoot] as [Any] }
        },
        "home": [PhoneAgentChat.home(tasks, session: "run1", owner: owner).rawValue, PhoneAgentChat.home(tasks, session: "generalRun", owner: owner).rawValue,
            PhoneAgentChat.home(tasks, session: "missing", owner: owner).rawValue],
        "fileIds": Set(PhoneResults.parse(value["sameNames"]).first?.files.map(\.id) ?? []).count,
        "takeDown": { () -> [Bool] in
            var proposalStore = PhoneProposalStore(), resultStore = PhoneResultStore()
            let a = proposalStore.begin(owner); proposalStore.finish(owner, token: a, list: value["proposals"], windowOpen: true)
            let b = resultStore.begin(owner); resultStore.finish(owner, token: b, value: results, windowOpen: true)
            let inFlight = resultStore.begin(PhoneAgents.generalId)
            let left = PhoneAgents.takeDown(snapshot, proposals: &proposalStore, results: &resultStore)
            return [proposalStore.isEmpty, resultStore.isEmpty, !resultStore.finish(PhoneAgents.generalId, token: inFlight, value: results, windowOpen: true),
                left["customAgents"] == .null, left["automations"] == .null, left["agentProposals"] == .null, left["agentResults"] == .null, left["tasks"] != .null]
        }(),
        "private": PhoneAgents.withoutPrivate(snapshot)["agentResults"] == .null,
    ]
}

/** Which refusals settle an Agent write, what they say, and what 核对并放下 says, from the Host's own proposals. */
private func writeCases(_ value: NativeJSON, proposals: [PhoneProposal], owner: String) -> [String: Any] {
    guard let schedule = proposals.first(where: { $0.schedule != nil }), let memory = proposals.first(where: { $0.schedule == nil }),
          let create = try? PhoneScheduleProposals.create(owner: owner, proposal: schedule, location: "default", notify: false),
          let run = try? PhoneResults.runNow(automationId: "auto_" + String(repeating: "a", count: 8) + "-aaaa-4aaa-8aaa-" + String(repeating: "a", count: 12)),
          let save = try? PhoneProposals.save(owner: owner, proposalId: memory.id),
          let remember = try? PhoneMemoryWrite.create(owner: owner, text: "x") else { return [:] }
    func refusal(_ code: String, _ message: String = "", replay: Bool = false) -> NativeHostRefusal {
        NativeHostRefusal(status: 409, code: code, message: message, details: .object(replay ? ["replay": .bool(true)] : [:]))
    }
    let decided = refusal("agent-proposal-decided", "这条提议已经保存过了。")
    let limit = refusal("automation-limit", "最多保存 64 个定时任务。")
    // The Host after another request saved it: the proposal is saved and names a schedule.
    let saved = PhoneProposals.parse(value["savedProposals"])
    func outcome(_ write: NativePendingWrite, _ refusal: NativeHostRefusal, _ list: [PhoneProposal]?) -> String {
        switch PhoneAgentWrites.outcome(write, refusal: refusal, proposals: list) {
        case .done: "done"
        case .changed: "changed"
        case let .refused(words): words
        }
    }
    return [
        "handles": [create, run, save, remember].map(PhoneAgentWrites.handles)
            + [PhoneAgentWrites.handles(try! NativePendingWrite(method: .post, path: "/link/api/tasks/ses_1/prompt", fields: ["prompt": .string("x")]))],
        "answered": [PhoneAgentWrites.retryAnswered(create)(decided), PhoneAgentWrites.retryAnswered(save)(decided), PhoneAgentWrites.retryAnswered(run)(decided),
            PhoneAgentWrites.retryAnswered(run)(refusal("automation-busy", replay: true)), PhoneAgentWrites.retryAnswered(create)(limit), PhoneAgentWrites.retryAnswered(remember)(decided)],
        "outcomes": [outcome(create, decided, saved), outcome(create, decided, proposals), outcome(create, decided, nil), outcome(create, limit, nil),
            outcome(run, refusal("automation-changed"), nil), outcome(save, refusal("agent-changed"), nil), outcome(run, refusal("automation-busy"), nil)],
        "check": [PhoneAgentWrites.checkWords(create, proposals: saved), PhoneAgentWrites.checkWords(create, proposals: proposals), PhoneAgentWrites.checkWords(create, proposals: []),
            PhoneAgentWrites.checkWords(save, proposals: proposals), PhoneAgentWrites.checkWords(run, proposals: nil)],
        "words": [PhoneAgentWrites.words(save, proposals: proposals), PhoneAgentWrites.words(try! PhoneProposals.dismiss(owner: owner, proposalId: schedule.id), proposals: proposals),
            PhoneAgentWrites.words(save, proposals: []), PhoneAgentWrites.words(create, proposals: proposals), PhoneAgentWrites.words(run, proposals: [])],
        "owners": [PhoneAgentWrites.owner(create) ?? "", PhoneAgentWrites.decisionOwner(save) ?? "", PhoneAgentWrites.owner(run) ?? ""],
    ]
}

/**
 * 立即运行, its result card in the topic, 打开运行, a schedule proposal saved from the phone, and 动态 and 资料库 from
 * the phone's actual workspace against a real Host: a retry is the same request and answer.
 */
@MainActor func runNativeAgentActivity(_ input: [String: Any]) async throws -> [String: Any] {
    let invitation = try PairingInvitation.parse(input["payload"] as? String ?? "", privateOnly: false), port = try fixturePort(input), keys = try FixtureKeys()
    guard let agentId = input["agentId"] as? String, let automationId = input["automationId"] as? String else { throw NativeFailure.invalidRecord }
    let pairing = try NativePairing(invitation: invitation, keys: keys)
    let temporary = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey)
    _ = try await pairing.begin(on: temporary, name: "Swift activity fixture", gatewayHash: Data(repeating: 0, count: 32))
    var approved = false
    for _ in 0..<60 {
        if let view = try await pairing.status(on: temporary), view.status == "approved" { approved = true; break }
        try await Task.sleep(for: .milliseconds(50))
    }
    guard approved else { throw NativeFailure.unavailable }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-activity-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: invitation.hostId)
    let device = try await pairing.complete(on: temporary) { device in try await vault.storeMetadata(JSONEncoder().encode(device), name: "device") }
    await temporary.close()
    let workspace = try NativeWorkspace(device: device, keys: keys, vault: vault)
    func settle(_ id: String) async throws -> NativeJSON {
        for _ in 0..<300 {
            let detail = try await workspace.detail(id)
            if detail["summary"]["status"].string == "idle" { return detail }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw NativeFailure.unavailable
    }
    do {
        _ = try await workspace.install {
            try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
        }
        // Outside a window none of it is read.
        var windowRequired = false
        do { _ = try await workspace.read(PhoneActivity.path(owner: agentId, part: "activity", before: nil), body: true) } catch { windowRequired = (error as? NativeFailure) == .expired }
        guard windowRequired else { throw NativeFailure.identityMismatch }
        _ = try await workspace.verify()
        let catalog = try await workspace.snapshot()["catalog"]
        guard let agent = try await workspace.snapshot()["customAgents"].array.first(where: { $0["id"].string == agentId }) else { throw NativeFailure.invalidRecord }
        let topicStart = try NativePendingWrite(method: .post, path: "/link/api/tasks",
            fields: PhoneAgents.fields(catalog, agent: agent, choice: PhoneAgents.choice(catalog, agent: agent), prompt: "你好"))
        guard let topic = try await workspace.submit(topicStart)["sessionId"].string else { throw NativeFailure.invalidRecord }
        _ = try await settle(topic)
        // 立即运行 from the phone; the retry of the same request starts nothing more.
        let run = try PhoneResults.runNow(automationId: automationId)
        guard PhonePending.kind(run) == .run(id: automationId) else { throw NativeFailure.invalidRecord }
        _ = try await workspace.submit(run)
        _ = try await workspace.submit(run)
        var results: [PhoneScheduleResult] = []
        for _ in 0..<400 {
            results = PhoneResults.parse(try await workspace.detail(topic)["results"])
            if !results.isEmpty { break }
            try await Task.sleep(for: .milliseconds(25))
        }
        let snapshot = try await workspace.snapshot()
        guard results.count == 1, let card = results.first, card.outcome == "completed", card.reply == "edited", card.topicId == topic, !card.files.isEmpty,
              let runSession = PhoneResults.run(card, tasks: snapshot["tasks"].array),
              PhoneResults.nextStep(card, automations: snapshot["automations"].array, canRun: true, connected: true) == nil,
              snapshot["automations"].array.first(where: { $0["id"].string == automationId })?["lastRun"]["state"].string == "completed" else { throw NativeFailure.invalidRecord }
        // 打开运行: the run's session reads like any session; the retry started no second run.
        guard try await workspace.detail(runSession)["summary"]["automationId"].string == automationId,
              try await workspace.read("/link/api/automations/" + automationId, body: true)["runs"].array.filter({ $0["trigger"].string == "manual" }).count == 1 else { throw NativeFailure.invalidRecord }
        // A schedule proposal in the topic; the phone saves it as a schedule, once.
        _ = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/tasks/" + topic + "/prompt", fields: ["prompt": .string("schedule 早间精选 weekdays 08:30 整理新闻")]))
        _ = try await settle(topic)
        var proposals: [PhoneProposal] = []
        for _ in 0..<100 {
            proposals = PhoneProposals.parse(try await workspace.read("/link/api/custom-agents/" + agentId + "/proposals", body: true))
            if proposals.contains(where: { $0.schedule != nil }) { break }
            try await Task.sleep(for: .milliseconds(25))
        }
        guard let proposal = proposals.first(where: { $0.schedule != nil }), PhoneProposals.pending(proposals).isEmpty,
              PhoneScheduleProposals.line(proposal) == "早间精选 · 工作日 08:30", proposal.sessionId == topic else { throw NativeFailure.invalidRecord }
        let create = try PhoneScheduleProposals.create(owner: agentId, proposal: proposal, location: "default", notify: false)
        guard PhonePending.kind(create) == .scheduleCreate else { throw NativeFailure.invalidRecord }
        // The first try never reaches the Host (the test's listener answers 503): unknown, kept with its request.
        var unknown = false
        do { _ = try await workspace.submit(create, explain: true, retryAnswered: PhoneAgentWrites.retryAnswered(create)) } catch { unknown = (error as? NativeFailure) == .resultUnknown }
        guard unknown, try await workspace.pendingWrites().contains(where: { $0.requestId == create.requestId }) else { throw NativeFailure.invalidRecord }
        // The retry is the same request: the schedule is made once, and a second retry is answered by the receipt.
        let saved = try await workspace.submit(create, explain: true, retryAnswered: PhoneAgentWrites.retryAnswered(create))
        guard let schedule = saved["id"].string, try await workspace.submit(create)["id"].string == schedule,
              try await workspace.pendingWrites().isEmpty else { throw NativeFailure.identityMismatch }
        let after = PhoneProposals.parse(try await workspace.read("/link/api/custom-agents/" + agentId + "/proposals", body: true))
        guard after.first(where: { $0.id == proposal.id })?.state == .saved,
              try await workspace.snapshot()["automations"].array.filter({ $0["customAgentId"].string == agentId }).count == 2 else { throw NativeFailure.invalidRecord }
        // Another request saving it again is refused 409 agent-proposal-decided; the Host's state shows it saved, so a
        // retry that hears this counts as done and 核对并放下 says so.
        let again = try PhoneScheduleProposals.create(owner: agentId, proposal: proposal, location: "default", notify: false)
        var refusal: NativeHostRefusal?
        do { _ = try await workspace.submit(again, explain: true, retryAnswered: PhoneAgentWrites.retryAnswered(again)) } catch { refusal = error as? NativeHostRefusal }
        guard let refusal, refusal.status == 409, refusal.code == "agent-proposal-decided", PhoneAgentWrites.retryAnswered(again)(refusal),
              PhoneAgentWrites.saved(again, proposals: after) == schedule, PhoneAgentWrites.outcome(again, refusal: refusal, proposals: after) == .done,
              PhoneAgentWrites.checkWords(again, proposals: after) == "已保存为定时任务" else { throw NativeFailure.invalidRecord }
        // 动态 and 资料库 through the phone's paths, and a page after the first through the cursor the Host gave.
        let activity = try await workspace.read(PhoneActivity.path(owner: agentId, part: "activity", before: nil), body: true)
        let rows = PhoneActivity.rows(activity)
        guard rows.contains(where: { $0.kind == "result" && $0.target == .session(topic) }), rows.contains(where: { $0.kind == "topic" }),
              rows.contains(where: { $0.lead == "提议定时" && $0.state == "已保存" }) else { throw NativeFailure.invalidRecord }
        let cursor = (activity["items"].array.last?["at"].string ?? "") + "|" + (activity["items"].array.last?["id"].string ?? "")
        let rest = try await workspace.read(PhoneActivity.path(owner: agentId, part: "activity", before: cursor), body: true)
        guard PhoneActivity.rows(rest).isEmpty else { throw NativeFailure.invalidRecord }
        let library = PhoneActivity.groups(try await workspace.read(PhoneActivity.path(owner: agentId, part: "library", before: nil), body: true))
        // A 资料库 file opens through its own session, under that session's file rules.
        guard let group = library.first(where: { $0.sessionId == runSession && $0.run }), let file = group.files.first(where: \.openable) else { throw NativeFailure.invalidRecord }
        let resolved = try await workspace.resolveFile(sessionId: file.sessionId, reference: file.reference, rootId: file.root)
        let meta = resolved["files"].array.first?["file"] ?? .null
        guard resolved["files"].array.first?["status"].string == "ok", let handle = meta["handle"].string, let etag = meta["etag"].string,
              let size = meta["size"].integer, size > 0, size < 65_536 else { throw NativeFailure.invalidRecord }
        let bytes = try await workspace.fileBytes(handle: handle, etag: etag, offset: 0, count: Int(size), explicitOpen: true)
        guard bytes.count == Int(size) else { throw NativeFailure.invalidRecord }
        // The list kept for offline has no cards' counts, and a closed window takes them from the snapshot.
        guard let cached = try await workspace.cachedSnapshot(), cached["agentResults"] == .null, snapshot["agentResults"] != .null,
              PhoneAgents.withoutPrivate(snapshot)["agentResults"] == .null else { throw NativeFailure.storageUnavailable }
        guard try await workspace.pendingWrites().isEmpty else { throw NativeFailure.invalidRecord }
        await workspace.closeOpening(); await vault.lock()
        return ["ranOnce": true, "card": true, "openRun": true, "unknownThenRetry": true, "proposalSaved": true, "decided": true, "activity": true, "library": true, "private": true]
    } catch {
        await workspace.closeOpening(); await vault.lock(); throw error
    }
}
