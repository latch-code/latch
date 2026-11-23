import Darwin
import Foundation
import Network

/**
 * Per-phase connection timings in a bounded in-memory ring. Entries are a phase, a path kind, an ordinal and milliseconds:
 * the API takes no strings, so addresses, candidate IDs and secrets cannot reach it.
 */
public final class NativeConnectionTimeline: @unchecked Sendable {
    public enum Phase: String, Sendable, CaseIterable {
        case foreground, storeReady, firstBrowse, candidates, connect, connectFailed, qualify, install, verification, firstEvent
    }
    public struct Entry: Sendable, Equatable {
        public let round: UInt32
        public let phase: Phase
        public let path: NativePathCandidate.Kind?
        public let ordinal: UInt8
        public let ms: UInt32
    }
    public static let capacity = 64
    private let lock = NSLock()
    private var origin = ContinuousClock.now
    private var round: UInt32 = 0
    private var ring: [Entry] = []
    private var once: Set<Phase> = []
    public init() {}
    /** Starts a new round at the App's return to the foreground. */
    public func begin() {
        lock.lock(); origin = .now; round &+= 1; once = []; lock.unlock()
        record(.foreground)
    }
    public func record(_ phase: Phase, path: NativePathCandidate.Kind? = nil, ordinal: Int = 0) {
        lock.lock(); defer { lock.unlock() }
        let elapsed = origin.duration(to: .now).components
        let ms = UInt32(clamping: max(0, elapsed.seconds) * 1000 + Int64(elapsed.attoseconds / 1_000_000_000_000_000))
        ring.append(Entry(round: round, phase: phase, path: path, ordinal: UInt8(clamping: ordinal), ms: ms))
        if ring.count > Self.capacity { ring.removeFirst(ring.count - Self.capacity) }
    }
    /** The first browse result or event of a round only. */
    public func recordOnce(_ phase: Phase, path: NativePathCandidate.Kind? = nil) {
        lock.lock(); let fresh = once.insert(phase).inserted; lock.unlock()
        if fresh { record(phase, path: path) }
    }
    public func entries() -> [Entry] { lock.lock(); defer { lock.unlock() }; return ring }
}

/** A short background hold can resume its selected conversation once the Host lists it again. */
public struct PhoneResumingSession: Equatable, Sendable {
    public enum Action: Equatable, Sendable { case read, close }
    public let session: String
    private let host: UUID, selection: UUID, content: UUID
    private let tab: PhoneTab, agentPath: [String]

    public init(session: String, host: UUID, selection: UUID, content: UUID, tab: PhoneTab, agentPath: [String]) {
        self.session = session; self.host = host; self.selection = selection; self.content = content
        self.tab = tab; self.agentPath = agentPath
    }

    public static func resolve(_ pending: inout Self?, current: Self?, snapshot: NativeJSON) -> Action? {
        guard let saved = pending else { return nil }
        guard current == saved else { pending = nil; return nil }
        switch PhoneWorkItems.sourceVisibility(snapshot, sessionId: saved.session) {
        case .unconfirmed: return nil
        case .readable: pending = nil; return .read
        case .unavailable: pending = nil; return .close
        }
    }
}

/** Retry and dial-order timing; pure so fixtures can check it. */
public enum NativeReconnectPolicy {
    /** A newly connected Host may still be starting its Harnesses. A complete list, including an empty one, needs no retry. */
    @MainActor public static func recoverIncompleteList(current: () -> NativeJSON?, read: () async throws -> Void) async throws {
        func incomplete() -> Bool {
            guard !Task.isCancelled, let snapshot = current(), case .array = snapshot["tasks"] else { return false }
            return !snapshot["tasksComplete"].bool
        }
        for delay: Duration in [.milliseconds(500), .seconds(2), .seconds(5)] {
            guard incomplete() else { return }
            try await Task.sleep(for: delay)
            guard incomplete() else { return }
            try await read()
        }
    }

    /** A network change retries at once; later failures back off 0.5·2^n s up to 30 s with up to 25% jitter. */
    public static func delay(attempt: Int, afterNetworkChange: Bool, jitter: Double = .random(in: 0...1)) -> Duration {
        if attempt == 0 && afterNetworkChange { return .zero }
        let base = min(30.0, 0.5 * pow(2, Double(min(max(attempt, 0), 6))))
        return .milliseconds(Int((base + base / 4 * min(1, max(0, jitter))) * 1000))
    }
    /** The relay waits only for a direct path this round can actually use or one that won here last time. */
    public static func relayDelay(directKnown: Bool, lastWinner: NativePathCandidate.Kind?) -> Duration {
        if lastWinner == .direct { return .milliseconds(600) }
        return directKnown ? .milliseconds(250) : .zero
    }
    /** How long a waiting direct candidate waits for a browse result. */
    public static let browseDeadline: Duration = .milliseconds(500)
}

/** Keep the current page during brief recovery while blocking requests to the interrupted connection. */
public struct PhoneReconnectPresentation: Sendable {
    public struct Interruption: Sendable, Equatable {
        private let id = UUID()
        fileprivate let startedAt: ContinuousClock.Instant
        public var deadline: ContinuousClock.Instant { startedAt.advanced(by: .seconds(6)) }

        fileprivate init(startedAt: ContinuousClock.Instant) { self.startedAt = startedAt }
    }

    public private(set) var interruption: Interruption?
    private var relayRounds = 0
    public init() {}

    public func permitsRequests(connected: Bool, transportValid: Bool) -> Bool {
        connected && transportValid && interruption == nil
    }

    public mutating func begin(at now: ContinuousClock.Instant = .now) -> Interruption? {
        guard interruption == nil else { return nil }
        let current = Interruption(startedAt: now)
        interruption = current
        return current
    }

    public func shouldShowOffline(afterFailedRound startedWith: Interruption?, connected: Bool) -> Bool {
        guard startedWith == interruption else { return false }
        guard interruption != nil else { return !connected }
        return relayRounds != 1
    }

    /** Allow one automatic retry of an eligible relay. The deadline stays anchored to the first lost connection. */
    public mutating func beginRound(withRelay: Bool) {
        guard interruption != nil else { return }
        relayRounds = withRelay ? min(2, relayRounds + 1) : 0
    }

    public func offlineDeadline(for expected: Interruption) -> ContinuousClock.Instant? {
        guard interruption == expected else { return nil }
        return relayRounds > 0 ? expected.startedAt.advanced(by: .seconds(24)) : expected.deadline
    }

    public func shouldShowOffline(at now: ContinuousClock.Instant = .now, for expected: Interruption) -> Bool {
        guard let deadline = offlineDeadline(for: expected) else { return false }
        return now >= deadline
    }

    public mutating func reset() { interruption = nil; relayRounds = 0 }
}

/** The last winning path kind per gateway hash, in memory only. It never holds an address and is never dialed. */
public struct NativeWinningPaths: Sendable {
    private var entries: [(gateway: Data, kind: NativePathCandidate.Kind)] = []
    public init() {}
    public func winner(gateway: Data?) -> NativePathCandidate.Kind? {
        guard let gateway else { return nil }
        return entries.last { $0.gateway == gateway }?.kind
    }
    public mutating func record(_ kind: NativePathCandidate.Kind?, gateway: Data?) {
        guard let kind, let gateway, gateway.count == 32 else { return }
        entries.removeAll { $0.gateway == gateway }
        entries.append((gateway, kind))
        if entries.count > 8 { entries.removeFirst(entries.count - 8) }
    }
}

/** What a path callback says about reachability: its usability, interfaces and gateways. Kept in memory only. */
public struct NativeNetworkSignature: Sendable, Equatable {
    public let usable: Bool
    let interfaces: [String]
    let gateways: [String]
    public init(usable: Bool, interfaces: [String], gateways: [String]) {
        self.usable = usable; self.interfaces = Array(interfaces.prefix(8)); self.gateways = Array(gateways.prefix(8))
    }
    public init(_ path: NWPath) {
        let used = path.availableInterfaces.filter { path.usesInterfaceType($0.type) }.prefix(8).map { "\($0.type)/\($0.name)" }
        let routers = path.gateways.prefix(8).map { "\($0)" }
        self.init(usable: path.status == .satisfied, interfaces: used, gateways: routers)
    }
}

/**
 * A path monitor's first callback is its baseline: everything the App built after it started already uses this network,
 * so it cancels nothing. Later callbacks count only when interfaces, gateways or usability change.
 */
public struct NativeNetworkChangeFilter: Sendable {
    public enum Change: Sendable, Equatable { case baseline, unchanged, changed }
    private var last: NativeNetworkSignature?
    public init() {}
    public mutating func reset() { last = nil }
    public mutating func observe(_ signature: NativeNetworkSignature) -> Change {
        defer { last = signature }
        guard let last else { return .baseline }
        return last == signature ? .unchanged : .changed
    }
}

/**
 * A short background keeps the connection, workspace and in-memory window token for at most `limit`. Content is withdrawn
 * on entry; the end comes once, by return, release or expiry, and `finish` (the background task) runs exactly once.
 */
@MainActor public final class NativeBackgroundHold {
    public static let limit: Duration = .seconds(30)
    private let limit: Duration
    private var timer: Task<Void, Never>?
    private var finish: (@MainActor () -> Void)?
    private var expire: (@MainActor () -> Void)?
    public init(limit: Duration = NativeBackgroundHold.limit) { self.limit = min(limit, Self.limit) }
    public var holding: Bool { finish != nil }
    public func enter(withdraw: () -> Void, finish: @escaping @MainActor () -> Void, expire: @escaping @MainActor () -> Void) {
        release()
        withdraw()
        self.finish = finish; self.expire = expire
        let limit = limit
        timer = Task { [weak self] in
            do { try await Task.sleep(for: limit) } catch { return }
            self?.expired()
        }
    }
    /** Back in the foreground: true when the connection was still held. The window is the Host's to recheck. */
    public func resume() -> Bool {
        guard holding else { return false }
        end(); return true
    }
    /** Lock, revocation, a computer switch or a network change: the caller tears down itself. */
    public func release() { end() }
    /** Ends the hold and runs the teardown, as when the time runs out. */
    public func expired() {
        guard holding else { return }
        let teardown = expire
        end(); teardown?()
    }
    private func end() {
        timer?.cancel(); timer = nil
        let done = finish
        finish = nil; expire = nil
        done?()
    }
}

/** Warms the system resolver for the relays' origin names when a path becomes usable. Names only; nothing is dialed. */
public enum NativeRelayWarmup {
    public static func warm(_ book: NativeAddressBook?) {
        var names: [String] = []
        for relay in NativeRelayOrder.available(book).prefix(2) {
            for url in relay.urls.prefix(2) {
                guard let host = url.host, !AddressBookCodec.isIP(host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))),
                      !names.contains(host) else { continue }
                names.append(host)
            }
        }
        // getaddrinfo blocks; it runs on a dispatch queue, never on the Swift concurrency pool.
        for name in names.prefix(4) {
            DispatchQueue.global(qos: .utility).async {
                var hints = addrinfo(), result: UnsafeMutablePointer<addrinfo>?
                hints.ai_socktype = SOCK_STREAM
                if getaddrinfo(name, "443", &hints, &result) == 0 { freeaddrinfo(result) }
            }
        }
    }
}
