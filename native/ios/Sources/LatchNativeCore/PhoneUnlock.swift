import Foundation

public enum PhoneStreamFailure: String, Sendable { case contentExpired, eventOverflow, retryEvents, reconnect }
public typealias PhoneEventRecovery = PhoneStreamRecovery<NativeJSON>
public struct PhoneStreamRecovery<Metadata: Sendable>: Sendable {
    public let action: PhoneStreamFailure
    public let snapshot: Metadata?
}

public enum PhoneContentReopen: Sendable {
    case agents(sessionId: String?), session(String), none
}

public enum PhoneTeamListRead: Sendable { case ready, automatic, onRequest }

/**
 * A connected phone opens its content without asking. Face ID is the person's own choice in 设置, off by default; when it
 * is on, it is asked before each new content window, and the words and icons say so.
 */
public enum PhoneUnlock {
    public static func teamListRead(windowOpen: Bool, confirmed: Bool, faceID: Bool) -> PhoneTeamListRead {
        if windowOpen { return confirmed ? .ready : .automatic }
        return faceID ? .onRequest : .automatic
    }
    /** Reopens only the captured foreground reading intent. A private page needs its newly authorized snapshot. */
    @MainActor public static func reopenContent(_ target: PhoneContentReopen, faceID: Bool, current: () -> Bool,
        verify: () async throws -> Void, refreshPrivate: () async -> Bool, openSession: (String) async -> Void) async throws {
        guard reopensAtExpiry(faceID: faceID), current(), !Task.isCancelled else { return }
        switch target {
        case let .session(id): await openSession(id)
        case .agents:
            try await verify()
            guard current(), !Task.isCancelled else { throw CancellationError() }
            _ = await refreshPrivate()
        case .none: break
        }
    }
    /** A transient read may retry once within the same reading; it never signs, replays a write or resets a stream. */
    @MainActor public static func retryBodyRead<Value>(current: () -> Bool, read: () async throws -> Value) async throws -> Value {
        guard current(), !Task.isCancelled else { throw CancellationError() }
        do { return try await read() }
        catch {
            guard current(), !Task.isCancelled else { throw CancellationError() }
            guard (error as? NativeFailure) == .unavailable || (error as? NativeReadFailure) == .failed else { throw error }
            try await Task.sleep(for: .milliseconds(250))
            guard current(), !Task.isCancelled else { throw CancellationError() }
            return try await read()
        }
    }
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
        await recoverStream(error, current: current, readCheckpoint: readMetadata)
    }
    @MainActor public static func recoverStream<Metadata: Sendable>(_ error: Error, current: () -> Bool,
        readCheckpoint: () async throws -> Metadata) async -> PhoneStreamRecovery<Metadata>? {
        guard current(), !(error is CancellationError) else { return nil }
        let action = streamFailure(error)
        guard (error as? NativeFailure) == .unavailable else { return PhoneStreamRecovery(action: action, snapshot: nil) }
        do {
            let value = try await readCheckpoint()
            guard current() else { return nil }
            return PhoneStreamRecovery(action: .retryEvents, snapshot: value)
        } catch {
            guard current(), !(error is CancellationError) else { return nil }
            return PhoneStreamRecovery(action: .reconnect, snapshot: nil)
        }
    }
    /** The one way back into a session whose window closed, named for what tapping it does. */
    public static func reopenWords(faceID: Bool) -> String { faceID ? "用 Face ID 查看" : "查看" }
    /** The icon beside 「查看内容后可以回复」. */
    public static func closedWindowSymbol(faceID: Bool) -> String { faceID ? "faceid" : "eye" }
    /** Nothing asks the person when Face ID is off, so a window that ran out while open opens again by itself. */
    public static func reopensAtExpiry(faceID: Bool) -> Bool { !faceID }
}
