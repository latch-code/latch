import Foundation

public struct NativePathCandidate: Sendable {
    public enum Kind: Sendable { case direct, relay }
    public let id: String
    public let kind: Kind
    public let connect: @Sendable () async throws -> NativeHTTPConnection
    public init(id: String, kind: Kind, connect: @escaping @Sendable () async throws -> NativeHTTPConnection) throws {
        guard LinkBytes.matches(id, "[A-Za-z0-9_-]{1,128}") else { throw NativeFailure.invalidRecord }
        self.id = id; self.kind = kind; self.connect = connect
    }
}

/** The sole dial owner: two direct slots and one delayed relay slot, finite negative memory, and generation cancellation. */
public actor NativePathOwner {
    private var round: Task<NativeJSON, Error>?
    private var generation = UUID()
    private var failures: [String: ContinuousClock.Instant] = [:]
    private weak var workspace: NativeWorkspace?
    public init() {}
    public func networkChanged() async {
        failures.removeAll()
        let current = UUID(); generation = current
        let previous = round
        previous?.cancel()
        await workspace?.cancelFileTransfer()
        if let previous { _ = await previous.result }
        if generation == current { round = nil }
    }
    public func close() async { await networkChanged() }
    public func migrate(_ candidates: [NativePathCandidate], workspace: NativeWorkspace) async throws -> NativeJSON {
        guard candidates.count <= 12 else { throw NativeFailure.invalidRecord }
        self.workspace = workspace
        let current = UUID(); generation = current
        let previous = round
        previous?.cancel()
        if let previous { _ = await previous.result }
        guard generation == current, !Task.isCancelled else { throw NativeFailure.unavailable }
        round = nil
        let available = candidates.filter { failures[$0.id].map { ContinuousClock.now >= $0 } ?? true }
        let selected = Array(available.filter { $0.kind == .direct }.prefix(2)) + Array(available.filter { $0.kind == .relay }.prefix(1))
        guard !selected.isEmpty else { throw NativeFailure.unavailable }
        let task = Task { try await self.dial(selected, workspace: workspace, generation: current) }
        round = task
        do {
            let result = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: { task.cancel() }
            guard generation == current else { throw NativeFailure.unavailable }
            round = nil; return result
        } catch { if generation == current { round = nil }; throw error }
    }
    private func dial(_ candidates: [NativePathCandidate], workspace: NativeWorkspace, generation current: UUID) async throws -> NativeJSON {
        if await workspace.verifiedRevocation() != nil { throw NativeFailure.revoked }
        let ticket = await workspace.beginPathRound()
        return try await withThrowingTaskGroup(of: (String, QualifiedNativePath?).self) { group in
            for candidate in candidates {
                group.addTask {
                    do {
                        if candidate.kind == .relay { try await Task.sleep(for: .milliseconds(250)) }
                        let connection = try await candidate.connect()
                        guard !Task.isCancelled else { await connection.close(); return (candidate.id, nil) }
                        return (candidate.id, try await workspace.qualify(connection, ticket: ticket, reopen: candidate.connect))
                    } catch { return (candidate.id, nil) }
                }
            }
            var installed: NativeJSON?
            var revoked = false
            while let (id, path) = try await group.next() {
                if let path {
                    if installed == nil, !revoked, generation == current, !Task.isCancelled {
                        do {
                            installed = try await workspace.installQualified(path)
                            group.cancelAll()
                        } catch {
                            if (error as? NativeFailure) == .revoked { revoked = true; group.cancelAll() }
                        }
                    } else { await path.connection.close() }
                } else if !Task.isCancelled, installed == nil, generation == current {
                    failures[id] = ContinuousClock.now.advanced(by: .seconds(5))
                    if failures.count > 64 { failures.removeAll() }
                }
                if await workspace.verifiedRevocation() != nil { revoked = true; group.cancelAll() }
            }
            if revoked { throw NativeFailure.revoked }
            guard generation == current, !Task.isCancelled, let installed else { throw NativeFailure.unavailable }
            return installed
        }
    }
}
