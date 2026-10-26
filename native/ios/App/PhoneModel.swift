import Foundation
import LatchNativeCore
import Network
import SwiftUI
import UIKit

@MainActor final class PhoneModel: ObservableObject {
    @Published var hosts: [RegisteredHost] = []
    @Published var selectedHost: RegisteredHost?
    @Published var snapshot = NativeJSON.null
    @Published var detail = NativeJSON.null
    @Published var sessionId: String?
    @Published var pending: [NativePendingWrite] = []
    @Published var draft: PairingDraft?
    @Published var comparisonCode: String?
    @Published var status = "选择一台电脑"
    @Published var error: String?
    @Published var connected = false
    @Published var busy = false
    @Published var verifying = false
    @Published var verifiedUntil: Date?
    @Published var contentGeneration = UUID()
    var currentSummary: NativeJSON { snapshot["tasks"].array.first { $0["id"].string == sessionId } ?? detail["summary"] }
    var canRun: Bool { connected && snapshot["device"]["status"].string == "active" && hasScope("run") && !snapshot["host"]["native"]["inputsPaused"].bool }
    var canApproveStandard: Bool { connected && snapshot["device"]["status"].string == "active" && hasScope("approve:standard") && !snapshot["host"]["native"]["inputsPaused"].bool }
    private func hasScope(_ scope: String) -> Bool { snapshot["device"]["scopes"].array.contains(.string(scope)) }
    private var store: PhoneStore?
    private var workspace: NativeWorkspace?
    private let paths = NativePathOwner()
    private let discovery = NativeDiscovery()
    private var generation = UUID()
    private var networkGeneration = UUID()
    private var freshPairings: [String: (PairingInvitation, UUID)] = [:]
    private var eventTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var streamGeneration = UUID()
    private var previewing = false
    private var refreshId: UUID?
    private var pendingEvent: (NativeEvent, NativeWorkspaceEvents, String?)?
    private var expiryTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var pairingTask: Task<Void, Never>?
    private var pairingConnection: NativeHTTPConnection?
    private var monitor: NWPathMonitor?
    private var monitorGeneration = UUID()
    private var currentNetworkPath: NWPath?
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
            hosts = saved; draft = pending
            observeNetwork()
        } catch { report(error) }
    }
    func lock() async {
        generation = UUID(); eventTask?.cancel(); refreshTask?.cancel(); expiryTask?.cancel(); reconnectTask?.cancel(); pairingTask?.cancel()
        monitorGeneration = UUID(); monitor?.cancel(); monitor = nil
        currentNetworkPath = nil; proximityTask?.cancel(); proximityTask = nil
        resetBookRefresh()
        discovery.stop(); freshPairings.removeAll()
        let previous = workspace, pairing = pairingConnection, previousStore = store
        store = nil; workspace = nil; pairingConnection = nil
        detail = .null; snapshot = .null; verifiedUntil = nil; comparisonCode = nil; pending = []; hosts = []; draft = nil; selectedHost = nil
        connected = false; busy = false; verifying = false; status = "已锁定，解锁后重新连接"
        PreviewFiles.clear()
        await paths.close(); await previous?.closeOpening(); await pairing?.close(); await previousStore?.lock()
    }
    func connect(_ host: RegisteredHost) async {
        guard let store, !busy else { return }
        busy = true; defer { busy = false }
        generation = UUID(); let current = generation
        eventTask?.cancel(); expiryTask?.cancel(); reconnectTask?.cancel()
        resetBookRefresh()
        let previous = workspace; workspace = nil
        clearPrivateContent(); snapshot = .null; sessionId = nil; verifiedUntil = nil; connected = false
        selectedHost = host; status = "正在连接…"; error = nil
        await paths.close(); await previous?.closeOpening()
        guard generation == current else { return }
        do {
            let vault = try await store.hostVault(host)
            guard generation == current else { await vault.lock(); return }
            let next = try NativeWorkspace(device: host.device, keys: SecureIdentityProvider(reference: host.keys), vault: vault,
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
                guard generation == current else { return }; adoptSnapshot(cached)
            }
            try startDiscovery(host)
            let candidates = try await candidates(host)
            let value = try await paths.migrate(candidates, workspace: next)
            guard generation == current else { return }
            adoptSnapshot(value); connected = true; status = "已连接"
            startEvents()
        } catch {
            guard generation == current else { return }
            if let workspace, let proof = await workspace.verifiedRevocation() { await retire(host, proof: proof); return }
            connected = false; status = "正在等待电脑连接…"
            if (error as? NativeFailure) != .unavailable { report(error) }
            startReconnect()
        }
    }
    func beginPairing(payload: String, name: String) async {
        guard let store, !busy else { return }
        busy = true; defer { if pairingTask == nil { busy = false } }
        let current = generation
        do {
            _ = try PairingInvitation.parse(payload)
            if draft != nil { throw NativeFailure.resultUnknown }
            let keys = try SecureDeviceKeys.create(), next = PairingDraft(payload: payload, keys: keys, name: name)
            do { try await store.saveDraft(next) }
            catch { SecureDeviceKeys.remove(keys); throw error }
            guard current == generation else { return }
            draft = next; busy = false; resumePairing()
        } catch { report(error) }
    }
    func resumePairing() {
        guard let draft, let store, pairingTask == nil else { return }
        error = nil; busy = true
        let current = generation
        pairingTask = Task {
            var owned: NativeHTTPConnection?
            defer { if generation == current { busy = false }; pairingTask = nil }
            do {
                let invitation = try PairingInvitation.parse(draft.payload), keys = SecureIdentityProvider(reference: draft.keys)
                let connection = try await pairingTransport(invitation)
                owned = connection
                guard generation == current, !Task.isCancelled else { await connection.close(); return }
                pairingConnection = connection
                let pairing = try NativePairing(invitation: invitation, keys: keys)
                let enrollment = try await pairing.begin(on: connection, name: UIDevice.current.name)
                guard current == generation, !Task.isCancelled else { await connection.close(); return }
                comparisonCode = enrollment.comparisonCode; status = "请在 Mac 输入这组六位码并确认"
                for _ in 0..<600 {
                    try Task.checkCancellation()
                    guard let view = try await pairing.status(on: connection) else { throw NativeFailure.unavailable }
                    if ["approved", "completed"].contains(view.status) {
                        let device = try await pairing.complete(on: connection) { device in
                            try await store.save(RegisteredHost(name: draft.name, device: device, keys: draft.keys, prepared: true))
                        }
                        let saved = RegisteredHost(name: draft.name, device: device, keys: draft.keys, prepared: false)
                        try await store.save(saved); try await store.clearDraft(matching: draft.payload)
                        guard current == generation, !Task.isCancelled else { await connection.close(); return }
                        hosts = await store.list(); self.draft = nil; comparisonCode = nil; status = "电脑已登记"
                        freshPairings[saved.id] = (invitation, networkGeneration)
                        await connection.close(); pairingConnection = nil
                        busy = false; await connect(saved)
                        return
                    }
                    guard view.status == "pending" else { throw NativeFailure.expired }
                    try await Task.sleep(for: .seconds(1))
                }
                throw NativeFailure.expired
            } catch {
                if generation != current || Task.isCancelled { await owned?.close(); return }
                comparisonCode = nil
                if (error as? NativeFailure) == .expired {
                    do {
                        try await store.abandonDraft()
                        if generation == current { self.draft = nil; comparisonCode = nil; self.error = "配对资料已过期，请重新扫描电脑上的二维码。" }
                    } catch { report(error) }
                } else { report(error) }
                await owned?.close()
                if pairingConnection === owned { pairingConnection = nil }
            }
        }
    }
    func openSession(_ id: String) async {
        guard let workspace else { return }
        let current = generation
        let reading = UUID()
        sessionId = id; detail = .null; contentGeneration = reading; PreviewFiles.clear()
        do {
            try await ensureVerified()
            guard current == generation, sessionId == id, contentGeneration == reading,
                  let lease = await workspace.lease() else { return }
            let value = try await workspace.detail(id)
            guard current == generation, sessionId == id, contentGeneration == reading else { return }
            try lease.requireValid()
            detail = value; startEvents()
        } catch { report(error) }
    }
    func ensureVerified() async throws {
        guard let workspace, !verifying else { throw NativeFailure.unavailable }
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
        scheduleBookRefresh(hint: snapshot["host"]["native"]["discoveryEpoch"].string, force: true)
        scheduleProximity(workspace)
    }
    private func bindBodyLease(_ lease: BodyLease, current: UUID) throws {
        guard current == generation else { throw NativeFailure.expired }; try lease.requireValid()
        verifiedUntil = lease.verifiedUntil; expiryTask?.cancel()
        expiryTask = Task {
            do { try await lease.waitForInvalidation() } catch { return }
            guard !Task.isCancelled, current == generation else { return }
            clearPrivateContent(); verifiedUntil = nil
            status = "解锁后继续"; eventTask?.cancel(); startEvents()
        }
    }
    @discardableResult func send(text: String, queue: Bool = false) async -> Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 16_000 else { return false }
        let current = generation
        do {
            guard canRun else { throw NativeFailure.forbidden }
            try await ensureVerified()
            guard current == generation else { return false }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            let path = sessionId.map { "/link/api/tasks/" + $0 + "/prompt" } ?? "/link/api/tasks"
            var fields: [String: NativeJSON] = ["prompt": .string(text)]
            if queue { fields["queue"] = .bool(true) }
            else if sessionId == nil { fields["mode"] = .string("agent") }
            return await submit(try NativePendingWrite(method: .post, path: path, fields: fields))
        } catch { report(error); return false }
    }
    @discardableResult func submit(_ request: NativePendingWrite) async -> Bool {
        guard let workspace, !busy else { return false }
        let current = generation
        do { try await ensureVerified() } catch { report(error); return false }
        guard current == generation else { return false }
        busy = true; defer { busy = false }
        do {
            if !pending.contains(where: { $0.requestId == request.requestId }) { pending.append(request) }
            let value = try await workspace.submit(request)
            guard generation == current else { return true }
            pending.removeAll { $0.requestId == request.requestId }
            if let id = value["sessionId"].string { sessionId = id }
            await refresh()
            return true
        } catch {
            guard generation == current else { return (error as? NativeFailure) == .resultUnknown }
            if (error as? NativeFailure) != .resultUnknown { pending.removeAll { $0.requestId == request.requestId } }
            report(error)
            return (error as? NativeFailure) == .resultUnknown
        }
    }
    func mutate(_ method: NativeHTTPMethod, path: String, fields: [String: NativeJSON]) async {
        let current = generation
        do {
            guard (path.hasPrefix("/link/api/approvals/") ? canApproveStandard : canRun) else { throw NativeFailure.forbidden }
            try await ensureVerified()
            guard current == generation else { return }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            await submit(try NativePendingWrite(method: method, path: path, fields: fields))
        }
        catch { report(error) }
    }
    func stop() async {
        guard let workspace, let id = sessionId else { return }
        var fields: [String: NativeJSON] = ["requestId": .string(UUID().uuidString)]
        let summary = snapshot["tasks"].array.first { $0["id"].string == id } ?? detail["summary"]
        if let run = summary["runId"].string { fields["runId"] = .string(run) }
        do { _ = try await workspace.freeAction(path: "/link/api/tasks/\(id)/cancel", fields: fields); await refresh() }
        catch { report(error) }
    }
    func reject(_ id: String) async {
        guard let workspace else { return }
        do { _ = try await workspace.freeAction(path: "/link/api/approvals/" + id, fields: ["decision": .string("reject"), "requestId": .string(UUID().uuidString)]); await refresh() }
        catch { report(error) }
    }
    func pauseInput() async {
        guard let workspace else { return }
        do { _ = try await workspace.freeAction(path: "/link/api/native/input/pause", fields: [:]); await refresh() }
        catch { report(error) }
    }
    func newSession() { sessionId = nil; detail = .null; contentGeneration = UUID(); PreviewFiles.clear(); startEvents() }
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
            if let selected, lease?.valid == true {
                let reading = contentGeneration
                let value = try await workspace.detail(selected)
                guard current == generation, sessionId == selected, contentGeneration == reading, lease?.valid == true else { return false }; detail = value
            }
            return true
        } catch { report(error); return false }
    }
    func preview(reference: String, root: String?) async throws -> PreviewItem {
        guard !previewing, let workspace, let sessionId else { throw NativeFailure.unavailable }
        previewing = true; defer { previewing = false }
        try await ensureVerified()
        return try await PreviewFiles.load(reference: reference, root: root, session: sessionId, workspace: workspace)
    }
    private func startEvents() {
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
                connected = false; status = "连接已断开，正在重连…"; startReconnect()
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
    private func scheduleBookRefresh(hint: String?, force: Bool = false) {
        guard let bookRefresher else { return }
        Task { await bookRefresher.observe(hint, force: force) }
    }
    private func receiveBook(_ device: PreparedNativeDevice, host: RegisteredHost, store: PhoneStore, current: UUID) async {
        guard generation == current else { return }
        let savedHosts = await store.list()
        let pendingDraft = try? await store.draft()
        guard generation == current else { return }
        var saved = host; saved.device = device; saved.prepared = false
        selectedHost = saved; hosts = savedHosts; draft = pendingDraft
    }
    private func bookFailed(_ failure: NativeFailure, current: UUID) {
        if generation == current { report(failure) }
    }
    private func startDiscovery(_ host: RegisteredHost) throws {
        let key = try AddressBookCodec.discoveryKey(host.device.signedAddressBook, rootSpki: host.device.rootSpki,
            deviceId: host.device.deviceId, nowMs: UInt64(Date().timeIntervalSince1970 * 1000), priorGeneration: host.device.bookGeneration, priorHash: host.device.bookHash)
        try discovery.start(key: key)
    }
    private func candidates(_ host: RegisteredHost) async throws -> [NativePathCandidate] {
        let host = hosts.first { $0.id == host.id } ?? host
        let now = UInt64(Date().timeIntervalSince1970 * 1000)
        let book = try? AddressBookCodec.verify(host.device.signedAddressBook, rootSpki: host.device.rootSpki,
            deviceId: host.device.deviceId, nowMs: now, priorGeneration: host.device.bookGeneration, priorHash: host.device.bookHash)
        let keys = SecureIdentityProvider(reference: host.keys)
        // LAN entries are hints only. Direct candidates are supplied by current-network discovery, never old private IPs.
        var result = try await discovery.candidates(device: host.device, keys: keys)
        if let (invitation, network) = freshPairings[host.id], network == networkGeneration, invitation.expiresAt > Date() {
            for (index, address) in invitation.direct.prefix(2).enumerated() {
                result.append(try NativePathCandidate(id: "pair-\(index)", kind: .direct) { [weak self] in
                    guard let self, await self.freshRoute(host.id, network: network) else { throw NativeFailure.unavailable }
                    return try await NativeHTTPConnection.open(host: address.host, port: address.port, rootSpki: host.device.rootSpki,
                        knockKey: host.device.knockKey, identity: keys.identity())
                })
            }
        }
        result += try (book?.relays ?? []).compactMap { endpoint in
            guard let pass = endpoint.passes.first(where: {
                guard let value = try? AdmissionPass.decode($0.bytes) else { return false }
                return now / 1000 >= value.notBefore && now / 1000 <= value.notAfter
            }) else { return nil }
            return try NativePathCandidate(id: LinkBytes.hex(endpoint.relayId), kind: .relay) {
                try await NativeHTTPConnection.relay(endpoint: endpoint, admission: pass, rootSpki: host.device.rootSpki,
                    knockKey: host.device.knockKey, identity: keys.identity())
            }
        }
        return Array(result.prefix(12))
    }
    private func freshRoute(_ id: String, network: UUID) -> Bool {
        network == networkGeneration && (freshPairings[id]?.0.expiresAt ?? .distantPast) > Date()
    }
    private func retire(_ host: RegisteredHost, proof: VerifiedNativeRevocation, retiredStore: PhoneStore? = nil) async {
        let currentStore = retiredStore ?? store, isCurrent = selectedHost?.id == host.id
        if isCurrent {
            generation = UUID(); reconnectTask?.cancel(); eventTask?.cancel(); expiryTask?.cancel()
            detail = .null; snapshot = .null; pending = []; verifiedUntil = nil; selectedHost = nil; connected = false
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
            error = "这台电脑已移除此手机。重新扫描电脑上的二维码即可连接。"
            status = "请重新连接电脑"
        }
    }
    private func pairingTransport(_ invitation: PairingInvitation) async throws -> NativeHTTPConnection {
        let key = LinkBytes.hash(Data(invitation.invitation.utf8))
        for address in invitation.direct.prefix(2) {
            if let connection = try? await NativeHTTPConnection.open(host: address.host, port: address.port, rootSpki: invitation.rootSpki, knockKey: key) { return connection }
        }
        for relay in invitation.relays.prefix(2) {
            if let pass = relay.passes.first,
               let connection = try? await NativeHTTPConnection.relay(endpoint: relay, admission: pass, rootSpki: invitation.rootSpki, knockKey: key) { return connection }
        }
        throw NativeFailure.unavailable
    }
    private func report(_ failure: Error) {
        guard !(failure is CancellationError) else { return }
        if (failure as? NativeFailure) == .expired {
            verifiedUntil = nil; clearPrivateContent(); startEvents()
        } else if (failure as? NativeFailure) == .forbidden || (failure as? NativeFailure) == .contextChanged { clearPrivateContent() }
        error = (failure as? NativeFailure)?.errorDescription ?? "暂时无法完成，请稍后重试。"
    }
    private func clearPrivateContent() {
        detail = .null; pending = []; contentGeneration = UUID(); PreviewFiles.clear()
    }
    private func adoptSnapshot(_ value: NativeJSON) {
        let keys = ["status", "scopes", "dataScope"]
        if snapshot != .null, keys.contains(where: { snapshot["device"][$0] != value["device"][$0] }) { clearPrivateContent() }
        snapshot = value
        scheduleBookRefresh(hint: value["host"]["native"]["discoveryEpoch"].string)
    }
}
