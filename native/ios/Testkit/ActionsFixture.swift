import Foundation
import LatchNativeCore

/** The session actions as the App derives them from synthetic Host JSON, in plain values to compare. */
func phoneActionsFixture(_ input: [String: Any]) throws -> [String: Any] {
    let value = try NativeJSON.decode(JSONSerialization.data(withJSONObject: input))
    func json(_ value: NativeJSON) -> Any { (try? JSONSerialization.jsonObject(with: value.encoded(), options: .fragmentsAllowed)) ?? NSNull() }
    func write(_ make: () throws -> NativePendingWrite) -> Any {
        guard let write = try? make() else { return "refused" }
        var body = (try? NativeJSON.decode(write.body)) ?? .null
        if case var .object(fields) = body { fields["requestId"] = fields["requestId"] == nil ? nil : .string("<id>"); body = .object(fields) }
        return ["method": write.method, "path": write.path, "body": json(body), "words": PhonePending.words(write)]
    }
    func request(_ make: () throws -> PhoneSessionRequest) -> Any {
        guard let request = try? make() else { return "refused" }
        return ["method": request.method.rawValue, "path": request.path, "body": json(.object(request.fields))]
    }
    let detail = value["detail"]
    let turns = PhoneConversation.turns(detail["messages"].array)
    func actions(_ turn: PhoneTurn, latest: Bool, running: Bool = false, canSend: Bool = true, canFork: Bool = true) -> [String: Any] {
        let found = PhoneTurnActions.of(turn, latest: latest, running: running, canSend: canSend, canFork: canFork)
        return ["copy": found.copy ?? NSNull(), "retry": found.retry?.prompt ?? NSNull(), "warning": found.retry?.warning ?? NSNull(), "fork": found.forkFrom ?? NSNull()]
    }
    let config = value["config"]
    let fork = PhoneForkDraft(taskId: "ses_source", upToMessageId: "m4", title: "源会话", turn: 2)
    let forkChoice = fork.choice(value["catalog"], source: value["forkSource"])
    let forkCatalog = value["forkCatalog"]
    func planned(_ source: NativeJSON, harness: String, picked: PhoneModelChoice? = nil) -> [String: Any] {
        var choice = fork.choice(forkCatalog, source: source["summary"]); choice.harnessId = harness
        if choice.workspaceId == nil && !PhoneStart.acceptsChat(forkCatalog, harnessId: harness) { choice.workspaceId = PhoneStart.projects(forkCatalog).first?.id }
        choice.model = PhoneStart.defaultModel(forkCatalog, harnessId: harness)
        let plan = fork.plan(forkCatalog, source: source, choice: choice, picked: picked)
        var fields = fork.fields(forkCatalog, plan: plan, prompt: "x"); fields.removeValue(forKey: "forkOf"); fields.removeValue(forKey: "prompt")
        return ["missed": plan.missed, "fields": json(.object(fields)), "rows": [plan.forwarded?.model ?? plan.choice.model?.model ?? "", plan.thinkingWords ?? "", plan.pick(.permission)?.name ?? ""]]
    }
    var stops = PhoneSubagentStops()
    var stopTrace: [[String]] = []
    _ = stops.begin("s1"); _ = stops.begin("s2"); _ = stops.begin("s3"); _ = stops.begin("s4")
    stopTrace.append(stops.requested.sorted())
    stops.answered("s2", ok: false)
    stopTrace.append(stops.requested.sorted())
    stops.observe(value["stopsDetail"])
    stopTrace.append(stops.requested.sorted())
    let startCatalog = value["startCatalog"]
    var setupCatalog = startCatalog.object
    setupCatalog["defaults"] = value["setupDefaults"]
    let prepared = NativeJSON.object(setupCatalog)
    let preparedStart = PhoneStart.defaults(prepared)
    let ordinary = PhoneStart.defaults(startCatalog)
    var changed = setupCatalog
    changed["defaults"] = .object(value["setupDefaults"].object.merging([
        "gateway": .object(["providerId": .string("p"), "model": .string("m2")]),
    ]) { _, picked in picked })
    var projectCatalog = setupCatalog
    projectCatalog["workspaces"] = .array([.object([
        "id": .string("latch"), "name": .string("latch"),
        "defaultModel": .object(["providerId": .string("p"), "model": .string("m2")]),
    ])])
    let handoff = try PhoneHandoffs.create(sourceSessionId: "ses_source", materials: [], requirements: "x", returnScope: "summary",
        newSession: (nil, "codex", PhoneStart.defaultModel(prepared, harnessId: "codex")), sessionId: nil)
    let search = PhoneSearch.results(value["search"])
    func controls(_ detail: NativeJSON) -> [[String: Any]] {
        PhoneSessionConfig.controls(detail, harness: value["harness"]).map { control -> [String: Any] in
            var result: [String: Any] = ["kind": control.kind.rawValue, "id": control.configId, "label": control.label, "amber": control.amber,
                "rows": control.rows.map { "\($0.name)\($0.current ? "*" : "")\($0.more ? "+" : "")" }]
            if let source = control.source { result["source"] = source.rawValue; result["note"] = control.note; result["noteDetail"] = control.noteDetail }
            return result
        }
    }
    return [
        "subagents": value["subagents"].array.map { entry -> Any in
            guard let row = PhoneSubagents.row(entry["message"], requested: entry["requested"].bool, canStop: entry["canStop"].bool) else { return NSNull() }
            return ["id": row.id, "title": row.title, "status": row.status ?? NSNull(), "canStop": row.canStop, "stopping": row.stopping, "waiting": row.waiting, "steps": row.steps.count]
        },
        "turnActions": turns.enumerated().map { index, turn in actions(turn, latest: index == turns.count - 1) },
        "latestRunning": turns.last.map { actions($0, latest: true, running: true) } ?? NSNull(),
        "readOnly": turns.last.map { actions($0, latest: true, canSend: false, canFork: false) } ?? NSNull(),
        "resend": value["resend"].array.map { PhoneTurnActions.resendText($0) },
        "followUp": value["followUps"].array.map { "\(PhoneFollowUp.of(detail: $0["detail"], status: $0["status"].string, queues: $0["queues"].bool))" },
        "controls": controls(config),
        "launchControls": value["launchConfigs"].array.map(controls),
        "chatControls": PhoneSessionConfig.controls(.object(["config": config["config"], "summary": .object(["mode": .string("chat"), "level": .string("L3")])]), harness: value["harness"]).map(\.kind.rawValue),
        "configWrites": [
            write { try PhoneSessionConfig.write(sessionId: "ses_1", configId: "model", value: "large", detail: config) },
            write { try PhoneSessionConfig.write(sessionId: "ses_1", configId: "model", value: "small", detail: config) },
            write { try PhoneSessionConfig.write(sessionId: "ses_1", configId: "model", value: "huge", detail: config) },
            write { try PhoneSessionConfig.write(sessionId: "ses_1", configId: "missing", value: "x", detail: config) },
            write { try PhoneSessionConfig.write(sessionId: "../x", configId: "model", value: "large", detail: config) },
            write { try PhoneSessionConfig.write(sessionId: "ses_1", configId: "mode", value: "yolo", detail: config) },
            write { try PhoneSessionConfig.write(sessionId: "ses_1", configId: "mode", value: "not-offered", detail: config) },
            write { try PhoneSessionConfig.write(sessionId: "ses_1", configId: "thinking", value: "high", detail: value["launchConfigs"].array.first ?? .null) },
        ],
        "menus": value["menuTasks"].array.map { task in
            PhoneSessionMenu.sections(task, canRun: true, clear: (task["offered"].bool, task["clearing"].bool)).map { section in
                section.map { $0.label + ($0.disabledReason.map { "（" + $0 + "）" } ?? "") }
            }
        },
        "noRunMenu": PhoneSessionMenu.sections(value["menuTasks"].array.first ?? .null, canRun: false).count,
        "listMenu": PhoneSessionMenu.sections(value["menuTasks"].array.first ?? .null, canRun: true).flatMap { $0.map(\.label) },
        "deleteQuestion": [PhoneSessionMenu.deleteQuestion(.object(["title": .string("修 relay")])), PhoneSessionMenu.deleteQuestion(.object(["title": .string("  ")]))],
        "sessionWrites": [
            request { try PhoneSessionWrite.rename("ses_1", title: "  新名字  ") },
            request { try PhoneSessionWrite.rename("ses_1", title: "   ") },
            request { try PhoneSessionWrite.rename("ses_1", title: String(repeating: "长", count: 120)) },
            request { try PhoneSessionWrite.rename("ses_1", title: String(repeating: "😀", count: 61)) },
            request { try PhoneSessionWrite.pin("ses_1", pinned: true) },
            request { try PhoneSessionWrite.archive("ses_1", archived: false) },
            request { try PhoneSessionWrite.remove("ses_1") },
            request { try PhoneSessionWrite.remove("ses/../x") },
        ],
        "fork": ["origin": fork.origin, "harness": forkChoice.harnessId ?? "", "workspace": forkChoice.workspaceId ?? "", "model": forkChoice.model?.model ?? "",
                 "fields": json(.object(fork.fields(value["catalog"], plan: fork.plan(value["catalog"], source: .object(["summary": value["forkSource"]]), choice: forkChoice), prompt: PhoneForkDraft.prompt))),
                 "words": write { try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: fork.fields(value["catalog"], plan: PhoneForkPlan(choice: forkChoice), prompt: "x")) },
                 "from": PhoneForkDraft.origin(value["forked"]).map { [$0.taskId, $0.words] } ?? []],
        "plans": [
            "same": planned(value["agentSource"], harness: "codex"),
            "other": planned(value["agentSource"], harness: "other"),
            "unread": planned(value["agentSource"], harness: "unread"),
            "routed": planned(value["routedSource"], harness: "codex"),
            "routedElsewhere": planned(value["routedSource"], harness: "other"),
            "builtin": planned(value["builtinSource"], harness: "standard"),
            "builtinPicked": planned(value["builtinSource"], harness: "standard", picked: PhoneModelChoice(providerId: "p", providerName: "P", model: "m1")),
            "builtinToAgent": planned(value["builtinSource"], harness: "codex"),
            "fromChat": planned(value["chatSource"], harness: "codex"),
        ],
        "starts": ["codex", "standard"].map { id -> Any in
            var choice = PhoneStart.defaults(startCatalog); choice.harnessId = id
            choice.model = PhoneStart.defaultModel(startCatalog, harnessId: id)
            var forced = choice; forced.model = PhoneModelChoice(providerId: "p", providerName: "P", model: "m2")
            return ["default": choice.model?.model ?? "", "fields": json(PhoneStart.fields(startCatalog, choice: choice, prompt: "x")["model"] ?? .null),
                    "forced": json(PhoneStart.fields(startCatalog, choice: forced, prompt: "x")["model"] ?? .null)]
        },
        "startDefault": PhoneStart.defaults(startCatalog).model?.model ?? "",
        "preparedStart": json(PhoneStart.newSessionFields(prepared, choice: preparedStart, prompt: "x")["model"] ?? .null),
        "preparedBuiltIn": PhoneStart.defaultModel(prepared, harnessId: "standard")?.model ?? "",
        "preparedThenOwn": json(PhoneStart.newSessionFields(startCatalog, choice: preparedStart, prompt: "x")["model"] ?? .null),
        "preparedThenChanged": json(PhoneStart.newSessionFields(.object(changed), choice: preparedStart, prompt: "x")["model"] ?? .null),
        "ownThenPrepared": json(.object(PhoneStart.newSessionFields(prepared, choice: ordinary, prompt: "x"))),
        "projectBeforePrepared": PhoneStart.defaults(.object(projectCatalog)).model?.model ?? "",
        "preparedHandoff": json(try NativeJSON.decode(handoff.body)["target"]),
        "stops": stopTrace,
        "search": ["hits": search.hits.map { [$0.sessionId, $0.title, $0.before, $0.match, $0.after, $0.archived ? "archived" : ""] }, "truncated": search.truncated],
        "queries": ["  relay ", "", "   ", String(repeating: "q", count: 201)].map { PhoneSearch.query($0) ?? "" },
        "archived": PhoneSessions.archived(value["tasks"].array).compactMap { $0["id"].string },
        "archivedFound": PhoneSessions.archived(value["tasks"].array, query: "Relay").compactMap { $0["id"].string },
        "approvals": value["approvals"].array.map { approval -> [String: Any] in
            let gate = PhoneConversation.approvalGate(approval, canApproveStandard: approval["standard"].bool, canApproveElevated: approval["elevated"].bool, canRun: true)
            return ["allow": gate.canAllow ? gate.allowLabel : "", "option": gate.allowOption ?? "", "more": gate.more.map { "\($0.id):\($0.label):\($0.allows)" },
                    "hidden": gate.hidden, "places": approval["tool"]["locations"].array.compactMap(\.string).map(PhoneConversation.visible)]
        },
    ]
}

/** The App's own stop and search flows, driven with answers the test chooses. */
@MainActor func phoneFlowsFixture() async throws -> [String: Any] {
    // 停止: a refused stop clears the mark, an answered one keeps it for the Host to settle, a second press sends nothing.
    var stops = PhoneSubagentStops()
    var sent = 0
    func stop(_ id: String, current: Bool = true, fails: Bool) async -> String {
        let outcome = await PhoneSubagentStops.run(id, get: { stops }, set: { stops = $0 }, current: { current }) {
            sent += 1
            if fails { throw NativeFailure.notStoppable }
        }
        switch outcome { case .none: return "not sent"; case .success?: return "ok"; case .failure?: return "failed" }
    }
    var stopTrace: [String] = []
    stopTrace.append(await stop("a", fails: true) + ":" + stops.requested.sorted().joined())
    stopTrace.append(await stop("b", fails: false) + ":" + stops.requested.sorted().joined())
    stopTrace.append(await stop("b", fails: false) + ":" + stops.requested.sorted().joined())
    stopTrace.append(await stop("c", current: false, fails: true) + ":" + stops.requested.sorted().joined())
    // 内容中包含: an earlier query's hits never show under a new one, even when every try finds the Host busy.
    func hit(_ id: String) -> NativeJSON {
        .object(["sessionId": .string(id), "messageId": .string("m"), "title": .string(id), "snippet": .string("relay"), "match": .object(["start": .number(0), "end": .number(5)])])
    }
    let old = PhoneContentSearch(query: "relay", hits: PhoneSearch.results(.object(["hits": .array([hit("old")])])).hits)
    func search(_ query: String, previous: PhoneContentSearch, answers: [NativeJSON?]) async throws -> [String: Any] {
        var shown: [PhoneContentSearch] = [], asked = 0, paused = 0
        try await PhoneSearchRun.run(query, previous: previous, search: {
            let answer = asked < answers.count ? answers[asked] : nil; asked += 1
            guard let answer else { throw NativeFailure.busy }
            return answer
        }, pause: { paused += 1 }) { state in shown.append(state); return true }
        let last = shown.last ?? PhoneContentSearch()
        return ["loadingHits": shown.first?.hits.map(\.sessionId) ?? [], "hits": last.hits.map(\.sessionId), "error": last.error ?? "", "asked": asked, "paused": paused, "loading": last.loading]
    }
    return [
        "stops": stopTrace, "sent": sent,
        "busyOther": try await search("tests", previous: old, answers: []),
        "busySame": try await search("relay", previous: old, answers: []),
        "afterBusy": try await search("tests", previous: old, answers: [nil, .object(["hits": .array([hit("new")])])]),
    ]
}

/**
 * The session actions from the phone's actual workspace against a real Host with the fake ACP agent: stop a subagent,
 * 更多's choice, 追加, retry, fork, a setting mid-session, 清空上下文, rename, pin, archive, delete and 内容中包含.
 */
@MainActor func runNativeActions(_ input: [String: Any]) async throws -> [String: Any] {
    let invitation = try PairingInvitation.parse(input["payload"] as? String ?? "", privateOnly: false), port = try fixturePort(input), keys = try FixtureKeys()
    let pairing = try NativePairing(invitation: invitation, keys: keys)
    let temporary = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey)
    _ = try await pairing.begin(on: temporary, name: "Swift actions fixture", gatewayHash: Data(repeating: 0, count: 32))
    var approved = false
    for _ in 0..<60 {
        if let view = try await pairing.status(on: temporary), view.status == "approved" { approved = true; break }
        try await Task.sleep(for: .milliseconds(50))
    }
    guard approved else { throw NativeFailure.unavailable }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-actions-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: invitation.hostId)
    let device = try await pairing.complete(on: temporary) { device in try await vault.storeMetadata(JSONEncoder().encode(device), name: "device") }
    await temporary.close()
    let workspace = try NativeWorkspace(device: device, keys: keys, vault: vault)
    var stage = "start"
    func check(_ ok: Bool, _ name: String) throws { if !ok { throw FixtureStage(name: name) } }
    func poll(_ id: String, _ done: (NativeJSON) -> Bool) async throws -> NativeJSON {
        for _ in 0..<300 {
            let detail = try await workspace.detail(id)
            if done(detail) { return detail }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw FixtureStage(name: "poll " + stage)
    }
    func settled(_ id: String) async throws -> NativeJSON {
        try await poll(id) { $0["summary"]["status"].string == "idle" }
    }
    var catalog = NativeJSON.null
    // A plain new session on the fake ACP Harness, as the sheet builds it: that Harness chooses its own model, so none is sent.
    func start(_ prompt: String) async throws -> String {
        var choice = PhoneStart.defaults(catalog); choice.harnessId = "fake"; choice.model = PhoneStart.defaultModel(catalog, harnessId: "fake")
        let fields = PhoneStart.fields(catalog, choice: choice, prompt: prompt)
        try check(fields["model"] == nil && choice.model == nil, "no model")
        guard let id = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/tasks", fields: fields))["sessionId"].string else { throw FixtureStage(name: "start " + prompt) }
        return id
    }
    do {
        _ = try await workspace.install {
            try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
        }
        // Content stays behind the window: no search and no stop before one opens.
        stage = "window"
        var closed = 0
        do { _ = try await workspace.search("anything") } catch { if (error as? NativeFailure) == .expired { closed += 1 } }
        do { _ = try await workspace.stopSubagent(sessionId: "ses_none", subagentId: "row") } catch { if (error as? NativeFailure) == .expired { closed += 1 } }
        try check(closed == 2, "window")
        _ = try await workspace.verify()
        let snapshot = try await workspace.snapshot()
        catalog = snapshot["catalog"]
        // The Host's own default model is a service's; a Harness with its own models is never given it.
        try check(PhoneStart.defaultModel(catalog, harnessId: "fake") == nil, "fake default model")
        try check(snapshot["catalog"]["features"]["fork"].bool && snapshot["catalog"]["features"]["search"].bool, "features")

        // 停止 one subagent alone; a second stop is the Host's own refusal.
        stage = "subagent"
        let delegating = try await start("delegate stop")
        // Waits for the fake Agent's own permission request too, so the gate below is always checked.
        let waiting = try await poll(delegating) { detail in
            detail["messages"].array.contains { $0["subagent"]["stoppable"].bool } && !detail["approvals"].array.isEmpty
        }
        guard let message = waiting["messages"].array.first(where: { $0["subagent"]["stoppable"].bool }),
              let row = PhoneSubagents.row(message, requested: false, canStop: true), row.canStop else { throw FixtureStage(name: "row") }
        // Its ask is an agent's: only reject or allow once, nothing under 更多.
        let approval = waiting["approvals"].array[0]
        let gate = PhoneConversation.approvalGate(approval, canApproveStandard: true, canApproveElevated: true, canRun: true)
        try check(approval["advisory"].bool && gate.canAllow && gate.more.isEmpty && gate.allowLabel == "允许" && !gate.hidden, "advisory gate")
        // A stop the Host refuses clears this phone's 正在停止… at once.
        var stops = PhoneSubagentStops(), during = false
        let outcome = await PhoneSubagentStops.run(row.id, get: { stops }, set: { stops = $0 }, current: { true }) {
            during = PhoneSubagents.row(message, requested: stops.contains(row.id), canStop: true)?.stopping == true
            _ = try await workspace.stopSubagent(sessionId: delegating, subagentId: "not-a-row")
        }
        guard case .failure? = outcome else { throw FixtureStage(name: "refused stop") }
        try check(during && !stops.contains(row.id) && PhoneSubagents.row(message, requested: stops.contains(row.id), canStop: true)?.stopping == false, "cleared on error")
        _ = try await workspace.stopSubagent(sessionId: delegating, subagentId: row.id)
        let stopped = try await poll(delegating) { detail in
            detail["messages"].array.contains { $0["id"].string == row.id && $0["subagent"]["status"].string == "cancelled" }
        }
        try check(PhoneSubagents.row(stopped["messages"].array.first { $0["id"].string == row.id } ?? .null, requested: true, canStop: true)?.canStop == false, "stopped row")
        var refused = false
        do { _ = try await workspace.stopSubagent(sessionId: delegating, subagentId: row.id) } catch { refused = (error as? NativeFailure) == .notStoppable }
        try check(refused, "second stop")
        _ = try await settled(delegating)

        // 追加: into the running turn, where the Harness takes it; the same request again is the same answer.
        stage = "steer"
        let steering = try await start("steerable")
        let running = try await poll(steering) { $0["steer"].bool }
        try check(PhoneFollowUp.of(detail: running, status: running["summary"]["status"].string, queues: true) == .steer, "follow-up")
        let steer = try NativePendingWrite(method: .post, path: "/link/api/tasks/\(steering)/prompt", fields: ["prompt": .string("check the tests too"), "steer": .bool(true)])
        try check(try await workspace.submit(steer)["steered"].bool, "steered")
        try check(try await workspace.submit(steer)["steered"].bool, "steered again")
        let steered = try await settled(steering)
        try check(steered["messages"].array.filter { $0["steered"].bool }.compactMap { $0["text"].string } == ["check the tests too"], "steered once")

        // 重试 sends the person's words again as a new turn; 复制 takes the turn's prose.
        stage = "retry"
        stage = "queued steering and order"
        let queuedSession = try await start("steerable")
        let active = try await poll(queuedSession) { $0["steer"].bool }
        guard let run = active["summary"]["runId"].string else { throw FixtureStage(name: "queue run") }
        let inputs = ["echo queue first", "echo queue second", "check the running turn"]
        for input in inputs {
            _ = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/tasks/\(queuedSession)/prompt",
                fields: ["prompt": .string(input), "queue": .bool(true)]))
        }
        let initial = try await poll(queuedSession) { $0["queue"].array.count == inputs.count }
        let rows = initial["queue"].array, ids = rows.compactMap { $0["id"].string }
        try check(ids.count == 3 && rows.allSatisfy { $0["canSteer"].bool }, "queue eligibility")
        let order = [ids[1], ids[0], ids[2]]
        let sort = try PhoneQueueControl.reorder(session: queuedSession, revision: rows.first?["orderRevision"].integer ?? 0, base: ids, order: order)
        try check(try await workspace.submit(sort)["ordered"].bool, "reorder")
        try check(try await workspace.submit(sort)["ordered"].bool, "same order")
        _ = try await poll(queuedSession) { $0["queue"].array.compactMap { $0["id"].string } == order }
        let oldText = try PhoneQueueControl.steer(session: queuedSession, item: ids[2], run: run, contentRevision: rows[2]["contentRevision"].integer ?? 0)
        let edited = "also check the fixtures"
        _ = try await workspace.submit(NativePendingWrite(method: .patch, path: "/link/api/tasks/\(queuedSession)/queue/\(ids[2])", fields: ["text": .string(edited)]))
        let revised = try await poll(queuedSession) { $0["queue"].array.last?["text"].string == edited }
        var stale = false
        do { _ = try await workspace.submit(oldText) } catch NativeFailure.changedElsewhere { stale = true }
        try check(stale, "changed queued text")
        guard let revision = revised["queue"].array.last?["contentRevision"].integer, revision > 0 else { throw FixtureStage(name: "queue content revision") }
        let take = try PhoneQueueControl.steer(session: queuedSession, item: ids[2], run: run, contentRevision: revision)
        try check(try await workspace.submit(take)["steered"].bool, "steer selected")
        try check(try await workspace.submit(take)["steered"].bool, "steer selected once")
        let drained = try await poll(queuedSession) { $0["summary"]["status"].string == "idle" && $0["messages"].array.last?["text"].string == "echo: echo queue first" }
        try check(drained["queue"].array.isEmpty && drained["messages"].array.filter { $0["role"].string == "user" }.compactMap { $0["text"].string } ==
            ["steerable", edited, inputs[1], inputs[0]], "queue dispatch order")
        try check(drained["messages"].array.filter { $0["steered"].bool }.compactMap { $0["text"].string } == [edited], "one selected steer")
        _ = try await workspace.sessionAction(PhoneSessionWrite.remove(queuedSession))
        let turns = PhoneConversation.turns(steered["messages"].array)
        guard let last = turns.last else { throw FixtureStage(name: "turns") }
        let offered = PhoneTurnActions.of(last, latest: true, running: false, canSend: true, canFork: true)
        guard let retry = offered.retry, retry.prompt == "steerable", let end = offered.forkFrom, offered.copy?.contains("steered") == true else { throw FixtureStage(name: "offered") }
        _ = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/tasks/\(steering)/prompt", fields: ["prompt": .string("echo again")]))
        let resent = try await poll(steering) { $0["summary"]["status"].string == "idle" && $0["messages"].array.last?["text"].string == "echo: echo again" }

        // 从这里分叉: a new session up to that turn; the same request again answers with the same session.
        stage = "fork"
        let draft = PhoneForkDraft(taskId: steering, upToMessageId: end, title: resent["summary"]["title"].string ?? "", turn: turns.count)
        let choice = draft.choice(try await workspace.snapshot()["catalog"], source: resent["summary"])
        try check(choice.harnessId == "fake", "fork harness")
        // The source's own model and mode go with the fork, read from what the same Harness offers.
        let forkCatalog = try await workspace.snapshot()["catalog"]
        let plan = draft.plan(forkCatalog, source: resent, choice: choice)
        let sourceModel = PhoneSessionConfig.controls(resent, harness: .null).first { $0.kind == .model }?.rows.first(where: \.current)?.value
        try check(plan.missed.isEmpty && plan.pick(.model)?.value == sourceModel && sourceModel != nil, "fork plan")
        let forkFields = draft.fields(forkCatalog, plan: plan, prompt: PhoneForkDraft.prompt)
        try check(forkFields["model"] == nil && !(forkFields["config"]?.array ?? []).isEmpty, "fork fields")
        let forking = try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: forkFields)
        let forkedAnswer: NativeJSON
        do { forkedAnswer = try await workspace.submit(forking) } catch { throw FixtureStage(name: "fork " + (String(data: forking.body, encoding: .utf8) ?? "")) }
        guard let forked = forkedAnswer["sessionId"].string else { throw FixtureStage(name: "forked") }
        try check(try await workspace.submit(forking)["sessionId"].string == forked, "same fork")
        let child = try await settled(forked)
        try check(PhoneForkDraft.origin(child["summary"])?.taskId == steering && child["summary"]["forkOf"]["upToMessageId"].string == end, "fork origin")
        try check(PhoneSessionConfig.controls(child, harness: .null).first { $0.kind == .model }?.rows.first(where: \.current)?.value == sourceModel, "fork kept model")

        // A setting mid-session: sent with its requestId and read back; the same request again is answered alike.
        stage = "config"
        guard let model = PhoneSessionConfig.controls(child, harness: .null).first(where: { $0.kind == .model }),
              let other = model.rows.first(where: { !$0.current }) else { throw FixtureStage(name: "model control") }
        let change = try PhoneSessionConfig.write(sessionId: forked, configId: model.configId, value: other.value, detail: child)
        try check(PhonePending.words(change) == "切换结果待确认", "config words")
        _ = try await workspace.submit(change)
        _ = try await workspace.submit(change)
        let changed = try await workspace.detail(forked)
        try check(PhoneSessionConfig.controls(changed, harness: .null).first { $0.kind == .model }?.rows.first(where: \.current)?.value == other.value, "read back")

        // 清空上下文: the next message carries it, and the Host draws the line above that turn.
        stage = "clear"
        try check(changed["clearContext"].bool, "offered")
        _ = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/tasks/\(forked)/prompt", fields: ["prompt": .string("fresh start"), "freshContext": .bool(true)]))
        let fresh = try await settled(forked)
        try check(PhoneConversation.turns(fresh["messages"].array).last.flatMap { PhoneConversation.divider($0) } == "清空了上下文", "divider")

        // 内容中包含: hits only from inside the window, never kept for the offline list.
        stage = "search"
        let found = PhoneSearch.results(try await workspace.search("check the tests too"))
        try check(found.hits.contains { $0.sessionId == steering && $0.match == "check the tests too" }, "hits")
        _ = try await workspace.snapshot()
        // The steered words appear in no title, so finding them in what is stored unencrypted would be the hits.
        guard let stored = try await vault.metadata(name: "snapshot") else { throw FixtureStage(name: "stored list") }
        try check(!String(decoding: stored, as: UTF8.self).contains("check the tests"), "hits not cached")

        // The session menu as the web sends it: plain requests, nothing kept to replay, the list read again for the truth.
        stage = "menu"
        _ = try await workspace.sessionAction(PhoneSessionWrite.rename(forked, title: "  分叉出来的  "))
        _ = try await workspace.sessionAction(PhoneSessionWrite.pin(forked, pinned: true))
        _ = try await workspace.sessionAction(PhoneSessionWrite.archive(forked, archived: true))
        var listed = try await workspace.snapshot()
        let row1 = listed["tasks"].array.first { $0["id"].string == forked } ?? .null
        try check(row1["title"].string == "分叉出来的" && row1["pinned"].bool && row1["archived"].bool, "patched")
        try check(PhoneSessions.archived(listed["tasks"].array).compactMap { $0["id"].string } == [forked], "archived list")
        try check(!PhoneSessions.shelves(tasks: listed["tasks"].array, workspaces: []).flatMap(\.tasks).contains { $0["id"].string == forked }, "off the shelves")
        guard let cached = try await workspace.cachedSnapshot() else { throw FixtureStage(name: "cache") }
        try check(cached["tasks"].array.contains { $0["id"].string == forked && $0["archived"].bool }, "cache")
        _ = try await workspace.sessionAction(PhoneSessionWrite.archive(forked, archived: false))
        _ = try await workspace.sessionAction(PhoneSessionWrite.remove(forked))
        // A refused action keeps nothing to replay; the list read again shows what is true.
        var refusedAction = false
        do { _ = try await workspace.sessionAction(PhoneSessionWrite.pin(forked, pinned: false)) } catch { refusedAction = (error as? NativeFailure) != .resultUnknown }
        listed = try await workspace.snapshot()
        let left = try await workspace.pendingWrites()
        try check(refusedAction && !listed["tasks"].array.contains { $0["id"].string == forked } && left.isEmpty, "refused action")
        for id in [delegating, steering] { _ = try await workspace.sessionAction(PhoneSessionWrite.remove(id)) }
        await workspace.closeOpening(); await vault.lock()
        return ["window": true, "subagent": true, "steer": true, "queueControl": true, "retry": true, "fork": true, "config": true, "clear": true, "search": true, "menu": true]
    } catch {
        await workspace.closeOpening(); await vault.lock()
        if let failed = error as? FixtureStage { throw failed }
        throw FixtureStage(name: stage + ": \(error)")
    }
}

struct FixtureStage: Error, CustomStringConvertible { let name: String; var description: String { "stage " + name } }
