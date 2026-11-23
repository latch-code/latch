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

enum PhoneStoreState: Equatable { case opening, ready, unavailable(NativeStoreFailure) }

@MainActor final class PhoneModel: ObservableObject {
    @Published var hosts: [RegisteredHost] = []
    var forgettingComputers: Set<String> = []
    @Published var selectedHost: RegisteredHost?
    @Published var snapshot = NativeJSON.null { didSet { shelfCache = nil } }
    @Published private(set) var questionAttention: PhoneQuestionAttention?
    @Published var questionTopic: String?
    private var pendingQuestionLink: (computer: String?, expires: Date)?
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
    @Published var connected = false {
        didSet {
            if connected { offline = false; hostNotice = nil; lastConfirmed = Date() }
            else if oldValue { questionAttention = nil; questionTopic = nil; withdrawDisconnectedWork() }
        }
    }
    @Published private var reconnectPresentation = PhoneReconnectPresentation()
    private var restoringTransport: Bool { reconnectPresentation.interruption != nil }
    var transportReady: Bool {
        #if LATCH_SCREENS
        if staged { return reconnectPresentation.permitsRequests(connected: connected, transportValid: true) }
        #endif
        return reconnectPresentation.permitsRequests(connected: connected, transportValid: installedTransport?.valid == true)
    }
    #if LATCH_SCREENS
    func stageReconnect() { _ = reconnectPresentation.begin() }
    #endif
    /** The store has answered, so an empty host list means this phone has none. */
    @Published var storeState: PhoneStoreState = .opening
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
    /** Covers both verification and the subsequent private list read for this computer. */
    @Published var openingAgentsFor: UUID?
    @Published var teamListRead: NativeTransportEpoch?
    @Published var teamListRetry: NativeTransportEpoch?
    var teamListOpening: (transport: NativeTransportEpoch, task: Task<Void, Error>)?
    /** Memory proposals by owner, read inside a content window and dropped with it. */
    @Published var proposals = PhoneProposalStore()
    /** Result cards waiting for an owner's next topic, read inside a content window and dropped with it. */
    @Published var agentResults = PhoneResultStore()
    @Published var appPath: [String] = []
    @Published var workItemsShown = false
    @Published var workItemId: String?
    @Published var workPath: [PhoneWorkDestination] = [] {
        didSet { if oldValue != workPath { workPathGeneration = UUID() } }
    }
    var workSelection = UUID()
    var workConnection = UUID()
    var workPathGeneration = UUID()
    /** The clipboard's change count when a pairing code was pasted, so a successful pairing clears it only if it still holds that code. */
    var pastedPairing: Int?
    #if LATCH_SCREENS
    /** A screenshot scene: canned Host data, no network, no keys. Only the LatchScreens target compiles this. */
    @Published var staged = false
    /** A scene's team members' sessions, read when a result row opens. */
    var stagedMemberSessions: [String: [NativeJSON]] = [:]
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
    private var shelfCache: (query: String, archived: Bool, window: Bool, shelves: [PhoneShelf])?
    private var hostClockOffset: TimeInterval = 0
    /** Where to come back to after the App returns from the background: within this process only. */
    private var resumeSession: String?
    private var resumeAfterListing: PhoneResumingSession?
    private var visibleSessionIntent: PhoneResumingSession? {
        guard let sessionId, hasContentWindow, connected, storageAvailable, !hold.holding,
              (tab == .code && !workItemsShown) || (tab == .agents && !agentPath.isEmpty) else { return nil }
        return PhoneResumingSession(session: sessionId, host: generation, selection: contentGeneration,
            content: privateSnapshot.epoch, tab: tab, agentPath: agentPath)
    }
    private var lastHostId: String?
    /** When a window that ran out last opened again by itself; a clock far off the Mac's cannot make it spin. */
    private var lastReopen: ContinuousClock.Instant?
    /** Drawn on every update of anything, so it is worked out once per list and search. */
    func shelves(query: String, archived: Bool = false) -> [PhoneShelf] {
        let window = connected && hasContentWindow && privateSnapshot.confirmed
        if let shelfCache, shelfCache.query == query, shelfCache.archived == archived, shelfCache.window == window { return shelfCache.shelves }
        let tasks = PhoneSpaces.tasks(snapshot, in: .code), workspaces = snapshot["catalog"]["workspaces"].array
        let teams = window ? snapshot["teams"].array : nil
        let value = archived ? PhoneSessions.archivedShelves(tasks, workspaces: workspaces, teams: teams, query: query)
            : PhoneSessions.shelves(tasks: tasks, workspaces: workspaces, teams: teams, query: query)
        shelfCache = (query, archived, window, value)
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
    private(set) var bodyLease: BodyLease?
    var currentFileAccess: NativeFileAccess? {
        guard transportReady, let bodyLease, bodyLease.valid, let installedTransport, installedTransport.valid else { return nil }
        return NativeFileAccess(lease: bodyLease, transport: installedTransport)
    }
    var hasContentWindow: Bool {
        #if LATCH_SCREENS
        if staged { return verifiedUntil.map { $0 > Date() } ?? false }
        #endif
        return bodyLease?.valid == true
    }
    @Published var contentGeneration = UUID() { didSet { if oldValue != contentGeneration { clearBodyReading() } } }
    private var bodyRead: PhoneBodyRead?
    private var bodyOpening: (id: UUID, host: UUID, selection: UUID, content: UUID, session: String, lease: BodyLease, workspace: NativeWorkspace, task: Task<NativeBodyReading, Error>)?
    var canRun: Bool { connected && snapshot["device"]["status"].string == "active" && hasScope("run") }
    var canApproveStandard: Bool { connected && snapshot["device"]["status"].string == "active" && hasScope("approve:standard") }
    var canApproveElevated: Bool { connected && snapshot["device"]["status"].string == "active" && hasScope("approve:elevated") }
    func hasScope(_ scope: String) -> Bool { snapshot["device"]["scopes"].array.contains(.string(scope)) }
    private(set) var store: PhoneStore?
    private(set) var workspace: NativeWorkspace?
    private let storageOpening = NativeStorageOpening()
    private var protectedDataLocked = false
    private var offlineCacheBlocked: Set<String> = []
    @Published private(set) var installedTransport: NativeTransportEpoch?
    /** Connection phases of the last rounds, in memory: phase, path kind and milliseconds only. */
    let timeline = NativeConnectionTimeline()
    private(set) lazy var paths = NativePathOwner(timeline: timeline)
    private let discovery = NativeDiscovery()
    private var networkFilter = NativeNetworkChangeFilter()
    private var winners = NativeWinningPaths()
    private var upgradeTask: (id: UUID, task: Task<Void, Never>)?
    /** A short background that keeps the connection; see `enterBackground`. */
    private let hold = NativeBackgroundHold()
    private var holdTask = UIBackgroundTaskIdentifier.invalid
    private var transportWatch: Task<Void, Never>?
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
    private let listPublication = NativeListPublication()
    private var initialListTask: Task<Void, Never>?
    private var reconnectTask: (id: UUID, task: Task<Void, Never>)?
    private var reconnectDelay: Task<Void, Error>?
    private var reconnectBookChanged = false
    private var offlineTask: Task<Void, Never>?
    var pairingTask: Task<Void, Never>?
    var pairingConnection: NativeHTTPConnection?
    private var monitor: NWPathMonitor?
    private var monitorGeneration = UUID()
    private(set) var currentNetworkPath: NWPath?
    private var proximityTask: Task<Void, Never>?
    private var bookRefresher: NativeBookRefresher?

    private var storageAvailable: Bool {
        !protectedDataLocked && UIApplication.shared.isProtectedDataAvailable && UIApplication.shared.applicationState != .background
    }
    func protectedDataChanged(available: Bool) {
        protectedDataLocked = !available
        if available { Task { await open() } }
        else { lock() }
    }
    func open() async {
        if hold.holding { await returnFromHold(); return }
        guard store == nil, storageAvailable else { return }
        timeline.begin()
        let current = generation
        await storageOpening.open(when: { self.canOpenStore(current) }) {
            await self.prepareStore(current)
        }
    }
    private func canOpenStore(_ current: UUID) -> Bool {
        generation == current && store == nil && storageAvailable && !Task.isCancelled
    }
    private func prepareStore(_ current: UUID) async {
        guard canOpenStore(current) else { return }
        storeState = .opening
        PreviewFiles.purgeAbandoned()
        // Copies a document picker left when its callback never came.
        PhoneAttachLoader.purgeInbox(temporary: FileManager.default.temporaryDirectory)
        var provisional: PhoneStore?
        do {
            let opened = try await PhoneStore.open()
            provisional = opened
            guard canOpenStore(current) else { await opened.lock(); return }
            let saved = await opened.list(), pending = try await opened.draft()
            guard canOpenStore(current) else { await opened.lock(); return }
            store = opened; hosts = saved; draft = pending; storeState = .ready
            timeline.record(.storeReady)
            // Browsing starts before the vault opens, so the first round can already see the Mac on this network.
            if pending == nil, let host = hosts.first(where: { $0.id == lastHostId }) ?? hosts.first { try? startDiscovery(host) }
            observeNetwork()
            if pending != nil { resumePairing() }
            else {
                Task {
                    guard generation == current, store === opened, storageAvailable else { return }
                    let other = pendingOther; pendingOther = nil
                    if let other, hosts.contains(where: { $0.id == other.computer }) {
                        await openOther(computer: other.computer, session: other.session)
                    } else { await connectLast() }
                }
            }
        } catch {
            await provisional?.lock()
            if canOpenStore(current) { storeState = .unavailable(NativeStoreFailure(error)) }
        }
    }
    /** The Mac this phone last used, or the first saved one. */
    func connectLast() async {
        if let host = hosts.first(where: { $0.id == lastHostId }) ?? hosts.first { await connect(host) }
    }
    /**
     * Going to the background withdraws content and previews at once. With the Mac connected and the data unlocked, the
     * connection, workspace and in-memory window token stay for at most 30 s, passively: no dial, stream or poll. Lock,
     * revocation, a dead connection, a network change, a computer switch or the time running out tear everything down.
     */
    func enterBackground() {
        guard workspace != nil, transportReady, store != nil, pairing == nil, draft == nil, !protectedDataLocked,
              UIApplication.shared.isProtectedDataAvailable else { lock(); return }
        hold.enter(withdraw: { withdrawForHold() }, finish: { [weak self] in
            guard let self, self.holdTask != .invalid else { return }
            UIApplication.shared.endBackgroundTask(self.holdTask); self.holdTask = .invalid
        }, expire: { [weak self] in self?.lock() })
        holdTask = UIApplication.shared.beginBackgroundTask(withName: "latch-hold") { [weak self] in
            MainActor.assumeIsolated { self?.hold.expired() }
        }
        if holdTask == .invalid { hold.expired() }
    }
    private func withdrawForHold() {
        questionAttention = nil; questionTopic = nil
        if let sessionId, !workPath.contains(where: { $0.openedSession == sessionId }) { resumeSession = sessionId }
        eventTask?.cancel(); refreshTask?.cancel(); expiryTask?.cancel(); initialListTask?.cancel(); cancelReconnect()
        proximityTask?.cancel(); proximityTask = nil; cancelUpgrade()
        streamGeneration = UUID(); stopWatching(forget: true)
        cancelPreview(); clearPrivateContent(); verifiedUntil = nil
        agentPath = []; appPath = []; resetWorkItems(); proposals.clear(); agentResults.clear()
        PreviewFiles.clear(); clearAttachments()
    }
    /** Back within the hold: the Host rechecks the window on the kept connection, which never extends it. */
    private func returnFromHold() async {
        guard hold.resume() else { return }
        guard let workspace, let host = selectedHost, let transport = installedTransport, transport.valid, storageAvailable else { lock(); await open(); return }
        timeline.begin()
        let current = generation, selected = contentGeneration, resume = resumeSession
        resumeSession = nil
        watchOthers()
        do {
            let kept = try await workspace.recheckWindow()
            guard generation == current, installedTransport === transport, storageAvailable else { return }
            timeline.record(.verification)
            let lease = kept ? await workspace.lease() : nil
            guard generation == current, installedTransport === transport, transport.valid, storageAvailable, !hold.holding else { return }
            if let lease { try? bindBodyLease(lease, current: current) }
            if kept, let resume, sessionId == resume, contentGeneration == selected { resumeAfterListing = visibleSessionIntent }
            // Resume the list stream while a partial first checkpoint still lacks the selected session.
            startEvents(listOnly: contentGeneration == selected && sessionId == resume)
            _ = await refresh(includeSelectedBody: false)
            guard generation == current, storageAvailable, !hold.holding, connected else { return }
            recoverInitialList()
            tryUpgrade()
        } catch {
            guard generation == current, installedTransport === transport, storageAvailable else { return }
            if let proof = await workspace.verifiedRevocation() { await retire(host, proof: proof); return }
            recoverTransport(on: transport)
        }
    }
    private var waitingForSessionList: Bool {
        resumeAfterListing != nil && resumeAfterListing == visibleSessionIntent
    }
    private func restoreListedSession() async {
        let current = visibleSessionIntent
        guard let intent = resumeAfterListing,
              let action = PhoneResumingSession.resolve(&resumeAfterListing, current: current, snapshot: snapshot) else { return }
        switch action {
        case .close: closeSession()
        case .read:
            guard let lease = bodyLease else { return }
            await openSession(intent.session, resuming: lease)
        }
    }
    func lock() {
        questionAttention = nil; questionTopic = nil; pendingQuestionLink = nil
        hold.release(); transportWatch?.cancel(); transportWatch = nil; cancelUpgrade()
        if let sessionId, !workPath.contains(where: { $0.openedSession == sessionId }) { resumeSession = sessionId }
        if let selectedHost { lastHostId = selectedHost.id }
        generation = UUID(); eventTask?.cancel(); refreshTask?.cancel(); expiryTask?.cancel(); initialListTask?.cancel(); cancelReconnect(); pairingTask?.cancel()
        monitorGeneration = UUID(); monitor?.cancel(); monitor = nil
        currentNetworkPath = nil; proximityTask?.cancel(); proximityTask = nil
        resetBookRefresh(); stopWatching(forget: true)
        discovery.stop(); freshPairings.removeAll()
        let previous = workspace, link = pairingConnection, previousStore = store, previousHost = selectedHost?.id
        if previous != nil || link != nil || previousStore != nil {
            storageOpening.close {
                await self.closeConnection(previous, hostId: previousHost)
                await link?.close()
                await previousStore?.lock()
            }
        } else { storageOpening.close() }
        store = nil; workspace = nil; installedTransport = nil; pairingConnection = nil
        cancelPreview()
        sessionId = nil; detail = .null; snapshot = .null; verifiedUntil = nil; pairing = nil; pending = []; controlPending = .null; hosts = []; draft = nil; selectedHost = nil
        agentPath = []; appPath = []; resetWorkItems(); proposals.clear(); agentResults.clear(); resetSessionActions(); resetReview()
        connected = false; offline = false; controlsInFlight = []; controlTail = nil; heldDrafts = [:]; draftInserts = [:]; storeState = .opening; busy = false; verifying = false; status = "正在连接…"
        PreviewFiles.clear(); clearAttachments()
    }
    private func closeConnection(_ previous: NativeWorkspace?, hostId: String?) async {
        await paths.close()
        if let previous, !(await previous.closeOpening()), let hostId { offlineCacheBlocked.insert(hostId) }
    }
    func connect(_ host: RegisteredHost) async {
        guard let store, !busy, storageAvailable, !forgettingComputers.contains(host.id),
              hosts.contains(where: { $0.id == host.id }) else { return }
        hold.release(); transportWatch?.cancel(); transportWatch = nil; cancelUpgrade()
        busy = true
        generation = UUID(); let current = generation
        defer { if generation == current { busy = false } }
        eventRetryAttempt = 0
        eventTask?.cancel(); expiryTask?.cancel(); initialListTask?.cancel(); cancelReconnect()
        resetBookRefresh()
        let previous = workspace, previousHost = selectedHost?.id
        storageOpening.close { await self.closeConnection(previous, hostId: previousHost) }
        workspace = nil; installedTransport = nil
        clearPrivateContent(); resetWorkItems(); resetSessionActions(); resetReview(); snapshot = .null; sessionId = nil; agentPath = []; appPath = []; controlPending = .null; controlsInFlight = []; controlTail = nil; heldDrafts = [:]; draftInserts = [:]; verifiedUntil = nil; connected = false; offline = false
        let resume = resumeSession; resumeSession = nil
        QuotaWidgetWriter.connecting(to: host.id, computers: hosts.count)
        selectedHost = host; lastHostId = host.id; lastConfirmed = nil; hostNotice = nil; status = "正在连接…"; error = nil
        watchOthers()
        guard await storageOpening.waitForClose(), generation == current, self.store === store, storageAvailable else { return }
        do {
            let vault = try await store.hostVault(host)
            guard generation == current, self.store === store, storageAvailable, !Task.isCancelled else { await vault.lock(); return }
            let next = try NativeWorkspace(device: host.device, keys: PhoneKeys.provider(host.keys, askOwner: { PhoneFaceID.isOn }), vault: vault,
                onRevoked: { [weak self, store] proof in Task { @MainActor in await self?.retire(host, proof: proof, retiredStore: store) } },
                onTransportInstalled: { [weak self] path in self?.adoptTransport(path, current: current) },
                prefetchChallenge: { !PhoneFaceID.isOn })
            workspace = next
            bookRefresher = NativeBookRefresher(workspace: next, persist: { device in
                var saved = host; saved.device = device; saved.prepared = false
                try await store.update(saved)
                if let pending = try await store.draft(), pending.keys.connectionTag == host.keys.connectionTag,
                   pending.keys.verificationTag == host.keys.verificationTag { try await store.clearDraft(matching: pending.payload) }
            }, updated: { [weak self] device in
                await self?.receiveBook(device, host: host, store: store, current: current)
            }, failed: { [weak self] failure in
                await self?.bookFailed(failure, current: current)
            })
            if !offlineCacheBlocked.contains(host.id) {
                // A damaged optional cache cannot prevent a fresh authenticated connection.
                let cached = try? await next.cachedSnapshot()
                guard generation == current, self.store === store, storageAvailable else { return }
                if let cached, installedTransport == nil, !offlineCacheBlocked.contains(host.id) { displaySnapshot(cached, live: false) }
            }
            if !connected { try await dialRound(host, workspace: next, current: current) }
            guard generation == current, storageAvailable else { return }
            await refreshControlPending()
            if generation == current, storageAvailable, let resume,
               snapshot["tasks"].array.contains(where: { $0["id"].string == resume }) { await openSession(resume) }
        } catch {
            guard generation == current, storageAvailable else { return }
            if let workspace, let proof = await workspace.verifiedRevocation() { await retire(host, proof: proof, retiredStore: store); return }
            guard generation == current, storageAvailable, !(connected && installedTransport?.valid == true) else { return }
            connected = false; offline = true; status = "不在线"
            if !Self.outOfReach(error) { report(error) }
            startReconnect()
        }
    }
    private func adoptTransport(_ path: NativeInstalledTransport, current: UUID) {
        guard generation == current, let workspace else { return }
        // The short background hold can keep only the connection it entered with.
        if hold.holding { hold.expired(); return }
        guard storageAvailable else { return }
        _ = path.epoch.whileCurrent {
            _ = withdrawWorkSessionBody()
            let restored = path.lease.map { (try? bindBodyLease($0, current: current)) != nil } ?? false
            if !restored {
                if verifiedUntil != nil { clearPrivateContent() }
                verifiedUntil = nil; expiryTask?.cancel()
            }
            installedTransport = path.epoch
            if let selectedHost { offlineCacheBlocked.remove(selectedHost.id) }
            adoptSnapshot(path.checkpoint, windowOpen: bodyLease?.valid == true)
            connected = true; status = "已连接"
            clearTransportRecovery()
            watchTransport(workspace, transport: path.epoch, current: current)
            startEvents()
            recoverInitialList()
        }
    }
    private func watchTransport(_ workspace: NativeWorkspace, transport: NativeTransportEpoch, current: UUID) {
        transportWatch?.cancel()
        transportWatch = Task { [weak self] in
            guard await workspace.transportEnded(on: transport), !Task.isCancelled,
                  let self, self.generation == current, self.workspace === workspace, self.installedTransport === transport else { return }
            if self.hold.holding { self.hold.expired() }
            else { self.recoverTransport(on: transport) }
        }
    }
    /** Retry a partial first checkpoint even when there is no body window for the list event stream. */
    private func recoverInitialList() {
        initialListTask?.cancel()
        guard let workspace, let transport = installedTransport, connected else { return }
        func current() -> Bool {
            !Task.isCancelled && installedTransport === transport && transport.valid && connected && storageAvailable && !hold.holding
        }
        initialListTask = Task {
            do {
                try await NativeReconnectPolicy.recoverIncompleteList(current: { current() ? self.snapshot : nil }) {
                    let reading = self.privateSnapshot.epoch, lease = self.bodyLease
                    let value = try await workspace.listCheckpoint()
                    guard current(), self.privateSnapshot.accepts(reading) else { throw CancellationError() }
                    self.adoptSnapshot(value, captured: reading, windowOpen: lease?.valid == true)
                }
            } catch {
                if current(), wentAway(error) { recoverTransport(on: transport) }
            }
        }
    }
    func refreshControlPending() async {
        guard let workspace else { return }
        let current = generation
        do { let value = try await workspace.pendingControl(); if generation == current { controlPending = value ?? .null } }
        catch { if generation == current { report(error) } }
    }
    func retryControl() async {
        guard let workspace, transportReady, !busy else { return }
        let current = generation
        busy = true; defer { if generation == current { busy = false } }
        do {
            guard let saved = try await workspace.pendingControl(), let path = saved["path"].string else { await refreshControlPending(); return }
            guard generation == current, transportReady else { return }
            controlsInFlight.insert(path); defer { controlsInFlight.remove(path) }
            _ = try await workspace.freeAction(path: path, fields: saved["fields"].object)
            guard generation == current else { return }
            await refreshControlPending(); _ = await refresh()
        } catch { if generation == current { await refreshControlPending(); report(error) } }
    }
    func ensureVerified(resuming retained: BodyLease? = nil) async throws {
        guard !restoringTransport else { throw CancellationError() }
        guard let workspace, let transport = installedTransport, transport.valid else { throw NativeFailure.unavailable }
        guard hasScope("view") else { throw NativeFailure.forbidden }
        let current = generation, openingWindow = privateSnapshot.epoch
        func restore(_ lease: BodyLease) async throws {
            guard !restoringTransport, installedTransport === transport, transport.valid, privateSnapshot.accepts(openingWindow) else { throw CancellationError() }
            try bindBodyLease(lease, current: current)
            let window = privateSnapshot.epoch
            let saved = try await workspace.pendingWrites()
            guard current == generation, !restoringTransport, installedTransport === transport, transport.valid, !hold.holding, !Task.isCancelled,
                  bodyLease?.sameWindow(as: lease) == true, privateSnapshot.accepts(window) else { throw CancellationError() }
            try lease.requireValid()
            pending = saved
        }
        if let lease = await workspace.lease() {
            guard retained?.sameWindow(as: lease) != false else { throw CancellationError() }
            try await restore(lease)
            return
        }
        guard retained == nil, generation == current, !restoringTransport, installedTransport === transport, transport.valid, !hold.holding,
              privateSnapshot.accepts(openingWindow) else { throw CancellationError() }
        verifying = true; defer { verifying = false }
        let lease = try await workspace.verify()
        try await restore(lease)
        timeline.record(.verification)
        startEvents()
        scheduleBookRefresh(hint: snapshot["host"]["native"]["discoveryEpoch"].string, directoryHint: snapshot["host"]["native"]["directoryEpoch"].string, force: true)
        scheduleProximity(workspace)
    }
    private func bindBodyLease(_ lease: BodyLease, current: UUID) throws {
        // A verification that answers while the App is in the background opens nothing on screen.
        guard current == generation, !hold.holding else { throw NativeFailure.expired }; try lease.requireValid()
        if bodyLease?.sameWindow(as: lease) != true {
            clearBodyReading()
#if LATCH_SCREENS
            PhoneLive.connectionCheckpoint(.windowBound, leaseValid: lease.valid, connected: connected)
#endif
            // Verification does not change the caller's selected session, draft or attachments.
            privateSnapshot.clear()
            clearWorkContent()
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
        guard current == generation, transportReady, verifiedUntil == nil, !verifying else { return }
        if let lastReopen, lastReopen.duration(to: .now) < .seconds(60) { return }
        lastReopen = .now
        if tab == .code, workItemsShown { await openWorkWindow(); return }
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
            if let checkpoint = value.checkpoint {
                guard self.adoptSnapshot(checkpoint, captured: context.content, windowOpen: context.lease.valid) else { return false }
                // Adopting changed scopes takes content down synchronously, before the body's assignment.
                guard self.bodyIsCurrent(context) else { return false }
            }
            if let detail = value.detail {
                self.detail = detail
                self.snapshot = PhoneSessions.projectingCurrentSummary(snapshot: self.snapshot, detail: detail, sessionId: context.session, cached: false)
                self.updateQuestionAttention()
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
            let value = try await context.workspace.listCheckpoint()
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
    @discardableResult func refresh(includeSelectedBody: Bool = true) async -> Bool {
        guard let workspace, !restoringTransport else { return false }
        let current = generation, selected = sessionId, transport = installedTransport
        func sameConnection() -> Bool { generation == current && !restoringTransport && installedTransport === transport && transport?.valid != false }
        var reading = privateSnapshot.epoch
        do {
            let lease = await workspace.lease()
            guard sameConnection() else { return false }
            if let lease { try bindBodyLease(lease, current: current) }
            else {
                if let bodyLease { closeBodyWindow(bodyLease, current: current) }
                else if verifiedUntil != nil { clearPrivateContent() }
                else { detail = .null; pending = []; PreviewFiles.clear(); clearAttachments() }
                verifiedUntil = nil
            }
            reading = privateSnapshot.epoch
            let value = try await workspace.listCheckpoint()
            guard sameConnection() else { return false }
            guard privateSnapshot.accepts(reading) else { return true }
            adoptSnapshot(value, captured: reading, windowOpen: lease?.valid == true)
            await refreshControlPending()
            guard sameConnection(), privateSnapshot.accepts(reading) else { return false }
            if includeSelectedBody, !waitingForSessionList, let selected, lease?.valid == true {
                let reading = contentGeneration
                guard try await readSelectedBody(selected, workspace: workspace), sameConnection(),
                      sessionId == selected, contentGeneration == reading, lease?.valid == true else { return false }
            }
            return true
        } catch {
            guard sameConnection(), privateSnapshot.accepts(reading), !Task.isCancelled, !(error is CancellationError) else { return false }
            if wentAway(error) {
                if let transport { recoverTransport(on: transport) }
            } else {
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
    /** Only a failed connection or a current list/stream probe starts recovery. Individual reads can fail on their own. */
    @discardableResult func wentAway(_ failure: Error) -> Bool {
        guard Self.outOfReach(failure) else { return false }
#if LATCH_SCREENS
        PhoneLive.connectionCheckpoint(.readUnavailable, leaseValid: bodyLease?.valid == true, connected: connected)
#endif
        return true
    }
    func startEvents(listOnly: Bool = false) {
        eventTask?.cancel()
        bodyRead?.cancelPending()
        refreshTask?.cancel(); refreshTask = nil; refreshId = nil; pendingEvent = nil
        streamGeneration = UUID()
        guard let workspace, let transport = installedTransport, !hold.holding, !restoringTransport else { return }
        let current = generation, selected = !listOnly && verifiedUntil != nil && !waitingForSessionList ? sessionId : nil, streamId = streamGeneration
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
                        timeline.recordOnce(.firstEvent)
                        if event.type == "heartbeat" || openedAt.duration(to: .now) >= .seconds(15) { eventRetryAttempt = 0 }
                        if event.type == "host-state" { hostNotice = PhoneHostNotice.parse(event.data) }
                        pendingEvent = (event, stream, selected)
                        scheduleEventRefresh(workspace: workspace, generation: current, stream: streamId)
                    }
                }
            } catch {
                guard !Task.isCancelled, generation == current, streamGeneration == streamId,
                      installedTransport === transport, transport.valid else { return }
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
                        && self.installedTransport === transport && transport.valid
                }, readCheckpoint: { try await workspace.listCheckpoint() }) else { return }
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
                recoverTransport(on: transport)
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
                    timeline.recordOnce(.firstEvent)
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
                    guard await refresh(includeSelectedBody: selected != nil), current == generation, streamGeneration == streamId else { return }
                    let applied = selected == nil ? snapshot["revision"].integer : detail["sync"]["revision"].integer
                    guard let applied else { return }
                    try await workspace.acknowledge(event, from: source, sessionId: selected, appliedRevision: applied)
                }
            } catch { if !(error is CancellationError), current == generation { report(error) } }
        }
    }
    func refreshInbox() async {
        if connected { _ = await refresh() }
        else if offline { retryConnection() }
    }
    private func recoverTransport(on transport: NativeTransportEpoch) {
        guard installedTransport === transport, transportReady, storageAvailable, !hold.holding,
              let interruption = reconnectPresentation.begin() else { return }
        eventTask?.cancel(); refreshTask?.cancel(); initialListTask?.cancel()
        bodyRead?.cancelPending(); cancelUpgrade()
        let current = generation
        // Give a replacement time to pass the connection checks before changing the page's connection state.
        offlineTask = Task { [weak self] in
            do { try await Task.sleep(until: interruption.deadline, clock: .continuous) } catch { return }
            guard let self, self.generation == current, self.installedTransport === transport,
                  self.reconnectPresentation.shouldShowOffline(for: interruption) else { return }
            self.publishOffline()
        }
        startReconnect(immediately: true)
    }
    private func publishOffline() {
        guard !offline else { return }
        offlineTask?.cancel(); offlineTask = nil
        connected = false; offline = true; status = "不在线"
    }
    private func clearTransportRecovery() {
        offlineTask?.cancel(); offlineTask = nil
        reconnectPresentation.reset()
    }
    private func cancelReconnect() {
        reconnectTask?.task.cancel()
        reconnectTask = nil
        reconnectDelay?.cancel(); reconnectDelay = nil
        reconnectBookChanged = false
        clearTransportRecovery()
    }
    /** Reconnecting is automatic; this only starts the next try now. */
    func retryConnection() {
        guard let selectedHost, !busy, !connected, !forgettingComputers.contains(selectedHost.id) else { return }
        cancelReconnect()
        if workspace == nil { Task { await connect(selectedHost) } }
        else { offline = false; status = "正在连接…"; startReconnect(immediately: true) }
    }
    private func startReconnect(immediately: Bool = false) {
        guard reconnectTask == nil, storageAvailable, !hold.holding, let workspace, let host = selectedHost else { return }
        let current = generation, id = UUID()
        reconnectTask = (id, Task {
            defer { if reconnectTask?.id == id { reconnectTask = nil } }
            for attempt in 0..<1000 {
                // An announced restart, update, stop or sleep says when to look again.
                let delay = hostNotice.map { Duration.seconds($0.retryAfter) }
                    ?? (reconnectBookChanged ? .zero : NativeReconnectPolicy.delay(attempt: attempt, afterNetworkChange: immediately))
                let waiting = Task { try await Task.sleep(for: delay) }
                reconnectDelay = waiting
                _ = await waiting.result
                guard current == generation, reconnectTask?.id == id, !Task.isCancelled, storageAvailable, !hold.holding else { return }
                reconnectDelay = nil
                reconnectBookChanged = false
                let previous = installedTransport, interruption = reconnectPresentation.interruption
                do {
                    try await dialRound(host, workspace: workspace, current: current, recovering: restoringTransport || !connected)
                    guard current == generation, !Task.isCancelled else { return }
                    await bookRefresher?.connectionChanged()
                    guard current == generation, !Task.isCancelled else { return }
                    _ = await refresh()
                    guard current == generation, !Task.isCancelled else { return }
                    if !transportReady || reconnectBookChanged { continue }
                    scheduleProximity(workspace); return
                } catch {
                    if Task.isCancelled || current != generation { return }
                    let proof = await workspace.verifiedRevocation()
                    guard current == generation, !Task.isCancelled else { return }
                    if let proof { await retire(host, proof: proof); return }
                    if !reconnectBookChanged, installedTransport === previous,
                       reconnectPresentation.shouldShowOffline(afterFailedRound: interruption, connected: connected) { publishOffline() }
                }
            }
        })
    }
    /**
     * A monitor's first callback is its baseline: the round already dialing uses this network, so it is not cancelled.
     * Later callbacks with the same interfaces, gateways and usability are ignored too.
     */
    private func observeNetwork() {
        let next = NWPathMonitor(); monitor = next; networkFilter.reset()
        monitorGeneration = UUID(); let current = monitorGeneration
        next.pathUpdateHandler = { [weak self] path in Task { @MainActor in
            guard let self, self.monitorGeneration == current else { return }
            self.currentNetworkPath = path
            let change = self.networkFilter.observe(NativeNetworkSignature(path))
            if path.status == .satisfied, change != .unchanged { self.warmRelays() }
            guard change == .changed else { return }
#if LATCH_SCREENS
            PhoneLive.connectionCheckpoint(.networkChanged, leaseValid: self.bodyLease?.valid == true, connected: self.connected)
#endif
            if self.hold.holding { self.lock(); return }
            self.proximityTask?.cancel(); self.proximityTask = nil
            self.networkGeneration = UUID(); self.freshPairings.removeAll(); self.discovery.stop()
            if path.status == .satisfied, let host = self.selectedHost { try? self.startDiscovery(host) }
            self.othersNetworkChanged()
            let network = self.networkGeneration
            await self.paths.forgetFailures()
            guard self.monitorGeneration == current, self.networkGeneration == network, path.status == .satisfied else { return }
            if self.transportReady, let workspace = self.workspace {
                self.scheduleProximity(workspace)
                self.tryUpgrade()
            } else if self.hostNotice == nil {
                // Wake a backoff, but leave an in-flight relay dial alone.
                self.reconnectDelay?.cancel()
                if !self.busy { self.startReconnect(immediately: true) }
            }
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
        guard storageAvailable, !hold.holding else { return }
        do {
            if oldKey != newBook.discoveryKey { discovery.stop(); try startDiscovery(saved) }
            try await dialRound(saved, workspace: workspace, current: current, changedBook: true)
            guard generation == current else { return }
            await bookRefresher?.connectionChanged()
            guard generation == current else { return }
            _ = await refresh()
        } catch { if generation == current, !Task.isCancelled, !(error is CancellationError) { startReconnect() } }
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
        discovery.onChange = { [weak self] in self?.discoveryChanged() }
        try discovery.start(key: key)
    }
    private func currentGateway() -> Data? { currentNetworkPath.flatMap { NativeDiscoveryWire.currentGatewayHashes($0).first } }
    /**
     * One dial round: known direct candidates and the relay, or, while browsing has no result yet, a direct candidate that
     * waits up to its deadline. On recovery the relay starts immediately. On first connect, direct can have a head start.
     */
    private func dialRound(_ host: RegisteredHost, workspace: NativeWorkspace, current: UUID, recovering: Bool = false, changedBook: Bool = false) async throws {
        let latest = hosts.first { $0.id == host.id } ?? host
        try? startDiscovery(latest)
        let available = try await candidates(latest)
        guard generation == current, storageAvailable, !hold.holding, self.workspace === workspace, !Task.isCancelled else { throw NativeFailure.unavailable }
        if changedBook, reconnectTask != nil {
            // The active recovery can finish its attempt, then use the newly verified book.
            reconnectBookChanged = true
            if hostNotice == nil { reconnectDelay?.cancel() }
            throw CancellationError()
        }
        let known = available.contains { $0.kind == .direct }, gateway = currentGateway(), network = networkGeneration
        let later = known || !discovery.browsing ? nil : discovery.lateCandidates(device: latest.device, keys: PhoneKeys.provider(latest.keys))
        let delay = recovering ? .zero : NativeReconnectPolicy.relayDelay(directKnown: known, lastWinner: winners.winner(gateway: gateway))
        _ = try await paths.migrate(available, later: later, relayDelay: delay, workspace: workspace)
        let kind = await workspace.installedPathKind()
        guard generation == current else { return }
        if networkGeneration == network { winners.record(kind, gateway: gateway) }
        // The reads that follow a new connection go first; the upgrade waits for a quiet path anyway.
        if kind == .relay { tryUpgrade(after: .seconds(1)) }
    }
    private func discoveryChanged() {
        timeline.recordOnce(.firstBrowse)
        tryUpgrade()
    }
    private func cancelUpgrade() {
        upgradeTask?.task.cancel()
        upgradeTask = nil
    }
    /**
     * On a relay, a direct path that browsing found moves the connection in the background. It waits for the path to be
     * quiet and tries a few times, seconds apart; a failure leaves the relay.
     */
    private func tryUpgrade(after delay: Duration = .zero) {
        guard upgradeTask == nil, transportReady, !hold.holding, storageAvailable, let workspace, let host = selectedHost else { return }
        let current = generation, id = UUID()
        upgradeTask = (id, Task { [weak self] in
            defer { if self?.upgradeTask?.id == id { self?.upgradeTask = nil } }
            if delay > .zero { do { try await Task.sleep(for: delay) } catch { return } }
            for _ in 0..<5 {
                guard let self, self.generation == current, self.transportReady, !self.hold.holding, self.storageAvailable,
                      self.workspace === workspace, await workspace.installedPathKind() == .relay else { return }
                let latest = self.hosts.first { $0.id == host.id } ?? host
                let directs = (try? await self.discovery.candidates(device: latest.device, keys: PhoneKeys.provider(latest.keys))) ?? []
                if !directs.isEmpty, await self.paths.upgrade(directs, workspace: workspace) {
                    guard self.generation == current, self.workspace === workspace else { return }
                    self.winners.record(.direct, gateway: self.currentGateway())
                    await self.bookRefresher?.connectionChanged()
                    guard self.generation == current else { return }
                    _ = await self.refresh(); self.scheduleProximity(workspace)
                    return
                }
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        })
    }
    private func warmRelays() {
        guard let host = selectedHost ?? hosts.first(where: { $0.id == lastHostId }) ?? hosts.first else { return }
        let book = try? AddressBookCodec.verify(host.device.signedAddressBook, rootSpki: host.device.rootSpki, deviceId: host.device.deviceId,
            nowMs: UInt64(max(0, Date().timeIntervalSince1970 * 1000)), priorGeneration: host.device.bookGeneration, priorHash: host.device.bookHash)
        NativeRelayWarmup.warm(book)
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
        guard let currentStore = retiredStore ?? store, currentStore === store, !forgettingComputers.contains(host.id) else { return }
        _ = await removeComputer(host, from: currentStore, showRevocation: !removedHere) {
            try await currentStore.retire(host, proof: proof)
        }
    }
    func forgetComputer(_ host: RegisteredHost) async -> Bool {
        guard let store, storageAvailable, !busy, pairingTask == nil,
              selectedHost?.id != host.id || !connected,
              hosts.contains(where: { $0.id == host.id }), forgettingComputers.insert(host.id).inserted else { return false }
        watchOthers()
        let removed = await removeComputer(host, from: store, showRevocation: false, localOnly: true) { try await store.forget(host.id) }
        forgettingComputers.remove(host.id)
        if !removed, self.store === store, storageAvailable {
            watchOthers()
            if selectedHost == nil, let saved = hosts.first { await connect(saved) }
            if self.store === store, storageAvailable, !hosts.contains(where: { $0.id == host.id }) {
                error = "本机资料未清理完。请重新打开 Latch 继续清理。"
            }
        }
        return removed
    }
    private func removeComputer(_ host: RegisteredHost, from currentStore: PhoneStore, showRevocation: Bool, localOnly: Bool = false,
                                remove: @escaping @MainActor () async throws -> Void) async -> Bool {
        let isCurrent = selectedHost?.id == host.id
        let old = isCurrent ? workspace : nil
        offlineCacheBlocked.insert(host.id)
        freshPairings.removeValue(forKey: host.id)
        if pendingOther?.computer == host.id { pendingOther = nil }
        if isCurrent {
            generation = UUID(); cancelReconnect(); initialListTask?.cancel(); eventTask?.cancel(); expiryTask?.cancel(); refreshTask?.cancel()
            resetBookRefresh(); proximityTask?.cancel(); proximityTask = nil
            hold.release(); transportWatch?.cancel(); transportWatch = nil; cancelUpgrade()
            clearPrivateContent(); resetWorkItems(); resetSessionActions(); resetReview()
            controlPending = .null; snapshot = .null; verifiedUntil = nil; selectedHost = nil; connected = false; offline = false
            sessionId = nil; resumeSession = nil; lastHostId = nil; agentPath = []; appPath = []; heldDrafts = [:]
            returnedText = [:]; openAfterDismiss = nil
            controlsInFlight = []; controlTail = nil; discovery.stop()
            workspace = nil; installedTransport = nil; busy = false
        }
        let current = generation
        var removed = false
        let finish = { @MainActor in
            do { try await remove(); removed = true }
            catch { if !localOnly, self.generation == current { self.report(error) } }
        }
        if isCurrent {
            storageOpening.close {
                await self.closeConnection(old, hostId: host.id)
                await finish()
            }
            guard await storageOpening.waitForClose() else { return false }
        } else {
            await watchTail?.value
            await finish()
        }
        let saved = await currentStore.list()
        guard store === currentStore, storageAvailable else { return false }
        if !saved.contains(where: { $0.id == host.id }) {
            hosts.removeAll { $0.id == host.id }
            QuotaWidgetWriter.forget()
            if let draft, draft.keys.connectionTag == host.keys.connectionTag,
               draft.keys.verificationTag == host.keys.verificationTag { self.draft = nil }
            forgetNotices(host, onlyThisComputer: localOnly)
            watchOthers()
        }
        guard generation == current else { return removed }
        if isCurrent || selectedHost == nil {
            removedByMac = showRevocation
            status = "选择一台电脑"
            if let next = hosts.first(where: { !forgettingComputers.contains($0.id) }) { await connect(next) }
        }
        return removed
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
    func withdrawWorkContent() {
        clearPrivateContent()
        Task { await refresh() }
    }
    private func clearPrivateContent() {
        if questionAttention != nil { questionAttention = nil }
        questionTopic = nil
        resumeAfterListing = nil
        privateSnapshot.clear()
        clearWorkContent()
        createdHelper = nil
        cancelPreview()
        detail = .null; detailFailed = nil; pending = []; contentGeneration = UUID(); PreviewFiles.clear(); clearAttachments()
        contentSearch = PhoneContentSearch(); forkDraft = nil; draftInserts = [:]; editPaths = [:]
        // Diffs, notes and handoffs are content: they go with the window, and the review page with them.
        reviewTarget = nil; sessionHandoffs = nil; handoffSignature = ""; handoffDraft = nil
        // Agents' names, duties and schedules came with the window and go with it.
        snapshot = PhoneAgents.takeDown(snapshot, proposals: &proposals, results: &agentResults)
    }
    @discardableResult private func adoptSnapshot(_ checkpoint: NativeListCheckpoint, captured: UUID? = nil, windowOpen: Bool) -> Bool {
        guard captured.map(privateSnapshot.accepts) ?? true else { return false }
        return listPublication.apply(checkpoint, on: installedTransport) { value in
            self.displaySnapshot(value, live: true, captured: captured, windowOpen: windowOpen)
        }
    }
    @discardableResult private func displaySnapshot(_ value: NativeJSON, live: Bool, captured: UUID? = nil, windowOpen: Bool = false) -> Bool {
        if let instance = value["instanceId"].string, snapshot["instanceId"].string == instance,
           let revision = value["revision"].integer, let applied = snapshot["revision"].integer, revision < applied { return false }
        let keys = ["status", "scopes", "dataScope"]
        let changedScope = snapshot != .null && keys.contains(where: { snapshot["device"][$0] != value["device"][$0] })
        let changedInstance = snapshot["instanceId"].string.map { $0 != value["instanceId"].string } ?? false
        let withdraw = changedScope || changedInstance
        if withdraw {
            if waitingForSessionList { sessionId = nil }
            clearPrivateContent(); heldDrafts = [:]
        }
        guard let projected = privateSnapshot.adopt(value, captured: withdraw ? privateSnapshot.epoch : captured ?? privateSnapshot.epoch,
            windowOpen: windowOpen && !withdraw) else { return false }
        let previousSources = workItemsShown ? snapshot["tasks"].array : []
        snapshot = PhoneSessions.projectingCurrentSummary(snapshot: projected, detail: detail, sessionId: sessionId, cached: detailCached)
        reconcileWorkSources(previousSources)
        if live {
            updateQuestionAttention()
            refreshReviewShortcuts()
            if resumeAfterListing != nil { Task { await restoreListedSession() } }
        }
        if let hostTime = PhoneTime.parse(value["hostTime"]) {
            // A cached list is old by definition: it says when it was true, not what the Host's clock reads now.
            if live { hostClockOffset = hostTime.timeIntervalSinceNow; lastConfirmed = Date() } else { lastConfirmed = hostTime }
        } else if live { lastConfirmed = Date() }
        if live, let computer = selectedHost?.id {
            QuotaWidgetWriter.note(snapshot["catalog"], computer: computer, hostNow: hostNow(), hostOffset: hostClockOffset)
        }
        scheduleBookRefresh(hint: value["host"]["native"]["discoveryEpoch"].string, directoryHint: value["host"]["native"]["directoryEpoch"].string)
        return true
    }

    func updateQuestionAttention(computer: String? = nil) {
        let next = (computer ?? selectedHost?.id).flatMap { PhoneQuestionAttention(computer: $0, snapshot: snapshot) }
        if next != questionAttention { questionAttention = next }
        if let link = pendingQuestionLink, let next {
            pendingQuestionLink = nil
            if link.expires > Date(), link.computer == nil || link.computer == next.computer, let session = next.sessions.first {
                Task { await requestPendingQuestion(computer: next.computer, session: session) }
            }
        }
    }

    /** Taps navigate only through a live, authorized list. The widget URL never carries an identifier. */
    func requestPendingQuestion(computer: String? = nil, session: String? = nil) async {
        guard let attention = questionAttention, connected, storageAvailable, !hold.holding else {
            if computer == nil && session == nil {
                pendingQuestionLink = (selectedHost?.id, Date().addingTimeInterval(15))
            }
            return
        }
        guard computer == nil || computer == attention.computer, let target = session ?? attention.sessions.first,
              attention.sessions.contains(target), let row = snapshot["tasks"].array.first(where: { $0["id"].string == target }) else { return }
        resumeAfterListing = nil
        showWorkItems(false); reviewTarget = nil
        if PhoneSpaces.split(snapshot), let owner = PhoneAgentChat.owner(row) {
            tab = .agents; agentPath = [owner]; questionTopic = target
        } else {
            tab = .code
        }
        if sessionId != target || !hasContentWindow || detailCached || detail["summary"]["id"].string != target || detail["questions"].array.isEmpty {
            await openSession(target)
        }
    }
}
