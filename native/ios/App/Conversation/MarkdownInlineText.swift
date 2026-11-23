import UIKit

extension NSAttributedString.Key {
    static let inlineCodeSurface = Self("LatchInlineCodeSurface")
    static let inlineDecoration = Self("LatchInlineDecoration")
}

extension NSAttributedString {
    /** Keep the author's whitespace, including real nonbreaking spaces and attachment characters. */
    func sourceText(in range: NSRange) -> String {
        let storage = string as NSString
        var result = ""
        enumerateAttribute(.inlineDecoration, in: range) { decoration, part, _ in
            if decoration == nil { result += storage.substring(with: part) }
        }
        return result
    }
}

/** Paint inside TextKit's own fragments so the background arrives with the glyphs, including when no selection is active. */
final class MarkdownTextView: LocalTextView, @preconcurrency NSTextLayoutManagerDelegate {
    private var decorations: [NSRange] = []
    func display(_ rich: NSAttributedString) {
        // A settled path can trade two code-pad spaces for a file mark while a selection is active.
        let selected = selectedRange
        let source: NSRange? = { [decorations] in
            guard selected.location != NSNotFound, selected.length > 0 else { return nil }
            func offset(_ end: Int) -> Int {
                decorations.reduce(end) { $0 - NSIntersectionRange($1, NSRange(location: 0, length: end)).length }
            }
            let start = offset(selected.location)
            return NSRange(location: start, length: offset(NSMaxRange(selected)) - start)
        }()
        attributedText = rich
        decorations = []
        rich.enumerateAttribute(.inlineDecoration, in: NSRange(location: 0, length: rich.length)) { value, range, _ in
            if value != nil { decorations.append(range) }
        }
        if let source {
            func offset(_ index: Int, afterDecoration: Bool) -> Int {
                var display = index
                for part in decorations {
                    if part.location > display || (part.location == display && !afterDecoration) { break }
                    display += part.length
                }
                return display
            }
            let start = offset(source.location, afterDecoration: true)
            let end = offset(NSMaxRange(source), afterDecoration: false)
            if end >= start, end <= rich.length { selectedRange = NSRange(location: start, length: end - start) }
        } else if selected.location != NSNotFound, selected.location <= rich.length {
            selectedRange = NSRange(location: selected.location, length: 0)
        }
        if let manager = textLayoutManager {
            manager.delegate = self
            manager.invalidateLayout(for: manager.documentRange)
        }
        setNeedsLayout()
    }
    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: MarkdownTextView, _) in
            if let manager = view.textLayoutManager { manager.invalidateLayout(for: manager.documentRange) }
            view.setNeedsLayout()
        }
    }
    required init?(coder: NSCoder) { nil }
    func textLayoutManager(_ manager: NSTextLayoutManager, textLayoutFragmentFor location: any NSTextLocation, in element: NSTextElement) -> NSTextLayoutFragment {
        let fragment = MarkdownFragment(textElement: element, range: element.elementRange)
        if let paragraph = element as? NSTextParagraph, let origin = element.elementRange?.location {
            let text = paragraph.attributedString
            text.enumerateAttribute(.inlineCodeSurface, in: NSRange(location: 0, length: text.length)) { value, range, _ in
                guard let font = value as? UIFont, let start = manager.location(origin, offsetBy: range.location),
                      let end = manager.location(start, offsetBy: range.length),
                      let span = NSTextRange(location: start, end: end) else { return }
                fragment.code.append((span, font))
            }
        }
        fragment.fill = PhoneTheme.codeTint.resolvedColor(with: traitCollection).cgColor
        return fragment
    }
    override func copy(_ sender: Any?) { copySelection(to: .general) }
    func copySelection(to pasteboard: UIPasteboard) {
        let range = selectedRange
        guard range.location != NSNotFound, range.length > 0, NSMaxRange(range) <= attributedText.length else { return }
        let source = attributedText.sourceText(in: range)
        if !source.isEmpty { LocalClipboard.copy(source, to: pasteboard) }
    }
}

enum MarkdownCodeSurface {
    /** TextKit's segment encloses the whole mixed-script line. The code surface follows only the mono font and baseline. */
    static func bounds(for segment: CGRect, baseline: CGFloat, font: UIFont) -> CGRect {
        let inset = font.pointSize / 14
        return CGRect(x: segment.minX, y: segment.minY + baseline - font.ascender - inset,
                      width: segment.width, height: font.ascender - font.descender + 2 * inset)
    }
}

private final class MarkdownFragment: NSTextLayoutFragment {
    var code: [(range: NSTextRange, font: UIFont)] = []
    var fill: CGColor?
    override func draw(at point: CGPoint, in context: CGContext) {
        if let manager = textLayoutManager, let fill, !code.isEmpty {
            context.saveGState()
            context.setFillColor(fill)
            for (range, font) in code {
                manager.enumerateTextSegments(in: range, type: .standard, options: .rangeNotRequired) { _, segment, baseline, _ in
                    let surface = MarkdownCodeSurface.bounds(for: segment, baseline: baseline, font: font)
                    let box = surface.offsetBy(dx: point.x - self.layoutFragmentFrame.minX, dy: point.y - self.layoutFragmentFrame.minY)
                    guard box.width > 0, box.height > 0 else { return true }
                    let radius = min(6, box.width / 2, box.height / 2)
                    context.addPath(CGPath(roundedRect: box, cornerWidth: radius, cornerHeight: radius, transform: nil))
                    context.fillPath()
                    return true
                }
            }
            context.restoreGState()
        }
        super.draw(at: point, in: context)
    }
}

@MainActor enum MarkdownFileMark {
    private enum Mark: Hashable {
        case letters(String), symbol(String)
        init(_ path: String) {
            if path.hasSuffix("/") { self = .symbol("folder"); return }
            let bare = path.replacingOccurrences(of: #"(#L[0-9]+(C[0-9]+)?|:[0-9]+(:[0-9]+)?)$"#, with: "", options: .regularExpression)
            let ext = (bare as NSString).pathExtension.lowercased()
            switch ext {
            case "go": self = .letters("GO")
            case "ts", "tsx", "mts", "cts": self = .letters("TS")
            case "js", "jsx", "mjs", "cjs": self = .letters("JS")
            case "py", "pyi": self = .letters("PY")
            case "md", "markdown", "mdx": self = .letters("M↓")
            case "json", "jsonl", "jsonc": self = .symbol("curlybraces")
            case "sh", "bash", "zsh": self = .symbol("terminal")
            case "png", "jpg", "jpeg", "webp", "heic", "gif", "svg": self = .symbol("photo")
            default: self = .symbol("doc")
            }
        }
    }
    private static let cache: NSCache<NSString, NSTextAttachment> = {
        let cache = NSCache<NSString, NSTextAttachment>(); cache.countLimit = 128; return cache
    }()
    static func attachment(for path: String, font: UIFont, dark: Bool) -> NSTextAttachment {
        let mark = Mark(path), side = ceil(font.pointSize * 0.9)
        let key = "\(mark):\(font.pointSize):\(dark)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        let ink = PhoneTheme.uiDynamic(0x4D6B86, 0x9DB4CC).resolvedColor(with: UITraitCollection(userInterfaceStyle: dark ? .dark : .light))
        let size = CGSize(width: side + 3, height: side)
        let image = UIGraphicsImageRenderer(size: size).image { _ in
            switch mark {
            case let .letters(letters):
                let label = letters as NSString
                let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: side * 0.64, weight: .bold), .foregroundColor: ink]
                let bounds = label.size(withAttributes: attributes)
                label.draw(at: CGPoint(x: (side - bounds.width) / 2, y: (side - bounds.height) / 2), withAttributes: attributes)
            case let .symbol(symbol):
                let image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: side * 0.82))?
                    .withTintColor(ink, renderingMode: .alwaysOriginal)
                if let image {
                    let fit = min(side / image.size.width, side / image.size.height)
                    let width = image.size.width * fit, height = image.size.height * fit
                    image.draw(in: CGRect(x: (side - width) / 2, y: (side - height) / 2, width: width, height: height))
                }
            }
        }
        let attachment = NSTextAttachment(image: image)
        // The mark sits beside the lowercase filename, whose optical centre is below the centre of a capital.
        attachment.bounds = CGRect(x: 0, y: (font.xHeight - side) / 2, width: size.width, height: side)
        attachment.isAccessibilityElement = false
        cache.setObject(attachment, forKey: key)
        return attachment
    }
}
