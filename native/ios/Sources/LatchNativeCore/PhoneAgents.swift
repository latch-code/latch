import Foundation

/** The root places of the App, in the web's order and words. */
public enum PhoneTab: String, Hashable, Sendable, CaseIterable { case code, agents, apps, settings }

public struct PhoneTabEntry: Equatable, Sendable, Identifiable {
    public let id: PhoneTab
    public let label: String
    public let symbol: String
}

public enum PhoneTabs {
    /** Code, 我的 Agent where the Host has them, 应用 where plugin pages are applied, and 设置. */
    public static func entries(_ snapshot: NativeJSON, selected: PhoneTab? = nil) -> [PhoneTabEntry] {
        var result = [PhoneTabEntry(id: .code, label: "Code", symbol: "chevron.left.forwardslash.chevron.right")]
        if snapshot["catalog"]["features"]["customAgents"].bool || (snapshot == .null && selected == .agents) {
            result.append(PhoneTabEntry(id: .agents, label: "我的 Agent", symbol: "person.crop.circle"))
        }
        if !PhoneApps.listed(snapshot).isEmpty { result.append(PhoneTabEntry(id: .apps, label: "应用", symbol: "square.grid.2x2")) }
        result.append(PhoneTabEntry(id: .settings, label: "设置", symbol: "gearshape"))
        return result
    }
    /**
     * Sessions that wait on you, counted as the web's dot counts them: a stop already asked for answers them. With a
     * place, only what that place's own lists show; an approval of a session no list holds counts in the total alone.
     */
    public static func waitingCount(_ snapshot: NativeJSON, space: PhoneSpace? = nil) -> Int {
        let all = snapshot["tasks"].array
        let tasks = all.filter { !$0["archived"].bool }
        let stopping = Set(tasks.filter { $0["live"]["activity"].string == "cancelling" }.compactMap { $0["id"].string })
        let placed = Dictionary(all.compactMap { task in task["id"].string.map { ($0, PhoneSpaces.of(task)) } }, uniquingKeysWith: { a, _ in a })
        let here = { (id: String) in space == nil || placed[id] == space }
        let asking = snapshot["approvals"].array.compactMap { $0["sessionId"].string }.filter { !stopping.contains($0) && here($0) }
        return Set(asking + tasks.filter(PhoneSessions.waitsOnYou).compactMap { $0["id"].string }.filter(here)).count
    }
    /** An amber dot on Code, never a number, while another place is on screen; it counts Code's own sessions. */
    public static func codeDot(_ snapshot: NativeJSON, current: PhoneTab) -> Bool {
        current != .code && waitingCount(snapshot, space: PhoneSpaces.split(snapshot) ? .code : nil) > 0
    }
    /** The same on 我的 Agent, for its own topics. */
    public static func agentsDot(_ snapshot: NativeJSON, current: PhoneTab) -> Bool {
        current != .agents && PhoneSpaces.split(snapshot) && waitingCount(snapshot, space: .agents) > 0
    }
}

/** Code and 我的 Agent, the two places a session belongs to. */
public enum PhoneSpace: String, Equatable, Sendable { case code, agents }

/**
 * Where a session belongs, by the web's rule (`spaceOf`): one of your Agents' sessions and a conversation with 通用 are
 * 我的 Agent's; every other one is Code's. A Host without 我的 Agent has Code alone, and every session is there.
 */
public enum PhoneSpaces {
    public static func split(_ snapshot: NativeJSON) -> Bool { snapshot["catalog"]["features"]["customAgents"].bool }
    public static func of(_ task: NativeJSON) -> PhoneSpace { task["agent"] != .null || task["generalChat"].bool ? .agents : .code }
    /** The sessions a place lists. */
    public static func tasks(_ snapshot: NativeJSON, in space: PhoneSpace) -> [NativeJSON] {
        let tasks = snapshot["tasks"].array
        guard split(snapshot) else { return space == .code ? tasks : [] }
        return tasks.filter { of($0) == space }
    }
    /** Whether a session open in Code belongs to the other place, so going back to Code leaves it. */
    public static func belongsElsewhere(_ snapshot: NativeJSON, sessionId: String?, from space: PhoneSpace) -> Bool {
        guard split(snapshot), let sessionId, let task = snapshot["tasks"].array.first(where: { $0["id"].string == sessionId }) else { return false }
        return of(task) != space
    }
}

/** Applied plugin pages. The App lists them; it cannot show them yet. */
public struct PhoneAppEntry: Equatable, Sendable, Identifiable {
    public let pluginId: String
    public let appId: String
    public let title: String
    public let plugin: String
    public let icon: String?
    public var id: String { pluginId + "/" + appId }
}

public enum PhoneApps {
    public static func listed(_ snapshot: NativeJSON) -> [PhoneAppEntry] {
        snapshot["apps"].array.compactMap { page in
            guard page["status"].string != "disabled", let pluginId = page["pluginId"].string, let appId = page["appId"].string else { return nil }
            return PhoneAppEntry(pluginId: pluginId, appId: appId, title: page["title"].string ?? appId,
                plugin: "插件 · " + (page["pluginName"].string ?? pluginId), icon: page["icon"].string)
        }
    }
}

/** Whether this device sees 我的 Agent, and in what state. */
public enum PhoneAgentAccess: String, Equatable, Sendable {
    /** The Host has no such domain. */
    case hidden
    /** The list is being read; no private entries are available to present yet. */
    case loading
    /** A smaller data scope: what is locked, never an empty list. */
    case locked
    /** A phone gets the list only inside a content window; it opens as a conversation does. */
    case closed
    /** The Host is confirming an earlier write and leaves the list out meanwhile. */
    case confirming
    case ready
}

/**
 * The bracket face the Host gave an Agent: brackets around two eyes in one muted hue. 通用 is the same face in grey. An
 * Agent with a picture (`kind: "image"`) keeps its face beside it, and this App draws that face until it shows pictures.
 */
public struct PhoneAgentAvatar: Equatable, Sendable {
    public static let brackets = ["round", "curly", "square", "angle"]
    public static let eyeKinds = ["dot", "arc", "oval", "sleepy"]
    public static let hues = ["ink", "slate", "pine", "plum", "wisteria", "cocoa", "sand", "moss", "mist"]
    public static let general = PhoneAgentAvatar(bracket: "round", eyes: "dot", hue: "neutral")
    public let bracket: String
    public let eyes: String
    public let hue: String
    /**
     * A face of known parts, alone or kept under a picture; the picture's own fields are not read. Anything else (a kind
     * or value from a later Host) draws as 通用's grey face: an Agent is never left out for its avatar.
     */
    public static func parse(_ value: NativeJSON) -> PhoneAgentAvatar {
        guard let kind = value["kind"].string, kind == "face" || kind == "image", let bracket = value["bracket"].string, brackets.contains(bracket),
              let eyes = value["eyes"].string, eyeKinds.contains(eyes), let hue = value["hue"].string, hues.contains(hue) else { return general }
        return PhoneAgentAvatar(bracket: bracket, eyes: eyes, hue: hue)
    }
}

/** What an Agent's face shows beside its state word. 刚完成 is a moment the view plays, not a state. */
public enum PhoneAgentFace: String, Equatable, Sendable {
    case idle, running, waiting, failed, resting
    /** The word beside the face, where the state has one; 休息 says 不可用 through the availability line. */
    public var words: String? {
        switch self {
        case .running: "运行中"
        case .waiting: "等你处理"
        case .failed: "失败"
        case .idle, .resting: nil
        }
    }
}

public struct PhoneAgentEntry: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let general: Bool
    public let avatar: PhoneAgentAvatar
    /** From the Agent's own sessions; 通用 stays idle. */
    public let face: PhoneAgentFace
    public let duty: String
    /** 「Harness · 模型」, or for 通用 that each session picks its own. */
    public let runs: String
    public let harnessId: String?
    /** Where its sessions work; nil for 通用. */
    public let place: String?
    public let available: Bool
    public let unavailableReason: String?
}

/** A read of private Agent data. A failed read never settles a pending write. */
public enum PhoneAgentRead: Equatable, Sendable {
    case loading, ready(NativeJSON), locked, confirming, offline, closed, missing, failed
}

public enum PhoneAgents {
    public static func readFailure(_ error: Error) -> PhoneAgentRead {
        if let read = error as? NativeReadFailure { return read == .agentWriteUnknown ? .confirming : .failed }
        return switch error as? NativeFailure {
        case .forbidden: .locked
        case .resultUnknown: .offline
        case .expired, .declined, .notVerified: .closed
        case .unsupported: .missing
        case .unavailable: .offline
        default: .failed
        }
    }
    public static let generalId = "general"
    public static let generalName = "通用"
    public static let generalDuty = "没选别的 Agent 的会话都带上它"
    public static func access(_ snapshot: NativeJSON, windowOpen: Bool = true, privateConfirmed: Bool = true, reading: Bool = false) -> PhoneAgentAccess {
        if snapshot == .null && reading { return .loading }
        guard snapshot["catalog"]["features"]["customAgents"].bool else { return .hidden }
        guard snapshot["device"]["dataScope"].string == "all" else { return .locked }
        // Names, duties and schedules are content: outside a window they are not shown, whatever is still in memory.
        guard windowOpen && privateConfirmed else { return reading ? .loading : .closed }
        return snapshot["customAgents"] == .null ? .confirming : .ready
    }
    /** The snapshot with what only a content window may show taken out, for when a window closes. */
    public static func withoutPrivate(_ snapshot: NativeJSON) -> NativeJSON {
        guard case var .object(value) = snapshot else { return snapshot }
        for key in ["customAgents", "agentChats", "automations", "agentProposals", "agentResults", "computer"] { value.removeValue(forKey: key) }
        return PhoneWorkItems.withoutBody(.object(value))
    }
    public static func validId(_ id: String) -> Bool { id == generalId || LinkBytes.matches(id, "agt_[a-f0-9-]{36}") }
    /** 通用 first, then the Host's order. */
    public static func entries(_ snapshot: NativeJSON, windowOpen: Bool = true) -> [PhoneAgentEntry] {
        guard access(snapshot, windowOpen: windowOpen) == .ready else { return [] }
        let catalog = snapshot["catalog"]
        let general = PhoneAgentEntry(id: generalId, name: generalName, general: true, avatar: .general, face: .idle, duty: generalDuty,
            runs: "内置 · 每个会话自己选 Harness", harnessId: nil, place: nil, available: true, unavailableReason: nil)
        return [general] + snapshot["customAgents"].array.compactMap { agent in
            guard let id = agent["id"].string, validId(id), id != generalId else { return nil }
            let available = agent["available"].bool
            return PhoneAgentEntry(id: id, name: agent["name"].string ?? "Agent", general: false, avatar: PhoneAgentAvatar.parse(agent["avatar"]),
                face: face(snapshot, id: id, available: available),
                duty: duty(agent), runs: runsWith(catalog, agent: agent), harnessId: agent["harnessId"].string,
                place: worksIn(catalog, projectId: agent["defaultProjectId"].string), available: available,
                unavailableReason: available ? nil : agent["unavailableReason"].string)
        }
    }
    /**
     * The face's state from the Host's own data, as the web derives it: this Agent's sessions, 等你处理 before 运行中, then
     * 休息 while it cannot start, then a failure of its latest unarchived session.
     */
    public static func face(_ snapshot: NativeJSON, id: String, available: Bool) -> PhoneAgentFace {
        let own = snapshot["tasks"].array.filter { $0["agent"]["customAgentId"].string == id }
        let asking = Set(snapshot["approvals"].array.compactMap { $0["sessionId"].string })
        if own.contains(where: { PhoneSessions.waitsOnYou($0) || ($0["status"].string == "running" && asking.contains($0["id"].string ?? "")) }) {
            return .waiting
        }
        if own.contains(where: { ["running", "waiting-approval"].contains($0["status"].string ?? "") }) { return .running }
        if !available { return .resting }
        let latest = own.filter { !$0["archived"].bool }.max { ($0["updatedAt"].string ?? "") < ($1["updatedAt"].string ?? "") }
        if let latest, PhoneSessions.rowStatus(latest) == .failed { return .failed }
        return .idle
    }
    public static func entry(_ snapshot: NativeJSON, id: String, windowOpen: Bool = true) -> PhoneAgentEntry? {
        entries(snapshot, windowOpen: windowOpen).first { $0.id == id }
    }
    /** The duty in one line: the description, else the first line of the instructions. */
    public static func duty(_ agent: NativeJSON) -> String {
        if let described = agent["description"].string?.trimmingCharacters(in: .whitespacesAndNewlines), !described.isEmpty {
            return described.split(separator: "\n", omittingEmptySubsequences: false).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? described
        }
        return (agent["instructions"].string ?? "").split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
    }
    /** 「Harness · 模型」; a Harness no longer listed keeps its ID, and one with its own models shows only its name. */
    public static func runsWith(_ catalog: NativeJSON, agent: NativeJSON) -> String {
        let id = agent["harnessId"].string ?? "Harness"
        guard let harness = catalog["harnesses"].array.first(where: { $0["id"].string == id }) else { return id }
        let name = PhoneStart.engineName(harness)
        guard PhoneStart.usesServices(harness) else { return name }
        return name + " · " + modelName(catalog, model: agent["model"])
    }
    public static func modelName(_ catalog: NativeJSON, model: NativeJSON) -> String {
        guard let name = model["model"].string else { return "默认模型" }
        // The list kept for offline has no services, which says nothing about whether one was removed.
        if catalog["providers"] == .null { return name }
        return catalog["providers"].array.contains { $0["id"].string == model["providerId"].string } ? name : name + "（服务已移除）"
    }
    public static func worksIn(_ catalog: NativeJSON, projectId: String?) -> String {
        guard let projectId, projectId != "default" else { return "家" }
        return catalog["workspaces"].array.first { $0["id"].string == projectId }?["name"].string ?? "项目已移除"
    }
    /** Ready Harnesses that can receive an Agent's instructions. */
    public static func harnesses(_ catalog: NativeJSON) -> [PhoneStartEntry] {
        let ids = Set(catalog["harnesses"].array.filter { $0["agentContext"].string != nil && $0["offer"] == .null }.compactMap { $0["id"].string })
        return PhoneStart.engines(catalog).filter { ids.contains($0.id) }
    }
    /** A new topic's picks start from the Agent's own. */
    public static func choice(_ catalog: NativeJSON, agent: NativeJSON) -> PhoneStartChoice {
        let harnessId = harnesses(catalog).first { $0.id == agent["harnessId"].string }?.id
        let projects = PhoneStart.projects(catalog)
        let project = projects.first { $0.id == agent["defaultProjectId"].string } ?? projects.first { $0.id == "default" }
        let models = PhoneStart.models(catalog)
        let model = models.first { $0.providerId == agent["model"]["providerId"].string && $0.model == agent["model"]["model"].string }
        return PhoneStartChoice(harnessId: harnessId, workspaceId: project?.id, model: model)
    }
    /** Why a new topic cannot start now, in the web's words; nil when it can. */
    public static func blocker(_ catalog: NativeJSON, agent: NativeJSON, choice: PhoneStartChoice, connected: Bool, canRun: Bool) -> String? {
        if !connected { return "Mac 不在线，恢复后再发" }
        if !canRun { return "这台设备不能开始会话" }
        if !agent["available"].bool { return agent["unavailableReason"].string ?? "现在不能开始" }
        guard let id = choice.harnessId, harnesses(catalog).contains(where: { $0.id == id }) else { return "先选 Harness" }
        if let workspace = choice.workspaceId, !PhoneStart.projects(catalog).contains(where: { $0.id == workspace }) { return "这个项目已不可用。" }
        return nil
    }
    /** The mode a new topic asks for: the Agent's own, where the chosen Harness has it. */
    public static func mode(_ catalog: NativeJSON, harnessId: String, agentMode: String?) -> String {
        let modes = catalog["harnesses"].array.first { $0["id"].string == harnessId }?["modes"].array.compactMap(\.string) ?? []
        let wanted = agentMode ?? "agent"
        return modes.isEmpty || modes.contains(wanted) ? wanted : modes[0]
    }
    /**
     * A new topic's start request: the Agent, then what was picked for this session. The Harness is always the Agent's own:
     * the Host refuses another (`agent-harness-fixed`).
     */
    public static func fields(_ catalog: NativeJSON, agent: NativeJSON, choice: PhoneStartChoice, prompt: String) throws -> [String: NativeJSON] {
        guard let id = agent["id"].string, validId(id), id != generalId, let harnessId = agent["harnessId"].string, choice.harnessId != nil else {
            throw NativeFailure.invalidRecord
        }
        var result: [String: NativeJSON] = ["prompt": .string(prompt), "customAgentId": .string(id), "harnessId": .string(harnessId),
            "mode": .string(mode(catalog, harnessId: harnessId, agentMode: agent["mode"].string))]
        // The folder as picked, as the web sends it: the Agent's project, another one, or the start folder ('default'), which
        // the Host takes for one session over the Agent's own project.
        if let workspaceId = choice.workspaceId { result["workspaceId"] = .string(workspaceId) }
        let harness = catalog["harnesses"].array.first { $0["id"].string == harnessId } ?? .null
        if PhoneStart.usesServices(harness), let model = choice.model {
            result["model"] = .object(["providerId": .string(model.providerId), "model": .string(model.model)])
        }
        return result
    }
    /**
     * The name of the Agent a topic belongs to (通用 for a conversation with it, 已删除的 Agent once it is gone), plain
     * 「我的 Agent」 outside a window; nil on a session of Code.
     */
    public static func ownerName(_ snapshot: NativeJSON, task: NativeJSON, windowOpen: Bool = true) -> String? {
        guard let id = PhoneAgentChat.owner(task) else { return nil }
        guard windowOpen else { return "我的 Agent" }
        if id == generalId { return generalName }
        guard snapshot["customAgents"] != .null else { return "Agent" }
        return snapshot["customAgents"].array.first { $0["id"].string == id }?["name"].string ?? "已删除的 Agent"
    }
    /** This Agent's schedules (通用's name no Agent); nil while the Host leaves them out. */
    public static func automations(_ snapshot: NativeJSON, id: String, windowOpen: Bool = true) -> [NativeJSON]? {
        guard windowOpen, snapshot["automations"] != .null else { return nil }
        return snapshot["automations"].array.filter { item in
            id == generalId ? item["customAgentId"] == .null : item["customAgentId"].string == id
        }
    }
    private static let days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
    /** 每天 09:00, 工作日 09:00, 每周一 09:00. */
    public static func scheduleWords(_ schedule: NativeJSON) -> String {
        let time = schedule["time"].string ?? ""
        switch schedule["kind"].string {
        case "daily": return "每天 " + time
        case "weekdays": return "工作日 " + time
        default:
            let day = Int(schedule["day"].integer ?? 7)
            return "每" + (day < days.count ? days[day] : "") + " " + time
        }
    }
    private static let runs: [String: String] = [
        "running": "运行中", "waiting": "等你处理", "completed": "完成", "failed": "失败", "cancelled": "已取消",
        "interrupted": "已中断", "unknown": "结果未知", "missed": "错过", "skipped": "跳过",
    ]
    public static func runWords(_ state: String?) -> String { state.flatMap { runs[$0] } ?? "没有运行" }
    /** 运行中, 已暂停, 已开启 or 已关闭. */
    public static func automationState(_ automation: NativeJSON) -> String {
        switch automation["state"].string {
        case "running": return "运行中"
        case "paused": return "已暂停"
        default: return automation["enabled"].bool ? "已开启" : "已关闭"
        }
    }
    public static func validAutomation(_ id: String) -> Bool { LinkBytes.matches(id, "auto_[a-f0-9-]{36}") }
    /** 技能 in words: all of them, none, or their names from the catalog. */
    public static func skillWords(_ catalog: NativeJSON, skills: NativeJSON) -> String {
        guard case let .array(chosen) = skills else { return "全部已启用的技能" }
        if chosen.isEmpty { return "不用技能" }
        let names = chosen.compactMap(\.string).map { key in
            catalog["skills"].array.first { ($0["pluginId"].string ?? "") + ":" + ($0["id"].string ?? "") == key }?["name"].string ?? key
        }
        return names.joined(separator: "、")
    }
    public static func toolWords(_ tools: NativeJSON) -> String {
        guard case let .array(chosen) = tools else { return "全部插件" }
        return chosen.isEmpty ? "不用插件的工具" : "\(chosen.count) 个插件"
    }
}

/** A memory write, with the request identity the Host answers by. Only the person writes these, never a tool. */
public enum PhoneMemoryWrite {
    public static let maximum = 4000
    private static func base(_ owner: String) throws -> String {
        guard PhoneAgents.validId(owner) else { throw NativeFailure.invalidRecord }
        return "/link/api/custom-agents/" + owner + "/memories"
    }
    private static func content(_ text: String) throws -> String {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= maximum else { throw NativeFailure.invalidRecord }
        return value
    }
    private static func memory(_ id: String) throws -> String {
        guard LinkBytes.matches(id, "mem_[a-f0-9-]{36}") else { throw NativeFailure.invalidRecord }
        return id
    }
    public static func create(owner: String, text: String) throws -> NativePendingWrite {
        try NativePendingWrite(method: .post, path: base(owner), fields: ["content": .string(content(text))])
    }
    public static func change(owner: String, memory value: NativeJSON, text: String) throws -> NativePendingWrite {
        guard let id = value["id"].string, let revision = value["revision"].integer else { throw NativeFailure.invalidRecord }
        return try NativePendingWrite(method: .patch, path: base(owner) + "/" + memory(id),
            fields: ["content": .string(content(text)), "baseRevision": .number(Double(revision))])
    }
    public static func remove(owner: String, memoryId: String) throws -> NativePendingWrite {
        try NativePendingWrite(method: .delete, path: base(owner) + "/" + memory(memoryId), fields: [:])
    }
}

/** What an unconfirmed write is, so each place offers only its own retry and says what it waits on. */
public enum PhonePendingKind: Equatable, Sendable {
    case start
    /** A new topic with an Agent or 通用. */
    case topic(owner: String)
    case memory(owner: String)
    case proposal(owner: String)
    case schedule(id: String)
    /** 立即运行 of a schedule. */
    case run(id: String)
    /** A schedule saved from a proposal. */
    case scheduleCreate
    /** An Agent's own switches: 通知 or 到点前后保持唤醒. */
    case agent(id: String)
    case session(id: String)
    case other
}

public enum PhonePending {
    public static func kind(_ write: NativePendingWrite) -> PhonePendingKind {
        if write.path == "/link/api/tasks" && write.method == "POST" {
            if let id = (try? NativeJSON.decode(write.body))?["customAgentId"].string { return .topic(owner: id) }
            return .start
        }
        let parts = write.path.split(separator: "/").map(String.init)
        if parts.count == 4, parts[2] == "custom-agents", write.method == "PATCH" { return .agent(id: parts[3]) }
        if parts.count >= 5, parts[2] == "custom-agents", parts[4] == "memories" { return .memory(owner: parts[3]) }
        if parts.count >= 5, parts[2] == "custom-agents", parts[4] == "proposals" { return .proposal(owner: parts[3]) }
        if parts.count == 5, parts[2] == "automations", parts[4] == "enabled" { return .schedule(id: parts[3]) }
        if parts.count == 5, parts[2] == "automations", parts[4] == "run" { return .run(id: parts[3]) }
        if parts.count == 3, parts[2] == "automations", write.method == "POST" { return .scheduleCreate }
        if parts.count >= 4, parts[2] == "tasks" { return .session(id: parts[3]) }
        return .other
    }
    public static func words(_ write: NativePendingWrite) -> String {
        if let words = PhoneHistory.pendingWords(write) { return words }
        switch kind(write) {
        case .topic: return "第一条消息结果待确认"
        case .memory: return "记忆的修改结果待确认"
        case .proposal: return "提议的结果待确认"
        case .schedule: return "定时任务的开关结果待确认"
        case .run: return "立即运行结果待确认"
        case .scheduleCreate: return "定时任务的保存结果待确认"
        case .agent: return (try? NativeJSON.decode(write.body))?["keepAwakeForSchedules"] != .null ? "保持唤醒的开关结果待确认" : "通知开关的结果待确认"
        case .start: return (try? NativeJSON.decode(write.body))?["forkOf"] != .null ? "分叉结果待确认" : "提交结果待确认"
        case .session:
            return write.path.hasSuffix("/config") ? "切换结果待确认" : "提交结果待确认"
        case .other: return "提交结果待确认"
        }
    }
    /**
     * The text of a message whose answer never came, a new session's first or a session's next; nil for every other
     * write. 放弃这次提交 gives it back to the input, to send again as a new message with a new requestId.
     */
    public static func prompt(_ write: NativePendingWrite) -> String? {
        guard write.method == "POST" else { return nil }
        switch kind(write) {
        case .start, .topic: return (try? NativeJSON.decode(write.body))?["prompt"].string
        case let .session(id): return write.path == "/link/api/tasks/" + id + "/prompt" ? (try? NativeJSON.decode(write.body))?["prompt"].string : nil
        default: return nil
        }
    }
    /** The Host lists this message in its session by its requestId: it was delivered, whatever the last retry heard. */
    public static func delivered(_ write: NativePendingWrite, detail: NativeJSON) -> Bool {
        guard case let .session(id) = kind(write), prompt(write) != nil, detail["summary"]["id"].string == id else { return false }
        return detail["messages"].array.contains { $0["role"].string == "user" && $0["requestId"].string == write.requestId }
    }
    /**
     * A queue item of the session with the same text as this queued (or steered) message: `waiting` goes out by itself
     * when the turn ends, `parked` only when someone sends it. The queue lists neither request IDs nor devices, so the
     * item may be another device's: this only names it, and never keeps 放弃 away.
     */
    public static func queuedTwin(_ write: NativePendingWrite, detail: NativeJSON) -> String? {
        guard case let .session(id) = kind(write), let text = prompt(write), detail["summary"]["id"].string == id,
              let body = try? NativeJSON.decode(write.body), body["queue"].bool || body["steer"].bool else { return nil }
        let states = detail["queue"].array.filter { $0["text"].string == text }.compactMap { $0["state"].string }
        return states.contains("waiting") ? "waiting" : states.contains("parked") ? "parked" : nil
    }
    /** Text 放弃这次提交 gives back, after what is already in the input and never in its place. */
    public static func joined(_ typed: String, _ back: String) -> String {
        typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? back : typed + "\n\n" + back
    }
}
