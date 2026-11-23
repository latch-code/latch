import Foundation
import LatchNativeCore
import NIOCore
import NIOEmbedded
import NIOHTTP2
import NIOTransportServices

/** A paired fixture device on a loopback Host: the same steps the App's pairing takes, with in-memory keys. */
struct ReconnectDevice {
    let device: PreparedNativeDevice
    let keys: FixtureKeys
    let directory: URL
    let port: UInt16
    func open(port override: UInt16? = nil) async throws -> NativeHTTPConnection {
        try await NativeHTTPConnection.open(host: "127.0.0.1", port: override ?? port, rootSpki: device.rootSpki,
            knockKey: device.knockKey, identity: keys.identity())
    }
    func workspace(prefetch: Bool, installed: (@MainActor @Sendable (NativeInstalledTransport) -> Void)? = nil) throws -> NativeWorkspace {
        let vault = try EncryptedVault(directory: directory.appendingPathComponent(UUID().uuidString), key: LinkBytes.random(32), binding: device.hostId)
        return try NativeWorkspace(device: device, keys: keys, vault: vault, onTransportInstalled: installed, prefetchChallenge: { prefetch })
    }
}

@MainActor func reconnectDevice(_ input: [String: Any]) async throws -> ReconnectDevice {
    let invitation = try PairingInvitation.parse(input["payload"] as? String ?? "", privateOnly: false), port = try fixturePort(input), keys = try FixtureKeys()
    let pairing = try NativePairing(invitation: invitation, keys: keys)
    let temporary = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey)
    _ = try await pairing.begin(on: temporary, name: "Swift reconnect fixture", gatewayHash: Data(repeating: 0, count: 32))
    var approved = false
    for _ in 0..<60 {
        if let view = try await pairing.status(on: temporary), view.status == "approved" { approved = true; break }
        try await Task.sleep(for: .milliseconds(50))
    }
    guard approved else { throw NativeFailure.unavailable }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-reconnect-" + UUID().uuidString)
    let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: invitation.hostId)
    let device = try await pairing.complete(on: temporary) { device in try await vault.storeMetadata(JSONEncoder().encode(device), name: "device") }
    await temporary.close()
    return ReconnectDevice(device: device, keys: keys, directory: directory, port: port)
}

private func elapsedMs(since start: ContinuousClock.Instant) -> Double {
    let duration = start.duration(to: .now)
    return Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
}

/** The connection a candidate opened, and when candidates started dialing. */
actor ReconnectBox {
    var connection: NativeHTTPConnection?
    var starts: [Double] = []
    func keep(_ value: NativeHTTPConnection) { connection = value }
    func started(_ ms: Double) { starts.append(ms) }
}
@MainActor final class ReconnectInstalls {
    var count = 0
    var epoch: NativeTransportEpoch?
    func record(_ path: NativeInstalledTransport) { count += 1; epoch = path.epoch }
}

private func fixtureFailure(_ name: String) -> FixtureStage { FixtureStage(name: name) }

/** Retry and relay timing, the path filter, last winners, the timeline ring, the background hold and PING liveness. */
@MainActor func runReconnectRules() async throws -> [String: Any] {
    // The Host's first list can be partial while the Harness starts. A confirmed empty list is already final.
    let partial: NativeJSON = .object(["tasks": .array([])])
    let complete: NativeJSON = .object(["tasks": .array([]), "tasksComplete": .bool(true)])
    var firstList: NativeJSON? = partial, listReads = 0
    try await NativeReconnectPolicy.recoverIncompleteList(current: { firstList }) {
        listReads += 1
        firstList = .object(["tasks": .array([.object(["id": .string("session")])]), "tasksComplete": .bool(true)])
    }
    guard listReads == 1, firstList?["tasks"].array.first?["id"].string == "session" else { throw fixtureFailure("initial-list") }
    try await NativeReconnectPolicy.recoverIncompleteList(current: { complete }) { throw fixtureFailure("complete-empty-list-retried") }
    // Lose the selection while the first delay is running. Its read must never reach the replacement connection.
    let withdraw = Task { @MainActor in firstList = nil }
    firstList = partial
    try await NativeReconnectPolicy.recoverIncompleteList(current: { firstList }) { throw fixtureFailure("old-list-retried") }
    await withdraw.value

    // An idle session can have only resumed heartbeats. Its first readable list must trigger one full body read.
    let host = UUID(), selection = UUID(), content = UUID()
    let resume = PhoneResumingSession(session: "held", host: host, selection: selection, content: content, tab: .code, agentPath: [])
    var deferred: PhoneResumingSession? = resume
    func listing(_ present: Bool, complete: Bool) -> NativeJSON {
        .object(["device": .object(["status": .string("active"), "scopes": .array([.string("view")])]),
            "tasks": .array(present ? [.object(["id": .string("held")])] : []), "tasksComplete": .bool(complete)])
    }
    guard PhoneResumingSession.resolve(&deferred, current: resume, snapshot: listing(false, complete: false)) == nil, deferred == resume,
          PhoneResumingSession.resolve(&deferred, current: resume, snapshot: listing(true, complete: false)) == .read,
          PhoneResumingSession.resolve(&deferred, current: resume, snapshot: listing(true, complete: true)) == nil else { throw fixtureFailure("held-session-appears") }
    deferred = resume
    guard PhoneResumingSession.resolve(&deferred, current: resume, snapshot: listing(false, complete: true)) == .close else { throw fixtureFailure("held-session-gone") }
    for changed in [
        PhoneResumingSession(session: "held", host: UUID(), selection: selection, content: content, tab: .code, agentPath: []),
        PhoneResumingSession(session: "held", host: host, selection: UUID(), content: content, tab: .code, agentPath: []),
        PhoneResumingSession(session: "held", host: host, selection: selection, content: UUID(), tab: .code, agentPath: []),
        PhoneResumingSession(session: "held", host: host, selection: selection, content: content, tab: .settings, agentPath: []),
    ] {
        deferred = resume
        guard PhoneResumingSession.resolve(&deferred, current: changed, snapshot: listing(true, complete: true)) == nil,
              deferred == nil else { throw fixtureFailure("held-session-changed") }
    }

    // A network change retries at once; failures still back off with bounded jitter.
    guard NativeReconnectPolicy.delay(attempt: 0, afterNetworkChange: true, jitter: 1) == .zero,
          NativeReconnectPolicy.delay(attempt: 0, afterNetworkChange: false, jitter: 0) == .milliseconds(500),
          NativeReconnectPolicy.delay(attempt: 0, afterNetworkChange: false, jitter: 1) == .milliseconds(625),
          NativeReconnectPolicy.delay(attempt: 1, afterNetworkChange: true, jitter: 0) == .seconds(1),
          NativeReconnectPolicy.delay(attempt: 50, afterNetworkChange: false, jitter: 1) == .milliseconds(37_500) else { throw fixtureFailure("backoff") }
    guard NativeReconnectPolicy.relayDelay(directKnown: false, lastWinner: nil) == .zero,
          NativeReconnectPolicy.relayDelay(directKnown: false, lastWinner: .relay) == .zero,
          NativeReconnectPolicy.relayDelay(directKnown: true, lastWinner: nil) == .milliseconds(250),
          NativeReconnectPolicy.relayDelay(directKnown: false, lastWinner: .direct) == .milliseconds(600) else { throw fixtureFailure("relay-delay") }
    var winners = NativeWinningPaths()
    let home = Data(repeating: 1, count: 32), office = Data(repeating: 2, count: 32)
    winners.record(.direct, gateway: home); winners.record(.relay, gateway: office); winners.record(.direct, gateway: nil)
    for index in 0..<16 { winners.record(.relay, gateway: Data(repeating: UInt8(10 + index), count: 32)) }
    guard winners.winner(gateway: home) == nil, winners.winner(gateway: nil) == nil,
          winners.winner(gateway: Data(repeating: 25, count: 32)) == .relay else { throw fixtureFailure("winners") }
    winners.record(.direct, gateway: home)
    guard winners.winner(gateway: home) == .direct else { throw fixtureFailure("winners") }
    // The first callback of a monitor is a baseline and cancels nothing; only a different path is a change.
    var filter = NativeNetworkChangeFilter()
    let wifi = NativeNetworkSignature(usable: true, interfaces: ["wifi/en0"], gateways: ["192.0.2.1:0"])
    let cellular = NativeNetworkSignature(usable: true, interfaces: ["cellular/pdp_ip0"], gateways: [])
    let changes = [filter.observe(wifi), filter.observe(wifi), filter.observe(cellular), filter.observe(cellular),
        filter.observe(NativeNetworkSignature(usable: false, interfaces: [], gateways: []))]
    filter.reset()
    guard changes == [.baseline, .unchanged, .changed, .unchanged, .changed], filter.observe(cellular) == .baseline else { throw fixtureFailure("filter") }
    let ring = NativeConnectionTimeline()
    ring.begin()
    for _ in 0..<100 { ring.record(.connect, path: .direct, ordinal: 300) }
    ring.recordOnce(.firstBrowse); ring.recordOnce(.firstBrowse)
    let entries = ring.entries()
    guard entries.count == NativeConnectionTimeline.capacity, entries.last?.phase == .firstBrowse,
          entries.filter({ $0.phase == .firstBrowse }).count == 1, entries.allSatisfy({ $0.round == 1 }) else { throw fixtureFailure("ring") }
    // The hold: content goes on entry, the end comes once, and lock or expiry tears down.
    var log: [String] = []
    let hold = NativeBackgroundHold(limit: .milliseconds(200))
    hold.enter(withdraw: { log.append("withdraw") }, finish: { log.append("finish") }, expire: { log.append("teardown") })
    guard log == ["withdraw"], hold.holding else { throw fixtureFailure("hold-enter") }
    try await Task.sleep(for: .milliseconds(100))
    guard log == ["withdraw"] else { throw fixtureFailure("hold-early") }
    try await Task.sleep(for: .milliseconds(250))
    guard log == ["withdraw", "finish", "teardown"], !hold.holding, !hold.resume() else { throw fixtureFailure("hold-expiry") }
    log = []
    hold.enter(withdraw: { log.append("withdraw") }, finish: { log.append("finish") }, expire: { log.append("teardown") })
    hold.release(); hold.expired(); hold.release()
    try await Task.sleep(for: .milliseconds(300))
    guard log == ["withdraw", "finish"] else { throw fixtureFailure("hold-lock") }
    log = []
    hold.enter(withdraw: { log.append("withdraw") }, finish: { log.append("finish") }, expire: { log.append("teardown") })
    let resumed = hold.resume(), again = hold.resume()
    try await Task.sleep(for: .milliseconds(300))
    guard resumed, !again, log == ["withdraw", "finish"] else { throw fixtureFailure("hold-resume") }
    guard NativeBackgroundHold.limit == .seconds(30) else { throw fixtureFailure("hold-limit") }
    return ["initialListRecovers": true, "backoff": true, "relayDelay": true, "winners": true, "filter": true, "ring": true, "holdWithdrawsAtOnce": true,
        "holdExpires": true, "holdLockTearsDown": true, "holdResumes": true, "drafts": try reconnectDraftRules(), "presentation": try reconnectPresentationRules(), "liveness": try livenessRules()]
}

/** Recreating a composer's field only reads the live session's draft; it never commits the locked field's empty display. */
@MainActor private func reconnectDraftRules() throws -> [String: Bool] {
    let drafts = PhoneConversationDrafts(), old = drafts.opening
    let note = "未发送的草稿"
    drafts.set(note, for: "first", opening: old, permitted: true)
    guard drafts.text(for: "first", visible: false).isEmpty else { throw fixtureFailure("draft-hidden") }
    drafts.set("", for: "first", opening: old, permitted: false)
    drafts.set("another", for: "second", opening: old, permitted: true)
    guard drafts.text(for: "first", visible: true) == note,
          drafts.text(for: "second", visible: true) == "another" else { throw fixtureFailure("draft-recreated") }
    drafts.set("é", for: "second", opening: old, permitted: true)
    drafts.set("e\u{301}", for: "second", opening: old, permitted: true)
    guard drafts.text(for: "second", visible: true).utf8.elementsEqual("e\u{301}".utf8) else { throw fixtureFailure("draft-exact-text") }
    drafts.set("", for: "second", opening: old, permitted: true)
    guard drafts.text(for: "second", visible: true).isEmpty else { throw fixtureFailure("draft-deleted") }
    drafts.restore("returned", for: "first", opening: old)
    guard drafts.text(for: "first", visible: true) == PhonePending.joined(note, "returned"),
          drafts.text(for: "second", visible: true).isEmpty else { throw fixtureFailure("draft-returned-to-original") }
    drafts.clear()
    drafts.restore("late return", for: "first", opening: old)
    drafts.set(note, for: "first", opening: old, permitted: true)
    guard drafts.text(for: "first", visible: true).isEmpty else { throw fixtureFailure("draft-old-writer") }
    func editor(_ fields: [String: NativeJSON] = [:], permission: NativeJSON = .null, scopes: [String] = ["view", "run"], active: Bool = true, bodyOpen: Bool = true) -> Bool {
        var summary = fields
        summary["id"] = .string("first")
        let device: NativeJSON = .object(["status": .string(active ? "active" : "revoked"), "scopes": .array(scopes.map(NativeJSON.string))])
        return PhoneConversation.keepsOfflineEditor(summary: .object(summary), permission: permission, device: device, bodyOpen: bodyOpen)
    }
    guard editor(), !editor(bodyOpen: false), !editor(active: false), !editor(scopes: ["view"]), !editor(scopes: ["run"]),
          !editor(["agentPrivate": .bool(true)]), !editor(["agent": .object([:])]), !editor(["personal": .object([:])]),
          !editor(["generalChat": .bool(true)]), !editor(["automationId": .string("auto")]), !editor(["imported": .object([:])]),
          !editor(["permissionDrift": .bool(true)]), !editor(permission: .object(["drift": .object([:])])) else { throw fixtureFailure("draft-offline-editor") }
    return ["windowHidesText": true, "recreatedFieldKeepsDraft": true, "editingCanClear": true, "resetRejectsOldWriter": true, "onlyPermittedCodeEditsOffline": true]
}

private func reconnectPresentationRules() throws -> [String: Bool] {
    let start = ContinuousClock.now
    var ui = PhoneReconnectPresentation()
    guard ui.permitsRequests(connected: true, transportValid: true),
          !ui.permitsRequests(connected: true, transportValid: false),
          !ui.shouldShowOffline(afterFailedRound: nil, connected: true),
          ui.shouldShowOffline(afterFailedRound: nil, connected: false),
          let lost = ui.begin(at: start), ui.begin(at: start) == nil,
          !ui.permitsRequests(connected: true, transportValid: true),
          !ui.shouldShowOffline(at: start.advanced(by: .milliseconds(5_999)), for: lost) else { throw fixtureFailure("presentation-grace") }
    guard ui.shouldShowOffline(afterFailedRound: lost, connected: true),
          ui.shouldShowOffline(at: start.advanced(by: .seconds(6)), for: lost) else { throw fixtureFailure("presentation-offline") }

    ui.beginRound(withRelay: true)
    let bound = start.advanced(by: .seconds(24))
    guard ui.offlineDeadline(for: lost) == bound,
          !ui.shouldShowOffline(at: start.advanced(by: .seconds(8)), for: lost),
          !ui.shouldShowOffline(afterFailedRound: lost, connected: true),
          !ui.permitsRequests(connected: true, transportValid: true) else { throw fixtureFailure("presentation-relay-handshake") }
    ui.beginRound(withRelay: true)
    guard ui.shouldShowOffline(afterFailedRound: lost, connected: true),
          !ui.shouldShowOffline(at: start.advanced(by: .milliseconds(23_999)), for: lost),
          ui.shouldShowOffline(at: bound, for: lost) else { throw fixtureFailure("presentation-relay-bound") }

    ui.reset()
    guard ui.permitsRequests(connected: true, transportValid: true),
          !ui.shouldShowOffline(at: lost.deadline, for: lost),
          !ui.shouldShowOffline(afterFailedRound: lost, connected: true),
          let next = ui.begin(at: start),
          !ui.shouldShowOffline(at: lost.deadline, for: lost),
          !ui.shouldShowOffline(afterFailedRound: lost, connected: true),
          ui.shouldShowOffline(afterFailedRound: next, connected: true) else { throw fixtureFailure("presentation-old-callback") }

    ui.reset()
    guard !ui.permitsRequests(connected: false, transportValid: false),
          !ui.shouldShowOffline(at: next.deadline, for: next),
          !ui.shouldShowOffline(afterFailedRound: next, connected: false) else { throw fixtureFailure("presentation-withdrawn") }
    return ["boundedRelayRetry": true, "graceBlocksRequests": true, "failedOrExpiredShowsOffline": true, "replacementIgnoresOldCallbacks": true, "clearedOpeningIgnoresOldCallbacks": true]
}

/** The PING rule on a virtual clock: about 20 s for a silent peer, never while acknowledgements come. */
func livenessRules() throws -> [String: Any] {
    func pings(_ channel: EmbeddedChannel) throws -> [HTTP2PingData] {
        var result: [HTTP2PingData] = []
        while let frame = try channel.readOutbound(as: HTTP2Frame.self) {
            guard frame.streamID == .rootStream, case let .ping(data, ack: false) = frame.payload else { throw fixtureFailure("liveness-frame") }
            result.append(data)
        }
        return result
    }
    func acknowledge(_ ping: HTTP2PingData, on channel: EmbeddedChannel) throws {
        try channel.writeInbound(HTTP2Frame(streamID: .rootStream, payload: .ping(ping, ack: true)))
        _ = try channel.readInbound(as: HTTP2Frame.self)
    }
    let silent = EmbeddedChannel(handler: NativeLivenessHandler())
    try silent.connect(to: SocketAddress(ipAddress: "127.0.0.1", port: 9)).wait()
    var sent = try pings(silent).count
    silent.embeddedEventLoop.advanceTime(by: .seconds(10))
    sent += try pings(silent).count
    silent.embeddedEventLoop.advanceTime(by: .milliseconds(9_900))
    let openAt19 = silent.isActive
    silent.embeddedEventLoop.advanceTime(by: .milliseconds(100))
    let closedAt20 = !silent.isActive
    guard sent == 2, openAt19, closedAt20 else { throw fixtureFailure("liveness-silent") }
    let live = EmbeddedChannel(handler: NativeLivenessHandler())
    try live.connect(to: SocketAddress(ipAddress: "127.0.0.1", port: 9)).wait()
    for _ in 0..<12 {
        for data in try pings(live) { try acknowledge(data, on: live) }
        live.embeddedEventLoop.advanceTime(by: .seconds(10))
    }
    guard live.isActive else { throw fixtureFailure("liveness-live") }
    _ = try? live.finish()

    let pathLoss = NIOTSNetworkEvents.ViabilityUpdate(isViable: false)
    for recovered in [false, true] {
        let direct = EmbeddedChannel(handler: NativeLivenessHandler(fast: true))
        try direct.connect(to: SocketAddress(ipAddress: "127.0.0.1", port: 9)).wait()
        guard let old = try pings(direct).first else { throw fixtureFailure("liveness-first-ping") }
        direct.embeddedEventLoop.advanceTime(by: .milliseconds(500))
        direct.pipeline.fireUserInboundEventTriggered(pathLoss)
        guard let probe = try pings(direct).first, probe != old else { throw fixtureFailure("liveness-path-probe") }
        direct.pipeline.fireUserInboundEventTriggered(pathLoss)
        guard try pings(direct).isEmpty else { throw fixtureFailure("liveness-duplicate-probe") }
        try acknowledge(old, on: direct)
        direct.embeddedEventLoop.advanceTime(by: .milliseconds(1999))
        guard direct.isActive else { throw fixtureFailure("liveness-early-path-close") }
        if recovered { try acknowledge(probe, on: direct) }
        direct.embeddedEventLoop.advanceTime(by: .milliseconds(1))
        guard direct.isActive == recovered else { throw fixtureFailure("liveness-path-recovery") }
        _ = try? direct.finish()
    }
    let ordinary = EmbeddedChannel(handler: NativeLivenessHandler())
    try ordinary.connect(to: SocketAddress(ipAddress: "127.0.0.1", port: 9)).wait()
    _ = try pings(ordinary)
    ordinary.pipeline.fireUserInboundEventTriggered(pathLoss)
    ordinary.embeddedEventLoop.advanceTime(by: .seconds(2))
    guard ordinary.isActive, try pings(ordinary).isEmpty else { throw fixtureFailure("liveness-ordinary-path-event") }
    _ = try? ordinary.finish()
    return ["silentClosedAtMs": 20_000, "answeredStaysOpen": true, "routeProbe": true]
}

/** Against a loopback Host: dial timing, a late direct path, relay delay, upgrade with the window rechecked, and PINGs. */
@MainActor func runNativeReconnect(_ input: [String: Any]) async throws -> [String: Any] {
    let paired = try await reconnectDevice(input)
    defer { try? FileManager.default.removeItem(at: paired.directory) }
    var timings: [String: Double] = [:], result: [String: Any] = [:]
    func median(_ values: [Double]) -> Double { values.sorted()[values.count / 2] }
    var verifications = 0
    do {
        let workspace = try paired.workspace(prefetch: false)
        let paths = NativePathOwner()
        var relay: [Double] = [], direct: [Double] = []
        for _ in 0..<3 {
            let start = ContinuousClock.now
            _ = try await paths.migrate([NativePathCandidate(id: "relay", kind: .relay) { try await paired.open() }], workspace: workspace)
            relay.append(elapsedMs(since: start))
            let next = ContinuousClock.now
            _ = try await paths.migrate([NativePathCandidate(id: "direct", kind: .direct) { try await paired.open() }], workspace: workspace)
            direct.append(elapsedMs(since: next))
        }
        timings["relayRoundMs"] = median(relay); timings["directRoundMs"] = median(direct)
        await workspace.closeOpening()
    }
    for prefetch in [false, true] {
        var cold: [Double] = []
        for _ in 0..<3 {
            let workspace = try paired.workspace(prefetch: prefetch)
            let start = ContinuousClock.now
            _ = try await NativePathOwner().migrate([NativePathCandidate(id: "direct", kind: .direct) { try await paired.open() }], workspace: workspace)
            _ = try await workspace.verify()
            verifications += 1
            cold.append(elapsedMs(since: start))
            await workspace.closeOpening()
        }
        timings[prefetch ? "coldOpenMs" : "coldOpenNoPrefetchMs"] = median(cold)
    }
    // A direct path that browsing finds after the relay began still wins, and the timeline names only phases and kinds.
    do {
        let timeline = NativeConnectionTimeline(), paths = NativePathOwner(timeline: timeline), box = ReconnectBox()
        let workspace = try paired.workspace(prefetch: false)
        timeline.begin()
        let started = ContinuousClock.now
        let relay = try NativePathCandidate(id: "relay", kind: .relay) {
            await box.started(elapsedMs(since: started))
            try await Task.sleep(for: .milliseconds(400)); return try await paired.open()
        }
        let late = try NativePathCandidate(id: "lan-late", kind: .direct) { try await paired.open() }
        let later = NativeLateDirects {
            try? await Task.sleep(for: .milliseconds(150))
            return [late]
        }
        _ = try await paths.migrate([relay], later: later, relayDelay: NativeReconnectPolicy.relayDelay(directKnown: false, lastWinner: nil), workspace: workspace)
        let kind = await workspace.installedPathKind()
        timings["lateDirectRoundMs"] = elapsedMs(since: started)
        let entries = timeline.entries()
        let relayStarted = await box.starts.first ?? 1000
        result["lateDirectWins"] = kind == .direct && relayStarted < 100
        result["timeline"] = entries.map { entry -> [String: Any] in
            var row: [String: Any] = ["round": entry.round, "phase": entry.phase.rawValue, "ordinal": entry.ordinal, "ms": entry.ms]
            if let path = entry.path { row["path"] = path.rawValue }
            return row
        }
        result["phases"] = entries.map { $0.phase.rawValue + ($0.path.map { ":" + $0.rawValue } ?? "") }
        // A deadline with no browse result is no failure: the same direct ID dials again at once.
        let empty = NativeLateDirects { try? await Task.sleep(for: .milliseconds(50)); return [] }
        var emptyFailed = false
        do { _ = try await paths.migrate([], later: empty, workspace: workspace) } catch { emptyFailed = true }
        let retried = try await paths.migrate([late], workspace: workspace)
        result["emptyBrowseLeavesNoMemory"] = emptyFailed && retried["device"]["id"].string == paired.device.deviceId
        await workspace.closeOpening()
    }
    // Without a usable direct candidate the relay starts at once; behind one it waits 250 ms, behind a direct winner 600 ms.
    do {
        let workspace = try paired.workspace(prefetch: false), paths = NativePathOwner()
        func relayStart(_ candidates: [NativePathCandidate], delay: Duration?) async throws -> Double {
            let box = ReconnectBox(), started = ContinuousClock.now
            let relay = try NativePathCandidate(id: "relay-" + String(UUID().uuidString.prefix(8)), kind: .relay) {
                await box.started(elapsedMs(since: started)); return try await paired.open()
            }
            _ = try await paths.migrate(candidates + [relay], relayDelay: delay, workspace: workspace)
            return await box.starts.first ?? -1
        }
        let faultPort = try fixturePort(["port": input["faultPort"] ?? 0])
        let failing = try NativePathCandidate(id: "lan-gone", kind: .direct) { try await paired.open(port: faultPort) }
        let alone = try await relayStart([], delay: nil)
        let behindDirect = try await relayStart([failing], delay: nil)
        let behindWinner = try await relayStart([], delay: NativeReconnectPolicy.relayDelay(directKnown: false, lastWinner: .direct))
        timings["relayStartAloneMs"] = alone; timings["relayStartBehindDirectMs"] = behindDirect; timings["relayStartBehindWinnerMs"] = behindWinner
        result["relayStartsAtOnce"] = alone >= 0 && alone < 100 && behindDirect >= 250 && behindWinner >= 600
        await workspace.closeOpening()
    }
    do {
        let workspace = try paired.workspace(prefetch: false), paths = NativePathOwner()
        let direct = ReconnectBox(), relay = ReconnectBox(), ready = ReconnectBox()
        let failedDirect = try NativePathCandidate(id: "cooled-direct", kind: .direct) {
            await direct.started(1); throw NativeFailure.unavailable
        }
        let failedRelay = try NativePathCandidate(id: "cooled-relay", kind: .relay) {
            await relay.started(1); throw NativeFailure.unavailable
        }
        let retryRelay = try NativePathCandidate(id: failedRelay.id, kind: .relay) {
            await relay.started(2); return try await paired.open()
        }
        let readyRelay = try NativePathCandidate(id: "ready-relay", kind: .relay) {
            let connection = try await paired.open(); await ready.keep(connection); return connection
        }
        let failed = try? await paths.migrate([failedDirect, failedRelay], relayDelay: .zero, workspace: workspace)
        let ordinary = try? await paths.migrate([failedDirect, retryRelay], workspace: workspace)
        let skippedOnOrdinaryDial = await relay.starts == [1] && ordinary == nil && failed == nil
        _ = try await paths.migrate([failedDirect, retryRelay, readyRelay], recovering: true, workspace: workspace)
        guard let readyConnection = await ready.connection else { throw fixtureFailure("relay-cooldown-ready") }
        let preferredReady = await relay.starts == [1]
        await readyConnection.close()
        _ = try await paths.migrate([failedDirect, retryRelay], recovering: true, workspace: workspace)
        let retriedOnlyRelay = await relay.starts == [1, 2]
        result["relayCooldown"] = ["ordinaryDialSkipsCooling": skippedOnOrdinaryDial, "readyRelayPreferred": preferredReady,
                                   "onlyRelayRetried": retriedOnlyRelay, "directStillCools": await direct.starts == [1]]
        await workspace.closeOpening()
    }
    // Test the real workspace liveness settings with a proxy that drops traffic without sending FIN or changing the path.
    if let proxy = input["silentPort"] {
        let silentPort = try fixturePort(["port": proxy])
        let installs = ReconnectInstalls(), paths = NativePathOwner(), connected = ReconnectBox()
        let workspace = try paired.workspace(prefetch: false, installed: installs.record)
        let direct = try NativePathCandidate(id: "blackhole-direct", kind: .direct) {
            let connection = try await paired.open(port: silentPort)
            await connected.keep(connection); return connection
        }
        _ = try await paths.migrate([direct], workspace: workspace)
        guard let lost = installs.epoch, let primary = await connected.connection else { throw fixtureFailure("liveness-install") }
        let stoppedWatcher = Task { await workspace.transportEnded(on: lost) }
        try await Task.sleep(for: .milliseconds(4250))
        stoppedWatcher.cancel()
        guard !(await stoppedWatcher.value) else { throw fixtureFailure("liveness-watch-cancelled") }
        let liveOpen = !(await primary.isClosed())
        let start = ContinuousClock.now
        FileManager.default.createFile(atPath: input["silentMarker"] as? String ?? "", contents: Data())
        let watchdog = Task {
            do { try await Task.sleep(for: .seconds(8)) } catch { return }
            await primary.close()
        }
        let observed = await workspace.transportEnded(on: lost)
        watchdog.cancel()
        let deadAt = elapsedMs(since: start)
        let backup = try NativePathCandidate(id: "blackhole-backup", kind: .relay) { try await paired.open() }
        _ = try await paths.migrate([backup], relayDelay: .zero, workspace: workspace)
        let kind = await workspace.installedPathKind(), staleLoss = await workspace.transportEnded(on: lost)
        timings["silentProxyDeadMs"] = deadAt
        timings["silentProxyFallbackMs"] = elapsedMs(since: start)
        result["liveness"] = ["answeredStaysOpen": liveOpen, "silentClosed": observed && deadAt >= 3000 && deadAt < 7000,
            "backupInstalled": kind == .relay, "staleLossIgnored": !staleLoss] as [String: Any]
        await workspace.closeOpening()
    }
    // Relay to direct in the background: the old path stays until the new one qualified, the Host rechecks the window, and
    // an unknown write keeps its requestId without being sent again.
    do {
        let installs = ReconnectInstalls()
        let workspace = try paired.workspace(prefetch: true, installed: installs.record)
        let paths = NativePathOwner(), relayBox = ReconnectBox()
        _ = try await paths.migrate([NativePathCandidate(id: "relay", kind: .relay) {
            let connection = try await paired.open(); await relayBox.keep(connection); return connection
        }], workspace: workspace)
        let lease = try await workspace.verify()
        verifications += 1
        let until = lease.verifiedUntil
        let unknown = try NativePendingWrite(method: .patch, path: "/link/api/devices/current", fields: ["name": .string("Swift reconnect renamed")])
        var unknownWrite = false
        do { _ = try await workspace.submit(unknown) } catch { unknownWrite = (error as? NativeFailure) == .resultUnknown }
        guard unknownWrite, try await workspace.pendingWrites().map(\.requestId) == [unknown.requestId] else { throw fixtureFailure("unknown-write") }
        let cancelledDirect = ReconnectBox()
        let cancellable = try NativePathCandidate(id: "lan-cancel-upgrade", kind: .direct) {
            let connection = try await paired.open()
            await cancelledDirect.keep(connection)
            do { try await Task.sleep(for: .seconds(1)); return connection }
            catch { await connection.close(); throw error }
        }
        let interrupted = Task { await paths.upgrade([cancellable], workspace: workspace) }
        for _ in 0..<50 {
            if await cancelledDirect.connection != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        interrupted.cancel()
        let lateUpgrade = await interrupted.value, keptRelay = await workspace.installedPathKind() == .relay
        guard let losingDirect = await cancelledDirect.connection, await losingDirect.isClosed(), !lateUpgrade, keptRelay else {
            throw fixtureFailure("cancelled-upgrade")
        }
        // A read on the relay keeps it: the upgrade waits for a quiet path rather than cutting the answer off.
        let held = Task { try await workspace.read("/link/api/custom-agents/general", body: true) }
        try await Task.sleep(for: .milliseconds(150))
        let duringRead = await paths.upgrade([try NativePathCandidate(id: "lan-busy", kind: .direct) { try await paired.open() }], workspace: workspace)
        let heldRead = (try? await held.value) != nil
        let relayOnly = await paths.upgrade([try NativePathCandidate(id: "relay-not-direct", kind: .relay) { try await paired.open() }], workspace: workspace)
        guard let replaced = installs.epoch else { throw fixtureFailure("upgrade-incumbent-epoch") }
        let replacedWatcher = Task { await workspace.transportEnded(on: replaced) }
        let oldOpenWhileDialing = ReconnectBox()
        let upgraded = await paths.upgrade([try NativePathCandidate(id: "lan-upgrade", kind: .direct) {
            if let old = await relayBox.connection, !(await old.isClosed()) { await oldOpenWhileDialing.started(1) }
            return try await paired.open()
        }], workspace: workspace)
        if !upgraded { replacedWatcher.cancel() }
        guard !(await replacedWatcher.value) else { throw fixtureFailure("upgrade-reports-stale-loss") }
        let kind = await workspace.installedPathKind()
        let current = await workspace.lease()
        var oldClosed = false
        if let old = await relayBox.connection {
            for _ in 0..<50 { if await old.isClosed() { oldClosed = true; break }; try await Task.sleep(for: .milliseconds(20)) }
        }
        let pending = try await workspace.pendingWrites()
        let dialedWhileOldOpen = await oldOpenWhileDialing.starts.count == 1
        let again = await paths.upgrade([try NativePathCandidate(id: "lan-again", kind: .direct) { try await paired.open() }], workspace: workspace)
        result["upgrade"] = [
            "relayOnlyRefused": !relayOnly,
            "readNotInterrupted": !duringRead && heldRead,
            "installedDirect": upgraded && kind == .direct,
            "builtBeforeTeardown": dialedWhileOldOpen && oldClosed,
            "sameWindow": current.map { $0.sameWindow(as: lease) && $0.verifiedUntil == until } ?? false,
            "unknownKept": pending.map(\.requestId) == [unknown.requestId],
            "directNotUpgradedAgain": !again,
            "installs": installs.count,
        ] as [String: Any]
        // Back from a short background: the Host rechecks the kept window on the same connection and never extends it.
        let kept = try await workspace.recheckWindow()
        let after = await workspace.lease()
        result["holdRecheck"] = kept && after.map { $0.sameWindow(as: lease) && $0.verifiedUntil == until } == true
        // Revoked meanwhile: a fresh opening sends revocation and snapshot together and decides revocation first.
        _ = try? await workspace.submit(NativePendingWrite(method: .delete, path: "/link/api/devices/current", fields: [:]))
        await workspace.closeOpening()
        let freshInstalls = ReconnectInstalls()
        let fresh = try paired.workspace(prefetch: true) { _ in freshInstalls.count += 1 }
        var revoked = false
        do { _ = try await NativePathOwner().migrate([NativePathCandidate(id: "lan-after-revoke", kind: .direct) { try await paired.open() }], workspace: fresh) }
        catch { revoked = (error as? NativeFailure) == .revoked }
        let proof = await fresh.verifiedRevocation(), freshKind = await fresh.installedPathKind()
        result["revocationFirst"] = revoked && freshInstalls.count == 0 && proof != nil && freshKind == nil
        await fresh.closeOpening()
    }
    result["timings"] = timings
    result["verifications"] = verifications
    return result
}
