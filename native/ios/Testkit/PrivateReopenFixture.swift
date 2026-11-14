import Foundation
import LatchNativeCore

/** Calls the App's recovery orchestration with controlled verification/read completions; no App or system permission stub. */
@MainActor func privateReopenFixture() async throws -> [String: Any] {
    let source = try NativeJSON.decode(Data(#"{"catalog":{"features":{"customAgents":true}},"device":{"dataScope":"all"},"customAgents":[],"tasks":[]}"#.utf8))
    var rows: [[String: Any]] = []
    for mode in ["topic", "list", "code", "none", "face-id", "old-host", "changed-host", "cancelled", "changed-reading"] {
        var host = UUID(), reading = UUID(), window = false, content = PhonePrivateSnapshot()
        let expectedHost = host, expectedReading = reading
        if mode == "old-host" { host = UUID() }
        var snapshot = PhoneAgents.withoutPrivate(source), events: [String] = []
        let target: PhoneContentReopen = mode == "code" ? .session("code-session") : mode == "none" ? .none
            : .agents(sessionId: mode == "list" ? nil : "agent-topic")
        let task = Task { @MainActor in
            do {
                try await PhoneUnlock.reopenContent(target, faceID: mode == "face-id",
                    current: { host == expectedHost && reading == expectedReading }, verify: {
                    events.append("verify")
                    await Task.yield()
                    if mode == "changed-host" { host = UUID(); content.clear() }
                    if mode == "changed-reading" { reading = UUID(); content.clear() }
                    if mode == "cancelled" { withUnsafeCurrentTask { $0?.cancel() } }
                    window = true
                }, refreshPrivate: {
                    events.append("snapshot")
                    let captured = content.epoch
                    if let value = content.adopt(source, captured: captured, windowOpen: window) { snapshot = value }
                    events.append("selected-detail")
                    return true
                }, openSession: { id in events.append("session:" + id); window = true })
            } catch is CancellationError { events.append("cancelled") }
        }
        try await task.value
        let access = PhoneAgents.access(snapshot, windowOpen: window, privateConfirmed: content.confirmed)
        rows.append(["mode": mode, "events": events, "access": "\(access)"])
    }
    return ["rows": rows]
}
