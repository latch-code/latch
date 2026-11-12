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
    public static func entries(_ snapshot: NativeJSON) -> [PhoneTabEntry] {
        var result = [PhoneTabEntry(id: .code, label: "Code", symbol: "chevron.left.forwardslash.chevron.right")]
        if snapshot["catalog"]["features"]["customAgents"].bool { result.append(PhoneTabEntry(id: .agents, label: "我的 Agent", symbol: "person.crop.circle")) }
        if !PhoneApps.listed(snapshot).isEmpty { result.append(PhoneTabEntry(id: .apps, label: "应用", symbol: "square.grid.2x2")) }
        result.append(PhoneTabEntry(id: .settings, label: "设置", symbol: "gearshape"))
        return result
    }
    /** Sessions that wait on you, counted as the web's dot counts them: a stop already asked for answers them. */
    public static func waitingCount(_ snapshot: NativeJSON) -> Int {
        let tasks = snapshot["tasks"].array.filter { !$0["archived"].bool }
        let stopping = Set(tasks.filter { $0["live"]["activity"].string == "cancelling" }.compactMap { $0["id"].string })
        let asking = snapshot["approvals"].array.compactMap { $0["sessionId"].string }.filter { !stopping.contains($0) }
        return Set(asking + tasks.filter(PhoneSessions.waitsOnYou).compactMap { $0["id"].string }).count
    }
    /** An amber dot on Code, never a number, while another place is on screen. */
    public static func codeDot(_ snapshot: NativeJSON, current: PhoneTab) -> Bool { current != .code && waitingCount(snapshot) > 0 }
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
    /** A smaller data scope: what is locked, never an empty list. */
    case locked
    /** A phone gets the list only inside a content window; it opens as a conversation does. */
    case closed
    /** The Host is confirming an earlier write and leaves the list out meanwhile. */
    case confirming
    case ready
}

/** The bracket face the Host gave an Agent: brackets around two eyes in one muted hue. 通用 is the same face in grey. */
public struct PhoneAgentAvatar: Equatable, Sendable {
    public static let brackets = ["round", "curly", "square", "angle"]
    public static let eyeKinds = ["dot", "arc", "oval", "sleepy"]
    public static let hues = ["ink", "slate", "pine", "plum", "wisteria", "cocoa", "sand", "moss", "mist"]
    public static let general = PhoneAgentAvatar(bracket: "round", eyes: "dot", hue: "neutral")
    public let bracket: String
    public let eyes: String
    public let hue: String
    /** Only a face of known parts; anything else (a kind or value from a later Host) draws as 通用's grey face. */
    public static func parse(_ value: NativeJSON) -> PhoneAgentAvatar {
        guard value["kind"].string == "face", let bracket = value["bracket"].string, brackets.contains(bracket),
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

public enum PhoneAgents {
    public static let generalId = "general"
    public static let generalName = "通用"
    public static let generalDuty = "没选别的 Agent 的会话都带上它"
    public static func access(_ snapshot: NativeJSON, windowOpen: Bool = true) -> PhoneAgentAccess {
        guard snapshot["catalog"]["features"]["customAgents"].bool else { return .hidden }
        guard snapshot["device"]["dataScope"].string == "all" else { return .locked }
        // Names, duties and schedules are content: outside a window they are not shown, whatever is still in memory.
        guard windowOpen else { return .closed }
        return snapshot["customAgents"] == .null ? .confirming : .ready
    }
    /** The snapshot with what only a content window may show taken out, for when a window closes. */
    public static func withoutPrivate(_ snapshot: NativeJSON) -> NativeJSON {
        guard case var .object(value) = snapshot else { return snapshot }
        value.removeValue(forKey: "customAgents"); value.removeValue(forKey: "automations")
        return .object(value)
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
        guard let projectId, projectId != "default" else { return catalog["sessionFolders"].bool ? "各自的文件夹" : "默认文件夹" }
        return catalog["workspaces"].array.first { $0["id"].string == projectId }?["name"].string ?? "项目已移除"
    }
    /** Ready Harnesses that can receive an Agent's instructions. */
    public static func harnesses(_ catalog: NativeJSON) -> [PhoneStartEntry] {
        let ids = Set(catalog["harnesses"].array.filter { $0["agentContext"].string != nil && $0["offer"] == .null }.compactMap { $0["id"].string })
        return PhoneStart.engines(catalog).filter { ids.contains($0.id) }
    }
    /** The delegation's picks start from the Agent's own. */
    public static func choice(_ catalog: NativeJSON, agent: NativeJSON) -> PhoneStartChoice {
        let harnessId = harnesses(catalog).first { $0.id == agent["harnessId"].string }?.id
        let projects = PhoneStart.projects(catalog)
        let project = projects.first { $0.id == agent["defaultProjectId"].string } ?? projects.first { $0.id == "default" }
        let models = PhoneStart.models(catalog)
        let model = models.first { $0.providerId == agent["model"]["providerId"].string && $0.model == agent["model"]["model"].string }
        return PhoneStartChoice(harnessId: harnessId, workspaceId: project?.id, model: model)
    }
    /** Why 委托 cannot start now, in the web's words; nil when it can. */
    public static func blocker(_ catalog: NativeJSON, agent: NativeJSON, choice: PhoneStartChoice, connected: Bool, canRun: Bool) -> String? {
        if !connected { return "Mac 不在线，恢复后再委托" }
        if !canRun { return "这台设备不能开始会话" }
        if !agent["available"].bool { return agent["unavailableReason"].string ?? "现在不能委托" }
        guard let id = choice.harnessId, harnesses(catalog).contains(where: { $0.id == id }) else { return "先选 Harness" }
        if let workspace = choice.workspaceId, !PhoneStart.projects(catalog).contains(where: { $0.id == workspace }) { return "这个项目已不可用。" }
        return nil
    }
    /** The mode a delegation asks for: the Agent's own, where the chosen Harness has it. */
    public static func mode(_ catalog: NativeJSON, harnessId: String, agentMode: String?) -> String {
        let modes = catalog["harnesses"].array.first { $0["id"].string == harnessId }?["modes"].array.compactMap(\.string) ?? []
        let wanted = agentMode ?? "agent"
        return modes.isEmpty || modes.contains(wanted) ? wanted : modes[0]
    }
    /** 委托's start request: the Agent, then what was picked for this session. */
    public static func fields(_ catalog: NativeJSON, agent: NativeJSON, choice: PhoneStartChoice, prompt: String) throws -> [String: NativeJSON] {
        guard let id = agent["id"].string, validId(id), id != generalId, let harnessId = choice.harnessId else { throw NativeFailure.invalidRecord }
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
    /** This Agent's sessions, newest first. 通用 has none of its own. */
    public static func recent(_ tasks: [NativeJSON], id: String) -> [NativeJSON] {
        guard id != generalId else { return [] }
        return tasks.filter { $0["agent"]["customAgentId"].string == id && !$0["archived"].bool }
            .sorted { (PhoneTime.parse($0["updatedAt"]) ?? .distantPast) > (PhoneTime.parse($1["updatedAt"]) ?? .distantPast) }
    }
    /** 「为 <Agent> 委托」 on a delegated session, plain 「委托」 outside a window; nil on any other. */
    public static func delegated(_ snapshot: NativeJSON, task: NativeJSON, windowOpen: Bool = true) -> String? {
        guard let id = task["agent"]["customAgentId"].string else { return nil }
        guard windowOpen else { return "委托" }
        let name = snapshot["customAgents"].array.first { $0["id"].string == id }?["name"].string ?? "Agent"
        return "为 " + name + " 委托"
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
    case delegation(agentId: String)
    case memory(owner: String)
    case session(id: String)
    case other
}

public enum PhonePending {
    public static func kind(_ write: NativePendingWrite) -> PhonePendingKind {
        if write.path == "/link/api/tasks" && write.method == "POST" {
            if let id = (try? NativeJSON.decode(write.body))?["customAgentId"].string { return .delegation(agentId: id) }
            return .start
        }
        let parts = write.path.split(separator: "/").map(String.init)
        if parts.count >= 5, parts[2] == "custom-agents", parts[4] == "memories" { return .memory(owner: parts[3]) }
        if parts.count >= 4, parts[2] == "tasks" { return .session(id: parts[3]) }
        return .other
    }
    public static func words(_ write: NativePendingWrite) -> String {
        if let words = PhoneHistory.pendingWords(write) { return words }
        switch kind(write) {
        case .delegation: return "委托结果待确认"
        case .memory: return "记忆的修改结果待确认"
        case .start: return (try? NativeJSON.decode(write.body))?["forkOf"] != .null ? "分叉结果待确认" : "提交结果待确认"
        case .session:
            return write.path.hasSuffix("/config") ? "切换结果待确认" : "提交结果待确认"
        case .other: return "提交结果待确认"
        }
    }
}
