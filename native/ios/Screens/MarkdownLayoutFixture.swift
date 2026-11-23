import CoreText
import Foundation
import LatchNativeCore
import UIKit

/** Checks UIKit's real selection and wrapping on public sample text, using an isolated named pasteboard. */
@MainActor enum MarkdownLayoutFixture {
    static func recordIfRequested() {
        guard let nonce = UserDefaults.standard.string(forKey: "LatchMarkdownProbe"), UUID(uuidString: nonce) != nil else { return }
        let long = String(repeating: "long_identifier_", count: 12)
        let nfc = "caf\u{e9}.go", nfd = "cafe\u{301}.go"
        let source = "前 `\(long)` [`源码`](src/app.go) [`网页`](https://example.invalid/) `\(nfc)` `\(nfd)` 后"
        guard case let .text(line) = PhoneRichText.blocks(source)?.first else { return }
        let font = UIFont.systemFont(ofSize: 16)
        func render(open: Bool, active: Bool, names: Set<Data>) -> MarkdownStyle.Inline {
            MarkdownStyle.inline(line.content, font: font, color: .label,
                                 style: .init(active: active, opensFiles: open, knownFiles: names, dark: false))
        }
        let rich = render(open: true, active: true, names: [Data(nfc.utf8)])
        let withoutFiles = render(open: false, active: true, names: [])
        let inert = render(open: true, active: false, names: [])
        var mark = NSRange()
        guard let markAt = rich.text.string.firstIndex(of: "l") else { return }
        _ = rich.text.attribute(.inlineCodeSurface, at: markAt.utf16Offset(in: rich.text.string), longestEffectiveRange: &mark,
                                in: NSRange(location: 0, length: rich.text.length))
        let web = (rich.text.string as NSString).range(of: "网页")
        let file = (rich.text.string as NSString).range(of: "源码")
        let plainFile = (withoutFiles.text.string as NSString).range(of: "源码")
        let view = MarkdownTextView(usingTextLayoutManager: true)
        view.isEditable = false; view.isScrollEnabled = false; view.textContainerInset = .zero
        view.frame = CGRect(x: 0, y: 0, width: 130, height: 700)
        view.display(rich.text.attributedSubstring(from: mark))
        view.layoutIfNeeded()
        let manager = view.textLayoutManager
        var lines = Set<Int>()
        if let manager {
            manager.ensureLayout(for: manager.documentRange)
            manager.enumerateTextSegments(in: manager.documentRange, type: .standard, options: .rangeNotRequired) { _, rect, _, _ in
                if rect.width > 0 { lines.insert(Int(rect.midY.rounded())) }
                return true
            }
        }
        // Resolution can replace code pads with a file mark while the reader is selecting a later line.
        let before = render(open: true, active: true, names: [])
        view.display(before.text)
        let selected = (before.text.string as NSString).range(of: "后")
        view.selectedRange = selected
        view.display(rich.text)
        let selectedWords = rich.text.sourceText(in: view.selectedRange)
        let board = UIPasteboard.withUniqueName()
        defer { UIPasteboard.remove(withName: board.name) }
        view.selectedRange = NSRange(location: 0, length: rich.text.length)
        view.copySelection(to: board)
        let copied = board.string
        let known = rich.links.compactMap { target -> Data? in if case let .path(path) = target { Data(path.utf8) } else { nil } }
        let results: [String: Any] = [
            "codeWraps": lines.count > 1,
            "codeInkHasBalancedInsets": balancedInsets(font: font, style: .init(active: false, opensFiles: false, knownFiles: [], dark: false)),
            "surfaceRGB": ["light": surfaceRGB(.light), "dark": surfaceRGB(.dark)],
            "copyPreservesSource": copied?.utf8.elementsEqual(String(line.content.characters).utf8) == true,
            "selectionSurvivesResolution": selectedWords == "后",
            "authorizedFileBytes": known == [Data("src/app.go".utf8), Data(nfc.utf8)],
            "distinctLinkStyles": rich.text.attribute(.inlineCodeSurface, at: web.location, effectiveRange: nil) == nil
                && rich.text.attribute(.inlineCodeSurface, at: file.location, effectiveRange: nil) == nil
                && (rich.text.attribute(.underlineStyle, at: web.location, effectiveRange: nil) as? Int) == NSUnderlineStyle.single.rawValue
                && (rich.text.attribute(.underlineStyle, at: file.location, effectiveRange: nil) as? Int) == NSUnderlineStyle.single.union(.patternDot).rawValue,
            "inactiveLinksStayWords": inert.links.isEmpty && withoutFiles.links.count == 1
                && withoutFiles.text.attribute(.underlineStyle, at: plainFile.location, effectiveRange: nil) == nil
        ]
        let url = URL.temporaryDirectory.appendingPathComponent("markdown-" + nonce + ".json")
        try? JSONSerialization.data(withJSONObject: results).write(to: url, options: .atomic)
    }
    /** Compare the actual ascenders and descenders to the surface on a Chinese list line, where the line leading is taller. */
    private static func balancedInsets(font: UIFont, style: MarkdownStyle.Links) -> Bool {
        guard case let .text(line) = PhoneRichText.blocks("- 保存态（`PersistMessages` / `Storage`）：作为事实源。")?.first else { return false }
        let (text, _) = MarkdownStyle.prose([line], size: font.pointSize, style: style, ink: .label)
        let view = MarkdownTextView(usingTextLayoutManager: true)
        view.frame = CGRect(x: 0, y: 0, width: 390, height: 120)
        view.display(text); view.layoutIfNeeded()
        guard let manager = view.textLayoutManager else { return false }
        manager.ensureLayout(for: manager.documentRange)
        return ["PersistMessages", "Storage"].allSatisfy { word in
            let range = (text.string as NSString).range(of: word)
            guard range.location != NSNotFound, let mono = text.attribute(.font, at: range.location, effectiveRange: nil) as? UIFont,
                  let start = manager.location(manager.documentRange.location, offsetBy: range.location),
                  let end = manager.location(start, offsetBy: range.length), let run = NSTextRange(location: start, end: end) else { return false }
            let glyphs = CTLineCreateWithAttributedString(NSAttributedString(string: word, attributes: [.font: mono]))
            let ink = CTLineGetBoundsWithOptions(glyphs, .useGlyphPathBounds)
            var balanced = false
            manager.enumerateTextSegments(in: run, type: .standard, options: .rangeNotRequired) { _, rect, baseline, _ in
                let box = MarkdownCodeSurface.bounds(for: rect, baseline: baseline, font: mono)
                let top = rect.minY + baseline - ink.maxY - box.minY
                let bottom = box.maxY - (rect.minY + baseline - ink.minY)
                balanced = min(top, bottom) > 0.5 && abs(top - bottom) < mono.pointSize / 4
                return false
            }
            return balanced
        }
    }
    private static func surfaceRGB(_ style: UIUserInterfaceStyle) -> [Int] {
        let color = PhoneTheme.codeTint.resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: nil)
        return [red, green, blue].map { Int(($0 * 255).rounded()) }
    }
}
