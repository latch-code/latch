import Foundation

/**
 * An Agent's schedule results, schedule proposals, 动态 and 资料库, as the web words them (`apps/web/src/agents/activity.ts`),
 * from the Host's records only. Every text a person reads here is passed through `PhoneConversation.visible`.
 */
public enum PhoneTone: String, Equatable, Sendable { case neutral, running, done, warn, failed }

/** One file a run changed or produced: the path as sent (to open it) and as shown. */
public struct PhoneResultFile: Equatable, Sendable, Identifiable {
    public let root: String
    public let path: String
    public let shown: String
    /** 新增, 修改 or 已删除. */
    public let change: String
    public let deleted: Bool
    /** The same path can be in two roots. */
    public var id: String { root + ":" + path }
}

/** A run's result card: a Host record in the Agent's conversation, never a message. */
public struct PhoneScheduleResult: Equatable, Sendable, Identifiable {
    public let id: String
    public let automationId: String
    public let owner: String
    public let name: String
    public let outcome: String
    public let at: String
    public let sessionId: String?
    public let topicId: String?
    public let reply: String?
    public let replyTruncated: Bool
    public let files: [PhoneResultFile]
    public let filesMore: Int
    public let reason: String?
    public let code: String?
    public let contentRemoved: Bool
}

/** A failed run's one next step on this device: 立即运行 of its schedule. Harness and 模型服务 are fixed on the Mac. */
public enum PhoneResultStep: Equatable, Sendable { case runNow(automationId: String) }

public enum PhoneResults {
    /** Cards drawn together in one place; the rest are in 动态. */
    public static let shown = 3
    private static let shortLines = 4
    private static let shortChars = 280
    private static func changeWords(_ change: String?) -> String { change == "created" ? "新增" : change == "deleted" ? "已删除" : "修改" }
    /** `GET …/results` or a topic detail's `results`, oldest first; a card with anything unknown is left out. */
    public static func parse(_ list: NativeJSON) -> [PhoneScheduleResult] {
        list.array.prefix(256).compactMap { item -> PhoneScheduleResult? in
            guard let id = item["id"].string, let automationId = item["automationId"].string, let owner = item["owner"].string,
                  let name = item["name"].string, let outcome = item["outcome"].string, let at = item["at"].string else { return nil }
            let files = item["files"].array.prefix(20).compactMap { file -> PhoneResultFile? in
                guard let root = file["root"].string, let path = file["path"].string else { return nil }
                let change = file["change"].string
                return PhoneResultFile(root: root, path: path, shown: PhoneConversation.visible(path), change: changeWords(change), deleted: change == "deleted")
            }
            return PhoneScheduleResult(id: id, automationId: automationId, owner: owner, name: PhoneConversation.visible(name), outcome: outcome, at: at,
                sessionId: item["sessionId"].string, topicId: item["topicId"].string, reply: item["reply"].string.map { PhoneConversation.visible(String($0.prefix(2000))) },
                replyTruncated: item["replyTruncated"].bool, files: files, filesMore: Int(item["filesMore"].integer ?? 0),
                reason: item["failure"]["reason"].string.map { PhoneConversation.visible(String($0.prefix(300))) }, code: item["failure"]["code"].string,
                contentRemoved: item["contentRemoved"].bool)
        }.sorted { $0.at < $1.at }
    }
    /** How a run ended: red only for a real failure, amber where the result is not known. */
    public static func outcomeWords(_ outcome: String) -> (word: String, tone: PhoneTone) {
        switch outcome {
        case "completed": ("已完成", .done)
        case "failed": ("失败", .failed)
        case "cancelled": ("已停止", .neutral)
        case "interrupted": ("已中断", .warn)
        default: ("结果未知", .warn)
        }
    }
    /** The start of a reply before 展开: `more` when 展开 shows more. */
    public static func preview(_ reply: String) -> (short: String, more: Bool) {
        let lines = reply.split(separator: "\n", omittingEmptySubsequences: false)
        var short = lines.prefix(shortLines).joined(separator: "\n")
        if short.count > shortChars { short = String(short.prefix(shortChars - 1)) + "…" }
        else if lines.count > shortLines { short += "…" }
        return (short, short != reply)
    }
    /** The newest few of one place and how many more 「还有 N 条结果」 counts. */
    public static func stack(_ results: [PhoneScheduleResult]) -> (hidden: Int, shown: [PhoneScheduleResult]) {
        let hidden = max(0, results.count - shown)
        return (hidden, Array(results.dropFirst(hidden)))
    }
    /** Each card after the last turn that began before its run settled; before every turn under ''. */
    public static func place(_ results: [PhoneScheduleResult], turns: [PhoneTurn]) -> [String: [PhoneScheduleResult]] {
        var placed: [String: [PhoneScheduleResult]] = [:]
        let starts = turns.map { ($0.id, PhoneTime.parse($0.user?["createdAt"] ?? $0.replies.first?["createdAt"] ?? .null)) }
        for result in results.sorted(by: { $0.at < $1.at }) {
            let key: String
            if let at = PhoneTime.parse(.string(result.at)) { key = starts.last { $0.1.map { $0 <= at } ?? false }?.0 ?? "" }
            else { key = turns.last?.id ?? "" }
            placed[key, default: []].append(result)
        }
        return placed
    }
    /** The run's session, where the Host lists it here. */
    public static func run(_ result: PhoneScheduleResult, tasks: [NativeJSON]) -> String? {
        guard let id = result.sessionId, tasks.contains(where: { $0["id"].string == id }) else { return nil }
        return id
    }
    /** The failure's codes the web sends to 设置 or a new session; any other code, or none, retries. */
    private static let elsewhere: Set<String> = [
        "agent-not-found", "agent-start-failed", "agent-paused", "agent-handshake-timeout", "agent-env-reserved", "agent-folders-unsupported",
        "agent-definition-changed", "harness-version-unsupported", "harness-folder-limit", "login-program-changed",
        "model-unavailable", "model-route-unavailable", "model-route-changed", "model-vision-unsupported", "attachments-unsupported",
        "effort-unavailable", "chat-tools-disabled", "http-404", "egress-denied", "invalid-url", "model-gateway-unavailable", "http-401", "http-403",
        "harness-session-lost", "permission-drift", "project-config-changed", "l3-confirmation-missing", "workspace-changed", "session-read-only",
    ]
    /**
     * A failed or interrupted run's next step here: 立即运行 when its failure is one a retry fixes, its schedule is still
     * listed and not running, and this device may run while the Mac is reachable. Anything else is in 打开运行.
     */
    public static func nextStep(_ result: PhoneScheduleResult, automations: [NativeJSON], canRun: Bool, connected: Bool) -> PhoneResultStep? {
        guard result.outcome == "failed" || result.outcome == "interrupted", canRun, connected else { return nil }
        if let code = result.code, elsewhere.contains(code) { return nil }
        guard let schedule = automations.first(where: { $0["id"].string == result.automationId }), schedule["state"].string != "running" else { return nil }
        return .runNow(automationId: result.automationId)
    }
    /** 立即运行: one request kept while its result is unknown. */
    public static func runNow(automationId: String) throws -> NativePendingWrite {
        guard PhoneAgents.validAutomation(automationId) else { throw NativeFailure.invalidRecord }
        return try NativePendingWrite(method: .post, path: "/link/api/automations/" + automationId + "/run", fields: [:])
    }
    public static func heldRun(_ pending: [NativePendingWrite], automationId: String) -> NativePendingWrite? {
        pending.first { $0.method == "POST" && $0.path == "/link/api/automations/" + automationId + "/run" }
    }
    /** What the snapshot says of an owner's cards; a page reads them again when it changes. Counts only. */
    public static func signature(_ snapshot: NativeJSON, owner: String) -> String {
        let state = snapshot["agentResults"][owner]
        return (state["unbound"].integer.map { "\($0)" } ?? "0") + ":" + (state["at"].string ?? "") + ":" + (snapshot["customAgents"] == .null ? "absent" : "present")
    }
    /** Whether cards wait for this owner's next topic, so the new topic reads them. */
    public static func waiting(_ snapshot: NativeJSON, owner: String) -> Bool { (snapshot["agentResults"][owner]["unbound"].integer ?? 0) > 0 }
    public static func path(owner: String) throws -> String {
        guard PhoneAgents.validId(owner) else { throw NativeFailure.invalidRecord }
        return "/link/api/custom-agents/" + owner + "/results"
    }
}

/** A schedule proposal: 想定时：<name> · <plan>, never created or run until the person saves it. */
public enum PhoneScheduleProposals {
    /** <name> · 每天 20:00. */
    public static func line(_ proposal: PhoneProposal) -> String {
        guard let schedule = proposal.schedule else { return "" }
        return schedule.name + " · " + PhoneAgents.scheduleWords(schedule.plan)
    }
    /** The first line of each run's input, shortened as the web does. */
    public static func inputLine(_ prompt: String, max: Int = 120) -> String {
        let line = prompt.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        return line.count > max ? String(line.prefix(max - 1)) + "…" : line
    }
    /** Where the schedule's runs work: the Agent's default project, else unset until chosen; `default` is each run's own folder. */
    public static func location(_ agent: NativeJSON, catalog: NativeJSON) -> String? {
        let id = agent["defaultProjectId"].string
        return locations(catalog, harness: harness(catalog, agent: agent)).first { $0.id == id && $0.unavailable == nil }?.id
    }
    /**
     * The places a schedule can work in, as the web's project picker offers them: the projects, each with why the Harness
     * cannot use it (more folders than it takes) and the 程序目录内 mark, then each run's own folder where the Host makes one.
     */
    public static func locations(_ catalog: NativeJSON, harness: NativeJSON) -> [PhoneScheduleLocation] {
        let limit = harness["projectFolders"]["access"].string == "all" ? harness["projectFolders"]["max"].integer : nil
        let label = harness["capabilities"]["display"]["label"].string ?? harness["id"].string ?? "Harness"
        let projects = catalog["workspaces"].array.compactMap { project -> PhoneScheduleLocation? in
            guard let id = project["id"].string, id != "default" else { return nil }
            let folders = max(1, project["folders"].array.count)
            let reason = project["unavailable"].string ?? (limit.map { folders > Int($0) ? "\(label) 最多使用 \($0) 个文件夹" : nil } ?? nil)
            return PhoneScheduleLocation(id: id, name: PhoneConversation.visible(project["name"].string ?? id), unavailable: reason, codeRoot: project["codeRoot"].bool)
        }
        let start = catalog["sessionFolders"].bool && catalog["workspaces"].array.contains { $0["id"].string == "default" }
        return projects + (start ? [PhoneScheduleLocation(id: "default", name: "每次新的文件夹", unavailable: nil, codeRoot: false)] : [])
    }
    /** The Harness a schedule of this owner runs on: the Agent's own, 通用's the Host's default. */
    public static func harness(_ catalog: NativeJSON, agent: NativeJSON) -> NativeJSON {
        PhoneStart.harness(catalog, agent["harnessId"].string ?? catalog["defaults"]["harnessId"].string)
    }
    /** Why the form cannot be saved now; nil when it can. */
    public static func blocker(_ proposal: PhoneProposal, location: String?, catalog: NativeJSON, agent: NativeJSON, connected: Bool, canRun: Bool) -> String? {
        if let block = PhoneScheduleWrite.blocker(agent: agent, connected: connected, canRun: canRun) { return block }
        guard proposal.state == .pending else { return proposal.state == .saved ? "已保存" : "不要了" }
        guard let location else { return "先选工作位置" }
        guard let place = locations(catalog, harness: harness(catalog, agent: agent)).first(where: { $0.id == location }) else { return "这个项目已不可用。" }
        return place.unavailable
    }
    /**
     * The schedule as the proposal has it, through the same create the editor uses: `proposalId` makes the Host check it
     * is this owner's open schedule proposal and mark it saved; a retry sends the same request.
     */
    public static func create(owner: String, proposal: PhoneProposal, location: String, notify: Bool) throws -> NativePendingWrite {
        guard PhoneAgents.validId(owner), PhoneProposals.validId(proposal.id), let schedule = proposal.schedule else { throw NativeFailure.invalidRecord }
        let prompt = proposal.prompt.trimmingCharacters(in: .whitespacesAndNewlines), name = schedule.rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !name.isEmpty else { throw NativeFailure.invalidRecord }
        var fields: [String: NativeJSON] = ["name": .string(name), "prompt": .string(prompt), "schedule": schedule.plan, "notify": .bool(notify),
            "proposalId": .string(proposal.id)]
        if owner != PhoneAgents.generalId { fields["customAgentId"] = .string(owner) }
        if location != "default" {
            guard LinkBytes.matches(location, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord }
            fields["projectId"] = .string(location)
        }
        return try NativePendingWrite(method: .post, path: "/link/api/automations", fields: fields)
    }
    /** This device's unconfirmed save of the proposal. */
    public static func held(_ pending: [NativePendingWrite], proposalId: String) -> NativePendingWrite? {
        pending.first { $0.method == "POST" && $0.path == "/link/api/automations" && (try? NativeJSON.decode($0.body))?["proposalId"].string == proposalId }
    }
}

/** A place a schedule can work in, as the picker shows it. */
public struct PhoneScheduleLocation: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    /** Why it cannot be chosen; nil when it can. */
    public let unavailable: String?
    /** Inside Latch's own program folder: every write asks. */
    public let codeRoot: Bool
    public static let codeRootWords = "程序目录内"
    public static let codeRootNotice = "在程序目录里，每次写入都问你"
}

/**
 * How the phone settles the writes of 我的 Agent (memories, proposals' 保存 and 不要, 撤销 and 清除, a schedule's switch,
 * 立即运行 and a schedule saved from a proposal): the Host's refusal in its own words, which refusals of a retry settle the
 * write, and 核对并放下 from what the Host now says.
 */
public enum PhoneAgentWrites {
    public static func handles(_ write: NativePendingWrite) -> Bool {
        switch PhonePending.kind(write) {
        case .memory, .proposal, .schedule, .run, .scheduleCreate: true
        default: false
        }
    }
    /** Refusals that mean another change won: shown as 已在别处修改 / 已在别处处理, never as an error. */
    public static let changedCodes: Set<String> = ["agent-changed", "agent-memory-deleted", "automation-changed", "agent-proposal-decided"]
    /**
     * Whether a refusal of a retry answers it. A replayed receipt does; so does `agent-proposal-decided` for a proposal's
     * 保存, 不要 or a schedule saved from it: the proposal is decided whatever became of the first attempt, and the Host's
     * state shows how. Anything else (busy, limits, a route's 400) says nothing about the first attempt and keeps it unknown.
     */
    public static func retryAnswered(_ write: NativePendingWrite) -> @Sendable (NativeHostRefusal) -> Bool {
        let decides: Bool = { switch PhonePending.kind(write) { case .proposal, .scheduleCreate: true; default: false } }()
        return { refusal in refusal.details["replay"].bool || (decides && refusal.code == "agent-proposal-decided") }
    }
    /** The proposal a schedule save names; nil for every other write. */
    public static func proposalId(_ write: NativePendingWrite) -> String? {
        guard PhonePending.kind(write) == .scheduleCreate else { return nil }
        return (try? NativeJSON.decode(write.body))?["proposalId"].string.flatMap { PhoneProposals.validId($0) ? $0 : nil }
    }
    /** Whose proposals a schedule save is checked against: its Agent, or 通用. */
    public static func owner(_ write: NativePendingWrite) -> String? {
        guard PhonePending.kind(write) == .scheduleCreate else { return nil }
        return (try? NativeJSON.decode(write.body))?["customAgentId"].string ?? PhoneAgents.generalId
    }
    /** The owner of a proposal's 保存 or 不要, so 核对并放下 reads its proposals. */
    public static func decisionOwner(_ write: NativePendingWrite) -> String? {
        if case let .proposal(owner) = PhonePending.kind(write) { return owner }
        return nil
    }
    /** Host evidence that a schedule save is done: its proposal is saved and names the schedule made from it. */
    public static func saved(_ write: NativePendingWrite, proposals: [PhoneProposal]) -> String? {
        guard let id = proposalId(write), let proposal = proposals.first(where: { $0.id == id }), proposal.state == .saved else { return nil }
        return proposal.automationId
    }
    public enum Outcome: Equatable, Sendable { case done, changed, refused(String) }
    /** A refusal in the Host's own words; a schedule save the Host shows as saved is done. */
    public static func outcome(_ write: NativePendingWrite, refusal: NativeHostRefusal, proposals: [PhoneProposal]?) -> Outcome {
        if refusal.code == "agent-proposal-decided", let proposals, saved(write, proposals: proposals) != nil { return .done }
        if changedCodes.contains(refusal.code) { return .changed }
        return .refused(refusal.message.isEmpty ? "没有完成。" : refusal.message)
    }
    /** What 核对并放下 says once the write is dropped, from what the Host now lists. */
    public static func checkWords(_ write: NativePendingWrite, proposals: [PhoneProposal]?) -> String {
        if decisionOwner(write) != nil, let proposals {
            let id = write.path.split(separator: "/").dropLast().last.map(String.init)
            guard let proposal = proposals.first(where: { $0.id == id }) else { return "这条提议已不在了" }
            switch proposal.state {
            case .saved: return "这条提议已保存"
            case .dismissed: return "这条提议已不要了"
            case .pending: return "还没有处理，可以再选一次"
            }
        }
        if let id = proposalId(write), let proposals {
            guard let proposal = proposals.first(where: { $0.id == id }) else { return "这条提议已不在了" }
            switch proposal.state {
            case .saved: return proposal.automationId != nil ? "已保存为定时任务" : "这条提议已保存"
            case .dismissed: return "这条提议已不要了"
            case .pending: return "没有保存，可以再保存一次"
            }
        }
        return "已按电脑上现在的状态显示"
    }
    /** The pending line, by what the proposal is when this device has read it. */
    public static func words(_ write: NativePendingWrite, proposals: [PhoneProposal]) -> String {
        guard case .proposal = PhonePending.kind(write) else { return PhonePending.words(write) }
        let id = write.path.split(separator: "/").dropLast().last.map(String.init)
        guard let proposal = proposals.first(where: { $0.id == id }) else { return PhonePending.words(write) }
        return proposal.schedule != nil ? "定时提议的结果待确认" : "记忆提议的结果待确认"
    }
}

/** One 动态 row in words: what it is, what about, its state; never a memory's or a proposal's text. */
public struct PhoneActivityRow: Equatable, Sendable, Identifiable {
    public enum Target: Equatable, Sendable { case session(String), memory, none }
    public let id: String
    public let at: String
    public let kind: String
    public let lead: String
    public let subject: String?
    public let state: String?
    public let tone: PhoneTone
    public let target: Target
}

/** One file of 资料库: a file a session changed, or an attachment the person gave it. */
public struct PhoneLibraryFile: Equatable, Sendable, Identifiable {
    public let id: String
    public let sessionId: String
    /** The path or the attachment's name, as shown. */
    public let shown: String
    /** What the file preview takes: the path, or the attachment's ID. */
    public let reference: String
    /** A project root, or `@attachment` for an attachment. */
    public let root: String
    public let image: Bool
    /** 新增, 修改, 已删除 or 你给的. */
    public let words: String
    public let openable: Bool
}

public struct PhoneLibraryGroup: Equatable, Sendable, Identifiable {
    public let sessionId: String
    public let title: String
    public let at: String
    public let run: Bool
    public let files: [PhoneLibraryFile]
    public let more: Int
    public var id: String { sessionId }
}

public enum PhoneActivity {
    public static let attachmentRoot = "@attachment"
    private static let proposalStates = ["pending": "等你决定", "saved": "已保存", "dismissed": "不要了"]
    private static let memoryWords = ["added": "记忆 +1", "updated": "记忆已修改", "deleted": "记忆 −1"]
    private static func runTone(_ state: String) -> PhoneTone {
        switch state {
        case "running": .running
        case "waiting", "missed", "skipped", "unknown": .warn
        case "failed": .failed
        case "completed": .done
        default: .neutral
        }
    }
    /** `GET …/activity` rows; one of an unknown kind is left out. */
    public static func rows(_ page: NativeJSON) -> [PhoneActivityRow] {
        page["items"].array.prefix(100).compactMap { item -> PhoneActivityRow? in
            guard let id = item["id"].string, let at = item["at"].string, let kind = item["kind"].string else { return nil }
            let visible = { (text: String?) in text.map(PhoneConversation.visible) }
            switch kind {
            case "topic":
                guard let session = item["sessionId"].string else { return nil }
                let title = item["title"].string.flatMap { $0.isEmpty ? nil : $0 } ?? "未命名会话"
                return PhoneActivityRow(id: id, at: at, kind: kind, lead: "新话题", subject: visible(title), state: nil, tone: .neutral, target: .session(session))
            case "run":
                let state = item["state"].string ?? ""
                return PhoneActivityRow(id: id, at: at, kind: kind, lead: "定时", subject: visible(item["name"].string), state: PhoneAgents.runWords(state),
                    tone: runTone(state), target: item["sessionId"].string.map { .session($0) } ?? .none)
            case "result":
                let outcome = PhoneResults.outcomeWords(item["outcome"].string ?? "")
                return PhoneActivityRow(id: id, at: at, kind: kind, lead: "定时结果", subject: visible(item["name"].string), state: outcome.word, tone: outcome.tone,
                    target: item["topicId"].string.map { .session($0) } ?? .none)
            case "memory":
                guard let words = memoryWords[item["change"].string ?? ""] else { return nil }
                return PhoneActivityRow(id: id, at: at, kind: kind, lead: words, subject: nil, state: nil, tone: .neutral, target: .memory)
            case "proposal":
                guard let session = item["sessionId"].string, let state = item["state"].string, let words = proposalStates[state] else { return nil }
                return PhoneActivityRow(id: id, at: at, kind: kind, lead: item["proposal"].string == "schedule" ? "提议定时" : "提议记忆", subject: nil, state: words,
                    tone: state == "pending" ? .warn : state == "saved" ? .done : .neutral, target: .session(session))
            default: return nil
            }
        }
    }
    /** `GET …/library` groups; a file of the device's own seeing: a deleted file is a path only. */
    public static func groups(_ page: NativeJSON) -> [PhoneLibraryGroup] {
        page["groups"].array.prefix(24).compactMap { group -> PhoneLibraryGroup? in
            guard let session = group["sessionId"].string, let at = group["at"].string else { return nil }
            let files = group["items"].array.prefix(200).compactMap { item -> PhoneLibraryFile? in
                switch item["kind"].string {
                case "file":
                    guard let root = item["root"].string, let path = item["path"].string else { return nil }
                    let change = item["change"].string
                    return PhoneLibraryFile(id: root + ":" + path, sessionId: item["sessionId"].string ?? session, shown: PhoneConversation.visible(path), reference: path,
                        root: root, image: false, words: change == "created" ? "新增" : change == "deleted" ? "已删除" : "修改", openable: change != "deleted")
                case "attachment":
                    let attachment = item["attachment"]
                    guard let id = attachment["id"].string, let name = attachment["name"].string else { return nil }
                    return PhoneLibraryFile(id: (item["messageId"].string ?? "") + ":" + id, sessionId: item["sessionId"].string ?? session, shown: PhoneConversation.visible(name),
                        reference: id, root: attachmentRoot, image: attachment["kind"].string == "image", words: "你给的", openable: true)
                default: return nil
                }
            }
            let title = group["title"].string.flatMap { $0.isEmpty ? nil : $0 } ?? "未命名会话"
            return PhoneLibraryGroup(sessionId: session, title: PhoneConversation.visible(title), at: at, run: group["automationId"].string != nil,
                files: files, more: Int(group["more"].integer ?? 0))
        }
    }
    /** 今天 / 本周 / 更早 by this device's clock. */
    public static func bucket(_ at: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = PhoneTime.parse(.string(at)) else { return "更早" }
        let start = calendar.startOfDay(for: now)
        if date >= start { return "今天" }
        if date >= start.addingTimeInterval(-6 * 86_400) { return "本周" }
        return "更早"
    }
    /** Rows split into 今天 / 本周 / 更早 in their order; empty buckets are left out. */
    public static func bucketed(_ rows: [PhoneActivityRow], now: Date = Date(), calendar: Calendar = .current) -> [(label: String, rows: [PhoneActivityRow])] {
        var result: [(label: String, rows: [PhoneActivityRow])] = []
        for row in rows {
            let label = bucket(row.at, now: now, calendar: calendar)
            if result.last?.label == label { result[result.count - 1].rows.append(row) } else { result.append((label, [row])) }
        }
        return result
    }
    /** A page's path: the first, or the one after `before` (the Host's `next`, checked and encoded). */
    public static func path(owner: String, part: String, before: String?) throws -> String {
        guard PhoneAgents.validId(owner), part == "activity" || part == "library" else { throw NativeFailure.invalidRecord }
        let base = "/link/api/custom-agents/" + owner + "/" + part
        guard let before else { return base }
        guard LinkBytes.matches(before, "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\\|[A-Za-z0-9_:.@|-]{1,600}") else { throw NativeFailure.invalidRecord }
        var allowed = CharacterSet.alphanumerics; allowed.insert(charactersIn: "-._")
        guard let encoded = before.addingPercentEncoding(withAllowedCharacters: allowed) else { throw NativeFailure.invalidRecord }
        return base + "?before=" + encoded
    }
    /**
     * 动态 and 资料库 are read again when the owner's topics, runs, cards, memories or proposals change; a topic that is
     * streaming counts once, not on every token. Counts and times only.
     */
    public static func signature(_ snapshot: NativeJSON, owner: String) -> String {
        let agent = snapshot["customAgents"].array.first { $0["id"].string == owner } ?? .null
        let schedules = Set(snapshot["automations"].array.filter { ($0["customAgentId"].string ?? PhoneAgents.generalId) == owner }.compactMap { $0["id"].string })
        let topics = snapshot["tasks"].array.filter { task in
            PhoneAgentChat.owner(task) == owner || (task["automationId"].string.map { schedules.contains($0) } ?? false)
        }.map { task -> String in
            let live = ["running", "waiting-approval"].contains(task["status"].string ?? "")
            return (task["id"].string ?? "") + ":" + (live ? "live" : task["updatedAt"].string ?? "")
        }.joined(separator: ",")
        return [PhoneResults.signature(snapshot, owner: owner), agent["revision"].integer.map { "\($0)" } ?? "", agent["memoryCount"].integer.map { "\($0)" } ?? "",
            snapshot["agentProposals"][owner]["at"].string ?? "", topics].joined(separator: "|")
    }
}

/**
 * A paged read inside a content window: the first page starts a load, a later page is appended only to the load it
 * continues, and `clear` (lock, window closed) drops the rows and every load in flight.
 */
public struct PhonePagedRead<Row: Equatable & Sendable>: Equatable, Sendable {
    public private(set) var rows: [Row] = []
    public private(set) var next: String?
    public private(set) var loaded = false
    private var load: UUID?
    private var paging: UUID?
    public init() {}
    public var more: Bool { next != nil }
    public var loadingMore: Bool { paging != nil }
    /** A first page: what was shown stays until its answer comes. */
    public mutating func begin() -> UUID { let token = UUID(); load = token; paging = nil; next = nil; return token }
    /** The next page of the current load; nil when there is none or one is on its way. */
    public mutating func beginMore() -> (token: UUID, before: String)? {
        guard let load, let next, paging == nil else { return nil }
        paging = load
        return (load, next)
    }
    /** True when adopted: only the current load's answer, and only while the window is open. */
    @discardableResult public mutating func finish(_ token: UUID, rows page: [Row], next cursor: String?, more: Bool, windowOpen: Bool) -> Bool {
        guard windowOpen, load == token else { return false }
        if more {
            guard paging == token else { return false }
            rows += page; paging = nil
        } else { rows = page; paging = nil }
        next = cursor; loaded = true
        return true
    }
    /** Whether an answer of this load may still be shown: a newer load replaced it otherwise. */
    public func current(_ token: UUID) -> Bool { load == token }
    /** A page that failed: the cursor stays for 加载更多. */
    public mutating func failed(_ token: UUID) { if paging == token { paging = nil } }
    public mutating func clear() { rows = []; next = nil; loaded = false; load = nil; paging = nil }
}
