import CoreFoundation
import Foundation

/** A cache lease is issued by this App opening's verified transport; consumers cannot construct one. */
public struct BodyLease: Sendable {
    public let verifiedUntil: Date
    private let authority: WindowAuthority
    private let id: UUID
    private let deadline: ContinuousClock.Instant
    fileprivate init(authority: WindowAuthority, id: UUID, until: Date, originalDeadline: ContinuousClock.Instant?) {
        self.authority = authority; self.id = id; self.verifiedUntil = until
        let bounded = ContinuousClock.now.advanced(by: .seconds(min(600, max(0, until.timeIntervalSinceNow))))
        self.deadline = min(bounded, originalDeadline ?? bounded)
    }
    public var valid: Bool { authority.accepts(id) && Date() < verifiedUntil && ContinuousClock.now < deadline }
    public func sameWindow(as other: BodyLease) -> Bool { authority === other.authority && id == other.id }
    public func requireValid() throws { guard valid else { throw NativeFailure.expired } }
    /** Rebinding a UI observer keeps this lease's original wall and monotonic deadlines. */
    public func waitForInvalidation() async throws {
        while valid {
            try Task.checkCancellation()
            let remaining = min(ContinuousClock.now.duration(to: deadline), .seconds(max(0, verifiedUntil.timeIntervalSinceNow)))
            guard remaining > .zero else { return }
            try await Task.sleep(for: min(remaining, .milliseconds(250)))
        }
    }
}
private final class WindowAuthority: @unchecked Sendable {
    private let lock = NSLock()
    private var current = UUID()
    func accepts(_ id: UUID) -> Bool { lock.lock(); defer { lock.unlock() }; return current == id }
    func replace() -> UUID { lock.lock(); defer { lock.unlock() }; current = UUID(); return current }
}
struct PreparedWindowRestore: Sendable {
    enum State: Sendable { case existing(String, Date), recovered(String, Date, String), none }
    let opening: String
    let version: UUID
    let state: State
}

/** App-open receipts and recovery proofs live only in memory and never refresh their original expiry on migration. */
public actor NativeVerification {
    private struct Window: Sendable { let token: String; let until: Date; let lease: BodyLease }
    private let hostId: String
    private let deviceId: String
    private let authority = WindowAuthority()
    private var opening = UUID().uuidString
    private var window: Window?
    private var windowConnection: ObjectIdentifier?
    private var proof: String?
    private var proofDeadline: ContinuousClock.Instant?
    private var flight: Task<BodyLease, Error>?
    private var flightId: UUID?
    private var version = UUID()
    private struct Challenge: Sendable { let connection: ObjectIdentifier; let opening: String; let body: Data; let deadline: ContinuousClock.Instant }
    private var prefetched: Challenge?
    private var prefetching: Task<Void, Never>?
    public init(hostId: String, deviceId: String) { self.hostId = hostId; self.deviceId = deviceId }
    /** A qualify rechecks a held window or recovery proof (or waits for a verification in flight) before reading the snapshot. */
    /** A verification or an early challenge is on the wire. */
    func busy() -> Bool { flight != nil || prefetching != nil }
    func restoresWindow() -> Bool { window?.lease.valid == true || proof != nil || flight != nil }
    /**
     * With Face ID off and no window, the challenge a verification needs is fetched as soon as a path is installed.
     * The Host's challenge supersedes every older window of this device, so this never runs while one or a recovery proof
     * exists or a verification is in flight. The challenge is bound to its connection and opening and used at most once.
     */
    func prefetchChallenge(on connection: NativeHTTPConnection) async {
        guard window == nil, proof == nil, flight == nil, prefetching == nil else { return }
        let current = opening, expected = version, id = ObjectIdentifier(connection)
        let task = Task {
            guard let response = try? await connection.request(.post, path: "/link/api/native/verification/challenge", body: json(["appOpenId": current])),
                  response.status == 200 else { return }
            self.keep(Challenge(connection: id, opening: current, body: response.body, deadline: ContinuousClock.now.advanced(by: .seconds(45))), version: expected)
        }
        prefetching = task
        await task.value
        prefetching = nil
    }
    private func keep(_ challenge: Challenge, version expected: UUID) {
        // A verification may already wait for this fetch; it changes the version only after taking the challenge.
        guard opening == challenge.opening, version == expected, window == nil, proof == nil else { return }
        prefetched = challenge
    }
    public func currentLease() -> BodyLease? { window?.lease.valid == true ? window?.lease : nil }
    /** A late stream failure may withdraw its own window, never a newer verification on this connection. */
    public func invalidate(_ lease: BodyLease?) -> Bool {
        guard let lease, window?.lease.sameWindow(as: lease) == true else { return false }
        closeOpening(); return true
    }
    public func closeOpening() {
        version = UUID(); prefetched = nil
        _ = authority.replace(); opening = UUID().uuidString
        window = nil; windowConnection = nil; proof = nil; proofDeadline = nil
        flight?.cancel(); flight = nil; flightId = nil
    }
    public func verify(on connection: NativeHTTPConnection, sign: @escaping @Sendable (Data) async throws -> Data) async throws -> BodyLease {
        if let window, window.lease.valid, windowConnection == ObjectIdentifier(connection) { return window.lease }
        if let flight { return try await flight.value }
        let id = UUID(), current = opening
        let task = Task { try await self.verifyOnce(on: connection, opening: current, sign: sign) }
        flight = task; flightId = id
        do {
            let result = try await task.value
            if flightId == id { flight = nil; flightId = nil }
            return result
        } catch {
            if flightId == id { flight = nil; flightId = nil }
            throw error
        }
    }
    public func restore(on connection: NativeHTTPConnection) async throws -> Bool {
        try installPrepared(prepare: await prepareRestore(on: connection), on: connection) != nil
    }
    /** A companion resumes the original receipt without changing which connection owns system confirmation. */
    func attachCompanion(on connection: NativeHTTPConnection) async throws -> BodyLease {
        guard let window, window.lease.valid else { throw NativeFailure.expired }
        let current = opening, expected = version
        let response = try await connection.request(.post, path: "/link/api/native/verification/resume",
            body: json(["appOpenId": current, "windowToken": window.token]))
        guard current == opening, expected == version, window.lease.valid else { throw NativeFailure.expired }
        if response.status == 403 { discardRejectedRecovery(); throw NativeFailure.expired }
        guard response.status == 200 else { throw NativeFailure.expired }
        guard try resumedUntil(response) == window.until else { throw NativeFailure.invalidRecord }
        return window.lease
    }
    func prepareRestore(on connection: NativeHTTPConnection) async throws -> PreparedWindowRestore {
        // An ongoing system confirmation still owns its challenge connection; do not close it mid-signature.
        if let flight { _ = try? await flight.value }
        let current = opening, expected = version
        if let window, window.lease.valid {
            let response = try await connection.request(.post, path: "/link/api/native/verification/resume", body: json(["appOpenId": current, "windowToken": window.token]))
            guard current == opening, expected == version else { throw NativeFailure.expired }
            if response.status == 403 {
                version = UUID(); _ = authority.replace(); self.window = nil; windowConnection = nil
                return PreparedWindowRestore(opening: current, version: version, state: .none)
            }
            guard response.status == 200 else { throw NativeFailure.unavailable }
            let restored = try resumedUntil(response)
            guard restored == window.until else { throw NativeFailure.invalidRecord }
            return PreparedWindowRestore(opening: current, version: expected, state: .existing(window.token, window.until))
        }
        if let proof {
            let response = try await connection.request(.post, path: "/link/api/native/verification/recover", body: json(["appOpenId": current, "proofReceipt": proof]))
            guard current == opening, expected == version else { throw NativeFailure.expired }
            if response.status == 403 {
                discardRejectedRecovery()
                return PreparedWindowRestore(opening: current, version: version, state: .none)
            }
            let value = try receipt(response)
            return PreparedWindowRestore(opening: current, version: expected, state: .recovered(value.token, value.until, proof))
        }
        return PreparedWindowRestore(opening: current, version: expected, state: .none)
    }
    func installPrepared(prepare: PreparedWindowRestore, on connection: NativeHTTPConnection) throws -> BodyLease? {
        guard opening == prepare.opening, version == prepare.version else { throw NativeFailure.expired }
        switch prepare.state {
        case let .existing(token, until):
            guard let window, window.token == token, window.until == until, window.lease.valid else { throw NativeFailure.expired }
            windowConnection = ObjectIdentifier(connection); return window.lease
        case let .recovered(token, until, expectedProof):
            guard proof == expectedProof else { throw NativeFailure.expired }
            return accept((token, until), connection: connection)
        case .none:
            window = nil; windowConnection = nil; return nil
        }
    }
    private func verifyOnce(on connection: NativeHTTPConnection, opening current: String, sign: @escaping @Sendable (Data) async throws -> Data) async throws -> BodyLease {
        if let proof {
            if let result = try await recover(proof, on: connection, opening: current) { return result }
            guard self.proof == nil else { throw NativeFailure.resultUnknown }
        }
        if let prefetching { await prefetching.value }
        let early = prefetched.flatMap { $0.connection == ObjectIdentifier(connection) && $0.opening == current && ContinuousClock.now < $0.deadline ? $0 : nil }
        prefetched = nil
        if let early {
            do { return try await signChallenge(early.body, on: connection, opening: current, sign: sign) }
            catch NativeVerificationRejected.answered {
                // A newer challenge from elsewhere superseded the early one; the Host answered, so one fresh challenge follows.
                discardRejectedRecovery()
            }
        }
        version = UUID(); _ = authority.replace(); window = nil; windowConnection = nil
        let response = try await connection.request(.post, path: "/link/api/native/verification/challenge", body: json(["appOpenId": current]))
        guard current == opening, response.status == 200 else { throw NativeFailure.expired }
        do { return try await signChallenge(response.body, on: connection, opening: current, sign: sign) }
        catch NativeVerificationRejected.answered { throw NativeFailure.resultUnknown }
    }
    private enum NativeVerificationRejected: Error { case answered }
    private func signChallenge(_ body: Data, on connection: NativeHTTPConnection, opening current: String,
        sign: @escaping @Sendable (Data) async throws -> Data) async throws -> BodyLease {
        version = UUID(); _ = authority.replace(); window = nil; windowConnection = nil
        let challenge = try object(body)
        guard Set(challenge.keys).isSubset(of: ["nonce", "appOpenId", "expiresAt", "generation"]), let nonce = challenge["nonce"] as? String,
              challenge["appOpenId"] as? String == current, let deadline = challenge["expiresAt"] as? NSNumber,
              CFGetTypeID(deadline) == CFNumberGetTypeID(), deadline.doubleValue.rounded(.down) == deadline.doubleValue,
              deadline.doubleValue >= Date().timeIntervalSince1970 * 1000, deadline.doubleValue <= Date().timeIntervalSince1970 * 1000 + 65_000 else { throw NativeFailure.invalidRecord }
        if let generation = challenge["generation"] {
            guard let value = generation as? NSNumber, CFGetTypeID(value) == CFNumberGetTypeID(),
                  value.doubleValue.rounded(.down) == value.doubleValue, value.doubleValue > 0,
                  value.doubleValue <= Double(LinkBytes.maximumInteger) else { throw NativeFailure.invalidRecord }
        }
        let statement = try NativeCrypto.verificationText(hostId: hostId, deviceId: deviceId, nonce: nonce, expiresAt: deadline.uint64Value, appOpenId: current)
        let signature = try await sign(Data(statement.utf8))
        guard current == opening, !Task.isCancelled else { throw NativeFailure.expired }
        let recovery = try "lnp1." + LinkBytes.base64url(NativeCrypto.recoverySecret(statement: statement, signature: signature))
        version = UUID(); proof = recovery; proofDeadline = ContinuousClock.now.advanced(by: .seconds(600))
        window = nil; windowConnection = nil
        let verified: NativeHTTPResponse
        do { verified = try await connection.request(.post, path: "/link/api/native/verification", body: json(["signature": LinkBytes.base64url(signature)])) }
        catch { throw NativeFailure.resultUnknown }
        guard current == opening else { throw NativeFailure.expired }
        if verified.status == 403 { throw NativeVerificationRejected.answered }
        guard let value = try? receipt(verified) else { throw NativeFailure.resultUnknown }
        return accept(value, connection: connection)
    }
    private func recover(_ proof: String, on connection: NativeHTTPConnection, opening current: String) async throws -> BodyLease? {
        let expected = version
        let response = try await connection.request(.post, path: "/link/api/native/verification/recover", body: json(["appOpenId": current, "proofReceipt": proof]))
        guard current == opening, expected == version else { throw NativeFailure.expired }
        if response.status == 403 { discardRejectedRecovery(); return nil }
        guard let value = try? receipt(response) else { return nil }
        return accept(value, connection: connection)
    }
    private func discardRejectedRecovery() {
        // A rejection from the authenticated Host ends only this proof; reconnect never initiates a new user confirmation.
        version = UUID(); _ = authority.replace(); window = nil; windowConnection = nil; proof = nil; proofDeadline = nil
    }
    private func accept(_ value: (token: String, until: Date), connection: NativeHTTPConnection) -> BodyLease {
        version = UUID()
        let lease = BodyLease(authority: authority, id: authority.replace(), until: value.until, originalDeadline: proofDeadline)
        window = Window(token: value.token, until: value.until, lease: lease); windowConnection = ObjectIdentifier(connection)
        proof = nil; proofDeadline = nil
        return lease
    }
    private func receipt(_ response: NativeHTTPResponse) throws -> (token: String, until: Date) {
        guard response.status == 200 else { throw NativeFailure.expired }
        let value = try object(response.body)
        guard Set(value.keys) == Set(["windowToken", "verifiedUntil"]), let token = value["windowToken"] as? String,
              LinkBytes.matches(token, "lnw1\\.[A-Za-z0-9_-]{43}"), let text = value["verifiedUntil"] as? String,
              let until = ISO8601DateFormatter.latch.date(from: text), until > Date(), until.timeIntervalSinceNow <= 660 else { throw NativeFailure.invalidRecord }
        return (token, until)
    }
    private func resumedUntil(_ response: NativeHTTPResponse) throws -> Date {
        guard response.status == 200 else { throw NativeFailure.expired }
        let value = try object(response.body)
        guard Set(value.keys) == Set(["verifiedUntil"]), let text = value["verifiedUntil"] as? String,
              let until = ISO8601DateFormatter.latch.date(from: text), until > Date() else { throw NativeFailure.invalidRecord }
        return until
    }
    private func json(_ value: [String: String]) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    private func object(_ value: Data) throws -> [String: Any] {
        guard value.count <= 8192, let result = try JSONSerialization.jsonObject(with: value) as? [String: Any] else { throw NativeFailure.invalidRecord }; return result
    }
}
