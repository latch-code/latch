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
        let ns = body as NSString
        return header.matches(in: body, range: NSRange(location: 0, length: ns.length)).compactMap { match in
            guard let session = ns.substring(with: match.range(at: 1)).removingPercentEncoding,
                  let message = ns.substring(with: match.range(at: 2)).removingPercentEncoding,
                  let offset = Int(ns.substring(with: match.range(at: 3))) else { return nil }
            let text = ns.substring(with: match.range(at: 4)).components(separatedBy: "\n").map { String($0.dropFirst(2)) }.joined(separator: "\n")
            guard !text.isEmpty, text.utf16.count <= 4000 else { return nil }
            return PhoneReplyQuote(id: String(match.range.location), session: session, message: message, offset: offset, text: text)
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
    private struct Label {
        let range: NSRange
        let shown: NSRange
        let plain: String
        let wire: String
    }
    private let labels: [Label]
    public let display: String
    private static let references = try! NSRegularExpression(pattern: #"\[conversation-ref:[a-f0-9-]{36}\] ([^\n]{1,500}?) · read_conversation_reference"#)
    private static let excerpts = try! NSRegularExpression(pattern: #"(?m)^\[引用回复 [^/\s\]]{1,768}/[^/\s\]]{1,768}@\d{1,8}\](?=\n> )"#)

    public init(_ text: String) {
        guard text.contains("[conversation-ref:") || text.contains("[引用回复 ") else { self.labels = []; self.display = text; return }
        let body = text as NSString, span = NSRange(location: 0, length: body.length)
        let sessions = Self.references.matches(in: text, range: span).map { ($0.range, "会话：" + body.substring(with: $0.range(at: 1))) }
        let quotes = Self.excerpts.matches(in: text, range: span).map { ($0.range, "引用原句") }
        var occurrences: [String: Int] = [:]
        var displacement = 0
        let labels = (sessions + quotes).sorted { $0.0.location < $1.0.location }.map { range, name in
            let n = (occurrences[name] ?? 0) + 1
            occurrences[name] = n
            let plain = n == 1 ? "〔\(name)〕" : "〔\(name) · \(n)〕"
            let shown = NSRange(location: range.location + displacement, length: plain.utf16.count)
            displacement += shown.length - range.length
            return Label(range: range, shown: shown, plain: plain, wire: body.substring(with: range))
        }
        let shown = NSMutableString(string: text)
        for label in labels.reversed() { shown.replaceCharacters(in: label.range, with: label.plain) }
        self.display = shown as String
        self.labels = labels
    }

    public func restore(_ edited: String) -> String {
        guard !labels.isEmpty else { return edited }
        let old = display as NSString, new = edited as NSString
        let common = min(old.length, new.length)
        var prefix = 0, suffix = 0
        while prefix < common, old.character(at: prefix) == new.character(at: prefix) { prefix += 1 }
        while suffix < common - prefix, old.character(at: old.length - 1 - suffix) == new.character(at: new.length - 1 - suffix) { suffix += 1 }
        let result = NSMutableString(string: edited)
        for label in labels.reversed() {
            var range = label.shown
            if NSMaxRange(range) <= prefix { /* Before the edit, still at the same offset. */ }
            else if range.location >= old.length - suffix { range.location += new.length - old.length }
            else { continue } // The person edited or removed this label.
            result.replaceCharacters(in: range, with: label.wire)
        }
        return result as String
    }
}
