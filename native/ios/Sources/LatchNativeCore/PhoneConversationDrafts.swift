import Combine
import Foundation

/** Session drafts belong to this unlocked opening. A view can disappear without writing its display back. */
@MainActor public final class PhoneConversationDrafts: ObservableObject {
    @Published private var drafts: [String: String] = [:]
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

    public func take(for id: String) -> String? {
        guard drafts[id] != nil else { return nil }
        return drafts.removeValue(forKey: id)
    }

    public func clear() {
        opening = UUID()
        if !drafts.isEmpty { drafts = [:] }
    }
}
