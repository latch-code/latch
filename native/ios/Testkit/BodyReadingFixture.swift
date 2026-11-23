import Foundation
import LatchNativeCore

@MainActor func bodyConnectionFixture(_ workspace: NativeWorkspace, keys: FixtureKeys, id: String,
    reopen: @escaping @Sendable () async throws -> NativeHTTPConnection) async throws -> [String: Any] {
    let reading = try await workspace.beginBody(id), first = try await workspace.readBody(for: reading)
    guard let applied = reading.publication.apply(first, to: { _ in true }) else { throw NativeFailure.invalidRecord }
    try await workspace.applied(applied)
    let held = try await workspace.readBody(for: reading), signatures = await keys.verificationCalls.value
    _ = try await workspace.install(reopen)
    let oldConnection = reading.publication.apply(held) { _ in true } == nil
    let lower = try await workspace.readBody(for: reading)
    let keptFloor = reading.publication.apply(lower) { _ in true } == nil
    let higher = try await workspace.readBody(for: reading)
    guard let next = reading.publication.apply(higher, to: { _ in true }) else { throw NativeFailure.invalidRecord }
    try await workspace.applied(next)
    let reusedWindow = await keys.verificationCalls.value == signatures
    await workspace.endBody(reading); await workspace.closeOpening()
    return ["oldConnectionRejected": oldConnection, "revisionFloorKept": keptFloor, "newerAccepted": true, "restoredWithoutSigning": reusedWindow]
}

@MainActor func bodyScopeFixture(_ workspace: NativeWorkspace, vault: EncryptedVault, lease: BodyLease, keys: FixtureKeys, id: String, mode: String) async throws -> [String: Any] {
    let signatures = await keys.verificationCalls.value
    let held = try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["mode": .string("chat"), "prompt": .string("Unknown retained write")])
    try await vault.storeBody(JSONEncoder().encode(held), name: "pending-" + held.requestId, lease: lease)
    try await vault.storeMetadata(JSONEncoder().encode([held.requestId]), name: "pending-index")
    let reading = try await workspace.beginBody(id), stream = try await workspace.events(for: reading)
    var iterator = stream.events.makeAsyncIterator()
    guard let event = try await iterator.next(),
          case let .update(update) = try await workspace.receive(event, from: stream, for: reading) else { throw NativeFailure.invalidRecord }
    let snapshot = try await workspace.snapshot()
    let withdrawn = reading.publication.apply(update) { _ in true } == nil
    var staleRead = false, scopeReason = false
    do { _ = try await workspace.readBody(for: reading) } catch { staleRead = true; scopeReason = (error as? NativeReadFailure) == .bodyAccessChanged }
    let pending = try await workspace.pendingWrites()
    if mode == "scope-no-view" {
        var metadataRefused = false
        do { _ = try await workspace.snapshot() } catch { metadataRefused = true }
        let noNewSignatures = await keys.verificationCalls.value == signatures
        await workspace.closeOpening()
        return ["scopeReason": scopeReason, "metadataRefused": metadataRefused, "noNewSignatures": noNewSignatures,
            "pendingUnchanged": pending.count == 1 && pending[0].requestId == held.requestId && pending[0].body == held.body]
    }
    let current = try await workspace.beginBody(id), next = try await workspace.readBody(for: current)
    let allowed = current.publication.apply(next) { _ in true } != nil
    let windowKept = lease.valid, noNewSignatures = await keys.verificationCalls.value == signatures
    await workspace.invalidateContentWindow(lease)
    var expiredWins = false
    do { _ = try await workspace.readBody(for: reading) } catch { expiredWins = (error as? NativeFailure) == .expired }
    await workspace.endBody(current); await workspace.closeOpening()
    return ["scope": snapshot["device"]["dataScope"].string ?? "", "oldOfferWithdrawn": withdrawn,
        "oldReadingRejected": staleRead, "newPublicReadingAllowed": allowed,
        "scopeReason": scopeReason, "windowKept": windowKept, "noNewSignatures": noNewSignatures, "expiredWins": expiredWins,
        "pendingUnchanged": pending.count == 1 && pending[0].requestId == held.requestId && pending[0].body == held.body]
}

@MainActor func bodyOpeningFixture(_ workspace: NativeWorkspace, id: String) async throws -> [String: Any] {
    let reading = try await workspace.beginBody(id)
    let first = Task { try await workspace.events(for: reading, incremental: true) }
    try await Task.sleep(for: .milliseconds(80))
    let second = try await workspace.events(for: reading, incremental: true)
    var rejected = false
    do { let old = try await first.value; await old.cancel() } catch { rejected = true }
    var iterator = second.events.makeAsyncIterator(), applied = false
    if let event = try await iterator.next(), case let .update(update) = try await workspace.receive(event, from: second, for: reading),
       let receipt = reading.publication.apply(update, to: { _ in true }) {
        try await workspace.applied(receipt); applied = true
    }
    await workspace.endBody(reading); await workspace.closeOpening()
    return ["lateOpeningRejected": rejected, "currentReaderApplied": applied]
}

@MainActor func bodyOrderingFixture(_ workspace: NativeWorkspace, vault: EncryptedVault, id: String, mode: String) async throws -> [String: Any] {
    let reading = try await workspace.beginBody(id), stream = try await workspace.events(for: reading, incremental: true)
    var iterator = stream.events.makeAsyncIterator()
    if mode == "host-state" {
        guard let foreign = try await iterator.next(), case .ignore = try await workspace.receive(foreign, from: stream, for: reading),
              let current = try await iterator.next(), case let .hostState(state) = try await workspace.receive(current, from: stream, for: reading),
              let body = try await iterator.next(), case let .update(update) = try await workspace.receive(body, from: stream, for: reading),
              let receipt = reading.publication.apply(update, to: { _ in true }) else { throw NativeFailure.invalidRecord }
        let before = try await vault.metadata(name: "event-cursors")
        try await workspace.applied(receipt)
        let after = try await vault.metadata(name: "event-cursors").map { try NativeJSON.decode($0) }
        let value = try NativeJSON.decode(state.data)
        await workspace.endBody(reading); await workspace.closeOpening()
        return ["foreignIgnored": true, "state": value["state"].string ?? "", "noLifecycleAck": before == nil,
            "cursor": after?.array.first?["cursor"]["sequence"].integer ?? 0]
    }
    if mode == "metadata" || mode == "metadata-retry" || mode == "detail-retry" {
        guard let initial = try await iterator.next(),
              case let .notice(notice) = try await workspace.receive(initial, from: stream, for: reading) else { throw NativeFailure.invalidRecord }
        let start = ContinuousClock.now
        let refresh = Task { try await PhoneUnlock.retryBodyRead(current: { !Task.isCancelled }) { try await workspace.refreshBody(for: reading, after: notice) } }
        var text = ""
        for _ in 0..<2 {
            guard let event = try await iterator.next(),
                  case let .update(update) = try await workspace.receive(event, from: stream, for: reading),
                  let receipt = reading.publication.apply(update, to: { value in text = value.detail?["liveText"].string ?? ""; return true }) else { throw NativeFailure.invalidRecord }
            try await workspace.applied(receipt)
        }
        let before = try await vault.metadata(name: "event-cursors")
        let update = try await refresh.value
        let list = NativeListPublication()
        var shown = NativeJSON.null
        if mode == "metadata" {
            let current = try await workspace.listCheckpoint()
            guard !list.hasDisplayed(on: current.transport), update.checkpoint?.value["tasks"].array.isEmpty == true,
                  update.snapshot?["revision"] == current.value["revision"],
                  list.apply(current, on: current.transport, to: { shown = $0; return true }),
                  list.hasDisplayed(on: current.transport) else { throw NativeFailure.invalidRecord }
        }
        var onlyMetadata = false
        guard let receipt = reading.publication.apply(update, to: { value in
            guard let checkpoint = value.checkpoint else { return false }
            onlyMetadata = value.detail == nil
            return list.apply(checkpoint, on: checkpoint.transport) { shown = $0; return true }
        }) else { throw NativeFailure.invalidRecord }
        try await workspace.applied(receipt)
        let cursor = try await vault.metadata(name: "event-cursors").map { try NativeJSON.decode($0) }
        let elapsed = start.duration(to: .now).components
        await workspace.endBody(reading); await workspace.closeOpening()
        return ["cursorHeld": before == nil, "metadataOnly": onlyMetadata, "text": text,
            "lateNoticeKeptSession": shown["tasks"].array.contains { $0["id"].string == id },
            "cursor": cursor?.array.first?["cursor"]["sequence"].integer ?? 0,
            "metadataMs": Double(elapsed.seconds) * 1000 + Double(elapsed.attoseconds) / 1e15]
    }
    var held: NativeBodyUpdate?, updates = 0, repaired = false
    var diagnosis: NativeBodyRepair?
    var refresh: Task<NativeBodyUpdate, Error>?
    let start = ContinuousClock.now
    for _ in 0..<9 {
        guard let event = try await iterator.next() else { throw NativeFailure.invalidRecord }
        switch try await workspace.receive(event, from: stream, for: reading) {
        case let .update(update): held = update; updates += 1
        case let .notice(notice):
            if mode == "overflow" { refresh = Task { try await workspace.refreshBody(for: reading, after: notice) } }
        case let .repair(value): repaired = true; diagnosis = value
        case .ignore, .hostState: throw NativeFailure.invalidRecord
        }
        if repaired { break }
    }
    guard repaired, let held else { throw NativeFailure.invalidRecord }
    let repairTime = start.duration(to: .now).components
    var metadataCancelled = false
    if let refresh {
        refresh.cancel()
        do { _ = try await refresh.value } catch { metadataCancelled = error is CancellationError }
    }
    let invalidated = reading.publication.apply(held) { _ in true } == nil
    let replacement = try await workspace.events(for: reading, incremental: true)
    var next = replacement.events.makeAsyncIterator()
    guard let event = try await next.next(),
          case let .update(update) = try await workspace.receive(event, from: replacement, for: reading),
          let receipt = reading.publication.apply(update, to: { _ in true }) else { throw NativeFailure.invalidRecord }
    try await workspace.applied(receipt)
    var terminalFailure = false
    if mode == "repair" {
        guard let bad = try await next.next() else { throw NativeFailure.invalidRecord }
        do { _ = try await workspace.receive(bad, from: replacement, for: reading) }
        catch { terminalFailure = true }
    }
    await workspace.endBody(reading); await workspace.closeOpening()
    var result: [String: Any] = ["updates": updates, "repaired": repaired, "oldOfferInvalidated": invalidated,
        "fallbackApplied": true, "secondFailureStops": terminalFailure]
    if let diagnosis {
        result["cause"] = diagnosis.cause.rawValue; result["pending"] = diagnosis.pending; result["covered"] = diagnosis.covered
        result["coveredPrefixCount"] = diagnosis.coveredPrefixCount; result["firstUncoveredKind"] = diagnosis.firstUncoveredKind.rawValue
    }
    if mode == "overflow" {
        result["metadataCancelled"] = metadataCancelled
        result["repairMs"] = Double(repairTime.seconds) * 1000 + Double(repairTime.attoseconds) / 1e15
    }
    return result
}

/** The Host's authenticated response is replaced with shared, public wire vectors only after route authorization. */
@MainActor func bodyShadowFixture(_ workspace: NativeWorkspace, vault: EncryptedVault, id: String) async throws -> [String: Any] {
    let reading = try await workspace.beginBody(id), http = try await workspace.readBody(for: reading)
    guard let first = reading.publication.apply(http, to: { $0.detail?["liveText"].string == "HTTP newer" }) else { throw NativeFailure.invalidRecord }
    try await workspace.applied(first)
    let stream = try await workspace.events(for: reading, incremental: true)
    var iterator = stream.events.makeAsyncIterator(), ignored = 0
    for _ in 0..<2 {
        guard let event = try await iterator.next(), case .ignore = try await workspace.receive(event, from: stream, for: reading) else { throw NativeFailure.invalidRecord }
        ignored += 1
    }
    guard let event = try await iterator.next(),
          case let .update(update) = try await workspace.receive(event, from: stream, for: reading) else { throw NativeFailure.invalidRecord }
    var text = ""
    guard let receipt = reading.publication.apply(update, to: { value in text = value.detail?["liveText"].string ?? ""; return true }) else { throw NativeFailure.invalidRecord }
    try await workspace.applied(receipt)
    var priority = true
    for _ in 0..<12 {
        let sameRevisionHTTP = try await workspace.readBody(for: reading)
        priority = priority && reading.publication.apply(sameRevisionHTTP) { _ in true } == nil
    }
    let data = try await vault.metadata(name: "event-cursors")
    let cursor = try data.map { try NativeJSON.decode($0) }.flatMap { $0.array.first?["cursor"]["sequence"].integer }
    let cache = try await workspace.cachedDetail(id)
    await workspace.endBody(reading)
    await workspace.closeOpening()
    return ["ignoredOlder": ignored, "text": text, "httpUnchanged": http.detail["liveText"].string == "HTTP newer",
        "streamWinsSameRevision": priority, "cursor": cursor ?? 0, "cachedText": cache?["liveText"].string ?? ""]
}

/** Real authenticated HTTP/SSE offers. No pure candidate or caller-provided revision can produce a receipt. */
@MainActor func bodyReadingFixture(_ workspace: NativeWorkspace, vault: EncryptedVault, lease: BodyLease,
    keys: FixtureKeys) async throws -> [String: Any] {
    let started = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/tasks",
        fields: ["mode": .string("chat"), "prompt": .string("Native body publication fixture")]))
    guard let id = started["sessionId"].string else { throw NativeFailure.invalidRecord }
    var idle = false
    for _ in 0..<100 {
        if try await workspace.read("/link/api/tasks/" + id, body: true)["summary"]["status"].string == "idle" { idle = true; break }
        try await Task.sleep(for: .milliseconds(20))
    }
    guard idle else { throw NativeFailure.unavailable }
    let reading = try await workspace.beginBody(id), stream = try await workspace.events(for: reading)
    var iterator = stream.events.makeAsyncIterator()
    guard let event = try await iterator.next(),
          case let .notice(notice) = try await workspace.receive(event, from: stream, for: reading) else { throw NativeFailure.invalidRecord }
    let update = try await workspace.refreshBody(for: reading, after: notice)
    let before = try await vault.metadata(name: "event-cursors")
    let rejected = reading.publication.apply(update) { _ in false } == nil
    let cursorAfterRefusal = try await vault.metadata(name: "event-cursors"), cacheAfterRefusal = try await workspace.cachedDetail(id)
    let untouched = cursorAfterRefusal == before && cacheAfterRefusal == nil
    var nestedRejected = false, assignments = 0
    guard let receipt = reading.publication.apply(update, to: { value in
        nestedRejected = reading.publication.apply(update) { _ in true } == nil
        guard value.detail?["summary"]["id"].string == id, value.snapshot?["instanceId"].string != nil else { return false }
        assignments += 1; return true
    }) else { throw NativeFailure.invalidRecord }
    let cursorBeforeReceipt = try await vault.metadata(name: "event-cursors"), cacheBeforeReceipt = try await workspace.cachedDetail(id)
    let beforeReceipt = cursorBeforeReceipt == before && cacheBeforeReceipt == nil
    try await workspace.applied(receipt)
    let cursor = try await vault.metadata(name: "event-cursors")
    let cached = try await workspace.cachedDetail(id)
    try await workspace.applied(receipt)
    let repeatedReceipt = try await vault.metadata(name: "event-cursors") == cursor
    var oldAckRefused = false
    do { try await workspace.acknowledge(event, from: stream, sessionId: id, appliedRevision: update.detail["sync"]["revision"].integer ?? 0) }
    catch { oldAckRefused = true }
    let oldAccepts = try await workspace.accepts(event, from: stream, sessionId: id)
    let duplicate = reading.publication.apply(update) { _ in assignments += 1; return true } == nil

    let heldReading = try await workspace.beginBody(id), held = try await workspace.readBody(for: heldReading)
    let nextReading = try await workspace.beginBody(id)
    let stale = heldReading.publication.apply(held) { _ in true } == nil
    let crossed = nextReading.publication.apply(held) { _ in true } == nil
    let next = try await workspace.readBody(for: nextReading)
    let signatures = await keys.verificationCalls.value
    await workspace.invalidateContentWindow(lease)
    let expired = nextReading.publication.apply(next) { _ in true } == nil
    var closedRead = false
    do { _ = try await workspace.beginBody(id) } catch { closedRead = (error as? NativeFailure) == .expired }
    let noVerification = await keys.verificationCalls.value == signatures
    _ = try await workspace.verify()
    let finalReading = try await workspace.beginBody(id), final = try await workspace.readBody(for: finalReading)
    await workspace.closeOpening()
    let closed = finalReading.publication.apply(final) { _ in true } == nil
    return ["refusedApplication": rejected, "noProgressBeforeApplication": untouched && beforeReceipt,
        "nestedPublicationRefused": nestedRejected, "appliedOnce": assignments == 1, "cacheAfterReceipt": cached == update.detail,
        "cursorAfterReceipt": cursor != nil, "idempotentReceipt": repeatedReceipt, "duplicateRefused": duplicate,
        "legacyAccepts": oldAccepts, "legacyAckRefused": oldAckRefused, "staleSelectionRefused": stale,
        "foreignPublicationRefused": crossed, "expiredPublicationRefused": expired, "closedRead": closedRead,
        "noImplicitVerification": noVerification, "closedPublicationRefused": closed]
}

/** Diagnostic replay of the App's 100ms opaque-update publication, against actual Host events. */
@MainActor func bodyCadenceFixture(_ workspace: NativeWorkspace, id: String) async throws -> [String: Any] {
    let reading = try await workspace.beginBody(id)
    let initial = try await workspace.readBody(for: reading)
    if let receipt = reading.publication.apply(initial, to: { _ in true }) { try await workspace.applied(receipt) }
    let stream = try await workspace.events(for: reading, incremental: true)
    var held: NativeBodyUpdate?, publication: Task<Void, Never>?, metadata: Task<Void, Never>?
    var updates = 0, applied = 0, notices = 0, repairs = 0, full = 0, delta = 0, finalBytes = 0
    var failure = "", timings: [[String: Any]] = []
    let start = ContinuousClock.now
    func mark(_ kind: String) {
        let elapsed = start.duration(to: .now).components
        timings.append(["kind": kind, "ms": Double(elapsed.seconds) * 1000 + Double(elapsed.attoseconds) / 1e15,
            "updates": updates, "applied": applied, "delta": delta])
    }
    _ = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/tasks/" + id + "/prompt", fields: ["prompt": .string("count 6000")]))
    do {
        for try await event in stream.events {
            if event.type == "task-state" { full += 1 }
            if event.type == "task-delta" { delta += 1 }
            switch try await workspace.receive(event, from: stream, for: reading) {
            case let .update(update):
                updates += 1; held = update
                if publication == nil {
                    publication = Task {
                        defer { publication = nil }
                        do {
                            while held != nil {
                                try await Task.sleep(for: .milliseconds(100))
                                guard !Task.isCancelled, let next = held else { return }; held = nil
                                if let receipt = reading.publication.apply(next, to: { _ in true }) {
                                    try await workspace.applied(receipt); applied += 1
                                }
                            }
                        } catch { if !Task.isCancelled { failure = "publication-" + String(describing: error); mark("publication-failed") } }
                    }
                }
            case let .notice(notice):
                notices += 1; mark("notice")
                metadata = Task {
                    do {
                        let next = try await workspace.refreshBody(for: reading, after: notice)
                        mark("metadata-returned")
                        if let receipt = reading.publication.apply(next, to: { _ in true }) { try await workspace.applied(receipt) }
                        mark("metadata-applied")
                    } catch { if !Task.isCancelled { failure = "metadata-" + String(describing: error); mark("metadata-failed") } }
                }
            case let .repair(value): repairs += 1; mark("repair-" + value.cause.rawValue)
            case .ignore, .hostState: break
            }
            if repairs > 0 { break }
            if event.type == "task-state", let value = try? NativeJSON.decode(event.data),
               value["detail"]["summary"]["status"].string == "idle", value["detail"]["messages"].array.count >= 22 {
                finalBytes = value["detail"]["messages"].array.last?["text"].string?.utf8.count ?? 0; break
            }
        }
    } catch { failure = "stream-" + String(describing: error); mark("stream-failed") }
    publication?.cancel(); metadata?.cancel(); _ = await publication?.value; _ = await metadata?.value
    await stream.cancel(); await workspace.endBody(reading); await workspace.closeOpening()
    return ["updates": updates, "applied": applied, "notices": notices, "repairs": repairs, "full": full, "delta": delta,
        "finalBytes": finalBytes, "failure": failure, "timings": timings]
}
