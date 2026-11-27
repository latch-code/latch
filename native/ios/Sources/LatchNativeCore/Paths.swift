import Foundation

public struct NativePathCandidate: Sendable {
    public enum Kind: String, Sendable { case direct, relay }
    public let id: String
    public let kind: Kind
    public let connect: @Sendable () async throws -> NativeHTTPConnection
    let didInstall: (@MainActor @Sendable () -> Void)?
    public init(id: String, kind: Kind, didInstall: (@MainActor @Sendable () -> Void)? = nil, connect: @escaping @Sendable () async throws -> NativeHTTPConnection) throws {
        guard LinkBytes.matches(id, "[A-Za-z0-9_-]{1,128}") else { throw NativeFailure.invalidRecord }
        self.id = id; self.kind = kind; self.didInstall = didInstall; self.connect = connect
    }
}

/**
 * Direct candidates that are not known yet: `wait` returns once browsing has a result or its own deadline passed. An empty
 * answer is not a failure and leaves no negative memory.
 */
public struct NativeLateDirects: Sendable {
    public let wait: @Sendable () async -> [NativePathCandidate]
    public init(wait: @escaping @Sendable () async -> [NativePathCandidate]) { self.wait = wait }
}

/**
 * The sole dial owner: two direct slots and one relay slot, finite negative memory, and generation cancellation. A round
 * may wait for direct candidates while the relay dials; a background upgrade round holds only direct candidates and builds
 * the new path before the installed one goes.
 */
public actor NativePathOwner {
    private enum Outcome: Sendable {
        case path(NativePathCandidate, QualifiedNativePath?)
        case late([NativePathCandidate])
    }
    private var round: Task<NativeJSON, Error>?
    private var upgrading: Task<NativeJSON, Error>?
    private var generation = UUID()
    private var failures: [String: ContinuousClock.Instant] = [:]
    private weak var workspace: NativeWorkspace?
    private let timeline: NativeConnectionTimeline?
    public init(timeline: NativeConnectionTimeline? = nil) { self.timeline = timeline }
    /** A new network can make a rejected candidate reachable without disrupting the installed connection. */
    public func forgetFailures() { failures.removeAll() }
    public func networkChanged() async {
        forgetFailures()
        let current = UUID(); generation = current
        let previous = round, upgrade = upgrading
        previous?.cancel(); upgrade?.cancel()
        await workspace?.cancelFileTransfer()
        if let previous { _ = await previous.result }
        if let upgrade { _ = await upgrade.result }
        if generation == current { round = nil; upgrading = nil }
    }
    public func close() async { await networkChanged() }
    public func migrate(_ candidates: [NativePathCandidate], later: NativeLateDirects? = nil, relayDelay: Duration? = nil,
        recovering: Bool = false, workspace: NativeWorkspace) async throws -> NativeJSON {
        guard candidates.count <= 12 else { throw NativeFailure.invalidRecord }
        self.workspace = workspace
        let current = UUID(); generation = current
        let previous = round, upgrade = upgrading
        previous?.cancel(); upgrade?.cancel()
        if let previous { _ = await previous.result }
        if let upgrade { _ = await upgrade.result }
        guard generation == current, !Task.isCancelled else { throw NativeFailure.unavailable }
        round = nil; upgrading = nil
        let directs = Array(candidates.filter { $0.kind == .direct && usable($0) }.prefix(2))
        let relays = candidates.filter { $0.kind == .relay }
        var relay = relays.first(where: usable)
        if recovering, relay == nil {
            // The reconnect loop already backs off. Without a ready relay, retry the one whose cooldown ends first.
            let now = ContinuousClock.now
            relay = relays.min { (failures[$0.id] ?? now) < (failures[$1.id] ?? now) }
        }
        var selected = directs
        if let relay { selected.append(relay) }
        guard !selected.isEmpty || later != nil else { throw NativeFailure.unavailable }
        let delay = relayDelay ?? NativeReconnectPolicy.relayDelay(directKnown: !directs.isEmpty, lastWinner: nil)
        timeline?.record(.candidates, ordinal: selected.count)
        let task = Task { try await self.dial(selected, later: later, relayDelay: delay, upgrade: false, workspace: workspace, generation: current) }
        round = task
        do {
            let result = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: { task.cancel() }
            guard generation == current else { throw NativeFailure.unavailable }
            round = nil; return result
        } catch { if generation == current { round = nil }; throw error }
    }
    /**
     * Moves an installed relay path to a direct one (or to a newly preferred #1 relay when no direct candidate is
     * available) in the background. It never runs beside or pre-empts a dial round, and a failure is silent: the
     * existing relay stays installed. True when a preferred path was installed.
     */
    public func upgrade(_ candidates: [NativePathCandidate], preferredRelay: NativePathCandidate? = nil, workspace: NativeWorkspace) async -> Bool {
        guard round == nil, upgrading == nil, candidates.count <= 12 else { return false }
        guard await workspace.installedPathKind() == .relay else { return false }
        let directs = Array(candidates.filter { $0.kind == .direct && usable($0) }.prefix(2))
        let targets: [NativePathCandidate]
        if !directs.isEmpty {
            targets = directs
        } else if let relay = preferredRelay, relay.kind == .relay, usable(relay), await workspace.installedPathId() != relay.id {
            targets = [relay]
        } else {
            return false
        }
        guard await workspace.quiet() else { return false }
        guard round == nil, upgrading == nil, !Task.isCancelled else { return false }
        self.workspace = workspace
        let current = generation
        let task = Task { try await self.dial(targets, later: nil, relayDelay: .zero, upgrade: true, workspace: workspace, generation: current) }
        upgrading = task
        let result = await withTaskCancellationHandler {
            await task.result
        } onCancel: { task.cancel() }
        if generation == current { upgrading = nil }
        if case .success = result { return true }
        return false
    }
    private func usable(_ candidate: NativePathCandidate) -> Bool { failures[candidate.id].map { ContinuousClock.now >= $0 } ?? true }
    private func remember(_ id: String) {
        failures[id] = ContinuousClock.now.advanced(by: .seconds(5))
        if failures.count > 64 { failures.removeAll() }
    }
    private func dial(_ candidates: [NativePathCandidate], later: NativeLateDirects?, relayDelay: Duration, upgrade: Bool,
        workspace: NativeWorkspace, generation current: UUID) async throws -> NativeJSON {
        if await workspace.verifiedRevocation() != nil { throw NativeFailure.revoked }
        let ticket = await workspace.beginPathRound(cancelTransfers: !upgrade)
        let timeline = timeline
        return try await withThrowingTaskGroup(of: Outcome.self) { group in
            var dialed = Set<String>(), directs = 0
            func start(_ candidate: NativePathCandidate) {
                dialed.insert(candidate.id)
                if candidate.kind == .direct { directs += 1 }
                let ordinal = dialed.count
                group.addTask {
                    do {
                        if candidate.kind == .relay, relayDelay > .zero { try await Task.sleep(for: relayDelay) }
                        let connection = try await NativeHTTPConnection.$workspaceDirectDial.withValue(candidate.kind == .direct) { try await candidate.connect() }
                        guard !Task.isCancelled else { await connection.close(); return .path(candidate, nil) }
                        timeline?.record(.connect, path: candidate.kind, ordinal: ordinal)
                        let path = try await workspace.qualify(connection, ticket: ticket, kind: candidate.kind, candidateId: candidate.id, upgrade: upgrade, reopen: candidate.connect)
                        timeline?.record(.qualify, path: candidate.kind, ordinal: ordinal)
                        return .path(candidate, path)
                    } catch {
                        if !Task.isCancelled { timeline?.record(.connectFailed, path: candidate.kind, ordinal: ordinal) }
                        return .path(candidate, nil)
                    }
                }
            }
            for candidate in candidates { start(candidate) }
            if let later { group.addTask { .late(await later.wait()) } }
            var installed: NativeJSON?
            var revoked = false
            while let outcome = try await group.next() {
                switch outcome {
                case let .late(found):
                    guard installed == nil, !revoked, generation == current, !Task.isCancelled else { break }
                    for candidate in found.filter({ $0.kind == .direct && !dialed.contains($0.id) && usable($0) }) where directs < 2 {
                        start(candidate)
                    }
                case let .path(candidate, path):
                    if let path {
                        if installed == nil, !revoked, generation == current, !Task.isCancelled {
                            do {
                                installed = try await workspace.installQualified(path)
                                timeline?.record(.install, path: candidate.kind)
                                group.cancelAll()
                                await candidate.didInstall?()
                            } catch {
                                if (error as? NativeFailure) == .revoked { revoked = true; group.cancelAll() }
                            }
                        } else { await path.connection.close() }
                    } else if !Task.isCancelled, installed == nil, generation == current {
                        remember(candidate.id)
                    }
                }
                if await workspace.verifiedRevocation() != nil { revoked = true; group.cancelAll() }
            }
            if revoked { throw NativeFailure.revoked }
            guard generation == current, !Task.isCancelled, let installed else { throw NativeFailure.unavailable }
            return installed
        }
    }
}
