import Foundation
import LatchNativeCore
import Network
import SwiftUI
import UIKit

@MainActor private final class PhoneBodyRead {
    let id: UUID
    let workspace: NativeWorkspace
    let reading: NativeBodyReading
    let host: UUID
    let selection: UUID
    let content: UUID
    let session: String
    let lease: BodyLease
    var update: NativeBodyUpdate?
    var publication: Task<Void, Never>?
    var notice: NativeBodyNotice?
    var metadata: Task<Void, Never>?
    var repairRead: Task<Void, Never>?
    var repaired = false
    var pendingGeneration = UUID()
    var sourceId = UUID()
    var source: NativeWorkspaceEvents?
    var readFailure: Error?
    init(id: UUID, workspace: NativeWorkspace, reading: NativeBodyReading, host: UUID, selection: UUID, content: UUID, session: String, lease: BodyLease) {
        self.id = id; self.workspace = workspace; self.reading = reading; self.host = host
        self.selection = selection; self.content = content; self.session = session; self.lease = lease
    }
    func cancelPending() {
        pendingGeneration = UUID()
        publication?.cancel(); publication = nil; update = nil
        metadata?.cancel(); metadata = nil; notice = nil
        repairRead?.cancel(); repairRead = nil
    }
}

@MainActor final class PhoneModel: ObservableObject {
    @Published var hosts: [RegisteredHost] = []
    @Published var selectedHost: RegisteredHost?
    @Published var snapshot = NativeJSON.null { didSet { shelfCache = nil } }
    @Published var detail = NativeJSON.null { didSet { detailCached = false; if detail != .null { detailFailed = nil }; subagentStops.observe(detail) } }
    /** The conversation on screen is what this window read before the Mac went away. */
    @Published var detailCached = false
    /** The session whose content could not be read, with the Mac still in reach. */
    @Published var detailFailed: String?
    @Published var previewProgress: PhonePreviewProgress?
    var previewJob: UUID?
    @Published var sessionId: String? { didSet { if oldValue != sessionId { clearBodyReading() } } }
    @Published var pending: [NativePendingWrite] = []
    @Published var controlPending = NativeJSON.null
    @Published var draft: PairingDraft?
    /** The pairing flow on screen; nil when there is none. */
    @Published var pairing: PhonePairingPhase?
    /** The Mac removed this phone. */
    @Published var removedByMac = false
    @Published var status = "选择一台电脑"
    @Published var error: String?
    @Published var connected = false { didSet { if connected { offline = false; hostNotice = nil; lastConfirmed = Date() } } }
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
    /** The root place on screen; Code when the one chosen is not offered. */
    @Published var tab = PhoneTab.code
    /** 我的 Agent's pushed pages, by Agent; 应用's, by page. */
    @Published var agentPath: [String] = []
    /** Memory proposals by owner, read inside a content window and dropped with it. */
    @Published var proposals = PhoneProposalStore()
    /** Result cards waiting for an owner's next topic, read inside a content window and dropped with it. */
    @Published var agentResults = PhoneResultStore()
    @Published var appPath: [String] = []
    /** The clipboard's change count when a pairing code was pasted, so a successful pairing clears it only if it still holds that code. */
    var pastedPairing: Int?
    #if LATCH_SCREENS
    /** A screenshot scene: canned Host data, no network, no keys. Only the LatchScreens target compiles this. */
    @Published var staged = false
    #endif
    /** Sessions whose Harness lost its own session (`harness-session-lost` on a prompt): input stops, 按文字重建 offered. In memory only. */
    @Published var lostSessions: Set<String> = []
    /** Previews to let go of on the Host, kept for the next window when none is open. In memory only. */
    var historyCloser = PhoneHistoryCloser()
    /** A session brought in from a sheet or cover, opened once they are gone: opening it under them leaves it loading. */
    var openAfterDismiss: String?
    /** Sessions whose next message starts a new context, chosen on this phone and not yet sent. In memory only. */
    @Published var clearing: Set<String> = []
    /** Subagents this phone asked to stop that the Host has not shown stopping yet, by row ID. */
    @Published var subagentStops = PhoneSubagentStops()
    /** The fork being drafted from a turn, the rename and the delete being asked about. */
    @Published var forkDraft: PhoneForkDraft?
    @Published var renaming: NativeJSON? { didSet { if renaming?["id"] != oldValue?["id"] { renameDraft = renaming?["title"].string ?? "" } } }
    /** The rename field's text, starting from the session's title. */
    @Published var renameDraft = ""
    @Published var deleting: NativeJSON?
    /** 内容中包含: hits beside the open window only, gone with it. */
    @Published var contentSearch = PhoneContentSearch()
    /** The list shows 已归档 in place of the shelves. */
    @Published var showArchived = false
    /** The review page over the list, and 提交 over it. */
    @Published var reviewTarget: PhoneReviewTarget?
    /** 「复核 N 处改动」 by session, worked out from the turn records read for the list. */
    @Published var reviewShortcuts: [String: String] = [:]
    /** Turn records by session and `updatedAt`; nil where they could not be read. */
    var turnRecords: [String: [NativeJSON]?] = [:]
    var turnReads: Set<String> = []
    /** What this device looked at on this computer; from the vault. */
    var seenState: PhoneSeen?
    /** The Host said it will not answer for a while: the list says why and reconnects by its `retryAfter`. */
    @Published var hostNotice: PhoneHostNotice?
    /** The open session's handoffs as this device may see them, and the signature they were read for. */
    @Published var sessionHandoffs: (sessionId: String, list: [NativeJSON])?
    var handoffSignature = ""
    /** The handoff being drafted from a turn. */
    @Published var handoffDraft: PhoneHandoffDraft?
    /** Each composer's attachments, by session or the new-session sheet; their bytes live only in memory and go with the window. */
    @Published var attachTrays: [String: PhoneAttachTray] = [:]
    /** What each composer may attach, as the Host last said for its selection. */
    @Published var attachStates: [String: PhoneAttachState] = [:]
    var uploadJobs: [UUID: Task<Void, Never>] = [:]
    var uploadTail: Task<Void, Never>?
    /** Places whose message with attachments is being sent now; their attachments are locked. */
    @Published var attachSending: Set<String> = []
    /** A start's text the Host proved was not delivered (its attachments were released), by the place that takes it back. */
    @Published var returnedText: [String: String] = [:]
    /** Unsent text the composer took off the screen with a closed window, back when the next window opens. In memory only. */
    var heldDrafts: [String: String] = [:]
    /** Text put into a session's draft from the commit page or a returned result, not yet in its composer. In memory only. */
    @Published var draftInserts: [String: String] = [:]
    /** Where a pending file save's text was meant to go, for 核对并放下. In memory only. */
    var editPaths: [String: (reference: String, root: String?)] = [:]
    /** Other computers' list readings by saved computer, each from that computer's own read-only connection (`NativeListWatcher`), and their guards. */
    @Published var computerDesk = PhoneComputerDesk()
    var watcher: NativeListWatcher?
    var watchTail: Task<Void, Never>?
    var watchDiscoveries: [String: NativeDiscovery] = [:]
    /** An item of 其他电脑 being opened: a later tap or switch replaces it, and a late connection opens nothing. */
    var otherOpening: UUID?
    /** A notification tapped before the store was open again: opened once it is. */
    var pendingOther: (computer: String, session: String)?
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
        let value = PhoneSessions.shelves(tasks: PhoneSpaces.tasks(snapshot, in: .code), workspaces: snapshot["catalog"]["workspaces"].array, query: query)
        shelfCache = (query, value)
        return value
    }
    func hostNow() -> Date { Date().addingTimeInterval(hostClockOffset) }
    @Published var busy = false
    @Published var verifying = false
    @Published var verifiedUntil: Date? {
        didSet {
            if verifiedUntil == nil { bodyLease = nil }
            else if oldValue == nil { flushHistoryCloses() }
        }
    }
    @Published var privateSnapshot = PhonePrivateSnapshot()
    @Published var createdHelper: CreatedHelper?
    private var bodyLease: BodyLease?
    @Published var contentGeneration = UUID() { didSet { if oldValue != contentGeneration { clearBodyReading() } } }
    private var bodyRead: PhoneBodyRead?
    private var bodyOpening: (id: UUID, host: UUID, selection: UUID, content: UUID, session: String, lease: BodyLease, workspace: NativeWorkspace, task: Task<NativeBodyReading, Error>)?
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
    private var eventRetryAttempt = 0
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
        // Copies a document picker left when its callback never came.
        PhoneAttachLoader.purgeInbox(temporary: FileManager.default.temporaryDirectory)
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
            else if let other = pendingOther, hosts.contains(where: { $0.id == other.computer }) {
                pendingOther = nil; await openOther(computer: other.computer, session: other.session)
            } else { pendingOther = nil; await connectLast() }
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
        resetBookRefresh(); stopWatching(forget: true)
        discovery.stop(); freshPairings.removeAll()
        let previous = workspace, link = pairingConnection, previousStore = store
        store = nil; workspace = nil; pairingConnection = nil
        cancelPreview()
        detail = .null; snapshot = .null; verifiedUntil = nil; pairing = nil; pending = []; controlPending = .null; hosts = []; draft = nil; selectedHost = nil
        agentPath = []; appPath = []; proposals.clear(); agentResults.clear(); resetSessionActions(); resetReview()
        connected = false; offline = false; controlsInFlight = []; controlTail = nil; heldDrafts = [:]; draftInserts = [:]; storeReady = false; busy = false; verifying = false; status = "正在连接…"
        PreviewFiles.clear(); clearAttachments()
        await paths.close(); await previous?.closeOpening(); await link?.close(); await previousStore?.lock()
    }
    func connect(_ host: RegisteredHost) async {
        guard let store, !busy else { return }
        busy = true; defer { busy = false }
        generation = UUID(); let current = generation
        eventRetryAttempt = 0
        eventTask?.cancel(); expiryTask?.cancel(); reconnectTask?.cancel()
        resetBookRefresh()
        let previous = workspace; workspace = nil
        clearPrivateContent(); resetSessionActions(); resetReview(); snapshot = .null; sessionId = nil; agentPath = []; appPath = []; controlPending = .null; controlsInFlight = []; controlTail = nil; heldDrafts = [:]; draftInserts = [:]; verifiedUntil = nil; connected = false; offline = false
        let resume = resumeSession; resumeSession = nil
        selectedHost = host; lastHostId = host.id; status = "正在连接…"; error = nil
        watchOthers()
        await paths.close(); await previous?.closeOpening()
        guard generation == current else { return }
        do {
            let vault = try await store.hostVault(host)
            guard generation == current else { await vault.lock(); return }
            let next = try NativeWorkspace(device: host.device, keys: PhoneKeys.provider(host.keys, askOwner: { PhoneFaceID.isOn }), vault: vault,
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
        if bodyLease?.sameWindow(as: lease) != true {
            clearBodyReading()
#if LATCH_SCREENS
            PhoneLive.connectionCheckpoint(.windowBound, leaseValid: lease.valid, connected: connected)
#endif
            // Verification does not change the caller's selected session, draft or attachments.
            privateSnapshot.clear()
            createdHelper = nil
            detail = .null; detailFailed = nil; PreviewFiles.clear()
            snapshot = PhoneAgents.takeDown(snapshot, proposals: &proposals, results: &agentResults)
        }
        bodyLease = lease
        verifiedUntil = lease.verifiedUntil; expiryTask?.cancel()
        expiryTask = Task {
            do { try await lease.waitForInvalidation() } catch { return }
            guard !Task.isCancelled, current == generation else { return }
            closeBodyWindow(lease, current: current)
        }
    }
    private func closeBodyWindow(_ lease: BodyLease, current: UUID) {
        guard current == generation, bodyLease?.sameWindow(as: lease) == true else { return }
#if LATCH_SCREENS
        PhoneLive.connectionCheckpoint(.windowClosed, leaseValid: lease.valid, connected: connected)
#endif
        bodyLease = nil; expiryTask?.cancel(); clearPrivateContent(); verifiedUntil = nil
        eventTask?.cancel(); startEvents()
        if PhoneUnlock.reopensAtExpiry(faceID: PhoneFaceID.isOn) { Task { await reopenContent(current) } }
    }
    /** What was on screen when its window ran out comes back without a tap; nothing asks the person. */
    private func reopenContent(_ current: UUID) async {
        guard current == generation, connected, verifiedUntil == nil, !verifying else { return }
        if let lastReopen, lastReopen.duration(to: .now) < .seconds(60) { return }
        lastReopen = .now
        let selectedTab = tab, selectedPath = agentPath, selected = sessionId, reading = contentGeneration
        let target: PhoneContentReopen = tab == .agents ? .agents(sessionId: agentPath.isEmpty ? nil : selected)
            : selected.map(PhoneContentReopen.session) ?? .none
        func stillReading() -> Bool {
            current == generation && connected && tab == selectedTab && agentPath == selectedPath
                && sessionId == selected && contentGeneration == reading && !PhoneFaceID.isOn
        }
        do {
            try await PhoneUnlock.reopenContent(target, faceID: PhoneFaceID.isOn, current: stillReading,
                verify: { try await self.ensureVerified() }, refreshPrivate: { await self.refresh() },
                openSession: { await self.openSession($0) })
        } catch {
            guard stillReading(), !(error is CancellationError) else { return }
            if !wentAway(error) { report(error) }
        }
    }
    /** Selection changes withdraw App candidates immediately; the old handles can only close their own Core reader. */
    func clearBodyReading() {
        let previous = bodyRead, opening = bodyOpening
        bodyRead = nil; bodyOpening = nil
        previous?.cancelPending(); opening?.task.cancel()
        if let previous { Task { await previous.workspace.endBody(previous.reading) } }
        if let opening { Task { if let reading = try? await opening.task.value { await opening.workspace.endBody(reading) } } }
    }
    private func bodyIntentIsCurrent(_ value: PhoneBodyRead) -> Bool {
        bodyRead === value && generation == value.host && contentGeneration == value.selection
            && privateSnapshot.accepts(value.content) && sessionId == value.session
            && bodyLease?.sameWindow(as: value.lease) == true
    }
    private func bodyIsCurrent(_ value: PhoneBodyRead) -> Bool { bodyIntentIsCurrent(value) && value.lease.valid }
    private func bodyContext(_ selected: String, workspace: NativeWorkspace) async throws -> PhoneBodyRead {
        guard sessionId == selected, let lease = bodyLease, lease.valid else { throw NativeFailure.expired }
        if let bodyRead, bodyIsCurrent(bodyRead), bodyRead.workspace === workspace { return bodyRead }
        let host = generation, selection = contentGeneration, content = privateSnapshot.epoch
        let opening: (id: UUID, host: UUID, selection: UUID, content: UUID, session: String, lease: BodyLease, workspace: NativeWorkspace, task: Task<NativeBodyReading, Error>)
        if let existing = bodyOpening, existing.host == host, existing.selection == selection,
           existing.content == content, existing.session == selected, existing.workspace === workspace, existing.lease.sameWindow(as: lease) {
            opening = existing
        } else {
            clearBodyReading()
            opening = (UUID(), host, selection, content, selected, lease, workspace, Task { try await workspace.beginBody(selected) })
            bodyOpening = opening
        }
        do {
            let reading = try await opening.task.value
            if let bodyRead, bodyRead.id == opening.id, bodyIsCurrent(bodyRead) { return bodyRead }
            guard bodyOpening?.id == opening.id, generation == host, contentGeneration == selection,
                  privateSnapshot.accepts(content), sessionId == selected, lease.valid, bodyLease?.sameWindow(as: lease) == true else {
                await workspace.endBody(reading); throw CancellationError()
            }
            let value = PhoneBodyRead(id: opening.id, workspace: workspace, reading: reading,
                host: host, selection: selection, content: content, session: selected, lease: lease)
            bodyRead = value; bodyOpening = nil
            return value
        } catch {
            if bodyOpening?.id == opening.id { bodyOpening = nil }
            throw error
        }
    }
    @discardableResult private func publishBody(_ update: NativeBodyUpdate, context: PhoneBodyRead) async throws -> Bool {
        guard let receipt = context.reading.publication.apply(update, to: { value in
            guard self.bodyIsCurrent(context) else { return false }
            if let snapshot = value.snapshot {
                self.adoptSnapshot(snapshot, captured: context.content, windowOpen: context.lease.valid)
                // Adopting changed scopes takes content down synchronously, before the body's assignment.
                guard self.bodyIsCurrent(context) else { return false }
            }
            if let detail = value.detail {
                self.detail = detail
                self.snapshot = PhoneSessions.projectingCurrentSummary(snapshot: self.snapshot, detail: detail, sessionId: context.session, cached: false)
                if let time = PhoneTime.parse(detail["sync"]["hostTime"]) { self.hostClockOffset = time.timeIntervalSinceNow }
                self.lastConfirmed = Date()
            }
            return true
        }) else { return false }
        try await context.workspace.applied(receipt)
        return bodyIsCurrent(context)
    }
    /** HTTP and stream candidates use one publication floor; a completed fetch is not consumption evidence. */
    @discardableResult func readSelectedBody(_ selected: String, workspace: NativeWorkspace) async throws -> Bool {
        let context = try await bodyContext(selected, workspace: workspace)
        guard !Task.isCancelled, bodyIsCurrent(context) else { throw CancellationError() }
        let update = try await workspace.readBody(for: context.reading)
        _ = try await publishBody(update, context: context)
        return bodyIsCurrent(context)
    }
    private func queueBody(_ update: NativeBodyUpdate, context: PhoneBodyRead) {
        guard bodyIsCurrent(context) else { return }
        context.update = update
        guard context.publication == nil else { return }
        let pending = context.pendingGeneration
        context.publication = Task {
            defer { if context.pendingGeneration == pending { context.publication = nil } }
            do {
                while context.update != nil {
                    try await Task.sleep(for: .milliseconds(100))
                    guard !Task.isCancelled, bodyIsCurrent(context), let update = context.update else { return }
                    context.update = nil
                    _ = try await publishBody(update, context: context)
                }
            } catch { if !Task.isCancelled, bodyIsCurrent(context) { report(error) } }
        }
    }
    private func queueBodyNotice(_ notice: NativeBodyNotice, context: PhoneBodyRead) {
        guard bodyIsCurrent(context) else { return }
        context.notice = notice
        guard context.metadata == nil else { return }
        let pending = context.pendingGeneration, source = context.sourceId
        context.metadata = Task {
            defer { if context.pendingGeneration == pending { context.metadata = nil } }
            do {
                while let notice = context.notice {
                    context.notice = nil
                    let update = try await PhoneUnlock.retryBodyRead(current: {
                        !Task.isCancelled && self.bodyIsCurrent(context) && context.pendingGeneration == pending && context.sourceId == source
                    }) { try await context.workspace.refreshBody(for: context.reading, after: notice) }
                    guard !Task.isCancelled, bodyIsCurrent(context) else { return }
                    _ = try await publishBody(update, context: context)
                    await refreshControlPending()
                }
            } catch { if !Task.isCancelled { await failBodyRead(error, context: context, source: source) } }
        }
    }
    /** A failed metadata read cannot leave an unconsumed barrier waiting for another event. */
    private func failBodyRead(_ error: Error, context: PhoneBodyRead, source: UUID) async {
        guard bodyIsCurrent(context), context.sourceId == source, let stream = context.source else { return }
        context.readFailure = (error as? NativeReadFailure) == .failed ? NativeFailure.unavailable : error
        await stream.cancel()
    }
    private func recoverBodyAccess(_ context: PhoneBodyRead, stream streamId: UUID) async {
        guard bodyIsCurrent(context), streamGeneration == streamId else { return }
        let host = generation, selected = context.session, repaired = context.repaired
        // A validated access checkpoint withdrew this reader. Hide its content before any recovery await.
        clearPrivateContent()
        var reading = contentGeneration, content = privateSnapshot.epoch
        do {
            let value = try await context.workspace.snapshot()
            guard generation == host, streamGeneration == streamId, sessionId == selected,
                  contentGeneration == reading, privateSnapshot.accepts(content) else { return }
            try context.lease.requireValid()
            guard bodyLease?.sameWindow(as: context.lease) == true else { return }
            adoptSnapshot(value, captured: content, windowOpen: true)
            reading = contentGeneration; content = privateSnapshot.epoch
            guard PhoneSessions.mayReadBody(snapshot: snapshot, sessionId: selected) else { detailFailed = selected; return }
            let next = try await bodyContext(selected, workspace: context.workspace)
            next.repaired = repaired
            let update = try await context.workspace.readBody(for: next.reading)
            _ = try await publishBody(update, context: next)
            if bodyIsCurrent(next) { startEvents() }
        } catch {
            guard generation == host, streamGeneration == streamId, sessionId == selected,
                  contentGeneration == reading, privateSnapshot.accepts(content), !Task.isCancelled else { return }
            detailFailed = selected; report(error)
        }
    }
    @discardableResult func refresh() async -> Bool {
        guard let workspace else { return false }
        let current = generation, selected = sessionId
        var reading = privateSnapshot.epoch
        do {
            let lease = await workspace.lease()
            guard current == generation else { return false }
            if let lease { try bindBodyLease(lease, current: current) }
            else {
                if let bodyLease { closeBodyWindow(bodyLease, current: current) }
                else if verifiedUntil != nil { clearPrivateContent() }
                else { detail = .null; pending = []; PreviewFiles.clear(); clearAttachments() }
                verifiedUntil = nil
            }
            reading = privateSnapshot.epoch
            let value = try await workspace.snapshot()
            guard current == generation else { return false }
            guard privateSnapshot.accepts(reading) else { return true }
            adoptSnapshot(value, captured: reading, windowOpen: lease?.valid == true)
            await refreshControlPending()
            guard current == generation, privateSnapshot.accepts(reading) else { return false }
            if let selected, lease?.valid == true {
                let reading = contentGeneration
                guard try await readSelectedBody(selected, workspace: workspace), current == generation,
                      sessionId == selected, contentGeneration == reading, lease?.valid == true else { return false }
            }
            return true
        } catch {
            guard current == generation, privateSnapshot.accepts(reading), !Task.isCancelled, !(error is CancellationError) else { return false }
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
#if LATCH_SCREENS
        PhoneLive.connectionCheckpoint(.readUnavailable, leaseValid: bodyLease?.valid == true, connected: connected)
#endif
        if connected { connected = false; offline = true; status = "不在线"; startReconnect() }
        return true
    }
    func startEvents() {
        eventTask?.cancel()
        bodyRead?.cancelPending()
        refreshTask?.cancel(); refreshTask = nil; refreshId = nil; pendingEvent = nil
        streamGeneration = UUID()
        guard let workspace else { return }
        let current = generation, selected = verifiedUntil != nil ? sessionId : nil, streamId = streamGeneration
        eventTask = Task {
            var streamLease: BodyLease?
            var selectedBody: PhoneBodyRead?
            let openedAt = ContinuousClock.now
            do {
                // The Host offers metadata snapshots without a body window, never an unverified SSE stream.
                streamLease = await workspace.lease()
                if streamLease == nil {
                    while !Task.isCancelled, generation == current, streamGeneration == streamId {
                        try await Task.sleep(for: .seconds(15))
                        guard !Task.isCancelled, generation == current, streamGeneration == streamId else { return }
                        guard await refresh() else { throw NativeFailure.unavailable }
                    }
                    return
                }
                if let selected {
                    let context = try await bodyContext(selected, workspace: workspace)
                    selectedBody = context
                    guard !Task.isCancelled, generation == current, streamGeneration == streamId else { return }
                    try await consumeBodyEvents(context, stream: streamId, openedAt: openedAt)
                    return
                }
                let stream = try await workspace.events(sessionId: selected, expectedLease: streamLease)
                defer { Task { await stream.cancel() } }
                for try await event in stream.events {
                    guard !Task.isCancelled, generation == current, streamGeneration == streamId else { return }
                    if try await workspace.accepts(event, from: stream, sessionId: selected) {
                        if event.type == "heartbeat" || openedAt.duration(to: .now) >= .seconds(15) { eventRetryAttempt = 0 }
                        if event.type == "host-state" { hostNotice = PhoneHostNotice.parse(event.data) }
                        pendingEvent = (event, stream, selected)
                        scheduleEventRefresh(workspace: workspace, generation: current, stream: streamId)
                    }
                }
            } catch {
                guard !Task.isCancelled, generation == current, streamGeneration == streamId else { return }
                if let selectedBody, !bodyIntentIsCurrent(selectedBody) { return }
                selectedBody?.cancelPending()
                if (error as? NativeReadFailure) == .bodyAccessChanged, let selectedBody {
                    await recoverBodyAccess(selectedBody, stream: streamId); return
                }
                if selectedBody?.repaired == true, [NativeFailure.invalidRecord, .eventOverflow].contains(error as? NativeFailure) {
                    report(error); return
                }
#if LATCH_SCREENS
                PhoneLive.connectionCheckpoint((error as? NativeFailure) == .expired ? .streamExpired
                    : (error as? NativeFailure) == .unavailable ? .streamUnavailable : .streamOther,
                    leaseValid: streamLease?.valid == true, connected: connected)
#endif
                let reading = privateSnapshot.epoch
                guard let recovery = await PhoneUnlock.recoverStream(error, current: {
                    !Task.isCancelled && self.generation == current && self.streamGeneration == streamId && self.privateSnapshot.accepts(reading)
                }, readMetadata: { try await workspace.snapshot() }) else { return }
                if recovery.action == .eventOverflow {
                    // The selected reader already spent its one full repair; a new event task must not reset it.
                    if selectedBody?.repaired == true { report(error); return }
                    try? await workspace.forgetCursor(sessionId: selected)
                    if await refresh() { startEvents() }
                    return
                }
                if recovery.action == .contentExpired, let streamLease {
                    await workspace.invalidateContentWindow(streamLease)
                    guard !Task.isCancelled, generation == current, streamGeneration == streamId else { return }
                    closeBodyWindow(streamLease, current: current)
                    return
                }
                if recovery.action == .retryEvents, let value = recovery.snapshot {
#if LATCH_SCREENS
                    PhoneLive.connectionCheckpoint(.metadataConfirmed, leaseValid: bodyLease?.valid == true, connected: connected)
#endif
                    adoptSnapshot(value, captured: reading, windowOpen: bodyLease?.valid == true)
                    connected = true; status = "已连接"
                    reconnectTask?.cancel()
                    if let streamLease, !streamLease.valid, bodyLease?.sameWindow(as: streamLease) == true {
                        closeBodyWindow(streamLease, current: current)
                        return
                    }
                    eventRetryAttempt = min(eventRetryAttempt + 1, 7)
                    let delay = min(30.0, 0.5 * pow(2, Double(eventRetryAttempt - 1)))
                    do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                    guard !Task.isCancelled, generation == current, streamGeneration == streamId else { return }
                    startEvents()
                    return
                }
#if LATCH_SCREENS
                PhoneLive.connectionCheckpoint(.reconnectRequired, leaseValid: bodyLease?.valid == true, connected: connected)
#endif
                connected = false; offline = true; status = "不在线"; startReconnect()
            }
        }
    }
    private func consumeBodyEvents(_ context: PhoneBodyRead, stream streamId: UUID, openedAt: ContinuousClock.Instant) async throws {
        var refreshAfterOpening = false
        while !Task.isCancelled, bodyIsCurrent(context), streamGeneration == streamId {
            let source = try await context.workspace.events(for: context.reading, incremental: !context.repaired)
            let sourceId = UUID()
            context.sourceId = sourceId; context.source = source; context.readFailure = nil
            defer {
                if context.sourceId == sourceId { context.source = nil }
                Task { await source.cancel() }
            }
            if refreshAfterOpening {
                refreshAfterOpening = false
                let pending = context.pendingGeneration
                context.repairRead = Task {
                    defer { if context.pendingGeneration == pending { context.repairRead = nil } }
                    do {
                        let full = try await PhoneUnlock.retryBodyRead(current: {
                            !Task.isCancelled && self.bodyIsCurrent(context) && context.pendingGeneration == pending && context.sourceId == sourceId
                        }) { try await context.workspace.readBody(for: context.reading) }
                        guard !Task.isCancelled, bodyIsCurrent(context) else { return }
                        _ = try await publishBody(full, context: context)
                    } catch { if !Task.isCancelled { await failBodyRead(error, context: context, source: sourceId) } }
                }
            }
            var repair = false
            do {
                for try await event in source.events {
                    guard !Task.isCancelled, bodyIsCurrent(context), streamGeneration == streamId else { return }
                    let result = try await context.workspace.receive(event, from: source, for: context.reading)
                    guard !Task.isCancelled, bodyIsCurrent(context), streamGeneration == streamId else { return }
                    if event.type == "heartbeat" || openedAt.duration(to: .now) >= .seconds(15) { eventRetryAttempt = 0 }
                    switch result {
                    case let .update(update): queueBody(update, context: context)
                    case let .notice(notice):
                        if try NativeJSON.decode(notice.event.data)["resumeRequired"].bool { try await context.workspace.forgetCursor(sessionId: context.session) }
                        queueBodyNotice(notice, context: context)
                    case let .hostState(value): hostNotice = PhoneHostNotice.parse(value.data)
                    case .ignore: break
                    case let .repair(diagnostic):
#if LATCH_SCREENS
                        PhoneLive.bodyRepairCheckpoint(diagnostic)
#endif
                        repair = true
                    }
                    if repair { break }
                }
            } catch {
                let failure = context.readFailure ?? error
                if context.readFailure == nil, (failure as? NativeFailure) == .unavailable, !Task.isCancelled {
                    try await context.workspace.checkBodyReading(context.reading)
                }
                guard !context.repaired, [NativeFailure.invalidRecord, .eventOverflow].contains(failure as? NativeFailure) else { throw failure }
#if LATCH_SCREENS
                PhoneLive.connectionCheckpoint(context.readFailure != nil ? .bodyReadRepair
                    : (failure as? NativeFailure) == .eventOverflow ? .eventBufferRepair : .eventRecordRepair,
                    leaseValid: context.lease.valid, connected: connected)
#endif
                repair = true
            }
            guard !Task.isCancelled, bodyIsCurrent(context), streamGeneration == streamId else { return }
            if !repair {
                if let failure = context.readFailure { throw failure }
                try await context.workspace.checkBodyReading(context.reading)
                throw NativeFailure.unavailable
            }
            guard !context.repaired else { throw NativeFailure.invalidRecord }
            context.repaired = true; context.cancelPending()
            await source.cancel()
            guard !Task.isCancelled, bodyIsCurrent(context), streamGeneration == streamId else { return }
            refreshAfterOpening = true
            // Reopen first, clearing the failed stream's ledger before offering the concurrent HTTP repair.
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
                    // An announced restart, update, stop or sleep says when to look again, as the web's: not a failure to back off from.
                    if let notice = hostNotice { try await Task.sleep(for: .seconds(Double(notice.retryAfter))) }
                    else {
                        let delay = min(30.0, 0.5 * pow(2, Double(min(attempt, 6))))
                        try await Task.sleep(for: .seconds(delay + Double.random(in: 0...delay / 4)))
                    }
                    guard current == generation else { return }
                    let available = try await candidates(host)
                    let reading = privateSnapshot.epoch
                    let value = try await paths.migrate(available, workspace: workspace)
                    guard current == generation else { return }
                    await bookRefresher?.connectionChanged()
                    guard current == generation else { return }
                    if let lease = await workspace.lease() { try bindBodyLease(lease, current: current) }
                    guard current == generation else { return }
                    adoptSnapshot(value, captured: reading, windowOpen: bodyLease?.valid == true); connected = true; status = "已连接"
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
#if LATCH_SCREENS
            PhoneLive.connectionCheckpoint(.networkChanged, leaseValid: self.bodyLease?.valid == true, connected: self.connected)
#endif
            self.currentNetworkPath = path; self.proximityTask?.cancel(); self.proximityTask = nil
            self.networkGeneration = UUID(); self.freshPairings.removeAll(); self.discovery.stop()
            if let host = self.selectedHost { try? self.startDiscovery(host) }
            await self.paths.networkChanged()
            self.othersNetworkChanged()
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
            let reading = privateSnapshot.epoch
            let value = try await paths.migrate(candidates(saved), workspace: workspace)
            guard generation == current else { return }
            await bookRefresher?.connectionChanged()
            guard generation == current else { return }
            if let lease = await workspace.lease() { try bindBodyLease(lease, current: current) }
            guard generation == current else { return }
            adoptSnapshot(value, captured: reading, windowOpen: bodyLease?.valid == true); connected = true; status = "已连接"
            _ = await refresh(); startEvents()
        } catch { if generation == current, !Task.isCancelled { startReconnect() } }
    }
    private func bookFailed(_ failure: NativeFailure, current: UUID) {
#if LATCH_SCREENS
        if generation == current { PhoneLive.connectionCheckpoint(.bookFailed, leaseValid: bodyLease?.valid == true, connected: connected) }
#endif
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
        let keys = PhoneKeys.provider(host.keys)
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
        for endpoint in NativeRelayOrder.available(book) {
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
            PreviewFiles.clear(); clearAttachments(); discovery.stop(); freshPairings.removeValue(forKey: host.id)
            let old = workspace; workspace = nil
            await paths.close(); await old?.closeOpening()
        }
        do {
            try await currentStore?.retire(host, proof: proof)
            if let store, store === currentStore {
                let saved = await store.list()
                if self.store === store { hosts = saved; forgetNotices(host); if !isCurrent { watchOthers() } }
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
            if let bodyLease, !bodyLease.valid { closeBodyWindow(bodyLease, current: generation) }
            else if bodyLease == nil { verifiedUntil = nil; clearPrivateContent(); startEvents() }
            return
        } else if (failure as? NativeFailure) == .forbidden || (failure as? NativeFailure) == .contextChanged { clearPrivateContent() }
        error = (failure as? NativeFailure)?.errorDescription ?? "暂时无法完成，请稍后重试。"
    }
    private func clearPrivateContent() {
        privateSnapshot.clear()
        createdHelper = nil
        cancelPreview()
        detail = .null; detailFailed = nil; pending = []; contentGeneration = UUID(); PreviewFiles.clear(); clearAttachments()
        contentSearch = PhoneContentSearch(); forkDraft = nil; draftInserts = [:]; editPaths = [:]
        // Diffs, notes and handoffs are content: they go with the window, and the review page with them.
        reviewTarget = nil; sessionHandoffs = nil; handoffSignature = ""; handoffDraft = nil
        // Agents' names, duties and schedules came with the window and go with it.
        snapshot = PhoneAgents.takeDown(snapshot, proposals: &proposals, results: &agentResults)
    }
    private func adoptSnapshot(_ value: NativeJSON, live: Bool = true, captured: UUID? = nil, windowOpen: Bool = false) {
        guard captured.map(privateSnapshot.accepts) ?? true else { return }
        if let instance = value["instanceId"].string, snapshot["instanceId"].string == instance,
           let revision = value["revision"].integer, let applied = snapshot["revision"].integer, revision < applied { return }
        let keys = ["status", "scopes", "dataScope"]
        let changedScope = snapshot != .null && keys.contains(where: { snapshot["device"][$0] != value["device"][$0] })
        if changedScope { clearPrivateContent(); heldDrafts = [:] }
        guard let projected = privateSnapshot.adopt(value, captured: changedScope ? privateSnapshot.epoch : captured ?? privateSnapshot.epoch,
            windowOpen: windowOpen && !changedScope) else { return }
        snapshot = PhoneSessions.projectingCurrentSummary(snapshot: projected, detail: detail, sessionId: sessionId, cached: detailCached)
        if live { refreshReviewShortcuts() }
        if let hostTime = PhoneTime.parse(value["hostTime"]) {
            // A cached list is old by definition: it says when it was true, not what the Host's clock reads now.
            if live { hostClockOffset = hostTime.timeIntervalSinceNow; lastConfirmed = Date() } else { lastConfirmed = hostTime }
        } else if live { lastConfirmed = Date() }
        scheduleBookRefresh(hint: value["host"]["native"]["discoveryEpoch"].string, directoryHint: value["host"]["native"]["directoryEpoch"].string)
    }
}
