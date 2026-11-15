import Foundation

/**
 * 接入已有会话 (docs/HARNESSES.md#接入已有会话), as the web's `history/model.ts` draws it: whether the new session offers it,
 * the list's and the preview's states, the Harness an import continues in, the write it sends and how its answer reads.
 * Display only: the Host checks every step again. Everything comes from the Harness's own ACP adapter; Latch never reads
 * a CLI's storage, and an imported session is private from the start.
 */

/** A Harness of the project that lists its own earlier sessions, ready to do it. */
public struct PhoneHistorySource: Equatable, Sendable, Identifiable {
    public let harnessId: String
    public let label: String
    public let mark: String?
    public var id: String { harnessId }
}

public enum PhoneHistoryEntry: Equatable, Sendable {
    /** Nothing to offer: no saved project, no Harness that lists, a device that cannot start sessions. */
    case hidden
    /** There is one, but this device cannot see private sessions, which an imported one always is. */
    case locked
    case open([PhoneHistorySource])
}

/** A Harness an import continues in: the source itself (as it was) or another that takes a text rebuild. */
public struct PhoneImportTarget: Equatable, Sendable, Identifiable {
    public enum Mode: String, Sendable { case native, text }
    public let harnessId: String
    public let label: String
    public let mark: String?
    public let mode: Mode
    public var id: String { harnessId }
}

/** One session the Harness lists in the project's primary folder or below: metadata only. */
public struct PhoneHistoryRow: Hashable, Sendable, Identifiable {
    public let handle: String
    public let title: String
    public let updatedAt: String?
    /** Relative to the project's primary folder; empty in the folder itself. */
    public let subdir: String
    public let importedTaskId: String?
    public var id: String { handle }
}

public struct PhoneHistoryList: Equatable, Sendable {
    public let rows: [PhoneHistoryRow]
    public let otherFolders: Int
    public let truncated: Bool
}

public enum PhoneHistoryListView: Equatable, Sendable {
    case loading
    case empty(otherFolders: Int)
    case rows([PhoneHistoryRow], otherFolders: Int, truncated: Bool)
    case notSupported
    /** `agent-auth-required`: the Harness has to log in on the Mac first. */
    case login
    case failed(String)
}

public struct PhoneHistoryMessage: Equatable, Sendable {
    public enum Role: String, Sendable { case user, assistant, tool }
    public let role: Role
    public let text: String
    public let status: String?
    public let clipped: Bool
    /** A tool: its state and that its output is hidden, never the output. */
    public var toolWords: String {
        let state = switch status { case "failed": "失败"; case "cancelled": "已取消"; case "running": "未完成"; default: "完成" }
        return state + " · 输出已隐藏"
    }
}

public struct PhoneHistoryPreview: Equatable, Sendable {
    public let previewId: String
    public let title: String
    public let model: String?
    public let turns: Int
    public let messages: [PhoneHistoryMessage]
    public let truncated: Bool
    /** 「model · N 轮」 above the messages. */
    public var meta: String { [model, "\(turns) 轮"].compactMap { $0 }.joined(separator: " · ") }
}

public enum PhoneHistoryFailure: Equatable, Sendable {
    /** `history-session-busy`: open elsewhere (a terminal, say). Latch never takes it over. */
    case busy
    /** `history-handle-expired`: the listing or preview has to be read again. */
    case expired
    case failed(String)
}

public enum PhoneImportOutcome: Equatable, Sendable {
    /** Brought in, or brought in before (`history-already-imported`): open that session. */
    case open(taskId: String)
    /** A retry of a preview's import refused as `history-handle-expired`: the Host had no receipt, so nothing came in. */
    case notDone
    /** A retry refused as `task-deleted`: it was brought in, and that session has since been deleted. */
    case deletedSince
    case busy
    case expired
    case failed(String)
}

/** What the Host's receipt of an import says (`GET /history/imports/:requestId`). */
public enum PhoneImportReceipt: Equatable, Sendable {
    case done(taskId: String)
    /** Still under way on the Host: keep the write and ask again later. */
    case pending
    /** No receipt: the Host never started it, so nothing was brought in. */
    case none
}

/**
 * The previews this phone asked for and must let go of. The Host holds a session open while a preview lasts and closes
 * it by itself after ten minutes; its `DELETE` needs a content window, so a close that cannot go now waits (in memory)
 * for the next window. A preview an unanswered import names is never closed from here: the import may still need it.
 */
public struct PhoneHistoryCloser: Equatable, Sendable {
    public private(set) var waiting: [String] = []
    public static let limit = 16
    public init() {}
    /** A preview that came back and is not shown (left before it came, superseded, a closed window): close it. */
    public mutating func discard(_ previewId: String, pending: [NativePendingWrite]) { close(previewId, pending: pending) }
    /** Leaving the preview, or a refusal that left it open (`history-already-imported`). */
    public mutating func close(_ previewId: String, pending: [NativePendingWrite]) {
        guard LinkBytes.matches(previewId, "hp_[a-f0-9]{32}"), !Self.held(previewId, by: pending), !waiting.contains(previewId) else { return }
        waiting.append(previewId)
        if waiting.count > Self.limit { waiting.removeFirst(waiting.count - Self.limit) }
    }
    /** What to send now, given the window; what is sent leaves the queue whether or not the Host still had it. */
    public mutating func take(windowOpen: Bool, pending: [NativePendingWrite]) -> [String] {
        guard windowOpen else { return [] }
        let now = waiting.filter { !Self.held($0, by: pending) }
        waiting.removeAll { now.contains($0) }
        return now
    }
    /** Back in the queue after a send that did not reach the Host (the window closed meanwhile). */
    public mutating func requeue(_ previewId: String) { if !waiting.contains(previewId), waiting.count < Self.limit { waiting.append(previewId) } }
    public static func held(_ previewId: String, by pending: [NativePendingWrite]) -> Bool {
        pending.contains { PhoneHistory.isImport($0) && (try? NativeJSON.decode($0.body))?["previewId"].string == previewId }
    }
}

/** A preview the Host opened whose answer came too late to show (another connection, a closed window): close it. */
public struct NativeDroppedPreview: Error, Equatable, Sendable {
    public let previewId: String
    public init(previewId: String) { self.previewId = previewId }
}

/** The header's mark of a session brought in. */
public struct PhoneImportedMark: Equatable, Sendable {
    public let label: String
    public let detail: String
    public let rebuilt: Bool
}

/** The bounded read a listing or preview sends: a POST that writes nothing on record, so it carries no requestId. */
public struct PhoneHistoryRead: Equatable, Sendable {
    public let path: String
    public let fields: [String: NativeJSON]
    public let timeoutSeconds: Int64
}

public enum PhoneHistory {
    public static let entryWords = "接入已有会话"
    public static func lockedWords(computer: String) -> String {
        "接入的会话只对能看项目文件的设备可见。在 \(computer) 上的 Latch 里，为这台设备开启「可以看项目文件」后可用。"
    }
    public static let busyWords = "这个会话正在别处使用"
    public static func busyDetail(_ from: String) -> String { "先在那里退出（例如终端里的 \(from)），再回来接入。Latch 不会接管正在使用的会话。" }
    public static let rebuildWords = "按文字重建，不是原样恢复"
    public static let lostWords = "Harness 找不到原来的会话了"
    public static let hiddenWords = "工具输出和思考不显示"
    /** The bound of a listing (500 sessions or 20 seconds) and of a load (60 seconds), each with the process's start. */
    public static let listTimeout: Int64 = 45
    public static let previewTimeout: Int64 = 90
    public static let importTimeout: Int64 = 90
    public static let importPath = "/link/api/history/imports"

    // MARK: the entry

    public static func entry(_ snapshot: NativeJSON, workspaceId: String?) -> PhoneHistoryEntry {
        let catalog = snapshot["catalog"]
        guard catalog != .null, let workspaceId, workspaceId != "default",
              catalog["workspaces"].array.contains(where: { $0["id"].string == workspaceId }) else { return .hidden }
        guard snapshot["device"]["scopes"].array.contains(.string("run")) else { return .hidden }
        let sources = sources(catalog)
        guard !sources.isEmpty else { return .hidden }
        // The Host offers the feature only to a device that may see private sessions; the device's own word says why not.
        if snapshot["device"]["dataScope"].string != "all" || catalog["features"]["historyImport"].integer != 1 { return .locked }
        return .open(sources)
    }
    static func sources(_ catalog: NativeJSON) -> [PhoneHistorySource] {
        catalog["harnesses"].array.compactMap { harness in
            guard harness["status"].string == "ready", harness["history"]["list"].bool, let id = harness["id"].string else { return nil }
            return PhoneHistorySource(harnessId: id, label: PhoneStart.engineName(harness), mark: PhoneStart.mark(harness))
        }
    }
    private static func target(_ harness: NativeJSON, mode: PhoneImportTarget.Mode) -> PhoneImportTarget? {
        harness["id"].string.map { PhoneImportTarget(harnessId: $0, label: PhoneStart.engineName(harness), mark: PhoneStart.mark(harness), mode: mode) }
    }
    /** The source first, then every other ready Harness a rebuilt session can start on. */
    public static func targets(_ catalog: NativeJSON, sourceId: String) -> [PhoneImportTarget] {
        let ready = catalog["harnesses"].array.filter { $0["status"].string == "ready" }
        let source = ready.first { $0["id"].string == sourceId }
        let others = ready.filter { $0["id"].string != sourceId && $0["history"]["rebuild"].bool }
        return (source.map { [$0] } ?? []).compactMap { target($0, mode: .native) } + others.compactMap { target($0, mode: .text) }
    }
    /** A session brought in as it was whose Harness lost it: every ready Harness a text rebuild can start on, its own first. */
    public static func rebuildTargets(_ catalog: NativeJSON, ownId: String?) -> [PhoneImportTarget] {
        let ready = catalog["harnesses"].array.filter { $0["status"].string == "ready" && $0["history"]["rebuild"].bool }
        return (ready.filter { $0["id"].string == ownId } + ready.filter { $0["id"].string != ownId }).compactMap { target($0, mode: .text) }
    }
    /** The session rebuilt as text from this one, if this device lists it. */
    public static func rebuiltFrom(_ tasks: [NativeJSON], taskId: String) -> NativeJSON? {
        tasks.first { $0["imported"]["fromTaskId"].string == taskId }
    }
    /** 按文字重建 on the stop row: a session brought in as it was, whose prompt the Host refused with `harness-session-lost`. */
    public static func offersRebuild(_ summary: NativeJSON, lost: Bool, snapshot: NativeJSON) -> Bool {
        lost && summary["imported"]["mode"].string == "native" && snapshot["catalog"]["features"]["historyImport"].integer == 1
            && snapshot["device"]["scopes"].array.contains(.string("run"))
    }

    // MARK: the list

    public static func list(_ value: NativeJSON) -> PhoneHistoryList? {
        guard case .array = value["rows"] else { return nil }
        let rows = value["rows"].array.prefix(500).compactMap { row -> PhoneHistoryRow? in
            guard let handle = row["handle"].string, LinkBytes.matches(handle, "hh_[a-f0-9]{32}") else { return nil }
            let taskId = row["importedTaskId"].string.flatMap { LinkBytes.matches($0, "[A-Za-z0-9_-]{1,160}") ? $0 : nil }
            return PhoneHistoryRow(handle: handle, title: String((row["title"].string ?? "").prefix(200)), updatedAt: row["updatedAt"].string,
                subdir: String((row["subdir"].string ?? "").prefix(512)), importedTaskId: taskId)
        }
        return PhoneHistoryList(rows: rows, otherFolders: Int(min(value["otherFolders"].integer ?? 0, 100_000)), truncated: value["truncated"].bool)
    }
    public static func listView(_ list: PhoneHistoryList?, failure: NativeHostRefusal? = nil, error: String? = nil) -> PhoneHistoryListView {
        if let failure {
            if failure.code == "history-not-supported" { return .notSupported }
            if failure.code == "agent-auth-required" { return .login }
            return .failed(failure.message.isEmpty ? "没有读到会话" : failure.message)
        }
        if let error { return .failed(error) }
        guard let list else { return .loading }
        if list.rows.isEmpty { return .empty(otherFolders: list.otherFolders) }
        return .rows(list.rows, otherFolders: list.otherFolders, truncated: list.truncated)
    }
    /** Where a row's session started, relative to the primary folder; the folder's own name for the folder itself. */
    public static func folder(_ row: PhoneHistoryRow, primary: String) -> String {
        let trimmed = row.subdir.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        return trimmed.isEmpty ? primary : trimmed + "/"
    }
    /** The project's primary folder's name. */
    public static func primaryName(_ project: NativeJSON) -> String {
        let path = project["folders"].array.first?["path"].string ?? project["path"].string ?? ""
        return path.split(separator: "/").last.map(String.init) ?? project["name"].string ?? ""
    }
    public static func othersWords(_ count: Int) -> String? { count > 0 ? "另有 \(count) 个在项目的其他文件夹里 · 尚未支持" : nil }
    /** Codex's own listing is of its current model provider; no other Harness that lists has such a limit. */
    public static func scopeDetail(_ source: PhoneHistorySource) -> String {
        let scope = "只列出在这个项目主文件夹（或它下面）开始的会话，不加载内容。"
        return source.mark == "codex" ? "\(scope)\(source.label) 只列出它当前模型服务下的会话。" : scope
    }

    // MARK: the preview

    public static func preview(_ value: NativeJSON) -> PhoneHistoryPreview? {
        guard let id = value["previewId"].string, LinkBytes.matches(id, "hp_[a-f0-9]{32}") else { return nil }
        let messages = value["messages"].array.prefix(40).compactMap { message -> PhoneHistoryMessage? in
            guard let role = message["role"].string.flatMap(PhoneHistoryMessage.Role.init(rawValue:)) else { return nil }
            return PhoneHistoryMessage(role: role, text: String((message["text"].string ?? "").prefix(4096)), status: message["status"].string, clipped: message["clipped"].bool)
        }
        return PhoneHistoryPreview(previewId: id, title: String((value["title"].string ?? "").prefix(200)), model: value["model"].string,
            turns: Int(min(value["turns"].integer ?? 0, 100_000)), messages: messages, truncated: value["truncated"].bool)
    }
    public static func previewFailure(_ refusal: NativeHostRefusal) -> PhoneHistoryFailure {
        if refusal.code == "history-session-busy" { return .busy }
        if refusal.code == "history-handle-expired" { return .expired }
        return .failed(refusal.message.isEmpty ? "没有打开这个会话" : refusal.message)
    }
    public static func previewDetail(count: Int, source: String) -> String {
        "只显示最后 \(count) 条对话和工具名称；像密钥的文字已替换。\(source) 会重新打开这个会话，在它自己的列表里可能排到前面。"
    }
    public static func modeDetail(_ target: PhoneImportTarget, source: String) -> String {
        target.mode == .text
            ? "\(target.label) 只看到对话文字，看不到工具结果、思考和 \(source) 的压缩记录；文件以现在磁盘上的为准。第一条消息会把这段文字发给它用的模型服务。"
            : "\(source) 带着它自己的完整记录继续；按 Latch 的默认权限继续，不沿用原会话的权限。"
    }

    // MARK: requests

    public static func listRead(projectId: String, harnessId: String) throws -> PhoneHistoryRead {
        guard LinkBytes.matches(projectId, "[a-z0-9][a-z0-9_-]{0,63}"), LinkBytes.matches(harnessId, "[A-Za-z0-9][A-Za-z0-9_-]{0,63}") else { throw NativeFailure.invalidRecord }
        return PhoneHistoryRead(path: "/link/api/history/list", fields: ["projectId": .string(projectId), "harnessId": .string(harnessId)], timeoutSeconds: listTimeout)
    }
    public static func previewRead(handle: String) throws -> PhoneHistoryRead {
        guard LinkBytes.matches(handle, "hh_[a-f0-9]{32}") else { throw NativeFailure.invalidRecord }
        return PhoneHistoryRead(path: "/link/api/history/previews", fields: ["handle": .string(handle)], timeoutSeconds: previewTimeout)
    }
    /** `DELETE /history/previews/:id`: the Host holds the session open while a preview lasts. */
    public static func closePath(_ previewId: String) throws -> String {
        guard LinkBytes.matches(previewId, "hp_[a-f0-9]{32}") else { throw NativeFailure.invalidRecord }
        return "/link/api/history/previews/" + previewId
    }
    /** `POST /history/imports { requestId, previewId, harnessId }`; no prompt: a rebuilt session waits for the first message. */
    public static func importWrite(previewId: String, harnessId: String) throws -> NativePendingWrite {
        guard LinkBytes.matches(previewId, "hp_[a-f0-9]{32}") else { throw NativeFailure.invalidRecord }
        return try importWrite(["previewId": .string(previewId)], harnessId: harnessId)
    }
    /** 按文字重建 a session its Harness lost: `{ requestId, fromTaskId, harnessId }`. */
    public static func rebuildWrite(fromTaskId: String, harnessId: String) throws -> NativePendingWrite {
        guard LinkBytes.matches(fromTaskId, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord }
        return try importWrite(["fromTaskId": .string(fromTaskId)], harnessId: harnessId)
    }
    private static func importWrite(_ source: [String: NativeJSON], harnessId: String) throws -> NativePendingWrite {
        guard LinkBytes.matches(harnessId, "[A-Za-z0-9][A-Za-z0-9_-]{0,63}") else { throw NativeFailure.invalidRecord }
        return try NativePendingWrite(method: .post, path: importPath, fields: source.merging(["harnessId": .string(harnessId)]) { a, _ in a })
    }
    /** The unanswered import again when it is for the same source and Harness; nil means a new one. */
    public static func attempt(_ pending: [NativePendingWrite], source: String, harnessId: String) -> NativePendingWrite? {
        pending.first { write in
            guard isImport(write), let body = try? NativeJSON.decode(write.body) else { return false }
            return (body["previewId"].string ?? body["fromTaskId"].string) == source && body["harnessId"].string == harnessId
        }
    }
    /** The preview an import write names, if any. */
    public static func previewOf(_ write: NativePendingWrite) -> String? {
        guard isImport(write) else { return nil }
        return (try? NativeJSON.decode(write.body))?["previewId"].string
    }
    public static func isImport(_ write: NativePendingWrite) -> Bool { write.method == "POST" && write.path == importPath }
    public static func pendingWords(_ write: NativePendingWrite) -> String? { isImport(write) ? "接入结果未确认" : nil }
    public static let notDoneWords = "这次接入没有完成"
    public static let deletedSinceWords = "已接入，但这个会话后来被删除了"
    /**
     * Which refusals of a retry of this import settle it. The Host answers a known request from its receipt (or joins it
     * while it runs) before it looks at the preview, so a retry of a preview's import refused with
     * `history-handle-expired` was never brought in; `task-deleted` comes from a finished receipt whose session was
     * deleted since. Either way nothing is left to send. `history-already-imported` names the session that was.
     */
    public static func retryAnswered(_ write: NativePendingWrite) -> @Sendable (NativeHostRefusal) -> Bool {
        let preview = ((try? NativeJSON.decode(write.body))?["previewId"].string) != nil
        return { refusal in
            if refusal.code == "history-already-imported" { return refusal.details["taskId"].string != nil }
            if refusal.code == "task-deleted" { return true }
            return preview && refusal.code == "history-handle-expired"
        }
    }
    /** `retry`: the refused write had been sent before without an answer. */
    public static func outcome(_ refusal: NativeHostRefusal, retry: Bool = false) -> PhoneImportOutcome {
        if refusal.code == "history-already-imported", let taskId = refusal.details["taskId"].string, LinkBytes.matches(taskId, "[A-Za-z0-9_-]{1,160}") {
            return .open(taskId: taskId)
        }
        if retry && refusal.code == "task-deleted" { return .deletedSince }
        if retry && refusal.code == "history-handle-expired" { return .notDone }
        if refusal.code == "history-session-busy" { return .busy }
        if refusal.code == "history-handle-expired" { return .expired }
        return .failed(refusal.message.isEmpty ? "没有接入" : refusal.message)
    }
    /** `GET /history/imports/:requestId`, for 核对并放下: the receipt says whether an unanswered import happened. */
    public static func receiptPath(_ write: NativePendingWrite) -> String? {
        guard isImport(write), LinkBytes.matches(write.requestId, "[A-Za-z0-9_-]{16,80}") else { return nil }
        return importPath + "/" + write.requestId
    }
    public static func importedTask(_ value: NativeJSON) -> String? {
        value["taskId"].string.flatMap { LinkBytes.matches($0, "[A-Za-z0-9_-]{1,160}") ? $0 : nil }
    }

    // MARK: the session

    /** `harness-session-lost` becomes the stop row with 按文字重建 only for a session brought in as it was. */
    public static func stopsAsLost(_ summary: NativeJSON) -> Bool { summary["imported"]["mode"].string == "native" }
    /** The session a prompt write is for, for the stop row a refused one leaves. */
    public static func promptSession(_ path: String) -> String? {
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count == 5, LinkBytes.matches(path, "/link/api/tasks/[A-Za-z0-9_-]{1,160}/prompt") else { return nil }
        return parts[3]
    }

    /** 「已接入」, and 「已接入 · 按文字重建」 for a text rebuild. */
    public static func mark(_ summary: NativeJSON, sourceLabel: String?) -> PhoneImportedMark? {
        let imported = summary["imported"]
        guard let mode = imported["mode"].string, let raw = imported["from"].string else { return nil }
        let from = sourceLabel ?? raw
        return mode == "native"
            ? PhoneImportedMark(label: "已接入", detail: "从 \(from) 接入 · 原样加载", rebuilt: false)
            : PhoneImportedMark(label: "已接入 · 按文字重建", detail: "从 \(from) 接入 · 按文字重建，不是原样恢复", rebuilt: true)
    }
    /** A text rebuild whose rebuilt conversation still waits for the first message: sending it sends that text too. */
    public static func seedWaiting(_ summary: NativeJSON, messages: [NativeJSON]) -> Bool {
        summary["imported"]["mode"].string == "text" && summary["imported"]["prefixLength"].integer != nil
            && !messages.contains { $0["role"].string == "user" }
    }
    public static func seedWords(service: String) -> String { rebuildWords + " · 第一条消息会把重建的对话文字一起发给 " + service }
    /**
     * The first message of a text rebuild, split where the Host says: the rebuilt conversation (folded under
     * 「按 <来源> 会话的文字重建」) and the person's own words. The Host counts `prefixLength` in UTF-16 units.
     */
    public static func fold(_ message: NativeJSON) -> (summary: String, context: String, rest: String)? {
        let context = message["importContext"]
        guard let from = context["from"].string, let length = context["prefixLength"].integer else { return nil }
        let units = Array((message["text"].string ?? "").utf16)
        let cut = min(Int(clamping: length), units.count)
        return ("按 \(from) 会话的文字重建", String(decoding: units[..<cut], as: UTF16.self), String(decoding: units[cut...], as: UTF16.self))
    }
}
