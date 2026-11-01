import SwiftUI
import UIKit
import UniformTypeIdentifiers

/** Native selection stays in TextKit 2; no WebView, detectors, indexing or cloud clipboard is involved. */
struct ConversationText: UIViewRepresentable {
    let text: String
    var monospaced = false
    var markdown = false
    var size: CGFloat = 16
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> LocalTextView {
        let view = LocalTextView(usingTextLayoutManager: true)
        view.isEditable = false; view.isSelectable = true; view.isScrollEnabled = false
        view.textDragInteraction?.isEnabled = false
        view.backgroundColor = .clear; view.textColor = .label
        view.textContainerInset = .zero; view.textContainer.lineFragmentPadding = 0
        view.dataDetectorTypes = []; view.autocorrectionType = .no; view.spellCheckingType = .no
        view.smartDashesType = .no; view.smartQuotesType = .no
        view.adjustsFontForContentSizeCategory = true
        if #available(iOS 18, *) { view.writingToolsBehavior = .none }
        return view
    }
    func updateUIView(_ view: LocalTextView, context: Context) {
        let trait = context.environment.sizeCategory
        guard context.coordinator.shown != text || context.coordinator.category != trait else { return }
        context.coordinator.shown = text; context.coordinator.category = trait
        let selected = view.selectedRange, scaled = UIFontMetrics(forTextStyle: .body).scaledValue(for: size)
        let font = monospaced ? UIFont.monospacedSystemFont(ofSize: scaled - 2, weight: .regular) : UIFont.systemFont(ofSize: scaled)
        if markdown { view.attributedText = RichText.attributed(text, font: font) }
        else { view.text = text; view.font = font; view.textColor = .label }
        if selected.location != NSNotFound, selected.location <= view.text.utf16.count,
           selected.length <= view.text.utf16.count - selected.location { view.selectedRange = selected }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: LocalTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0, width.isFinite else { return nil }
        return uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    }
    final class Coordinator { var shown: String?; var category: ContentSizeCategory? }
}

/** The prose the agents write, as the desktop draws it. Links stay plain words: nothing in a reply opens by itself. */
enum RichText {
    private static let limit = 200_000
    static func attributed(_ text: String, font: UIFont) -> NSAttributedString {
        guard text.utf8.count <= limit else { return NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: UIColor.label]) }
        let result = NSMutableAttributedString(), mono = UIFont.monospacedSystemFont(ofSize: font.pointSize - 2, weight: .regular)
        var fenced = false, first = true
        func paragraph(indent: CGFloat = 0, head: CGFloat? = nil, after: CGFloat = 8) -> NSParagraphStyle {
            let style = NSMutableParagraphStyle()
            style.lineHeightMultiple = 1.18; style.paragraphSpacing = after; style.headIndent = indent; style.firstLineHeadIndent = head ?? indent
            return style
        }
        func add(_ line: NSAttributedString) {
            if !first { result.append(NSAttributedString(string: "\n")) }
            result.append(line); first = false
        }
        for raw in text.components(separatedBy: "\n") {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") { fenced.toggle(); continue }
            if fenced {
                add(NSAttributedString(string: raw, attributes: [.font: mono, .foregroundColor: UIColor.secondaryLabel, .backgroundColor: UIColor.secondarySystemBackground, .paragraphStyle: paragraph(after: 0)]))
                continue
            }
            if trimmed.isEmpty { continue }
            if let match = trimmed.range(of: "^#{1,6} ", options: .regularExpression) {
                add(inline(String(trimmed[match.upperBound...]), font: UIFont.systemFont(ofSize: font.pointSize, weight: .semibold), mono: mono, style: paragraph()))
            } else if let match = trimmed.range(of: "^([-*+]|[0-9]{1,3}[.)]) ", options: .regularExpression) {
                let mark = String(trimmed[..<match.upperBound]).trimmingCharacters(in: .whitespaces)
                let shown = mark.first?.isNumber == true ? mark : "•"
                let line = NSMutableAttributedString(string: shown + "\t", attributes: [.font: font, .foregroundColor: UIColor.secondaryLabel])
                line.append(inline(String(trimmed[match.upperBound...]), font: font, mono: mono, style: nil))
                let style = paragraph(indent: 22, head: 0, after: 4).mutableCopy() as! NSMutableParagraphStyle
                style.tabStops = [NSTextTab(textAlignment: .left, location: 22)]
                line.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: line.length))
                add(line)
            } else {
                add(inline(trimmed, font: font, mono: mono, style: paragraph()))
            }
        }
        return result
    }
    private static func inline(_ text: String, font: UIFont, mono: UIFont, style: NSParagraphStyle?) -> NSAttributedString {
        var base: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.label]
        if let style { base[.paragraphStyle] = style }
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        guard let parsed = try? AttributedString(markdown: text, options: options) else { return NSAttributedString(string: text, attributes: base) }
        let result = NSMutableAttributedString()
        for run in parsed.runs {
            var attributes = base
            let intent = run.inlinePresentationIntent ?? []
            if intent.contains(.code) { attributes[.font] = mono; attributes[.backgroundColor] = UIColor.secondarySystemBackground }
            else if intent.contains(.stronglyEmphasized) { attributes[.font] = UIFont.systemFont(ofSize: font.pointSize, weight: .semibold) }
            if run.link != nil { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
            result.append(NSAttributedString(string: String(parsed[run.range].characters), attributes: attributes))
        }
        return result
    }
}

struct LocalTextEditor: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    var maximumLines: Int? = 6
    var focused: Binding<Bool>? = nil
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> LocalPromptView {
        let view = LocalPromptView(usingTextLayoutManager: true)
        view.isEditable = true; view.isSelectable = true; view.delegate = context.coordinator
        view.backgroundColor = .clear; view.textColor = .label; view.font = Self.font
        view.textContainerInset = .zero; view.textContainer.lineFragmentPadding = 0
        view.textDragInteraction?.isEnabled = false; view.dataDetectorTypes = []; view.allowsEditingTextAttributes = false
        view.autocorrectionType = .no; view.spellCheckingType = .no; view.smartDashesType = .no; view.smartQuotesType = .no
        view.adjustsFontForContentSizeCategory = true
        if #available(iOS 18, *) { view.writingToolsBehavior = .none }
        return view
    }
    private static var font: UIFont { UIFont.systemFont(ofSize: UIFontMetrics(forTextStyle: .body).scaledValue(for: 16)) }
    func updateUIView(_ view: LocalPromptView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
        view.accessibilityLabel = placeholder
        view.font = Self.font
        view.isScrollEnabled = maximumLines == nil
        if let focused, focused.wrappedValue != view.isFirstResponder, view.window != nil {
            // Changing the responder during a layout pass is refused, so it waits for the next turn.
            let wanted = focused.wrappedValue
            DispatchQueue.main.async { if wanted { view.becomeFirstResponder() } else { view.resignFirstResponder() } }
        }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: LocalPromptView, context: Context) -> CGSize? {
        guard let maximumLines, let width = proposal.width, width > 0, width.isFinite else { return nil }
        let line = uiView.font?.lineHeight ?? 22, maximum = line * CGFloat(maximumLines)
        let size = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        uiView.isScrollEnabled = size.height > maximum
        return CGSize(width: width, height: max(line, min(maximum, size.height)))
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: LocalTextEditor
        init(_ parent: LocalTextEditor) { self.parent = parent }
        func textViewDidChange(_ textView: UITextView) { parent.text = textView.text ?? "" }
        func textViewDidBeginEditing(_ textView: UITextView) { if parent.focused?.wrappedValue == false { parent.focused?.wrappedValue = true } }
        func textViewDidEndEditing(_ textView: UITextView) { if parent.focused?.wrappedValue == true { parent.focused?.wrappedValue = false } }
    }
}

class LocalTextView: UITextView {
    override func copy(_ sender: Any?) {
        let source = (text ?? "") as NSString, range = selectedRange
        guard range.location != NSNotFound, range.location <= source.length, range.length > 0,
              range.length <= source.length - range.location else { return }
        UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: source.substring(with: range)]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
    }
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        [#selector(copy(_:)), #selector(select(_:)), #selector(selectAll(_:))].contains(action) && super.canPerformAction(action, withSender: sender)
    }
}

final class LocalPromptView: LocalTextView {
    override func cut(_ sender: Any?) {
        guard isEditable, let selection = selectedTextRange, !selection.isEmpty else { return }
        copy(sender); replace(selection, withText: "")
        delegate?.textViewDidChange?(self)
    }
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) { return isEditable }
        if action == #selector(cut(_:)) { return isEditable && selectedRange.length > 0 }
        return super.canPerformAction(action, withSender: sender)
    }
}
