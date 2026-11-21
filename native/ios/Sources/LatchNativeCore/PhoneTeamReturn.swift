import Foundation

/**
 * The message with which the Host hands a team's results to the lead, drawn as the web's `TeamResults` draws it in place
 * of a bubble of the person's (`apps/web/src/teams/`): which team sent it, the members of that round as each ended it,
 * and a member's whole reply from its own session.
 */
public enum PhoneTeamReturn {
    /** `TEAM_RETURN_HEADING` of `@latch/protocol`: what such a message starts with when the team's record is not here. */
    public static let heading = "团队成员都结束了。下面是每个成员的结果，由各自的 Agent 写下，不是用户的话："

    public struct Row: Equatable, Sendable, Identifiable {
        public var id: String { itemId }
        public let itemId: String
        public let sessionId: String?
        public let name: String
        public let harnessId: String
        public let state: String
        /** The first line of its reply, only for the team's latest round. */
        public let said: String?
        public let refusal: String?
        /** That round's message in the member's own session; nil for the start, whose message is the session's first. */
        public let requestId: String?
    }
    public struct Card: Equatable, Sendable {
        /** Set only when the team has had more than one round. */
        public let round: Int?
        public let rows: [Row]
        public var title: String { round.map { "成员的结果 · 第 \($0) 轮" } ?? "成员的结果" }
    }

    /** Whether a message is a team's results: the card, from the team that names it; without a record, a card of no rows. */
    public static func card(_ message: NativeJSON, teams: [NativeJSON]) -> Card? {
        guard message["role"].string == "user", !message["steered"].bool, let id = message["id"].string else { return nil }
        let team = teams.first { team in
            team["returnedMessageId"].string == id || team["rounds"].array.contains { $0["returnedMessageId"].string == id }
        }
        guard let team else { return (message["text"].string ?? "").hasPrefix(heading) ? Card(round: nil, rows: []) : nil }
        let members = team["members"].array
        func row(_ member: NativeJSON, state: String?, requestId: String?, latest: Bool) -> Row? {
            guard let itemId = member["itemId"].string else { return nil }
            let name = (member["name"].string ?? "").isEmpty ? (member["title"].string ?? "") : member["name"].string!
            return Row(itemId: itemId, sessionId: member["sessionId"].string, name: name, harnessId: member["harnessId"].string ?? "",
                       state: state ?? member["state"].string ?? "unknown", said: latest ? member["said"].string : nil,
                       refusal: member["refusal"].string, requestId: requestId)
        }
        let rounds = team["rounds"].array
        guard let round = rounds.first(where: { $0["returnedMessageId"].string == id }) else {
            return Card(round: nil, rows: members.compactMap { row($0, state: nil, requestId: nil, latest: true) })
        }
        let number = round["round"].integer.map(Int.init) ?? 1
        let latest = number == (team["round"].integer.map(Int.init) ?? 1)
        let rows = round["members"].array.compactMap { entry -> Row? in
            guard let member = members.first(where: { $0["itemId"].string == entry["itemId"].string }) else { return nil }
            return row(member, state: entry["state"].string, requestId: entry["requestId"].string, latest: latest)
        }
        return Card(round: rounds.count > 1 ? number : nil, rows: rows)
    }

    /**
     * A member's reply to one round in its own session: the last words of its agent after that round's message (the
     * session's first message for the start) and before the next one sent to it.
     */
    public static func reply(_ messages: [NativeJSON], requestId: String?) -> String {
        let start = messages.firstIndex { $0["role"].string == "user" && (requestId == nil || $0["requestId"].string == requestId) }
        guard let start else { return "" }
        let rest = messages[(start + 1)...]
        let end = rest.firstIndex { $0["role"].string == "user" } ?? messages.endIndex
        return messages[(start + 1)..<end].last { $0["role"].string == "assistant" && !($0["text"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }?["text"].string ?? ""
    }

    /** A member's state in words, as the web's `memberWords`. */
    public static func words(_ state: String) -> String {
        switch state {
        case "starting": "正在开始"
        case "running": "运行中"
        case "waiting": "等你处理"
        case "done": "已完成"
        case "failed": "失败"
        case "cancelled": "已停止"
        case "unknown": "未回报结果"
        default: "没有开始"
        }
    }
}
