import LatchNativeCore
import SwiftUI
import UIKit

/**
 * An agent's Markdown as the web draws it (`apps/web/src/MessageContent.tsx`, `styles/markdown.css`): headings in three
 * steps, lists with their markers and tasks, quotes behind a bar, a rule, tables that scroll sideways, and code in a
 * card with its language, a copy button and a fold past 18 lines. Prose that runs together stays one selectable text.
 * Web and mail links open when pressed and a project path previews; pictures load only from the project, never the web.
 * Formulas and diagrams are shown as their source: drawing them needs a web view, which the phone does not use.
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
    @Environment(\.openURL) private var openURL
    @Environment(\.sizeCategory) private var sizeCategory
    var body: some View {
        if let blocks = MarkdownCache.blocks(text) {
            let pieces = MarkdownPiece.group(blocks)
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(pieces.enumerated()), id: \.offset) { index, piece in
                    quoted(piece.quote) { view(piece, last: index == pieces.count - 1) }
                        .padding(.leading, CGFloat(piece.depth) * MarkdownStyle.indent(scaled))
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if text.utf8.count <= PhoneRichText.limit { Text("结构过深，按纯文本显示").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                ConversationText(text: text, size: size)
            }
        }
    }
    @ViewBuilder private func view(_ piece: MarkdownPiece, last: Bool) -> some View {
        switch piece.kind {
        case let .prose(lines):
            let (rich, links) = MarkdownStyle.prose(lines, size: scaled, inert: inert, ink: ink)
            ConversationText(rich: rich, links: links, onLink: follow).frame(maxWidth: .infinity, alignment: .leading)
        case let .code(language, code, open):
            MarkdownCode(code: code, language: language, arriving: open && streaming && last)
        case let .table(table):
            MarkdownTable(table: table, size: scaled)
        case .rule:
            Rectangle().fill(PhoneTheme.line).frame(height: 1).padding(.vertical, 6)
        case let .image(source, alt):
            MarkdownPicture(source: source, alt: alt, open: inert ? nil : open)
        }
    }
    private var scaled: CGFloat { _ = sizeCategory; return UIFontMetrics(forTextStyle: .body).scaledValue(for: size) }
    private func follow(_ target: PhoneRichText.LinkTarget) {
        switch target {
        case let .web(url): openURL(url)
        case let .path(path): open?(path, nil)
        case .text: break
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
    static func blocks(_ text: String) -> [PhoneRichBlock]? {
        let key = text as NSString
        if let hit = cache.object(forKey: key) { return hit.blocks }
        let blocks = PhoneRichText.blocks(text)
        cache.setObject(Entry(blocks), forKey: key, cost: key.length)
        return blocks
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
    static func prose(_ lines: [PhoneRichLine], size: CGFloat, inert: Bool = false, ink: UIColor = .label) -> (NSAttributedString, [PhoneRichText.LinkTarget]) {
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
            let (words, found) = inline(line.content, font: font, color: ink, linkBase: links.count, inert: inert)
            links += found
            piece.append(words)
            if case .heading = line.kind { piece.addAttribute(.foregroundColor, value: UIColor(PhoneTheme.ink), range: NSRange(location: 0, length: piece.length)) }
            piece.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: piece.length))
            result.append(piece)
        }
        return (result, links)
    }
    private static func markerText(_ marker: PhoneRichMarker, depth: Int, font: UIFont) -> NSAttributedString {
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
    static func inline(_ value: AttributedString, font: UIFont, color: UIColor, linkBase: Int = 0, inert: Bool = false) -> (NSAttributedString, [PhoneRichText.LinkTarget]) {
        let result = NSMutableAttributedString()
        var links: [PhoneRichText.LinkTarget] = []
        let mono = UIFont.monospacedSystemFont(ofSize: font.pointSize * 0.88, weight: .regular)
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
            if intent.contains(.code) { attributes[.font] = mono; attributes[.backgroundColor] = PhoneTheme.codeTint }
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            let target: PhoneRichText.LinkTarget? = {
                if let url = run.imageURL {
                    let local = PhoneRichText.localReference(url)
                    let name = words.trimmingCharacters(in: .whitespaces)
                    words = (local == nil ? "外部图片：" : "图片：") + (name.isEmpty ? (url.lastPathComponent.isEmpty ? "图片" : url.lastPathComponent) : name)
                    return PhoneRichText.linkTarget(url)
                }
                return run.link.map(PhoneRichText.linkTarget)
            }()
            if let target, !inert {
                if case .text = target {} else {
                    attributes[.link] = URL(string: "latch-link:\(linkBase + links.count)")
                    attributes[.foregroundColor] = PhoneTheme.accentInk
                    links.append(target)
                }
            }
            result.append(NSAttributedString(string: words, attributes: attributes))
        }
        return (result, links)
    }
    /** Cell text for SwiftUI: emphasis, code and strikethrough; a table's links read as their words. */
    static func cell(_ value: AttributedString, size: CGFloat, header: Bool) -> AttributedString {
        var result = AttributedString()
        for run in value.runs {
            var piece = AttributedString(String(value[run.range].characters))
            let intent = run.inlinePresentationIntent ?? []
            var font = Font.system(size: size, weight: header || intent.contains(.stronglyEmphasized) ? .semibold : .regular)
            if intent.contains(.emphasized) { font = font.italic() }
            if intent.contains(.code) { font = .system(size: size * 0.88, design: .monospaced); piece.backgroundColor = Color(PhoneTheme.codeTint) }
            piece.font = font
            if intent.contains(.strikethrough) { piece.strikethroughStyle = .single }
            if run.link != nil || run.imageURL != nil { piece.foregroundColor = Color(PhoneTheme.accentInk) }
            result += piece
        }
        return result
    }
}

/** A table: hairline rows, a header at 600 over a stronger rule, no column lines; wider than the column, it scrolls. */
struct MarkdownTable: View {
    let table: PhoneRichTable
    let size: CGFloat
    var body: some View {
        let fontSize = size - 1
        let widths = columnWidths(fontSize: fontSize)
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                row(table.header, header: true, widths: widths, fontSize: fontSize)
                Rectangle().fill(PhoneTheme.lineStrong).frame(height: 1)
                ForEach(Array(table.rows.enumerated()), id: \.offset) { index, cells in
                    row(cells, header: false, widths: widths, fontSize: fontSize)
                    if index < table.rows.count - 1 { Rectangle().fill(PhoneTheme.line).frame(height: 1) }
                }
            }.fixedSize()
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .mask(EdgeFade())
        .contextMenu { Button { LocalClipboard.copy(source) } label: { Label("复制表格", systemImage: "doc.on.doc") } }
        .accessibilityElement(children: .contain).accessibilityLabel("表格，可横向滚动")
    }
    private func row(_ cells: [AttributedString], header: Bool, widths: [CGFloat], fontSize: CGFloat) -> some View {
        HStack(alignment: .top, spacing: 16) {
            ForEach(widths.indices, id: \.self) { column in
                let alignment = table.alignments.indices.contains(column) ? table.alignments[column] : .leading
                Text(MarkdownStyle.cell(cells.indices.contains(column) ? cells[column] : AttributedString(), size: fontSize, header: header))
                    .foregroundStyle(header ? PhoneTheme.ink : PhoneTheme.ink2)
                    .lineSpacing(3)
                    .multilineTextAlignment(alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
                    .frame(width: widths[column], alignment: alignment == .center ? .top : alignment == .trailing ? .topTrailing : .topLeading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }.padding(.vertical, header ? 6 : 9)
    }
    /** Each column as wide as its longest cell on one line, between 6 and 18 characters of the body size. */
    private func columnWidths(fontSize: CGFloat) -> [CGFloat] {
        let count = max(table.alignments.count, table.header.count, table.rows.map(\.count).max() ?? 0)
        let bold = UIFont.systemFont(ofSize: fontSize, weight: .semibold), plain = UIFont.systemFont(ofSize: fontSize)
        return (0..<count).map { column in
            let header = table.header.indices.contains(column) ? [MarkdownStyle.inline(table.header[column], font: bold, color: .label).0] : []
            let cells = header + table.rows.compactMap { $0.indices.contains(column) ? MarkdownStyle.inline($0[column], font: plain, color: .label).0 : nil }
            let widest = cells.map { $0.boundingRect(with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], context: nil).width }.max() ?? 0
            return min(max(ceil(widest) + 2, fontSize * 4), fontSize * 15)
        }
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
