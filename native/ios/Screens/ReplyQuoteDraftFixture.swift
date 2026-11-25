#if LATCH_SCREENS && targetEnvironment(simulator)
import Foundation
import SwiftUI
import LatchNativeCore
import UIKit

/** Exercises the conversation's mounted text view, including the binding that preserves the wire draft. */
@MainActor enum ReplyQuoteDraftFixture {
    @MainActor private final class MixedDraft: ObservableObject {
        @Published var wire: String
        init(_ wire: String) { self.wire = wire }
    }
    private struct MixedEditor: View {
        @ObservedObject var draft: MixedDraft
        let markers: [PromptMentionChip]
        var body: some View {
            let display = Binding(get: { PhoneInputReferences(draft.wire, collapseQuotes: true).display },
                set: { draft.wire = PhoneInputReferences(draft.wire, collapseQuotes: true).restore($0) })
            LocalTextEditor(text: display, placeholder: "草稿", mentionMarkers: markers, referenceDraft: $draft.wire)
        }
    }
    private static func mixedEditor(in window: UIWindow) async -> Bool {
        let member = "@Pat", file = "@default:docs/spec.md"
        let citation = "[引用回复 ses_review/m2@0]\n> Pat said @Pat  twice"
        let draft = MixedDraft(member + " task " + file + "\n" + citation + "\n\nend")
        let page = UIHostingController(rootView: MixedEditor(draft: draft, markers: [
            PromptMentionChip(marker: member, name: "Pat", icon: .member(nil)),
            PromptMentionChip(marker: file, name: "spec.md", icon: .file)]))
        guard let owner = window.rootViewController else { return false }
        owner.addChild(page); page.view.frame = CGRect(x: 0, y: 80, width: 320, height: 120)
        owner.view.addSubview(page.view); page.didMove(toParent: owner)
        defer { page.willMove(toParent: nil); page.view.removeFromSuperview(); page.removeFromParent() }
        guard let input = await waitForEditor(in: page.view, text: "\u{fffc}task\u{fffc}\n\u{fffc}end") else { return false }
        input.becomeFirstResponder()
        let source = draft.wire
        guard input.readableText(in: NSRange(location: 0, length: input.textStorage.length)) == member + " task " + file + "\nPat said @Pat  twiceend" else { return false }
        input.selectedRange = NSRange(location: 1, length: 0); input.insertText("111")
        let edited = member + " 111task " + file + "\n" + citation + "\n\nend"
        guard draft.wire == edited else { return false }
        try? await Task.sleep(for: .milliseconds(80))
        let quoteAt = (input.text as NSString).range(of: "\n\u{fffc}").location
        guard quoteAt != NSNotFound else { return false }
        input.selectedRange = NSRange(location: quoteAt + 2, length: 0); input.deleteBackward()
        guard draft.wire == member + " 111task " + file + "\nend" else { return false }
        try? await Task.sleep(for: .milliseconds(80))
        input.undoManager?.undo()
        guard draft.wire == edited else { return false }
        let beforeFile = (input.text as NSString).range(of: "task").location
        guard beforeFile != NSNotFound else { return false }
        input.selectedRange = NSRange(location: beforeFile + 5, length: 0); input.deleteBackward()
        guard draft.wire == member + " 111task\n" + citation + "\n\nend" else { return false }
        try? await Task.sleep(for: .milliseconds(80))
        input.undoManager?.undo()
        return draft.wire == edited && source.contains(citation)
    }
    private static func editor(in view: UIView) -> LocalPromptView? {
        if let input = view as? LocalPromptView, input.window != nil, input.isEditable { return input }
        for child in view.subviews { if let input = editor(in: child) { return input } }
        return nil
    }
    private static func waitForEditor(in view: UIView, text: String) async -> LocalPromptView? {
        for _ in 0..<50 {
            if let input = editor(in: view), input.text == text { return input }
            try? await Task.sleep(for: .milliseconds(40))
        }
        return nil
    }
    static func stage(_ model: PhoneModel, session: String, terminal: Bool) {
        let prefix = "请检查：\n", suffix = "Keep this."
        let legacy = prefix + (terminal ? "Terminal 2\n```text\nBuild passed\nDone\n```" : "[引用回复 \(session)/m2@0]\n> Release\n> notes")
        let probe = UserDefaults.standard.string(forKey: "LatchReplyQuoteProbe").flatMap(UUID.init(uuidString:))
        let drafts = model.heldDrafts
        let opening = drafts.opening
        let ready = legacy + "\n\n" + suffix
        drafts.set(probe == nil ? ready : legacy, for: session, opening: opening, permitted: true)
        guard let probe else { return }
        let output = URL.temporaryDirectory.appendingPathComponent("reply-quote-\(probe.uuidString.lowercased()).json")
        Task { @MainActor in
            var input: LocalPromptView?
            for _ in 0..<100 {
                if let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow),
                   let view = editor(in: window), view.text == prefix + "\u{fffc}" {
                    input = view; break
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
            var proof = ["restored": false, "keptSource": false, "deletedOnce": false, "undoRestoredSource": false, "redoRemovedSource": false]
            if let input {
                let offset = prefix.utf16.count
                let attachment = input.attributedText.attribute(.attachment, at: offset, effectiveRange: nil) as? NSTextAttachment
                let spoken = attachment?.accessibilityLabel?.split(whereSeparator: \.isWhitespace).joined(separator: " ")
                proof["restored"] = terminal ? spoken?.contains("Build passed") == true : spoken == "Release notes"
                input.becomeFirstResponder()
                input.selectedRange = NSRange(location: offset + 1, length: 0)
                input.insertText(suffix)
                proof["keptSource"] = drafts.text(for: session, visible: true) == ready
                try? await Task.sleep(for: .milliseconds(100))
                input.selectedRange = NSRange(location: offset + 1, length: 0)
                if terminal {
                    input.layoutIfNeeded()
                    let remove = input.subviews.compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "remove-terminal-reference" }
                    remove?.sendActions(for: .touchUpInside)
                } else {
                    input.deleteBackward()
                }
                proof["deletedOnce"] = drafts.text(for: session, visible: true) == prefix + suffix
                    && input.text == prefix + suffix
                try? await Task.sleep(for: .milliseconds(100))
                input.undoManager?.undo()
                proof["undoRestoredSource"] = drafts.text(for: session, visible: true) == ready
                proof["undoRestoredText"] = input.text == prefix + "\u{fffc}" + suffix
                proof["undoRestoredAttachment"] = offset < input.attributedText.length
                    && input.attributedText.attribute(.attachment, at: offset, effectiveRange: nil) is NSTextAttachment
                input.undoManager?.redo()
                proof["redoRemovedSource"] = drafts.text(for: session, visible: true) == prefix + suffix
                    && input.text == prefix + suffix
                input.resignFirstResponder()
                if let window = input.window { proof["mixedSourceUndoCopy"] = await mixedEditor(in: window) }
                drafts.set(ready, for: session, opening: opening, permitted: true)
            }
            try? JSONEncoder().encode(proof).write(to: output, options: .atomic)
        }
    }
}
#endif
