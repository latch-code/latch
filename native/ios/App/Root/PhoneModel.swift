import Foundation
import LatchNativeCore
import Network
import SwiftUI
import UIKit

@MainActor final class PhoneModel: ObservableObject {
    @Published var hosts: [RegisteredHost] = []
    @Published var selectedHost: RegisteredHost?
    @Published var snapshot = NativeJSON.null { didSet { shelfCache = nil } }
    @Published var detail = NativeJSON.null { didSet { detailCached = false; if detail != .null { detailFailed = nil } } }
    /** The conversation on screen is what this window read before the Mac went away. */
    @Published var detailCached = false
    /** The session whose content could not be read, with the Mac still in reach. */
    @Published var detailFailed: String?
    @Published var previewProgress: PhonePreviewProgress?
    var previewJob: UUID?
    @Published var sessionId: String?
    @Published var pending: [NativePendingWrite] = []
    @Published var controlPending = NativeJSON.null
    @Published var draft: PairingDraft?
    /** The pairing flow on screen; nil when there is none. */
    @Published var pairing: PhonePairingPhase?
    /** The Mac removed this phone. */
    @Published var removedByMac = false
    @Published var status = "选择一台电脑"
    @Published var error: String?
    @Published var connected = false { didSet { if connected { offline = false; lastConfirmed = Date() } } }
    /** The store has answered, so an empty host list means this phone has none. */
    @Published var storeReady = false
    /** Reaching the Mac has failed at least once; the list shows what it last knew. */
    @Published var offline = false
    /** The last time this phone heard the Mac. */
    @Published var lastConfirmed: Date?
    /** The paths of stops and rejections this phone has sent and the Host has not answered yet. */
    @Published var controlsInFlight: Set<String> = []
    /** The core keeps one unconfirmed control at a time, so they go out in the order they were asked for. */
    var controlTail: Task<Void, Never>?
    /** Unsent text the composer took off the screen with a closed window, back when the next window opens. In memory only. */
    var heldDrafts: [String: String] = [:]
    private var shelfCache: (query: String, shelves: [PhoneShelf])?
    private var hostClockOffset: TimeInterval = 0
    /** Where to come back to after the App returns from the background: within this process only. */
    private var resumeSession: String?
    private var lastHostId: String?
    /** When a window that ran out last opened again by itself; a clock far off the Mac's cannot make it spin. */
    private var lastReopen: ContinuousClock.Instant?
    /** Drawn on every update of anything, so it is worked out once per list and search. */
    func shelves(query: String) -> [PhoneShelf] {
        if let shelfCache, shelfCache.query == query { return shelfCache.shelves }
        let value = PhoneSessions.shelves(tasks: snapshot["tasks"].array, workspaces: snapshot["catalog"]["workspaces"].array, query: query)
        shelfCache = (query, value)
        return value
    }
    func hostNow() -> Date { Date().addingTimeInterval(hostClockOffset) }
    @Published var busy = false
    @Published var verifying = false
    @Published var verifiedUntil: Date?
    @Published var contentGeneration = UUID()
    var canRun: Bool { connected && snapshot["device"]["status"].string == "active" && hasScope("run") }
    var canApproveStandard: Bool { connected && snapshot["device"]["status"].string == "active" && hasScope("approve:standard") }
    var canApproveElevated: Bool { connected && snapshot["device"]["status"].string == "active" && hasScope("approve:elevated") }
    func hasScope(_ scope: String) -> Bool { snapshot["device"]["scopes"].array.contains(.string(scope)) }
    private(set) var store: PhoneStore?
    private(set) var workspace: NativeWorkspace?
    let paths = NativePathOwner()
    private let discovery = NativeDiscovery()
    private(set) var generation = UUID()
    private(set) var networkGeneration = UUID()
    var freshPairings: [String: (PairingInvitation, UUID)] = [:]
    private var eventTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var streamGeneration = UUID()
    var previewing = false
    private var refreshId: UUID?
    private var pendingEvent: (NativeEvent, NativeWorkspaceEvents, String?)?
    private var expiryTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    var pairingTask: Task<Void, Never>?
    var pairingConnection: NativeHTTPConnection?
    private var monitor: NWPathMonitor?
    private var monitorGeneration = UUID()
    private(set) var currentNetworkPath: NWPath?
    private var proximityTask: Task<Void, Never>?
    private var bookRefresher: NativeBookRefresher?

    func open() async {
        guard store == nil, UIApplication.shared.isProtectedDataAvailable else { return }
        PreviewFiles.purgeAbandoned()
        let current = generation
        do {
            let opened = try await PhoneStore.open()
            guard generation == current, UIApplication.shared.applicationState != .background else { await opened.lock(); return }
            store = opened
            let saved = await opened.list(), pending = try await opened.draft()
            guard generation == current else { await opened.lock(); return }
            hosts = saved; draft = pending; storeReady = true
            observeNetwork()
            if pending != nil { resumePairing() }
            else { await connectLast() }
        } catch { storeReady = true; report(error) }
    }
    /** The Mac this phone last used, or the first saved one. */
    func connectLast() async {
        if let host = hosts.first(where: { $0.id == lastHostId }) ?? hosts.first { await connect(host) }
    }
    func lock() async {
        if let sessionId { resumeSession = sessionId }
        if let selectedHost { lastHostId = selectedHost.id }
        generation = UUID(); eventTask?.cancel(); refreshTask?.cancel(); expiryTask?.cancel(); reconnectTask?.cancel(); pairingTask?.cancel()
        monitorGeneration = UUID(); monitor?.cancel(); monitor = nil
        currentNetworkPath = nil; proximityTask?.cancel(); proximityTask = nil
        resetBookRefresh()
        discovery.stop(); freshPairings.removeAll()
        let previous = workspace, link = pairingConnection, previousStore = store
        store = nil; workspace = nil; pairingConnection = nil
        cancelPreview()
        detail = .null; snapshot = .null; verifiedUntil = nil; pairing = nil; pending = []; controlPending = .null; hosts = []; draft = nil; selectedHost = nil
        connected = false; offline = false; controlsInFlight = []; controlTail = nil; heldDrafts = [:]; storeReady = false; busy = false; verifying = false; status = "正在连接…"
        PreviewFiles.clear()
        await paths.close(); await previous?.closeOpening(); await link?.close(); await previousStore?.lock()
    }
    func connect(_ host: RegisteredHost) async {
        guard let store, !busy else { return }
        busy = true; defer { busy = false }
        generation = UUID(); let current = generation
        eventTask?.cancel(); expiryTask?.cancel(); reconnectTask?.cancel()
        resetBookRefresh()
        let previous = workspace; workspace = nil
        clearPrivateContent(); snapshot = .null; sessionId = nil; controlPending = .null; controlsInFlight = []; controlTail = nil; heldDrafts = [:]; verifiedUntil = nil; connected = false; offline = false
        let resume = resumeSession; resumeSession = nil
        selectedHost = host; lastHostId = host.id; status = "正在连接…"; error = nil
        await paths.close(); await previous?.closeOpening()
        guard generation == current else { return }
        do {
            let vault = try await store.hostVault(host)
            guard generation == current else { await vault.lock(); return }
            let next = try NativeWorkspace(device: host.device, keys: SecureIdentityProvider(reference: host.keys, askOwner: { PhoneFaceID.isOn }), vault: vault,
                onRevoked: { [weak self, store] proof in Task { @MainActor in await self?.retire(host, proof: proof, retiredStore: store) } })
            workspace = next
            bookRefresher = NativeBookRefresher(workspace: next, persist: { device in
                var saved = host; saved.device = device; saved.prepared = false
                try await store.save(saved)
                if let pending = try await store.draft(), pending.keys.connectionTag == host.keys.connectionTag,
                   pending.keys.verificationTag == host.keys.verificationTag { try await store.clearDraft(matching: pending.payload) }
            }, updated: { [weak self] device in
                await self?.receiveBook(device, host: host, store: store, current: current)
            }, failed: { [weak self] failure in
                await self?.bookFailed(failure, current: current)
            })
            if let cached = try await next.cachedSnapshot() {
                guard generation == current else { return }; adoptSnapshot(cached, live: false)
            }
            try startDiscovery(host)
            let candidates = try await candidates(host)
            let value = try await paths.migrate(candidates, workspace: next)
            guard generation == current else { return }
            adoptSnapshot(value); connected = true; status = "已连接"
            await refreshControlPending(); startEvents()
            if let resume, snapshot["tasks"].array.contains(where: { $0["id"].string == resume }) { await openSession(resume) }
        } catch {
            guard generation == current else { return }
            if let workspace, let proof = await workspace.verifiedRevocation() { await retire(host, proof: proof); return }
            connected = false; offline = true; status = "不在线"
            if !Self.outOfReach(error) { report(error) }
            startReconnect()
        }
    }
    func refreshControlPending() async {
        guard let workspace else { return }
        let current = generation
        do { let value = try await workspace.pendingControl(); if generation == current { controlPending = value ?? .null } }
        catch { if generation == current { report(error) } }
    }
    func retryControl() async {
        guard let workspace, !busy else { return }
        let current = generation
        busy = true; defer { if generation == current { busy = false } }
        do {
            guard let saved = try await workspace.pendingControl(), let path = saved["path"].string else { await refreshControlPending(); return }
            controlsInFlight.insert(path); defer { controlsInFlight.remove(path) }
            _ = try await workspace.freeAction(path: path, fields: saved["fields"].object)
            guard generation == current else { return }
            await refreshControlPending(); _ = await refresh()
        } catch { if generation == current { await refreshControlPending(); report(error) } }
    }
    func ensureVerified() async throws {
        guard let workspace else { throw NativeFailure.unavailable }
        guard hasScope("view") else { throw NativeFailure.forbidden }
        let current = generation
        if let lease = await workspace.lease() {
            try bindBodyLease(lease, current: current)
            let restored = try await workspace.pendingWrites()
            guard current == generation else { throw NativeFailure.expired }
            try lease.requireValid(); pending = restored
            return
        }
        verifying = true; defer { verifying = false }
        let lease = try await workspace.verify()
        try bindBodyLease(lease, current: current)
        let restored = try await workspace.pendingWrites()
        guard current == generation else { throw NativeFailure.expired }
        try lease.requireValid(); pending = restored
        startEvents()
        scheduleBookRefresh(hint: snapshot["host"]["native"]["discoveryEpoch"].string, directoryHint: snapshot["host"]["native"]["directoryEpoch"].string, force: true)
        scheduleProximity(workspace)
    }
    private func bindBodyLease(_ lease: BodyLease, current: UUID) throws {
        guard current == generation else { throw NativeFailure.expired }; try lease.requireValid()
        verifiedUntil = lease.verifiedUntil; expiryTask?.cancel()
        expiryTask = Task {
            do { try await lease.waitForInvalidation() } catch { return }
            guard !Task.isCancelled, current == generation else { return }
            clearPrivateContent(); verifiedUntil = nil
            eventTask?.cancel(); startEvents()
            // Its own task: opening binds a new lease, which cancels this one.
            if PhoneUnlock.reopensAtExpiry(faceID: PhoneFaceID.isOn) { Task { await reopenContent(current) } }
        }
    }
    /** What was on screen when its window ran out comes back without a tap; nothing asks the person. */
    private func reopenContent(_ current: UUID) async {
        guard current == generation, connected, verifiedUntil == nil, !verifying else { return }
        if let lastReopen, lastReopen.duration(to: .now) < .seconds(60) { return }
        lastReopen = .now
        if let sessionId { await openSession(sessionId) }
    }
    @discardableResult func refresh() async -> Bool {
        guard let workspace else { return false }
        let current = generation, selected = sessionId
        do {
            let lease = await workspace.lease()
            guard current == generation else { return false }
            if let lease { try bindBodyLease(lease, current: current) }
            else {
                if verifiedUntil != nil { clearPrivateContent() }
                else { detail = .null; pending = []; PreviewFiles.clear() }
                verifiedUntil = nil
            }
            let value = try await workspace.snapshot()
            guard current == generation else { return false }; adoptSnapshot(value)
            await refreshControlPending()
            guard current == generation else { return false }
            if let selected, lease?.valid == true {
                let reading = contentGeneration
                let value = try await workspace.detail(selected)
                guard current == generation, sessionId == selected, contentGeneration == reading, lease?.valid == true else { return false }; detail = value
            }
            return true
        } catch {
            guard current == generation else { return false }
            if !wentAway(error) {
                report(error)
                if selected == sessionId, detail == .null, verifiedUntil != nil { detailFailed = selected }
            }
            return false
        }
    }
    /** A read that never came back says only that the Mac is out of reach, in the words of a request or of the connection. */
    static func outOfReach(_ failure: Error) -> Bool {
        [NativeFailure.unavailable, .resultUnknown].contains(failure as? NativeFailure)
    }
    /** Going away is the banner's to say, not an alert's; true when that is what this failure was. */
    @discardableResult func wentAway(_ failure: Error) -> Bool {
        guard Self.outOfReach(failure) else { return false }
        if connected { connected = false; offline = true; status = "不在线"; startReconnect() }
        return true
    }
    func startEvents() {
        eventTask?.cancel()
        refreshTask?.cancel(); refreshTask = nil; refreshId = nil; pendingEvent = nil
        streamGeneration = UUID()
        guard let workspace else { return }
        let current = generation, selected = verifiedUntil != nil ? sessionId : nil, streamId = streamGeneration
        eventTask = Task {
            do {
                // The Host offers metadata snapshots without a body window, never an unverified SSE stream.
                if await workspace.lease() == nil {
                    while !Task.isCancelled, generation == current, streamGeneration == streamId {
                        try await Task.sleep(for: .seconds(15))
                        guard !Task.isCancelled, generation == current, streamGeneration == streamId else { return }
                        guard await refresh() else { throw NativeFailure.unavailable }
                    }
                    return
                }
                let stream = try await workspace.events(sessionId: selected)
                defer { Task { await stream.cancel() } }
                for try await event in stream.events {
                    guard !Task.isCancelled, generation == current, streamGeneration == streamId else { return }
                    if try await workspace.accepts(event, from: stream, sessionId: selected) {
                        pendingEvent = (event, stream, selected)
                        scheduleEventRefresh(workspace: workspace, generation: current, stream: streamId)
                    }
                }
            } catch {
                guard !Task.isCancelled, generation == current, streamGeneration == streamId else { return }
                if (error as? NativeFailure) == .eventOverflow {
                    try? await workspace.forgetCursor(sessionId: selected)
                    if await refresh() { startEvents() }
                    return
                }
                connected = false; offline = true; status = "不在线"; startReconnect()
            }
        }
    }
    private func scheduleEventRefresh(workspace: NativeWorkspace, generation current: UUID, stream streamId: UUID) {
        guard refreshTask == nil else { return }
        let id = UUID(); refreshId = id
        refreshTask = Task {
            defer { if refreshId == id { refreshId = nil; refreshTask = nil } }
            do {
                while pendingEvent != nil {
                    try await Task.sleep(for: .milliseconds(100))
                    guard current == generation, streamGeneration == streamId, let (event, source, selected) = pendingEvent else { return }
                    pendingEvent = nil
                    let value = event.data.isEmpty ? NativeJSON.null : try NativeJSON.decode(event.data)
                    if value["resumeRequired"].bool { try await workspace.forgetCursor(sessionId: selected) }
                    guard await refresh(), current == generation, streamGeneration == streamId else { return }
                    let applied = selected == nil ? snapshot["revision"].integer : detail["sync"]["revision"].integer
                    guard let applied else { return }
                    try await workspace.acknowledge(event, from: source, sessionId: selected, appliedRevision: applied)
                }
            } catch { if !(error is CancellationError), current == generation { report(error) } }
        }
    }
    /** Reconnecting is automatic; this only starts the next try now. */
    func retryConnection() {
        reconnectTask?.cancel(); reconnectTask = nil
        if let selectedHost, workspace == nil { Task { await connect(selectedHost) } } else { startReconnect() }
    }
    private func startReconnect() {
        guard reconnectTask == nil, let workspace, let host = selectedHost else { return }
        let current = generation
        reconnectTask = Task {
            defer { reconnectTask = nil }
            for attempt in 0..<1000 {
                do {
                    let delay = min(30.0, 0.5 * pow(2, Double(min(attempt, 6))))
                    try await Task.sleep(for: .seconds(delay + Double.random(in: 0...delay / 4)))
                    guard current == generation else { return }
                    let available = try await candidates(host)
                    let value = try await paths.migrate(available, workspace: workspace)
                    guard current == generation else { return }
                    await bookRefresher?.connectionChanged()
                    guard current == generation else { return }
                    if let lease = await workspace.lease() { try bindBodyLease(lease, current: current) }
                    guard current == generation else { return }
                    adoptSnapshot(value); connected = true; status = "已连接"
                    _ = await refresh(); startEvents(); scheduleProximity(workspace); return
                } catch {
                    if Task.isCancelled || current != generation { return }
                    if let proof = await workspace.verifiedRevocation() { await retire(host, proof: proof); return }
                }
            }
        }
    }
    private func observeNetwork() {
        let next = NWPathMonitor(); monitor = next
        monitorGeneration = UUID(); let current = monitorGeneration
        next.pathUpdateHandler = { [weak self] path in Task { @MainActor in
            guard let self, self.monitorGeneration == current else { return }
            self.currentNetworkPath = path; self.proximityTask?.cancel(); self.proximityTask = nil
            self.networkGeneration = UUID(); self.freshPairings.removeAll(); self.discovery.stop()
            if let host = self.selectedHost { try? self.startDiscovery(host) }
            await self.paths.networkChanged()
            self.reconnectTask?.cancel(); self.reconnectTask = nil
            if self.selectedHost != nil { self.startReconnect() }
        } }
        next.start(queue: DispatchQueue(label: "app.latch.path-monitor"))
    }
    private func scheduleProximity(_ workspace: NativeWorkspace) {
        proximityTask?.cancel()
        guard let path = currentNetworkPath else { return }
        let hashes = NativeDiscoveryWire.currentGatewayHashes(path), current = generation, network = networkGeneration
        guard !hashes.isEmpty else { return }
        proximityTask = Task { [weak self] in
            for hash in hashes {
                guard let self, !Task.isCancelled, self.generation == current, self.networkGeneration == network else { return }
                if await workspace.noteProximity(gatewayHash: hash) { return }
            }
        }
    }
    private func resetBookRefresh() {
        let previous = bookRefresher; bookRefresher = nil
        Task { await previous?.close() }
    }
    private func scheduleBookRefresh(hint: String?, directoryHint: String? = nil, force: Bool = false) {
        guard let bookRefresher else { return }
        Task { await bookRefresher.observe(hint, directoryHint: directoryHint, force: force) }
    }
    private func receiveBook(_ device: PreparedNativeDevice, host: RegisteredHost, store: PhoneStore, current: UUID) async {
        guard generation == current else { return }
        let savedHosts = await store.list()
        let pendingDraft = try? await store.draft()
        guard generation == current else { return }
        let previous = selectedHost ?? host
        let now = UInt64(Date().timeIntervalSince1970 * 1000)
        let oldKey = try? AddressBookCodec.discoveryKey(previous.device.signedAddressBook, rootSpki: previous.device.rootSpki,
            deviceId: previous.device.deviceId, nowMs: now, priorGeneration: previous.device.bookGeneration, priorHash: previous.device.bookHash)
        let oldBook = try? AddressBookCodec.verify(previous.device.signedAddressBook, rootSpki: previous.device.rootSpki,
            deviceId: previous.device.deviceId, nowMs: now, priorGeneration: previous.device.bookGeneration, priorHash: previous.device.bookHash)
        let newBook = try? AddressBookCodec.verify(device.signedAddressBook, rootSpki: device.rootSpki,
            deviceId: device.deviceId, nowMs: now, priorGeneration: device.bookGeneration, priorHash: device.bookHash)
        var saved = host; saved.device = device; saved.prepared = false
        selectedHost = saved; hosts = savedHosts; draft = pendingDraft
        guard let newBook, NativeBookPathChange.requiresMigration(previous: oldBook, current: newBook), let workspace else { return }
        do {
            if oldKey != newBook.discoveryKey { try startDiscovery(saved) }
            let value = try await paths.migrate(candidates(saved), workspace: workspace)
            guard generation == current else { return }
            await bookRefresher?.connectionChanged()
            guard generation == current else { return }
            if let lease = await workspace.lease() { try bindBodyLease(lease, current: current) }
            guard generation == current else { return }
            adoptSnapshot(value); connected = true; status = "已连接"
            _ = await refresh(); startEvents()
        } catch { if generation == current, !Task.isCancelled { startReconnect() } }
    }
    private func bookFailed(_ failure: NativeFailure, current: UUID) {
        if generation == current, !wentAway(failure) { report(failure) }
    }
    private func startDiscovery(_ host: RegisteredHost) throws {
        let key = try AddressBookCodec.discoveryKey(host.device.signedAddressBook, rootSpki: host.device.rootSpki,
            deviceId: host.device.deviceId, nowMs: UInt64(Date().timeIntervalSince1970 * 1000), priorGeneration: host.device.bookGeneration, priorHash: host.device.bookHash)
        try discovery.start(key: key)
    }
    func candidates(_ host: RegisteredHost) async throws -> [NativePathCandidate] {
        let host = hosts.first { $0.id == host.id } ?? host
        let now = UInt64(Date().timeIntervalSince1970 * 1000)
        let book = try? AddressBookCodec.verify(host.device.signedAddressBook, rootSpki: host.device.rootSpki,
            deviceId: host.device.deviceId, nowMs: now, priorGeneration: host.device.bookGeneration, priorHash: host.device.bookHash)
        let keys = SecureIdentityProvider(reference: host.keys)
        // LAN entries are hints only. Direct candidates are supplied by current-network discovery, never old private IPs.
        var result = try await discovery.candidates(device: host.device, keys: keys)
        if let (invitation, network) = freshPairings[host.id], network == networkGeneration, invitation.expiresAt > Date() {
            for (index, address) in invitation.lan.enumerated() {
                result.append(try NativePathCandidate(id: "pair-\(index)", kind: .direct) { [weak self] in
                    guard let self, await self.freshRoute(host.id, network: network) else { throw NativeFailure.unavailable }
                    return try await NativeHTTPConnection.open(host: address.host, port: address.port, rootSpki: host.device.rootSpki,
                        knockKey: host.device.knockKey, identity: keys.identity())
                })
            }
        }
        for endpoint in book?.relays ?? [] {
            let expiresAt = book?.expiresAt ?? 0
            guard (try? NativeRelayAdmission.current(endpoint: endpoint, bookExpiresAt: expiresAt, nowMs: now)) != nil else { continue }
            guard let workspace else { throw NativeFailure.unavailable }
            result.append(try await workspace.relayCandidate(relayId: endpoint.relayId))
        }
        return Array(result.prefix(12))
    }
    private func freshRoute(_ id: String, network: UUID) -> Bool {
        network == networkGeneration && (freshPairings[id]?.0.expiresAt ?? .distantPast) > Date()
    }
    func retire(_ host: RegisteredHost, proof: VerifiedNativeRevocation, retiredStore: PhoneStore? = nil, removedHere: Bool = false) async {
        let currentStore = retiredStore ?? store, isCurrent = selectedHost?.id == host.id
        if isCurrent {
            generation = UUID(); reconnectTask?.cancel(); eventTask?.cancel(); expiryTask?.cancel()
            clearPrivateContent(); controlPending = .null; snapshot = .null; verifiedUntil = nil; selectedHost = nil; connected = false
            PreviewFiles.clear(); discovery.stop(); freshPairings.removeValue(forKey: host.id)
            let old = workspace; workspace = nil
            await paths.close(); await old?.closeOpening()
        }
        do {
            try await currentStore?.retire(host, proof: proof)
            if let store, store === currentStore {
                let saved = await store.list()
                if self.store === store { hosts = saved }
            }
        }
        catch { report(error) }
        if isCurrent || selectedHost == nil {
            removedByMac = !removedHere
            status = "选择一台电脑"
            if let next = hosts.first { await connect(next) }
        }
    }
    func report(_ failure: Error) {
        guard !(failure is CancellationError) else { return }
        if (failure as? NativeFailure) == .expired {
            // The conversation offers the way back in; a closed window is not an error to report.
            verifiedUntil = nil; clearPrivateContent(); startEvents()
            return
        } else if (failure as? NativeFailure) == .forbidden || (failure as? NativeFailure) == .contextChanged { clearPrivateContent() }
        error = (failure as? NativeFailure)?.errorDescription ?? "暂时无法完成，请稍后重试。"
    }
    private func clearPrivateContent() {
        cancelPreview()
        detail = .null; detailFailed = nil; pending = []; contentGeneration = UUID(); PreviewFiles.clear()
    }
    private func adoptSnapshot(_ value: NativeJSON, live: Bool = true) {
        if let instance = value["instanceId"].string, snapshot["instanceId"].string == instance,
           let revision = value["revision"].integer, let applied = snapshot["revision"].integer, revision < applied { return }
        let keys = ["status", "scopes", "dataScope"]
        if snapshot != .null, keys.contains(where: { snapshot["device"][$0] != value["device"][$0] }) { clearPrivateContent(); heldDrafts = [:] }
        snapshot = value
        if let hostTime = PhoneTime.parse(value["hostTime"]) {
            // A cached list is old by definition: it says when it was true, not what the Host's clock reads now.
            if live { hostClockOffset = hostTime.timeIntervalSinceNow; lastConfirmed = Date() } else { lastConfirmed = hostTime }
        } else if live { lastConfirmed = Date() }
        scheduleBookRefresh(hint: value["host"]["native"]["discoveryEpoch"].string, directoryHint: value["host"]["native"]["directoryEpoch"].string)
    }
}
