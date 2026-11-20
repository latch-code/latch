import Foundation

/** A local content withdrawal is not evidence that the Host is confirming a write. */
public struct PhonePrivateSnapshot: Sendable {
    public private(set) var epoch = UUID()
    public private(set) var confirmed = false
    public init() {}
    public mutating func clear() { epoch = UUID(); confirmed = false }
    public func accepts(_ captured: UUID) -> Bool { captured == epoch }
    /** A vault read began under this window and intent. A retry must still name the exact persisted write. */
    public func mayRestorePending(_ saved: [NativePendingWrite], captured: UUID, permitted: Bool, retry: NativePendingWrite?) -> Bool {
        guard accepts(captured), permitted else { return false }
        guard let retry else { return true }
        return saved.contains { $0.requestId == retry.requestId && $0.method == retry.method && $0.path == retry.path && $0.body == retry.body }
    }
    /** Reject an old read entirely; it cannot restore private fields or overwrite a newer window's state. */
    public mutating func adopt(_ snapshot: NativeJSON, captured: UUID, windowOpen: Bool) -> NativeJSON? {
        guard accepts(captured) else { return nil }
        confirmed = windowOpen
        return windowOpen ? snapshot : PhoneAgents.withoutPrivate(snapshot)
    }
}
