import Foundation

/** A prompt and everything that answered it, up to the next prompt. */
public struct PhoneTurn: Equatable, Sendable, Identifiable {
    public let id: String
    public let user: NativeJSON?
    public var replies: [NativeJSON]
}
public enum PhoneWorkItem: Equatable, Sendable {
    case tool(NativeJSON), thinking(NativeJSON), reads([NativeJSON])
}
public enum PhoneTurnBlock: Equatable, Sendable {
    case work(key: String, items: [PhoneWorkItem])
    case prose(NativeJSON), note(NativeJSON)
}
public struct PhoneToolLabel: Equatable, Sendable {
    public let verb: String?
    public let object: String
    public let mono: Bool
}
public struct PhoneDiffStat: Equatable, Sendable { public let add: Int; public let del: Int }
public struct PhoneDiffLine: Equatable, Sendable {
    public enum Kind: Sendable { case context, add, remove }
    public let kind: Kind
    public let text: String
}
public struct PhoneChangedFile: Equatable, Sendable, Identifiable {
    public let id: String
    public let path: String
    public let root: String?
    public let add: Int?
    public let del: Int?
    public let deleted: Bool
}
public struct PhoneTurnSummary: Equatable, Sendable {
    public let files: [PhoneChangedFile]
    public let add: Int?
    public let del: Int?
}
public struct PhoneRunStatus: Equatable, Sendable {
    public enum Tone: Sendable { case plain, amber, quiet }
    public enum Action: Sendable { case keepWaiting, stop }
    public let tone: Tone
    public let text: String
    public let clock: String?
    public let actions: [Action]
}
public struct PhoneRunEnd: Equatable, Sendable {
    public let failed: Bool
    public let text: String
    public let unknown: [String]
}
/** One of the approval's other choices, under 更多. */
public struct PhoneApprovalChoice: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let allows: Bool
}
public struct PhoneApprovalGate: Equatable, Sendable {
    public let heading: String
    /** The Host's reason for a risky request, on its own line. */
    public let riskClause: String?
    public let allowOption: String?
    public let canAllow: Bool
    /** Why this phone may not allow it. */
    public let refusal: String?
    /** The primary button's words: 允许, or the web's words for the allow choice it stands for. */
    public var allowLabel = "允许"
    /** 更多: the choices besides one reject and one allow, never while the request holds text that may read as something else. */
    public var more: [PhoneApprovalChoice] = []
    /** The request holds text that may read as something else: allowing is no longer the prominent choice, as on the web. */
    public var hidden = false
}

public enum PhoneConversation {
    public static func isLive(_ detail: NativeJSON) -> Bool { !(detail["liveText"].string ?? "").isEmpty || !(detail["liveReasoning"].string ?? "").isEmpty }
    /** Committed messages plus the streaming reply under the ID it will keep once committed. */
    public static func rendered(_ detail: NativeJSON) -> [NativeJSON] {
        var messages = detail["messages"].array
        guard isLive(detail) else { return messages }
        let id = detail["liveMessageId"].string ?? "live:" + (detail["summary"]["id"].string ?? "")
        if messages.contains(where: { $0["id"].string == id }) { return messages }
        var live: [String: NativeJSON] = ["id": .string(id), "role": .string("assistant"), "text": detail["liveText"]]
        if !(detail["liveReasoning"].string ?? "").isEmpty { live["reasoning"] = detail["liveReasoning"] }
        messages.append(.object(live))
        return messages
    }
    public static func turns(_ messages: [NativeJSON]) -> [PhoneTurn] {
        var result: [PhoneTurn] = []
        for message in messages {
            // Text added to a running turn (`steered`) stays in that turn.
            if message["role"].string == "user" && !message["steered"].bool { result.append(PhoneTurn(id: message["id"].string ?? "user:\(result.count)", user: message, replies: [])) }
            else if result.isEmpty { result.append(PhoneTurn(id: "lead:" + (message["id"].string ?? ""), user: nil, replies: [message])) }
            else { result[result.count - 1].replies.append(message) }
        }
        return result
    }
    public static func toolKind(_ message: NativeJSON) -> String {
        if let kind = message["tool"]["kind"].string { return kind }
        let name = (message["toolName"].string ?? "").lowercased()
        func has(_ words: String) -> Bool { name.range(of: words, options: .regularExpression) != nil }
        if has("write|edit|patch|update|create") { return "edit" }
        if has("read|cat|open|view") { return "read" }
        if has("list|search|find|grep|glob") { return "search" }
        if has("shell|exec|run|command|bash|task") { return "execute" }
        if has("fetch|http|web|url") { return "fetch" }
        if has("delete|remove") { return "delete" }
        return "other"
    }
    private static func isQuestion(_ message: NativeJSON) -> Bool { message["toolName"].string == "ask_user" }
    private static func plainRead(_ message: NativeJSON) -> Bool { message["state"].string == "completed" && toolKind(message) == "read" && message["tool"]["decision"] == .null }
    private static func joinReads(_ items: [PhoneWorkItem]) -> [PhoneWorkItem] {
        var result: [PhoneWorkItem] = [], reads: [NativeJSON] = []
        func flush() {
            if reads.count > 1 { result.append(.reads(reads)) } else if let only = reads.first { result.append(.tool(only)) }
            reads = []
        }
        for item in items {
            if case let .tool(message) = item, plainRead(message) { reads.append(message) } else { flush(); result.append(item) }
        }
        flush()
        return result
    }
    /** A settled turn joins its consecutive reads; a live one keeps each on its own row, so rows do not jump as they finish. */
    public static func blocks(_ turn: PhoneTurn, settled: Bool) -> [PhoneTurnBlock] {
        var blocks: [PhoneTurnBlock] = [], work: [PhoneWorkItem] = []
        func key(_ item: PhoneWorkItem) -> String {
            switch item {
            case let .tool(message), let .thinking(message): return message["id"].string ?? ""
            case let .reads(messages): return messages.first?["id"].string ?? ""
            }
        }
        func flush() {
            guard let first = work.first else { return }
            blocks.append(.work(key: "work:" + key(first), items: settled ? joinReads(work) : work)); work = []
        }
        for message in turn.replies {
            let role = message["role"].string
            if role == "tool" && !isQuestion(message) { work.append(.tool(message)); continue }
            if role == "assistant" {
                if !(message["reasoning"].string ?? "").isEmpty { work.append(.thinking(message)) }
                if (message["text"].string ?? "").isEmpty && message["attachments"].array.isEmpty { continue }
                flush(); blocks.append(.prose(message)); continue
            }
            flush(); blocks.append(.note(message))
        }
        flush()
        return blocks
    }
    public static func turnText(_ turn: PhoneTurn) -> String {
        turn.replies.filter { $0["role"].string == "assistant" && !($0["text"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .compactMap { $0["text"].string }.joined(separator: "\n\n")
    }
    /** How a settled turn ended; the latest turn's status says it, an earlier one is read from its own messages. */
    public static func outcome(_ turn: PhoneTurn, latestStatus: String?) -> String {
        if let latestStatus {
            switch latestStatus { case "failed": return "failed"; case "cancelled": return "stopped"; case "interrupted": return "interrupted"; default: return "completed" }
        }
        if turn.replies.contains(where: { $0["role"].string == "assistant" && $0["state"].string == "cancelled" }) { return "stopped" }
        if turn.replies.contains(where: { ["assistant", "system"].contains($0["role"].string ?? "") && $0["state"].string == "failed" }) { return "failed" }
        return "completed"
    }
    /** A failed or stopped turn stays open, and so does one that ended without a word, because its last row is all it said. */
    public static func workFolds(_ turn: PhoneTurn, outcome: String) -> Bool {
        guard outcome == "completed" else { return false }
        return turn.replies.contains { $0["role"].string == "tool" && !isQuestion($0) } && !turnText(turn).isEmpty
    }
    public static func unrun(_ message: NativeJSON) -> String? {
        let state = message["state"].string
        guard state == "failed" || state == "cancelled", message["startedAt"] == .null else { return nil }
        if let outcome = message["tool"]["decision"]["outcome"].string { return outcome == "allowed" ? nil : outcome }
        return state == "failed" && (message["tool"]["output"].string ?? message["text"].string ?? "").hasPrefix("APPROVAL_REJECTED:") ? "rejected" : nil
    }
    private static let judgedWords = ["approved": "放行", "denied": "拦下", "none": "没有判断", "unasked": "没有问你"]
    /**
     * A call no person was asked about while the Harness's own model decides, as the web names it: a review of a request with
     * its verdict (`review`), or a call that ran unasked. Never a person's approval.
     */
    public static func judgement(_ message: NativeJSON) -> (review: Bool, by: String, words: String)? {
        let judged = message["tool"]["judged"]
        guard let by = judged["by"].string, let outcome = judged["outcome"].string, let words = judgedWords[outcome] else { return nil }
        // A call the Harness refused itself is that call, not a review of its own.
        return (outcome != "unasked" && message["tool"]["blocked"] == .null, by, words)
    }
    /**
     * A call the Harness refused itself before it ran, as the web says it: its model (`model`) or its own rules or mode stopped it,
     * with the Harness's own words for why on one line. It reports failed, but nothing ran and nothing broke.
     */
    public static func blocked(_ message: NativeJSON) -> (model: Bool, line: String)? {
        let block = message["tool"]["blocked"]
        guard message["state"].string == "failed", let by = block["by"].string, let source = block["source"].string, source == "model" || source == "rule" else { return nil }
        var reason = (block["reason"].string ?? "").split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        if reason.count > 120 { reason = String(reason.prefix(120)) + "…" }
        if source == "model" { return (true, by + " 的模型审阅" + (reason.isEmpty ? "拦下了这次调用" : "：" + reason)) }
        return (false, "被 " + by + " 自己的规则或当前模式拦下" + (reason.isEmpty ? "" : "：" + reason))
    }
    /** 已工作 2 分 13 秒, with what the fold must not hide. */
    public static func foldWords(_ turn: PhoneTurn) -> String {
        let spent = PhoneTime.duration(seconds: Double(turn.user?["turn"]["activeMs"].integer ?? 0) / 1000)
        let tools = turn.replies.filter { $0["role"].string == "tool" }
        let rejected = tools.filter { unrun($0) == "rejected" }.count
        // A review that came to 拦下 reports itself failed, as does a call the Harness refused itself; neither is a failed step.
        let failed = tools.filter { $0["state"].string == "failed" && unrun($0) == nil && judgement($0)?.review != true && blocked($0) == nil }.count
        // What the Harness's own model or rules stopped happened without the person, its subagents' too.
        func count(_ messages: [NativeJSON], _ matches: (NativeJSON) -> Bool) -> Int {
            messages.filter { $0["role"].string == "tool" }.reduce(0) { sum, message in
                sum + (matches(message["tool"]) ? 1 : 0) + count(message["subagent"]["steps"].array, matches)
            }
        }
        let denied = count(turn.replies) { $0["judged"]["outcome"].string == "denied" || $0["blocked"]["source"].string == "model" }
        let ruled = count(turn.replies) { $0["blocked"]["source"].string == "rule" }
        return (["已工作" + (spent.map { " " + $0 } ?? "")] + (failed > 0 ? ["\(failed) 步失败"] : []) + (rejected > 0 ? ["\(rejected) 步被拒绝"] : [])
            + (denied > 0 ? ["模型拦下 \(denied) 次"] : []) + (ruled > 0 ? ["规则拦下 \(ruled) 次"] : [])).joined(separator: " · ")
    }
    /** One line for a failed row: the first line it reported, without the runtime's code, and cut. */
    public static func failureReason(_ message: NativeJSON) -> String {
        var output = message["tool"]["output"].string ?? message["text"].string ?? ""
        if output.hasPrefix("APPROVAL_REJECTED:") { output = String(output.dropFirst(18)) }
        var line = output.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        if let code = line.range(of: "^TOOL_[A-Z_]+:\\s*", options: .regularExpression) { line.removeSubrange(code) }
        if line.isEmpty { return "没有成功" }
        return line.count > 120 ? String(line.prefix(120)) + "…" : line
    }
    private static func basename(_ path: String) -> String {
        var value = path
        while value.count > 1, value.hasSuffix("/") { value.removeLast() }
        return value.split(separator: "/").last.map(String.init) ?? path
    }
    private static func argument(_ input: NativeJSON, _ names: [String]) -> String? {
        guard let text = input.string, text.utf8.count <= 65_536, let value = try? NativeJSON.decode(Data(text.utf8)), case .object = value else { return nil }
        for name in names {
            if let found = value[name].string, !found.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !found.contains("\n") { return found }
        }
        return nil
    }
    private static func titledObject(_ tool: NativeJSON) -> (object: String, path: Bool)? {
        if let located = tool["locations"].array.first?.string { return (located, true) }
        let groups: [([String], Bool)] = [(["path", "file", "file_path", "filePath"], true), (["command", "cmd"], false), (["query", "pattern", "q"], false), (["url"], false)]
        for (keys, path) in groups {
            if let value = argument(tool["input"], keys) {
                let trimmed = value.trimmingCharacters(in: .whitespaces)
                return trimmed == "." || trimmed == "./" ? nil : (value, path)
            }
        }
        return nil
    }
    private static let verbs = ["read": "读取", "edit": "编辑", "delete": "删除", "move": "移动", "search": "搜索", "execute": "运行", "fetch": "获取"]
    /** A verb by the tool's kind and its object; a tool Latch can read nothing from shows its raw name in mono, never a guess. */
    public static func toolLabel(_ message: NativeJSON) -> PhoneToolLabel {
        if let title = message["subagent"]["title"].string { return PhoneToolLabel(verb: "子 Agent", object: title, mono: false) }
        if let judged = judgement(message), judged.review { return PhoneToolLabel(verb: nil, object: judged.by + " 的模型审阅", mono: false) }
        let tool = message["tool"], diffs = tool["diffs"].array
        if diffs.count > 1 { return PhoneToolLabel(verb: "编辑", object: "\(diffs.count) 个文件", mono: false) }
        if let diff = diffs.first {
            let name = basename(diff["path"].string ?? "")
            if diff["previous"].string != "none" || !(diff["oldText"].string ?? "").isEmpty { return PhoneToolLabel(verb: "编辑", object: name, mono: false) }
            return PhoneToolLabel(verb: "新建", object: "\(name) · \(lines(diff["newText"].string ?? "").count) 行", mono: false)
        }
        if let title = tool["toolTitle"].string {
            guard let found = titledObject(tool) else { return PhoneToolLabel(verb: nil, object: title, mono: false) }
            return PhoneToolLabel(verb: title, object: found.path ? basename(found.object) : found.object, mono: !found.path)
        }
        let kind = toolKind(message), verb = verbs[kind]
        var object: String?, mono = true
        switch kind {
        case "execute": object = argument(tool["input"], ["command", "cmd"])
        case "read", "edit", "delete", "move":
            object = (tool["locations"].array.first?.string ?? argument(tool["input"], ["path", "file", "file_path", "filePath"])).map(basename); mono = false
        case "search": object = argument(tool["input"], ["query", "pattern", "q"])
        case "fetch": object = argument(tool["input"], ["url"])
        default: break
        }
        if let object, let verb { return PhoneToolLabel(verb: verb, object: object, mono: mono) }
        if let title = tool["title"].string, title != message["toolName"].string { return PhoneToolLabel(verb: nil, object: title, mono: false) }
        if let name = message["toolName"].string { return PhoneToolLabel(verb: nil, object: name, mono: true) }
        return PhoneToolLabel(verb: nil, object: "工具调用", mono: false)
    }
    /** A request that touches several places says how many: the first alone would read as all of it. */
    public static func toolHeading(_ tool: NativeJSON, toolName: String?) -> String {
        let places = tool["locations"].array.count, more = places > 1 ? " 等 \(places) 处" : ""
        if let title = tool["toolTitle"].string {
            if let found = titledObject(tool) { return title + " " + found.object + more }
            return title + more
        }
        return (tool["title"].string ?? toolName ?? "工具调用") + more
    }
    private static func lines(_ text: String) -> [String] {
        if text.isEmpty { return [] }
        var result = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        if result.last == "" { result.removeLast() }
        return result
    }
    /** Line diff. Above a million LCS cells the changed middle reads as a full replacement, as the desktop draws it. */
    public static func diffLines(old: String?, new: String) -> [PhoneDiffLine] {
        let a = lines(old ?? ""), b = lines(new)
        var start = 0
        while start < a.count, start < b.count, a[start] == b[start] { start += 1 }
        var endA = a.count, endB = b.count
        while endA > start, endB > start, a[endA - 1] == b[endB - 1] { endA -= 1; endB -= 1 }
        var result = a[0..<start].map { PhoneDiffLine(kind: .context, text: $0) }
        let midA = Array(a[start..<endA]), midB = Array(b[start..<endB]), m = midA.count, n = midB.count
        if m * n > 1_000_000 {
            result += midA.map { PhoneDiffLine(kind: .remove, text: $0) } + midB.map { PhoneDiffLine(kind: .add, text: $0) }
        } else {
            let width = n + 1
            var table = [UInt32](repeating: 0, count: (m + 1) * width)
            if m > 0, n > 0 {
                for i in stride(from: m - 1, through: 0, by: -1) {
                    for j in stride(from: n - 1, through: 0, by: -1) {
                        table[i * width + j] = midA[i] == midB[j] ? table[(i + 1) * width + j + 1] + 1 : max(table[(i + 1) * width + j], table[i * width + j + 1])
                    }
                }
            }
            var i = 0, j = 0
            while i < m, j < n {
                if midA[i] == midB[j] { result.append(PhoneDiffLine(kind: .context, text: midA[i])); i += 1; j += 1 }
                else if table[(i + 1) * width + j] >= table[i * width + j + 1] { result.append(PhoneDiffLine(kind: .remove, text: midA[i])); i += 1 }
                else { result.append(PhoneDiffLine(kind: .add, text: midB[j])); j += 1 }
            }
            result += midA[i...].map { PhoneDiffLine(kind: .remove, text: $0) } + midB[j...].map { PhoneDiffLine(kind: .add, text: $0) }
        }
        result += a[endA...].map { PhoneDiffLine(kind: .context, text: $0) }
        return result
    }
    public static func diffStat(_ tool: NativeJSON) -> PhoneDiffStat? {
        let diffs = tool["diffs"].array
        guard !diffs.isEmpty else { return nil }
        var add = 0, del = 0
        for diff in diffs {
            for line in diffLines(old: diff["oldText"].string, new: diff["newText"].string ?? "") {
                if line.kind == .add { add += 1 } else if line.kind == .remove { del += 1 }
            }
        }
        return PhoneDiffStat(add: add, del: del)
    }
    private static func applied(_ message: NativeJSON) -> [NativeJSON] {
        let state = message["state"].string
        if state == "awaiting-approval" || state == "queued" || unrun(message) != nil || blocked(message) != nil { return [] }
        return message["tool"]["diffs"].array
    }
    /** Whether a session has any file to list, without counting a single line of its diffs. */
    public static func hasFiles(_ detail: NativeJSON) -> Bool {
        detail["messages"].array.contains { message in
            guard message["role"].string != "user" else { return false }
            return applied(message).contains { $0["path"].string != nil } || message["outputs"].array.contains { $0["change"].string != "deleted" && $0["path"].string != nil }
        }
    }
    /**
     * What a turn's tools edited and what the folders watched during its run saw. A call its approval kept from running changed
     * nothing, so it does not count; a watched file carries no line counts because other writers share the folder.
     */
    public static func summary(_ turn: PhoneTurn, outputs: [NativeJSON], scope: PhoneFileScope = PhoneFileScope()) -> PhoneTurnSummary {
        var order: [String] = [], added: [String: Int] = [:], removed: [String: Int] = [:]
        var references: [String: (path: String, root: String?)] = [:]
        for message in turn.replies where message["role"].string == "tool" {
            for diff in applied(message) {
                guard let path = diff["path"].string else { continue }
                let reference = scope.reference(path: path, root: nil), key = reference.id
                if added[key] == nil {
                    order.append(key); added[key] = 0; removed[key] = 0
                    references[key] = (reference.path, reference.root)
                }
                for line in diffLines(old: diff["oldText"].string, new: diff["newText"].string ?? "") {
                    if line.kind == .add { added[key, default: 0] += 1 } else if line.kind == .remove { removed[key, default: 0] += 1 }
                }
            }
        }
        var files = order.compactMap { key -> PhoneChangedFile? in
            guard let reference = references[key] else { return nil }
            return PhoneChangedFile(id: key, path: reference.path, root: reference.root, add: added[key], del: removed[key], deleted: false)
        }
        var seen = Set(order)
        for file in outputs {
            guard let path = file["path"].string else { continue }
            let reference = scope.reference(path: path, root: file["root"].string)
            guard seen.insert(reference.id).inserted else { continue }
            files.append(PhoneChangedFile(id: reference.id, path: reference.path, root: reference.root, add: nil, del: nil, deleted: file["change"].string == "deleted"))
        }
        let counted = !files.isEmpty && files.allSatisfy { $0.add != nil }
        return PhoneTurnSummary(files: files, add: counted ? files.reduce(0) { $0 + ($1.add ?? 0) } : nil, del: counted ? files.reduce(0) { $0 + ($1.del ?? 0) } : nil)
    }
    /** Under the person's latest bubble, until the agent starts answering. */
    public static func delivery(_ detail: NativeJSON, turn: PhoneTurn) -> String? {
        let activity = detail["summary"]["live"]["activity"].string
        guard let activity, (detail["liveText"].string ?? "").isEmpty, turnText(turn).isEmpty else { return nil }
        return activity == "starting" ? "Mac 已收到" : "Agent 已开始"
    }
    private static func minutes(_ seconds: TimeInterval) -> String { "\(max(1, Int(seconds / 60))) 分钟" }
    /** The line under a running turn: what is really happening, never only that time passes. */
    public static func runStatus(_ detail: NativeJSON, stopping: Bool, engine: String, hostNow: Date) -> PhoneRunStatus {
        let live = detail["summary"]["live"], activity = detail["activity"]["phase"].string
        if stopping || activity == "cancelling" || live["activity"].string == "cancelling" {
            return PhoneRunStatus(tone: .plain, text: "正在停止…", clock: nil, actions: [])
        }
        if !detail["questions"].array.isEmpty { return PhoneRunStatus(tone: .quiet, text: "等你回答", clock: nil, actions: []) }
        if !detail["approvals"].array.isEmpty || detail["summary"]["status"].string == "waiting-approval" || activity == "approval" {
            return PhoneRunStatus(tone: .quiet, text: "需要你允许", clock: nil, actions: [])
        }
        if PhoneSessions.stuckOnRequest(live) { return PhoneRunStatus(tone: .amber, text: engine + " 发来不支持的请求", clock: nil, actions: [.stop]) }
        if live["silent"].bool {
            let quiet = hostNow.timeIntervalSince(PhoneTime.parse(live["lastEventAt"]) ?? hostNow)
            let commandLike = ["command", "tool"].contains(live["activity"].string ?? "")
            let text = commandLike ? (live["commandName"].string ?? "命令") + " · \(minutes(quiet))没有输出" : "等模型回应 · \(minutes(quiet))没有新内容"
            return PhoneRunStatus(tone: .amber, text: text, clock: nil, actions: [.keepWaiting, .stop])
        }
        if activity == "starting" {
            let slow = PhoneTime.parse(detail["activity"]["since"]).map { hostNow.timeIntervalSince($0) >= 10 } ?? false
            return PhoneRunStatus(tone: .plain, text: slow ? engine + " 启动较慢，仍在等待进程就绪…" : "正在启动 " + engine + "…", clock: nil, actions: [])
        }
        if live == .null, let last = PhoneTime.parse(detail["lastOutputAt"]), hostNow.timeIntervalSince(last) > 120 {
            return PhoneRunStatus(tone: .amber, text: minutes(hostNow.timeIntervalSince(last)) + "没有新输出", clock: nil, actions: [.stop])
        }
        let elapsed = PhoneSessions.runElapsed(started: detail["runStartedAt"], waited: detail["runWaitMs"], waiting: detail["runWaitingSince"], hostNow: hostNow)
        let running = detail["messages"].array.last { $0["role"].string == "tool" && $0["state"].string == "running" && $0["subagent"] == .null }
        let command = running.flatMap { toolKind($0) == "execute" ? toolLabel($0).object : nil } ?? (live["activity"].string == "command" ? live["commandName"].string : nil)
        return PhoneRunStatus(tone: .plain, text: command.map { "命令运行中 · " + $0 } ?? "运行中", clock: elapsed.map { PhoneTime.runClock(seconds: $0) }, actions: [])
    }
    public static func runEnd(_ summary: NativeJSON, engine: String) -> PhoneRunEnd? {
        let end = summary["runEnd"]
        guard let reason = end["reason"].string else { return nil }
        let unknown = end["unknownResults"].array.compactMap { $0["name"].string }
        let count = Int(end["unknownResultCount"].integer ?? UInt64(unknown.count))
        let uncertain = count > 0 ? " · 这 \(count) 条命令结果未知，请核对" : ""
        switch reason {
        case "process-exited": return PhoneRunEnd(failed: true, text: engine + " 已退出 · 这一轮没有完成" + uncertain, unknown: unknown)
        case "login-required": return PhoneRunEnd(failed: true, text: engine + " 还没登录 · 在 Mac 的终端里登录后重试", unknown: unknown)
        case "forced-stop": return PhoneRunEnd(failed: false, text: "已强制停止" + uncertain, unknown: unknown)
        case "host-stopped": return PhoneRunEnd(failed: false, text: "Latch 重启时中断" + uncertain, unknown: unknown)
        case "turn-ended": return count > 0 ? PhoneRunEnd(failed: false, text: engine + " 结束了这一轮" + uncertain, unknown: unknown) : nil
        default: return nil
        }
    }
    private static let riskWords = ["code-root": "Latch 自己的代码", "protected-path": "受保护的文件", "outside-workspace": "在项目文件夹之外",
        "unresolved-path": "不是项目里的相对路径", "unlisted-tool": "Latch 不认识的工具", "unparsable-arguments": "参数无法解析",
        "sensitive-field": "密码等敏感输入框", "mcp-tool": "远程 MCP 服务器的工具"]
    private static let optionWords = ["reject_once": "拒绝", "allow_once": "允许一次", "reject_always": "始终拒绝", "allow_always": "本会话始终允许"]
    /** The web's words on an option: an agent's ask shows the product's words for its kind; every other request comes in the Host's. */
    private static func optionLabel(_ option: NativeJSON, advisory: Bool) -> String {
        let kind = option["kind"].string ?? ""
        if kind == "allow_once" { return "允许" }
        if kind == "allow_always" { return "这个会话都允许这类操作" }
        if advisory, let words = optionWords[kind] { return words }
        return option["label"].string ?? optionWords[kind] ?? "拒绝"
    }
    /**
     * Whether any text of the request holds a character that draws as nothing or as something else. Stricter than the
     * web's escape: any control, format, private-use or unassigned scalar counts, emoji joiners too.
     */
    public static func hidesText(_ approval: NativeJSON) -> Bool {
        let tool = approval["tool"]
        // Everything the drawer can show: the heading, each place, the arguments and every diff.
        let texts = [toolHeading(tool, toolName: approval["toolName"].string), approval["toolName"].string, approval["reason"].string, approval["subagent"].string,
            tool["input"].string ?? approval["arguments"].string, tool["title"].string, tool["toolTitle"].string] + tool["locations"].array.map(\.string)
            + tool["diffs"].array.flatMap { [$0["path"].string, $0["newText"].string, $0["oldText"].string] }
        return texts.contains { text in (text ?? "").unicodeScalars.contains(where: hidden) }
    }
    private static func hidden(_ scalar: Unicode.Scalar) -> Bool {
        if scalar == "\n" || scalar == "\t" || scalar == "\r" { return false }
        switch scalar.properties.generalCategory {
        case .control, .format, .privateUse, .surrogate, .unassigned, .lineSeparator, .paragraphSeparator: return true
        default: return false
        }
    }
    /** The text with each hidden character drawn as `\u{XXXX}`, as the web marks them. */
    public static func visible(_ text: String) -> String {
        var result = ""
        for scalar in text.unicodeScalars {
            if hidden(scalar) { result += "\\u{" + String(scalar.value, radix: 16, uppercase: true) + "}" } else { result.unicodeScalars.append(scalar) }
        }
        return result
    }
    /** A diff with its path and text marked the same way. */
    public static func visibleDiff(_ diff: NativeJSON) -> NativeJSON {
        var object = diff.object
        for key in ["path", "newText", "oldText"] { if let text = object[key]?.string { object[key] = .string(visible(text)) } }
        return .object(object)
    }
    public static let hiddenNote = "含有不可见字符，已标出"
    /**
     * What this phone may do with an approval, by its own scopes, as the web decides it: an agent's question needs `run`,
     * an ordinary step of the built-in engine `approve:standard`, a high-risk one `approve:elevated`. An ordinary step
     * offers every choice the Host gave; an agent's ask and a high-risk step only reject or allow once. The primary allow
     * is the once-choice, else the first allow; the rest go under 更多. A request it cannot allow says so plainly.
     */
    public static func approvalGate(_ approval: NativeJSON, canApproveStandard: Bool, canApproveElevated: Bool, canRun: Bool) -> PhoneApprovalGate {
        // A subagent's request says whose it is: its call is no row of the session's own.
        let asker = approval["subagent"].string.map { "子 Agent \($0) · " } ?? ""
        let heading = asker + toolHeading(approval["tool"], toolName: approval["toolName"].string)
        let options = approval["options"].array.filter { $0["id"].string != nil && $0["kind"].string != nil }
        let advisory = approval["advisory"].bool
        let ordinary = approval["risk"].string == "R1" && !advisory
        let clause: String? = !ordinary && !advisory ? riskWords[approval["riskReason"].string ?? ""] ?? "高风险" : nil
        let allowed = advisory ? canRun : ordinary ? canApproveStandard : canApproveElevated
        let allows: (NativeJSON) -> Bool = { $0["kind"].string?.hasPrefix("allow") == true }
        let rejects = options.filter { !allows($0) }
        let offered = !allowed ? rejects : ordinary ? options : rejects + options.filter { $0["kind"].string == "allow_once" }
        let reject = rejects.first { $0["kind"].string == "reject_once" } ?? rejects.first
        let allow = offered.first { $0["kind"].string == "allow_once" } ?? offered.first(where: allows)
        let hidden = hidesText(approval)
        let more = hidden ? [] : offered.compactMap { option -> PhoneApprovalChoice? in
            guard option != reject, option != allow, let id = option["id"].string else { return nil }
            return PhoneApprovalChoice(id: id, label: optionLabel(option, advisory: advisory), allows: allows(option))
        }
        guard allowed else {
            return PhoneApprovalGate(heading: heading, riskClause: clause, allowOption: nil, canAllow: false, refusal: "这台手机没有允许的权限", more: more, hidden: hidden)
        }
        guard options.isEmpty || allow != nil else {
            return PhoneApprovalGate(heading: heading, riskClause: clause, allowOption: nil, canAllow: false, refusal: "这一步不能只允许一次", more: more, hidden: hidden)
        }
        return PhoneApprovalGate(heading: heading, riskClause: clause, allowOption: allow?["id"].string, canAllow: true, refusal: nil,
            allowLabel: allow.map { optionLabel($0, advisory: advisory) } ?? "允许", more: more, hidden: hidden)
    }
    /** What the Host would refuse in a rejection's note, said before sending. The Host also refuses invisible characters, and its word stands. */
    public static let rejectionNoteLimit = 500
    public static func rejectionNoteTooLong(_ text: String) -> Bool {
        text.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count > rejectionNoteLimit
    }
    /** Whether this phone may type into the session, and the plain line in place of the field when it may not. */
    public static func inputGate(summary: NativeJSON, permission: NativeJSON, canRun: Bool, connected: Bool) -> String? {
        // Latch no longer runs an assistant's private context, so nothing can continue its session.
        if summary["personal"] != .null { return "这个会话来自已移除的 Agent，只能查看" }
        if !connected { return "Mac 不在线" }
        if summary["permissionDrift"].bool || permission["drift"] != .null { return "这个会话的权限变了，已停止接受输入" }
        if !canRun { return "这台手机不能发送消息" }
        return nil
    }
    /** Latch's word for each tier of a Harness's modes, as the web menu titles them. */
    public static let tierTitles = ["plan": "只看不改", "ask": "先问你", "rule": "按规则放行", "model": "由模型判断", "never": "不再询问"]
    /** Harness, a 权限 away from the default, branch, and usage from half the context up. */
    public static func subtitle(_ detail: NativeJSON, engine: String) -> (parts: [String], neverAsks: Bool) {
        let summary = detail["summary"], permission = detail["permission"]
        var parts = [engine], neverAsks = false
        let level = permission["level"].string ?? summary["level"].string
        if level == "L3" {
            let mode = detail["config"].array.first { $0["category"].string == "mode" }
            if let mode, let current = mode["currentValue"].string {
                let tier = permission["modeTiers"][current]["tier"].string
                let standing = permission["defaultMode"].string ?? permission["expectedMode"].string
                if tier == "never" { neverAsks = true; parts.append(tierTitles["never"]!) }
                else if current != standing {
                    parts.append(tier.flatMap { tierTitles[$0] } ?? mode["options"].array.first { $0["value"].string == current }?["name"].string ?? current)
                }
            } else if permission["approvals"].string == "none" { parts.append("由 " + engine + " 决定") }
            else if permission != .null, permission["readback"].string != "mode" { parts.append("权限无法确认") }
        }
        if let branch = summary["branch"].string { parts.append(branch) }
        if let used = detail["usageReport"]["contextUsed"].integer, let size = detail["usageReport"]["contextSize"].integer, size > 0 {
            let percent = Int((Double(used) / Double(size) * 100).rounded())
            if percent >= 50 { parts.append("\(percent)%") }
        }
        return (parts, neverAsks)
    }
    /** The line drawn above a turn whose prompt began a new context. */
    public static func divider(_ turn: PhoneTurn) -> String? { turn.user?["freshContext"].bool == true ? "清空了上下文" : nil }
    /** Why the next message starts a new context whether or not it asks: the Host already let go of the old one. */
    public static func clearedNote(_ detail: NativeJSON, engine: String) -> (title: String, line: String)? {
        detail["contextCleared"].bool ? ("下一条消息开始新的上下文", "上下文已经清空，" + engine + " 看不到之前的消息，记录仍留在这里。") : nil
    }
    /** The model a turn's first step used, as the author line names it. */
    public static func turnModel(_ turn: PhoneTurn) -> String? { modelStep(turn)?["model"].string }
    private static func modelStep(_ turn: PhoneTurn) -> NativeJSON? {
        turn.replies.first { $0["role"].string == "assistant" && !($0["model"].string ?? "").isEmpty }
    }
    public static let thinkingWords = ["none": "不思考", "minimal": "最少", "low": "低", "medium": "中", "high": "高", "xhigh": "超高", "max": "最高"]
    /**
     * Where the model or thinking level changed from the turn before, by turn ID: what changed, as `from → to`. Only a
     * value the Host recorded on both sides counts; a turn with no answer carries the last one recorded across it.
     */
    public static func switches(_ turns: [PhoneTurn]) -> [String: String] {
        var result: [String: String] = [:]
        var model: String?, thinking: String?
        for turn in turns {
            guard let step = modelStep(turn), let next = step["model"].string else { continue }
            let nextThinking = step["thinking"].string.map { thinkingWords[$0] ?? $0 }
            let fromThinking = thinking.flatMap { level in nextThinking.flatMap { $0 == level ? nil : level } }
            let fromModel = model.flatMap { $0 == next ? nil : $0 }
            if let fromModel, let fromThinking, let nextThinking { result[turn.id] = "\(fromModel) · \(fromThinking) → \(next) · \(nextThinking)" }
            else if let fromModel { result[turn.id] = "模型 \(fromModel) → \(next)" }
            else if let fromThinking, let nextThinking { result[turn.id] = "思考 \(fromThinking) → \(nextThinking)" }
            let modelChanged = fromModel != nil
            model = next
            // A model without levels says nothing about the next one's.
            thinking = nextThinking ?? (modelChanged ? nil : thinking)
        }
        return result
    }
}
