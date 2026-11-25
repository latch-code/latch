import Combine
import Foundation

/** Session drafts belong to this unlocked opening. A view can disappear without writing its display back. */
@MainActor public final class PhoneConversationDrafts: ObservableObject {
    @Published private var drafts: [String: String] = [:]
    public struct AddressedDraft {
        public let target: PhoneAgentEntry
        public let message: String
        public let original: String
    }
    private var addressed: [String: AddressedDraft] = [:]
    public func addressedDraft(for owner: String) -> AddressedDraft? { addressed[owner] }
    public func address(_ target: PhoneAgentEntry?, owner: String, message: String, original: String, opening: UUID) {
        guard opening == self.opening else { return }
        addressed[owner] = target.map { AddressedDraft(target: $0, message: message, original: original) }
    }
    public private(set) var opening = UUID()

    public init() {}

    public func text(for id: String?, visible: Bool) -> String {
        guard visible, let id else { return "" }
        return drafts[id] ?? ""
    }

    public func set(_ text: String, for id: String?, opening: UUID, permitted: Bool) {
        guard permitted, self.opening == opening, let id else { return }
        let before = drafts[id], after = text.isEmpty ? nil : text
        if let before, let after, before.utf8.elementsEqual(after.utf8) { return }
        if before == nil && after == nil { return }
        drafts[id] = after
    }

    /** A settled pending message returns to its original session, even after its field has gone off screen. */
    public func restore(_ text: String, for id: String, opening: UUID) {
        guard self.opening == opening else { return }
        drafts[id] = PhonePending.joined(drafts[id] ?? "", text)
    }

    /** The first attempt can return only what it took. A definitive retry refusal has the original prompt in the request. */
    public func restoreRefusedPrompt(_ request: NativePendingWrite, taken: String?, confirmedRetry: Bool, opening: UUID, permitted: Bool) {
        guard permitted, let id = PhoneHistory.promptSession(request.path),
              let text = taken ?? (confirmedRetry ? PhonePending.prompt(request) : nil), !text.isEmpty else { return }
        restore(text, for: id, opening: opening)
    }

    public func take(for id: String, matching text: String? = nil) -> String? {
        guard let draft = drafts[id] else { return nil }
        if let text, !draft.utf8.elementsEqual(text.utf8) { return nil }
        return drafts.removeValue(forKey: id)
    }

    public func clear() {
        opening = UUID(); addressed = [:]
        if !drafts.isEmpty { drafts = [:] }
    }
}
