import Foundation

/** How a list item starts: a bullet, its number, or a task's box. */
public enum PhoneRichMarker: Equatable, Sendable {
    case bullet
    case number(Int)
    case task(done: Bool)
}

/** A line of prose: a paragraph, a heading, a list item's first paragraph or a later paragraph of one. */
public struct PhoneRichLine: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case paragraph
        case heading(Int)
        case item(PhoneRichMarker)
        /** A further paragraph of the list item above, indented with it. */
        case continuation
    }
    public var kind: Kind
    /** How many lists hold it; zero outside any list. */
    public var depth: Int
    /** How many quotes hold it. */
    public var quote: Int
    /** Inline Markdown as Foundation reads it: emphasis, code, strikethrough, links and pictures. */
    public var content: AttributedString
}

public struct PhoneRichTable: Equatable, Sendable {
    public enum Alignment: Equatable, Sendable { case leading, center, trailing }
    public var alignments: [Alignment]
    public var header: [AttributedString]
    public var rows: [[AttributedString]]
    public var quote: Int
}

public enum PhoneRichBlock: Equatable, Sendable {
    case text(PhoneRichLine)
    /** `open` only for a fence still arriving at the end of a reply. */
    case code(language: String?, text: String, open: Bool, depth: Int, quote: Int)
    case table(PhoneRichTable)
    case rule(quote: Int)
    /** A paragraph that is only a local picture; a web address never loads. */
    case image(source: String, alt: String, depth: Int, quote: Int)
}

/**
 * A reply's Markdown as blocks, read by Foundation's GitHub-flavoured parser, under the web's rules
 * (`apps/web/src/MessageContent.tsx`): raw HTML never becomes elements and its words never vanish (a line break breaks
 * the line, a comment says nothing, a disclosure is its words, anything else reads as the HTML it is); a list item that
 * starts with `[ ]` or `[x]` is a task; `$$` blocks are shown as their source, labelled 公式. Text past `limit`, or that
 * nests deeper than the web draws, is nil and is shown plain.
 */
public enum PhoneRichText {
    public static let limit = 200_000
    /** The web's `MAX_TREE_DEPTH` counts nodes; this counts containers on a line, which a far shallower tree exceeds first. */
    static let maxNesting = 24

    public static func blocks(_ text: String) -> [PhoneRichBlock]? {
        guard text.utf8.count <= limit, nesting(text) <= maxNesting else { return nil }
        let source = mathFences(text)
        let options = AttributedString.MarkdownParsingOptions(allowsExtendedAttributes: false, interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible)
        guard let parsed = try? AttributedString(markdown: source, options: options) else { return nil }
        var builder = Builder()
        for run in parsed.runs {
            let slice = AttributedString(parsed[run.range])
            let inline = run.inlinePresentationIntent ?? []
            let components = run.presentationIntent?.components ?? []
            let quote = components.filter { $0.kind == .blockQuote }.count
            let depth = components.filter { if case .listItem = $0.kind { return true } else { return false } }.count
            if inline.contains(.blockHTML) {
                builder.html(String(slice.characters), depth: depth, quote: quote)
                continue
            }
            if let table = components.first(where: { if case .table = $0.kind { return true } else { return false } }) {
                builder.tableRun(slice, components: components, table: table, quote: quote)
                continue
            }
            guard let leaf = components.first else { continue }
            switch leaf.kind {
            case let .codeBlock(language):
                builder.code(String(slice.characters), language: language, identity: leaf.identity, depth: depth, quote: quote)
            case .thematicBreak:
                builder.rule(identity: leaf.identity, quote: quote)
            case let .header(level):
                builder.line(slice, inline: inline, kind: .heading(level), identity: leaf.identity, item: nil, depth: depth, quote: quote)
            default:
                let item = components.first { if case .listItem = $0.kind { return true } else { return false } }
                var marker: PhoneRichMarker?
                if let item, case let .listItem(ordinal) = item.kind {
                    // The nearest list decides: a bullet list inside a numbered item still has bullets.
                    let nearest = components.first { $0.kind == .unorderedList || $0.kind == .orderedList }
                    marker = nearest?.kind == .orderedList ? .number(ordinal) : .bullet
                }
                builder.line(slice, inline: inline, kind: .paragraph, identity: leaf.identity, item: item.map { ($0.identity, marker ?? .bullet) }, depth: depth, quote: quote)
            }
        }
        var blocks = builder.finish()
        if let last = blocks.indices.last, case let .code(language, code, _, depth, quote) = blocks[last], fenceOpen(source) {
            blocks[last] = .code(language: language, text: code, open: true, depth: depth, quote: quote)
        }
        return blocks.compactMap(images)
    }

    /** A paragraph of nothing but local pictures becomes the pictures; a web picture stays inline as words. */
    private static func images(_ block: PhoneRichBlock) -> PhoneRichBlock? {
        guard case let .text(line) = block, line.kind == .paragraph else { return block }
        var found: (String, String)?
        for run in line.content.runs {
            let words = String(line.content[run.range].characters)
            if let url = run.imageURL {
                guard found == nil, let reference = localReference(url) else { return block }
                found = (reference, words)
            } else if !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return block }
        }
        guard let found else { return block }
        return .image(source: found.0, alt: found.1, depth: line.depth, quote: line.quote)
    }

    /** A picture or link target in the project: a relative or absolute path, or a `file:` URL. Never a web address. */
    public static func localReference(_ url: URL) -> String? {
        let raw = url.absoluteString.removingPercentEncoding ?? url.absoluteString
        if let scheme = url.scheme?.lowercased() {
            guard scheme == "file" else { return nil }
            return url.path.isEmpty ? nil : url.path
        }
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("//"), !trimmed.hasPrefix("#"),
              trimmed.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value != 0x7F && $0 != "\\" }) else { return nil }
        return trimmed.split(separator: "#", maxSplits: 1).first.map(String.init)
    }

    /** What a link does when pressed: a web or mail address opens, a project path previews, anything else is words. */
    public enum LinkTarget: Equatable, Sendable { case web(URL), path(String), text }
    public static func linkTarget(_ url: URL) -> LinkTarget {
        switch url.scheme?.lowercased() {
        case "http", "https": return url.host?.isEmpty == false ? .web(url) : .text
        case "mailto": return .web(url)
        case nil, "file": return localReference(url).map(LinkTarget.path) ?? .text
        default: return .text
        }
    }

    /** The deepest run of quote and list markers that opens any line; indentation alone is not nesting. */
    static func nesting(_ text: String) -> Int {
        var deepest = 0
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            var count = 0, rest = Substring(line)
            while true {
                rest = rest.drop { $0 == " " || $0 == "\t" }
                if rest.first == ">" { count += 1; rest = rest.dropFirst(); continue }
                if let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " { count += 1; rest = rest.dropFirst(2); continue }
                let digits = rest.prefix { $0.isASCII && $0.isNumber }
                if !digits.isEmpty, digits.count <= 9, let mark = rest.dropFirst(digits.count).first, mark == "." || mark == ")",
                   rest.dropFirst(digits.count + 1).first == " " { count += 1; rest = rest.dropFirst(digits.count + 2); continue }
                break
            }
            deepest = max(deepest, count)
            if deepest > maxNesting { break }
        }
        return deepest
    }

    /** Whether the reply ends inside a fence, so its last code block is still arriving. */
    static func fenceOpen(_ text: String) -> Bool {
        var open: (Character, Int)?
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.drop { $0 == " " || $0 == ">" }
            guard let first = line.first, first == "`" || first == "~" else { continue }
            let run = line.prefix { $0 == first }.count
            guard run >= 3 else { continue }
            if let fence = open {
                if fence.0 == first, run >= fence.1, line.dropFirst(run).allSatisfy(\.isWhitespace) { open = nil }
            } else if first == "~" || !line.dropFirst(run).contains("`") { open = (first, run) }
        }
        return open != nil
    }

    /** `$$` on a line of its own, outside fences, opens and closes a formula: shown as a fenced block labelled math. */
    static func mathFences(_ text: String) -> String {
        guard text.contains("$$") else { return text }
        var lines = text.components(separatedBy: "\n"), fence: (Character, Int)?, mathOpen: Int?
        for index in lines.indices {
            let line = lines[index].drop { $0 == " " }
            if let first = line.first, first == "`" || first == "~", mathOpen == nil {
                let run = line.prefix { $0 == first }.count
                if run >= 3 {
                    if let open = fence { if open.0 == first, run >= open.1 { fence = nil } } else { fence = (first, run) }
                    continue
                }
            }
            guard fence == nil, line.trimmingCharacters(in: .whitespaces) == "$$" else { continue }
            if let open = mathOpen { lines[open] = "```math"; lines[index] = "```"; mathOpen = nil } else { mathOpen = index }
        }
        return lines.joined(separator: "\n")
    }

    private struct Builder {
        var blocks: [PhoneRichBlock] = []
        /** The block being filled, by its identity in Foundation's parse. */
        var current: Int?
        var tableIdentity: Int?
        var table: PhoneRichTable?
        var cell: (row: Int, column: Int)?
        var startedItems: Set<Int> = []
        var htmlOpen = false
        /** The line being filled, held apart so each run appends in place rather than copying the line. */
        var pending: PhoneRichLine?

        mutating func close() {
            if let pending { blocks.append(.text(pending)) }
            if let table { blocks.append(.table(table)) }
            pending = nil; table = nil; tableIdentity = nil; cell = nil; current = nil; htmlOpen = false
        }
        mutating func code(_ text: String, language: String?, identity: Int, depth: Int, quote: Int) {
            if current == identity, case let .code(lang, existing, open, d, q) = blocks.last {
                blocks[blocks.count - 1] = .code(language: lang, text: existing + text, open: open, depth: d, quote: q); return
            }
            close(); current = identity
            var body = text
            if body.hasSuffix("\n") { body.removeLast() }
            let name = language?.trimmingCharacters(in: .whitespaces).split(separator: " ").first.map(String.init)
            blocks.append(.code(language: name?.isEmpty == false ? name : nil, text: body, open: false, depth: depth, quote: quote))
        }
        mutating func rule(identity: Int, quote: Int) {
            guard current != identity else { return }
            close(); current = identity; blocks.append(.rule(quote: quote))
        }
        mutating func line(_ slice: AttributedString, inline: InlinePresentationIntent, kind: PhoneRichLine.Kind, identity: Int,
                           item: (Int, PhoneRichMarker)?, depth: Int, quote: Int) {
            let piece = Self.literal(slice, inline: inline)
            if current == identity, pending != nil { pending!.content += piece; return }
            close(); current = identity
            var shown = kind, content = piece
            if case let (itemId, marker)? = item, case .paragraph = kind {
                if startedItems.insert(itemId).inserted {
                    shown = .item(marker)
                    let words = String(content.characters)
                    if marker == .bullet, let box = ["[ ] ", "[x] ", "[X] "].first(where: words.hasPrefix) {
                        shown = .item(.task(done: box != "[ ] "))
                        content = AttributedString(content[content.characters.index(content.startIndex, offsetBy: 4)...])
                    }
                } else { shown = .continuation }
            }
            pending = PhoneRichLine(kind: shown, depth: depth, quote: quote, content: content)
        }
        mutating func tableRun(_ slice: AttributedString, components: [PresentationIntent.IntentType], table intent: PresentationIntent.IntentType, quote: Int) {
            if tableIdentity != intent.identity {
                close(); tableIdentity = intent.identity
                var alignments: [PhoneRichTable.Alignment] = []
                if case let .table(columns) = intent.kind {
                    alignments = columns.map { $0.alignment == .center ? .center : $0.alignment == .right ? .trailing : .leading }
                }
                table = PhoneRichTable(alignments: alignments, header: Array(repeating: AttributedString(), count: alignments.count), rows: [], quote: quote)
            }
            // Moved out while filled, so the cell appends in place rather than copying the whole table.
            guard var table = self.table.take() else { return }
            var row = 0, column = 0
            for component in components {
                switch component.kind {
                case let .tableCell(index): column = index
                case let .tableRow(index): row = index
                case .tableHeaderRow: row = 0
                default: break
                }
            }
            let width = max(table.alignments.count, column + 1)
            if table.alignments.count < width { table.alignments += Array(repeating: .leading, count: width - table.alignments.count) }
            if row == 0 {
                while table.header.count < width { table.header.append(AttributedString()) }
                table.header[column] += slice
            } else {
                while table.rows.count < row { table.rows.append(Array(repeating: AttributedString(), count: width)) }
                while table.rows[row - 1].count < width { table.rows[row - 1].append(AttributedString()) }
                table.rows[row - 1][column] += slice
            }
            self.table = table
        }
        /**
         * Block HTML by the web's `literalNode`: comments go, a disclosure is its words, any other markup is code. Foundation
         * joins neighbouring HTML blocks into one run, so a line that is only a disclosure tag, a comment or a line break
         * goes on its own, as it would as its own block.
         */
        mutating func html(_ value: String, depth: Int, quote: Int) {
            let withoutComments = value.replacingOccurrences(of: "<!--[\\s\\S]*?-->", with: "", options: .regularExpression)
            let disclosure = "</?(?:details|summary)(?:\\s[^<>]*)?>"
            var kept: [String] = [], words: [String] = []
            for raw in withoutComments.components(separatedBy: "\n") {
                let line = raw.trimmingCharacters(in: .whitespaces)
                if line.isEmpty || line.range(of: "^<br\\s*/?>$", options: [.regularExpression, .caseInsensitive]) != nil { continue }
                let stripped = line.replacingOccurrences(of: disclosure, with: "", options: [.regularExpression, .caseInsensitive]).trimmingCharacters(in: .whitespaces)
                if stripped.isEmpty { continue }
                kept.append(raw); words.append(stripped)
            }
            guard !kept.isEmpty else { return }
            if !words.contains(where: { $0.contains("<") }) {
                close()
                for paragraph in words { blocks.append(.text(PhoneRichLine(kind: .paragraph, depth: depth, quote: quote, content: AttributedString(paragraph)))) }
                return
            }
            let code = kept.joined(separator: "\n")
            if htmlOpen, case let .code(language, existing, open, d, q) = blocks.last, language == "html" {
                blocks[blocks.count - 1] = .code(language: language, text: existing + "\n" + code, open: open, depth: d, quote: q); return
            }
            close()
            blocks.append(.code(language: "html", text: code, open: false, depth: depth, quote: quote)); htmlOpen = true
        }
        /** Inline HTML reads as its characters, except that a line break breaks the line and a comment says nothing. */
        static func literal(_ slice: AttributedString, inline: InlinePresentationIntent) -> AttributedString {
            guard inline.contains(.inlineHTML) else { return slice }
            let value = String(slice.characters).trimmingCharacters(in: .whitespaces)
            if value.hasPrefix("<!--") { return AttributedString() }
            if value.range(of: "^<br\\s*/?>$", options: [.regularExpression, .caseInsensitive]) != nil { return AttributedString("\n") }
            var plain = slice; plain.inlinePresentationIntent = nil
            return plain
        }
        mutating func finish() -> [PhoneRichBlock] { close(); return blocks }
    }
}
