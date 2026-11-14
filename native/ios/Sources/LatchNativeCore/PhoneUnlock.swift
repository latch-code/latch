import Foundation

public enum PhoneStreamFailure: String, Sendable { case contentExpired, eventOverflow, retryEvents, reconnect }
public struct PhoneEventRecovery: Sendable {
    public let action: PhoneStreamFailure
    public let snapshot: NativeJSON?
}

/**
 * A connected phone opens its content without asking. Face ID is the person's own choice in 设置, off by default; when it
 * is on, it is asked before each new content window, and the words and icons say so.
 */
public enum PhoneUnlock {
    public static func streamFailure(_ error: Error) -> PhoneStreamFailure {
        switch error as? NativeFailure {
        case .expired: .contentExpired
        case .eventOverflow: .eventOverflow
        default: .reconnect
        }
    }
    /** A failed HTTP stream is not evidence that its authenticated connection failed. Probe once, never replay a write. */
    @MainActor public static func recoverStream(_ error: Error, current: () -> Bool,
        readMetadata: () async throws -> NativeJSON) async -> PhoneEventRecovery? {
        guard current(), !(error is CancellationError) else { return nil }
        let action = streamFailure(error)
        guard (error as? NativeFailure) == .unavailable else { return PhoneEventRecovery(action: action, snapshot: nil) }
        do {
            let value = try await readMetadata()
            guard current() else { return nil }
            return PhoneEventRecovery(action: .retryEvents, snapshot: value)
        } catch {
            guard current(), !(error is CancellationError) else { return nil }
            return PhoneEventRecovery(action: .reconnect, snapshot: nil)
        }
    }
    /** The one way back into a session whose window closed, named for what tapping it does. */
    public static func reopenWords(faceID: Bool) -> String { faceID ? "用 Face ID 查看" : "查看" }
    /** The icon beside 「查看内容后可以回复」. */
    public static func closedWindowSymbol(faceID: Bool) -> String { faceID ? "faceid" : "eye" }
    /** Nothing asks the person when Face ID is off, so a window that ran out while open opens again by itself. */
    public static func reopensAtExpiry(faceID: Bool) -> Bool { !faceID }
}
