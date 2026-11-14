import Foundation

/** A local content withdrawal is not evidence that the Host is confirming a write. */
public struct PhonePrivateSnapshot: Sendable {
    public private(set) var epoch = UUID()
    public private(set) var confirmed = false
    public init() {}
    public mutating func clear() { epoch = UUID(); confirmed = false }
    public func accepts(_ captured: UUID) -> Bool { captured == epoch }
    /** Reject an old read entirely; it cannot restore private fields or overwrite a newer window's state. */
    public mutating func adopt(_ snapshot: NativeJSON, captured: UUID, windowOpen: Bool) -> NativeJSON? {
        guard accepts(captured) else { return nil }
        confirmed = windowOpen
        return windowOpen ? snapshot : PhoneAgents.withoutPrivate(snapshot)
    }
}
