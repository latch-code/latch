import Foundation

/** A retry the Host refused without settling it: the write stays unknown, and this is the line shown under it. */
public struct NativeUnsettledRefusal: Error, Equatable, Sendable {
    public let refusal: NativeHostRefusal
    public init(refusal: NativeHostRefusal) { self.refusal = refusal }
}

/** A refusal the Host explained: its fixed code, its words and the details it carries (a hook's name, exit code and output). */
public struct NativeHostRefusal: Error, Equatable, Sendable {
    public let status: Int
    public let code: String
    public let message: String
    public let details: NativeJSON
    public init(status: Int, code: String, message: String, details: NativeJSON) {
        self.status = status; self.code = code; self.message = message; self.details = details
    }
    /**
     * 5xx answers that say, for certain, that the Host accepted nothing: it refused before recording the request. The same
     * list as `NOT_ACCEPTED_5XX` in @latch/protocol (docs/STREAMING.md「确定的拒绝」); any other 5xx is result unknown.
     */
    public static let notAccepted5xx: Set<String> = [
        "audit-unavailable", "presence-unavailable", "agent-busy", "agent-start-failed", "agent-refused", "agent-paused",
        "agent-handshake-timeout", "model-gateway-unavailable",
    ]
    /** A definite refusal: any 4xx but 408, or a 5xx whose code is in `notAccepted5xx`. */
    public static func refusedBeforeAccepting(status: Int, code: String?) -> Bool {
        if (400..<500).contains(status) { return status != 408 }
        guard status >= 500, let code else { return false }
        return notAccepted5xx.contains(code)
    }
    /** From a definite refusal's body `{ error, message, ...details }`: a 4xx, or a 5xx that accepted nothing; nil otherwise. */
    public static func parse(status: Int, body: Data) -> NativeHostRefusal? {
        guard let value = try? NativeJSON.decode(body), let code = value["error"].string, LinkBytes.matches(code, "[a-z0-9-]{1,64}"),
              (400..<500).contains(status) || refusedBeforeAccepting(status: status, code: code) else { return nil }
        return NativeHostRefusal(status: status, code: code, message: String((value["message"].string ?? "").prefix(400)), details: value)
    }
    /** Whether an answer leaves a write's result unknown: timeouts and any 5xx but those that accepted nothing. */
    public static func leavesUnknown(status: Int, body: Data) -> Bool {
        if status == 408 { return true }
        guard status >= 500 else { return false }
        return parse(status: status, body: body) == nil
    }
}

public enum PhoneDeliveryGroup: String, Sendable, CaseIterable {
    case staged, unstaged, untracked, conflicted
    public var title: String { switch self { case .staged: "已暂存"; case .unstaged: "未暂存"; case .untracked: "未跟踪"; case .conflicted: "冲突" } }
}

public struct PhoneDeliveryRow: Equatable, Sendable, Identifiable {
    public let path: String
    /** 新增, 修改, 删除, 类型变化, 未跟踪, 冲突. */
    public let word: String
    /** Pressing its box unstages it (true) or stages it (false). */
    public let staged: Bool
    public var id: String { (staged ? "s\u{0}" : "u\u{0}") + path }
}

/** The session repository as the 交付 tab reads it (`GitDeliveryState`). */
public struct PhoneGitState: Equatable, Sendable {
    public let branch: String?
    public let head: String?
    public let upstream: String?
    public let ahead: Int
    public let behind: Int
    /** When the repository last fetched: `behind` is as of then, and says nothing without it. */
    public let fetchedAt: String?
    public let staged: [PhoneDeliveryRow]
    public let unstaged: [PhoneDeliveryRow]
    public let untracked: [String]
    public let conflicted: [String]
    public let more: Int
    public let operation: String?
    public let running: (kind: String, hook: String?)?
    public let hooks: [String]
    public let filters: Bool
    public let remote: String?
    public static func == (a: Self, b: Self) -> Bool {
        a.branch == b.branch && a.head == b.head && a.upstream == b.upstream && a.ahead == b.ahead && a.behind == b.behind && a.fetchedAt == b.fetchedAt && a.staged == b.staged
            && a.unstaged == b.unstaged && a.untracked == b.untracked && a.conflicted == b.conflicted && a.more == b.more && a.operation == b.operation
            && a.running?.kind == b.running?.kind && a.running?.hook == b.running?.hook && a.hooks == b.hooks && a.filters == b.filters && a.remote == b.remote
    }
    static let words = ["A": "新增", "M": "修改", "D": "删除", "T": "类型变化"]
    public init?(_ value: NativeJSON) {
        guard case .object = value else { return nil }
        func files(_ list: NativeJSON, staged: Bool) -> [PhoneDeliveryRow] {
            list.array.prefix(2000).compactMap { file in
                guard let path = file["path"].string, let word = file["status"].string.flatMap({ Self.words[$0] }) else { return nil }
                return PhoneDeliveryRow(path: path, word: word, staged: staged)
            }
        }
        branch = value["branch"].string; head = value["head"].string; upstream = value["upstream"].string
        ahead = Int(clamping: value["ahead"].integer ?? 0); behind = Int(clamping: value["behind"].integer ?? 0)
        fetchedAt = value["fetchedAt"].string
        staged = files(value["staged"], staged: true); unstaged = files(value["unstaged"], staged: false)
        untracked = value["untracked"].array.prefix(2000).compactMap(\.string); conflicted = value["conflicted"].array.prefix(2000).compactMap(\.string)
        more = Int(clamping: value["more"].integer ?? 0); operation = value["gitOperation"].string
        running = value["running"]["kind"].string.map { ($0, value["running"]["hook"].string) }
        hooks = value["hooks"].array.prefix(64).compactMap(\.string); filters = value["filters"].bool; remote = value["remote"].string
    }
    public func rows(_ group: PhoneDeliveryGroup) -> [PhoneDeliveryRow] {
        switch group {
        case .staged: staged
        case .unstaged: unstaged
        case .untracked: untracked.map { PhoneDeliveryRow(path: $0, word: "未跟踪", staged: false) }
        case .conflicted: conflicted.map { PhoneDeliveryRow(path: $0, word: "冲突", staged: false) }
        }
    }
    public var changedCount: Int { unstaged.count + untracked.count + conflicted.count }
    /** Every path a 暂存全部 stages, each once, in order. */
    public var stageAllPaths: [String] {
        var seen = Set<String>()
        return (unstaged.map(\.path) + untracked + conflicted).filter { seen.insert($0).inserted }
    }
    /** A push has somewhere to go and something to take there; without an upstream the branch is new on the remote. */
    public var canPush: Bool { branch != nil && head != nil && remote != nil && (upstream == nil || ahead > 0) }
    public var upstreamOther: Bool { upstream != nil && remote != nil && branch != nil && upstream != "\(remote!)/\(branch!)" }
    public var pushLabel: String { upstream != nil && ahead > 0 ? "推送 \(ahead) 个提交" : "推送" }
    /** 新分支, 领先 and 落后, or 已是最新, as the web's `aheadBehind`: behind only with the last fetch's time. */
    public var aheadBehind: String {
        guard upstream != nil else { return "新分支" }
        let known = fetchedAt != nil
        let words = [ahead > 0 ? "领先 \(ahead)" : "", known && behind > 0 ? "落后 \(behind)" : ""].filter { !$0.isEmpty }
        if !words.isEmpty { return words.joined(separator: " · ") }
        return known ? "已是最新" : "已推送"
    }
}

/** The one blue button of 提交. */
public enum PhoneDeliveryPrimary: Equatable, Sendable {
    case stage(label: String, paths: [String])
    case commit(label: String)
    case push(label: String)
    public var label: String { switch self { case let .stage(label, _), let .commit(label), let .push(label): label } }
}

/** A refusal or failure in the web's short words; `tone` neutral is not a failure. */
public struct PhoneDeliveryCopy: Equatable, Sendable {
    public enum Tone: String, Sendable { case neutral, warn, failed }
    public let label: String
    public let tone: Tone
    public let detail: String?
}

/**
 * The phone's 提交 page, as the web's 交付 tab (`panel/delivery`): four groups, the one blue button, the fixed reasons in
 * the web's words, the hook card and its excerpt for the draft. Stage and unstage go one at a time, each with its own
 * request ID; the rows move only by what the Host reads back.
 */
public enum PhoneDelivery {
    static let operationWords = ["merge": "合并", "rebase": "变基", "cherry-pick": "拣选", "revert": "还原", "unmerged": "合并"]
    public static func operationNote(_ operation: String?) -> String {
        if let operation, operation != "unmerged", let word = operationWords[operation] { return word + "进行中，在终端里完成" }
        return "合并/变基进行中，在终端里完成"
    }
    static let runningWords = ["stage": "暂存中…", "unstage": "取消暂存中…", "commit": "提交中…", "push": "推送中…", "pr": "创建 PR 中…"]
    public static func runningLabel(kind: String, hook: String?) -> String {
        let word = runningWords[kind] ?? "进行中…"
        return hook.map { word + " " + $0 } ?? word
    }
    /**
     * 暂存全部, then 提交 N 个文件, then 推送. `justCommitted`: right after this page's commit, the files left out were left
     * out on purpose, so 推送 comes next while there is somewhere to push.
     */
    public static func primary(_ state: PhoneGitState, justCommitted: Bool) -> PhoneDeliveryPrimary? {
        if justCommitted && state.staged.isEmpty && state.conflicted.isEmpty && state.canPush { return .push(label: state.pushLabel) }
        if !state.staged.isEmpty { return .commit(label: "提交 \(state.staged.count) 个文件") }
        if state.changedCount > 0 { return .stage(label: "暂存全部", paths: state.stageAllPaths) }
        if state.canPush { return .push(label: state.pushLabel) }
        return nil
    }
    /** The line beside the foot's button. */
    public static func footNote(_ state: PhoneGitState) -> String? {
        if !state.staged.isEmpty {
            let left = state.changedCount
            return left > 0 ? "只提交已暂存的 · 未暂存的 \(left) 个文件不提交" : "\(state.staged.count) 个文件已暂存"
        }
        if state.changedCount > 0 { return "\(state.changedCount) 个文件未暂存" }
        if state.canPush { return state.upstream.map { "领先 \($0) \(state.ahead) 个提交" } ?? "这个分支还不在远端" }
        if state.head != nil && state.remote == nil { return "已提交，未推送" }
        return nil
    }
    public static func copy(_ code: String, operation: String? = nil) -> PhoneDeliveryCopy? {
        func c(_ label: String, _ tone: PhoneDeliveryCopy.Tone, _ detail: String? = nil) -> PhoneDeliveryCopy { PhoneDeliveryCopy(label: label, tone: tone, detail: detail) }
        switch code {
        case "git-turn-running": return c("Agent 正在改这个文件夹", .neutral, "这一轮结束后再暂存或提交；推送不受影响。")
        case "git-operation-in-progress": return c(operationNote(operation), .warn)
        case "host-updating": return c("这台电脑正在安装更新", .neutral)
        case "git-busy": return c("另一个交付操作正在进行", .neutral)
        case "git-nothing-staged": return c("没有暂存的文件", .neutral)
        case "git-conflicted": return c("有冲突的文件", .warn, "先在终端里解决冲突，再暂存这些文件。")
        case "git-identity-missing": return c("Git 不知道提交者是谁", .warn, "在终端里设置 user.name 与 user.email 后再提交。")
        case "git-no-remote": return c("没有远端，提交留在本地", .neutral)
        case "git-detached": return c("不在任何分支上", .neutral, "HEAD 是分离的，推送需要一个分支。")
        case "git-no-commit": return c("还没有提交", .neutral)
        case "git-upstream-other-branch":
            return c("上游是另一个分支", .neutral, "推送总是推到远端上与当前分支同名的分支，这个分支的上游指向别的名字。在终端里推送，或改成同名的上游。")
        case "git-remote-invalid": return c("推送的远端不在仓库配置里", .failed, "检查 pushRemote、pushDefault 与上游的远端名。")
        case "git-commit-failed": return c("提交失败", .failed)
        case "git-commit-not-made": return c("没有生成提交，可以重新提交", .neutral)
        case "git-push-auth": return c("远端不接受凭据", .failed, "在终端里检查这个仓库的登录或 SSH 密钥。")
        case "git-push-non-fast-forward": return c("远端有你没有的提交", .failed, "先拉取并合并（git pull），再推送。Latch 从不强制推送。")
        case "git-push-remote-rejected": return c("远端钩子拒绝了推送", .failed)
        case "git-push-unreachable": return c("连不上远端", .failed)
        case "git-push-host-key": return c("远端主机密钥没有通过验证", .failed, "在终端里连一次这个远端，核对并记下主机密钥。")
        case "git-push-failed": return c("推送失败", .failed)
        case "git-stage-failed": return c("暂存失败", .failed, "Git 拒绝了这些文件，例如被忽略的文件。")
        case "git-receipt-unsaved": return c("没能记下这次请求，没有执行", .failed)
        case "git-not-repository": return c("会话文件夹不是 Git 仓库的顶层", .neutral)
        case "git-no-git": return c("这台电脑上找不到 Git", .failed)
        case "git-folder-unavailable", "workspace-changed": return c("会话文件夹不可用", .failed)
        case "git-paths-invalid": return c("路径无效", .failed)
        case "request-conflict": return c("同一请求换了内容，没有执行", .failed)
        case "git-failed": return c("Git 没有完成", .failed)
        default: return nil
        }
    }
    /** The fine print of 「运行仓库钩子」. */
    public static func hooksDetail(_ state: PhoneGitState?) -> String {
        let account = "提交与推送以你在这台电脑上的账户运行，用你的凭据，与在终端里相同；这不是沙箱。"
        guard let state else { return "仓库的钩子会照常运行。" + account }
        let hooks = state.hooks.isEmpty ? "仓库里没有可执行的钩子。" : "仓库的钩子：" + state.hooks.joined(separator: "、") + "。"
        return hooks + (state.filters ? "仓库配置了 filter 驱动（如 Git LFS），暂存与提交时照常运行。" : "") + account
    }
    static func fence(_ text: String) -> String {
        var longest = 0, run = 0
        for character in text { if character == "`" { run += 1; longest = max(longest, run) } else { run = 0 } }
        return String(repeating: "`", count: max(3, longest + 1))
    }
    /** The hook failure as a fenced excerpt for the composer draft: its last 80 lines, at most 8,000 characters. Never sent by itself. */
    public static func hookExcerpt(hook: String?, exitCode: UInt64?, tail: String?, push: Bool) -> String {
        let name = hook ?? (push ? "pre-push" : "pre-commit")
        let exit = exitCode.map { "，退出码 \($0)" } ?? ""
        var text = tail ?? ""
        while let last = text.last, last.isWhitespace { text.removeLast() }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        if lines.count > 80 { text = lines.suffix(80).joined(separator: "\n") }
        let units = Array(text.utf16)
        if units.count > 8000 { text = String(decoding: units[(units.count - 8000)...], as: UTF16.self) }
        let marks = fence(text)
        let head = push ? "推送前的钩子 \(name) 没通过\(exit)，没有推送：" : "提交钩子 \(name) 没通过\(exit)，没有生成提交："
        return head + "\n\n" + marks + "text\n" + text + "\n" + marks
    }
    /** A commit or push refusal shown as the red hook card rather than a line. */
    public static func isHookCard(_ refusal: NativeHostRefusal) -> Bool { refusal.code == "git-hook-failed" }

    // MARK: routes and writes

    private static func base(_ id: String) throws -> String {
        guard LinkBytes.matches(id, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord }
        return "/link/api/tasks/" + id + "/git"
    }
    public static func statePath(_ id: String) throws -> String { try base(id) }
    public static func stage(sessionId: String, paths: [String], unstage: Bool = false) throws -> NativePendingWrite {
        guard !paths.isEmpty, paths.count <= 2000, paths.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 4096 }) else { throw NativeFailure.invalidRecord }
        return try NativePendingWrite(method: .post, path: try base(sessionId) + (unstage ? "/unstage" : "/stage"), fields: ["paths": .array(paths.map { .string($0) })])
    }
    public static func commit(sessionId: String, message: String, skipHooks: Bool) throws -> NativePendingWrite {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 65_536 else { throw NativeFailure.invalidRecord }
        var fields: [String: NativeJSON] = ["message": .string(trimmed)]
        if skipHooks { fields["skipHooks"] = .bool(true) }
        return try NativePendingWrite(method: .post, path: try base(sessionId) + "/commit", fields: fields)
    }
    public static func push(sessionId: String) throws -> NativePendingWrite {
        try NativePendingWrite(method: .post, path: try base(sessionId) + "/push", fields: [:])
    }
    /** The Host gives a commit with its hooks 10 minutes, a push and a stage 2; the phone waits a little longer. */
    public static func timeout(_ write: NativePendingWrite) -> Int64 {
        if write.path.hasSuffix("/git/commit") { return 630 }
        // A push first asks the remote (`ls-remote`, up to 2 minutes) and then pushes (up to 2 more).
        if write.path.hasSuffix("/git/push") { return 270 }
        if isStage(write) { return 150 }
        return 15
    }
    /**
     * What settles a retried commit or push besides an answer from the Host's receipt (`replay`): the web's
     * `SETTLES_RETRY` (`panel/delivery/model.ts`). A commit settles on its receipt alone; a push also on the failures the
     * Host gives only after reading the remote and finding the commit missing.
     */
    static let settlesRetry: [String: Set<String>] = [
        "commit": [],
        "push": ["git-push-remote-rejected", "git-hook-failed", "git-push-auth", "git-push-host-key", "git-push-unreachable", "git-push-failed"],
    ]
    /**
     * Whether a refusal of a retry settles this write, as the web's `writeEnd` with `retry`. Anything else (a route's 400,
     * 403 or 429, a session check, `host-updating`, `git-result-unknown`) says nothing about the first attempt and keeps it
     * unknown with its request ID, for the person to retry or abandon. Stage and unstage keep no failure receipt, so no
     * refusal of their retry settles them.
     */
    public static func retryAnswered(_ write: NativePendingWrite) -> @Sendable (NativeHostRefusal) -> Bool {
        if write.path.hasSuffix("/git/commit") || write.path.hasSuffix("/git/push"), LinkBytes.matches(write.path, "/link/api/tasks/[A-Za-z0-9_-]{1,160}/git/(commit|push)") {
            let settles = settlesRetry[write.path.hasSuffix("/commit") ? "commit" : "push"] ?? []
            return { refusal in refusal.code != "host-updating" && (refusal.details["replay"].bool || settles.contains(refusal.code)) }
        }
        return PhoneFileEdit.retryAnswered(write)
    }
    /** A stage or unstage: its effect is what the Host's state reads back, so 核对并放下 may drop it after a read. */
    public static func isStage(_ write: NativePendingWrite) -> Bool {
        LinkBytes.matches(write.path, "/link/api/tasks/[A-Za-z0-9_-]{1,160}/git/(stage|unstage)")
    }
    public static func pendingWords(_ write: NativePendingWrite) -> String? {
        if write.path.hasSuffix("/git/commit") { return "提交结果未知" }
        if write.path.hasSuffix("/git/push") { return "推送结果未知" }
        if write.path.hasSuffix("/git/stage") || write.path.hasSuffix("/git/unstage") { return "暂存结果待确认" }
        return nil
    }
    /** The paths a pending stage or unstage is for: their rows turn until the Host reads them back. */
    public static func pendingPaths(_ writes: [NativePendingWrite], sessionId: String) -> [String: Bool] {
        var result: [String: Bool] = [:]
        for write in writes where write.path == "/link/api/tasks/\(sessionId)/git/stage" || write.path == "/link/api/tasks/\(sessionId)/git/unstage" {
            for path in ((try? NativeJSON.decode(write.body))?["paths"].array ?? []).compactMap(\.string) { result[path] = write.path.hasSuffix("/stage") }
        }
        return result
    }
}
