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
