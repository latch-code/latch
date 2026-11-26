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
        approvalId = value["approval"]["id"].string; approvalRun = value["approval"]["runId"].string
        autonomous = initiator == "agent"
        mode = autonomous ? value["consultationMode"].string.flatMap(Mode.init(rawValue:)) : nil
    }
    /** A receipt is for one session. A later chat or an Agent working on another computer is a different destination. */
    public func chatAction(in snapshot: NativeJSON, entry: PhoneAgentEntry?) -> String? {
        guard entry?.id == target, entry?.destination == .local, let targetSession, !targetSession.isEmpty,
              PhoneAgentChat.session(snapshot, owner: target) == targetSession,
              PhoneSessions.mayReadBody(snapshot: snapshot, sessionId: targetSession),
              let task = snapshot["tasks"].array.first(where: { $0["id"].string == targetSession }),
              PhoneAgentChat.owner(task) == target else { return nil }
        if status == "waiting-approval", task["status"].string == status,
           let approvalRun, task["runId"].string == approvalRun, let approvalId,
           snapshot["approvals"].array.contains(where: { $0["id"].string == approvalId && $0["sessionId"].string == targetSession }) {
            return "在对方聊天查看审批"
        }
        return more ? "在对方聊天查看完整回复" : "打开对方聊天"
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
