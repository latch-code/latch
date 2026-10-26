import SwiftUI
import UIKit
import UniformTypeIdentifiers

/** Native selection stays in TextKit 2; no WebView, detectors, indexing or cloud clipboard is involved. */
struct ConversationText: UIViewRepresentable {
    let text: String
    var monospaced = false
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
        if view.text != text {
            let selected = view.selectedRange
            view.text = text
            if selected.location != NSNotFound, selected.location <= text.utf16.count,
               selected.length <= text.utf16.count - selected.location { view.selectedRange = selected }
        }
        let descriptor = UIFont.preferredFont(forTextStyle: .body).fontDescriptor
        view.font = monospaced ? UIFont(descriptor: descriptor.withDesign(.monospaced) ?? descriptor, size: 0) : UIFont(descriptor: descriptor, size: 0)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: LocalTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0, width.isFinite else { return nil }
        return uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    }
}

struct LocalTextEditor: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    var maximumLines: Int? = 6
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> LocalPromptView {
        let view = LocalPromptView(usingTextLayoutManager: true)
        view.isEditable = true; view.isSelectable = true; view.delegate = context.coordinator
        view.backgroundColor = .clear; view.textColor = .label; view.font = .preferredFont(forTextStyle: .body)
        view.textContainerInset = .zero; view.textContainer.lineFragmentPadding = 0
        view.textDragInteraction?.isEnabled = false; view.dataDetectorTypes = []; view.allowsEditingTextAttributes = false
        view.autocorrectionType = .no; view.spellCheckingType = .no; view.smartDashesType = .no; view.smartQuotesType = .no
        view.adjustsFontForContentSizeCategory = true
        if #available(iOS 18, *) { view.writingToolsBehavior = .none }
        return view
    }
    func updateUIView(_ view: LocalPromptView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
        view.accessibilityLabel = placeholder
        view.font = .preferredFont(forTextStyle: .body)
        view.isScrollEnabled = maximumLines == nil
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
