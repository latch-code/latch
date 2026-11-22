import Foundation
import LatchNativeCore

/** Each case's blocks as short strings, so the test reads what the phone draws without reaching into Foundation's types. */
func phoneRichTextFixture(_ input: Data) throws -> [String: Any] {
    let vectors = try NativeJSON.decode(input)
    func inline(_ value: AttributedString) -> String {
        value.runs.map { run in
            let words = String(value[run.range].characters)
            let intent = run.inlinePresentationIntent ?? []
            if run.imageURL != nil { return "![" + words + "]" }
            if run.link != nil { return "[" + words + "]" }
            if intent.contains(.code) { return "`" + words + "`" }
            if intent.contains(.stronglyEmphasized) { return "**" + words + "**" }
            if intent.contains(.strikethrough) { return "~~" + words + "~~" }
            if intent.contains(.emphasized) { return "_" + words + "_" }
            return words
        }.joined()
    }
    func describe(_ block: PhoneRichBlock) -> String {
        switch block {
        case let .text(line):
            let kind: String = switch line.kind {
            case .paragraph: "p"
            case let .heading(level): "h\(level)"
            case .continuation: "more"
            case .item(.bullet): "bullet"
            case let .item(.number(number)): "number \(number)"
            case let .item(.task(done)): done ? "done" : "todo"
            }
            return "\(kind) d\(line.depth) q\(line.quote): " + inline(line.content)
        case let .code(language, text, open, depth, quote):
            return "code \(language ?? "-")\(open ? " open" : "") d\(depth) q\(quote): " + text
        case let .table(table):
            let align = table.alignments.map { $0 == .center ? "c" : $0 == .trailing ? "r" : "l" }.joined()
            return "table \(align) q\(table.quote): " + ([table.header] + table.rows).map { $0.map(inline).joined(separator: " | ") }.joined(separator: " / ")
        case let .rule(quote): return "rule q\(quote)"
        case let .image(source, alt, depth, quote): return "image d\(depth) q\(quote): \(source) (\(alt))"
        }
    }
    let cases: [Any] = vectors["cases"].array.map { item in
        guard let blocks = PhoneRichText.blocks(item.string ?? "") else { return NSNull() }
        return blocks.map(describe)
    }
    let links: [String] = vectors["links"].array.map { item in
        guard let value = item.string, let url = URL(string: value) else { return "invalid" }
        return switch PhoneRichText.linkTarget(url) {
        case let .web(url): "web " + url.absoluteString
        case let .path(path): "path " + path
        case .text: "text"
        }
    }
    return ["cases": cases, "links": links]
}

/** Team results as the phone reads them: which message is one, its rows, a member's reply to a round. */
func phoneTeamReturnFixture(_ input: Data) throws -> [String: Any] {
    let vectors = try NativeJSON.decode(input)
    let teams = vectors["teams"].array
    let cards: [Any] = vectors["messages"].array.map { message in
        guard let card = PhoneTeamReturn.card(message, teams: teams) else { return NSNull() }
        return ["title": card.title, "rows": card.rows.map { "\($0.name) \($0.state) \($0.said ?? "-") \($0.requestId ?? "-") \($0.sessionId ?? "-")" }] as [String: Any]
    }
    let replies = vectors["replies"].array.map { PhoneTeamReturn.reply(vectors["session"].array, requestId: $0.string) }
    return ["heading": PhoneTeamReturn.heading, "cards": cards, "replies": replies,
            "words": ["starting", "running", "waiting", "done", "failed", "cancelled", "unknown", "unstarted"].map(PhoneTeamReturn.words)]
}

/** Team cards as the phone places them in the lead's conversation: which turn each follows, its rows and its end. */
func phoneTeamGraphFixture(_ input: Data) throws -> [String: Any] {
    let vectors = try NativeJSON.decode(input)
    let teams = vectors["teams"].array
    func value(_ text: String?) -> Any { text.map { $0 as Any } ?? NSNull() }
    func describe(_ card: PhoneTeamGraph.Card) -> [String: Any] {
        ["id": card.id, "title": card.title, "count": card.count, "round": value(card.roundWords), "by": value(card.byWords),
         "end": card.endWords, "endCount": value(card.endCount), "endWire": card.endWire.rawValue, "kept": value(card.kept),
         "returned": value(card.returnedMessageId), "dispatch": card.dispatch,
         "members": card.members.map { "\($0.name) \($0.state) \($0.wire.rawValue) \($0.refused ? "refused" : "said") \($0.line ?? "-") \($0.sessionId ?? "-")" }]
    }
    let placements: [Any] = vectors["placements"].array.map { item in
        let messages = item["messages"].array
        let turnIds = PhoneConversation.turns(messages).map(\.id)
        let placed = PhoneTeamGraph.place(teams, session: item["session"].string ?? "", messages: messages, turnIds: turnIds)
        return placed.mapValues { $0.map(\.id) }
    }
    let cards = PhoneTeamGraph.teams(teams, session: vectors["session"].string ?? "").map { team in
        PhoneTeamGraph.card(team, newest: team["id"].string == vectors["newest"].string).map { describe($0) as Any } ?? NSNull()
    }
    let ends: [String] = vectors["ends"].array.map { item in
        PhoneTeamGraph.end(state: item["state"].string ?? "", members: item["members"].array.compactMap(\.string)).rawValue
    }
    let words = [PhoneTeamGraph.End.members, .you, .stopping, .pending, .returned, .kept].map(PhoneTeamGraph.words)
    return ["placements": placements, "cards": cards, "ends": ends, "words": words]
}
