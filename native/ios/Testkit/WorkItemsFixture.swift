import Foundation
import LatchNativeCore

func phoneWorkItemsFixture(_ data: Data) throws -> [String: Any] {
    let input = try NativeJSON.decode(data), snapshot = input["snapshot"]
    if input["listRows"].bool {
        func rows(_ value: NativeJSON, privateAllowed: Bool) -> [String: Any] {
            let items = PhoneWorkItems.visible(value, privateAllowed: privateAllowed)
            let list = PhoneWorkList(items: items, snapshot: value)
            return Dictionary(uniqueKeysWithValues: items.map { item in
                let row = list.presentation(for: item)
                return (item.id, ["project": row.project ?? "", "updatedAt": row.updatedAt.timeIntervalSince1970,
                                  "sessions": row.sessionCount, "priority": row.priority ?? "", "note": row.note ?? "",
                                  "tags": row.tags, "reason": row.reason?.rawValue ?? ""] as [String: Any])
            })
        }
        return ["open": rows(snapshot, privateAllowed: true), "closed": rows(PhoneWorkItems.withoutBody(snapshot), privateAllowed: false)]
    }
    if input["creationFields"].bool {
        let requestId = UUID().uuidString
        let plain = try PhoneWorkChange.creation(title: "  保存  ", prompt: "", project: nil).request(requestId: requestId)
        let project = try PhoneWorkChange.creation(title: "保存", prompt: "  要求  ", project: "two").request(requestId: requestId)
        let plainBody = try NativeJSON.decode(plain.body), projectBody = try NativeJSON.decode(project.body)
        let reply = NativeJSON.object(["requestId": .string(requestId), "item": input["item"]])
        guard let change = PhoneWorkChange(project) else { throw NativeFailure.invalidRecord }
        return ["capabilities": input["capabilities"].array.map(PhoneWorkItems.supportsCreation),
                "keys": plainBody.object.keys.sorted(), "project": projectBody["projectId"].string ?? "",
                "prompt": projectBody["prompt"].string ?? "", "title": plainBody["title"].string ?? "",
                "valid": change.confirmed(by: reply, requestId: requestId),
                "mismatch": change.confirmed(by: reply, requestId: UUID().uuidString),
                "malformed": change.confirmed(by: .object(["requestId": .string(requestId)]), requestId: requestId),
                "longTitleRejected": (try? PhoneWorkChange.creation(title: String(repeating: "a", count: 121), prompt: "", project: nil).request()) == nil]
    }
    if case let .array(filters) = input["listFilters"] {
        let results = filters.map { filter -> [String: Any] in
            let value = filter["offline"].bool ? PhoneWorkItems.withoutBody(snapshot) : snapshot
            let list = PhoneWorkList(items: PhoneWorkItems.visible(value, privateAllowed: filter["privateAllowed"].bool), snapshot: value)
            let selected = Set(filter["projects"].array.map { PhoneWorkList.Project($0.string) }).intersection(list.projects)
            let rows = list.matching(title: filter["query"].string ?? "", projects: selected)
            return ["choices": list.projects.map(list.name), "titles": rows.map(\.title), "groups": rows.map { $0.group?.rawValue ?? "unknown" }]
        }
        return ["results": results]
    }
    let post = input["post"], detail = input["detail"]
    guard let source = PhoneWorkPost(post)?.source, let message = PhoneWorkPost(post)?.reply?.id,
          let session = detail["summary"]["id"].string, let itemId = snapshot["items"].array.first?["id"].string,
          let olderId = input["olderMessage"].string, let expectedSha = input["sha"].string else { throw NativeFailure.invalidRecord }
    func editing(_ value: NativeJSON, _ apply: (inout [String: NativeJSON]) -> Void) -> NativeJSON {
        var copy = value.object; apply(&copy); return .object(copy)
    }
    func rejects(_ check: () throws -> Void) -> Bool {
        do { try check(); return false } catch { return true }
    }

    var window = PhonePrivateSnapshot()
    let old = window.epoch
    let open = window.adopt(snapshot, captured: old, windowOpen: true) ?? .null
    window.clear()
    let expired = PhoneAgents.withoutPrivate(open)
    let cannotRestore = window.adopt(open, captured: old, windowOpen: true) == nil
    let denied = PhoneWorkItems.visible(snapshot, privateAllowed: false)
    let oldHost = editing(snapshot) { $0["catalog"] = .object(["features": .object(["workItems": .bool(true)])]) }
    let privateResponse = NativeJSON.object(["item": input["privateDetail"]])
    let privateRejected = rejects {
        _ = try PhoneWorkItemDetail(privateResponse, itemId: input["privateDetail"]["id"].string ?? "", privateAllowed: false)
    }
    let malformedItem = editing(snapshot["items"].array[0]) { $0["board"] = .object(["group": .string("attention"), "postId": .string("../other")]) }

    let host = UUID(), network = UUID(), connection = UUID(), selection = UUID()
    func readStamp(connected: Bool, connection: UUID, window: UUID?) -> PhoneWorkReadStamp? {
        PhoneWorkReadStamp(connected: connected, host: host, connection: connection, network: network, window: window,
            selection: selection, instance: "fixture-work-instance")
    }
    let beforeDisconnect = readStamp(connected: true, connection: connection, window: old)
    let afterReconnect = readStamp(connected: true, connection: UUID(), window: old)
    let noReadOffline = readStamp(connected: false, connection: connection, window: old) == nil
    let noReadExpired = readStamp(connected: true, connection: connection, window: nil) == nil

    guard let sent = PhoneWorkPost(post) else { throw NativeFailure.invalidRecord }
    let completeWithoutSource = editing(snapshot) { $0["tasks"] = .array([]); $0["tasksComplete"] = .bool(true) }
    let partialWithoutSource = editing(completeWithoutSource) { $0.removeValue(forKey: "tasksComplete") }
    let withdrawn = sent.projectingSource(completeWithoutSource)
    let removedSource = PhoneWorkItems.sourceVisibility(completeWithoutSource, sessionId: session)
    let omittedSource = PhoneWorkItems.sourceVisibility(partialWithoutSource, sessionId: session)
    let startsReadable = sent.projectingSource(snapshot).reply != nil
    let preservedPost = withdrawn.text == sent.text
    let noReplyOnRecovery = withdrawn.projectingSource(snapshot).reply == nil

    let turn = source.locate(in: PhoneConversation.turns(PhoneConversation.rendered(detail)))
    let current = source.currentDecision(detail: detail, summary: detail["summary"])
    let next = editing(detail["summary"]) { $0["runId"] = .string("later-run") }
    let replied = editing(detail) { $0["questions"] = .array([detail["questions"].array[0]]) }
    let legacy = editing(post) { $0.removeValue(forKey: "turn") }
    let legacySource = PhoneWorkPost(legacy)?.source
    let legacyId = legacySource?.locate(in: PhoneConversation.turns(PhoneConversation.rendered(detail)))?.id
    let wrongMessage = editing(post["turn"]) { $0["userMessageId"] = .string(olderId) }
    let wrongPost = editing(post) { $0["turn"] = wrongMessage }
    let oldApproval = input["approvalPost"]
    let approval = PhoneWorkPost(oldApproval)?.source?.currentDecision(detail: input["approvalDetail"], summary: detail["summary"])
    let postPage = try PhoneWorkPostPage(input["page"])
    let olderValue = editing(post) { $0["id"] = input["olderPostId"] }
    guard let olderPost = PhoneWorkPost(olderValue) else { throw NativeFailure.invalidRecord }
    let alreadyRead = [olderPost.projectingSource(partialWithoutSource), sent]
    let stillOmitted = postPage.keepingEarlierPosts(alreadyRead, before: nil, revision: postPage.revision, snapshot: partialWithoutSource)
    let backInListing = postPage.keepingEarlierPosts(alreadyRead, before: nil, revision: postPage.revision, snapshot: snapshot)
    let badPage = rejects { _ = try PhoneWorkPostPage(editing(input["page"]) { $0["posts"] = .array(Array(repeating: post, count: 33)) }) }
    let reply = try PhoneWorkReplyPage(input["reply"], messageId: message, source: source, offset: 0)
    let replyMismatch = rejects {
        _ = try PhoneWorkReplyPage(editing(input["reply"]) { $0["messageId"] = .string("new-reply") },
            messageId: message, source: source, offset: 0)
    }
    let replyWrongTurn = rejects {
        _ = try PhoneWorkReplyPage(editing(input["reply"]) { $0["turn"] = wrongMessage },
            messageId: message, source: source, offset: 0)
    }
    let replyWrongOffset = rejects {
        _ = try PhoneWorkReplyPage(editing(input["reply"]) { $0["nextOffset"] = .number(23) },
            messageId: message, source: source, offset: 0)
    }

    let request = try PhoneWorkRead.reply(itemId, post: post["id"].string ?? "", message: "回复&offset=2", offset: 16_000).request()
    let refusedRoute = rejects { _ = try PhoneWorkRead.item("../other").request() }
    let refusedSha = rejects { _ = try PhoneWorkRead.commit(session, sha: "HEAD", file: nil).request() }
    let delivery = try PhoneWorkRead.delivery([session]).request()
    let deliveryBody = try NativeJSON.decode(delivery.body ?? Data())

    let evidence = try PhoneWorkEvidence.read(input["evidence"], sessions: [session]).first
    let equalEvidence = try PhoneWorkEvidence.read(input["equalEvidence"], sessions: [session]).first
    let unboundEvidence = try PhoneWorkEvidence.read(input["unboundEvidence"], sessions: [session]).first
    let missingSHAEvidence = try PhoneWorkEvidence.read(input["missingSHAEvidence"], sessions: [session]).first
    let discussion = PhoneWorkPRDiscussion(input["discussion"])
    let job = input["job"].string ?? ""
    let exactCheck = equalEvidence?.pr?.failedCheck(job: job, sha: expectedSha)?.name
    let otherCheck = evidence?.pr?.failedCheck(job: job, sha: expectedSha)
    let commit = try PhoneWorkCommit(input["commit"], sha: expectedSha)
    let wrongCommit = rejects { _ = try PhoneWorkCommit(input["commit"], sha: String(repeating: "b", count: 40)) }

    return [
        "window": [
            "oldHostDisabled": !PhoneWorkItems.supported(oldHost),
            "publicCount": denied.count,
            "openCount": PhoneWorkItems.visible(open, privateAllowed: true).count,
            "closedCount": PhoneWorkItems.visible(expired, privateAllowed: true).count,
            "referenceWithdrawn": expired["tasks"].array[0]["itemId"] == .null,
            "postWithdrawn": expired["items"].array[0]["board"]["postId"] == .null,
            "noteWithdrawn": expired["items"].array[0]["note"] == .null,
            "proposalWithdrawn": expired["workProposals"] == .null,
            "oldSnapshotRejected": cannotRestore,
            "privateReadDenied": privateRejected,
            "invalidRouteRejected": PhoneWorkItemSummary(malformedItem) == nil,
            "files": PhoneWorkItems.canReadFiles(snapshot),
            "offlineWithdrawn": noReadOffline,
            "expiredWithdrawn": noReadExpired,
            "sameNetworkNewConnection": beforeDisconnect != nil && afterReconnect != nil && beforeDisconnect != afterReconnect && beforeDisconnect?.network == afterReconnect?.network,
        ],
        "source": [
            "startsReadable": startsReadable,
            "completeMissing": removedSource.rawValue,
            "partialMissing": omittedSource.rawValue,
            "withdrawn": withdrawn.reply == nil && withdrawn.source == nil && withdrawn.turn == nil && withdrawn.attention == nil,
            "humanPostPreserved": preservedPost,
            "stillWithdrawnAfterSourceReturns": noReplyOnRecovery,
            "keepsEarlierWhileOmitted": stillOmitted.posts.count == 2 && stillOmitted.posts.first?.reply == nil && stillOmitted.before == nil,
            "olderCursorRestored": backInListing.posts.count == 1 && backInListing.before == postPage.posts.first?.id,
            "turn": turn?.id ?? "",
            "decision": current?["id"].string ?? "",
            "approval": approval?["id"].string ?? "",
            "legacyTurn": legacyId ?? "",
            "legacyCannotAnswer": legacySource?.currentDecision(detail: detail, summary: detail["summary"]) == nil,
            "oldRunRejected": source.currentDecision(detail: detail, summary: next) == nil,
            "answeredRejected": source.currentDecision(detail: replied, summary: detail["summary"]) == nil,
            "wrongMessageRejected": PhoneWorkPost(wrongPost)?.source?.currentDecision(detail: detail, summary: detail["summary"]) == nil,
            "pageBefore": postPage.before ?? "",
            "pageLimit": badPage,
            "offset": reply.nextOffset ?? -1,
            "replyMismatch": replyMismatch,
            "replyWrongTurn": replyWrongTurn,
            "replyWrongOffset": replyWrongOffset,
            "replyQuery": request.path,
            "routeRejected": refusedRoute,
            "shaRejected": refusedSha,
        ],
        "evidence": [
            "deliveryRead": delivery.method.rawValue,
            "deliveryIds": deliveryBody["ids"].array.compactMap(\.string),
            "different": evidence?.version == .different,
            "same": equalEvidence?.version == .same,
            "unbound": unboundEvidence?.pr == nil && unboundEvidence?.head == expectedSha && unboundEvidence?.version == .unconfirmed,
            "missingSHA": missingSHAEvidence?.pr != nil && missingSHAEvidence?.version == .unconfirmed,
            "commentsPreserved": discussion.comments.compactMap { $0["body"].string?.count },
            "commentLimitApplied": discussion.capped,
            "matchedCheck": exactCheck ?? "",
            "wrongCheckRejected": otherCheck == nil,
            "commitFiles": commit.files.count,
            "wrongCommitRejected": wrongCommit,
        ],
        "reviewWidths": [
            PhoneReview.fileColumnWidth(detail: 514, accessibility: false) == nil,
            PhoneReview.fileColumnWidth(detail: 742, accessibility: false) == nil,
            (PhoneReview.fileColumnWidth(detail: 880, accessibility: false) ?? 880) <= 360,
            PhoneReview.fileColumnWidth(detail: 1050, accessibility: true) == nil,
        ],
    ]
}

/** A live path change on one native opening, with the same Host and verification window. */
@MainActor final class WorkTransportFixture {
    private(set) var latest: NativeInstalledTransport?
    private var installs = 0
    private var priorInvalidWhenInstalled = false

    func record(_ path: NativeInstalledTransport) {
        if let latest { priorInvalidWhenInstalled = !latest.epoch.valid }
        latest = path; installs += 1
    }

    private func wait(_ condition: () async -> Bool) async throws {
        for _ in 0..<200 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw NativeFailure.unavailable
    }

    private func sawChangedAccess(_ workspace: NativeWorkspace, _ reading: NativeBodyReading) async -> Bool {
        do { try await workspace.checkBodyReading(reading); return false }
        catch { return (error as? NativeReadFailure) == .bodyAccessChanged }
    }

    /** Hold the first refresh on the wire while the automatic read finds a session at the same Host revision. */
    func exerciseInitialList(_ workspace: NativeWorkspace, markers: URL) async throws -> [String: Any] {
        guard var list = latest?.snapshot, list["tasks"].array.isEmpty, !list["tasksComplete"].bool else { throw NativeFailure.invalidRecord }
        let older = Task { try await workspace.snapshot() }
        defer { older.cancel() }
        try await wait { FileManager.default.fileExists(atPath: markers.appendingPathComponent("candidate-read").path) }
        try await NativeReconnectPolicy.recoverIncompleteList(current: { list }) { list = try await workspace.snapshot() }
        try Data().write(to: markers.appendingPathComponent("release-candidate"))
        let late = try await older.value
        let cached = try await workspace.cachedSnapshot()
        func hasSession(_ value: NativeJSON?) -> Bool { value?["tasks"].array.first?["id"].string == "available-session" }
        let result = ["recovered": hasSession(list), "lateReadKeptSession": hasSession(late),
            "cacheKeptSession": hasSession(cached), "windowClosed": await workspace.lease() == nil]
        await workspace.closeOpening()
        return result
    }

    func exercise(_ workspace: NativeWorkspace, keys: FixtureKeys, lease: BodyLease, itemId: String,
        reopen: @escaping @Sendable () async throws -> NativeHTTPConnection) async throws -> [String: Any] {
        guard let old = latest, installs == 1 else { throw NativeFailure.invalidRecord }
        let initial = try await workspace.readWork(.item(itemId), on: old.epoch)
        let installedBefore = old.epoch.whileCurrent { initial["item"]["id"].string == itemId } == true
        let signCount = await keys.verificationCalls.value

        let paths = NativePathOwner()
        let candidate = try NativePathCandidate(id: "replacement", kind: .direct, connect: reopen)
        let checkpoint = try await paths.migrate([candidate], workspace: workspace)
        guard let new = latest, installs == 2, new.epoch !== old.epoch else { throw NativeFailure.invalidRecord }
        let stalePublicationRefused = old.epoch.whileCurrent { true } == nil
        var staleContinuationRefused = false
        do { _ = try await workspace.readWork(.posts(itemId, before: nil), on: old.epoch) }
        catch { staleContinuationRefused = error is CancellationError }

        let item = try await workspace.readWork(.item(itemId), on: new.epoch)
        let posts = try await workspace.readWork(.posts(itemId, before: nil), on: new.epoch)
        let currentPublication = new.epoch.whileCurrent {
            item["item"]["id"].string == itemId && posts["revision"].integer != nil
        } == true
        let keptWindow = new.lease?.sameWindow(as: lease) == true && lease.valid
        let didNotSign = await keys.verificationCalls.value == signCount
        let coherentCheckpoint = new.snapshot == checkpoint && old.snapshot["instanceId"] == checkpoint["instanceId"]
        await paths.close()
        await workspace.closeOpening()
        return ["originalRead": installedBefore, "sameInstanceCheckpoint": coherentCheckpoint,
            "restoredWindow": keptWindow, "withoutNewSignature": didNotSign, "oldEpochWithdrawnDuringInstall": priorInvalidWhenInstalled,
            "oldPublicationRejected": stalePublicationRefused, "oldCompositionRejected": staleContinuationRefused,
            "currentCompositionAccepted": currentPublication, "closeWithdrawn": !new.epoch.valid]
    }

    /** The responses deliberately race disk writes; a new vault then opens the cache without a transport. */
    func exerciseCache(_ workspace: NativeWorkspace, vault: EncryptedVault, keys: FixtureKeys, directory: URL,
        vaultKey: Data, itemId: String, markers: URL, reopen: @escaping @Sendable () async throws -> NativeHTTPConnection) async throws -> [String: Any] {
        guard let old = latest, let base = old.snapshot["revision"].integer,
              try await workspace.cachedSnapshot()?["items"].array.contains(where: { $0["id"].string == itemId }) == true else {
            throw NativeFailure.invalidRecord
        }
        let paths = NativePathOwner()
        let candidate = try NativePathCandidate(id: "cache-candidate", kind: .direct, connect: reopen)
        let migration = Task { try await paths.migrate([candidate], workspace: workspace) }
        defer { migration.cancel() }
        try await wait { FileManager.default.fileExists(atPath: markers.appendingPathComponent("candidate-read").path) }

        let firstReader = try await workspace.beginBody("cache-scope-before")
        let pause = FixtureVaultPause(), heldVault = Task { await vault.fixturePause(pause) }
        defer { pause.release.signal() }
        try await wait { pause.hasEntered() }
        let earlier = Task { try await workspace.snapshot() }
        defer { earlier.cancel() }
        try await wait { await sawChangedAccess(workspace, firstReader) }

        let secondReader = try await workspace.beginBody("cache-scope-after")
        let newer = Task { try await workspace.snapshot() }
        defer { newer.cancel() }
        try await wait { await sawChangedAccess(workspace, secondReader) }

        try Data().write(to: markers.appendingPathComponent("release-candidate"))
        try await wait { !old.epoch.valid }
        pause.release.signal()
        let timedOut = await heldVault.value
        let installed = try await migration.value
        _ = await earlier.result; _ = await newer.result
        let usedNewCheckpoint = installed["revision"].integer == base + 2
            && installed["items"].array.first?["private"] == .bool(true)
        await paths.close()
        await workspace.closeOpening()

        let device = await workspace.device
        let offlineVault = try EncryptedVault(directory: directory, key: vaultKey, binding: device.hostId)
        let offline = try NativeWorkspace(device: device, keys: keys, vault: offlineVault)
        let cached = try await offline.cachedSnapshot()
        let noPrivateRow = cached?["items"].array.contains(where: { $0["id"].string == itemId }) == false
        let floorKept = cached?["revision"].integer == base + 2
        let restarted = try await offline.install(reopen)
        let cachedAfterRestart = try await offline.cachedSnapshot()
        let realReplacementResetFloor = restarted["instanceId"].string == "fixture-restarted" && restarted["revision"].integer == 1
            && cachedAfterRestart?["instanceId"].string == "fixture-restarted" && cachedAfterRestart?["revision"].integer == 1
        await offline.closeOpening()

        return ["publicCacheExisted": true, "vaultWasHeld": !timedOut,
            "acceptedLatestDuringInstall": usedNewCheckpoint, "offlinePrivateRowWithdrawn": noPrivateRow,
            "offlineRevisionKept": floorKept, "newInstanceResetFloor": realReplacementResetFloor]
    }

    /** A new profile store waits for the old workspace's latest checkpoint and the old store lock. */
    func exerciseLockOpen(_ workspace: NativeWorkspace, vault: EncryptedVault, keys: FixtureKeys, store: NativeProfileStore,
        host: NativeRegisteredHost, directory: URL, vaultKey: Data, itemId: String) async throws -> [String: Any] {
        guard let old = latest, let base = old.snapshot["revision"].integer,
              try await workspace.cachedSnapshot()?["items"].array.contains(where: { $0["id"].string == itemId }) == true else {
            throw NativeFailure.invalidRecord
        }
        let reader = try await workspace.beginBody("cache-lock-open")
        let pause = FixtureVaultPause(), heldVault = Task { await vault.fixturePause(pause) }
        defer { pause.release.signal() }
        try await wait { pause.hasEntered() }
        let refresh = Task { try await workspace.snapshot() }
        defer { refresh.cancel() }
        try await wait { await sawChangedAccess(workspace, reader) }

        let storage = NativeStorageOpening()
        var cacheSafe = false, storeLocked = false, closeRuns = 0
        storage.close {
            closeRuns += 1
            cacheSafe = await workspace.closeOpening()
        }

        var waiting = 0, opened = 0, cancelledOpened = false, protectedOpened = false
        var protectedDataAvailable = true, oldStoreClosedWhenOpened = false
        var offlineRead: Result<NativeJSON?, Error>?
        let cancelled = Task {
            waiting += 1
            await storage.open(when: { true }) { cancelledOpened = true }
        }
        let superseded = Task {
            waiting += 1
            await storage.open(when: { protectedDataAvailable }) { protectedOpened = true }
        }
        try await wait { waiting == 2 && !old.epoch.valid }
        cancelled.cancel()
        protectedDataAvailable = false
        let active = Task {
            waiting += 1
            await storage.open(when: { true }) {
                opened += 1
                oldStoreClosedWhenOpened = storeLocked
                do {
                    let nextStore = try await NativeProfileStore.open(directory: directory, key: vaultKey, eraseKeys: { _ in })
                    do {
                        guard let saved = await nextStore.list().first(where: { $0.id == host.id }) else { throw NativeFailure.storageUnavailable }
                        let nextVault = try await nextStore.hostVault(saved)
                        let offline = try NativeWorkspace(device: saved.device, keys: keys, vault: nextVault)
                        offlineRead = .success(try await offline.cachedSnapshot())
                        await offline.closeOpening()
                    } catch { offlineRead = .failure(error) }
                    await nextStore.lock()
                } catch { offlineRead = .failure(error) }
            }
        }
        try await wait { waiting == 3 }
        storage.close {
            closeRuns += 1
            await store.lock()
            storeLocked = true
        }
        storage.close()
        let waitedWhilePaused = !storeLocked && opened == 0 && !cancelledOpened && !protectedOpened
        pause.release.signal()
        let timedOut = await heldVault.value
        await cancelled.value; await superseded.value; await active.value
        _ = await refresh.result
        let cached = try offlineRead?.get()
        return ["waitedWhileOldVaultHeld": waitedWhilePaused && !timedOut,
            "oldStoreLockedBeforeReopening": oldStoreClosedWhenOpened && cacheSafe && closeRuns == 2,
            "canceledAndProtectedReopensSkipped": !cancelledOpened && !protectedOpened && opened == 1,
            "offlinePrivateRowWithdrawn": cached?["items"].array.contains(where: { $0["id"].string == itemId }) == false,
            "offlineRevisionKept": cached?["revision"].integer == base + 1]
    }
}
