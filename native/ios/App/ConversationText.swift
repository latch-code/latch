import LatchNativeCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/**
 * Native selection stays in TextKit 2; no WebView, detectors, indexing or cloud clipboard is involved. Rich text comes
 * from `MarkdownView` with its links listed apart: a pressed link runs `onLink`, and its long-press preview, menu and
 * drag stay off, so nothing in a reply opens or leaves by itself.
 */
struct ConversationText: UIViewRepresentable {
    @Environment(\.replyCitation) private var replyCitation
    init(text: String = "", monospaced: Bool = false, size: CGFloat = 16, rich: NSAttributedString? = nil,
         links: [PhoneRichText.LinkTarget] = [], onLink: ((PhoneRichText.LinkTarget) -> Void)? = nil, wraps: Bool = true) {
        self.text = text; self.monospaced = monospaced; self.size = size; self.rich = rich; self.links = links; self.onLink = onLink; self.wraps = wraps
    }
    var text: String = ""
    var monospaced = false
    var size: CGFloat = 16
    /** Drawn as given instead of `text`; its `.link` values are `latch-link:<index>` into `links`. */
    var rich: NSAttributedString? = nil
    var links: [PhoneRichText.LinkTarget] = []
    var onLink: ((PhoneRichText.LinkTarget) -> Void)? = nil
    /** Off for code: the lines keep their width and the caller scrolls sideways. */
    var wraps = true
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> MarkdownTextView {
        let view = MarkdownTextView(usingTextLayoutManager: true)
        view.isEditable = false; view.isSelectable = true; view.isScrollEnabled = false
        view.textDragInteraction?.isEnabled = false
        view.backgroundColor = .clear; view.textColor = .label
        view.textContainerInset = .zero; view.textContainer.lineFragmentPadding = 0
        view.dataDetectorTypes = []; view.autocorrectionType = .no; view.spellCheckingType = .no
        view.smartDashesType = .no; view.smartQuotesType = .no
        view.adjustsFontForContentSizeCategory = true
        view.linkTextAttributes = [:]
        view.delegate = context.coordinator
        if #available(iOS 18, *) { view.writingToolsBehavior = .none }
        return view
    }
    func updateUIView(_ view: MarkdownTextView, context: Context) {
        let coordinator = context.coordinator, trait = context.environment.sizeCategory
        coordinator.links = links; coordinator.onLink = onLink; coordinator.citation = replyCitation
        if !wraps { view.textContainer.lineBreakMode = .byClipping; view.textContainer.widthTracksTextView = false; view.textContainer.size.width = .greatestFiniteMagnitude }
        if let rich {
            guard coordinator.shownRich.map({ !$0.isEqual(to: rich) }) ?? true || coordinator.category != trait else { return }
            coordinator.shownRich = rich; coordinator.shown = nil; coordinator.category = trait
            view.display(rich)
            return
        }
        guard coordinator.shown != text || coordinator.category != trait else { return }
        coordinator.shown = text; coordinator.shownRich = nil; coordinator.category = trait
        let scaled = UIFontMetrics(forTextStyle: .body).scaledValue(for: size)
        let font = monospaced ? UIFont.monospacedSystemFont(ofSize: scaled - 2, weight: .regular) : UIFont.systemFont(ofSize: scaled)
        view.display(NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: UIColor.label]))
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MarkdownTextView, context: Context) -> CGSize? {
        if !wraps {
            let size = uiView.attributedText.boundingRect(with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).size
            return CGSize(width: ceil(size.width) + 2, height: ceil(size.height))
        }
        guard let width = proposal.width, width > 0, width.isFinite else { return nil }
        return uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        var citation: ReplyCitation?
        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard let citation, let content = textView.attributedText, range.length > 0, NSMaxRange(range) <= content.length else { return nil }
            let words = content.sourceText(in: range)
            guard !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, words.utf16.count <= 4000 else { return nil }
            let block = content.sourceText(in: NSRange(location: 0, length: content.length))
            let offset = content.sourceText(in: NSRange(location: 0, length: range.location)).utf16.count
            let quote = UIAction(title: "引用这句话", image: UIImage(systemName: "quote.bubble")) { _ in citation.insert(words, block, offset) }
            return UIMenu(children: [quote] + suggestedActions)
        }
        var shown: String?
        var shownRich: NSAttributedString?
        var category: ContentSizeCategory?
        var links: [PhoneRichText.LinkTarget] = []
        var onLink: ((PhoneRichText.LinkTarget) -> Void)?
        private func target(_ item: UITextItem, in view: UITextView) -> PhoneRichText.LinkTarget? {
            let url: URL?
            if case let .link(link) = item.content { url = link }
            else {
                // UIKit can hit the attachment instead of its enclosing link when the file mark itself is pressed.
                let offset = item.range.location
                guard offset < view.attributedText.length,
                      view.attributedText.attribute(.inlineDecoration, at: offset, effectiveRange: nil) != nil else { return nil }
                url = view.attributedText.attribute(.link, at: offset, effectiveRange: nil) as? URL
            }
            guard let url, url.scheme == "latch-link", let index = Int(url.absoluteString.dropFirst(11)), links.indices.contains(index) else { return nil }
            return links[index]
        }
        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            guard let target = target(textItem, in: textView) else { return nil }
            if case .text = target { return nil }
            return UIAction { [weak self] _ in self?.onLink?(target) }
        }
        /** No preview, menu or share sheet for a link, and a long press does not open it either: only the press above. */
        func textView(_ textView: UITextView, menuConfigurationFor textItem: UITextItem, defaultMenu: UIMenu) -> UITextItem.MenuConfiguration? {
            target(textItem, in: textView) == nil ? nil : UITextItem.MenuConfiguration(menu: UIMenu(children: []))
        }
    }
}

struct PromptHint: View {
    let text: String
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 16
    var body: some View {
        Text(text).font(.system(size: size)).foregroundStyle(PhoneTheme.muted).lineLimit(1)
            .allowsHitTesting(false).accessibilityHidden(true)
    }
}

struct LocalTextEditor: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    var maximumLines: Int? = 6
    var minimumLines = 1
    var focused: Binding<Bool>? = nil
    var selection: Binding<NSRange>? = nil
    var composing: Binding<Bool>? = nil
    var selectionRequest: Binding<EditorSelectionRequest?>? = nil
    var commandKeys: [String] = []
    var onCommand: ((String) -> Void)? = nil
    var suffixHint: String? = nil
    var onPasteImages: (@MainActor ([NSItemProvider]) async -> Void)? = nil
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> LocalPromptView {
        let view = LocalPromptView(usingTextLayoutManager: true)
        view.isEditable = true; view.isSelectable = true; view.delegate = context.coordinator; view.pasteDelegate = context.coordinator
        view.isScrollEnabled = maximumLines == nil
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
        context.coordinator.applying = true
        defer { context.coordinator.applying = false }
        let coordinator = context.coordinator
        if view.isFirstResponder {
            // During a SwiftUI update the binding can still be a snapshot taken before UIKit's last edit.
            // Read the live binding after this render before replacing a focused editor's document or caret.
            if !(view.text ?? "").utf8.elementsEqual(text.utf8) || selectionRequest?.wrappedValue != nil { coordinator.queueSync(view) }
        } else {
            coordinator.sync(view)
        }
        view.completionKeys = commandKeys; view.completionCommand = onCommand
        view.configureImagePaste(onPasteImages != nil)
        if view.commandHint != suffixHint { view.commandHint = suffixHint; view.setNeedsLayout() }
        view.accessibilityHint = suffixHint
        view.accessibilityLabel = placeholder
        let font = Self.font
        if view.font != font { view.font = font }
        // A capped draft keeps its caret's scroll position across unrelated session updates.
        if maximumLines == nil { view.isScrollEnabled = true }
        if let focused, focused.wrappedValue != view.isFirstResponder, view.window != nil {
            // Changing the responder during a layout pass is refused, so it waits for the next turn.
            let wanted = focused.wrappedValue
            DispatchQueue.main.async { [weak view, weak coordinator = context.coordinator] in
                guard let view, view.window != nil, coordinator?.parent.focused?.wrappedValue == wanted else { return }
                if wanted { view.becomeFirstResponder() } else { view.resignFirstResponder() }
            }
        }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: LocalPromptView, context: Context) -> CGSize? {
        guard let maximumLines, let width = proposal.width, width > 0, width.isFinite else { return nil }
        let line = uiView.font?.lineHeight ?? 22, maximum = line * CGFloat(maximumLines)
        let size = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let scrolls = size.height > maximum
        if uiView.isScrollEnabled != scrolls { uiView.isScrollEnabled = scrolls }
        // The text view itself fills the visible editor, including the blank lines a person can tap.
        return CGSize(width: width, height: max(line * CGFloat(min(minimumLines, maximumLines)), min(maximum, size.height)))
    }
    final class Coordinator: NSObject, UITextViewDelegate, UITextPasteDelegate {
        var parent: LocalTextEditor
        private var pastedImages: [any UITextPasteItem] = []
        private var imagePasteTask: Task<Void, Never>?
        func textPasteConfigurationSupporting(_ supporting: any UITextPasteConfigurationSupporting, transform item: any UITextPasteItem) {
            guard let paste = parent.onPasteImages, item.itemProvider.hasItemConformingToTypeIdentifier(UTType.image.identifier) else {
                item.setDefaultResult(); return
            }
            let first = pastedImages.isEmpty
            pastedImages.append(item)
            if first {
                let previous = imagePasteTask
                imagePasteTask = Task { @MainActor in
                    let items = pastedImages
                    pastedImages.removeAll()
                    // UIKit may deliver more items while an earlier provider is still preparing its file.
                    await previous?.value
                    // Use the providers authorized for this gesture; keep them alive through the bounded file reads.
                    await paste(items.map { $0.itemProvider })
                    for image in items { image.setNoResult() }
                }
            }
        }
        var applying = false
        private var queued = false
        private var lastPublished: String
        init(_ parent: LocalTextEditor) { self.parent = parent; lastPublished = parent.text }
        func queueSync(_ view: LocalPromptView) {
            guard !queued else { return }
            queued = true
            DispatchQueue.main.async { [weak self, weak view] in
                guard let self else { return }
                queued = false
                guard let view, view.window != nil, view.delegate === self else { return }
                sync(view)
            }
        }
        func sync(_ view: LocalPromptView) {
            let previous = applying
            applying = true; defer { applying = previous }
            let before = view.selectedRange
            let native = view.text ?? "", wanted = parent.text
            // An unfinished composition can lead its last delegate notification. A real external draft still wins.
            if view.markedTextRange != nil, wanted.utf8.elementsEqual(lastPublished.utf8), !native.utf8.elementsEqual(wanted.utf8) { return }
            if !native.utf8.elementsEqual(wanted.utf8) {
                lastPublished = wanted
                view.text = wanted
                if parent.selection != nil { view.selectedRange = NSRange(location: wanted.utf16.count, length: 0) }
            }
            if let request = parent.selectionRequest?.wrappedValue, view.markedTextRange == nil {
                let count = wanted.utf16.count
                if request.text.utf8.elementsEqual(wanted.utf8), request.range.location <= count,
                   request.range.length <= count - request.range.location { view.selectedRange = request.range }
                DispatchQueue.main.async { [weak self] in
                    guard let self, parent.selectionRequest?.wrappedValue?.id == request.id else { return }
                    parent.selectionRequest?.wrappedValue = nil
                }
            }
            if before != view.selectedRange || parent.composing.map({ $0.wrappedValue != (view.markedTextRange != nil) }) == true {
                DispatchQueue.main.async { [weak self, weak view] in
                    guard let self, let view, view.window != nil else { return }
                    readSelection(view)
                }
            }
        }
        func textViewDidChange(_ textView: UITextView) {
            lastPublished = textView.text ?? ""; parent.text = lastPublished; readSelection(textView)
        }
        func textViewDidChangeSelection(_ textView: UITextView) { readSelection(textView) }
        func readSelection(_ textView: UITextView) {
            guard !applying else { return }
            if let selection = parent.selection, selection.wrappedValue != textView.selectedRange { selection.wrappedValue = textView.selectedRange }
            let marked = textView.markedTextRange != nil
            if let composing = parent.composing, composing.wrappedValue != marked { composing.wrappedValue = marked }
        }
        func textViewDidBeginEditing(_ textView: UITextView) { readSelection(textView); if parent.focused?.wrappedValue == false { parent.focused?.wrappedValue = true } }
        func textViewDidEndEditing(_ textView: UITextView) { readSelection(textView); if parent.focused?.wrappedValue == true { parent.focused?.wrappedValue = false } }
    }
}

private extension UITextInput {
    func copySelectedTextLocally() {
        guard let range = selectedTextRange, !range.isEmpty, let value = text(in: range) else { return }
        UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: value]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
    }
    func cutSelectedTextLocally() -> Bool {
        guard let range = selectedTextRange, !range.isEmpty else { return false }
        copySelectedTextLocally(); replace(range, withText: "")
        return true
    }
}

class LocalTextView: UITextView {
    override func copy(_ sender: Any?) { copySelectedTextLocally() }
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        [#selector(copy(_:)), #selector(select(_:)), #selector(selectAll(_:))].contains(action) && super.canPerformAction(action, withSender: sender)
    }
}

final class LocalPromptView: LocalTextView {
    var completionKeys: [String] = []
    var completionCommand: ((String) -> Void)?
    var commandHint: String?
    private var takesImagePaste = false
    private var originalPasteConfiguration: UIPasteConfiguration?
    func configureImagePaste(_ enabled: Bool) {
        guard enabled != takesImagePaste else { return }
        takesImagePaste = enabled
        if enabled {
            originalPasteConfiguration = pasteConfiguration
            // UIKit's implicit configuration for a plain UITextView accepts NSString-readable content.
            let configuration = (pasteConfiguration?.copy() as? UIPasteConfiguration) ?? UIPasteConfiguration(forAccepting: NSString.self)
            configuration.addAcceptableTypeIdentifiers([UTType.image.identifier])
            pasteConfiguration = configuration
        } else {
            pasteConfiguration = originalPasteConfiguration
            originalPasteConfiguration = nil
        }
    }
    private var hintLabel: UILabel?
    override func layoutSubviews() {
        super.layoutSubviews()
        guard let commandHint, markedTextRange == nil, let range = selectedTextRange, range.isEmpty else { hintLabel?.isHidden = true; return }
        let label: UILabel
        if let hintLabel { label = hintLabel }
        else {
            label = UILabel(); label.isUserInteractionEnabled = false; label.isAccessibilityElement = false
            label.textColor = .placeholderText; label.lineBreakMode = .byTruncatingTail
            addSubview(label); hintLabel = label
        }
        let caret = caretRect(for: range.end), width = max(0, bounds.width - caret.maxX - 4)
        label.text = commandHint; label.font = font; label.isHidden = width < 12
        label.frame = CGRect(x: caret.maxX + 4, y: caret.minY, width: width, height: caret.height)
    }
    override var keyCommands: [UIKeyCommand]? {
        guard isFirstResponder, window != nil, markedTextRange == nil, completionCommand != nil else { return super.keyCommands }
        let own = completionKeys.map { key in
            let command = UIKeyCommand(input: key == "submit" ? "\r" : key,
                modifierFlags: key == "submit" ? .command : [], action: #selector(runCompletion(_:)))
            command.wantsPriorityOverSystemBehavior = true
            return command
        }
        return own + (super.keyCommands ?? [])
    }
    @objc private func runCompletion(_ command: UIKeyCommand) {
        guard isFirstResponder, window != nil, markedTextRange == nil, let input = command.input else { return }
        completionCommand?(command.modifierFlags.contains(.command) ? "submit" : input)
    }
    override func cut(_ sender: Any?) {
        guard isEditable, cutSelectedTextLocally() else { return }
        delegate?.textViewDidChange?(self)
    }
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) { return isEditable }
        if action == #selector(cut(_:)) { return isEditable && selectedRange.length > 0 }
        return super.canPerformAction(action, withSender: sender)
    }
}

/** A native single-line search input. The visible composition belongs to UIKit until the IME commits it. */
struct LocalSearchInput: UIViewRepresentable {
    @Binding var query: String
    let prompt: String
    let identifier: String

    func makeCoordinator() -> Coordinator { Coordinator(query: $query) }
    func makeUIView(context: Context) -> LocalField {
        let field = LocalField()
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        field.text = query; field.returnKeyType = .search; field.clearButtonMode = .always
        field.autocorrectionType = .no; field.autocapitalizationType = .none; field.spellCheckingType = .no
        field.smartDashesType = .no; field.smartQuotesType = .no
        field.textDragInteraction?.isEnabled = false
        if #available(iOS 18, *) { field.writingToolsBehavior = .none }
        field.font = .preferredFont(forTextStyle: .subheadline); field.adjustsFontForContentSizeCategory = true
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }
    func updateUIView(_ field: LocalField, context: Context) {
        let coordinator = context.coordinator
        coordinator.query = $query
        // External changes (clearing or changing computer) supersede even an uncommitted composition.
        if !coordinator.committed.utf8.elementsEqual(query.utf8) {
            coordinator.committed = query; field.text = query
        }
        field.placeholder = prompt; field.accessibilityLabel = prompt; field.accessibilityIdentifier = identifier
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: LocalField, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        return CGSize(width: width, height: max(44, uiView.intrinsicContentSize.height))
    }
    static func dismantleUIView(_ field: LocalField, coordinator: Coordinator) {
        field.delegate = nil
        field.removeTarget(coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        field.text = nil
    }
    final class Coordinator: NSObject, UITextFieldDelegate {
        var query: Binding<String>
        var committed: String
        init(query: Binding<String>) { self.query = query; committed = query.wrappedValue }

        @objc func changed(_ field: UITextField) {
            guard field.markedTextRange == nil else { return }
            let value = field.text ?? ""
            guard !value.utf8.elementsEqual(committed.utf8) else { return }
            committed = value; query.wrappedValue = value
        }
        func textFieldDidEndEditing(_ field: UITextField) { changed(field) }
        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            guard field.markedTextRange == nil else { return true }
            changed(field); field.resignFirstResponder(); return false
        }
    }
    final class LocalField: UITextField {
        override func copy(_ sender: Any?) { copySelectedTextLocally() }
        override func cut(_ sender: Any?) { if cutSelectedTextLocally() { sendActions(for: .editingChanged) } }
        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            [#selector(copy(_:)), #selector(cut(_:)), #selector(paste(_:)), #selector(select(_:)), #selector(selectAll(_:))].contains(action)
                && super.canPerformAction(action, withSender: sender)
        }
    }
}
