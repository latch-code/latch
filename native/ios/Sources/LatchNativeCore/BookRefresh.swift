import Foundation

/** One bounded owner refreshes signed books; metadata hints never replace verified key material. */
public actor NativeBookRefresher {
    private let workspace: NativeWorkspace
    private let persist: @Sendable (PreparedNativeDevice) async throws -> Void
    private let updated: @Sendable (PreparedNativeDevice) async -> Void
    private let failed: @Sendable (NativeFailure) async -> Void
    private var flight: Task<Void, Never>?
    private var generation = UUID()
    private struct Hint: Equatable { let discovery: String?; let directory: String?; let relay: String? }
    private var pending: Hint?
    private var attempted: Hint?
    private var forced = false
    private var closed = false
    public init(workspace: NativeWorkspace,
        persist: @escaping @Sendable (PreparedNativeDevice) async throws -> Void,
        updated: @escaping @Sendable (PreparedNativeDevice) async -> Void = { _ in },
        failed: @escaping @Sendable (NativeFailure) async -> Void = { _ in }) {
        self.workspace = workspace; self.persist = persist; self.updated = updated; self.failed = failed
    }
    public func observe(_ hint: String?, directoryHint: String? = nil, relayHint: String? = nil, force: Bool = false) {
        guard !closed else { return }
        let discovery = hint.flatMap { LinkBytes.matches($0, "[a-f0-9]{64}") ? $0 : nil }
        let directory = directoryHint.flatMap { LinkBytes.matches($0, "[a-f0-9]{64}") ? $0 : nil }
        let relay = relayHint.flatMap { LinkBytes.matches($0, "[a-f0-9]{64}") ? $0 : nil }
        if discovery != nil || directory != nil || relay != nil {
            pending = Hint(
                discovery: discovery ?? pending?.discovery,
                directory: directory ?? pending?.directory,
                relay: relay ?? pending?.relay
            )
        } else if !force { return }
        forced = forced || force
        guard flight == nil else { return }
        let current = generation
        flight = Task { await self.refresh(current) }
    }
    /** A new installed connection can retry a hint whose earlier request failed. No verification is requested here. */
    public func connectionChanged() { attempted = nil }
    public func close() async {
        closed = true; generation = UUID(); pending = nil; attempted = nil; forced = false
        let previous = flight; flight = nil; previous?.cancel(); await previous?.value
    }
    private func refresh(_ current: UUID) async {
        defer { if generation == current { flight = nil } }
        while !closed, !Task.isCancelled, generation == current {
            let hint = pending, force = forced
            pending = nil; forced = false
            guard let lease = await workspace.lease(), lease.valid else { return }
            let verifiedEpoch = try? await workspace.discoveryEpoch()
            let directoryEpoch = try? await workspace.directoryEpoch()
            let relayEpoch = try? await workspace.relayEpoch()
            let differs = hint.map { value in
                (value.discovery != nil && value.discovery != verifiedEpoch)
                    || (value.directory != nil && value.directory != directoryEpoch)
                    || (value.relay != nil && value.relay != relayEpoch)
            } ?? false
            guard force || (differs && hint != attempted) else { return }
            if let hint { attempted = hint }
            do {
                let value = try await workspace.refreshAddressBook(persist: persist)
                guard !closed, !Task.isCancelled, generation == current else { return }
                await updated(value)
            } catch {
                guard !closed, !Task.isCancelled, generation == current else { return }
                if let value = error as? NativeFailure, [.identityMismatch, .storageUnavailable, .expired].contains(value) { await failed(value) }
            }
            guard pending != nil || forced else { return }
        }
    }
}
