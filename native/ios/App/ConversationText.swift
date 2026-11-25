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
            let quote = UIAction(title: "引用这句话", image: UIImage(systemName: "quote.bubble")) { [weak textView] _ in
                citation.insert(words, block, offset)
                if textView?.selectedRange == range { textView?.selectedTextRange = nil }
            }
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
    @Environment(\.agentPickerKeys) var agentPicker
    @Binding var text: String
    let placeholder: String
    var maximumLines: Int? = 6
    var minimumLines = 1
    var focused: Binding<Bool>? = nil
    var selection: Binding<NSRange>? = nil
    var composing: Binding<Bool>? = nil
    var selectionRequest: Binding<EditorSelectionRequest?>? = nil
    var mentionMarkers: [PromptMentionChip] = []
    var commandKeys: [String] = []
    var onCommand: ((String) -> Void)? = nil
    var suffixHint: String? = nil
    var onPasteImages: (@MainActor ([NSItemProvider]) async -> Void)? = nil
    var referenceDraft: Binding<String>? = nil
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> LocalPromptView {
        let view = LocalPromptView(frame: .zero, textContainer: nil)
        view.isEditable = true; view.isSelectable = true; view.delegate = context.coordinator; view.pasteDelegate = context.coordinator
        view.usesReferenceHistory = referenceDraft != nil
        view.registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitPreferredContentSizeCategory.self]) { (view: LocalPromptView, _) in
            view.setNeedsLayout()
        }
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
        view.usesReferenceHistory = referenceDraft != nil
        let coordinator = context.coordinator
        if view.isFirstResponder {
            // During a SwiftUI update the binding can still be a snapshot taken before UIKit's last edit.
            // Read the live binding after this render before replacing a focused editor's document or caret.
            let wireChanged = referenceDraft.map { draft in
                coordinator.shownWire?.utf8.elementsEqual(draft.wrappedValue.utf8) != true
            } ?? (coordinator.shownWire != nil)
            if !view.draft.source.utf8.elementsEqual(text.utf8) || wireChanged
                || selectionRequest?.wrappedValue != nil || !mentionMarkers.isEmpty || view.hasMentionChips { coordinator.queueSync(view) }
        } else {
            coordinator.sync(view)
        }
        view.addressingAgent = !agentPicker.keys.isEmpty
        view.completionKeys = agentPicker.keys.isEmpty ? commandKeys : agentPicker.keys
        view.completionCommand = agentPicker.keys.isEmpty ? onCommand : agentPicker.select
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
        private(set) var shownWire: String?
        private var references: PhoneInputReferences?
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
            let document = view.draft, wanted = parent.text
            let native = document.source
            // An unfinished composition can lead its last delegate notification. A real external draft still wins.
            if view.markedTextRange != nil, wanted.utf8.elementsEqual(lastPublished.utf8), !native.utf8.elementsEqual(wanted.utf8) { return }
            let request = parent.selectionRequest?.wrappedValue
            let changed = !native.utf8.elementsEqual(wanted.utf8)
            let completing = request?.text.utf8.elementsEqual(wanted.utf8) == true
            let offsets: PhoneMentionOffsets
            if let wire = parent.referenceDraft?.wrappedValue {
                if !wire.utf8.elementsEqual((shownWire ?? "").utf8) || shownWire == nil {
                    // A completed picker edit is reversible. A different draft cannot reuse this session's undo history.
                    if completing, let previous = shownWire {
                        registerUndo(in: view, from: wire, to: previous, caret: document.offsets.sourceRange(for: before))
                    } else { view.undoManager?.removeAllActions() }
                }
                offsets = install(wire, in: view, selection: !changed ? document.offsets.sourceRange(for: before) : nil)
            } else {
                if changed { lastPublished = wanted }
                offsets = view.displayDraft(wanted, chips: parent.mentionMarkers, document: document, changed: changed, completing: completing)
            }
            if let request, view.markedTextRange == nil {
                let count = wanted.utf16.count
                if request.text.utf8.elementsEqual(wanted.utf8), request.range.location <= count,
                   request.range.length <= count - request.range.location { view.selectedRange = offsets.displayRange(for: request.range) }
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
            guard !applying, let view = textView as? LocalPromptView else { return }
            let draft = view.draft
            if let binding = parent.referenceDraft, let shownWire {
                guard binding.wrappedValue.utf8.elementsEqual(shownWire.utf8) else { sync(view); return }
                let selected = draft.offsets.sourceRange(for: view.selectedRange)
                let wire = view.sourceText(draft: draft)
                binding.wrappedValue = wire
                guard binding.wrappedValue.utf8.elementsEqual(wire.utf8) else { sync(view); return }
                if view.markedTextRange != nil {
                    let document = PhoneInputReferences(wire, collapseQuotes: true)
                    self.shownWire = wire; references = document; lastPublished = document.display
                } else { install(wire, in: view, selection: selected) }
            } else { lastPublished = draft.source; parent.text = lastPublished }
            readSelection(view)
        }
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard let view = textView as? LocalPromptView, let binding = parent.referenceDraft, let shownWire else { return true }
            guard binding.wrappedValue.utf8.elementsEqual(shownWire.utf8) else { sync(view); return false }
            return view.replaceAtoms?(range, text) != true
        }
        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard let view = textView as? LocalPromptView, let references,
                  let quote = references.quotes.first(where: { $0.isTerminalBlock && $0.range == view.draft.offsets.sourceRange(for: range) }) else { return nil }
            let remove = UIAction(title: "移除终端引用", image: UIImage(systemName: "xmark")) { [weak view] _ in
                view?.removeTerminal?(quote)
            }
            return UIMenu(children: [remove] + suggestedActions)
        }
        private func registerUndo(in view: LocalPromptView, from old: String, to new: String, caret: NSRange) {
            view.undoManager?.registerUndo(withTarget: self) { [weak view] coordinator in
                guard let view else { return }
                coordinator.replaceSource(in: view, from: old, to: new, caret: caret)
            }
        }
        /** UIKit's plain-text undo for a deletion may return only an object character. Keep the wire for this edit. */
        private func replaceSource(in view: LocalPromptView, from old: String, to new: String, caret: NSRange) {
            guard let binding = parent.referenceDraft, binding.wrappedValue.utf8.elementsEqual(old.utf8) else { return }
            registerUndo(in: view, from: new, to: old, caret: view.draft.offsets.sourceRange(for: view.selectedRange))
            binding.wrappedValue = new
            guard binding.wrappedValue.utf8.elementsEqual(new.utf8) else { sync(view); return }
            install(new, in: view, selection: caret)
            readSelection(view)
        }
        /** Text commands and mention search use the quote-collapsed draft; UIKit also collapses each selected @ marker. */
        @discardableResult private func install(_ wire: String, in view: LocalPromptView, selection: NSRange?) -> PhoneMentionOffsets {
            let document = PhoneInputReferences(wire, collapseQuotes: true)
            let old = applying
            applying = true; defer { applying = old }
            references = document; shownWire = wire; lastPublished = document.display
            view.canCopySource = { [weak self] in
                guard let self, let binding = parent.referenceDraft, let shownWire else { return false }
                return binding.wrappedValue.utf8.elementsEqual(shownWire.utf8)
            }
            view.replaceAtoms = { [weak self, weak view] range, text in
                guard let self, let view, view.isEditable, !view.settingMarkedText, view.markedTextRange == nil,
                      view.undoManager?.isUndoing != true, view.undoManager?.isRedoing != true,
                      let wire = self.shownWire, let current = self.references else { return false }
                let offsets = view.draft.offsets, sourceRange = offsets.sourceRange(for: range)
                let crossesChip = current.quotes.contains { NSIntersectionRange(sourceRange, $0.range).length > 0 }
                    || offsets.ranges.contains { NSIntersectionRange(sourceRange, $0).length > 0 }
                guard crossesChip, let next = current.replacing(sourceRange, with: text) else { return false }
                replaceSource(in: view, from: wire, to: next, caret: NSRange(location: sourceRange.location + text.utf16.count, length: 0))
                return true
            }
            view.removeTerminal = { [weak self, weak view] quote in
                guard let self, let view, view.isEditable, view.markedTextRange == nil, let wire = self.shownWire, let current = self.references,
                      current.quotes.contains(where: { $0.range == quote.range && $0.wire == quote.wire && $0.isTerminalBlock }),
                      let next = current.replacing(quote.range, with: "") else { return }
                let selected = view.draft.offsets.sourceRange(for: view.selectedRange)
                func after(_ offset: Int) -> Int { offset > quote.range.location ? offset - 1 : offset }
                let start = after(selected.location)
                replaceSource(in: view, from: wire, to: next, caret: NSRange(location: start, length: after(NSMaxRange(selected)) - start))
            }
            let draft = view.draft
            let matches: [PromptMentionDocument.Match]? = document.quotes.isEmpty ? nil : PromptMentionDocument.matches(parent.mentionMarkers, in: wire).compactMap { match in
                document.displayRange(forWire: match.range).map { PromptMentionDocument.Match(range: $0, chip: match.chip) }
            }
            let offsets = view.displayDraft(document.display, chips: parent.mentionMarkers, document: draft,
                changed: !document.display.utf8.elementsEqual(draft.source.utf8), completing: false, sourceMatches: matches)
            view.displaySources(document, offsets: offsets)
            let count = document.display.utf16.count, start = min(selection?.location ?? count, count)
            let caret = offsets.displayRange(for: NSRange(location: start, length: min(selection?.length ?? 0, count - start)))
            if view.selectedRange != caret { view.selectedRange = caret }
            return offsets
        }
        func textViewDidChangeSelection(_ textView: UITextView) { readSelection(textView) }
        func readSelection(_ textView: UITextView) {
            guard !applying else { return }
            if let selection = parent.selection, let view = textView as? LocalPromptView, view.selectedRange.location != NSNotFound {
                let source = view.draft.offsets.sourceRange(for: view.selectedRange)
                if selection.wrappedValue != source { selection.wrappedValue = source }
            }
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

private extension PhoneInputReferences.Quote {
    var isTerminalBlock: Bool { kind == .hook || kind == .terminal }
}

final class PromptSourceAttachment: NSTextAttachment {
    let source: PhoneInputReferences.Quote
    @MainActor init(_ quote: PhoneInputReferences.Quote, font: UIFont, width: CGFloat, traits: UITraitCollection) {
        source = quote
        super.init(data: nil, ofType: nil)
        let color = UIColor.link.resolvedColor(with: traits)
        let readable = PhoneConversation.visible(quote.text)
        if quote.isTerminalBlock {
            let preview = Self.terminalImage(title: PhoneConversation.visible(quote.title), body: readable, width: width, font: font, traits: traits)
            image = preview
            bounds = CGRect(origin: CGPoint(x: 0, y: font.descender), size: preview.size)
            accessibilityLabel = PhoneConversation.visible(quote.title) + "\n" + readable
            return
        }
        if quote.kind == .reply {
            let chip = Self.replyImage(readable, font: font, width: width, traits: traits)
            image = chip
            bounds = CGRect(x: 0, y: font.descender - 2 * font.pointSize / 16, width: chip.size.width, height: chip.size.height)
            accessibilityLabel = readable
            return
        }
        let glyph = quote.kind == .conversation ? "bubble.left.and.bubble.right" : "arrowshape.turn.up.left"
        let label = readable.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ") as NSString
        let textFont = UIFont.systemFont(ofSize: font.pointSize * 0.88, weight: .medium)
        let format = NSMutableParagraphStyle(); format.lineBreakMode = .byTruncatingTail
        let attributes: [NSAttributedString.Key: Any] = [.font: textFont, .foregroundColor: color, .paragraphStyle: format]
        let inset = ceil(font.pointSize * 0.3), side = ceil(textFont.pointSize), gap = ceil(inset / 1.5)
        let height = ceil(textFont.lineHeight + 2)
        let size = CGSize(width: min(max(1, width), ceil(label.size(withAttributes: attributes).width) + inset * 2 + side + gap), height: height)
        image = UIGraphicsImageRenderer(size: size).image { _ in
            color.withAlphaComponent(0.12).setFill()
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: inset).fill()
            let symbol = UIImage(systemName: glyph, withConfiguration: UIImage.SymbolConfiguration(pointSize: side, weight: .medium))
            symbol?.withTintColor(color, renderingMode: .alwaysOriginal)
                .draw(in: CGRect(x: inset, y: (height - side) / 2, width: side, height: side))
            let x = inset + side + gap
            label.draw(with: CGRect(x: x, y: (height - textFont.lineHeight) / 2, width: max(0, size.width - x - inset), height: textFont.lineHeight),
                       options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attributes, context: nil)
        }
        bounds = CGRect(x: 0, y: font.descender, width: size.width, height: height)
        accessibilityLabel = readable
    }
    /** Match the desktop .prompt-chip. Gutters live in the image so selection and deletion still cover one character. */
    @MainActor private static func replyImage(_ text: String, font: UIFont, width: CGFloat, traits: UITraitCollection) -> UIImage {
        let scale = font.pointSize / 16
        let label = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ") as NSString
        let style = NSMutableParagraphStyle(); style.lineBreakMode = .byTruncatingTail
        let ink = PhoneTheme.contentPathInk.resolvedColor(with: traits)
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink, .paragraphStyle: style]
        let iconSide = 14 * scale, leading = 4 * scale, gap = 4 * scale, trailing = 6 * scale
        let gutter = min(4 * scale, max(0, width - 1) / 2)
        let labelWidth = min(ceil(label.size(withAttributes: attributes).width), 28 * ("0" as NSString).size(withAttributes: attributes).width)
        let chipWidth = min(leading + iconSide + gap + labelWidth + trailing, max(1, width - 2 * gutter))
        let chip = CGRect(x: gutter, y: 2 * scale, width: chipWidth, height: max(font.lineHeight, 20 * scale))
        let size = CGSize(width: chipWidth + 2 * gutter, height: chip.height + 2 * chip.minY)
        return UIGraphicsImageRenderer(size: size).image { _ in
            PhoneTheme.contentChipWash.resolvedColor(with: traits).setFill()
            UIBezierPath(roundedRect: chip, cornerRadius: 6 * scale).fill()
            let icon = CGRect(x: chip.minX + leading, y: chip.midY - iconSide / 2 + scale, width: iconSide, height: iconSide)
            UIImage(named: "ReplyQuote")?.withTintColor(ink, renderingMode: .alwaysOriginal).draw(in: icon)
            let x = icon.maxX + gap
            label.draw(with: CGRect(x: x, y: chip.midY - font.lineHeight / 2, width: max(0, chip.maxX - trailing - x), height: font.lineHeight),
                       options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attributes, context: nil)
        }
    }
    @MainActor private static func terminalImage(title: String, body: String, width: CGFloat, font: UIFont, traits: UITraitCollection) -> UIImage {
        let mono = UIFont.monospacedSystemFont(ofSize: font.pointSize * 0.82, weight: .regular)
        let heading = UIFont.systemFont(ofSize: mono.pointSize, weight: .semibold)
        let pad = max(5, ceil(mono.pointSize / 2)), headerHeight = max(30, ceil(heading.lineHeight + pad))
        let line = ceil(mono.lineHeight)
        let textWidth = max(1, width - pad * 2)
        let ink = UIColor.label.resolvedColor(with: traits), secondary = UIColor.secondaryLabel.resolvedColor(with: traits)
        let format = NSMutableParagraphStyle(); format.lineBreakMode = .byTruncatingTail
        let headerStyle: [NSAttributedString.Key: Any] = [.font: heading, .foregroundColor: secondary, .paragraphStyle: format]
        let style: [NSAttributedString.Key: Any] = [.font: mono, .foregroundColor: ink]
        let measured = (body as NSString).boundingRect(with: CGSize(width: textWidth, height: line * 3), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: style, context: nil)
        let height = max(line, min(line * 3, ceil(measured.height)))
        let size = CGSize(width: max(1, width), height: headerHeight + height + pad)
        return UIGraphicsImageRenderer(size: size).image { _ in
            UIColor.secondarySystemFill.resolvedColor(with: traits).setFill()
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: pad).fill()
            let icon = UIImage(systemName: "terminal", withConfiguration: UIImage.SymbolConfiguration(pointSize: heading.pointSize))
            let h = heading.pointSize, x = pad + h + pad
            icon?.withTintColor(secondary, renderingMode: .alwaysOriginal).draw(in: CGRect(x: pad, y: (headerHeight - h) / 2, width: h, height: h))
            (title as NSString).draw(in: CGRect(x: x, y: (headerHeight - heading.lineHeight) / 2, width: max(0, width - x - 44), height: heading.lineHeight), withAttributes: headerStyle)
            (body as NSString).draw(with: CGRect(x: pad, y: headerHeight, width: textWidth, height: height),
                                    options: [.usesLineFragmentOrigin, .usesFontLeading, .truncatesLastVisibleLine], attributes: style, context: nil)
        }
    }
    required init?(coder: NSCoder) { nil }
}

final class LocalPromptView: LocalTextView {
    // UITextView's Objective-C convenience initializer may bypass Swift subclass storage initialization.
    // Its designated initializer with a nil text container uses TextKit 2 on our supported iOS versions.
    private var readyForLayout = false
    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        readyForLayout = true
    }
    required init?(coder: NSCoder) { nil }
    private let referenceHistory = UndoManager()
    var usesReferenceHistory = false {
        didSet { if oldValue && !usesReferenceHistory { referenceHistory.removeAllActions(); references = nil } }
    }
    override var undoManager: UndoManager? { usesReferenceHistory ? referenceHistory : super.undoManager }
    private(set) var settingMarkedText = false
    override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        settingMarkedText = true; defer { settingMarkedText = false }
        super.setMarkedText(markedText, selectedRange: selectedRange)
    }
    var canCopySource: (() -> Bool)?
    var replaceAtoms: ((NSRange, String) -> Bool)?
    var removeTerminal: ((PhoneInputReferences.Quote) -> Void)?
    private var terminalButtons: [Int: (wire: String, button: UIButton)] = [:]
    private var references: PhoneInputReferences?
    private var renderedWidth: CGFloat = 0
    private var renderedFont: UIFont?
    private var renderedStyle: UIUserInterfaceStyle?
    private var marking = false

    var draft: PromptMentionDocument { PromptMentionDocument(storage: textStorage) }
    private(set) var hasMentionChips = false
    override var accessibilityValue: String? {
        get { usesReferenceHistory && canCopySource?() == false ? nil : hasMentionChips || references?.quotes.isEmpty == false ? readableText(in: NSRange(location: 0, length: textStorage.length)) : super.accessibilityValue }
        set { super.accessibilityValue = newValue }
    }
    private var shownChips: [PromptMentionChip] = []
    private var chipWidth: CGFloat = 0
    private var chipStyle: UIUserInterfaceStyle = .unspecified
    private var chipFont: UIFont?

    func displayDraft(_ source: String, chips: [PromptMentionChip], document: PromptMentionDocument,
                      changed: Bool, completing: Bool, sourceMatches: [PromptMentionDocument.Match]? = nil) -> PhoneMentionOffsets {
        if markedTextRange != nil, !changed { return document.offsets }
        let matches = sourceMatches ?? PromptMentionDocument.matches(chips, in: source)
        let offsets = PhoneMentionOffsets(markers: matches.map(\.range), in: source)
        let font = font ?? .preferredFont(forTextStyle: .body)
        let width = max(36, bounds.width - textContainerInset.left - textContainerInset.right)
        let style = traitCollection.userInterfaceStyle
        let visuals = matches.map(\.chip)
        let appearanceChanged = !matches.isEmpty && (width != chipWidth || style != chipStyle || font != chipFont)
        let projectionChanged = offsets != document.offsets
        guard changed || projectionChanged || appearanceChanged || visuals != shownChips else { return offsets }
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.label]
        let rich = NSMutableAttributedString(string: source, attributes: attributes)
        for (match, span) in zip(matches, offsets.ranges).reversed() {
            let attachment = match.chip.attachment(font: font, traits: traitCollection, maxWidth: width)
            let piece = NSMutableAttributedString(attributedString: NSAttributedString(attachment: attachment))
            piece.addAttributes([.font: font, PromptMentionDocument.marker: match.chip.marker], range: NSRange(location: 0, length: 1))
            if NSMaxRange(span) > NSMaxRange(match.range) {
                piece.addAttribute(PromptMentionDocument.trailingDelimiter, value: true, range: NSRange(location: 0, length: 1))
            }
            rich.replaceCharacters(in: span, with: piece)
        }
        let oldSelection = selectedRange.location == NSNotFound ? NSRange(location: 0, length: 0) : selectedRange
        let caret = changed ? NSRange(location: source.utf16.count, length: 0) : document.offsets.sourceRange(for: oldSelection)
        shownChips = visuals; hasMentionChips = !matches.isEmpty; chipWidth = width; chipStyle = style; chipFont = font
        if !usesReferenceHistory, isFirstResponder, completing || (!changed && projectionChanged),
           let all = textRange(from: beginningOfDocument, to: endOfDocument) {
            // Use a native edit for an accepted completion so Undo restores the text the person was typing.
            replace(all, withAttributedText: rich)
        } else {
            textStorage.setAttributedString(rich)
        }
        selectedRange = offsets.displayRange(for: caret)
        typingAttributes = attributes
        return offsets
    }

    private var sourceOffsets = PhoneMentionOffsets(ranges: [])
    func displaySources(_ document: PhoneInputReferences, offsets: PhoneMentionOffsets) {
        guard markedTextRange == nil else { return }
        let previous = references, oldOffsets = sourceOffsets
        references = document; sourceOffsets = offsets
        let expected = Set(document.quotes.map { offsets.displayRange(for: $0.range).location })
        for quote in previous?.quotes ?? [] {
            let at = oldOffsets.displayRange(for: quote.range).location
            if at < textStorage.length, !expected.contains(at), textStorage.attribute(.attachment, at: at, effectiveRange: nil) is PromptSourceAttachment {
                textStorage.removeAttribute(.attachment, range: NSRange(location: at, length: 1))
            }
        }
        drawReferences(force: false)
    }
    /** Re-expand mention chips before translating the live positions of the remaining source attachments. */
    private func sources(in storage: NSAttributedString, offsets: PhoneMentionOffsets) -> [PhoneInputReferences.Quote] {
        var result: [PhoneInputReferences.Quote] = []
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            if let source = value as? PromptSourceAttachment { result.append(source.source.at(offsets.sourceRange(for: range))) }
        }
        return result
    }
    func sourceText(draft: PromptMentionDocument) -> String {
        PhoneInputReferences.wireText(draft.source, quotes: sources(in: textStorage, offsets: draft.offsets))
    }
    func readableText(in range: NSRange) -> String? {
        guard range.location != NSNotFound, NSMaxRange(range) <= textStorage.length else { return nil }
        let selection = textStorage.attributedSubstring(from: range)
        let document = PromptMentionDocument(storage: selection, copying: true)
        let result = NSMutableString(string: document.source)
        for quote in sources(in: selection, offsets: document.offsets).reversed() where quote.range.length == 1 {
            result.replaceCharacters(in: quote.range, with: quote.text)
        }
        return result as String
    }
    private func drawReferences(force: Bool) {
        guard !marking, let references, markedTextRange == nil else { return }
        let textFont = font ?? UIFont.preferredFont(forTextStyle: .body)
        let width = max(1, bounds.width - textContainerInset.left - textContainerInset.right - textContainer.lineFragmentPadding * 2)
        let changed = width != renderedWidth || textFont != renderedFont || renderedStyle != traitCollection.userInterfaceStyle
        if force && !changed { return }
        marking = true; defer { marking = false }
        renderedWidth = width; renderedFont = textFont; renderedStyle = traitCollection.userInterfaceStyle
        for quote in references.quotes {
            let at = sourceOffsets.displayRange(for: quote.range)
            guard at.length == 1, at.location < textStorage.length, (textStorage.string as NSString).character(at: at.location) == 0xfffc else { continue }
            let existing = textStorage.attribute(.attachment, at: at.location, effectiveRange: nil) as? PromptSourceAttachment
            if changed || existing?.source.wire.utf8.elementsEqual(quote.wire.utf8) != true {
                let attachment = PromptSourceAttachment(quote, font: textFont, width: width, traits: traitCollection)
                textStorage.addAttribute(.attachment, value: attachment, range: at)
            }
        }
        if typingAttributes[.attachment] != nil {
            typingAttributes.removeValue(forKey: .attachment)
        }
    }
    override func copy(_ sender: Any?) {
        guard canCopySource?() != false, selectedRange.length > 0, let value = readableText(in: selectedRange) else { return }
        LocalClipboard.copy(value)
    }
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
        guard readyForLayout else { return }
        drawReferences(force: true)
        layoutTerminalButtons()
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
    /** The attachment stays one text character. The close target is a native control in the same scroll coordinates. */
    private func layoutTerminalButtons() {
        let visible = usesReferenceHistory && isEditable && markedTextRange == nil ? references?.quotes.filter(\.isTerminalBlock) ?? [] : []
        var leftover = terminalButtons
        for quote in visible {
            let offset = sourceOffsets.displayRange(for: quote.range).location
            guard offset < textStorage.length, let attachment = textStorage.attribute(.attachment, at: offset, effectiveRange: nil) as? PromptSourceAttachment,
                  attachment.source.wire == quote.wire,
                  let start = position(from: beginningOfDocument, offset: offset), let end = position(from: start, offset: 1),
                  let range = textRange(from: start, to: end) else { continue }
            let rect = firstRect(for: range)
            guard !rect.isNull, rect.width > 0, rect.height > 0 else { continue }
            let previous = leftover.removeValue(forKey: offset)
            let button: UIButton
            if let previous, previous.wire == quote.wire { button = previous.button }
            else {
                previous?.button.removeFromSuperview()
                button = UIButton(type: .system)
                button.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(textStyle: .caption1)), for: .normal)
                button.accessibilityLabel = "移除终端引用"
                button.accessibilityIdentifier = "remove-terminal-reference"
                button.tintColor = .secondaryLabel
                button.accessibilityHint = PhoneConversation.visible(quote.title)
                button.addAction(UIAction { [weak self] _ in
                    guard let self, let current = references?.quotes.first(where: {
                        $0.isTerminalBlock && sourceOffsets.displayRange(for: $0.range).location == offset && $0.wire.utf8.elementsEqual(quote.wire.utf8)
                    }) else { return }
                    removeTerminal?(current)
                }, for: .touchUpInside)
                addSubview(button)
                terminalButtons[offset] = (quote.wire, button)
            }
            button.frame = CGRect(x: rect.minX + attachment.bounds.width - 44, y: rect.minY, width: 44, height: min(44, rect.height)).integral
        }
        for (offset, item) in leftover { item.button.removeFromSuperview(); terminalButtons.removeValue(forKey: offset) }
    }
    var addressingAgent = false
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if addressingAgent, isFirstResponder, markedTextRange == nil, presses.count == 1, let key = presses.first?.key,
           key.modifierFlags.intersection([.command, .control, .alternate, .shift]).isEmpty {
            let word: String? = switch key.keyCode {
            case .keyboardUpArrow: UIKeyCommand.inputUpArrow
            case .keyboardDownArrow: UIKeyCommand.inputDownArrow
            case .keyboardEscape: UIKeyCommand.inputEscape
            case .keyboardTab: "\t"
            case .keyboardReturnOrEnter: "\r"
            default: nil
            }
            if let word, completionKeys.contains(word) { completionCommand?(word); return }
        }
        super.pressesBegan(presses, with: event)
    }
    override var keyCommands: [UIKeyCommand]? {
        guard isFirstResponder, window != nil, markedTextRange == nil, completionCommand != nil else { return super.keyCommands }
        let own = completionKeys.map { key in
            let modifiers: UIKeyModifierFlags = key == "submit" ? .command : key == "alternateSubmit" ? [.command, .shift] : []
            let command = UIKeyCommand(input: modifiers.isEmpty ? key : "\r", modifierFlags: modifiers, action: #selector(runCompletion(_:)))
            command.wantsPriorityOverSystemBehavior = true
            return command
        }
        return own + (super.keyCommands ?? [])
    }
    @objc private func runCompletion(_ command: UIKeyCommand) {
        guard isFirstResponder, window != nil, markedTextRange == nil, let input = command.input else { return }
        let key = command.modifierFlags == [.command, .shift] ? "alternateSubmit" : command.modifierFlags == .command ? "submit" : input
        guard completionKeys.contains(key) else { return }
        completionCommand?(key)
    }
    override func cut(_ sender: Any?) {
        guard isEditable, canCopySource?() != false, let range = selectedTextRange, !range.isEmpty else { return }
        copy(sender)
        if usesReferenceHistory { deleteBackward(); return }
        replace(range, withText: "")
        delegate?.textViewDidChange?(self)
    }
    override func deleteBackward() {
        if usesReferenceHistory, let replaceAtoms {
            var range = selectedRange
            if range.length == 0, range.location > 0, range.location <= textStorage.length {
                range = NSRange(location: range.location - 1, length: 1)
            }
            if range.length > 0, replaceAtoms(range, "") { return }
        }
        super.deleteBackward()
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
