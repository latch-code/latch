import Foundation

/** One verified book source owns fetching and encrypted trust; it can recover addresses only for an existing book node. */
public actor NativeDirectoryResolver {
    public typealias Fetch = @Sendable (URL) async throws -> Data
    private let vault: EncryptedVault
    private let fetch: Fetch
    private let now: @Sendable () -> UInt64
    private var sourceId: Data?
    private var cache: NativeDirectoryCache?
    private var active: NativeDirectorySource?
    private var flight: Task<Void, Never>?
    private var scheduled: Task<Void, Never>?
    private var monitoring: Task<Void, Never>?
    private var paths: [UUID: (target: NativeDirectoryTarget, connection: NativeHTTPConnection)] = [:]
    private var nextAttempt: UInt64 = 0
    private var generation = UUID()
    private var closed = false
    public init(vault: EncryptedVault, fetch: @escaping Fetch = NativeDirectoryFetch.fetch,
        now: @escaping @Sendable () -> UInt64 = { UInt64(max(0, Date().timeIntervalSince1970 * 1000)) }) {
        self.vault = vault; self.fetch = fetch; self.now = now
    }
    public func configure(_ source: NativeDirectorySource?) async throws {
        guard !closed else { throw NativeFailure.unavailable }
        let id = try source.map { LinkBytes.hash(try $0.encoded()) }
        if id == sourceId { return }
        generation = UUID(); let current = generation
        scheduled?.cancel(); scheduled = nil
        let previous = flight; previous?.cancel(); await previous?.value
        guard generation == current, !closed, !Task.isCancelled else { throw NativeFailure.unavailable }
        flight = nil; active = nil; sourceId = nil
        guard let source else { try? await cache?.retryPersistence(); await sweep(); return }
        do {
            try await cache?.retryPersistence()
            let loaded = try await NativeDirectoryCache.open(source: source, storage: .encrypted(vault, source: source), now: now)
            guard generation == current, !closed, !Task.isCancelled else { throw NativeFailure.unavailable }
            cache = loaded; active = source; sourceId = id; nextAttempt = 0
            await sweep()
            guard generation == current, !closed else { throw NativeFailure.unavailable }
            schedule(after: 0, generation: current)
        } catch { await sweep(); throw error }
    }
    public func targets(for endpoint: NativeRelayAddress) async -> [NativeDirectoryTarget] {
        guard active != nil, !closed else { return [] }
        return await cache?.candidates(for: endpoint) ?? []
    }
    public func retain(_ connection: NativeHTTPConnection, target: NativeDirectoryTarget) async throws {
        await sweep()
        guard await permitted(target), paths.count < 4 else { await connection.close(); throw NativeFailure.unavailable }
        paths[UUID()] = (target, connection)
        if monitoring == nil {
            monitoring = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                    guard let self, await self.monitor() else { return }
                }
            }
        }
    }
    private func permitted(_ target: NativeDirectoryTarget) async -> Bool {
        guard !closed, active != nil else { return false }
        let current = generation
        let values = await cache?.candidates(for: target.endpoint) ?? []
        return generation == current && values.contains { $0.address == target.address && $0.endpoint.url == target.endpoint.url }
    }
    private func sweep() async {
        for (id, path) in paths {
            if await path.connection.isClosed() { await path.connection.close(); paths.removeValue(forKey: id) }
            else if !(await permitted(path.target)) {
                await path.connection.close(); paths.removeValue(forKey: id)
            }
        }
    }
    private func monitor() async -> Bool {
        await sweep()
        if closed || paths.isEmpty { monitoring = nil; return false }; return true
    }
    public func refresh() async {
        guard active != nil, !closed else { return }
        if let flight { await flight.value; return }
        guard now() >= nextAttempt, let cache, let source = active else { return }
        let current = generation
        let task = Task { await self.update(cache: cache, source: source, generation: current) }
        flight = task
        await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
        if generation == current { flight = nil }
    }
    private func update(cache: NativeDirectoryCache, source: NativeDirectorySource, generation current: UUID) async {
        nextAttempt = now() + 30_000
        var accepted = false
        for mirror in source.mirrors {
            guard generation == current, !closed, !Task.isCancelled else { return }
            do {
                let bytes = try await fetch(mirror)
                guard bytes.count <= 32_768, generation == current, !closed, !Task.isCancelled else { return }
                try await cache.adopt(bytes); accepted = true; break
            } catch { /* A bad mirror cannot replace a Root, clear an identity or reset a floor. */ }
        }
        await sweep()
        guard generation == current, !closed, !Task.isCancelled else { return }
        let wait: UInt64 = accepted ? UInt64(Double(6 * 3600_000) * Double.random(in: 0.9...1.1)) : 30_000
        nextAttempt = now() + wait; schedule(after: wait, generation: current)
    }
    private func schedule(after ms: UInt64, generation current: UUID) {
        scheduled?.cancel()
        scheduled = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(ms)) } catch { return }
            guard let self else { return }; await self.wake(generation: current)
        }
    }
    private func wake(generation current: UUID) async {
        guard generation == current, !closed else { return }; await refresh()
    }
    public func close() async {
        closed = true; generation = UUID()
        let timer = scheduled, monitor = monitoring
        timer?.cancel(); scheduled = nil; monitor?.cancel(); monitoring = nil
        let previous = flight; flight = nil; previous?.cancel(); await previous?.value
        await cache?.settled(); try? await cache?.retryPersistence(); active = nil; sourceId = nil
        await sweep()
        await timer?.value; await monitor?.value
    }
}
