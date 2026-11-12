import Foundation
import LatchNativeCore

/** 接入已有会话 as the App derives it from synthetic Host JSON, in plain values to compare. */
func phoneHistoryFixture(_ input: [String: Any]) throws -> [String: Any] {
    let value = try NativeJSON.decode(JSONSerialization.data(withJSONObject: input))
    func entry(_ entry: PhoneHistoryEntry) -> Any {
        switch entry {
        case .hidden: "hidden"
        case .locked: "locked"
        case let .open(sources): sources.map { "\($0.harnessId):\($0.label)" }
        }
    }
    func targets(_ list: [PhoneImportTarget]) -> [String] { list.map { "\($0.harnessId):\($0.mode.rawValue)" } }
    func view(_ view: PhoneHistoryListView) -> String {
        switch view {
        case .loading: "loading"
        case let .empty(others): "empty \(others)"
        case let .rows(rows, others, truncated): "rows \(rows.map(\.handle).joined(separator: ",")) \(others) \(truncated)"
        case .notSupported: "not-supported"
        case .login: "login"
        case let .failed(words): "failed \(words)"
        }
    }
    func refusal(_ code: String, _ details: NativeJSON = .null, message: String = "") -> NativeHostRefusal {
        NativeHostRefusal(status: 409, code: code, message: message, details: details)
    }
    func write(_ make: () throws -> NativePendingWrite) -> Any {
        guard let write = try? make() else { return "refused" }
        let body = (try? JSONSerialization.jsonObject(with: write.body)) as? [String: Any] ?? [:]
        return ["method": write.method, "path": write.path, "body": body.filter { $0.key != "requestId" }, "sameId": body["requestId"] as? String == write.requestId,
            "words": PhonePending.words(write), "import": PhoneHistory.isImport(write)]
    }
    func outcome(_ value: PhoneImportOutcome) -> String {
        switch value { case let .open(taskId): "open \(taskId)"; case .busy: "busy"; case .expired: "expired"; case let .failed(words): "failed \(words)"; case .notDone: "not done"; case .deletedSince: "deleted since" }
    }
    let catalog = value["snapshots"].array.first?["catalog"] ?? .null
    let list = PhoneHistory.list(value["list"])
    let preview = PhoneHistory.preview(value["preview"])
    let previewId = "hp_" + String(repeating: "e5", count: 16)
    let first = try PhoneHistory.importWrite(previewId: previewId, harnessId: "codex")
    let pending = [try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["prompt": .string("x")]), first]
    let project = value["project"]
    let message = value["message"]
    let fold = PhoneHistory.fold(message)
    return [
        "entries": value["snapshots"].array.map { entry(PhoneHistory.entry($0, workspaceId: $0["choose"].string)) },
        "targets": targets(PhoneHistory.targets(catalog, sourceId: "codex")),
        "rebuildTargets": targets(PhoneHistory.rebuildTargets(catalog, ownId: "pi")),
        "rebuilt": PhoneHistory.rebuiltFrom(value["tasks"].array, taskId: "ses_lost")?["id"].string ?? NSNull(),
        "offers": value["tasks"].array.map { PhoneHistory.offersRebuild($0, lost: true, snapshot: value["snapshots"].array[0]) }
            + [PhoneHistory.offersRebuild(value["tasks"].array[0], lost: false, snapshot: value["snapshots"].array[0])],
        "views": [
            view(PhoneHistory.listView(nil)), view(PhoneHistory.listView(list)),
            view(PhoneHistory.listView(PhoneHistory.list(.object(["rows": .array([]), "otherFolders": .number(3)])))),
            view(PhoneHistory.listView(nil, failure: refusal("history-not-supported"))), view(PhoneHistory.listView(nil, failure: refusal("agent-auth-required"))),
            view(PhoneHistory.listView(nil, failure: refusal("harness-unavailable", message: "Codex 当前不可用"))), view(PhoneHistory.listView(nil, error: "暂时无法连接这台电脑。")),
            PhoneHistory.list(.object(["nope": .null])) == nil ? "invalid" : "parsed",
        ],
        "folders": (list?.rows ?? []).map { PhoneHistory.folder($0, primary: PhoneHistory.primaryName(project)) },
        "imported": (list?.rows ?? []).map { $0.importedTaskId ?? "" },
        "others": [PhoneHistory.othersWords(0) ?? "", PhoneHistory.othersWords(2) ?? ""],
        "preview": [preview?.meta ?? "", preview?.messages.map { $0.role == .tool ? $0.toolWords : $0.text + ($0.clipped ? " …" : "") } ?? [], preview?.truncated ?? false,
            PhoneHistory.preview(.object(["previewId": .string("hp_../x")])) == nil] as [Any],
        "previewFailures": ["history-session-busy", "history-handle-expired", "harness-unavailable"].map { code -> String in
            switch PhoneHistory.previewFailure(refusal(code, message: "不行")) { case .busy: "busy"; case .expired: "expired"; case let .failed(words): "failed \(words)" }
        },
        "reads": [
            (try? PhoneHistory.listRead(projectId: "app", harnessId: "codex")).map { [$0.path, $0.timeoutSeconds] as [Any] } ?? "refused",
            (try? PhoneHistory.listRead(projectId: "../x", harnessId: "codex")) == nil ? "refused" : "made",
            (try? PhoneHistory.previewRead(handle: "hh_" + String(repeating: "0f", count: 16))).map { [$0.path, $0.timeoutSeconds] as [Any] } ?? "refused",
            (try? PhoneHistory.previewRead(handle: "hh_x")) == nil ? "refused" : "made",
            (try? PhoneHistory.closePath(previewId)) ?? "refused",
            (try? PhoneHistory.closePath("hp_../tasks")) ?? "refused",
        ] as [Any],
        "writes": [
            write { first },
            write { try PhoneHistory.rebuildWrite(fromTaskId: "task-1", harnessId: "pi") },
            write { try PhoneHistory.importWrite(previewId: "hp_nope", harnessId: "codex") },
            write { try PhoneHistory.rebuildWrite(fromTaskId: "../x", harnessId: "pi") },
            write { try PhoneHistory.importWrite(previewId: previewId, harnessId: "-bad") },
        ],
        "attempt": [PhoneHistory.attempt(pending, source: previewId, harnessId: "codex")?.requestId == first.requestId,
            PhoneHistory.attempt(pending, source: previewId, harnessId: "pi") == nil, PhoneHistory.attempt(pending, source: "hp_other", harnessId: "codex") == nil],
        "answered": {
            let preview = PhoneHistory.retryAnswered(first)
            let rebuild = PhoneHistory.retryAnswered((try? PhoneHistory.rebuildWrite(fromTaskId: "task-1", harnessId: "pi")) ?? first)
            return [preview(refusal("history-already-imported", .object(["taskId": .string("task-9")]))), preview(refusal("history-already-imported")),
                preview(refusal("history-session-busy")), preview(refusal("history-handle-expired")), preview(refusal("task-deleted")),
                rebuild(refusal("history-handle-expired")), rebuild(refusal("task-deleted"))]
        }(),
        "outcomes": [outcome(PhoneHistory.outcome(refusal("history-already-imported", .object(["taskId": .string("task-9")])))),
            outcome(PhoneHistory.outcome(refusal("history-session-busy"))), outcome(PhoneHistory.outcome(refusal("history-handle-expired"))),
            outcome(PhoneHistory.outcome(refusal("harness-unavailable", message: "Pi 当前不可用"))),
            outcome(PhoneHistory.outcome(refusal("history-handle-expired"), retry: true)), outcome(PhoneHistory.outcome(refusal("task-deleted"), retry: true))],
        "receiptPath": [PhoneHistory.receiptPath(first) == "/link/api/history/imports/" + first.requestId, PhoneHistory.receiptPath(pending[0]) == nil],
        "closer": {
            // Leaving with the window closed waits; an unanswered import holds its preview; a window sends the rest once.
            let other = "hp_" + String(repeating: "f6", count: 16)
            var closer = PhoneHistoryCloser()
            closer.close(previewId, pending: pending)
            closer.close(other, pending: pending)
            closer.close(other, pending: pending)
            closer.discard("hp_bad", pending: [])
            let closed = closer.take(windowOpen: false, pending: pending)
            let open = closer.take(windowOpen: true, pending: pending)
            let again = closer.take(windowOpen: true, pending: pending)
            closer.requeue(other)
            let requeued = closer.take(windowOpen: true, pending: [])
            // Once the import is settled, its preview may be closed.
            closer.close(previewId, pending: [])
            let settled = closer.take(windowOpen: true, pending: [])
            var many = PhoneHistoryCloser()
            for index in 0..<20 { many.close("hp_" + String(format: "%032x", index), pending: []) }
            return [closed, open, again, requeued, settled, [String(many.waiting.count)]]
        }(),
        "marks": value["tasks"].array.map { task -> Any in
            PhoneHistory.mark(task, sourceLabel: task["imported"]["from"].string == "codex" ? "Codex" : nil).map { [$0.label, $0.detail, $0.rebuilt] as [Any] } ?? NSNull()
        },
        "seed": [PhoneHistory.seedWaiting(value["tasks"].array[1], messages: []), PhoneHistory.seedWaiting(value["tasks"].array[1], messages: [message]),
            PhoneHistory.seedWaiting(value["tasks"].array[0], messages: [])],
        "seedWords": PhoneHistory.seedWords(service: "DeepSeek"),
        "fold": fold.map { [$0.summary, $0.context, $0.rest] } ?? [],
        "resend": PhoneTurnActions.resendText(message),
        "promptSession": [PhoneHistory.promptSession("/link/api/tasks/task-1/prompt") ?? "", PhoneHistory.promptSession("/link/api/tasks") ?? "",
            PhoneHistory.promptSession("/link/api/tasks/task-1/queue/q/send") ?? ""],
        "lost": NativeFailure.sessionLost.localizedDescription,
    ]
}

/**
 * 接入已有会话 from the actual Swift workspace against a real Host whose fake agent lists and loads its own sessions: the
 * window is required, a listing and a preview carry no request ID, 接入 with the same request ID answers the same session,
 * another request for it is `history-already-imported` naming it, and a closed preview cannot be imported.
 */
@MainActor func runNativeHistory(_ input: [String: Any]) async throws -> [String: Any] {
    let invitation = try PairingInvitation.parse(input["payload"] as? String ?? "", privateOnly: false), port = try fixturePort(input), keys = try FixtureKeys()
    guard let projectId = input["projectId"] as? String else { throw NativeFailure.invalidRecord }
    let pairing = try NativePairing(invitation: invitation, keys: keys)
    let temporary = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey)
    _ = try await pairing.begin(on: temporary, name: "Swift history fixture", gatewayHash: Data(repeating: 0, count: 32))
    var approved = false
    for _ in 0..<60 {
        if let view = try await pairing.status(on: temporary), view.status == "approved" { approved = true; break }
        try await Task.sleep(for: .milliseconds(50))
    }
    guard approved else { throw NativeFailure.unavailable }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-history-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: invitation.hostId)
    let device = try await pairing.complete(on: temporary) { device in try await vault.storeMetadata(JSONEncoder().encode(device), name: "device") }
    await temporary.close()
    let workspace = try NativeWorkspace(device: device, keys: keys, vault: vault)
    var result: [String: Any] = [:]
    do {
        _ = try await workspace.install {
            try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
        }
        let listing = try PhoneHistory.listRead(projectId: projectId, harnessId: "codex")
        var windowRequired = false
        do { _ = try await workspace.historyRead(listing) } catch { windowRequired = (error as? NativeFailure) == .expired }
        result["window"] = windowRequired
        _ = try await workspace.verify()
        let snapshot = try await workspace.snapshot()
        guard case let .open(sources) = PhoneHistory.entry(snapshot, workspaceId: projectId) else { throw NativeFailure.unsupported }
        result["sources"] = sources.map(\.harnessId)
        // The read-only query route: its path is fixed and only the project is in the query.
        let named = try await workspace.read("/link/api/history/sources?projectId=" + projectId, body: true)
        result["sourcesRoute"] = named["sources"].array.compactMap { $0["harnessId"].string }
        guard let list = PhoneHistory.list(try await workspace.historyRead(listing)) else { throw NativeFailure.invalidRecord }
        result["titles"] = list.rows.map(\.title)
        result["otherFolders"] = list.otherFolders
        guard let row = list.rows.first(where: { $0.title == "Web build" }), let busy = list.rows.first(where: { $0.title == "Open in a terminal" }) else { throw NativeFailure.invalidRecord }
        do { _ = try await workspace.historyRead(PhoneHistory.previewRead(handle: busy.handle)); result["busy"] = "loaded" }
        catch let refusal as NativeHostRefusal { result["busy"] = "\(PhoneHistory.previewFailure(refusal))" }
        guard let preview = PhoneHistory.preview(try await workspace.historyRead(PhoneHistory.previewRead(handle: row.handle))) else { throw NativeFailure.invalidRecord }
        result["preview"] = [preview.messages.map(\.role.rawValue), preview.messages.contains { $0.role == .tool && $0.text.contains("secret") }] as [Any]
        // 接入 as it was; the same request again is the Host's receipt: the same session, and no second one.
        let write = try PhoneHistory.importWrite(previewId: preview.previewId, harnessId: "codex")
        let done = try await workspace.submit(write, timeoutSeconds: PhoneHistory.importTimeout, explain: true, retryAnswered: PhoneHistory.retryAnswered(write))
        guard let taskId = PhoneHistory.importedTask(done) else { throw NativeFailure.invalidRecord }
        let again = try await workspace.submit(write, timeoutSeconds: PhoneHistory.importTimeout, explain: true, retryAnswered: PhoneHistory.retryAnswered(write))
        result["sameSession"] = PhoneHistory.importedTask(again) == taskId
        // 核对并放下 reads the receipt: done names the session; a request the Host never saw has none.
        result["receipt"] = [try await workspace.historyReceipt(write) == .done(taskId: taskId),
            try await workspace.historyReceipt(PhoneHistory.importWrite(previewId: preview.previewId, harnessId: "codex")) == PhoneImportReceipt.none]
        let detail = try await workspace.detail(taskId)
        result["mark"] = PhoneHistory.mark(detail["summary"], sourceLabel: "Codex")?.label ?? ""
        result["importedMode"] = detail["summary"]["imported"]["mode"].string ?? ""
        // Listed again: the row is ticked and names the session.
        let relisted = PhoneHistory.list(try await workspace.historyRead(listing))
        result["ticked"] = relisted?.rows.first { $0.title == "Web build" }?.importedTaskId == taskId
        // Another request for the same session: the Host names the one already brought in.
        guard let other = relisted?.rows.first(where: { $0.title == "Web build" }) else { throw NativeFailure.invalidRecord }
        let second = try PhoneHistory.importWrite(previewId: "hp_" + String(repeating: "0", count: 32), harnessId: "codex")
        do { _ = try await workspace.submit(second, explain: true, retryAnswered: PhoneHistory.retryAnswered(write)); result["expired"] = "done" }
        catch let refusal as NativeHostRefusal { result["expired"] = "\(PhoneHistory.outcome(refusal))" }
        guard let reopened = PhoneHistory.preview(try await workspace.historyRead(PhoneHistory.previewRead(handle: other.handle))) else { throw NativeFailure.invalidRecord }
        do { _ = try await workspace.submit(PhoneHistory.importWrite(previewId: reopened.previewId, harnessId: "codex"), explain: true, retryAnswered: PhoneHistory.retryAnswered(write)); result["already"] = "done" }
        catch let refusal as NativeHostRefusal { result["already"] = "\(PhoneHistory.outcome(refusal))" == "open(taskId: \"\(taskId)\")" }
        try? await workspace.closeHistoryPreview(reopened.previewId)
        // A text rebuild into another Harness: a fresh session that waits for the first message.
        let rebuildRow = relisted?.rows.first { $0.title == "Rebuild me" }
        if let rebuildRow, let rebuildPreview = PhoneHistory.preview(try await workspace.historyRead(PhoneHistory.previewRead(handle: rebuildRow.handle))) {
            let targets = PhoneHistory.targets(snapshot["catalog"], sourceId: "codex")
            result["targets"] = targets.map { "\($0.harnessId):\($0.mode.rawValue)" }
            let rebuild = try PhoneHistory.importWrite(previewId: rebuildPreview.previewId, harnessId: "fake")
            let rebuilt = try await workspace.submit(rebuild, timeoutSeconds: PhoneHistory.importTimeout, explain: true, retryAnswered: PhoneHistory.retryAnswered(write))
            guard let rebuiltId = PhoneHistory.importedTask(rebuilt) else { throw NativeFailure.invalidRecord }
            let fresh = try await workspace.detail(rebuiltId)
            result["rebuilt"] = [PhoneHistory.mark(fresh["summary"], sourceLabel: "Codex")?.label ?? "", PhoneHistory.seedWaiting(fresh["summary"], messages: fresh["messages"].array)] as [Any]
        }
        // A preview let go cannot be imported any more.
        let closing = relisted?.rows.first { $0.title == "Phone notes" }
        if let closing, let closed = PhoneHistory.preview(try await workspace.historyRead(PhoneHistory.previewRead(handle: closing.handle))) {
            try await workspace.closeHistoryPreview(closed.previewId)
            do { _ = try await workspace.submit(try PhoneHistory.importWrite(previewId: closed.previewId, harnessId: "codex"), explain: true); result["closed"] = "imported" }
            catch let refusal as NativeHostRefusal { result["closed"] = "\(PhoneHistory.outcome(refusal))" }
        }
        result["pendingAfter"] = try await workspace.pendingWrites().count
    } catch {
        await workspace.closeOpening()
        throw error
    }
    await workspace.closeOpening()
    return result
}
