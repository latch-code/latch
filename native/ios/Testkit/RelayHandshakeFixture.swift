import Foundation
import LatchNativeCore
import NIOCore

@MainActor func relayHandshakeDeadlineFixture() async -> [String: Any] {
    let start = NIODeadline.now()
    let progressing = NativeRelayHandshakeDeadline(now: start)
    let stalled = NativeRelayHandshakeDeadline(now: start)
    stalled.advanced(at: start + .seconds(9))
    var deadlines: [Int64] = []
    for offset: Int64 in [0, 7, 14, 21, 25] {
        progressing.advanced(at: start + .seconds(offset))
        deadlines.append((progressing.deadline - start).nanoseconds / 1_000_000_000)
    }

    let first = URL(string: "https://first.example")!, other = URL(string: "https://other.example")!
    // The join completes before the shorter claim deadline; the Host handshake may finish after it.
    let winner = await NativeEdgeOrigins.race([first, other], stagger: .milliseconds(50), claimTimeout: .milliseconds(200),
        attempt: { origin, race in
            guard origin == first, race.claim(origin: origin) else { throw NativeFailure.unavailable }
            race.spliced(origin: origin)
            try await Task.sleep(for: .milliseconds(400))
            return origin
        }, close: { _ in })
    let stalledSeconds = (stalled.deadline - start).nanoseconds / 1_000_000_000
    return ["progressing": deadlines, "stalled": stalledSeconds, "joinedOriginKept": winner?.0 == first]
}
