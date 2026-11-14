import Foundation
import LatchNativeCore
import Security

/** Reads synthetic Host JSON through the App's own projections, and answers in plain values the test can compare. */
func phoneProjectionFixture(_ input: [String: Any]) throws -> [String: Any] {
    let value = try NativeJSON.decode(JSONSerialization.data(withJSONObject: input))
    let hostNow = PhoneTime.parse(value["hostNow"]) ?? Date()
    func words(_ status: PhoneRowStatus) -> String {
        switch status {
        case .waiting: "waiting"; case .silent: "silent"; case .stopping: "stopping"; case .running: "running"; case .failed: "failed"
        case let .ended(word, unknown): "ended:\(word):\(unknown)"; case .frozen: "frozen"; case .read: "read"
        }
    }
    let tasks = value["tasks"].array, workspaces = value["workspaces"].array, catalog = value["catalog"], detail = value["detail"]
    let turns = PhoneConversation.turns(PhoneConversation.rendered(detail))
    func item(_ work: PhoneWorkItem) -> String {
        switch work {
        case let .tool(message): let label = PhoneConversation.toolLabel(message); return [label.verb, label.object].compactMap { $0 }.joined(separator: " ")
        case .thinking: return "thinking"
        case let .reads(messages): return "reads:\(messages.count)"
        }
    }
    func block(_ value: PhoneTurnBlock) -> Any {
        switch value {
        case let .work(_, items): return ["work": items.map(item)]
        case let .prose(message): return ["prose": message["text"].string ?? ""]
        case let .note(message): return [message["steered"].bool ? "steer" : "note": message["text"].string ?? ""]
        }
    }
    let choice = PhoneStart.defaults(catalog)
    func fieldValue(_ json: NativeJSON) throws -> Any { try JSONSerialization.jsonObject(with: json.encoded(), options: .fragmentsAllowed) }
    let status = PhoneConversation.runStatus(detail, stopping: value["stopping"].bool, engine: "Codex", hostNow: hostNow)
    let subtitle = PhoneConversation.subtitle(detail, engine: "Codex")
    let delivered = PhoneConversation.turns(value["delivered"]["messages"].array)
    func hours(_ count: Double) -> Date { hostNow.addingTimeInterval(count * -3600) }
    func ended(_ end: PhoneRunEnd?) -> Any { end.map { ["failed": $0.failed, "text": $0.text, "unknown": $0.unknown] as [String: Any] } ?? NSNull() }
    return [
        "sameScope": PhoneFileScope(value["scopes"].array.first ?? .null) == PhoneFileScope(value["scopes"].array.last ?? .null),
        "parsed": value["stamps"].array.map { PhoneTime.parse($0)?.timeIntervalSince1970 ?? -1 },
        "confirmed": [PhoneTime.message(hostNow, now: hostNow) == PhoneTime.clock(hostNow), PhoneTime.message(hours(24), now: hostNow).hasPrefix("昨天"), PhoneTime.message(hours(96), now: hostNow).contains("月")],
        "clocks": [PhoneTime.runClock(seconds: 47), PhoneTime.runClock(seconds: 723), PhoneTime.runClock(seconds: 3723)],
        "durations": [0.5, 1.25, 12, 133, 3720].map { PhoneTime.duration(seconds: $0) ?? "" },
        "runEnds": value["runEnds"].array.map { ended(PhoneConversation.runEnd($0, engine: "Codex")) },
        "outcomes": value["statuses"].array.compactMap { status in delivered.first.map { PhoneConversation.outcome($0, latestStatus: status.string) } },
        "delivery": delivered.first.flatMap { PhoneConversation.delivery(value["delivered"], turn: $0) } ?? "",
        "hasFiles": [PhoneConversation.hasFiles(detail), PhoneConversation.hasFiles(value["delivered"])],
        "noteTooLong": [PhoneConversation.rejectionNoteTooLong(String(repeating: "字", count: 500)), PhoneConversation.rejectionNoteTooLong(String(repeating: "字", count: 501)), PhoneConversation.rejectionNoteTooLong(" " + String(repeating: "字", count: 500) + "\n")],
        "faceId": [("com.apple.LocalAuthentication", -2), ("com.apple.LocalAuthentication", -4), ("com.apple.LocalAuthentication", -1), (kCFErrorDomainOSStatus as String, -128), (kCFErrorDomainOSStatus as String, -25300), ("", 0)]
            .map { SecureDeviceKeys.verificationFailure(domain: $0.0, code: $0.1) == .declined },
        "verificationAsksPresence": SecureDeviceKeys.verificationAccess.contains(.userPresence),
        "unlock": [false, true].map { ["reopen": PhoneUnlock.reopenWords(faceID: $0), "symbol": PhoneUnlock.closedWindowSymbol(faceID: $0), "atExpiry": PhoneUnlock.reopensAtExpiry(faceID: $0)] as [String: Any] },
        "rows": tasks.map { words(PhoneSessions.rowStatus($0)) },
        "frozen": tasks.map { words(PhoneSessions.rowStatus($0, frozen: true)) },
        "shelves": PhoneSessions.shelves(tasks: tasks, workspaces: workspaces).map { ["label": $0.label, "ids": $0.tasks.compactMap { $0["id"].string }] },
        "found": PhoneSessions.shelves(tasks: tasks, workspaces: workspaces, query: value["query"].string ?? "").map { $0.label },
        "turns": turns.map { turn -> [String: Any] in
            let summary = PhoneConversation.summary(turn, outputs: value["outputs"].array, scope: PhoneFileScope(detail["summary"]))
            let outcome = PhoneConversation.outcome(turn, latestStatus: nil)
            return ["blocks": PhoneConversation.blocks(turn, settled: true).map(block), "folds": PhoneConversation.workFolds(turn, outcome: outcome),
                "fold": PhoneConversation.foldWords(turn), "files": summary.files.map(\.path), "add": summary.add ?? -1, "del": summary.del ?? -1]
        },
        "dividers": turns.map { PhoneConversation.divider($0) ?? "" },
        "switches": PhoneConversation.switches(PhoneConversation.turns(value["switching"].array)),
        "cleared": [detail, value["delivered"]].map { PhoneConversation.clearedNote($0, engine: "Codex").map { [$0.title, $0.line] } ?? [] },
        "status": ["text": status.text, "clock": status.clock ?? "", "tone": "\(status.tone)", "actions": status.actions.map { "\($0)" }],
        "subtitle": subtitle.parts, "neverAsks": subtitle.neverAsks,
        "judged": PhoneConversation.rendered(detail).compactMap { PhoneConversation.judgement($0).map { "\($0.review):\($0.words)" } },
        "blocked": PhoneConversation.rendered(detail).compactMap { PhoneConversation.blocked($0).map { "\($0.model):\($0.line)" } },
        "input": value["inputs"].array.map { PhoneConversation.inputGate(summary: $0["summary"], permission: $0["permission"], canRun: $0["canRun"].bool, connected: $0["connected"].bool) ?? "" },
        "approvals": value["approvals"].array.map { approval -> [String: Any] in
            let gate = PhoneConversation.approvalGate(approval, canApproveStandard: value["canApprove"].bool, canApproveElevated: value["canApproveElevated"].bool, canRun: value["canRun"].bool)
            return ["heading": gate.heading, "canAllow": gate.canAllow, "option": gate.allowOption ?? "", "refusal": gate.refusal ?? "", "clause": gate.riskClause ?? ""]
        },
        "engines": PhoneStart.engines(catalog).map { ["id": $0.id, "name": $0.name] },
        "projects": PhoneStart.projects(catalog).map { ["id": $0.id] },
        "choice": ["harness": choice.harnessId ?? "", "workspace": choice.workspaceId ?? "", "model": choice.model?.model ?? ""],
        "blocker": PhoneStart.blocker(catalog, choice: choice) ?? "",
        "fields": try fieldValue(.object(PhoneStart.fields(catalog, choice: choice, prompt: "开始"))),
    ]
}
