import Foundation

/** The Host chooses the chat. Earlier sessions stay visible as history. */
public enum PhoneAgentChat {
    public static func slot(_ snapshot: NativeJSON, owner: String) -> NativeJSON {
        guard snapshot["catalog"]["features"]["singleAgentChat"].bool else { return .null }
        return snapshot["agentChats"][owner]
    }

    public static func session(_ snapshot: NativeJSON, owner: String) -> String? {
        let chat = slot(snapshot, owner: owner)
        return chat["state"].string == "ready" ? chat["sessionId"].string : nil
    }

    public static func isCurrent(_ snapshot: NativeJSON, task: NativeJSON) -> Bool {
        guard let owner = owner(task), let id = task["id"].string else { return false }
        return session(snapshot, owner: owner) == id
    }

    public static func model(_ snapshot: NativeJSON, task: NativeJSON) -> PhoneModelChoice? {
        guard task["harnessId"].string == "standard", isCurrent(snapshot, task: task), let owner = owner(task),
              let agent = snapshot["customAgents"].array.first(where: { $0["id"].string == owner && $0["harnessId"].string == "standard" }),
              let provider = agent["model"]["providerId"].string, let model = agent["model"]["model"].string else { return nil }
        return PhoneStart.models(snapshot["catalog"]).first { $0.providerId == provider && $0.model == model }
            ?? PhoneModelChoice(providerId: provider, providerName: provider, model: model)
    }

    /** The Agent a session belongs to in 我的 Agent: one of yours, 通用 for a conversation with it, or none. */
    public static func owner(_ task: NativeJSON) -> String? {
        if let id = task["agent"]["customAgentId"].string { return id }
        return task["generalChat"].bool ? PhoneAgents.generalId : nil
    }
    private static func newer(_ a: NativeJSON, _ b: NativeJSON) -> Bool {
        (PhoneTime.parse(a["updatedAt"]) ?? .distantPast) > (PhoneTime.parse(b["updatedAt"]) ?? .distantPast)
    }
    /** An Agent's topics, newest first: the open ones, and the archived ones apart. */
    public static func topics(_ tasks: [NativeJSON], id: String) -> (open: [NativeJSON], archived: [NativeJSON]) {
        let own = tasks.filter { owner($0) == id }.sorted(by: newer)
        return (own.filter { !$0["archived"].bool }, own.filter { $0["archived"].bool })
    }
    public static func placeholder(_ name: String) -> String { "给 " + name + " 发消息…" }
    /** Where a session opened from an Agent's page goes: its conversation when it is this owner's, else Code. */
    public static func home(_ tasks: [NativeJSON], session: String, owner: String) -> PhoneSpace {
        tasks.first { $0["id"].string == session }.map { self.owner($0) == owner ? .agents : .code } ?? .code
    }
    /** A topic's state in the session list's words; a topic at rest says nothing. */
    public static func topicWords(_ task: NativeJSON, frozen: Bool) -> String? {
        switch PhoneSessions.rowStatus(task, frozen: frozen) {
        case .waiting, .silent: "等你处理"
        case .running: "运行中"
        case .stopping: "正在停止"
        case .failed: "失败"
        case let .ended(word, _): word
        case .frozen, .read: nil
        }
    }
    /** New General topics use Standard Agent, independently of the Code defaults. */
    public static func generalChoice(_ catalog: NativeJSON) -> PhoneStartChoice {
        PhoneStartChoice(harnessId: "standard", workspaceId: nil, model: PhoneStart.defaultModel(catalog, harnessId: "standard"))
    }
    /** New requests only; an old pending write retains its original body and request ID. */
    public static func generalFields(_ catalog: NativeJSON, choice: PhoneStartChoice, prompt: String) throws -> [String: NativeJSON] {
        guard choice.harnessId == "standard", PhoneAgents.harnesses(catalog).contains(where: { $0.id == "standard" }) else { throw NativeFailure.invalidRecord }
        var result: [String: NativeJSON] = ["prompt": .string(prompt), "customAgentId": .string(PhoneAgents.generalId),
            "harnessId": .string("standard"), "mode": .string("agent"), "workspaceId": .string("default")]
        if let model = choice.model {
            result["model"] = .object(["providerId": .string(model.providerId), "model": .string(model.model)])
        }
        return result
    }
    /** Why a new topic with 通用 cannot start now; nil when it can. */
    public static func generalBlocker(_ catalog: NativeJSON, choice: PhoneStartChoice, connected: Bool, canRun: Bool) -> String? {
        if !connected { return "Mac 不在线，恢复后再发" }
        if !canRun { return "这台设备不能开始会话" }
        guard choice.harnessId == "standard", PhoneAgents.harnesses(catalog).contains(where: { $0.id == "standard" }) else { return "Latch 内置暂不可用" }
        if choice.model == nil { return "还没有模型服务。在 Mac 上的 Latch 里添加。" }
        return nil
    }
    /** Counts of 技能 and 工具 for the profile, as the web's facts line has them. */
    public static func kitWords(_ catalog: NativeJSON, agent: NativeJSON) -> String {
        let skills: String
        if case let .array(chosen) = agent["skills"] { skills = chosen.isEmpty ? "不用技能" : "\(chosen.count) 个技能" }
        else if let count = agent["skillCount"].integer { skills = "\(count) 个技能" }
        else { skills = "全部已启用的技能" }
        return skills + " · " + PhoneAgents.toolWords(agent["tools"])
    }
}

/** A memory or schedule proposal as a row draws it: its text and reason already made visible, never acted on. */
public struct PhoneProposal: Equatable, Sendable, Identifiable {
    public enum State: String, Sendable { case pending, saved, dismissed }
    /** A schedule proposal's name (as shown and as sent) and its plan, the Host's own shape. */
    public struct Schedule: Equatable, Sendable {
        public let name: String
        public let rawName: String
        public let plan: NativeJSON
    }
    public let id: String
    public let content: String
    /** Each run's input as the Agent wrote it, for the schedule it may become; the same as `content` before marking. */
    public let prompt: String
    /** Set on a schedule proposal; nil on a memory proposal. */
    public let schedule: Schedule?
    public let reason: String?
    /** `user`: the person's own 「记住…」; `agent`: the Agent proposed it. */
    public let origin: String
    public let external: Bool
    public let sessionId: String
    public let messageId: String?
    public let requestId: String?
    public let state: State
    /** A 「记住…」 the Host did not keep: `content` is its reason; it has no buttons. */
    public let refused: Bool
    /** A schedule proposal saved: the schedule the Host made from it. */
    public var automationId: String? = nil
}

public enum PhoneProposals {
    public static func validId(_ id: String) -> Bool { LinkBytes.matches(id, "prp_[a-f0-9-]{36}") }
    /** `GET …/proposals`, newest last as the Host lists them; a row with anything unknown is left out. */
    public static func parse(_ list: NativeJSON) -> [PhoneProposal] {
        list["proposals"].array.compactMap { item in
            guard let id = item["id"].string, validId(id), let content = item["content"].string, let session = item["source"]["sessionId"].string,
                  let state = item["state"].string.flatMap(PhoneProposal.State.init(rawValue:)) else { return nil }
            var schedule: PhoneProposal.Schedule?
            switch item["kind"] {
            case .null: schedule = nil
            case .string("schedule"):
                let plan = item["schedule"]["plan"]
                guard let name = item["schedule"]["name"].string, ["daily", "weekdays", "weekly"].contains(plan["kind"].string ?? "") else { return nil }
                schedule = PhoneProposal.Schedule(name: PhoneConversation.visible(name), rawName: name, plan: plan)
            default: return nil
            }
            return PhoneProposal(id: id, content: PhoneConversation.visible(content), prompt: content, schedule: schedule, reason: item["reason"].string.map(PhoneConversation.visible),
                origin: item["origin"].string == "user" ? "user" : "agent", external: item["external"].bool, sessionId: session,
                messageId: item["source"]["messageId"].string, requestId: item["source"]["requestId"].string, state: state, refused: false,
                automationId: item["automationId"].string.flatMap { PhoneAgents.validAutomation($0) ? $0 : nil })
        }
    }
    /** The person's 「记住…」 the Host did not keep, from the session's detail: each on its own turn, with why. */
    public static func refusals(_ detail: NativeJSON) -> [PhoneProposal] {
        guard let session = detail["summary"]["id"].string else { return [] }
        return detail["memoryRefusals"].array.compactMap { refusal in
            guard let request = refusal["requestId"].string, let reason = refusal["reason"].string else { return nil }
            return PhoneProposal(id: "refused:" + request, content: PhoneConversation.visible(reason), prompt: "", schedule: nil, reason: nil, origin: "user", external: false,
                sessionId: session, messageId: nil, requestId: request, state: .dismissed, refused: true)
        }
    }
    /** Pending memory proposals, for 记忆: a schedule proposal is no memory and is not listed there. */
    public static func pending(_ proposals: [PhoneProposal]) -> [PhoneProposal] { proposals.filter { $0.state == .pending && $0.schedule == nil } }
    public static func originWords(_ origin: String) -> String { origin == "user" ? "你说的" : "它推断的" }
    /** When a saved memory reaches the Agent: the built-in Harness reads memories each turn; an external one with a topic's first turn. */
    public static func effectWords(_ harness: NativeJSON) -> String { harness["agentContext"].string == "private" ? "已生效" : "清空上下文后生效" }
    /** The user message a proposal came from: by its ID, or the person's message by its request. */
    public static func turn(_ proposal: PhoneProposal, messages: [NativeJSON]) -> String? {
        let users = messages.filter { $0["role"].string == "user" }
        if let id = proposal.messageId, let found = users.first(where: { $0["id"].string == id }) { return found["id"].string }
        if let request = proposal.requestId, let found = users.first(where: { $0["requestId"].string == request }) { return found["id"].string }
        return nil
    }
    /** Each proposal of this session after its turn; those whose turn is not shown after the last one, '' before any turn. */
    public static func place(_ proposals: [PhoneProposal], sessionId: String, messages: [NativeJSON], turnIds: [String]) -> [String: [PhoneProposal]] {
        let keys = Set(turnIds), last = turnIds.last ?? ""
        var placed: [String: [PhoneProposal]] = [:]
        for proposal in proposals where proposal.sessionId == sessionId {
            let key = turn(proposal, messages: messages).flatMap { keys.contains($0) ? $0 : nil } ?? last
            placed[key, default: []].append(proposal)
        }
        return placed
    }
    /** What the snapshot says of an owner's proposals; a page reads them again when it changes. Counts only, never text. */
    public static func signature(_ snapshot: NativeJSON, owner: String) -> String {
        let state = snapshot["agentProposals"][owner]
        return (state["pending"].integer.map { "\($0)" } ?? "-") + ":" + (state["at"].string ?? "")
    }
    public static func save(owner: String, proposalId: String) throws -> NativePendingWrite { try decide(owner, proposalId, "save") }
    public static func dismiss(owner: String, proposalId: String) throws -> NativePendingWrite { try decide(owner, proposalId, "dismiss") }
    private static func decide(_ owner: String, _ id: String, _ verb: String) throws -> NativePendingWrite {
        guard PhoneAgents.validId(owner), validId(id) else { throw NativeFailure.invalidRecord }
        return try NativePendingWrite(method: .post, path: "/link/api/custom-agents/" + owner + "/proposals/" + id + "/" + verb, fields: [:])
    }
    /** This device's unconfirmed save or dismiss of the proposal, and which of the two it is. */
    public static func held(_ pending: [NativePendingWrite], owner: String, proposalId: String) -> (write: NativePendingWrite, saving: Bool)? {
        let base = "/link/api/custom-agents/" + owner + "/proposals/" + proposalId + "/"
        guard let write = pending.first(where: { $0.path.hasPrefix(base) && $0.method == "POST" }) else { return nil }
        return (write, write.path.hasSuffix("/save"))
    }
}

/** A memory's source and its last change, as the 记忆 section shows them. */
public enum PhoneMemories {
    /** Deleted memories whose text the Host still keeps for 撤销, newest first. */
    public static func deleted(_ detail: NativeJSON) -> [NativeJSON] {
        let present = Set(detail["memories"].array.compactMap { $0["id"].string })
        return detail["memoryChanges"].array.filter { $0["operation"].string == "delete" && !present.contains($0["memoryId"].string ?? "") }
    }
    /** Whether a memory's last change was an edit that can still be undone. */
    public static func edited(_ detail: NativeJSON, memoryId: String) -> Bool {
        detail["memoryChanges"].array.contains { $0["memoryId"].string == memoryId && $0["operation"].string == "update" }
    }
    /** 「你说的」 or 「它推断的」, whether it came from outside content, and its topic; nil for a memory the person wrote. */
    public static func source(_ memory: NativeJSON) -> (words: String, external: Bool, sessionId: String?, at: Date?)? {
        let source = memory["source"]
        guard source != .null, let origin = source["origin"].string else { return nil }
        return (PhoneProposals.originWords(origin), source["external"].bool, source["sessionId"].string, PhoneTime.parse(source["proposedAt"]))
    }
    /** 撤销 brings back the text before the last edit, or the deleted memory; `baseRevision` is the revision shown. */
    public static func undo(owner: String, memoryId: String, baseRevision: Int) throws -> NativePendingWrite {
        try NativePendingWrite(method: .post, path: path(owner, memoryId), fields: ["baseRevision": .number(Double(baseRevision))])
    }
    /** 清除: a deleted memory's text goes now. */
    public static func forget(owner: String, memoryId: String, baseRevision: Int) throws -> NativePendingWrite {
        try NativePendingWrite(method: .delete, path: path(owner, memoryId), fields: ["baseRevision": .number(Double(baseRevision))])
    }
    private static func path(_ owner: String, _ memoryId: String) throws -> String {
        guard PhoneAgents.validId(owner), LinkBytes.matches(memoryId, "mem_[a-f0-9-]{36}") else { throw NativeFailure.invalidRecord }
        return "/link/api/custom-agents/" + owner + "/memories/" + memoryId + "/undo"
    }
}

/** 即将进行's switch: the schedule's revision as shown, so a change made elsewhere is not overwritten. */
public enum PhoneScheduleWrite {
    public static func enabled(_ automation: NativeJSON, on: Bool) throws -> NativePendingWrite {
        guard let id = automation["id"].string, PhoneAgents.validAutomation(id), let revision = automation["revision"].integer else { throw NativeFailure.invalidRecord }
        return try NativePendingWrite(method: .post, path: "/link/api/automations/" + id + "/enabled",
            fields: ["enabled": .bool(on), "baseRevision": .number(Double(revision))])
    }
    /** Why this device cannot turn a schedule on now, in the web's words; nil when it can. Turning one off is always allowed. */
    public static func blocker(agent: NativeJSON, connected: Bool, canRun: Bool, manual: Bool = false) -> String? {
        if !connected { return "Mac 不在线，恢复后再改" }
        if !canRun { return "这台设备只能查看定时任务：它没有开始会话的权限。" }
        if agent != .null && !(manual ? agent["available"].bool : agent["canAutomate"].bool) {
            return agent["unavailableReason"].string ?? (manual ? "这个 Agent 暂不可用。" : "这个 Agent 现在不能用于定时任务。")
        }
        return nil
    }
    /** This device's unconfirmed switch of the schedule. */
    public static func held(_ pending: [NativePendingWrite], automationId: String) -> NativePendingWrite? {
        pending.first { $0.path == "/link/api/automations/" + automationId + "/enabled" }
    }
}

extension PhoneAgentChat {
    /**
     * The new topic's input after a start: emptied once the Host holds the request (answered, or unknown and kept), so
     * 放弃这次提交 gives the text back once rather than doubling it; kept when nothing was sent.
     */
    public static func promptAfterStart(_ prompt: String, pending: [NativePendingWrite], owner: String, started: Bool) -> String {
        started || pending.contains(where: { PhonePending.kind($0) == .topic(owner: owner) }) ? "" : prompt
    }
}

/** Where an unconfirmed write is offered again: each page offers only what it can open the answer of. */
public enum PhonePendingPlace: Equatable, Sendable {
    /** A session's conversation. */
    case session(String)
    /** The new topic of an Agent or 通用. */
    case newTopic(String)
    /** The session list, which offers every write so none blocks the others unseen. */
    case list
}

extension PhonePending {
    /** Whether this place offers 重试 for the write: a new topic's start only on that new topic or the list. */
    public static func retried(_ write: NativePendingWrite, at place: PhonePendingPlace) -> Bool {
        guard case let .topic(owner) = kind(write) else { return true }
        switch place {
        case let .newTopic(page): return page == owner
        case .list: return true
        case .session: return false
        }
    }
    /** The new-topic owner whose page must open when the list retries a start, nil for any other write. */
    public static func topicOwner(_ write: NativePendingWrite) -> String? {
        if case let .topic(owner) = kind(write) { return owner }
        return nil
    }
}

/**
 * What was read inside a content window, by owner (memory proposals, result cards waiting for a topic). Each read takes
 * a token and only the owner's latest read is adopted, so a slow earlier answer never replaces a newer list; `clear`
 * (lock, window closed, scope changed) drops the lists and every token, so a read still in flight is dropped too.
 */
public struct PhoneOwnerStore<Value: Equatable & Sendable>: Equatable, Sendable {
    private var lists: [String: Value] = [:]
    private var tokens: [String: UUID] = [:]
    public init() {}
    public subscript(owner: String) -> Value? { lists[owner] }
    public var isEmpty: Bool { lists.isEmpty && tokens.isEmpty }
    /** Every owner's list, in no order. */
    public var all: [Value] { Array(lists.values) }
    public mutating func begin(_ owner: String) -> UUID {
        let token = UUID(); tokens[owner] = token; return token
    }
    /** True when adopted. */
    @discardableResult public mutating func finish(_ owner: String, token: UUID, value: Value, windowOpen: Bool) -> Bool {
        guard windowOpen, tokens[owner] == token else { return false }
        lists[owner] = value
        return true
    }
    public mutating func drop(_ owner: String) { lists[owner] = nil; tokens[owner] = nil }
    public mutating func clear() { lists = [:]; tokens = [:] }
}
public typealias PhoneProposalStore = PhoneOwnerStore<[PhoneProposal]>
extension PhoneOwnerStore where Value == [PhoneProposal] {
    @discardableResult public mutating func finish(_ owner: String, token: UUID, list: NativeJSON, windowOpen: Bool) -> Bool {
        finish(owner, token: token, value: PhoneProposals.parse(list), windowOpen: windowOpen)
    }
}
public typealias PhoneResultStore = PhoneOwnerStore<[PhoneScheduleResult]>

extension PhoneAgents {
    /**
     * What a closing window (lock, revoke, expiry, a scope change) takes from 我的 Agent: the snapshot's Agents, schedules,
     * proposal and card counts, the proposals read, and the cards waiting for a topic, with every read still in flight.
     */
    public static func takeDown(_ snapshot: NativeJSON, proposals: inout PhoneProposalStore, results: inout PhoneResultStore) -> NativeJSON {
        proposals.clear(); results.clear()
        return withoutPrivate(snapshot)
    }
}

/** What a page showing a window's content does when the content generation changes. */
public enum PhoneContentChange: Equatable, Sendable {
    /** The window closed: what it showed goes, and nothing asks to open it again. */
    case close
    /** Read again inside the still-open window. */
    case reload
    /** Nothing was shown from the window. */
    case none
    public static func next(windowOpen: Bool, showing: Bool) -> PhoneContentChange {
        guard showing else { return .none }
        return windowOpen ? .reload : .close
    }
}
