import Foundation
import LatchNativeCore

/** The review, 提交, editing, handoff and notice decisions as the App derives them, in plain values to compare. */
func phoneReviewFixture(_ input: [String: Any]) throws -> [String: Any] {
    let value = try NativeJSON.decode(JSONSerialization.data(withJSONObject: input))
    func json(_ value: NativeJSON) -> Any { (try? JSONSerialization.jsonObject(with: value.encoded(), options: .fragmentsAllowed)) ?? NSNull() }
    func write(_ make: () throws -> NativePendingWrite) -> Any {
        guard let write = try? make() else { return "refused" }
        var body = (try? NativeJSON.decode(write.body)) ?? .null
        if case var .object(fields) = body { fields["requestId"] = fields["requestId"] == nil ? nil : .string("<id>"); body = .object(fields) }
        return ["method": write.method, "path": write.path, "body": json(body)]
    }
    let snapshot = value["snapshot"]
    var seen = PhoneSeen(baseline: "2026-11-01T10:00:00.000Z", seen: ["ses_old": "2026-11-01T11:00:00.000Z"])
    let unreadBefore = snapshot["tasks"].array.filter { seen.unread($0) }.compactMap { $0["id"].string }
    seen = seen.marking("ses_new", updatedAt: "2026-11-01T12:00:00.000Z") ?? seen
    let candidates = PhoneReview.candidates(snapshot) { seen.unread($0) }.compactMap { $0["id"].string }
    let shortcuts = value["shortcuts"].array.map { entry -> Any in
        PhoneReview.shortcut(entry["task"], unread: entry["unread"].bool, turns: entry["turns"] == .null ? nil : entry["turns"].array, counts: entry["counts"]) ?? NSNull()
    }
    // Lines: a tap picks, the next stretches (at most 100), the only picked line tapped again lets go.
    func line(_ kind: PhoneReviewLine.Kind, _ old: Int?, _ new: Int?, _ text: String = "x") -> PhoneReviewLine { PhoneReviewLine(kind: kind, text: text, oldLine: old, newLine: new) }
    func pick(_ selection: PhoneLineSelection?) -> Any { selection.map { [$0.side.rawValue, $0.start, $0.end, $0.anchor, $0.label] as [Any] } ?? NSNull() }
    var trace: [Any] = []
    var selection = PhoneReview.tap(nil, line(.context, 4, 5))
    trace.append(pick(selection))
    selection = PhoneReview.tap(selection, line(.add, nil, 9))
    trace.append(pick(selection))
    selection = PhoneReview.tap(selection, line(.add, nil, 400))
    trace.append(pick(selection))
    let single = PhoneReview.tap(nil, line(.remove, 7, nil))
    trace.append(pick(single))
    trace.append(pick(PhoneReview.tap(single, line(.remove, 7, nil))))
    // A removed line picked, then an added one: no number on the old side, so a fresh pick.
    trace.append(pick(PhoneReview.tap(single, line(.add, nil, 3))))
    // Where notes sit: exact, moved, stale (two copies, thin, gone).
    let current = value["current"].array.compactMap(\.string)
    func located(_ entry: NativeJSON) -> String {
        switch PhoneReview.locate(start: Int(entry["start"].integer ?? 1), end: Int(entry["end"].integer ?? 1), lines: entry["lines"].array.compactMap(\.string), current: current) {
        case let .exact(a, b): "exact \(a)-\(b)"
        case let .moved(a, b): "moved \(a)-\(b)"
        case .stale: "stale"
        }
    }
    let diffLines = PhoneReview.lines(value["fileDetail"])
    let notes = PhoneReview.notes(value["notes"])
    let placed = PhoneReview.place(notes, old: PhoneReview.textLines(diffLines, side: .old), new: PhoneReview.textLines(diffLines, side: .new))
    let segments = PhoneReview.segments(diffLines) { placed.noted($0, notes: notes) }.map { segment -> String in
        switch segment { case let .lines(lines): "lines \(lines.count)"; case let .gap(lines): "gap \(lines.count)" }
    }
    let tally = PhoneReview.tally(notes)
    func foot(_ selection: PhoneLineSelection? = nil, running: Bool = false, canQueue: Bool = true, offline: Bool = false, unknown: Bool = false, canWrite: Bool = true, canDeliver: Bool = true, tally: PhoneNoteTally? = nil) -> String {
        "\(PhoneReview.foot(tally: tally ?? PhoneReview.tally(notes), selection: selection, running: running, canQueue: canQueue, offline: offline, unknownSend: unknown, canWrite: canWrite, canDeliver: canDeliver))"
    }
    let none = PhoneNoteTally(ready: [], sending: 0, queued: 0, sent: 0, toReview: 0)
    let picked = PhoneLineSelection(side: .new, start: 2, end: 3, anchor: 2)
    // 提交.
    let git = PhoneGitState(value["git"])!
    let committedGit = PhoneGitState(value["gitClean"])!
    return [
        "unreadBefore": unreadBefore, "candidates": candidates, "shortcuts": shortcuts,
        "seenAgain": seen.marking("ses_new", updatedAt: "2026-11-01T11:59:00.000Z") == nil,
        "readsTurns": [PhoneReview.readsTurns(snapshot), PhoneReview.readsTurns(.object(["catalog": snapshot["catalog"], "device": .object(["dataScope": .string("work")])]))],
        "taps": trace,
        "located": value["locate"].array.map(located),
        "placed": ["under": placed.under.keys.sorted(), "stale": placed.stale.map(\.id)],
        "segments": segments,
        "cards": notes.map { "\($0.id):\($0.word):\($0.canEdit)" },
        "tally": [tally.ready, tally.sending, tally.queued, tally.sent, tally.toReview] as [Any],
        "open": PhoneReview.openSend(value["notes"]).map { [$0.id] + $0.noteIds } ?? [],
        "feet": [foot(picked), foot(), foot(running: true), foot(running: true, canQueue: false), foot(offline: true), foot(unknown: true),
                 foot(tally: none), foot(running: true, tally: PhoneNoteTally(ready: [], sending: 0, queued: 0, sent: 2, toReview: 2)), foot(canDeliver: false, tally: none),
                 foot(picked, canWrite: false, tally: none)],
        "files": PhoneReview.files(value["list"]).compactMap { $0["path"].string },
        "fileNotes": PhoneReview.files(value["list"]).map { PhoneReview.fileNote($0) ?? "" },
        "empty": value["empties"].array.map { PhoneReview.empty($0).map { [$0.title, $0.detail ?? ""] } ?? [] },
        "paths": [
            (try? PhoneReview.listPath("ses_1", scope: .uncommitted)) ?? "",
            (try? PhoneReview.filePath("ses_1", scope: .turn, turnId: "t 1", root: "default", path: "src/a b&c.ts")) ?? "",
            (try? PhoneReview.turnsPath("ses/../x")) ?? "refused",
        ],
        "noteWrites": [
            write { try PhoneReview.create(sessionId: "ses_1", root: "default", path: "a.ts", selection: picked, scope: .turn, turnId: "turn_1", lines: ["two", "three"], text: "  这里不对 ") },
            write { try PhoneReview.create(sessionId: "ses_1", root: "default", path: "a.ts", selection: picked, scope: .turn, turnId: nil, lines: ["two"], text: "x") },
            write { try PhoneReview.create(sessionId: "ses_1", root: "default", path: "a.ts", selection: picked, scope: .turn, turnId: nil, lines: ["two", "three"], text: "   ") },
            write { try PhoneReview.edit(sessionId: "ses_1", noteId: "n1", text: "改") },
            write { try PhoneReview.status(sessionId: "ses_1", noteId: "n1", status: .reviewed) },
            write { try PhoneReview.status(sessionId: "ses_1", noteId: "n1", status: .pending) },
            write { try PhoneReview.remove(sessionId: "ses_1", noteId: "n1") },
            write { try PhoneReview.send(sessionId: "ses_1", noteIds: ["n1", "n2"], queue: true) },
            write { try PhoneReview.send(sessionId: "ses_1", noteIds: [], queue: false) },
            write { try PhoneReview.retrySend(sessionId: "ses_1", sendId: "send_1") },
            write { try PhoneReview.abandonSend(sessionId: "ses_1", sendId: "send_1") },
        ],
        // Session A's unknown send survives B's list, and a note B's list does not have never settles anything.
        "held": [
            PhoneReview.heldByHost(try PhoneReview.send(sessionId: "ses_1", noteIds: ["n4"], queue: false), list: value["notes"], sessionId: "ses_1"),
            PhoneReview.heldByHost(try PhoneReview.send(sessionId: "ses_1", noteIds: ["n1"], queue: false), list: value["notes"], sessionId: "ses_1"),
            PhoneReview.heldByHost(try PhoneReview.send(sessionId: "ses_a", noteIds: ["n4"], queue: false), list: value["notes"], sessionId: "ses_b"),
            PhoneReview.heldByHost(try PhoneReview.send(sessionId: "ses_1", noteIds: ["n_missing"], queue: false), list: value["notes"], sessionId: "ses_1"),
            PhoneReview.heldByHost(try PhoneReview.send(sessionId: "ses_1", noteIds: ["n3"], queue: false), list: value["notes"], sessionId: "ses_1"),
        ],
        // The Host's own shaping cases (file-edits.test.ts), and 核对并放下 on them.
        "shapes": { () -> [Any] in
            func shape(_ text: String) -> PhoneFileEdit.TextShape? { PhoneFileEdit.textShape(Data(text.utf8)) }
            func s(_ data: Data) -> String { String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\r", with: "\\r").replacingOccurrences(of: "\n", with: "\\n") }
            let crlf = shape("a\r\nb\r\n")!, bare = shape("a\nb")!, bom = shape("\u{FEFF}hi\n")!
            return [crlf.crlf, crlf.finalNewline, shape("a\r\nb\nc")!.mixed, s(PhoneFileEdit.shaped("a\nb\nc", crlf)), s(PhoneFileEdit.shaped("a\nb\nc\n", bare)),
                    Array(PhoneFileEdit.shaped("hello", bom).prefix(3)).map(Int.init), PhoneFileEdit.shaped("", bare).count, PhoneFileEdit.textShape(Data([0xFF, 0xFE, 0x00])) == nil,
                    s(PhoneFileEdit.shaped("x\r\ny\n", crlf)),
                    PhoneFileEdit.settled(content: "a\nb", current: Data("a\r\nb\r\n".utf8)), PhoneFileEdit.settled(content: "a\nb\n", current: Data("a\nb".utf8)),
                    PhoneFileEdit.settled(content: "hi", current: Data("\u{FEFF}hi\n".utf8)), PhoneFileEdit.settled(content: "other", current: Data("a\n".utf8)),
                    PhoneFileEdit.checkWords(saved: true), PhoneFileEdit.checkWords(saved: false), PhoneFileEdit.uncheckable]
        }(),
        "visible": ["a\u{200B}b", "\u{061C}x", "\u{FEFF}y", "\u{202E}evil", "\u{2066}i\u{2069}", "tab\tok", "\u{1}"].map(PhoneConversation.visible),
        "readable": ["/link/api/tasks/s/changes/file?path=pages%2F%5B...slug%5D.tsx", "/link/api/tasks/s/../changes", "/link/api/snapshot?x=1", "/link/api/handoffs?sessionId=s"].map(NativeWorkspace.readable),
        "delivery": [
            "groups": PhoneDeliveryGroup.allCases.map { group in git.rows(group).map { "\($0.word) \($0.path)" } },
            "primary": [PhoneDelivery.primary(git, justCommitted: false)?.label ?? "", PhoneDelivery.primary(committedGit, justCommitted: false)?.label ?? "",
                        PhoneDelivery.primary(committedGit, justCommitted: true)?.label ?? "", PhoneDelivery.primary(PhoneGitState(value["gitUnstaged"])!, justCommitted: false)?.label ?? ""],
            "stageAll": PhoneGitState(value["gitUnstaged"])!.stageAllPaths,
            "aheadBehind": [git.aheadBehind, committedGit.aheadBehind, PhoneGitState(value["gitFetched"])!.aheadBehind],
            "foot": [PhoneDelivery.footNote(git) ?? "", PhoneDelivery.footNote(committedGit) ?? ""],
            "copy": ["git-turn-running", "git-operation-in-progress", "host-updating", "file-scope"].map { PhoneDelivery.copy($0, operation: "rebase")?.label ?? "" },
            "excerpt": PhoneDelivery.hookExcerpt(hook: "pre-commit", exitCode: 1, tail: (1...90).map { "line \($0)" }.joined(separator: "\n") + "\n```\n", push: false),
            "writes": [
                write { try PhoneDelivery.stage(sessionId: "ses_1", paths: ["a.ts"]) },
                write { try PhoneDelivery.stage(sessionId: "ses_1", paths: ["a.ts"], unstage: true) },
                write { try PhoneDelivery.commit(sessionId: "ses_1", message: " fix: a \n", skipHooks: true) },
                write { try PhoneDelivery.commit(sessionId: "ses_1", message: "  ", skipHooks: false) },
                write { try PhoneDelivery.push(sessionId: "ses_1") },
            ],
            "timeouts": [try PhoneDelivery.commit(sessionId: "ses_1", message: "m", skipHooks: false), try PhoneDelivery.push(sessionId: "ses_1"),
                         try PhoneReview.remove(sessionId: "ses_1", noteId: "n1")].map { PhoneDelivery.timeout($0) },
            "retryAnswers": try {
                let commit = PhoneDelivery.retryAnswered(try PhoneDelivery.commit(sessionId: "ses_1", message: "m", skipHooks: false))
                let push = PhoneDelivery.retryAnswered(try PhoneDelivery.push(sessionId: "ses_1"))
                let stage = PhoneDelivery.retryAnswered(try PhoneDelivery.stage(sessionId: "ses_1", paths: ["a"]))
                let save = PhoneDelivery.retryAnswered(try PhoneFileEdit.save(sessionId: "ses_1", handle: "AAAAAAAAAAAAAAAAAAAAAA", baseHash: String(repeating: "a", count: 64), content: "x"))
                let note = PhoneDelivery.retryAnswered(try PhoneReview.remove(sessionId: "ses_1", noteId: "n1"))
                func r(_ code: String, replay: Bool = false) -> NativeHostRefusal {
                    NativeHostRefusal(status: 422, code: code, message: "", details: replay ? .object(["replay": .bool(true)]) : .object([:]))
                }
                return [commit(r("git-hook-failed", replay: true)), commit(r("git-commit-not-made", replay: true)), commit(r("git-hook-failed")), commit(r("file-scope", replay: true)),
                        push(r("git-push-failed", replay: true)), push(r("git-detached")), push(r("git-push-unreachable")), push(r("git-push-auth")),
                        stage(r("git-stage-failed")), stage(r("git-stage-failed", replay: true)),
                        save(r("file-changed")), save(r("file-handle-expired")), note(r("request-reused"))]
            }(),
            "pendingPaths": PhoneDelivery.pendingPaths([try PhoneDelivery.stage(sessionId: "ses_1", paths: ["a.ts", "b.ts"], unstage: true)], sessionId: "ses_1").mapValues { $0 ? "stage" : "unstage" },
        ],
        "edit": [
            write { try PhoneFileEdit.save(sessionId: "ses_1", handle: "AAAAAAAAAAAAAAAAAAAAAA", baseHash: String(repeating: "a", count: 64), content: "new\n") },
            write { try PhoneFileEdit.save(sessionId: "ses_1", handle: "short", baseHash: String(repeating: "a", count: 64), content: "x") },
            write { try PhoneFileEdit.save(sessionId: "ses_1", handle: "AAAAAAAAAAAAAAAAAAAAAA", baseHash: "nothex", content: "x") },
            PhoneFileEdit.offered(value["editable"], canRun: true, wholeText: true, text: "a\nb\n"), PhoneFileEdit.offered(value["editable"], canRun: false, wholeText: true, text: "a\n"),
            PhoneFileEdit.offered(value["protected"], canRun: true, wholeText: true, text: "a\n"), PhoneFileEdit.baseHash(Data("abc".utf8)),
            PhoneFileEdit.offered(value["editable"], canRun: true, wholeText: true, text: "a\r\nb\n"),
            PhoneFileEdit.offered(value["editable"], canRun: true, wholeText: true, text: String(repeating: "\u{1}", count: 200_000)),
            PhoneFileEdit.settled(content: "a\nb\n", current: Data("a\r\nb\r\n".utf8)), PhoneFileEdit.settled(content: "a\n", current: Data("b\n".utf8)),
            PhoneFileEdit.refusalWords(NativeHostRefusal(status: 409, code: "file-changed", message: "x", details: .null)),
        ] as [Any],
        "handoffs": [
            "crumb": PhoneHandoffs.crumb(snapshot, sessionId: "ses_target").map { [$0.sourceId, $0.words, $0.listed ? "listed" : ""] } ?? [],
            "crumbUnlisted": PhoneHandoffs.crumb(snapshot, sessionId: "ses_target2")?.words ?? "",
            "awaiting": PhoneHandoffs.awaiting(snapshot).sorted(),
            "status": value["handoffList"].array.map(PhoneHandoffs.statusWords),
            "returnable": PhoneHandoffs.returnable(value["handoffList"].array, sessionId: "ses_target", status: "idle")?["id"].string ?? "",
            "returnableRunning": PhoneHandoffs.returnable(value["handoffList"].array, sessionId: "ses_target", status: "running")?["id"].string ?? "",
            "results": PhoneHandoffs.results(value["handoffList"].array, sessionId: "ses_source").map { [$0.id, $0.summary ?? "withheld", $0.evidence.joined(separator: ",")] },
            "summary": PhoneHandoffs.defaultSummary(value["detail"]["messages"].array),
            "materials": PhoneConversation.turns(value["detail"]["messages"].array).first.map { PhoneHandoffs.materials($0).map { $0.label + " " + $0.hash.prefix(8) } } ?? [],
            "quoted": PhoneHandoffs.quoted("先看这个", summary: "结论一\n\n结论二"),
            "create": write { try PhoneHandoffs.create(sourceSessionId: "ses_source", materials: [PhoneHandoffMessage(id: "m1", label: "x", hash: String(repeating: "b", count: 64))],
                requirements: " 修好它 ", returnScope: "summary", newSession: ("ws_1", "fake", nil), sessionId: nil) },
            "createExisting": write { try PhoneHandoffs.create(sourceSessionId: "ses_source", materials: [], requirements: "做", returnScope: "none", newSession: nil, sessionId: "ses_2") },
            "createEmpty": write { try PhoneHandoffs.create(sourceSessionId: "ses_source", materials: [], requirements: "  ", returnScope: "none", newSession: nil, sessionId: "ses_2") },
            "return": write { try PhoneHandoffs.handBack(handoffId: "hof_1", summary: "完成", scope: "summary", evidence: [PhoneHandoffMessage(id: "m2", label: "", hash: "h")]) },
            "returnEvidence": write { try PhoneHandoffs.handBack(handoffId: "hof_1", summary: "完成", scope: "summary-and-evidence", evidence: [PhoneHandoffMessage(id: "m2", label: "", hash: "h")]) },
            "listPath": (try? PhoneHandoffs.listPath("ses_1")) ?? "",
        ],
        "notices": value["notices"].array.map { PhoneHostNotice.parse((try? $0.encoded()) ?? Data()).map { notice in
            let words = notice.words(computer: "工作室 Mac"); return words.title.replacingOccurrences(of: PhoneTime.clock(notice.at), with: "<clock>") + " / " + words.body } ?? "" },
        "noticeRetry": PhoneHostNotice.parse((try? value["notices"].array[0].encoded()) ?? Data())?.retryAfter ?? 0,
        "markdown": PhoneMarkdown.transcript(value["detail"], harness: "Fake", now: Date(timeIntervalSince1970: 0)),
        "markdownUpTo": PhoneMarkdown.transcript(value["detail"], harness: nil, upTo: "m2", now: Date(timeIntervalSince1970: 0)),
        "menu": PhoneSessionMenu.sections(.object(["id": .string("s"), "status": .string("idle")]), canRun: true, copy: true).flatMap { $0.map(\.label) },
    ]
}

/**
 * Review and delivery from the phone's actual workspace against a real Host, a temporary Git repository and the fake
 * ACP agent: the turn's changes and one file, a note written and sent (and the same request again), a stage, a commit a
 * hook refuses with the staging kept, a commit without hooks, a small file saved and a stale save refused, and a handoff.
 */
@MainActor func runNativeReview(_ input: [String: Any]) async throws -> [String: Any] {
    let invitation = try PairingInvitation.parse(input["payload"] as? String ?? "", privateOnly: false), port = try fixturePort(input), keys = try FixtureKeys()
    let pairing = try NativePairing(invitation: invitation, keys: keys)
    let temporary = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey)
    _ = try await pairing.begin(on: temporary, name: "Swift review fixture", gatewayHash: Data(repeating: 0, count: 32))
    var approved = false
    for _ in 0..<60 {
        if let view = try await pairing.status(on: temporary), view.status == "approved" { approved = true; break }
        try await Task.sleep(for: .milliseconds(50))
    }
    guard approved else { throw NativeFailure.unavailable }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-review-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: invitation.hostId)
    let device = try await pairing.complete(on: temporary) { device in try await vault.storeMetadata(JSONEncoder().encode(device), name: "device") }
    await temporary.close()
    let workspace = try NativeWorkspace(device: device, keys: keys, vault: vault)
    var stage = "start"
    func check(_ ok: Bool, _ name: String) throws { if !ok { throw FixtureStage(name: name) } }
    func settled(_ id: String) async throws -> NativeJSON {
        for _ in 0..<400 {
            let detail = try await workspace.detail(id)
            if detail["summary"]["status"].string == "idle" { return detail }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw FixtureStage(name: "settle " + stage)
    }
    func refusal(_ write: NativePendingWrite, retryAnswered: (@Sendable (NativeHostRefusal) -> Bool)? = nil) async throws -> NativeHostRefusal {
        do { _ = try await workspace.submit(write, explain: true, retryAnswered: retryAnswered) } catch let refused as NativeHostRefusal { return refused }
        throw FixtureStage(name: "not refused " + stage)
    }
    /** The test on the other side changes this device's scopes between steps, through files in a folder of its own. */
    let handshake = URL(fileURLWithPath: input["handshake"] as? String ?? "/nonexistent")
    func ask(_ name: String, _ answer: String) async throws {
        try Data().write(to: handshake.appendingPathComponent(name))
        for _ in 0..<400 {
            if FileManager.default.fileExists(atPath: handshake.appendingPathComponent(answer).path) { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw FixtureStage(name: "handshake " + name)
    }
    /** A retry of a pending write; a window the scope change closed is opened again first. */
    func retry(_ write: NativePendingWrite) async -> String {
        for _ in 0..<2 {
            do { _ = try await workspace.submit(write, timeoutSeconds: PhoneDelivery.timeout(write), explain: true, retryAnswered: PhoneDelivery.retryAnswered(write)); return "done" }
            catch let refused as NativeHostRefusal { return "refused " + refused.code + (refused.details["replay"].bool ? " replay" : "") }
            catch let unsettled as NativeUnsettledRefusal { return "refused " + unsettled.refusal.code + " unsettled" }
            catch NativeFailure.expired { _ = try? await workspace.verify(); continue }
            catch { return "\(error)" }
        }
        return "expired"
    }
    var result: [String: Any] = [:]
    do {
        _ = try await workspace.install {
            try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
        }
        // Changes are content: nothing before a window opens, and a query outside the fixed routes is never sent.
        stage = "window"
        var closed = false
        do { _ = try await workspace.read(try PhoneReview.listPath("ses_none", scope: .turn), body: true) } catch { closed = (error as? NativeFailure) == .expired }
        var refusedQuery = false
        do { _ = try await workspace.read("/link/api/snapshot?x=1", body: false) } catch { refusedQuery = (error as? NativeFailure) == .invalidRecord }
        try check(closed && refusedQuery, "window")
        _ = try await workspace.verify()
        var snapshot = try await workspace.snapshot()
        let catalog = snapshot["catalog"]
        try check(catalog["features"]["changes"].bool && catalog["features"]["reviewNotes"].bool && catalog["features"]["gitDelivery"].bool, "features")
        var choice = PhoneStart.defaults(catalog); choice.harnessId = "fake"; choice.model = nil
        guard let id = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/tasks", fields: PhoneStart.fields(catalog, choice: choice, prompt: "shell-edit")))["sessionId"].string
        else { throw FixtureStage(name: "start") }
        _ = try await settled(id)

        // 「复核 N 处改动」: the latest turn's files, read once it is recorded.
        stage = "turns"
        var turns: [NativeJSON] = []
        for _ in 0..<80 {
            turns = try await workspace.read(try PhoneReview.turnsPath(id), body: true)["turns"].array
            if turns.last?["state"].string == "settled" { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        snapshot = try await workspace.snapshot()
        let task = snapshot["tasks"].array.first { $0["id"].string == id } ?? .null
        let shortcut = PhoneReview.shortcut(task, unread: true, turns: turns, counts: PhoneReview.counts(snapshot, id)) ?? ""
        result["shortcut"] = shortcut
        let list = try await workspace.read(try PhoneReview.listPath(id, scope: .turn), body: true)
        let files = PhoneReview.files(list)
        guard let file = files.first(where: { !PhoneReview.contentHidden($0) }), let root = file["root"].string, let path = file["path"].string else { throw FixtureStage(name: "files") }
        result["files"] = files.compactMap { $0["path"].string }
        let detail = try await workspace.read(try PhoneReview.filePath(id, scope: .turn, turnId: list["turnId"].string, root: root, path: path), body: true)
        let lines = PhoneReview.lines(detail)
        let newText = PhoneReview.textLines(lines, side: .new)
        guard let added = lines.first(where: { $0.kind == .add }) else { throw FixtureStage(name: "added line") }
        guard let selection = PhoneReview.tap(nil, added) else { throw FixtureStage(name: "pick") }

        // Write a note, send it; sending the same request again answers from the Host's receipt, never a second message.
        stage = "notes"
        let create = try PhoneReview.create(sessionId: id, root: root, path: path, selection: selection, scope: .turn, turnId: list["turnId"].string,
            lines: PhoneReview.snippet(newText, selection), text: "这里不对")
        let note = try await workspace.submit(create)
        guard let noteId = note["id"].string else { throw FixtureStage(name: "note id") }
        let send = try PhoneReview.send(sessionId: id, noteIds: [noteId], queue: false)
        _ = try await workspace.submit(send)
        let again = try await workspace.submit(send)
        try check(again["noteIds"].array.compactMap(\.string) == [noteId], "send receipt")
        _ = try await settled(id)
        var notes: [PhoneReviewNote] = []
        for _ in 0..<80 {
            notes = PhoneReview.notes(try await workspace.read(try PhoneReview.notesPath(id), body: true))
            if notes.first?.status == .sent { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        let messages = try await workspace.detail(id)["messages"].array.filter { $0["role"].string == "user" }
        result["notes"] = notes.map(\.word)
        result["feedbackMessages"] = messages.filter { ($0["text"].string ?? "").hasPrefix("请处理这 1 条代码反馈") }.count
        _ = try await workspace.submit(try PhoneReview.status(sessionId: id, noteId: noteId, status: .claimed))
        notes = PhoneReview.notes(try await workspace.read(try PhoneReview.notesPath(id), body: true))
        result["claimed"] = notes.map(\.word)

        // 提交: stage one file, a commit its hook refuses keeps the staging, then one without hooks.
        stage = "delivery"
        guard let gitState = PhoneGitState(try await workspace.read(try PhoneDelivery.statePath(id), body: true)) else { throw FixtureStage(name: "git state") }
        result["primary"] = PhoneDelivery.primary(gitState, justCommitted: false)?.label ?? ""
        guard let first = gitState.stageAllPaths.first else { throw FixtureStage(name: "changed") }
        let stageWrite = try PhoneDelivery.stage(sessionId: id, paths: [first])
        _ = try await workspace.submit(stageWrite, timeoutSeconds: PhoneDelivery.timeout(stageWrite))
        guard let staged = PhoneGitState(try await workspace.read(try PhoneDelivery.statePath(id), body: true)) else { throw FixtureStage(name: "staged") }
        result["staged"] = staged.staged.map(\.path)
        result["primaryStaged"] = PhoneDelivery.primary(staged, justCommitted: false)?.label ?? ""
        result["hooks"] = staged.hooks
        // A commit whose answer is lost: the hook takes three seconds and this request waits one. It stays pending.
        let lost = try PhoneDelivery.commit(sessionId: id, message: "fix: lost", skipHooks: false)
        do { _ = try await workspace.submit(lost, timeoutSeconds: 1, explain: true); throw FixtureStage(name: "answered") }
        catch NativeFailure.resultUnknown {}
        try await Task.sleep(for: .seconds(4))
        // Without run the Host refuses before it looks at the receipt: that says nothing, so the commit stays unknown.
        try await ask("drop-run", "dropped")
        let denied = await retry(lost)
        let stillPending = try await workspace.pendingWrites().contains { $0.requestId == lost.requestId }
        try await ask("restore-run", "restored")
        // With run back, the Host answers from the first attempt's receipt (`replay`): settled, gone from pending.
        let answered = await retry(lost)
        let settledNow = try await !workspace.pendingWrites().contains { $0.requestId == lost.requestId }
        result["lostCommit"] = [denied.hasPrefix("refused") || denied == "resultUnknown" ? "refused-or-unknown" : denied, stillPending ? "pending" : "dropped", answered, settledNow ? "settled" : "pending"]
        let commit = try PhoneDelivery.commit(sessionId: id, message: "fix: phone", skipHooks: false)
        let hook = try await refusal(commit)
        result["hook"] = [hook.code, hook.details["hook"].string ?? "", hook.details["exitCode"].integer ?? 0, (hook.details["tail"].string ?? "").contains("phone hook says no")] as [Any]
        let excerpt = PhoneDelivery.hookExcerpt(hook: hook.details["hook"].string, exitCode: hook.details["exitCode"].integer, tail: hook.details["tail"].string, push: false)
        result["excerpt"] = excerpt.hasPrefix("提交钩子 pre-commit 没通过，退出码 1，没有生成提交：")
        guard let after = PhoneGitState(try await workspace.read(try PhoneDelivery.statePath(id), body: true)) else { throw FixtureStage(name: "after hook") }
        result["stagedAfterHook"] = after.staged.map(\.path)
        // Sending the refused commit again is answered from its receipt: the same refusal, settled, not unknown.
        let replay = try await refusal(commit, retryAnswered: PhoneDelivery.retryAnswered(commit))
        result["replay"] = replay.code
        let skip = try PhoneDelivery.commit(sessionId: id, message: "fix: phone", skipHooks: true)
        let made = try await workspace.submit(skip, timeoutSeconds: PhoneDelivery.timeout(skip), explain: true)
        result["commit"] = (made["commit"].string ?? "").count == 40
        // A push whose answer is lost (the remote's hook takes three seconds, this request waits one). Without run the retry
        // stays unknown; after HEAD is detached the retry is answered from the receipt, never `git-detached`.
        let lostPush = try PhoneDelivery.push(sessionId: id)
        do { _ = try await workspace.submit(lostPush, timeoutSeconds: 1, explain: true); throw FixtureStage(name: "push answered") }
        catch NativeFailure.resultUnknown {}
        try await Task.sleep(for: .seconds(4))
        try await ask("drop-run-push", "dropped-push")
        let pushDenied = await retry(lostPush)
        let pushPending = try await workspace.pendingWrites().contains { $0.requestId == lostPush.requestId }
        try await ask("restore-run-push", "restored-push")
        try await ask("detach", "detached")
        let pushAnswered = await retry(lostPush)
        let pushSettled = try await !workspace.pendingWrites().contains { $0.requestId == lostPush.requestId }
        result["lostPush"] = [pushDenied.hasPrefix("refused") ? "refused-unknown" : pushDenied, pushPending ? "pending" : "dropped", pushAnswered, pushSettled ? "settled" : "pending"]
        result["pendingAfter"] = try await workspace.pendingWrites().count

        // A small file saved on the version read; a save on a version since changed is refused, nothing written.
        stage = "edit"
        let resolved = try await workspace.resolveFile(sessionId: id, reference: path, rootId: root)
        let meta = resolved["files"].array.first?["file"] ?? .null
        guard let handle = meta["handle"].string, let etag = meta["etag"].string, let size = meta["size"].integer else { throw FixtureStage(name: "resolve") }
        let bytes = try await workspace.fileBytes(handle: handle, etag: etag, offset: 0, count: Int(size))
        result["editOffered"] = PhoneFileEdit.offered(meta, canRun: true, wholeText: true, text: String(decoding: bytes, as: UTF8.self))
        let base = PhoneFileEdit.baseHash(bytes)
        let saved = try await workspace.submit(try PhoneFileEdit.save(sessionId: id, handle: handle, baseHash: base, content: "edited on the phone\n"), explain: true)
        result["saved"] = saved == .null ? "null" : "ok"
        let stale = try await refusal(try PhoneFileEdit.save(sessionId: id, handle: handle, baseHash: base, content: "second\n"))
        result["stale"] = [stale.code, PhoneFileEdit.refusalWords(stale)]
        // 核对并放下 compares the file now with the text a save carried.
        let now = try await workspace.resolveFile(sessionId: id, reference: path, rootId: root)["files"].array.first?["file"] ?? .null
        let current = try await workspace.fileBytes(handle: now["handle"].string ?? "", etag: now["etag"].string ?? "", offset: 0, count: Int(now["size"].integer ?? 1))
        result["checked"] = [PhoneFileEdit.settled(content: "edited on the phone\n", current: current), PhoneFileEdit.settled(content: "second\n", current: current)]
        // A file whose name has `..` in it is read through the query, never refused as a path.
        try check(NativeWorkspace.readable(try PhoneReview.filePath(id, scope: .turn, turnId: nil, root: root, path: "pages/[...slug].tsx")), "dots")

        // 交给代码任务…: this turn's messages, fixed at their versions, to a new session.
        stage = "handoff"
        let sourceTurns = PhoneConversation.turns(try await workspace.detail(id)["messages"].array)
        guard let turn = sourceTurns.first else { throw FixtureStage(name: "turn") }
        let materials = PhoneHandoffs.materials(turn)
        let handoff = try await workspace.submit(try PhoneHandoffs.create(sourceSessionId: id, materials: materials, requirements: "接着做",
            returnScope: "summary", newSession: (task["workspaceId"].string ?? "default", "fake", nil), sessionId: nil), explain: true)
        result["handoff"] = [handoff["status"].string ?? "", handoff["targetSessionId"].string != nil ? "target" : ""]
        let listed = try await workspace.read(try PhoneHandoffs.listPath(id), body: true)["handoffs"].array
        result["handoffListed"] = listed.count
        result["window"] = true
    } catch {
        await workspace.closeOpening()
        throw FixtureStage(name: stage + ": \(error)")
    }
    await workspace.closeOpening()
    return result
}

/** The core's port of the Host's file shaping, over bytes and texts the test gives, for comparison with the Host's own. */
func fileShapeFixture(_ input: [String: Any]) -> [String: Any] {
    let files = (input["files"] as? [String] ?? []).compactMap { Data(base64Encoded: $0) }
    let contents = input["contents"] as? [String] ?? []
    return ["files": files.map { file -> Any in
        guard let shape = PhoneFileEdit.textShape(file) else { return NSNull() }
        return ["shape": ["bom": shape.bom, "eol": shape.crlf ? "\r\n" : "\n", "finalNewline": shape.finalNewline, "mixed": shape.mixed],
                "shaped": contents.map { PhoneFileEdit.shaped($0, shape).base64EncodedString() },
                "settled": contents.map { PhoneFileEdit.settled(content: $0, current: file) }]
    }]
}
