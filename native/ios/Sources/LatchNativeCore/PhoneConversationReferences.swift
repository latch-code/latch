import Foundation

public struct PhoneReplyQuote: Identifiable, Sendable {
    public let id: String
    public let session: String
    public let message: String
    public let offset: Int
    public let text: String
    private static let header = try! NSRegularExpression(pattern: #"(?m)^\[引用回复 ([^/\s\]]{1,768})/([^/\s\]]{1,768})@(\d{1,8})\]\n(> [^\n]*(?:\n> [^\n]*)*)"#)

    /** Coordinates refer to visible words, so inline formatting does not break a selection. */
    private static func visible(_ body: String) -> String {
        guard let blocks = PhoneRichText.blocks(body) else { return body }
        return blocks.map { block in
            switch block {
            case let .text(line): return String(line.content.characters)
            case let .code(_, text, _, _, _): return text
            case let .table(table): return ([table.header] + table.rows).map { row in row.map { String($0.characters) }.joined(separator: "\t") }.joined(separator: "\n")
            case let .image(_, alt, _, _): return alt
            case .rule: return ""
            }
        }.joined(separator: "\n")
    }
    public static func create(session: String, message: String, selected: String, body: String, block: String? = nil, blockOffset: Int = 0) -> String? {
        guard !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, selected.utf16.count <= 4000 else { return nil }
        let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()"))
        guard let origin = session.addingPercentEncoding(withAllowedCharacters: safe), let row = message.addingPercentEncoding(withAllowedCharacters: safe) else { return nil }
        let visible = Self.visible(body), ns = visible as NSString
        var offset = 99_999_999 // A citation still opens its original message when repeated words have ambiguous positions.
        if let block, !block.isEmpty, blockOffset >= 0, blockOffset <= block.utf16.count - selected.utf16.count,
           (block as NSString).substring(with: NSRange(location: blockOffset, length: selected.utf16.count)) == selected,
           visible.components(separatedBy: block).count == 2 {
            offset = ns.range(of: block).location + blockOffset
        } else if visible.components(separatedBy: selected).count == 2 {
            offset = ns.range(of: selected).location
        }
        return "[引用回复 \(origin)/\(row)@\(offset)]\n" + selected.components(separatedBy: "\n").map { "> " + $0 }.joined(separator: "\n")
    }
    public static func parse(_ body: String) -> [PhoneReplyQuote] {
        passages(body).map { $0.quote }
    }
    fileprivate static func passages(_ body: String) -> [(range: NSRange, quote: PhoneReplyQuote)] {
        let ns = body as NSString
        return header.matches(in: body, range: NSRange(location: 0, length: ns.length)).compactMap { match in
            guard let session = ns.substring(with: match.range(at: 1)).removingPercentEncoding,
                  let message = ns.substring(with: match.range(at: 2)).removingPercentEncoding,
                  let offset = Int(ns.substring(with: match.range(at: 3))) else { return nil }
            let text = ns.substring(with: match.range(at: 4)).components(separatedBy: "\n").map { String($0.dropFirst(2)) }.joined(separator: "\n")
            guard !text.isEmpty, text.utf16.count <= 4000 else { return nil }
            return (match.range, PhoneReplyQuote(id: String(match.range.location), session: session, message: message, offset: offset, text: text))
        }
    }
    public func original(in body: String) -> (text: String, range: NSRange)? {
        let visible = Self.visible(body)
        if let range = match(in: visible) { return (visible, range) }
        if visible != body, let range = match(in: body) { return (body, range) }
        return nil
    }
    private func match(in body: String) -> NSRange? {
        let ns = body as NSString, length = text.utf16.count
        let exact = NSRange(location: offset, length: length)
        if NSMaxRange(exact) <= ns.length, ns.substring(with: exact) == text { return exact }
        guard body.components(separatedBy: text).count == 2 else { return nil }
        return ns.range(of: text)
    }
}

/** UITextView edits readable labels. Reusing an intact label preserves its original reference only inside this draft. */
public struct PhoneInputReferences {
    public enum Kind: String, Sendable { case reply, conversation, hook, handoff, terminal }
    public struct Quote: Sendable {
        /** A single object replacement character, in the editor's UTF-16 coordinates. */
        public let range: NSRange
        public let kind: Kind
        public let title: String
        public let text: String
        public let wire: String
        public func at(_ range: NSRange) -> Self { Self(range: range, kind: kind, title: title, text: text, wire: wire) }
    }
    private struct Label {
        let range: NSRange
        let shown: NSRange
        let wire: String
        let kind: Kind?
    }
    private struct Part {
        let range: NSRange
        let kind: Kind
        let title: String
        let text: String
    }
    private let source: String
    private let labels: [Label]
    public let display: String
    public let quotes: [Quote]
    private static let references = try! NSRegularExpression(pattern: #"\[conversation-ref:[a-f0-9-]{36}\] ([^\n]{1,500}?) · read_conversation_reference"#)
    private static let excerpts = try! NSRegularExpression(pattern: #"(?m)^\[引用回复 [^/\s\]]{1,768}/[^/\s\]]{1,768}@\d{1,8}\](?=\n> )"#)
    private static let handoffs = try! NSRegularExpression(pattern: #"(?m)^交回结果：\n(>(?: [^\n]*)?(?:\n>(?: [^\n]*)?)*)$"#)
    private static let terminalTitle = try! NSRegularExpression(pattern: #"^(?:终端 [0-9,]+(?: · 最近报错)?|Terminal [0-9,]+(?: · Latest error)?)(?:（较早的输出未包含）| \(earlier output omitted\))?$"#)
    private static let hooks = try! NSRegularExpression(pattern: #"(?m)^(提交钩子|推送前的钩子) ([\w.-]{1,128}) 没通过(?:，退出码 [0-9]+)?，(没有生成提交|没有推送)：\n\n(`{3,})text\n([\s\S]*?)\n\4$"#)

    public init(_ text: String, collapseQuotes: Bool = false) {
        source = text
        guard text.contains("[conversation-ref:") || text.contains("[引用回复 ") || (collapseQuotes && (text.contains("交回结果：") || text.contains("钩子 ") || text.contains("终端 ") || text.contains("Terminal "))) else {
            labels = []; quotes = []; display = text; return
        }
        let body = text as NSString, span = NSRange(location: 0, length: body.length)
        var parts = Self.references.matches(in: text, range: span).map { match in
            Part(range: match.range, kind: .conversation, title: "会话", text: body.substring(with: match.range(at: 1)))
        }
        if collapseQuotes {
            parts += PhoneReplyQuote.passages(text).map { Part(range: $0.range, kind: .reply, title: "回复", text: $0.quote.text) }
            for match in Self.handoffs.matches(in: text, range: span) {
                let words = body.substring(with: match.range(at: 1)).components(separatedBy: "\n").map { String($0.dropFirst(2)) }.joined(separator: "\n")
                if !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { parts.append(Part(range: match.range, kind: .handoff, title: "交回结果", text: words)) }
            }
            for match in Self.hooks.matches(in: text, range: span) {
                let push = body.substring(with: match.range(at: 1)) == "推送前的钩子"
                guard body.substring(with: match.range(at: 3)) == (push ? "没有推送" : "没有生成提交") else { continue }
                let output = body.substring(with: match.range(at: 5))
                guard output.utf16.count <= 8000, PhoneDelivery.fence(output) == body.substring(with: match.range(at: 4)) else { continue }
                let name = body.substring(with: match.range(at: 2))
                parts.append(Part(range: match.range, kind: .hook, title: name, text: output))
            }
        } else {
            parts += Self.excerpts.matches(in: text, range: span).map { Part(range: $0.range, kind: .reply, title: "引用原句", text: "") }
        }

        var terminals: [Part] = []
        let fences = Self.codeRanges(text, terminals: &terminals)
        if collapseQuotes { parts += terminals }
        let rendered = NSMutableString()
        var occurrences: [String: Int] = [:], displacement = 0, consumed = 0, fenceIndex = 0
        var labels: [Label] = [], quotes: [Quote] = []
        for part in parts.sorted(by: { $0.range.location < $1.range.location }) {
            var range = part.range
            while fenceIndex < fences.count && NSMaxRange(fences[fenceIndex]) <= range.location { fenceIndex += 1 }
            // A hook contains its own fenced output. Only its heading must be outside a code block.
            guard range.location >= consumed, fenceIndex == fences.count || !NSLocationInRange(range.location, fences[fenceIndex]) else { continue }
            let plain: String
            if collapseQuotes {
                let end = NSMaxRange(range)
                if end + 2 <= body.length, body.character(at: end) == 10, body.character(at: end + 1) == 10 { range.length += 2 }
                plain = "\u{fffc}"
            } else {
                let name = part.kind == .conversation ? "会话：" + part.text : part.title
                let n = (occurrences[name] ?? 0) + 1
                occurrences[name] = n
                plain = n == 1 ? "〔\(name)〕" : "〔\(name) · \(n)〕"
            }
            let shown = NSRange(location: range.location + displacement, length: plain.utf16.count)
            displacement += shown.length - range.length
            rendered.append(body.substring(with: NSRange(location: consumed, length: range.location - consumed)))
            rendered.append(plain)
            consumed = NSMaxRange(range)
            let wire = body.substring(with: range)
            labels.append(Label(range: range, shown: shown, wire: wire, kind: collapseQuotes ? part.kind : nil))
            if collapseQuotes { quotes.append(Quote(range: shown, kind: part.kind, title: part.title, text: part.text, wire: wire)) }
        }
        display = rendered as String + body.substring(from: consumed)
        self.labels = labels
        self.quotes = quotes
    }

    /** Mentions in quoted material and fenced examples are data supplied to the agent. */
    public static func materialRanges(in text: String) -> [NSRange] {
        let document = PhoneInputReferences(text, collapseQuotes: true)
        var ranges = document.labels.map(\.range)
        if text.contains("```") || text.contains("~~~") {
            var terminals: [Part] = []
            ranges += codeRanges(text, terminals: &terminals)
        }
        var nonoverlapping: [NSRange] = []
        for range in ranges.sorted(by: { $0.location < $1.location || $0.location == $1.location && $0.length > $1.length }) {
            if let last = nonoverlapping.last, range.location < NSMaxRange(last) {
                nonoverlapping[nonoverlapping.count - 1] = NSUnionRange(last, range)
            } else { nonoverlapping.append(range) }
        }
        return nonoverlapping
    }

    public enum MessagePart {
        case text(String)
        case reply(PhoneReplyQuote)
    }

    /** Each source link stays next to its passage, including in messages that quote several replies. */
    public static func messageParts(_ text: String) -> [MessagePart] {
        guard text.contains("[引用回复 ") else { return [.text(PhoneInputReferences(text).display)] }
        let source = text as NSString
        var ignoredTerminals: [Part] = []
        let fences = codeRanges(text, terminals: &ignoredTerminals)
        var parts: [MessagePart] = [], cursor = 0, fenceIndex = 0
        func appendText(until end: Int) {
            let words = source.substring(with: NSRange(location: cursor, length: end - cursor))
            if !words.isEmpty { parts.append(.text(PhoneInputReferences(words).display)) }
        }
        for (range, quote) in PhoneReplyQuote.passages(text) {
            while fenceIndex < fences.count && NSMaxRange(fences[fenceIndex]) <= range.location { fenceIndex += 1 }
            if fenceIndex < fences.count && NSLocationInRange(range.location, fences[fenceIndex]) { continue }
            // The block supplies its own vertical spacing in place of the framing line breaks.
            var end = range.location
            for _ in 0..<2 where end > cursor && source.character(at: end - 1) == 10 { end -= 1 }
            appendText(until: end)
            parts.append(.reply(quote))
            cursor = NSMaxRange(range)
            for _ in 0..<2 where cursor < source.length && source.character(at: cursor) == 10 { cursor += 1 }
        }
        appendText(until: source.length)
        return parts
    }

    /** Mirror the web terminal's framing. A terminal's title must sit immediately before a complete text fence outside other code. */
    private static func codeRanges(_ text: String, terminals: inout [Part]) -> [NSRange] {
        var ranges: [NSRange] = [], open: (mark: Character, length: Int, start: Int)?
        let body = text as NSString
        var previous = "", terminal: (title: String, from: Int, bodyFrom: Int)?
        var offset = 0
        for line in text.components(separatedBy: "\n") {
            defer { offset += line.utf16.count + 1; previous = line }
            let indented = line.prefix { $0 == " " }
            guard indented.count <= 3 else { continue }
            let rest = line.dropFirst(indented.count)
            guard let mark = rest.first, mark == "`" || mark == "~" else { continue }
            let count = rest.prefix { $0 == mark }.count
            guard count >= 3 else { continue }
            let suffix = rest.dropFirst(count)
            if let fence = open {
                if mark == fence.mark, count >= fence.length, suffix.allSatisfy(\.isWhitespace) {
                    let end = offset + line.utf16.count
                    ranges.append(NSRange(location: fence.start, length: end - fence.start))
                    if let candidate = terminal, line.utf16.count == fence.length, offset > candidate.bodyFrom {
                        let output = body.substring(with: NSRange(location: candidate.bodyFrom, length: offset - candidate.bodyFrom - 1))
                        // A draft truncated before its fence cannot borrow a later example's closing delimiter.
                        if !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !output.contains(line) {
                            terminals.append(Part(range: NSRange(location: candidate.from, length: end - candidate.from),
                                kind: .terminal, title: candidate.title, text: output))
                        }
                    }
                    open = nil; terminal = nil
                }
            } else if mark == "~" || !suffix.contains(mark) {
                open = (mark, count, offset)
                if mark == "`", indented.isEmpty, suffix == "text",
                   terminalTitle.firstMatch(in: previous, range: NSRange(location: 0, length: previous.utf16.count)) != nil {
                    terminal = (previous, offset - previous.utf16.count - 1, offset + line.utf16.count + 1)
                }
            }
        }
        if let open { ranges.append(NSRange(location: open.start, length: text.utf16.count - open.start)) }
        return ranges
    }

    private func contains(_ range: NSRange, in text: NSString) -> Bool {
        guard range.location >= 0, range.location <= text.length, range.length >= 0, range.length <= text.length - range.location else { return false }
        return [range.location, NSMaxRange(range)].allSatisfy { edge in
            edge == 0 || edge == text.length || !(0xdc00...0xdfff).contains(text.character(at: edge))
        }
    }

    /** Within a replaced label a caret maps to its end; a range includes the complete label it touches. */
    private func mapped(_ selection: NSRange, from text: String, wireToDisplay: Bool) -> NSRange? {
        guard contains(selection, in: text as NSString) else { return nil }
        func edge(_ position: Int, trailing: Bool) -> Int {
            var displacement = 0
            for label in labels {
                let from = wireToDisplay ? label.range : label.shown, to = wireToDisplay ? label.shown : label.range
                if position <= from.location { break }
                if position < NSMaxRange(from) { return trailing ? NSMaxRange(to) : to.location }
                displacement += to.length - from.length
            }
            return position + displacement
        }
        let start = edge(selection.location, trailing: selection.length == 0)
        return NSRange(location: start, length: edge(NSMaxRange(selection), trailing: true) - start)
    }
    public func wireRange(for displayRange: NSRange) -> NSRange? { mapped(displayRange, from: display, wireToDisplay: false) }
    public func displayRange(forWire range: NSRange) -> NSRange? { mapped(range, from: source, wireToDisplay: true) }

    public func readableText(in range: NSRange) -> String? {
        let text = display as NSString
        guard contains(range, in: text) else { return nil }
        let result = NSMutableString(string: text.substring(with: range))
        for quote in quotes.reversed() where quote.range.location >= range.location && NSMaxRange(quote.range) <= NSMaxRange(range) {
            result.replaceCharacters(in: NSRange(location: quote.range.location - range.location, length: 1), with: quote.text)
        }
        return result as String
    }

    private typealias Span = (shown: NSRange, kind: Kind?, wire: String)
    private static func serialize(_ edited: NSString, _ items: [Span]) -> String {
        let result = NSMutableString()
        var cursor = 0
        for (shown, kind, wire) in items {
            guard shown.location >= cursor, shown.location <= edited.length, shown.length > 0, shown.length <= edited.length - shown.location else { continue }
            if kind != nil, shown.length != 1 || edited.character(at: shown.location) != 0xfffc { continue }
            result.append(edited.substring(with: NSRange(location: cursor, length: shown.location - cursor)))
            cursor = NSMaxRange(shown)
            if let kind, kind != .conversation, result.length > 0, result.character(at: result.length - 1) != 10 { result.append("\n") }
            result.append(wire)
            if let kind, kind != .conversation, !wire.hasSuffix("\n\n"), cursor < edited.length {
                let startsQuoteLine = cursor + 2 < edited.length && edited.character(at: cursor + 1) == 62 && edited.character(at: cursor + 2) == 32
                if edited.character(at: cursor) != 10 || startsQuoteLine { result.append("\n\n") }
            }
        }
        result.append(edited.substring(from: cursor))
        return result as String
    }

    /** Input methods and undo can bypass a range edit. Restore only attachments still present in UIKit's text. */
    public static func wireText(_ display: String, quotes: [Quote]) -> String {
        serialize(display as NSString, quotes.sorted { $0.range.location < $1.range.location }.map { ($0.range, $0.kind, $0.wire) })
    }

    /** Use the edit's actual range: two neighboring U+FFFCs can carry entirely different source messages. */
    public func replacing(_ range: NSRange, with replacement: String) -> String? {
        let old = display as NSString
        guard contains(range, in: old) else { return nil }
        let edited = old.replacingCharacters(in: range, with: replacement) as NSString
        let delta = edited.length - old.length
        let kept: [Span] = labels.compactMap { label in
            var shown = label.shown
            if NSMaxRange(shown) <= range.location { /* Before the edit. */ }
            else if shown.location >= NSMaxRange(range) { shown.location += delta }
            else { return nil }
            return (shown, label.kind, label.wire)
        }
        return Self.serialize(edited, kept)
    }

    public func restore(_ edited: String) -> String {
        guard !labels.isEmpty else { return edited }
        let old = display as NSString, new = edited as NSString
        let common = min(old.length, new.length)
        var prefix = 0, suffix = 0
        while prefix < common, old.character(at: prefix) == new.character(at: prefix) { prefix += 1 }
        while suffix < common - prefix, old.character(at: old.length - 1 - suffix) == new.character(at: new.length - 1 - suffix) { suffix += 1 }
        if prefix == old.length, prefix == new.length { return source }
        // The first unequal UTF-16 unit may be the second half of an emoji. Widen to whole scalars.
        if prefix > 0, prefix < old.length, (0xdc00...0xdfff).contains(old.character(at: prefix)) { prefix -= 1 }
        if suffix > 0, suffix < old.length, (0xdc00...0xdfff).contains(old.character(at: old.length - suffix)) { suffix -= 1 }
        let range = NSRange(location: prefix, length: old.length - prefix - suffix)
        let replacement = new.substring(with: NSRange(location: prefix, length: new.length - prefix - suffix))
        return replacing(range, with: replacement) ?? edited
    }
}
