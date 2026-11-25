import Foundation

/** One returned result in the source's timeline, as this reader may see it. */
public struct PhoneReturnedResult: Equatable, Sendable, Identifiable {
    public let id: String
    public let targetSessionId: String?
    /** Nil when this reader may not read the target. */
    public let summary: String?
    public let evidence: [String]
    public let at: String
    public let removed: Bool
}

/** A message the person may pick as material or evidence. */
public struct PhoneHandoffMessage: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let hash: String
    public init(id: String, label: String, hash: String) { self.id = id; self.label = label; self.hash = hash }
}

/**
 * Handoffs as the web shows them (`apps/web/src/handoffs`): 来自 on the target, 待交回 on its row, 交回结果 once its turn
 * ends, the returned result in the source's timeline, and 交给代码任务… from a turn. States are the Host's answers.
 */
public enum PhoneHandoffs {
    public static func sha256(_ text: String) -> String { LinkBytes.hex(LinkBytes.hash(Data(text.utf8))) }
    static func running(_ task: NativeJSON) -> Bool { ["running", "waiting-approval"].contains(task["status"].string ?? "") }
    /** The handoff this session received: the newest the snapshot lists. */
    public static func incoming(_ snapshot: NativeJSON, sessionId: String?) -> NativeJSON? {
        guard let sessionId else { return nil }
        return snapshot["handoffs"].array.filter { $0["targetSessionId"].string == sessionId }
            .max { ($0["updatedAt"].string ?? "") < ($1["updatedAt"].string ?? "") }
    }
    /** 「来自 <来源会话>」, or 「来自另一个会话」 where this device does not list the source. */
    public static func crumb(_ snapshot: NativeJSON, sessionId: String?) -> (sourceId: String, words: String, listed: Bool)? {
        guard let item = incoming(snapshot, sessionId: sessionId), let source = item["sourceSessionId"].string else { return nil }
        let task = snapshot["tasks"].array.first { $0["id"].string == source }
        let title = (task?["title"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return (source, task == nil ? "来自另一个会话" : "来自 " + String((title.isEmpty ? "未命名会话" : title).prefix(80)), task != nil)
    }
    /** A target whose result waits for the person: started, a return agreed, its turn ended. */
    public static func awaitsReturn(_ handoff: NativeJSON, target: NativeJSON?) -> Bool {
        handoff["status"].string == "started" && handoff["returnScope"].string != "none" && target.map { !running($0) } == true
    }
    public static func awaiting(_ snapshot: NativeJSON) -> Set<String> {
        var result = Set<String>()
        for item in snapshot["handoffs"].array {
            guard let id = item["targetSessionId"].string else { continue }
            if awaitsReturn(item, target: snapshot["tasks"].array.first { $0["id"].string == id }) { result.insert(id) }
        }
        return result
    }
    /** Whether the snapshot names this session in any handoff: only then is its list read. */
    public static func involved(_ snapshot: NativeJSON, sessionId: String) -> String {
        snapshot["handoffs"].array.filter { $0["sourceSessionId"].string == sessionId || $0["targetSessionId"].string == sessionId }
            .map { "\($0["id"].string ?? ""):\($0["status"].string ?? ""):\($0["updatedAt"].string ?? "")" }.joined(separator: "|")
    }
    public static func listPath(_ sessionId: String) throws -> String {
        guard LinkBytes.matches(sessionId, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord }
        return "/link/api/handoffs?sessionId=" + sessionId
    }
    public static func statusWords(_ handoff: NativeJSON) -> String {
        switch handoff["status"].string {
        case "starting": "正在开始"
        case "started": handoff["returnScope"].string == "none" ? "已开始" : "代码会话在做"
        case "start-unknown": "结果未知"
        case "start-failed": "没有开始"
        case "returned": "已交回"
        case "withdrawn": "已撤回"
        case "closed": "已结束"
        default: ""
        }
    }
    /** The handoff the open target hands back through: started by the source, a return agreed, the turn over. */
    public static func returnable(_ handoffs: [NativeJSON], sessionId: String, status: String?) -> NativeJSON? {
        guard !["running", "waiting-approval"].contains(status ?? "") else { return nil }
        return handoffs.first { $0["targetSessionId"].string == sessionId && $0["status"].string == "started" && $0["returnScope"].string != "none" }
    }
    /** The returned results of handoffs this session started, oldest first. */
    public static func results(_ handoffs: [NativeJSON], sessionId: String) -> [PhoneReturnedResult] {
        handoffs.filter { $0["sourceSessionId"].string == sessionId && $0["status"].string == "returned" && $0["result"] != .null }.compactMap { item in
            guard let id = item["id"].string else { return nil }
            let result = item["result"]
            let evidence = result["evidence"].array.prefix(32).map { entry -> String in
                switch entry["kind"].string {
                case "file": entry["file"]["path"].string ?? "文件"
                case "message": "代码会话里的一条消息"
                default: "无权查看"
                }
            }
            return PhoneReturnedResult(id: id, targetSessionId: item["targetSessionId"].string,
                summary: result["summaryWithheld"].bool ? nil : result["summary"].string.map { String($0.prefix(16_000)) },
                evidence: evidence, at: result["at"].string ?? item["updatedAt"].string ?? "", removed: item["contentRemoved"].bool)
        }.sorted { $0.at < $1.at }
    }
    /** Where each result sits: after the last turn that began before it arrived; before every turn, first (key ""). */
    public static func place(_ results: [PhoneReturnedResult], turns: [PhoneTurn]) -> [String: [PhoneReturnedResult]] {
        var placed: [String: [PhoneReturnedResult]] = [:]
        let starts = turns.map { ($0.id, PhoneTime.parse($0.user?["createdAt"] ?? $0.replies.first?["createdAt"] ?? .null)) }
        for result in results {
            let key: String
            if let at = PhoneTime.parse(.string(result.at)) { key = starts.last { $0.1.map { $0 <= at } ?? false }?.0 ?? "" }
            else { key = turns.last?.id ?? "" }
            placed[key, default: []].append(result)
        }
        return placed
    }
    /** The target's last reply, which 交回结果 starts from. */
    public static func defaultSummary(_ messages: [NativeJSON]) -> String {
        let last = messages.last { $0["role"].string == "assistant" && !($0["text"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return String((last?["text"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(16_000))
    }
    /** One line of a message, for a checklist row. */
    public static func line(_ text: String, max: Int = 48) -> String {
        let first = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        return first.count > max ? String(first.prefix(max - 1)) + "…" : first
    }
    /** Evidence the phone offers: the session's last eight messages with text. File evidence needs the file's bytes: 尚未实现 here. */
    public static func evidence(_ messages: [NativeJSON]) -> [PhoneHandoffMessage] {
        messages.filter { ["assistant", "user"].contains($0["role"].string ?? "") && !($0["text"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .suffix(8).compactMap { message in
                guard let id = message["id"].string, !id.hasPrefix("live:") else { return nil }
                let text = message["text"].string ?? ""
                return PhoneHandoffMessage(id: id, label: (message["role"].string == "user" ? "消息 · " : "回复 · ") + line(text), hash: sha256(text))
            }
    }
    /** The messages of a turn a handoff can carry, each fixed at its version. */
    public static func materials(_ turn: PhoneTurn) -> [PhoneHandoffMessage] {
        ([turn.user].compactMap { $0 } + turn.replies).filter { ["assistant", "user"].contains($0["role"].string ?? "") }.compactMap { message in
            let text = message["text"].string ?? ""
            guard let id = message["id"].string, !id.hasPrefix("live:"), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return PhoneHandoffMessage(id: id, label: (message["role"].string == "user" ? "你 · " : "回复 · ") + line(text, max: 40), hash: sha256(text))
        }.prefix(32).map { $0 }
    }
    /** The summary into the composer as quoted text, after what is already there. */
    public static func quoted(_ previous: String, summary: String) -> String {
        let quote = summary.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.isEmpty ? ">" : "> " + $0 }.joined(separator: "\n")
        var head = previous
        while let last = head.last, last.isWhitespace { head.removeLast() }
        return head + (head.isEmpty ? "" : "\n\n") + "交回结果：\n" + quote + "\n\n"
    }
    public static let scopes: [(value: String, label: String)] = [("none", "不交回"), ("summary", "结论"), ("summary-and-evidence", "加证据")]
    public static let scopeFacts = [
        "none": "代码会话照常运行，结果不回到这里；在那边用「结束交接」收尾。",
        "summary": "代码会话结束后，由你在那边把结论交回这个会话。",
        "summary-and-evidence": "代码会话结束后，由你在那边把结论连同选中的文件与消息交回这个会话，各带链接。",
    ]
    /** Sessions an existing-session handoff may go to: listed, not archived, not the source, private only with private. */
    public static func targets(_ tasks: [NativeJSON], source: NativeJSON) -> [NativeJSON] {
        func isPrivate(_ task: NativeJSON) -> Bool { task["agent"] != .null || task["agentPrivate"].bool }
        let privateSource = isPrivate(source)
        return tasks.filter { $0["id"] != source["id"] && !$0["archived"].bool && $0["personal"] == .null && (!privateSource || isPrivate($0)) }
            .sorted { ($0["updatedAt"].string ?? "") > ($1["updatedAt"].string ?? "") }
    }
    /** Why the form cannot go as it is; nil when it can. */
    public static func problem(materials: Int, requirements: String, targetSession: String?, newSession: Bool, harnessId: String?) -> String? {
        if materials == 0 && requirements.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "选一项材料或写下要求" }
        if !newSession && targetSession == nil { return "选一个已有会话" }
        if newSession && harnessId == nil { return "先选 Harness" }
        if requirements.trimmingCharacters(in: .whitespacesAndNewlines).utf8.count > 8192 { return "要求最多 8 KB" }
        return nil
    }
    /** `POST /handoffs`; the locale is always named, so the record says exactly what was asked. */
    public static func create(sourceSessionId: String, materials: [PhoneHandoffMessage], requirements: String, returnScope: String,
        newSession: (projectId: String?, harnessId: String, model: PhoneModelChoice?)?, sessionId: String?) throws -> NativePendingWrite {
        guard LinkBytes.matches(sourceSessionId, "[A-Za-z0-9_-]{1,160}"), scopes.contains(where: { $0.value == returnScope }), materials.count <= 32 else { throw NativeFailure.invalidRecord }
        guard problem(materials: materials.count, requirements: requirements, targetSession: sessionId, newSession: newSession != nil, harnessId: newSession?.harnessId) == nil else { throw NativeFailure.invalidRecord }
        var target: [String: NativeJSON]
        if let newSession {
            target = ["kind": .string("new-session"), "harnessId": .string(newSession.harnessId), "mode": .string(newSession.projectId == nil ? "chat" : "agent")]
            if let project = newSession.projectId { target["projectId"] = .string(project) }
            if let model = newSession.model { target["model"] = .object(["providerId": .string(model.providerId), "model": .string(model.model)]) }
        } else {
            guard let sessionId, LinkBytes.matches(sessionId, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord }
            target = ["kind": .string("session"), "sessionId": .string(sessionId)]
        }
        return try NativePendingWrite(method: .post, path: "/link/api/handoffs", fields: [
            "sourceSessionId": .string(sourceSessionId), "target": .object(target),
            "materials": .array(materials.map { .object(["kind": .string("message"), "messageId": .string($0.id), "hash": .string($0.hash)]) }),
            "requirements": .string(requirements.trimmingCharacters(in: .whitespacesAndNewlines)), "decisions": .array([]),
            "returnScope": .string(returnScope), "locale": .string("zh-CN"),
        ])
    }
    /** `POST /handoffs/:id/return`; evidence goes along only when the agreed scope keeps it. */
    public static func handBack(handoffId: String, summary: String, scope: String, evidence: [PhoneHandoffMessage]) throws -> NativePendingWrite {
        let trimmed = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        guard LinkBytes.matches(handoffId, "[A-Za-z0-9_-]{1,160}"), !trimmed.isEmpty, trimmed.count <= 16_000, scope != "none" else { throw NativeFailure.invalidRecord }
        let items: [NativeJSON] = scope == "summary-and-evidence" ? evidence.prefix(32).map { .object(["kind": .string("message"), "messageId": .string($0.id), "hash": .string($0.hash)]) } : []
        return try NativePendingWrite(method: .post, path: "/link/api/handoffs/\(handoffId)/return", fields: ["summary": .string(trimmed), "evidence": .array(items)])
    }
    public static func pendingWords(_ write: NativePendingWrite) -> String? {
        guard write.path.hasPrefix("/link/api/handoffs") else { return nil }
        return write.path.hasSuffix("/return") ? "交回结果待确认" : "交接结果待确认"
    }
    /** A refusal in the web's words: what changed, or the Host's own message. */
    public static func refusalWords(_ refusal: NativeHostRefusal) -> String {
        switch refusal.code {
        case "handoff-material-changed": "材料在选定后变了，重新打开再交"
        case "handoff-evidence-changed": "证据在选定后变了，重新勾选"
        case "host-updating": "这台电脑正在安装更新"
        default: refusal.message.isEmpty ? "没有交接，请重试。" : refusal.message
        }
    }
}

/** The Host's announcement that it will not answer for a while: why, since when, and when to try again. */
public struct PhoneHostNotice: Equatable, Sendable {
    public let state: String
    public let reason: String
    public let at: Date
    public let retryAfter: Int
    /** The web's words (`hostNoticeCopy`): what the computer is doing, and when the App comes back by itself. */
    public func words(computer: String) -> (title: String, body: String) {
        if state == "sleeping" { return ("\(computer) 已休眠（\(PhoneTime.clock(at)) 起）", "唤醒后自动重连") }
        switch reason {
        case "restart": return ("\(computer) 上的 Latch 正在重启", "几秒后自动重连")
        case "update": return ("\(computer) 上的 Latch 正在更新", "更新完成后自动重连")
        default: return ("\(computer) 上的 Latch 已停止（\(PhoneTime.clock(at)) 起）", "Latch 启动后自动重连")
        }
    }
    /** A `host-state` frame, or nil when it is not one or says the Host is awake. */
    public static func parse(_ data: Data) -> PhoneHostNotice? {
        guard let value = try? NativeJSON.decode(data), value["type"].string == "host-state", let state = value["state"].string,
              ["stopping", "sleeping"].contains(state), let reason = value["reason"].string, ["restart", "update", "sleep", "shutdown"].contains(reason),
              let retry = value["retryAfter"].integer, retry >= 1, retry <= 3600, let at = PhoneTime.parse(value["at"]) else { return nil }
        return PhoneHostNotice(state: state, reason: reason, at: at, retryAfter: Int(retry))
    }
}

/** Plain-text editing of a small session file (CODE-12): the Host writes only on the version that was read. */
public enum PhoneFileEdit {
    public static let limit = 1_048_576
    /** Whether 编辑 shows: the Host offers it for this file, this phone may run, and the text was read whole. */
    public static func offered(_ meta: NativeJSON, canRun: Bool, wholeText: Bool, text: String) -> Bool {
        canRun && wholeText && meta["actions"]["edit"].bool && !meta["secret"].bool && (meta["size"].integer ?? UInt64.max) <= UInt64(limit)
            && fits(text) && !mixedEndings(text)
    }
    /** The version the editor starts from: the SHA-256 of the bytes read. */
    public static func baseHash(_ bytes: Data) -> String { LinkBytes.hex(LinkBytes.hash(bytes)) }
    public static func save(sessionId: String, handle: String, baseHash: String, content: String) throws -> NativePendingWrite {
        guard LinkBytes.matches(sessionId, "[A-Za-z0-9_-]{1,160}"), LinkBytes.matches(handle, "[A-Za-z0-9_-]{22}"),
              LinkBytes.matches(baseHash, "[a-f0-9]{64}"), content.utf8.count <= limit, !content.contains("\u{0}") else { throw NativeFailure.invalidRecord }
        return try NativePendingWrite(method: .put, path: "/link/api/tasks/\(sessionId)/files/\(handle)",
            fields: ["baseHash": .string(baseHash), "content": .string(content)])
    }
    /** The file changed since it was read: shown, never overwritten from here. */
    public static func conflicted(_ refusal: NativeHostRefusal) -> Bool { refusal.code == "file-changed" }
    public static func refusalWords(_ refusal: NativeHostRefusal) -> String {
        switch refusal.code {
        case "file-changed": "文件已在别处修改"
        case "file-turn-running": "Agent 运行中，不能编辑"
        case "file-not-text": "这个文件不是 UTF-8 文本"
        case "file-edit-invalid": "内容含有不能保存的字符"
        default: refusal.message.isEmpty ? "没有保存" : refusal.message
        }
    }
    public static func pendingWords(_ write: NativePendingWrite) -> String? {
        write.method == "PUT" && write.path.contains("/files/") ? "保存结果未知" : nil
    }
    /**
     * A retry the Host answers `file-changed` read the file again under its lock: it is not this text, so this save did not
     * take (a lost success is answered from its receipt for an hour, then as `unchanged`). `file-edit-invalid` is about the
     * text itself, the same for the first try. Anything else, an expired handle included, stays unknown until 核对并放下.
     */
    public static func retryAnswered(_ write: NativePendingWrite) -> @Sendable (NativeHostRefusal) -> Bool {
        guard write.method == "PUT", write.path.contains("/files/") else { return { _ in false } }
        return { ["file-changed", "file-edit-invalid"].contains($0.code) }
    }
    /** The content a pending save carries, and the version it was meant for. */
    public static func pendingSave(_ write: NativePendingWrite) -> (handle: String, content: String)? {
        guard write.method == "PUT", let handle = write.path.split(separator: "/").last.map(String.init),
              let body = try? NativeJSON.decode(write.body), let content = body["content"].string else { return nil }
        return (handle, content)
    }
    /** A text file's shape as the Host reads it (`textShape` in `files/edit.ts`): its BOM, line ending and final newline. */
    public struct TextShape: Equatable, Sendable {
        public let bom: Bool
        public let crlf: Bool
        public let finalNewline: Bool
        public let mixed: Bool
    }
    public static func textShape(_ bytes: Data) -> TextShape? {
        guard bytes.count <= limit else { return nil }
        let bom = bytes.starts(with: [0xEF, 0xBB, 0xBF])
        let body = Array(bom ? bytes.dropFirst(3) : bytes[...])
        guard String(bytes: body, encoding: .utf8) != nil, !body.contains(0) else { return nil }
        var crlf = 0, lf = 0, cr = 0, index = 0
        while index < body.count {
            if body[index] == 0x0D { if index + 1 < body.count && body[index + 1] == 0x0A { crlf += 1; index += 1 } else { cr += 1 } }
            else if body[index] == 0x0A { lf += 1 }
            index += 1
        }
        return TextShape(bom: bom, crlf: crlf > lf, finalNewline: body.last == 0x0A, mixed: [crlf, lf, cr].filter { $0 > 0 }.count > 1)
    }
    /**
     * The bytes the Host writes for `content` in a file of `shape` (`shapeContent`): its own BOM dropped and CRLF made LF,
     * the final newline as the file had it, LF made the file's ending, the file's BOM put back.
     */
    public static func shaped(_ content: String, _ shape: TextShape) -> Data {
        var bytes = Array(content.utf8)
        if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes.removeFirst(3) }
        var text: [UInt8] = [], index = 0
        while index < bytes.count {
            if bytes[index] == 0x0D && index + 1 < bytes.count && bytes[index + 1] == 0x0A { text.append(0x0A); index += 2; continue }
            text.append(bytes[index]); index += 1
        }
        if shape.finalNewline { if !text.isEmpty && text.last != 0x0A { text.append(0x0A) } }
        else if text.last == 0x0A { text.removeLast() }
        if shape.crlf { text = text.flatMap { $0 == 0x0A ? [0x0D, 0x0A] : [$0] } }
        return Data((shape.bom ? [0xEF, 0xBB, 0xBF] : []) + text)
    }
    /**
     * 核对并放下: the file now holds exactly what the Host would have written for this text, in the file's shape. False says
     * only that the file is not this text now; it may have been saved and changed since, so it never means "not saved".
     */
    public static func settled(content: String, current: Data) -> Bool {
        guard let shape = textShape(current) else { return false }
        return shaped(content, shape) == current
    }
    /** What 核对并放下 says. */
    public static func checkWords(saved: Bool) -> String { saved ? "已保存" : "文件现在不是你的修改" }
    public static let uncheckable = "不能核对，到电脑上看"
    /** The JSON body the Host takes is at most 1 MiB: text that would not fit once escaped is not offered for editing. */
    public static func fits(_ text: String) -> Bool {
        guard let body = try? NativeJSON.object(["requestId": .string(String(repeating: "0", count: 36)), "baseHash": .string(String(repeating: "0", count: 64)),
            "content": .string(text)]).encoded() else { return false }
        return body.count <= 1_048_576 - 1024
    }
    /** Mixed CRLF, LF or CR line endings: not edited, as the web, so nothing silently changes them. */
    public static func mixedEndings(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        var crlf = false, lf = false, cr = false, index = 0
        while index < scalars.count {
            if scalars[index] == "\r" { if index + 1 < scalars.count && scalars[index + 1] == "\n" { crlf = true; index += 1 } else { cr = true } }
            else if scalars[index] == "\n" { lf = true }
            index += 1
        }
        return [crlf, lf, cr].filter { $0 }.count > 1
    }
}
