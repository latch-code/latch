import Foundation

/** The name is just a search term. Only an explicitly chosen ID addresses a message. */
public enum PhoneAgentMentions {
    public static let textLimit = 16_000
    public static func path(_ owner: String) -> String? {
        PhoneAgents.validId(owner) ? "/link/api/custom-agents/\(owner)/mentions" : nil
    }
    public static func owner(of write: NativePendingWrite) -> String? {
        let parts = write.path.split(separator: "/")
        guard write.method == "POST", parts.count == 5, let owner = parts.dropLast().last,
              path(String(owner)) == write.path else { return nil }
        return String(owner)
    }
    public static func supports(_ snapshot: NativeJSON, owner: String) -> Bool {
        snapshot["catalog"]["features"]["agentMentions"].bool && PhoneAgents.entry(snapshot, id: owner)?.destination == .local
    }
    public static func options(_ snapshot: NativeJSON, owner: String, query: String) -> [PhoneAgentEntry] {
        guard supports(snapshot, owner: owner) else { return [] }
        return PhoneAgents.entries(snapshot).filter {
            $0.id != owner && $0.destination == .local && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query))
        }
    }
    /** A token ends at the caret. Email addresses and marked or selected text stay ordinary text. */
    public static func token(_ text: String, selection: NSRange) -> (range: NSRange, query: String)? {
        guard selection.length == 0, let caret = Range(selection, in: text)?.lowerBound else { return nil }
        let prefix = text[..<caret]
        guard let at = prefix.lastIndex(where: { $0 == "@" || $0 == "＠" }) else { return nil }
        if at > prefix.startIndex {
            let before = prefix[prefix.index(before: at)]
            if before.isASCII && (before.isLetter || before.isNumber || "._%+-@".contains(before)) { return nil }
        }
        let query = String(prefix[prefix.index(after: at)...])
        guard query.utf16.count <= 80, !query.contains(where: { $0.isWhitespace || $0.isPunctuation }) else { return nil }
        let range = NSRange(at..<caret, in: text)
        guard !PhoneInputReferences.materialRanges(in: text).contains(where: { NSLocationInRange(range.location, $0) }) else { return nil }
        return (range, query)
    }
    public static func request(owner: String, target: String, text: String) throws -> NativePendingWrite {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let path = path(owner), PhoneAgents.validId(target), owner != target, !words.isEmpty, words.utf16.count <= textLimit else { throw NativeFailure.invalidRecord }
        return try NativePendingWrite(method: .post, path: path, fields: [
            "target": .object(["kind": .string("agent"), "customAgentId": .string(target)]), "text": .string(words)
        ])
    }
    public static func confirms(_ response: NativeJSON, write: NativePendingWrite) -> Bool {
        guard let owner = owner(of: write), let input = try? NativeJSON.decode(write.body),
              let row = PhoneAgentConsultation(response, owner: owner) else { return false }
        return !row.autonomous && row.request == write.requestId && row.target == input["target"]["customAgentId"].string && row.text == input["text"].string && row.status != "unknown"
    }
}

public struct PhoneAgentConsultation: Identifiable, Equatable, Sendable {
    public let id: String
    public let request: String
    public let target: String
    public let source: String
    public let text: String
    public let status: String
    public let reply: String?
    public let more: Bool
    public let targetSession: String?
    public let failure: String?
    public let autonomous: Bool
    public enum Mode: String, Sendable {
        case textOnly = "text-only"
        case ownPermissions = "own-permissions"
        public var words: String { self == .textOnly ? "仅回复文字" : "按自身权限接单" }
    }
    private let replyId: String?
    private let targetMessage: String?
    private let approvalId: String?
    private let approvalRun: String?
    public let mode: Mode?
    public init?(_ value: NativeJSON, owner: String) {
        guard value["sourceAgentId"].string == owner, let id = value["id"].string, !id.isEmpty,
              let request = value["requestId"].string, !request.isEmpty, let target = value["targetAgentId"].string, PhoneAgents.validId(target),
              let initiator = value["initiator"].string, ["person", "agent"].contains(initiator),
              let text = value["text"].string, let status = value["status"].string,
              ["sending", "running", "waiting-approval", "completed", "failed", "cancelled", "interrupted", "unknown"].contains(status) else { return nil }
        self.id = id; self.request = request; self.source = owner; self.target = target; self.text = text; self.status = status
        more = value["reply"]["more"].bool; targetSession = value["targetSessionId"].string
        reply = value["reply"]["text"].string; failure = value["failure"].string
        replyId = PhoneWorkItems.message(value["reply"]["messageId"]); targetMessage = PhoneWorkItems.message(value["targetMessageId"])
        approvalId = value["approval"]["id"].string.flatMap(PhoneWorkItems.session)
        approvalRun = PhoneWorkItems.message(value["approval"]["runId"])
        autonomous = initiator == "agent"
        mode = autonomous ? value["consultationMode"].string.flatMap(Mode.init(rawValue:)) : nil
    }
    public func destination(in snapshot: NativeJSON, entry: PhoneAgentEntry?) -> PhoneAgentMentionDestination? {
        guard entry?.id == target, let session = targetSession.flatMap(PhoneWorkItems.session) else { return nil }
        var focus = PhoneAgentMentionDestination.Focus.chat
        let route = PhoneAgentMentionDestination(target: target, session: session, focus: .chat)
        guard route.available(in: snapshot) else { return nil }
        if status == "waiting-approval", let approvalId, let approvalRun,
           route.waiting(in: snapshot, approval: approvalId, run: approvalRun) {
            focus = .approval(approvalId, approvalRun, targetMessage)
        } else if let replyId { focus = .message(replyId, user: targetMessage, assistant: true) }
        else if let targetMessage { focus = .message(targetMessage, user: targetMessage, assistant: false) }
        else if status == "waiting-approval" { return nil }
        return PhoneAgentMentionDestination(target: target, session: session, focus: focus)
    }
    public func chatAction(in snapshot: NativeJSON, entry: PhoneAgentEntry?) -> String? {
        guard let visit = destination(in: snapshot, entry: entry) else { return nil }
        switch visit.focus {
        case .approval: return "在对方聊天查看审批"
        case .message(_, _, true): return more ? "在对方聊天查看完整回复" : "在对方聊天查看回复"
        case .message: return "在对方聊天查看本轮消息"
        case .chat: return "打开对方聊天"
        }
    }
    public var words: String {
        switch status {
        case "sending": "发送中"
        case "running": "正在回复"
        case "waiting-approval": "等待批准"
        case "completed": "已回复"
        case "failed": "失败"
        case "cancelled": "已取消"
        case "interrupted": "已中断"
        default: "结果未知"
        }
    }
}

/** An in-memory navigation target. Only the addressed message or approval may occupy a focused destination. */
public struct PhoneAgentMentionDestination: Hashable, Sendable {
    public enum Focus: Hashable, Sendable {
        case chat
        case message(String, user: String?, assistant: Bool)
        case approval(String, String, String?)
    }
    public let target: String
    public let session: String
    public let focus: Focus

    public func available(in snapshot: NativeJSON) -> Bool {
        guard PhoneAgents.entry(snapshot, id: target)?.destination == .local,
              PhoneAgentChat.session(snapshot, owner: target) == session,
              PhoneSessions.mayReadBody(snapshot: snapshot, sessionId: session),
              let task = snapshot["tasks"].array.first(where: { $0["id"].string == session }) else { return false }
        return PhoneAgentChat.owner(task) == target
    }
    fileprivate func waiting(in snapshot: NativeJSON, approval: String, run: String) -> Bool {
        guard let task = snapshot["tasks"].array.first(where: { $0["id"].string == session }),
              task["status"].string == "waiting-approval", PhoneWorkItems.same(task["runId"].string, run),
              task["live"]["activity"].string != "cancelling" else { return false }
        return snapshot["approvals"].array.contains { PhoneWorkItems.same($0["id"].string, approval) && $0["sessionId"].string == session }
    }
    public func record(in detail: NativeJSON, snapshot: NativeJSON) -> NativeJSON? {
        guard available(in: snapshot), detail["summary"]["id"].string == session,
              PhoneAgentChat.owner(detail["summary"]) == target else { return nil }
        let messages = detail["messages"].array
        switch focus {
        case .chat: return nil
        case let .message(id, user, assistant):
            guard let index = messages.firstIndex(where: { PhoneWorkItems.same($0["id"].string, id)
                && $0["role"].string == (assistant ? "assistant" : "user") }) else { return nil }
            if let user, !PhoneWorkItems.same(messages[...index].last(where: { $0["role"].string == "user" && !$0["steered"].bool })?["id"].string, user) { return nil }
            return messages[index]
        case let .approval(id, run, user):
            guard waiting(in: snapshot, approval: id, run: run), detail["summary"]["status"].string == "waiting-approval",
                  PhoneWorkItems.same(detail["summary"]["runId"].string, run),
                  detail["summary"]["live"]["activity"].string != "cancelling" else { return nil }
            if let user, !PhoneWorkItems.same(messages.last(where: { $0["role"].string == "user" && !$0["steered"].bool })?["id"].string, user) { return nil }
            return detail["approvals"].array.first { PhoneWorkItems.same($0["id"].string, id) && $0["sessionId"].string == session }
        }
    }
}
