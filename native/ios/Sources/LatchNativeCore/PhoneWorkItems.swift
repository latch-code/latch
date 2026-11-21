import Foundation

public enum PhoneWorkGroup: String, CaseIterable, Sendable {
    case attention, running, deliver, todo, done
    public var label: String {
        switch self {
        case .attention: "等你处理"
        case .running: "进行中"
        case .deliver: "可交付"
        case .todo: "未开始"
        case .done: "已结束"
        }
    }
}

public enum PhoneWorkReason: String, Sendable {
    case question, approval, unknown, failed, silent, unrecognized, settled
    public var label: String {
        switch self {
        case .question: "有问题待回答"
        case .approval: "需要你允许"
        case .unknown: "投递结果未知"
        case .failed: "失败"
        case .silent: "暂时没有动静"
        case .unrecognized: "需要在 Mac 上查看"
        case .settled: "会话已结束"
        }
    }
}

public struct PhoneWorkItemSummary: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let revision: UInt64
    public let threadRevision: UInt64?
    public let updatedAt: Date
    public let isPrivate: Bool
    public let projectId: String?
    public let sessionIds: [String]
    public let group: PhoneWorkGroup?
    public let reason: PhoneWorkReason?
    public let postId: String?
    public let note: String?
    public let tags: [String]
    public let priority: String?

    public init?(_ value: NativeJSON) {
        guard let id = value["id"].string, PhoneWorkItems.validItem(id),
              let title = PhoneWorkItems.text(value["title"], max: 120), !title.isEmpty,
              let revision = value["revision"].integer, let at = PhoneTime.parse(value["updatedAt"]),
              value.object["private"] == nil || value["private"] == .bool(true),
              case let .array(sessions) = value["sessionIds"], sessions.count <= 16 else { return nil }
        let ids = sessions.compactMap { $0.string.flatMap(PhoneWorkItems.session) }
        guard ids.count == sessions.count, Set(ids).count == ids.count,
              value.object["threadRevision"] == nil || value["threadRevision"].integer != nil else { return nil }
        let group = value["board"]["group"].string.flatMap(PhoneWorkGroup.init)
        let postId = value["board"]["postId"].string
        guard value.object["board"] == nil || group != nil,
              value["board"].object["postId"] == nil || (group == .attention && postId.map(PhoneWorkItems.validPost) == true) else { return nil }
        self.id = id; self.title = title; self.revision = revision; threadRevision = value["threadRevision"].integer
        updatedAt = at; isPrivate = value["private"] == .bool(true); projectId = PhoneWorkItems.text(value["projectId"], max: 256)
        sessionIds = ids; self.group = group
        reason = value["board"]["reason"].string.flatMap(PhoneWorkReason.init); self.postId = postId
        note = Self.line(value["note"], limit: 140)
        var seen = Set<String>()
        tags = value["tags"].array.prefix(8).compactMap {
            guard let tag = Self.line($0, limit: 24), seen.insert(tag).inserted else { return nil }
            return tag
        }
        switch value["priority"].string {
        case "high": priority = "高优先级"
        case "low": priority = "低优先级"
        default: priority = nil
        }
    }

    private static func line(_ value: NativeJSON, limit: Int) -> String? {
        guard let raw = PhoneWorkItems.text(value, max: limit) else { return nil }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.unicodeScalars.contains(where: { CharacterSet.newlines.contains($0) }) else { return nil }
        return PhoneConversation.visible(text)
    }
}

/** The project choices of the visible work items. A missing member summary never implies that it has no project. */
public struct PhoneWorkList {
    public enum Project: Hashable {
        case unassigned
        case saved(String)

        public init(_ id: String?) {
            if let id, id != "default" { self = .saved(id) } else { self = .unassigned }
        }
    }

    public let projects: [Project]
    private let names: [String: String]
    private let membersById: [String: (project: Project, updated: Date?)]
    private let rows: [(item: PhoneWorkItemSummary, projects: Set<Project>)]

    public struct Presentation {
        public let project: String?
        public let updatedAt: Date
        public let sessionCount: Int
        public let note: String?
        public let tags: [String]
        public let priority: String?
        public let reason: PhoneWorkReason?
    }

    public init(items: [PhoneWorkItemSummary], snapshot: NativeJSON) {
        let workspaces = snapshot["catalog"]["workspaces"].array
        var names: [String: String] = [:]
        for workspace in workspaces {
            if let id = workspace["id"].string { names[id] = workspace["name"].string ?? id }
        }
        self.names = names

        let members = Set(items.flatMap(\.sessionIds))
        var byId: [String: (project: Project, updated: Date?)] = [:]
        for task in snapshot["tasks"].array {
            guard let id = task["id"].string, members.contains(id) else { continue }
            let project = Project(PhoneSessions.project(of: task, workspaces: workspaces)?["id"].string)
            byId[id] = (project, PhoneTime.parse(task["updatedAt"]))
        }
        membersById = byId
        rows = items.map { item in
            var projects = Set(item.sessionIds.compactMap { byId[$0]?.project })
            if item.projectId != nil || item.sessionIds.isEmpty { projects.insert(Project(item.projectId)) }
            return (item, projects)
        }
        projects = Set(rows.flatMap(\.projects)).sorted { left, right in
            guard case let .saved(a) = left else { return false }
            guard case let .saved(b) = right else { return true }
            let order = (names[a] ?? a).localizedStandardCompare(names[b] ?? b)
            return order == .orderedSame ? a < b : order == .orderedAscending
        }
    }

    /** The member index comes only from visible session summaries. A missing member has no name or update time to show. */
    public func presentation(for item: PhoneWorkItemSummary) -> Presentation {
        let members = item.sessionIds.compactMap { membersById[$0] }
        let suggested = item.projectId.flatMap { $0 == "default" ? nil : names[$0] }
        let memberProject = members.lazy.compactMap { member -> String? in
            guard case let .saved(id) = member.project else { return nil }
            return names[id]
        }.first
        let latest = members.compactMap(\.updated).max() ?? item.updatedAt
        let reason = item.group == .attention || (item.group == .deliver && item.reason == .settled) ? item.reason : nil
        return Presentation(project: suggested ?? memberProject, updatedAt: max(item.updatedAt, latest), sessionCount: item.sessionIds.count,
                            note: item.note, tags: item.tags, priority: item.priority, reason: reason)
    }

    public func name(of project: Project) -> String {
        switch project {
        case .unassigned: "无项目"
        case let .saved(id): names[id] ?? id
        }
    }

    /** Choosing several projects takes their union. A title narrows those results without changing Host order or group. */
    public func matching(title: String, projects selected: Set<Project>) -> [PhoneWorkItemSummary] {
        let needle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return rows.compactMap { row in
            guard selected.isEmpty || !row.projects.isDisjoint(with: selected),
                  needle.isEmpty || row.item.title.localizedCaseInsensitiveContains(needle) else { return nil }
            return row.item
        }
    }
}

public struct PhoneWorkItemDetail: Equatable, Sendable {
    public let item: PhoneWorkItemSummary
    public let closed: Bool
    public let prompt: String
    public let note: String?
    public let origin: PhoneWorkSource?

    public init(_ answer: NativeJSON, itemId: String, privateAllowed: Bool) throws {
        let value = answer["item"]
        guard let item = PhoneWorkItemSummary(value), item.id == itemId, !item.isPrivate || privateAllowed,
              item.group != nil, let prompt = PhoneWorkItems.text(value["prompt"], max: 16_000) else { throw NativeFailure.invalidRecord }
        guard value.object["closedAt"] == nil || PhoneTime.parse(value["closedAt"]) != nil else { throw NativeFailure.invalidRecord }
        self.item = item; self.prompt = prompt; closed = value.object["closedAt"] != nil
        note = PhoneWorkItems.text(value["note"], max: 512)
        if let session = value["from"]["sessionId"].string.flatMap(PhoneWorkItems.session),
           let message = PhoneWorkItems.message(value["from"]["messageId"]) {
            origin = PhoneWorkSource(sessionId: session, anchor: .message(message))
        } else { origin = nil }
    }
}

public struct PhoneWorkTurn: Equatable, Hashable, Sendable {
    public let sessionId: String
    public let userMessageId: String
    public let runId: String?

    public init?(_ value: NativeJSON) {
        guard let sessionId = value["sessionId"].string.flatMap(PhoneWorkItems.session),
              let message = PhoneWorkItems.message(value["userMessageId"]),
              value.object["runId"] == nil || PhoneWorkItems.message(value["runId"]) != nil else { return nil }
        self.sessionId = sessionId; userMessageId = message; runId = PhoneWorkItems.message(value["runId"])
    }
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.sessionId == rhs.sessionId && PhoneWorkItems.same(lhs.userMessageId, rhs.userMessageId)
            && PhoneWorkItems.same(lhs.runId, rhs.runId)
    }
    public func hash(into hasher: inout Hasher) {
        hasher.combine(sessionId); hasher.combine(Array(userMessageId.utf8)); hasher.combine(runId.map { Array($0.utf8) })
    }
}

public struct PhoneWorkDecision: Equatable, Hashable, Sendable {
    public enum Kind: String, Sendable { case question, approval }
    public let kind: Kind
    public let id: String
}

/** The Host's source identity. A message-only source is historical and never earns a decision button. */
public struct PhoneWorkSource: Equatable, Hashable, Sendable {
    public enum Anchor: Equatable, Hashable, Sendable {
        case message(String)
        case turn(PhoneWorkTurn, PhoneWorkDecision?)
    }
    public let sessionId: String
    public let anchor: Anchor

    public init(sessionId: String, anchor: Anchor) { self.sessionId = sessionId; self.anchor = anchor }

    public func locate(in turns: [PhoneTurn]) -> PhoneTurn? {
        switch anchor {
        case let .message(message):
            turns.first { turn in
                PhoneWorkItems.same(turn.user?["id"].string, message) || turn.replies.contains { PhoneWorkItems.same($0["id"].string, message) }
            }
        case let .turn(source, _):
            turns.first { PhoneWorkItems.same($0.user?["id"].string, source.userMessageId) }
        }
    }

    public var runId: String? { if case let .turn(turn, _) = anchor { turn.runId } else { nil } }
    public var decision: PhoneWorkDecision? { if case let .turn(_, decision) = anchor { decision } else { nil } }

    /** Use the exact decision, even if another is first in the session. No latest-run fallback. */
    public func currentDecision(detail: NativeJSON, summary: NativeJSON) -> NativeJSON? {
        guard case let .turn(turn, decision?) = anchor, turn.sessionId == sessionId, let run = turn.runId,
              detail["summary"]["id"].string == sessionId, summary["id"].string == sessionId,
              PhoneWorkItems.same(detail["summary"]["runId"].string, run), PhoneWorkItems.same(summary["runId"].string, run),
              ["running", "waiting-approval"].contains(summary["status"].string ?? ""),
              summary["live"]["activity"].string != "cancelling",
              let user = detail["messages"].array.last(where: { $0["role"].string == "user" && !$0["steered"].bool }),
              PhoneWorkItems.same(user["id"].string, turn.userMessageId) else { return nil }
        switch decision.kind {
        case .question:
            guard (summary["pendingQuestions"].integer ?? 1) > 0 else { return nil }
            return detail["questions"].array.first { $0["id"].string == decision.id && $0["state"].string == "pending" }
        case .approval:
            return detail["approvals"].array.first { $0["id"].string == decision.id && $0["sessionId"].string == sessionId }
        }
    }
}

public struct PhoneWorkPost: Equatable, Sendable, Identifiable {
    public enum Delivery: String, Sendable {
        case sending, sent, unknown, failed
        public var label: String {
            switch self {
            case .sending: "正在投递"
            case .sent: "已送达"
            case .unknown: "结果未知"
            case .failed: "投递失败"
            }
        }
    }

    public struct Reply: Equatable, Sendable {
        public let id: String
        public let text: String
        public let more: Bool
        public let live: Bool
    }

    public let id: String
    public let at: Date
    public let text: String
    public let delivery: Delivery?
    public let refusal: String?
    public let sourceSessionId: String?
    private let sourceWithdrawn: Bool
    public let turn: PhoneWorkTurn?
    public let reply: Reply?
    public let attention: PhoneWorkReason?
    public let source: PhoneWorkSource?

    public init?(_ value: NativeJSON) {
        guard let id = value["id"].string, PhoneWorkItems.validPost(id), let at = PhoneTime.parse(value["at"]),
              let text = PhoneWorkItems.text(value["text"], max: 4000), !text.isEmpty else { return nil }
        let turn = PhoneWorkTurn(value["turn"]), delivery = value["delivery"]["state"].string.flatMap(Delivery.init)
        let session = value["delivery"]["sessionId"].string.flatMap(PhoneWorkItems.session)
        guard value.object["delivery"] == nil || delivery != nil,
              value["delivery"].object["sessionId"] == nil || session != nil,
              value.object["turn"] == nil || (turn != nil && turn?.sessionId == session) else { return nil }
        self.id = id; self.at = at; self.text = text; self.turn = turn; self.delivery = delivery
        sourceSessionId = session
        sourceWithdrawn = false
        refusal = session == nil ? nil : PhoneWorkItems.text(value["delivery"]["reason"], max: 300)
        if value.object["reply"] != nil {
            guard session != nil, let message = PhoneWorkItems.message(value["reply"]["messageId"]),
                  let words = PhoneWorkItems.text(value["reply"]["text"], max: 2000) else { return nil }
            reply = Reply(id: message, text: words, more: value["reply"]["more"] == .bool(true), live: value["reply"]["live"] == .bool(true))
        } else { reply = nil }
        let reason = value["attention"]["reason"].string
        attention = reason.flatMap(PhoneWorkReason.init)
        let decision: PhoneWorkDecision? = if let kind = reason.flatMap(PhoneWorkDecision.Kind.init),
            let id = value["attention"]["decisionId"].string.flatMap(PhoneWorkItems.session), turn?.runId != nil {
            PhoneWorkDecision(kind: kind, id: id)
        } else { nil }
        if let turn { source = PhoneWorkSource(sessionId: turn.sessionId, anchor: .turn(turn, decision)) }
        else if let session, let reply { source = PhoneWorkSource(sessionId: session, anchor: .message(reply.id)) }
        else { source = nil }
    }

    private init(withdrawn post: Self) {
        id = post.id; at = post.at; text = post.text; delivery = post.delivery; sourceSessionId = post.sourceSessionId
        sourceWithdrawn = true
        refusal = nil; turn = nil; reply = nil; attention = nil; source = nil
    }

    /** The person's post remains readable. Evidence projected from its source must be read again. */
    public func projectingSource(_ snapshot: NativeJSON) -> Self {
        guard let sourceSessionId, PhoneWorkItems.sourceVisibility(snapshot, sessionId: sourceSessionId) != .readable else { return self }
        return Self(withdrawn: self)
    }

    fileprivate func sourceNeedsReread(_ snapshot: NativeJSON) -> Bool {
        guard sourceWithdrawn, let sourceSessionId else { return false }
        return PhoneWorkItems.sourceVisibility(snapshot, sessionId: sourceSessionId) == .readable
    }
}

public struct PhoneWorkPostPage: Equatable, Sendable {
    public let posts: [PhoneWorkPost]
    public let revision: UInt64
    public let before: String?

    public init(_ answer: NativeJSON) throws {
        guard case let .array(rows) = answer["posts"], rows.count <= 32,
              let revision = answer["revision"].integer else { throw NativeFailure.invalidRecord }
        let posts = rows.compactMap(PhoneWorkPost.init)
        let before = answer["before"].string
        guard posts.count == rows.count, Set(posts.map(\.id)).count == posts.count,
              answer.object["before"] == nil || (before != nil && posts.first?.id == before) else { throw NativeFailure.invalidRecord }
        self.posts = posts; self.revision = revision; self.before = before
    }

    /** Keep already read history at the same revision. A previously withdrawn source needs a fresh page. */
    public func keepingEarlierPosts(_ earlier: [PhoneWorkPost], before earlierCursor: String?, revision earlierRevision: UInt64,
        snapshot: NativeJSON) -> (posts: [PhoneWorkPost], before: String?) {
        guard earlierRevision == revision, let first = posts.first, let index = earlier.firstIndex(where: { $0.id == first.id }),
              index > 0, index + posts.count <= 500 else { return (posts, before) }
        let prefix = earlier.prefix(index)
        guard !prefix.contains(where: { $0.sourceNeedsReread(snapshot) }) else { return (posts, before) }
        return (Array(prefix) + posts, earlierCursor)
    }
}

public struct PhoneWorkReplyPage: Equatable, Sendable {
    public let turn: PhoneWorkTurn
    public let text: String
    public let nextOffset: Int?

    public init(_ answer: NativeJSON, messageId: String, source: PhoneWorkSource, offset: Int) throws {
        guard let turn = PhoneWorkTurn(answer["turn"]), turn.sessionId == source.sessionId,
              PhoneWorkItems.same(answer["messageId"].string, messageId),
              let text = PhoneWorkItems.text(answer["text"], max: 16_000), !text.isEmpty,
              (0..<PhoneWorkItems.replyLimit).contains(offset) else { throw NativeFailure.invalidRecord }
        if case let .turn(expected, _) = source.anchor, expected != turn { throw NativeFailure.invalidRecord }
        if case let .message(expected) = source.anchor, !PhoneWorkItems.same(expected, messageId) { throw NativeFailure.invalidRecord }
        let end = offset + text.unicodeScalars.count
        guard end <= PhoneWorkItems.replyLimit else { throw NativeFailure.invalidRecord }
        if answer.object["nextOffset"] != nil {
            guard text.unicodeScalars.count == 16_000, answer["nextOffset"].integer == UInt64(end), end < PhoneWorkItems.replyLimit else {
                throw NativeFailure.invalidRecord
            }
            nextOffset = end
        } else { nextOffset = nil }
        self.turn = turn; self.text = text
    }
}

/** A read may only paint the Host, transport, window and selection that asked for it. */
public struct PhoneWorkReadStamp: Hashable, Sendable {
    public let host: UUID
    public let connection: UUID
    public let transport: NativeTransportEpoch?
    public let network: UUID
    public let window: UUID
    public let selection: UUID
    public let instance: String

    public init?(connected: Bool, host: UUID, connection: UUID, transport: NativeTransportEpoch? = nil,
        network: UUID, window: UUID?, selection: UUID, instance: String?) {
        guard connected, transport?.valid != false, let window, let instance else { return nil }
        self.host = host; self.connection = connection; self.transport = transport; self.network = network; self.window = window
        self.selection = selection; self.instance = instance
    }
}

public enum PhoneWorkSourceVisibility: String, Sendable {
    case readable, unavailable, unconfirmed

    public var notice: String? {
        switch self {
        case .readable: nil
        case .unavailable: "原会话不可用"
        case .unconfirmed: "暂未确认原会话可读"
        }
    }
}

public enum PhoneWorkItems {
    public static let replyLimit = 1_048_576

    public static func supported(_ snapshot: NativeJSON) -> Bool {
        let features = snapshot["catalog"]["features"]
        return features["workItems"] == .bool(true) && features["workItemTurns"] == .bool(true)
    }
    public static func supportsCreation(_ snapshot: NativeJSON) -> Bool {
        supported(snapshot) && snapshot["catalog"]["features"]["workItemCreateReceipt"] == .bool(true)
    }
    public static func visible(_ snapshot: NativeJSON, privateAllowed: Bool) -> [PhoneWorkItemSummary] {
        guard supported(snapshot) else { return [] }
        var ids = Set<String>()
        return snapshot["items"].array.prefix(2000).compactMap { value in
            guard let item = PhoneWorkItemSummary(value), !item.isPrivate || privateAllowed,
                  ids.insert(item.id).inserted else { return nil }
            return item
        }.sorted {
            $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt
        }
    }
    /** List metadata survives a window. Discussion-related placement and references do not. */
    public static func withoutBody(_ snapshot: NativeJSON) -> NativeJSON {
        guard case var .object(result) = snapshot else { return snapshot }
        result.removeValue(forKey: "workProposals")
        let keep = ["id", "title", "projectId", "sessionIds", "updatedAt", "revision"]
        let items = snapshot["items"].array.prefix(2000).compactMap { value -> NativeJSON? in
            guard let item = PhoneWorkItemSummary(value), !item.isPrivate else { return nil }
            var row = value.object.filter { keep.contains($0.key) }
            if item.postId == nil, let group = item.group {
                var place: [String: NativeJSON] = ["group": .string(group.rawValue)]
                if let reason = item.reason { place["reason"] = .string(reason.rawValue) }
                row["board"] = .object(place)
            }
            return .object(row)
        }
        if snapshot.object["items"] != nil { result["items"] = .array(items) }
        let ids = Set(items.compactMap { $0["id"].string })
        if case let .array(tasks) = snapshot["tasks"] {
            result["tasks"] = .array(tasks.map { task in
                guard case var .object(row) = task, let itemId = task["itemId"].string, !ids.contains(itemId) else { return task }
                row.removeValue(forKey: "itemId"); return .object(row)
            })
        }
        return .object(result)
    }
    public static func sourceVisibility(_ snapshot: NativeJSON, sessionId: String) -> PhoneWorkSourceVisibility {
        guard snapshot["device"]["status"].string == "active", snapshot["device"]["scopes"].array.contains(.string("view")) else {
            return .unavailable
        }
        if PhoneSessions.mayReadBody(snapshot: snapshot, sessionId: sessionId) { return .readable }
        // Harness listings can be partial. In either case its old reply may no longer be shown.
        return snapshot["tasksComplete"] == .bool(true) ? .unavailable : .unconfirmed
    }
    public static func canReadFiles(_ snapshot: NativeJSON) -> Bool {
        ["files", "all"].contains(snapshot["device"]["dataScope"].string ?? "")
    }
    static func validItem(_ id: String) -> Bool { LinkBytes.matches(id, "itm_[A-Za-z0-9_-]{22}") }
    static func validPost(_ id: String) -> Bool { LinkBytes.matches(id, "pst_[A-Za-z0-9_-]{22}") }
    static func session(_ id: String) -> String? { LinkBytes.matches(id, "[A-Za-z0-9_-]{1,160}") ? id : nil }
    static func sha(_ id: String) -> String? { LinkBytes.matches(id, "[0-9a-f]{64}|[0-9a-f]{40}") ? id : nil }
    static func job(_ id: String) -> String? { LinkBytes.matches(id, "[0-9]{1,20}") ? id : nil }
    static func text(_ value: NativeJSON, max: Int) -> String? {
        guard let text = value.string, text.utf8.count <= max * 4, text.unicodeScalars.count <= max else { return nil }
        return text
    }
    static func message(_ value: NativeJSON) -> String? {
        guard let text = value.string, !text.isEmpty, text.utf16.count <= 256,
              !text.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
        return text
    }
    static func same(_ left: String?, _ right: String?) -> Bool {
        guard let left, let right else { return left == nil && right == nil }
        return left.utf8.elementsEqual(right.utf8)
    }
    static func query(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? ""
    }
}
