import Foundation

/** A subagent's row, as the web draws it: its name, what it last said of itself, and 停止 where it can be stopped alone. */
public struct PhoneSubagentRow: Equatable, Sendable {
    public let id: String
    public let title: String
    /** Nothing said, nothing shown. */
    public let status: String?
    public let waiting: Bool
    public let stopping: Bool
    public let canStop: Bool
    public let steps: [NativeJSON]
}

public enum PhoneSubagents {
    private static let words = ["running": "运行中", "waiting": "等你处理", "done": "已完成", "failed": "失败", "cancelled": "已停止", "unknown": "状态未知"]
    /**
     * `requested`: this phone sent a stop the Host has not shown yet. A row reads 正在停止… until the subagent says it
     * stopped, never 已停止 before. `canStop`: this phone may stop the session (`view`) and hears the Mac now.
     */
    public static func row(_ message: NativeJSON, requested: Bool, canStop: Bool) -> PhoneSubagentRow? {
        let agent = message["subagent"]
        guard case .object = agent, let id = message["id"].string, !id.isEmpty, id.utf8.count <= 256 else { return nil }
        let stoppable = agent["stoppable"].bool
        let stopping = agent["stopping"].bool || (requested && stoppable)
        return PhoneSubagentRow(id: id, title: agent["title"].string ?? "子 Agent",
            status: stopping ? "正在停止…" : agent["status"].string.flatMap { words[$0] }, waiting: !stopping && agent["status"].string == "waiting",
            stopping: stopping, canStop: canStop && stoppable && !stopping, steps: Array(agent["steps"].array.prefix(200)))
    }
}

/**
 * The stops this phone sent that the Host has not shown yet, as the web's row keeps them: one goes on any failure or
 * unknown answer, and once the Host reports the subagent stopping or no longer stoppable. Rows show what the Host read back.
 */
public struct PhoneSubagentStops: Equatable, Sendable {
    public private(set) var requested: Set<String> = []
    public init() {}
    public func contains(_ id: String) -> Bool { requested.contains(id) }
    public mutating func begin(_ id: String) -> Bool { requested.insert(id).inserted }
    /** Answered: kept only while the Host has not yet said otherwise; failed or unknown: gone. */
    public mutating func answered(_ id: String, ok: Bool) { if !ok { requested.remove(id) } }
    public mutating func observe(_ detail: NativeJSON) {
        func rows(_ messages: [NativeJSON]) -> [NativeJSON] {
            messages.flatMap { message -> [NativeJSON] in message["subagent"] == .null ? [] : [message] + rows(message["subagent"]["steps"].array) }
        }
        let found = Dictionary(rows(detail["messages"].array).compactMap { row in row["id"].string.map { ($0, row["subagent"]) } }, uniquingKeysWith: { a, _ in a })
        requested = requested.filter { id in found[id].map { $0["stoppable"].bool && !$0["stopping"].bool } ?? false }
    }
}

extension PhoneSubagentStops {
    /**
     * The App's 停止 on a row, start to answer: marked stopping, sent, and the mark dropped on any failure or unknown
     * answer. `current` says the App still shows this connection; when it does not, nothing is touched. Nil: not sent,
     * since a stop of that row is already on its way.
     */
    @MainActor public static func run(_ id: String, get: () -> PhoneSubagentStops, set: (PhoneSubagentStops) -> Void,
        current: () -> Bool, send: () async throws -> Void) async -> Result<Void, Error>? {
        var stops = get()
        guard stops.begin(id) else { return nil }
        set(stops)
        do {
            try await send()
            guard current() else { return .success(()) }
            stops = get(); stops.answered(id, ok: true); set(stops)
            return .success(())
        } catch {
            guard current() else { return .failure(error) }
            stops = get(); stops.answered(id, ok: false); set(stops)
            return .failure(error)
        }
    }
}

/** Resending a turn: the person's own words, and what to say first when the earlier try may have changed something. */
public struct PhoneRetry: Equatable, Sendable {
    public let prompt: String
    public let warning: String?
}

/** What a settled turn offers, as the web's turn footer: 复制, 重试 on the newest one, and 从这里分叉. */
public struct PhoneTurnActions: Equatable, Sendable {
    public let copy: String?
    public let retry: PhoneRetry?
    /** The message a fork keeps up to: the turn's last. */
    public let forkFrom: String?
    public var isEmpty: Bool { copy == nil && retry == nil && forkFrom == nil }
    public static let none = PhoneTurnActions(copy: nil, retry: nil, forkFrom: nil)

    /**
     * `canSend`: this phone may type into the session now; `canFork`: the Host offers forks (`features.fork`) and this
     * phone may start a session. A running turn offers nothing.
     */
    public static func of(_ turn: PhoneTurn, latest: Bool, running: Bool, canSend: Bool, canFork: Bool) -> PhoneTurnActions {
        guard !running else { return .none }
        let text = PhoneConversation.turnText(turn)
        var retry: PhoneRetry?
        if latest, canSend, let user = turn.user {
            let prompt = resendText(user)
            if !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { retry = PhoneRetry(prompt: prompt, warning: resendWarning(turn)) }
        }
        let end = (turn.replies.last ?? turn.user)?["id"].string
        return PhoneTurnActions(copy: text.isEmpty ? nil : text, retry: retry, forkFrom: canFork ? end.flatMap { $0.hasPrefix("live:") ? nil : $0 } : nil)
    }
    /**
     * What resending sends again: the person's words, without the Host's note about an undo. A fork's text record of its
     * source stays unless the Harness forked its own record. The Host counts `prefixLength` in UTF-16 units.
     */
    public static func resendText(_ message: NativeJSON) -> String {
        let text = message["text"].string ?? ""
        let own = message["forkContext"] != .null && message["nativeFork"].bool
            ? message["forkContext"]["prefixLength"].integer ?? 0 : message["importContext"]["prefixLength"].integer ?? 0
        let units = Array(text.utf16)
        var rest = String(decoding: units[min(Int(clamping: own), units.count)...], as: UTF16.self)
        if rest.hasPrefix("[Latch] ") { rest = rest.range(of: "\n\n").map { String(rest[$0.upperBound...]) } ?? "" }
        return rest
    }
    private static let harmless: Set<String> = ["read", "search", "think", "fetch"]
    /** The web's confirmation before resending a turn whose tools may have changed something; nil when none did. */
    public static func resendWarning(_ turn: PhoneTurn) -> String? {
        var edits = 0, commands = 0, others = 0, unknown = 0
        for message in turn.replies where message["role"].string == "tool" {
            let kind = message["tool"]["kind"].string
            if let kind, harmless.contains(kind) { continue }
            let state = message["state"].string
            if state == nil || state == "queued" || state == "awaiting-approval" { continue }
            if PhoneConversation.unrun(message) != nil || (message["tool"]["blocked"] != .null && message["startedAt"] == .null) { continue }
            let output = message["tool"]["output"].string ?? message["text"].string ?? ""
            if state == "running" || output.contains("TOOL_OUTCOME_UNKNOWN") { unknown += 1 }
            else if state == "cancelled" && output.contains("TOOL_NOT_STARTED") { continue }
            else if ["edit", "delete", "move"].contains(kind ?? "") { edits += 1 }
            else if kind == "execute" { commands += 1 }
            else { others += 1 }
        }
        let done = edits + commands + others
        guard done > 0 || unknown > 0 else { return nil }
        var parts: [String] = []
        if done > 0 {
            let what = [edits > 0 ? "修改 \(edits) 个文件" : "", commands > 0 ? "运行 \(commands) 条命令" : "", others > 0 ? "调用 \(others) 次其他工具" : ""].filter { !$0.isEmpty }
            parts.append("上一次已经执行了 \(done) 个操作：" + what.joined(separator: "、") + "。")
        }
        if unknown > 0 { parts.append("上一次有 \(unknown) 个操作结果未知，可能已经执行。") }
        parts.append("重新发送后，Harness 可能再次执行它们。")
        return parts.joined()
    }
}

/** What the send key does while a turn runs: 追加 into it where the Harness takes that now, else 排队 where the Host queues. */
public enum PhoneFollowUp: Equatable, Sendable {
    case send, steer, queue, none
    public static func of(detail: NativeJSON, status: String?, queues: Bool) -> PhoneFollowUp {
        guard status == "running" || status == "waiting-approval" else { return .send }
        if detail["steer"].bool { return .steer }
        return queues ? .queue : .none
    }
}

public struct PhoneConfigRow: Equatable, Sendable, Identifiable {
    public let value: String
    public let name: String
    public let line: String?
    public let current: Bool
    /** Under 更多: the menu's main rows are at most three. */
    public let more: Bool
    public let neverAsks: Bool
    public var id: String { value }
}

/** One of the session's own settings the Harness reported, as a control of the input box. */
public struct PhoneConfigControl: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable { case permission, model, thinking }
    public enum Source: String, Sendable { case launch }
    public let kind: Kind
    public let configId: String
    public let label: String
    public let rows: [PhoneConfigRow]
    /** The current row never asks: shown in amber, with its words. */
    public let amber: Bool
    /** The Host's startup intent is distinct from a value the Harness independently reported. */
    public let source: Source?
    public var note: String? { source == .launch ? "启动设置 · 未独立读回" : nil }
    public var noteDetail: String? { source == .launch ? "这项设置通过进程启动参数应用；Agent 没有独立报告该参数的有效值。" : nil }
    public var id: String { kind.rawValue }
    public var title: String { switch kind { case .permission: "权限"; case .model: "模型"; case .thinking: "思考" } }
}

/**
 * 权限, 模型 and 思考 mid-session, from what the Harness itself reported (`detail.config`): a choice is an intent sent with
 * a requestId, never an optimistic update. Widening the mode is only audited, as everywhere.
 */
public enum PhoneSessionConfig {
    private static let order = ["plan": 0, "ask": 1, "rule": 2, "model": 3, "never": 4]
    private static func values(_ option: NativeJSON) -> [NativeJSON] {
        var seen = Set<String>()
        return option["options"].array.prefix(64).filter { item in item["value"].string.map { seen.insert($0).inserted } ?? false }
    }
    public static func controls(_ detail: NativeJSON, harness: NativeJSON) -> [PhoneConfigControl] {
        let config = detail["config"].array, summary = detail["summary"]
        var result: [PhoneConfigControl] = []
        if summary["mode"].string != "chat", (summary["level"].string ?? harness["level"].string) == "L3",
           let option = config.first(where: { $0["category"].string == "mode" }), let control = permission(option, tiers: detail["permission"]["modeTiers"]) {
            result.append(control)
        }
        for (kind, category) in [(PhoneConfigControl.Kind.model, "model"), (.thinking, "thought_level")] {
            guard let option = config.first(where: { $0["category"].string == category }), let id = option["id"].string else { continue }
            let current = option["currentValue"].string
            let rows = values(option).map { item in
                PhoneConfigRow(value: item["value"].string ?? "", name: item["name"].string ?? item["value"].string ?? "", line: item["description"].string,
                    current: item["value"].string == current, more: false, neverAsks: false)
            }
            guard !rows.isEmpty else { continue }
            result.append(PhoneConfigControl(kind: kind, configId: id, label: rows.first(where: \.current)?.name ?? current ?? "默认", rows: rows, amber: false,
                source: option["source"].string.flatMap { PhoneConfigControl.Source(rawValue: $0) }))
        }
        return result
    }
    /**
     * Where Latch knows the Harness's modes each is titled by its tier, in tier order, and a mode it has no word for is
     * left out unless it is the current one. At most three main rows: asking first, the model's (else the rules'), never.
     */
    private static func permission(_ option: NativeJSON, tiers: NativeJSON) -> PhoneConfigControl? {
        guard let id = option["id"].string else { return nil }
        let known = !tiers.object.isEmpty, current = option["currentValue"].string
        var rows: [(row: PhoneConfigRow, tier: String?)] = values(option).compactMap { item in
            guard let value = item["value"].string else { return nil }
            let tier = tiers[value]["tier"].string.flatMap { order[$0] == nil ? nil : $0 }
            if known && tier == nil && value != current { return nil }
            let name = tiers[value]["name"].string ?? tier.flatMap { PhoneConversation.tierTitles[$0] } ?? item["name"].string ?? value
            return (PhoneConfigRow(value: value, name: name, line: tiers[value]["line"].string ?? item["description"].string, current: value == current, more: false,
                neverAsks: tier == "never"), tier)
        }
        if known { rows.sort { (order[$0.tier ?? ""] ?? 5) < (order[$1.tier ?? ""] ?? 5) } }
        guard !rows.isEmpty else { return nil }
        var main = Set(rows.map(\.row.value))
        if rows.count > 3, rows.contains(where: { $0.tier != nil }) {
            func first(_ tier: String) -> String? { rows.first { $0.tier == tier }?.row.value }
            let picked = [first("ask"), first("model") ?? first("rule"), first("never")].compactMap { $0 }
            main = Set(picked.isEmpty ? [rows[0].row.value] : picked)
        }
        let shown = rows.map { entry in
            PhoneConfigRow(value: entry.row.value, name: entry.row.name, line: entry.row.line, current: entry.row.current,
                more: !entry.row.current && !main.contains(entry.row.value), neverAsks: entry.row.neverAsks)
        }
        let now = shown.first(where: \.current)
        return PhoneConfigControl(kind: .permission, configId: id, label: now?.name ?? current ?? "权限", rows: shown, amber: now?.neverAsks == true,
            source: option["source"].string.flatMap { PhoneConfigControl.Source(rawValue: $0) })
    }
    /** Reasserting a mode or startup setting can replace a stale start choice; other identical settings stay local. */
    public static func write(sessionId: String, configId: String, value: String, detail: NativeJSON) throws -> NativePendingWrite {
        guard LinkBytes.matches(sessionId, "[A-Za-z0-9_-]{1,160}"), !configId.isEmpty, configId.utf8.count <= 128, value.utf8.count <= 1024,
              let option = detail["config"].array.first(where: { $0["id"].string == configId }),
              option["currentValue"].string != value || option["category"].string == "mode" || option["source"].string == "launch",
              values(option).contains(where: { $0["value"].string == value }) else { throw NativeFailure.invalidRecord }
        return try NativePendingWrite(method: .post, path: "/link/api/tasks/\(sessionId)/config", fields: ["configId": .string(configId), "value": .string(value)])
    }
}

public struct PhoneMenuItem: Equatable, Sendable, Identifiable {
    public enum Action: String, Sendable { case rename, pin, copy, clear, archive, delete }
    public let action: Action
    public let label: String
    public let symbol: String
    /** Greyed in place, with the reason beside it. */
    public let disabledReason: String?
    public var id: String { action.rawValue }
}

/**
 * The one session menu, as the web draws it: the conversation's title and a list row held down or swiped show the same
 * items. Only the open session can clear its context. While a turn runs or waits, 清空上下文 and 删除 stay in place,
 * greyed, each with its reason. A phone that may not run sessions has no menu.
 */
public enum PhoneSessionMenu {
    public static func active(_ task: NativeJSON) -> Bool { ["running", "waiting-approval"].contains(task["status"].string ?? "") }
    /** `copy`: the open session's transcript is on screen, so 复制为 Markdown can copy it. */
    public static func sections(_ task: NativeJSON, canRun: Bool, clear: (offered: Bool, clearing: Bool)? = nil, copy: Bool = false) -> [[PhoneMenuItem]] {
        guard canRun, task["personal"] == .null else { return [] }
        let busy = active(task)
        var result: [[PhoneMenuItem]] = [[
            PhoneMenuItem(action: .rename, label: "重命名", symbol: "pencil", disabledReason: nil),
            PhoneMenuItem(action: .pin, label: task["pinned"].bool ? "取消置顶" : "置顶", symbol: task["pinned"].bool ? "pin.slash" : "pin", disabledReason: nil),
        ]]
        if copy { result.append([PhoneMenuItem(action: .copy, label: "复制为 Markdown", symbol: "doc.on.doc", disabledReason: nil)]) }
        if let clear, clear.offered || clear.clearing {
            result.append([PhoneMenuItem(action: .clear, label: clear.clearing ? "保留上下文" : "清空上下文", symbol: "eraser",
                disabledReason: !clear.clearing && busy ? "这一轮结束后才能清空上下文" : nil)])
        }
        result.append([PhoneMenuItem(action: .archive, label: task["archived"].bool ? "取消归档" : "归档", symbol: task["archived"].bool ? "archivebox.fill" : "archivebox", disabledReason: nil)])
        result.append([PhoneMenuItem(action: .delete, label: "删除", symbol: "trash", disabledReason: busy ? "运行中的会话需要先停止" : nil)])
        return result
    }
    /** The question before a delete, in the web's words. */
    public static func deleteQuestion(_ task: NativeJSON) -> String {
        let title = (task["title"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return "删除「" + (title.isEmpty ? "未命名会话" : String(title.prefix(80))) + "」及其全部记录？此操作无法撤销。"
    }
}

/**
 * Rename, pin, archive and delete, as the web sends them: plain requests with no requestId and nothing kept to replay.
 * Whatever happens, the list the Host gives next is the truth.
 */
public struct PhoneSessionRequest: Equatable, Sendable {
    public let method: NativeHTTPMethod
    public let path: String
    public let fields: [String: NativeJSON]
}
public enum PhoneSessionWrite {
    private static func path(_ id: String) throws -> String {
        guard LinkBytes.matches(id, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord }
        return "/link/api/tasks/" + id
    }
    /** The Host trims and counts in UTF-16 units; so does this. */
    public static let titleLimit = 120
    public static func rename(_ id: String, title: String) throws -> PhoneSessionRequest {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf16.count <= titleLimit else { throw NativeFailure.invalidRecord }
        return PhoneSessionRequest(method: .patch, path: try path(id), fields: ["title": .string(trimmed)])
    }
    public static func pin(_ id: String, pinned: Bool) throws -> PhoneSessionRequest {
        PhoneSessionRequest(method: .patch, path: try path(id), fields: ["pinned": .bool(pinned)])
    }
    public static func archive(_ id: String, archived: Bool) throws -> PhoneSessionRequest {
        PhoneSessionRequest(method: .patch, path: try path(id), fields: ["archived": .bool(archived)])
    }
    public static func remove(_ id: String) throws -> PhoneSessionRequest {
        PhoneSessionRequest(method: .delete, path: try path(id), fields: [:])
    }
}

/** A fork's start: what a new session runs on, with the source and the message it keeps up to. */
public struct PhoneForkDraft: Equatable, Sendable, Identifiable {
    public let taskId: String
    public let upToMessageId: String
    public let title: String
    /** The turn it forks from, counted from one, as the Host numbers it. */
    public let turn: Int
    public var id: String { taskId + "\u{0}" + upToMessageId }
    public init(taskId: String, upToMessageId: String, title: String, turn: Int) {
        self.taskId = taskId; self.upToMessageId = upToMessageId; self.title = title; self.turn = turn
    }
    /** The web's words where the draft begins. */
    public static let prompt = "请接着这个会话继续。"
    public var origin: String { "从「" + String(title.prefix(80)) + "」第 \(turn) 轮分叉" }
    /** The source's Harness and project where they can still start; the rest as a new session would. */
    public func choice(_ catalog: NativeJSON, source: NativeJSON) -> PhoneStartChoice {
        var choice = PhoneStart.defaults(catalog)
        let engines = PhoneStart.engines(catalog)
        if let harness = source["harnessId"].string, engines.contains(where: { $0.id == harness }) { choice.harnessId = harness }
        if source["mode"].string == "chat" && PhoneStart.acceptsChat(catalog, harnessId: choice.harnessId) { choice.workspaceId = nil }
        else if let project = source["workspaceId"].string, PhoneStart.projects(catalog).contains(where: { $0.id == project }) { choice.workspaceId = project }
        choice.model = PhoneStart.defaultModel(catalog, harnessId: choice.harnessId)
        return choice
    }
    /**
     * The web's fork draft (`forkChoice.ts`) onto `choice`: the source's model, thinking level and permission row where
     * the chosen Harness offers them, the row being the widest one no wider than the source's, else its strictest. What it
     * could not keep is said in the web's words. `picked`: a model the person chose in the sheet, which wins.
     */
    public func plan(_ catalog: NativeJSON, source detail: NativeJSON, choice base: PhoneStartChoice, picked: PhoneModelChoice? = nil) -> PhoneForkPlan {
        let summary = detail["summary"], config = detail["config"].array
        let harness = PhoneStart.harness(catalog, base.harnessId)
        var plan = PhoneForkPlan(choice: base)
        guard harness != .null else { return plan }
        let name = PhoneStart.engineName(harness), same = harness["id"].string == summary["harnessId"].string
        func reported(_ category: String) -> (id: String, value: String, name: String)? {
            guard let option = config.first(where: { $0["category"].string == category }), let id = option["id"].string,
                  let value = option["currentValue"].string else { return nil }
            return (id, value, option["options"].array.first { $0["value"].string == value }?["name"].string ?? value)
        }
        // What the source ran with: a built-in session's model and level, or the service Latch forwarded another Harness to.
        let builtinSource = summary["providerId"].string != nil && summary["model"].string != nil
        let service: (provider: String, model: String, effort: String?)? = builtinSource
            ? (summary["providerId"].string!, summary["model"].string!, summary["effort"].string)
            : summary["modelRoute"]["providerId"].string.flatMap { provider in summary["modelRoute"]["model"].string.map { (provider, $0, nil) } }
        let sourceModel = builtinSource ? nil : reported("model"), sourceThinking = builtinSource ? nil : reported("thought_level")
        let modeOption = summary["mode"].string == "chat" ? nil : config.first { $0["category"].string == "mode" }
        let drifted = summary["permissionDrift"].bool || detail["permission"]["drift"] != .null
        let modeValue = detail["permission"]["expectedMode"].string ?? (drifted ? nil : modeOption?["currentValue"].string)
        let from: (id: String, value: String, name: String, tier: String?)? = modeOption.flatMap { option in
            guard let id = option["id"].string, let value = modeValue else { return nil }
            let tiers = detail["permission"]["modeTiers"] != .null ? detail["permission"]["modeTiers"] : PhoneStart.harness(catalog, summary["harnessId"].string)["permission"]["modeTiers"]
            return (id, value, option["options"].array.first { $0["value"].string == value }?["name"].string ?? value, tiers[value]["tier"].string)
        }
        let chat = summary["mode"].string == "chat"
        let modelWords = service?.model ?? sourceModel?.name
        let thinkingValue = sourceThinking?.value ?? service?.effort
        let thinkingName = sourceThinking?.name ?? service?.effort.map { PhoneConversation.thinkingWords[$0] ?? $0 }
        var lost: [String] = [], pending: [String] = []
        func listed(_ items: [String]) -> String { items.count > 2 ? items.dropLast().joined(separator: "、") + "与" + items.last! : items.joined(separator: "与") }
        let models = PhoneStart.models(catalog)
        if PhoneStart.usesServices(harness) {
            var model = picked
            if model == nil, let service { model = models.first { $0.providerId == service.provider && $0.model == service.model } }
            if picked == nil, model == nil, let modelWords { lost.append("模型「\(modelWords)」") }
            model = model ?? base.model
            plan.choice.model = model
            if let thinkingValue {
                if let model, PhoneForkPlan.levels(catalog, model).contains(thinkingValue) { plan.effort = thinkingValue }
                else { lost.append("思考「\(thinkingName ?? thinkingValue)」") }
            }
        } else {
            plan.choice.model = nil
            let catalogue = harness["catalogue"], listedOptions = catalogue["options"].array, unread = listedOptions.isEmpty
            func offers(_ option: NativeJSON?, _ value: String?) -> Bool { value != nil && option?["options"].array.contains { $0["value"].string == value } == true }
            var shown = listedOptions
            func find(_ category: String, _ id: String?) -> NativeJSON? {
                (same ? shown.first { id != nil && $0["id"].string == id } : nil) ?? shown.first { $0["category"].string == category }
            }
            let modelOption = find("model", sourceModel?.id)
            // A service is kept only on the same Harness it was forwarded for, while that service still lists the model.
            let forwarded = same && !builtinSource ? service.flatMap { route in models.first { $0.providerId == route.provider && $0.model == route.model } } : nil
            if let forwarded { plan.forwarded = forwarded }
            else if let sourceModel, let modelOption, let id = modelOption["id"].string, offers(modelOption, sourceModel.value) {
                plan.picks.append(PhoneConfigPick(kind: .model, configId: id, value: sourceModel.value, name: sourceModel.name))
                if modelOption["currentValue"].string != sourceModel.value {
                    // On another model the Harness lists what that model reported, or nothing yet.
                    shown = shown.filter { !["thought_level", "model_config"].contains($0["category"].string ?? "") }
                        + (catalogue["perModel"].array.first { $0["model"].string == sourceModel.value }?["options"].array ?? [])
                }
            }
            else if unread && sourceModel != nil { pending.append("模型「\(modelWords ?? "")」") }
            else if let modelWords { lost.append("模型「\(modelWords)」") }
            if let thinkingValue {
                let option = plan.forwarded != nil ? nil : find("thought_level", sourceThinking?.id)
                if offers(option, thinkingValue), let id = option?["id"].string {
                    plan.picks.append(PhoneConfigPick(kind: .thinking, configId: id, value: thinkingValue,
                        name: option?["options"].array.first { $0["value"].string == thinkingValue }?["name"].string ?? thinkingValue))
                }
                else if unread && plan.forwarded == nil { pending.append("思考「\(thinkingName ?? thinkingValue)」") }
                else { lost.append("思考「\(thinkingName ?? thinkingValue)」") }
            }
            let was = from.map { $0.tier.flatMap { PhoneConversation.tierTitles[$0] } ?? $0.name }
            let rows = base.workspaceId != nil && harness["level"].string == "L3"
            let hasRows = harness["permission"] == .null || harness["permission"]["modeTiers"] != .null
            if rows && unread && hasRows, let was { pending.append("权限「\(was)」") }
            let tiers = harness["permission"]["modeTiers"]
            if rows, let option = find("mode", from?.id), let id = option["id"].string {
                let exact = same && offers(option, from?.value) ? from?.value : nil
                var row: (value: String, tier: String)?
                if exact == nil, let tier = from?.tier, tiers != .null {
                    let known = option["options"].array.compactMap { item -> (value: String, tier: String)? in
                        guard let value = item["value"].string, let tier = tiers[value]["tier"].string, PhoneForkPlan.order[tier] != nil else { return nil }
                        return (value, tier)
                    }
                    let limit = PhoneForkPlan.order[tier] ?? 0
                    let stricter = known.filter { PhoneForkPlan.order[$0.tier]! <= limit }
                    row = stricter.max { PhoneForkPlan.order[$0.tier]! < PhoneForkPlan.order[$1.tier]! } ?? known.min { PhoneForkPlan.order[$0.tier]! < PhoneForkPlan.order[$1.tier]! }
                }
                func rowName(_ value: String) -> String {
                    tiers[value]["tier"].string.flatMap { PhoneConversation.tierTitles[$0] } ?? option["options"].array.first { $0["value"].string == value }?["name"].string ?? value
                }
                if let exact {
                    plan.picks.append(PhoneConfigPick(kind: .permission, configId: id, value: exact, name: rowName(exact)))
                } else if let row, let was, let fromTier = from?.tier {
                    plan.picks.append(PhoneConfigPick(kind: .permission, configId: id, value: row.value, name: rowName(row.value)))
                    if row.tier != fromTier {
                        let now = PhoneConversation.tierTitles[row.tier] ?? row.value
                        plan.missed.append(PhoneForkPlan.order[row.tier]! < PhoneForkPlan.order[fromTier]! ? "权限「\(was)」→ 更严的「\(now)」" : "权限「\(was)」→ \(name) 最严的「\(now)」")
                    }
                } else if let was { plan.missed.append("权限「\(was)」→ \(name) 的默认项") }
                else if drifted { plan.missed.append("来源权限被改过，用 \(name) 的默认项") }
                else if chat { plan.missed.append("来源不读写文件，用 \(name) 的默认项") }
            } else if rows && chat { plan.missed.append("来源不读写文件，用 \(name) 的默认项") }
        }
        var lines: [String] = []
        if !lost.isEmpty { lines.append("没有沿用来源会话的" + listed(lost) + "：" + name + " 在这里不能选。") }
        if !pending.isEmpty { lines.append("来源会话的" + listed(pending) + "要等读到 " + name + " 的选项后才能沿用。") }
        plan.missed = lines + plan.missed
        return plan
    }
    public func fields(_ catalog: NativeJSON, plan: PhoneForkPlan, prompt: String) -> [String: NativeJSON] {
        var result = PhoneStart.fields(catalog, choice: plan.choice, prompt: prompt, forwarded: plan.forwarded)
        if let effort = plan.effort, case var .object(model) = result["model"] ?? .null { model["effort"] = .string(effort); result["model"] = .object(model) }
        if !plan.picks.isEmpty {
            result["config"] = .array(plan.picks.map { .object(["configId": .string($0.configId), "value": .string($0.value)]) })
        }
        result["forkOf"] = .object(["taskId": .string(taskId), "upToMessageId": .string(upToMessageId)])
        return result
    }
    /** Where a forked session's transcript says it came from. */
    public static func origin(_ summary: NativeJSON) -> (taskId: String, words: String)? {
        let fork = summary["forkOf"]
        guard let id = fork["taskId"].string, let turn = fork["turn"].integer else { return nil }
        return (id, "从「" + String((fork["title"].string ?? "未命名会话").prefix(80)) + "」第 \(turn) 轮分叉")
    }
}

public struct PhoneConfigPick: Equatable, Sendable {
    public let kind: PhoneConfigControl.Kind
    public let configId: String
    public let value: String
    public let name: String
}
/** What a fork starts on, and what it could not keep from its source. */
public struct PhoneForkPlan: Equatable, Sendable {
    public var choice: PhoneStartChoice
    /** The built-in Harness's thinking level. */
    public var effort: String?
    /** A service Latch forwards another Harness's requests to, shown in the sheet's model row. */
    public var forwarded: PhoneModelChoice?
    public var picks: [PhoneConfigPick] = []
    public var missed: [String] = []
    public init(choice: PhoneStartChoice) { self.choice = choice }
    static let order = ["plan": 0, "ask": 1, "rule": 2, "model": 3, "never": 4]
    /** The thinking levels the owner declared for a service's model. */
    static func levels(_ catalog: NativeJSON, _ model: PhoneModelChoice) -> [String] {
        catalog["providers"].array.first { $0["id"].string == model.providerId }?["modelCapabilities"][model.model]["thinking"].array.compactMap(\.string) ?? []
    }
    public func pick(_ kind: PhoneConfigControl.Kind) -> PhoneConfigPick? { picks.first { $0.kind == kind } }
    /** The sheet's 思考 row: the carried level, else the model's own default. */
    public var thinkingWords: String? { effort.map { PhoneConversation.thinkingWords[$0] ?? $0 } ?? pick(.thinking)?.name }
}

/** 内容中包含, for the query it was asked for. Content: it lives only while the window it was read in is open. */
public struct PhoneContentSearch: Equatable, Sendable {
    public var query = ""
    public var hits: [PhoneSearchHit] = []
    public var truncated = false
    public var loading = false
    public var error: String?
    public init(query: String = "", hits: [PhoneSearchHit] = [], truncated: Bool = false, loading: Bool = false, error: String? = nil) {
        self.query = query; self.hits = hits; self.truncated = truncated; self.loading = loading; self.error = error
    }
}

public enum PhoneSearchRun {
    /** The Host's words when its one search at a time is taken. */
    public static let busyWords = "正在完成一次正文搜索，请稍后再试。"
    /**
     * One query: what an earlier search found stays on screen only for this same query. The Host answers one search at
     * a time, so a 429 waits `pause` and asks again, up to five times, then says so with an empty list. `show` puts a state
     * on screen and answers false once the App has moved on, which ends the run. A closed window is thrown for the App.
     */
    @MainActor public static func run(_ query: String, previous: PhoneContentSearch, attempts: Int = 5,
        search: () async throws -> NativeJSON, pause: () async -> Void, show: (PhoneContentSearch) -> Bool) async throws {
        let kept = previous.query == query ? previous : PhoneContentSearch(query: query)
        guard show(PhoneContentSearch(query: query, hits: kept.hits, truncated: kept.truncated, loading: true)) else { return }
        for attempt in 0..<max(1, attempts) {
            do {
                let results = PhoneSearch.results(try await search())
                _ = show(PhoneContentSearch(query: query, hits: results.hits, truncated: results.truncated))
                return
            } catch {
                if error is CancellationError { return }
                if (error as? NativeFailure) == .expired { throw error }
                if (error as? NativeFailure) == .busy {
                    if attempt < attempts - 1 { await pause(); if Task.isCancelled { return }; continue }
                    // Never another query's hits under this one.
                    _ = show(PhoneContentSearch(query: query, hits: kept.hits, truncated: kept.truncated, error: kept.hits.isEmpty ? busyWords : nil))
                    return
                }
                _ = show(PhoneContentSearch(query: query, error: (error as? NativeFailure)?.errorDescription ?? "暂时无法完成，请稍后重试。"))
                return
            }
        }
    }
}

public struct PhoneSearchHit: Equatable, Sendable, Identifiable {
    public let sessionId: String
    public let messageId: String
    public let title: String
    public let before: String
    public let match: String
    public let after: String
    public let archived: Bool
    public var id: String { sessionId + "\u{0}" + messageId }
}

/** 内容中包含: the Host's full-text hits. They are content, so they live only beside an open window and never in a cache. */
public enum PhoneSearch {
    public static let limit = 30
    public static func query(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.utf16.count > 200 ? nil : trimmed
    }
    public static func results(_ value: NativeJSON) -> (hits: [PhoneSearchHit], truncated: Bool) {
        let hits: [PhoneSearchHit] = value["hits"].array.prefix(limit).compactMap { hit in
            guard let session = hit["sessionId"].string, LinkBytes.matches(session, "[A-Za-z0-9_-]{1,160}"),
                  let message = hit["messageId"].string, !message.isEmpty, message.utf8.count <= 256 else { return nil }
            // The Host counts the match in UTF-16 units; a range that does not fit draws the snippet unmarked.
            let units = Array((hit["snippet"].string ?? "").utf16.prefix(400))
            let start = Int(clamping: hit["match"]["start"].integer ?? 0), end = Int(clamping: hit["match"]["end"].integer ?? 0)
            func text(_ range: Range<Int>) -> String { String(decoding: units[range], as: UTF16.self) }
            let valid = start <= end && end <= units.count
            return PhoneSearchHit(sessionId: session, messageId: message, title: String((hit["title"].string ?? "").prefix(120)),
                before: valid ? text(0..<start) : text(0..<units.count), match: valid ? text(start..<end) : "", after: valid ? text(end..<units.count) : "",
                archived: hit["archived"].bool)
        }
        return (hits, value["truncated"].bool)
    }
}

extension PhoneSessions {
    /** 已归档, newest first. */
    public static func archived(_ tasks: [NativeJSON], query: String = "") -> [NativeJSON] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return tasks.filter { $0["archived"].bool && (needle.isEmpty || ($0["title"].string ?? "").lowercased().contains(needle)) }
            .sorted { (PhoneTime.parse($0["updatedAt"]) ?? .distantPast) > (PhoneTime.parse($1["updatedAt"]) ?? .distantPast) }
    }
    /** The list in 已归档's place: one shelf without a heading. */
    public static func archivedShelves(_ tasks: [NativeJSON], query: String = "") -> [PhoneShelf] {
        let found = archived(tasks, query: query)
        return found.isEmpty ? [] : [PhoneShelf(id: "archived", label: "", tasks: found)]
    }
}
