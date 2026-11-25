#if LATCH_SCREENS && targetEnvironment(simulator)
import Foundation
import SwiftUI
import LatchNativeCore
import UIKit

/** Exercises the conversation's mounted text view, including the binding that preserves the wire draft. */
@MainActor enum ReplyQuoteDraftFixture {
    @MainActor private final class MixedDraft: ObservableObject {
        @Published var wire: String
        var commands: [String] = []
        init(_ wire: String) { self.wire = wire }
    }
    private struct MixedEditor: View {
        @ObservedObject var draft: MixedDraft
        let markers: [PromptMentionChip]
        var body: some View {
            let display = Binding(get: { PhoneInputReferences(draft.wire, collapseQuotes: true).display },
                set: { draft.wire = PhoneInputReferences(draft.wire, collapseQuotes: true).restore($0) })
            LocalTextEditor(text: display, placeholder: "草稿", mentionMarkers: markers,
                commandKeys: ["submit", "alternateSubmit"], onCommand: { draft.commands.append($0) }, referenceDraft: $draft.wire)
        }
    }
    private static func mixedEditor(in window: UIWindow) async -> [String: Bool] {
        var checks = [String: Bool]()
        let member = "@Pat", file = "@default:docs/spec.md"
        let citation = "[引用回复 ses_review/m2@0]\n> Pat said @Pat  twice"
        let draft = MixedDraft(member + " task " + file + "\n" + citation + "\n\nend")
        let page = UIHostingController(rootView: MixedEditor(draft: draft, markers: [
            PromptMentionChip(marker: member, name: "Pat", icon: .member(nil)),
            PromptMentionChip(marker: file, name: "spec.md", icon: .file)]))
        guard let owner = window.rootViewController else { return checks }
        owner.addChild(page); page.view.frame = CGRect(x: 0, y: 80, width: 320, height: 120)
        owner.view.addSubview(page.view); page.didMove(toParent: owner)
        defer { page.willMove(toParent: nil); page.view.removeFromSuperview(); page.removeFromParent() }
        guard let input = await waitForEditor(in: page.view, text: "\u{fffc}task\u{fffc}\n\u{fffc}end") else { return checks }
        checks["mixedMounted"] = true
        input.becomeFirstResponder()
        func key(_ modifiers: UIKeyModifierFlags) -> UIKeyCommand? {
            input.keyCommands?.first { $0.input == "\r" && $0.modifierFlags == modifiers && $0.wantsPriorityOverSystemBehavior }
        }
        guard let primary = key(.command), let alternate = key([.command, .shift]) else { return checks }
        func press(_ command: UIKeyCommand) {
            if let action = command.action { UIApplication.shared.sendAction(action, to: input, from: command, for: nil) }
        }
        press(primary); press(alternate)
        checks["distinctSubmitKeys"] = draft.commands == ["submit", "alternateSubmit"] && key(.control) == nil
        let original = draft.wire
        input.selectedRange = NSRange(location: input.textStorage.length, length: 0)
        input.setMarkedText("拼", selectedRange: NSRange(location: 1, length: 0))
        guard input.markedTextRange != nil else { return checks }
        press(alternate)
        input.setMarkedText("拼音", selectedRange: NSRange(location: 2, length: 0)); input.unmarkText()
        try? await Task.sleep(for: .milliseconds(80))
        guard draft.commands == ["submit", "alternateSubmit"], draft.wire == original + "拼音" else { return checks }
        input.selectedRange = NSRange(location: input.textStorage.length - 2, length: 2); input.deleteBackward()
        try? await Task.sleep(for: .milliseconds(80))
        guard draft.wire == original else { return checks }
        checks["compositionKeptSource"] = true
        guard input.readableText(in: NSRange(location: 0, length: input.textStorage.length)) == member + " task " + file + "\nPat said @Pat  twiceend" else { return checks }
        checks["mixedCopy"] = true
        input.selectedRange = NSRange(location: 1, length: 0); input.insertText("111")
        let edited = member + " 111task " + file + "\n" + citation + "\n\nend"
        guard draft.wire == edited else { return checks }
        try? await Task.sleep(for: .milliseconds(80))
        checks["mixedPlainEdit"] = true
        let quoteAt = (input.text as NSString).range(of: "\n\u{fffc}").location
        guard quoteAt != NSNotFound else { return checks }
        input.selectedRange = NSRange(location: quoteAt + 2, length: 0); input.deleteBackward()
        guard draft.wire == member + " 111task " + file + "\nend" else { return checks }
        try? await Task.sleep(for: .milliseconds(80))
        input.undoManager?.undo()
        guard draft.wire == edited else { return checks }
        checks["mixedQuoteUndo"] = true
        let beforeFile = (input.text as NSString).range(of: "task").location
        guard beforeFile != NSNotFound else { return checks }
        input.selectedRange = NSRange(location: beforeFile + 5, length: 0); input.deleteBackward()
        guard draft.wire == member + " 111task\n" + citation + "\n\nend" else { return checks }
        try? await Task.sleep(for: .milliseconds(80))
        input.undoManager?.undo()
        checks["mixedFileUndo"] = draft.wire == edited
        return checks
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
                // A collapsed quote can look short while its actual request exceeds the Host's UTF-16 limit.
                let quote = "[引用回复 \(session)/m2@0]\n> " + String(repeating: "a", count: 2_000) + "\n\n"
                let quotes = String(repeating: quote, count: 7)
                let atLimit = quotes + String(repeating: "b", count: 16_000 - quotes.utf16.count)
                let tooLong = atLimit + "x"
                drafts.set(tooLong, for: session, opening: opening, permitted: true)
                let projected = PhoneInputReferences(tooLong, collapseQuotes: true).display
                for _ in 0..<50 where input.text != projected { try? await Task.sleep(for: .milliseconds(40)) }
                proof["oversizeDraftKept"] = input.text == projected && projected.utf16.count < 16_000
                    && !input.completionKeys.contains("submit") && drafts.text(for: session, visible: true) == tooLong
                input.selectedRange = NSRange(location: input.textStorage.length, length: 0); input.deleteBackward()
                for _ in 0..<50 where !input.completionKeys.contains("submit") { try? await Task.sleep(for: .milliseconds(40)) }
                proof["shortenedDraftCanSend"] = drafts.text(for: session, visible: true) == atLimit && input.completionKeys.contains("submit")
                input.resignFirstResponder()
                if let window = input.window { proof.merge(await mixedEditor(in: window)) { _, new in new } }
                drafts.set(ready, for: session, opening: opening, permitted: true)
            }
            try? JSONEncoder().encode(proof).write(to: output, options: .atomic)
        }
    }
}
#endif
