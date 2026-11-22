import Foundation

/**
 * A team in its lead's conversation, the phone form of the web's `TeamGraph` (`apps/web/src/teams/`): this session as a
 * node, a pill per member down a rail, and the node where the results are. A card stands after the turn its latest round
 * came from (`placeTeams`), or after the last turn when that message is not in the record.
 */
public enum PhoneTeamGraph {
    /** Where the results are, as the card's end says it (the web's `endMark`). */
    public enum End: String, Sendable {
        case members, you, stopping, pending, returned, kept
    }
    /** How a wire down the rail is drawn: what went in to a member, or how the results stand. */
    public enum Wire: String, Sendable {
        case none, waiting, flow, done, quiet, idle
    }

    public struct Member: Equatable, Sendable, Identifiable {
        public var id: String { itemId }
        public let itemId: String
        public let sessionId: String?
        /** What it is called: its name, or its title where it has none. */
        public let name: String
        public let title: String
        public let harnessId: String
        public let state: String
        /** The pill's second line: why it did not start, or the first line of its last reply. */
        public let line: String?
        /** `line` is the Host's refusal. */
        public let refused: Bool
        /** When it started, for its clock while it runs. */
        public let startedAt: String?
        public let wire: Wire
    }

    public struct Card: Equatable, Sendable, Identifiable {
        public let id: String
        public let goal: String?
        public let members: [Member]
        /** The latest round, only once there is more than one. */
        public let round: Int?
        /** The lead's agent sent that round, on the switch the person turned on. */
        public let byAgent: Bool
        public let end: End
        /** Members that have ended. */
        public let ended: Int
        public let returnedMessageId: String?
        /** Why the results were kept, in words. */
        public let kept: String?
        public let endWire: Wire
        /** The person lets the lead's agent send work to the members; said only on the session's newest team. */
        public let dispatch: Bool

        public var title: String { goal ?? "团队分工" }
        public var count: String { "\(members.count) 个成员" }
        public var roundWords: String? { round.map { "第 \($0) 轮" } }
        public var byWords: String? { round == nil ? nil : byAgent ? "Agent 派的" : "你派的" }
        public var endWords: String { PhoneTeamGraph.words(end) }
        /** 「2/3」 beside the end while members are still at work. */
        public var endCount: String? { end == .members || end == .you ? "\(ended)/\(members.count)" : nil }
    }

    /** The teams this session started, oldest first. */
    public static func teams(_ teams: [NativeJSON], session: String) -> [NativeJSON] {
        teams.enumerated().filter { $0.element["leadSessionId"].string == session }
            .sorted { a, b in
                let (left, right) = (a.element["createdAt"].string ?? "", b.element["createdAt"].string ?? "")
                return left == right ? a.offset < b.offset : left < right
            }
            .map(\.element)
    }

    /**
     * The turn a team's card follows: the one that holds its latest round's message (the team's own before there is a
     * later round). Nil when that message is not in the record.
     */
    public static func turnKey(_ team: NativeJSON, messages: [NativeJSON]) -> String? {
        guard let messageId = team["rounds"].array.last?["messageId"].string ?? team["messageId"].string,
              let at = messages.firstIndex(where: { $0["id"].string == messageId }) else { return nil }
        if let user = messages[...at].last(where: { $0["role"].string == "user" && !$0["steered"].bool }) { return user["id"].string }
        // Before any prompt: the lead content's own turn, as `PhoneConversation.turns` keys it.
        return messages.first.map { "lead:" + ($0["id"].string ?? "") }
    }

    /** This session's cards by the turn each follows; "" when there are no turns. */
    public static func place(_ teams: [NativeJSON], session: String, messages: [NativeJSON], turnIds: [String]) -> [String: [Card]] {
        let own = self.teams(teams, session: session)
        guard let newest = own.last?["id"].string else { return [:] }
        let keys = Set(turnIds), last = turnIds.last ?? ""
        var placed: [String: [Card]] = [:]
        for team in own {
            guard let card = card(team, newest: team["id"].string == newest) else { continue }
            let key = turnKey(team, messages: messages).flatMap { keys.contains($0) ? $0 : nil } ?? last
            placed[key, default: []].append(card)
        }
        return placed
    }

    public static func card(_ team: NativeJSON, newest: Bool) -> Card? {
        guard let id = team["id"].string else { return nil }
        let members = team["members"].array.compactMap(member)
        let rounds = team["rounds"].array
        let latest = rounds.count > 1 ? rounds.last : nil
        let goal = team["goal"].string.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        let state = team["state"].string ?? "running"
        return Card(
            id: id, goal: goal, members: members, round: latest.map { $0["round"].integer.map(Int.init) ?? rounds.count },
            byAgent: latest?["by"].string == "agent", end: end(state: state, members: members.map(\.state)),
            ended: members.filter { !atWork($0.state) }.count, returnedMessageId: state == "returned" ? team["returnedMessageId"].string : nil,
            kept: state == "kept" ? keptWords(team["kept"].string) : nil, endWire: endWire(state),
            dispatch: newest && team["agentDispatch"].bool)
    }

    private static func member(_ member: NativeJSON) -> Member? {
        guard let itemId = member["itemId"].string else { return nil }
        let title = member["title"].string ?? ""
        let name = (member["name"].string ?? "").isEmpty ? title : member["name"].string!
        let state = member["state"].string ?? "unknown"
        let refusal = state == "unstarted" ? member["refusal"].string.flatMap { $0.isEmpty ? nil : $0 } : nil
        return Member(itemId: itemId, sessionId: member["sessionId"].string, name: name, title: title, harnessId: member["harnessId"].string ?? "",
                      state: state, line: refusal ?? member["said"].string.flatMap { $0.isEmpty ? nil : $0 }, refused: refusal != nil,
                      startedAt: member["startedAt"].string, wire: wire(state))
    }

    /** Where the results are: with the members (or the person, while one waits for them), on their way, or settled. */
    public static func end(state: String, members: [String]) -> End {
        switch state {
        case "kept": .kept
        case "returned": .returned
        case "returning": .pending
        case "stopping": .stopping
        default: members.contains("waiting") ? .you : .members
        }
    }

    public static func atWork(_ state: String) -> Bool { state == "starting" || state == "running" || state == "waiting" }

    /** What went in to a member: nothing when it never started, its work while it is at it, or work it has ended. */
    public static func wire(_ state: String) -> Wire {
        switch state {
        case "unstarted": .none
        case "waiting": .waiting
        case "starting", "running": .flow
        default: .done
        }
    }

    /** The wire into the results: on its way while they wait to go back, full once back, quiet when kept. */
    public static func endWire(_ state: String) -> Wire {
        switch state {
        case "returned": .done
        case "returning": .flow
        case "kept": .quiet
        default: .idle
        }
    }

    public static func words(_ end: End) -> String {
        switch end {
        case .members: "等成员"
        case .you: "等你处理"
        case .stopping: "正在停止…"
        case .pending: "结果待发"
        case .returned: "已交回"
        case .kept: "留在这里"
        }
    }

    public static func keptWords(_ kept: String?) -> String? {
        switch kept {
        case "stopped": "已停止"
        case "lead-gone": "这个会话不在了"
        case "device-removed": "开始它的设备已移除"
        default: nil
        }
    }
}
