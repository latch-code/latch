import LatchNativeCore
import SwiftUI
import UIKit

/**
 * An agent's Markdown as the web draws it (`apps/web/src/MessageContent.tsx`, `styles/markdown.css`): headings in three
 * steps, lists with their markers and tasks, quotes behind a bar, a rule, tables that scroll sideways, and code in a
 * card with its language, a copy button and a fold past 18 lines. Prose that runs together stays one selectable text.
 * Web and mail links open when pressed and a project path previews; pictures load only from the project, never the web.
 * A completed Mermaid fence can be viewed as a diagram. Formulas retain their source.
 */
struct MarkdownView: View {
    let text: String
    var streaming = false
    var size: CGFloat = 16
    /** Previews a project file the reply names; without it a path is words. */
    var open: ((String, String?) -> Void)? = nil
    /** Thoughts, as the web draws reasoning: links and pictures stay words, nothing opens from them. */
    var inert = false
    /** The prose's ink; a thought is in the secondary one. */
    var ink: UIColor = .label
    var knownFiles: Set<Data> = []
    var cacheParsedText = true
    var allowsFile: ((String) -> Bool)? = nil
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL
    @Environment(\.sizeCategory) private var sizeCategory
    /** A long reply's last parse, made off the main thread; while it streams, the one before stays shown. */
    @State private var parsed: MarkdownCache.Parse?
    var body: some View {
        // The previous streamed prefix can stay on screen; an edited path with different UTF-8 bytes cannot.
        let cached = cacheParsedText ? MarkdownCache.lookup(text) : nil
        let result = cached ?? parsed.flatMap { prior in
            (streaming ? text.utf8.starts(with: prior.text.utf8) : text.utf8.elementsEqual(prior.text.utf8)) ? prior : nil
        }
        content(result)
            .task(id: text as NSString) {
                guard cached == nil else { return }
                // While a long reply arrives, one parse per pause rather than per word.
                if streaming && parsed != nil { try? await Task.sleep(for: .milliseconds(150)) }
                guard !Task.isCancelled else { return }
                let next = await MarkdownCache.parse(text, storeResult: cacheParsedText)
                guard !Task.isCancelled else { return }
                parsed = next
            }
    }
    @ViewBuilder private func content(_ parse: MarkdownCache.Parse?) -> some View {
        if let parse, let blocks = parse.blocks {
            let pieces = MarkdownPiece.group(blocks)
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(pieces.enumerated()), id: \.offset) { index, piece in
                    quoted(piece.quote) { view(piece, last: index == pieces.count - 1) }
                        .padding(.leading, CGFloat(piece.depth) * MarkdownStyle.indent(scaled))
                }
            }
        } else if parse != nil {
            VStack(alignment: .leading, spacing: 6) {
                if text.utf8.count <= PhoneRichText.limit { Text("结构过深，按纯文本显示").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                ConversationText(text: text, size: size)
            }
        } else {
            // A long reply's first parse is still running: its words, until their layout is ready.
            ConversationText(text: text, size: size)
        }
    }
    @ViewBuilder private func view(_ piece: MarkdownPiece, last: Bool) -> some View {
        switch piece.kind {
        case let .prose(lines):
            let (rich, links) = MarkdownStyle.prose(lines, size: scaled, style: inlineStyle, ink: ink)
            ConversationText(rich: rich, links: links, onLink: follow).frame(maxWidth: .infinity, alignment: .leading)
        case let .code(language, code, open):
            if language?.lowercased() == "mermaid", !open, !inert {
                MermaidDiagramView(source: code)
            } else {
                MarkdownCode(code: code, language: language, arriving: open && streaming && last)
            }
        case let .table(table):
            MarkdownTable(table: table, size: scaled, style: inlineStyle, onLink: follow)
        case .rule:
            Rectangle().fill(PhoneTheme.line).frame(height: 1).padding(.vertical, 6)
        case let .image(source, alt):
            MarkdownPicture(source: source, alt: alt, open: inert || allowsFile?(source) == false ? nil : open)
        }
    }
    private var inlineStyle: MarkdownStyle.Links {
        .init(active: !inert, opensFiles: open != nil, knownFiles: streaming ? [] : knownFiles, dark: colorScheme == .dark, allowsFile: allowsFile)
    }
    private var scaled: CGFloat { _ = sizeCategory; return UIFontMetrics(forTextStyle: .body).scaledValue(for: size) }
    private func follow(_ target: PhoneRichText.LinkTarget) {
        switch target {
        case let .web(url): openURL(url)
        case let .path(path) where allowsFile?(path) != false: open?(path, nil)
        default: break
        }
    }
    @ViewBuilder private func quoted<Content: View>(_ depth: Int, @ViewBuilder _ content: () -> Content) -> some View {
        if depth > 0 {
            HStack(alignment: .top, spacing: 12) {
                RoundedRectangle(cornerRadius: 1.5).fill(PhoneTheme.lineStrong).frame(width: 3)
                content().foregroundStyle(PhoneTheme.ink2)
            }.padding(.leading, CGFloat(depth - 1) * 15).fixedSize(horizontal: false, vertical: true)
        } else { content() }
    }
}

/** Parsing is cached by text: a long transcript redraws often, and a streaming reply changes only its last message. */
@MainActor enum MarkdownCache {
    private final class Entry { let blocks: [PhoneRichBlock]?; init(_ blocks: [PhoneRichBlock]?) { self.blocks = blocks } }
    /** By count and by text: a streaming reply leaves a parse of each length it passed through. */
    private static let cache: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>(); cache.countLimit = 96; cache.totalCostLimit = 4_000_000; return cache
    }()
    struct Parse { let text: String; let blocks: [PhoneRichBlock]? }
    /** Text this short is parsed where it is drawn; longer text only by `parse`, off the main thread. */
    private static let inline = 12_000
    /** A parse to draw now: cached, or made here for short text; nil sends a long one to `parse`. */
    static func lookup(_ text: String) -> Parse? {
        let key = text as NSString
        if let hit = cache.object(forKey: key) { return Parse(text: text, blocks: hit.blocks) }
        guard text.utf8.count <= inline else { return nil }
        let blocks = PhoneRichText.blocks(text)
        cache.setObject(Entry(blocks), forKey: key, cost: key.length)
        return Parse(text: text, blocks: blocks)
    }
    static func parse(_ text: String, storeResult: Bool = true) async -> Parse {
        let blocks = await Task.detached(priority: .userInitiated) { PhoneRichText.blocks(text) }.value
        if storeResult { cache.setObject(Entry(blocks), forKey: text as NSString, cost: (text as NSString).length) }
        return Parse(text: text, blocks: blocks)
    }
}

/** Blocks as drawn: runs of prose in one quote share a text view; everything else stands alone. */
struct MarkdownPiece {
    enum Kind {
        case prose([PhoneRichLine])
        case code(language: String?, text: String, open: Bool)
        case table(PhoneRichTable)
        case rule
        case image(source: String, alt: String)
    }
    var kind: Kind
    var quote: Int
    var depth: Int
    static func group(_ blocks: [PhoneRichBlock]) -> [MarkdownPiece] {
        var pieces: [MarkdownPiece] = []
        for block in blocks {
            switch block {
            case let .text(line):
                if case var .prose(lines) = pieces.last?.kind, pieces.last?.quote == line.quote {
                    lines.append(line); pieces[pieces.count - 1].kind = .prose(lines)
                } else { pieces.append(MarkdownPiece(kind: .prose([line]), quote: line.quote, depth: 0)) }
            case let .code(language, text, open, depth, quote): pieces.append(MarkdownPiece(kind: .code(language: language, text: text, open: open), quote: quote, depth: depth))
            case let .table(table): pieces.append(MarkdownPiece(kind: .table(table), quote: table.quote, depth: 0))
            case let .rule(quote): pieces.append(MarkdownPiece(kind: .rule, quote: quote, depth: 0))
            case let .image(source, alt, depth, quote): pieces.append(MarkdownPiece(kind: .image(source: source, alt: alt), quote: quote, depth: depth))
            }
        }
        return pieces
    }
}

/** The web's measures: 20 and 18 for the first two headings, 600 weight, markers in the muted ink, 22 points a level. */
enum MarkdownStyle {
    /** One level of a list: 22 points at the body size, growing with the text so a marker always fits before its words. */
    static func indent(_ size: CGFloat) -> CGFloat { (size * 1.4).rounded() }
    struct Links {
        let active: Bool
        let opensFiles: Bool
        let knownFiles: Set<Data>
        let dark: Bool
        var allowsFile: ((String) -> Bool)? = nil
    }
    @MainActor static func prose(_ lines: [PhoneRichLine], size: CGFloat, style linksStyle: Links, ink: UIColor) -> (NSAttributedString, [PhoneRichText.LinkTarget]) {
        let result = NSMutableAttributedString()
        var links: [PhoneRichText.LinkTarget] = []
        for (index, line) in lines.enumerated() {
            if index > 0 { result.append(NSAttributedString(string: "\n")) }
            let next = index + 1 < lines.count ? lines[index + 1] : nil
            let font: UIFont
            switch line.kind {
            case let .heading(level): font = .systemFont(ofSize: level == 1 ? size + 4 : level == 2 ? size + 2 : size, weight: .semibold)
            default: font = .systemFont(ofSize: size)
            }
            let style = NSMutableParagraphStyle()
            style.lineHeightMultiple = 1.18
            let inList = line.depth > 0, nextInList = (next?.depth ?? 0) > 0
            style.paragraphSpacing = next == nil ? 0 : { if case .heading = next?.kind { return 18 } else { return inList && nextInList ? 5 : 11 } }()
            if case .heading = line.kind { style.paragraphSpacing = next == nil ? 0 : 8 }
            let step = indent(size), body = CGFloat(line.depth) * step
            style.headIndent = body; style.firstLineHeadIndent = body
            let piece = NSMutableAttributedString()
            if case let .item(marker) = line.kind {
                style.firstLineHeadIndent = body - step
                style.tabStops = [NSTextTab(textAlignment: .left, location: body)]
                piece.append(markerText(marker, depth: line.depth, font: font))
                piece.append(NSAttributedString(string: "\t", attributes: [.font: font]))
            }
            let color: UIColor = if case .heading = line.kind { UIColor(PhoneTheme.ink) } else { ink }
            let (words, found) = inline(line.content, font: font, color: color, linkBase: links.count, style: linksStyle)
            links += found
            piece.append(words)
            piece.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: piece.length))
            result.append(piece)
        }
        return (result, links)
    }
    @MainActor private static func markerText(_ marker: PhoneRichMarker, depth: Int, font: UIFont) -> NSAttributedString {
        let muted = UIColor(PhoneTheme.muted)
        switch marker {
        case .bullet:
            let glyph = ["•", "◦", "▪︎"][(max(depth, 1) - 1) % 3]
            return NSAttributedString(string: glyph, attributes: [.font: font, .foregroundColor: muted])
        case let .number(number):
            return NSAttributedString(string: "\(number).", attributes: [.font: UIFont.monospacedDigitSystemFont(ofSize: font.pointSize, weight: .regular), .foregroundColor: muted])
        case let .task(done):
            let configuration = UIImage.SymbolConfiguration(pointSize: font.pointSize * 0.95, weight: .regular)
            let image = UIImage(systemName: done ? "checkmark.square.fill" : "square", withConfiguration: configuration)?
                .withTintColor(done ? UIColor(PhoneTheme.accent) : muted, renderingMode: .alwaysOriginal)
            guard let image else { return NSAttributedString(string: done ? "☑" : "☐", attributes: [.font: font]) }
            let attachment = NSTextAttachment(image: image)
            attachment.bounds = CGRect(x: 0, y: (font.capHeight - image.size.height) / 2, width: image.size.width, height: image.size.height)
            attachment.accessibilityLabel = done ? "已完成" : "未完成"
            return NSAttributedString(attachment: attachment)
        }
    }
    /**
     * Foundation's inline runs in UIKit attributes. A link keeps its words and becomes `latch-link:<n>` into the returned
     * targets; a picture in a sentence is the words 图片 or 外部图片 with its name, opening as its link would.
     */
    typealias Inline = (text: NSAttributedString, links: [PhoneRichText.LinkTarget])
    @MainActor static func inline(_ value: AttributedString, font: UIFont, color: UIColor, linkBase: Int = 0, style: Links) -> Inline {
        let result = NSMutableAttributedString()
        var links: [PhoneRichText.LinkTarget] = []
        let mono = UIFont.monospacedSystemFont(ofSize: font.pointSize * 0.88, weight: .regular)
        var previousTarget: PhoneRichText.LinkTarget?
        for run in value.runs {
            var words = String(value[run.range].characters)
            let intent = run.inlinePresentationIntent ?? []
            var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
            var traits: UIFontDescriptor.SymbolicTraits = []
            if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
            if intent.contains(.emphasized) { traits.insert(.traitItalic) }
            if !traits.isEmpty {
                let weight: UIFont.Weight = traits.contains(.traitBold) ? .semibold : .regular
                var descriptor = UIFont.systemFont(ofSize: font.pointSize, weight: weight).fontDescriptor
                if traits.contains(.traitItalic) { descriptor = descriptor.withSymbolicTraits(.traitItalic) ?? descriptor }
                attributes[.font] = UIFont(descriptor: descriptor, size: font.pointSize)
                if traits.contains(.traitBold) { attributes[.foregroundColor] = UIColor(PhoneTheme.ink) }
            }
            if intent.contains(.code) { attributes[.font] = mono }
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            let target: PhoneRichText.LinkTarget? = {
                if let url = run.imageURL {
                    let local = PhoneRichText.localReference(url)
                    let name = words.trimmingCharacters(in: .whitespaces)
                    words = (local == nil ? "外部图片：" : "图片：") + (name.isEmpty ? (url.lastPathComponent.isEmpty ? "图片" : url.lastPathComponent) : name)
                    return PhoneRichText.linkTarget(url)
                }
                if let url = run.link { return PhoneRichText.linkTarget(url) }
                if style.opensFiles, !style.knownFiles.isEmpty, intent.contains(.code),
                   let candidate = PhoneRichText.codeFileCandidate(words), style.knownFiles.contains(Data(candidate.utf8)) { return .path(candidate) }
                return nil
            }()
            let continues: Bool = switch (previousTarget, target) {
            case let (.path(a), .path(b)): a.utf8.elementsEqual(b.utf8)
            case let (.web(a), .web(b)): a == b
            default: false
            }
            var prefix: NSMutableAttributedString?
            var actionable = false
            if style.active, let target {
                switch target {
                case .web:
                    actionable = true
                    attributes[.foregroundColor] = PhoneTheme.accentInk
                    attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
                    attributes[.underlineColor] = PhoneTheme.accentInk.withAlphaComponent(0.55)
                case let .path(path) where style.opensFiles && style.allowsFile?(path) != false:
                    actionable = true
                    if run.link == nil || !intent.contains(.code) { attributes[.font] = font }
                    attributes[.underlineStyle] = NSUnderlineStyle.single.union(.patternDot).rawValue
                    attributes[.underlineColor] = UIColor(PhoneTheme.muted)
                    if !continues {
                        let mark = MarkdownFileMark.attachment(for: path, font: font, dark: style.dark)
                        prefix = NSMutableAttributedString(attachment: mark)
                        // The mark and the first letter move onto the next line together.
                        prefix?.append(NSAttributedString(string: "\u{2060}"))
                    }
                default: break
                }
                if actionable {
                    if !continues { links.append(target) }
                    attributes[.link] = URL(string: "latch-link:\(linkBase + links.count - 1)")
                }
            }
            if let prefix {
                let range = NSRange(location: 0, length: prefix.length)
                prefix.addAttribute(.inlineDecoration, value: true, range: range)
                if let link = attributes[.link] { prefix.addAttribute(.link, value: link, range: range) }
                result.append(prefix)
            }
            if intent.contains(.code), target == nil {
                attributes[.inlineCodeSurface] = mono
                // NBSP is sized like a body-text space; only these marked padding characters are omitted when copied.
                let pad = NSAttributedString(string: "\u{00a0}", attributes: [.font: UIFont.systemFont(ofSize: mono.pointSize),
                    .inlineDecoration: true, .inlineCodeSurface: mono])
                result.append(pad)
                appendCode(words, attributes: attributes, to: result)
                result.append(pad)
            } else {
                result.append(NSAttributedString(string: words, attributes: attributes))
            }
            previousTarget = actionable ? target : nil
        }
        return (result, links)
    }
    private static let longIdentifier = try! NSRegularExpression(pattern: #"\S{20,}"#)
    /** TextKit otherwise sends an entire identifier to the next line and can strand just its leading pad. */
    private static func appendCode(_ words: String, attributes: [NSAttributedString.Key: Any], to result: NSMutableAttributedString) {
        var cursor = words.startIndex
        for match in longIdentifier.matches(in: words, range: NSRange(words.startIndex..., in: words)) {
            guard let range = Range(match.range, in: words) else { continue }
            var previous: Character?, uninterrupted = 0
            for index in words[range].indices {
                let char = words[index]
                let natural = previous.map { "._/-".contains($0) || ($0.isLowercase && char.isUppercase) } ?? false
                if uninterrupted >= 14 || (uninterrupted >= 4 && natural) {
                    result.append(NSAttributedString(string: String(words[cursor..<index]), attributes: attributes))
                    var separator = attributes; separator[.inlineDecoration] = true
                    result.append(NSAttributedString(string: "\u{200b}", attributes: separator))
                    cursor = index; uninterrupted = 0
                }
                previous = char; uninterrupted += 1
            }
        }
        result.append(NSAttributedString(string: String(words[cursor...]), attributes: attributes))
    }
}

/** A table: hairline rows, a header at 600 over a stronger rule, no column lines; wider than the column, it scrolls. */
struct MarkdownTable: View {
    let table: PhoneRichTable
    let size: CGFloat
    let style: MarkdownStyle.Links
    let onLink: (PhoneRichText.LinkTarget) -> Void
    var body: some View {
        let fontSize = size - 1
        let header = formatted(table.header, size: fontSize, header: true)
        let rows = table.rows.map { formatted($0, size: fontSize, header: false) }
        let widths = columnWidths([header] + rows, fontSize: fontSize)
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                row(header, header: true, widths: widths)
                Rectangle().fill(PhoneTheme.lineStrong).frame(height: 1)
                ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                    row(cells, header: false, widths: widths)
                    if index < table.rows.count - 1 { Rectangle().fill(PhoneTheme.line).frame(height: 1) }
                }
            }.fixedSize()
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .mask(EdgeFade())
        .contextMenu { Button { LocalClipboard.copy(source) } label: { Label("复制表格", systemImage: "doc.on.doc") } }
        .accessibilityElement(children: .contain).accessibilityLabel("表格，可横向滚动")
    }
    private func formatted(_ cells: [AttributedString], size: CGFloat, header: Bool) -> [MarkdownStyle.Inline] {
        let font = UIFont.systemFont(ofSize: size, weight: header ? .semibold : .regular)
        return cells.enumerated().map { column, cell in
            let inline = MarkdownStyle.inline(cell, font: font, color: UIColor(header ? PhoneTheme.ink : PhoneTheme.ink2), style: style)
            let text = NSMutableAttributedString(attributedString: inline.text)
            let align = table.alignments.indices.contains(column) ? table.alignments[column] : .leading
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = align == .center ? .center : align == .trailing ? .right : .left
            paragraph.lineSpacing = 3
            text.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: text.length))
            return (text, inline.links)
        }
    }
    private func row(_ cells: [MarkdownStyle.Inline], header: Bool, widths: [CGFloat]) -> some View {
        HStack(alignment: .top, spacing: 16) {
            ForEach(widths.indices, id: \.self) { column in
                if cells.indices.contains(column) {
                    let cell = cells[column]
                    ConversationText(rich: cell.text, links: cell.links, onLink: onLink)
                        .frame(width: widths[column]).fixedSize(horizontal: false, vertical: true)
                } else {
                    Color.clear.frame(width: widths[column], height: 0)
                }
            }
        }.padding(.vertical, header ? 6 : 9)
    }
    /** Measure the same marks and padding the cells draw. */
    private func columnWidths(_ rows: [[MarkdownStyle.Inline]], fontSize: CGFloat) -> [CGFloat] {
        let count = max(table.alignments.count, rows.map(\.count).max() ?? 0)
        var widths = Array(repeating: fontSize * 4, count: count)
        for row in rows {
            for (column, cell) in row.enumerated() {
                let width = cell.text.boundingRect(with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude),
                    options: [.usesLineFragmentOrigin], context: nil).width
                widths[column] = min(fontSize * 15, max(widths[column], ceil(width) + 2))
            }
        }
        return widths
    }
    private var source: String {
        func line(_ cells: [AttributedString]) -> String { "| " + cells.map { String($0.characters).replacingOccurrences(of: "|", with: "\\|") }.joined(separator: " | ") + " |" }
        let rule = "|" + table.alignments.map { $0 == .center ? ":---:" : $0 == .trailing ? "---:" : "---" }.joined(separator: "|") + "|"
        return ([line(table.header), rule] + table.rows.map(line)).joined(separator: "\n")
    }
}

/**
 * Code in a card: its language and a copy button above, lines that scroll sideways, a fold past 18 lines. While a long
 * block still arrives it shows its newest lines. Invisible characters are marked where they are shown, never in a copy.
 */
struct MarkdownCode: View {
    let code: String
    let language: String?
    var arriving = false
    @State private var expanded = false
    @State private var copied = false
    @Environment(\.sizeCategory) private var sizeCategory
    private static let fold = 18
    var body: some View {
        let lines = code.isEmpty ? 0 : code.components(separatedBy: "\n").count
        let long = lines > Self.fold, tail = long && arriving, collapsed = long && !expanded && !arriving
        let shown: String = {
            let all = code.components(separatedBy: "\n")
            if tail { return all.suffix(Self.fold - 1).joined(separator: "\n") }
            if collapsed { return all.prefix(Self.fold).joined(separator: "\n") }
            return code
        }()
        let visible = PhoneConversation.visible(shown), hidden = PhoneConversation.visible(code) != code
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(label).font(.system(size: 12, design: .monospaced)).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                Spacer(minLength: 8)
                if hidden { Text("含不可见字符").font(.system(size: 12)).foregroundStyle(PhoneTheme.amber).lineLimit(1) }
                Button {
                    LocalClipboard.copy(code)
                    withAnimation(.easeOut(duration: 0.15)) { copied = true }
                    Task { try? await Task.sleep(for: .seconds(2.5)); withAnimation(.easeOut(duration: 0.15)) { copied = false } }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 13)).foregroundStyle(copied ? PhoneTheme.accent : PhoneTheme.muted)
                        .frame(width: 36, height: 32).contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(code.isEmpty).accessibilityLabel(copied ? "已复制" : "复制代码")
            }.padding(.leading, 12).padding(.trailing, 2).frame(minHeight: 32)
            if tail { Text("前 \(lines - Self.fold + 1) 行已收起").font(.system(size: 12)).foregroundStyle(PhoneTheme.muted).padding(.horizontal, 12).padding(.bottom, 2) }
            ScrollView(.horizontal, showsIndicators: false) {
                ConversationText(rich: CodeHighlight.attributed(visible, language: arriving ? nil : language, size: fontSize), wraps: false)
                    .padding(.horizontal, 12).padding(.top, 2).padding(.bottom, 12)
            }.scrollBounceBehavior(.basedOnSize, axes: .horizontal).mask(EdgeFade())
            if long && !arriving {
                Button { withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() } } label: {
                    HStack(spacing: 6) {
                        Text(expanded ? "收起代码" : "展开全部 \(lines) 行")
                        Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .semibold))
                    }.font(.system(size: 13)).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity, minHeight: 36).contentShape(Rectangle())
                }.buttonStyle(.plain).overlay(alignment: .top) { Rectangle().fill(PhoneTheme.line).frame(height: 1) }
                    .accessibilityValue(expanded ? "已展开" : "已收起")
            }
        }
        .background(PhoneTheme.sunken, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(PhoneTheme.line))
    }
    private var label: String {
        switch language?.lowercased() {
        case nil, "": "代码"
        case "math", "latex", "tex": "公式 · 源码"
        case "mermaid": "Mermaid · 源码"
        case let name?: name
        }
    }
    private var fontSize: CGFloat { _ = sizeCategory; return UIFontMetrics(forTextStyle: .body).scaledValue(for: 13) }
}

/** The trailing edge thins out, so a line running past it reads as more to scroll to, as the web's code edge does. */
struct EdgeFade: View {
    var body: some View {
        HStack(spacing: 0) {
            Rectangle()
            LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .leading, endPoint: .trailing).frame(width: 18)
        }
    }
}

/** A local picture a reply shows: drawn from the project once the Host lets the phone read it, else its name to open. */
struct MarkdownPicture: View {
    let source: String
    let alt: String
    let open: ((String, String?) -> Void)?
    var body: some View {
        Button { open?(source, nil) } label: {
            HStack(spacing: 6) {
                Image(systemName: "photo").font(.system(size: 12))
                Text(alt.isEmpty ? (source.split(separator: "/").last.map(String.init) ?? source) : alt).lineLimit(1).truncationMode(.middle)
            }
            .font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2)
            .padding(.horizontal, 10).frame(height: 30)
            .background(PhoneTheme.raised, in: Capsule()).overlay(Capsule().stroke(PhoneTheme.line))
        }.buttonStyle(.plain).disabled(open == nil).accessibilityLabel("图片：" + (alt.isEmpty ? source : alt))
    }
}
