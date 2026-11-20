import Foundation

public struct NativePathCandidate: Sendable {
    public enum Kind: String, Sendable { case direct, relay }
    public let id: String
    public let kind: Kind
    public let connect: @Sendable () async throws -> NativeHTTPConnection
    public init(id: String, kind: Kind, connect: @escaping @Sendable () async throws -> NativeHTTPConnection) throws {
        guard LinkBytes.matches(id, "[A-Za-z0-9_-]{1,128}") else { throw NativeFailure.invalidRecord }
        self.id = id; self.kind = kind; self.connect = connect
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
        case path(String, NativePathCandidate.Kind, QualifiedNativePath?)
        case late([NativePathCandidate])
    }
    private var round: Task<NativeJSON, Error>?
    private var upgrading: Task<NativeJSON, Error>?
    private var generation = UUID()
    private var failures: [String: ContinuousClock.Instant] = [:]
    private weak var workspace: NativeWorkspace?
    private let timeline: NativeConnectionTimeline?
    public init(timeline: NativeConnectionTimeline? = nil) { self.timeline = timeline }
    public func networkChanged() async {
        failures.removeAll()
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
        workspace: NativeWorkspace) async throws -> NativeJSON {
        guard candidates.count <= 12 else { throw NativeFailure.invalidRecord }
        self.workspace = workspace
        let current = UUID(); generation = current
        let previous = round, upgrade = upgrading
        previous?.cancel(); upgrade?.cancel()
        if let previous { _ = await previous.result }
        if let upgrade { _ = await upgrade.result }
        guard generation == current, !Task.isCancelled else { throw NativeFailure.unavailable }
        round = nil; upgrading = nil
        let available = candidates.filter(usable)
        let directs = Array(available.filter { $0.kind == .direct }.prefix(2))
        let selected = directs + Array(available.filter { $0.kind == .relay }.prefix(1))
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
     * Moves an installed relay path to a direct one in the background. It never runs beside or pre-empts a dial round, and
     * a failure is silent: the relay stays installed. True when a direct path was installed.
     */
    public func upgrade(_ candidates: [NativePathCandidate], workspace: NativeWorkspace) async -> Bool {
        guard round == nil, upgrading == nil, candidates.count <= 12 else { return false }
        let directs = Array(candidates.filter { $0.kind == .direct && usable($0) }.prefix(2))
        guard !directs.isEmpty, await workspace.installedPathKind() == .relay, await workspace.quiet() else { return false }
        guard round == nil, upgrading == nil else { return false }
        self.workspace = workspace
        let current = generation
        let task = Task { try await self.dial(directs, later: nil, relayDelay: .zero, upgrade: true, workspace: workspace, generation: current) }
        upgrading = task
        let result = await task.result
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
                        let connection = try await candidate.connect()
                        guard !Task.isCancelled else { await connection.close(); return .path(candidate.id, candidate.kind, nil) }
                        timeline?.record(.connect, path: candidate.kind, ordinal: ordinal)
                        let path = try await workspace.qualify(connection, ticket: ticket, kind: candidate.kind, upgrade: upgrade, reopen: candidate.connect)
                        timeline?.record(.qualify, path: candidate.kind, ordinal: ordinal)
                        return .path(candidate.id, candidate.kind, path)
                    } catch {
                        if !Task.isCancelled { timeline?.record(.connectFailed, path: candidate.kind, ordinal: ordinal) }
                        return .path(candidate.id, candidate.kind, nil)
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
                case let .path(id, kind, path):
                    if let path {
                        if installed == nil, !revoked, generation == current, !Task.isCancelled {
                            do {
                                installed = try await workspace.installQualified(path)
                                timeline?.record(.install, path: kind)
                                group.cancelAll()
                            } catch {
                                if (error as? NativeFailure) == .revoked { revoked = true; group.cancelAll() }
                            }
                        } else { await path.connection.close() }
                    } else if !Task.isCancelled, installed == nil, generation == current {
                        remember(id)
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
