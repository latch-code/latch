import Foundation
import LatchNativeCore

/** A phone's workspace against a real Host: bodies behind a window, retries keep their request, and a stop survives a lost answer. */
@MainActor func runNativeWorkspace(_ input: [String: Any]) async throws -> [String: Any] {
    let invitation = try PairingInvitation.parse(input["payload"] as? String ?? "", privateOnly: false), port = try fixturePort(input), keys = try FixtureKeys()
    let pairing = try NativePairing(invitation: invitation, keys: keys)
    let temporary = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey)
    _ = try await pairing.begin(on: temporary, name: "Swift workspace fixture", gatewayHash: Data(repeating: 0, count: 32))
    var approved = false
    for _ in 0..<60 {
        if let view = try await pairing.status(on: temporary), view.status == "approved" { approved = true; break }
        try await Task.sleep(for: .milliseconds(50))
    }
    guard approved else { throw NativeFailure.unavailable }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-workspace-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: invitation.hostId)
    let device = try await pairing.complete(on: temporary) { device in
        try await vault.storeMetadata(JSONEncoder().encode(device), name: "device")
    }
    await temporary.close()
    let workspace = try NativeWorkspace(device: device, keys: keys, vault: vault)
    do {
        _ = try await workspace.install {
            try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki,
                knockKey: device.knockKey, identity: keys.identity())
        }
        var windowRequired = false
        do { _ = try await workspace.read("/link/api/plugins", body: true) }
        catch { windowRequired = (error as? NativeFailure) == .expired }
        guard windowRequired else { throw NativeFailure.identityMismatch }
        var cacheNeedsWindow = false
        do { _ = try await workspace.cachedDetail("none") }
        catch { cacheNeedsWindow = (error as? NativeFailure) == .expired }
        guard cacheNeedsWindow else { throw NativeFailure.identityMismatch }
        let lease = try await workspace.verify()
        if input["helperReceipt"] as? Bool == true {
            let catalog = try await workspace.snapshot()["catalog"]
            var draft = try PhoneHelperCreate.choose(catalog, harnessId: "standard", agents: [])
            draft.name = "Receipt fixture helper"
            let write = try PhoneHelperCreate.create(catalog, draft: draft)
            var unknown = false
            do { _ = try await workspace.submit(write) } catch { unknown = (error as? NativeFailure) == .resultUnknown }
            let held = try await workspace.pendingWrites()
            let same = held.count == 1 && held[0].requestId == write.requestId && held[0].body == write.body
            let response = try await workspace.submit(write)
            let id = try PhoneHelperCreate.createdId(response, for: write)
            let cleared = try await workspace.pendingWrites().isEmpty
            await workspace.closeOpening(); await vault.lock()
            return ["unknown": unknown, "sameRequest": same, "createdId": id, "cleared": cleared]
        }
        if input["bodyScript"] as? String == "cadence", let id = input["sessionId"] as? String {
            return try await bodyCadenceFixture(workspace, id: id)
        }
        if let mode = input["bodyScript"] as? String, ["vault-covered", "metadata-covered"].contains(mode), let id = input["sessionId"] as? String {
            return try await bodyBacklogFixture(workspace, vault: vault, id: id, mode: mode)
        }
        if input["bodyScript"] as? String == "ledger-state", let id = input["sessionId"] as? String {
            return try await bodyLedgerFixture(workspace, lease: lease, id: id)
        }
        if input["bodyScript"] as? String == "shadow", let id = input["sessionId"] as? String {
            return try await bodyShadowFixture(workspace, vault: vault, id: id)
        }
        if input["bodyScript"] as? String == "opening", let id = input["sessionId"] as? String {
            return try await bodyOpeningFixture(workspace, id: id)
        }
        if input["bodyScript"] as? String == "reconnect", let id = input["sessionId"] as? String {
            return try await bodyConnectionFixture(workspace, keys: keys, id: id) {
                try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki,
                    knockKey: device.knockKey, identity: keys.identity())
            }
        }
        if let mode = input["bodyScript"] as? String, ["scope", "scope-no-view"].contains(mode), let id = input["sessionId"] as? String {
            return try await bodyScopeFixture(workspace, vault: vault, lease: lease, keys: keys, id: id, mode: mode)
        }
        if let mode = input["bodyScript"] as? String, let id = input["sessionId"] as? String {
            return try await bodyOrderingFixture(workspace, vault: vault, id: id, mode: mode)
        }
        if input["bodyPublication"] as? Bool == true {
            return try await bodyReadingFixture(workspace, vault: vault, lease: lease, keys: keys)
        }
        if input["eventProvenance"] as? Bool == true {
            let firstStream = try await workspace.events(expectedLease: lease)
            let secondStream = try await workspace.events(expectedLease: lease)
            var firstEvents = firstStream.events.makeAsyncIterator()
            guard let first = try await firstEvents.next(), let cursor = first.cursor else { throw NativeFailure.invalidRecord }
            let own = try await workspace.accepts(first, from: firstStream, sessionId: nil)
            let crossed = try await workspace.accepts(first, from: secondStream, sessionId: nil)
            var parser = NativeEventParser()
            let wire = Data("id: \(cursor.epoch):\(cursor.sequence)\nevent: \(first.type)\ndata: ".utf8) + first.data + Data("\n\n".utf8)
            guard let copied = try parser.feed(wire).first else { throw NativeFailure.invalidRecord }
            let parsed = try await workspace.accepts(copied, from: firstStream, sessionId: nil)
            let revision = try await workspace.snapshot()["revision"].integer ?? 0
            var refused = false
            do { try await workspace.acknowledge(copied, from: firstStream, sessionId: nil, appliedRevision: revision) }
            catch { refused = true }
            try await workspace.acknowledge(first, from: firstStream, sessionId: nil, appliedRevision: revision)
            await firstStream.cancel(); await secondStream.cancel()
            await workspace.closeOpening(); await vault.lock()
            return ["ownAccepted": own, "crossStreamAccepted": crossed, "parserAccepted": parsed, "parserAckRefused": refused]
        }
        if input["eventRecovery"] as? Bool == true {
            let held = try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["mode": .string("chat"), "prompt": .string("Unconfirmed event fixture")])
            try await vault.storeBody(JSONEncoder().encode(held), name: "pending-" + held.requestId, lease: lease)
            try await vault.storeMetadata(JSONEncoder().encode([held.requestId]), name: "pending-index")
            var failure: Error = NativeFailure.invalidRecord
            do {
                let events = try await workspace.events(expectedLease: lease)
                for try await _ in events.events {}
                await events.cancel()
            } catch { failure = error }
            guard let recovery = await PhoneUnlock.recoverStream(failure, current: { true }, readMetadata: { try await workspace.snapshot() })
                else { throw NativeFailure.invalidRecord }
            let action = recovery.action
            var resumed = false
            if action.rawValue == "retryEvents" {
                let events = try await workspace.events(expectedLease: lease)
                for try await event in events.events {
                    resumed = try await workspace.accepts(event, from: events, sessionId: nil)
                    break
                }
                await events.cancel()
            }
            let pending = try await workspace.pendingWrites()
            let valid = lease.valid
            await workspace.closeOpening(); await vault.lock()
            return ["eventFailure": (failure as? NativeFailure)?.rawValue ?? "other", "leaseStillValid": valid,
                "metadataRead": recovery.snapshot != nil, "action": action.rawValue, "resumed": resumed, "pending": pending.count,
                "samePending": pending.first?.requestId == held.requestId && pending.first?.path == held.path
                    && pending.first?.method == held.method && pending.first?.body == held.body]
        }
        if input["agentReadFailures"] as? Bool == true {
            let held = try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["mode": .string("chat"), "prompt": .string("Unconfirmed fixture message")])
            try await vault.storeBody(JSONEncoder().encode(held), name: "pending-" + held.requestId, lease: lease)
            try await vault.storeMetadata(JSONEncoder().encode([held.requestId]), name: "pending-index")
            var outcomes: [String] = []
            for _ in 0..<3 {
                do { _ = try await workspace.read("/link/api/custom-agents/general", body: true); outcomes.append("ready") }
                catch { outcomes.append(String(describing: PhoneAgents.readFailure(error))) }
            }
            let read = try await workspace.read("/link/api/custom-agents/general", body: true)
            let live = try await workspace.snapshot()
            let pending = try await workspace.pendingWrites()
            await workspace.closeOpening(); await vault.lock()
            return ["outcomes": outcomes, "transportUsable": read != .null && live["device"]["id"].string == device.deviceId,
                "pending": pending.count, "samePending": pending.first?.requestId == held.requestId && pending.first?.path == held.path
                    && pending.first?.method == held.method && pending.first?.body == held.body,
                "timeout": String(describing: PhoneAgents.readFailure(NativeFailure.resultUnknown))]
        }
        let create = try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["mode": .string("chat"), "prompt": .string("Daily Swift conversation")])
        let task = try await workspace.submit(create)
        guard let taskId = task["sessionId"].string else { throw NativeFailure.invalidRecord }
        var settled = false
        for _ in 0..<100 {
            let detail = try await workspace.detail(taskId)
            guard detail["messages"].array.first?["text"].string == "Daily Swift conversation",
                  detail["messages"].array.first?["requestId"].string == create.requestId else { throw NativeFailure.identityMismatch }
            if detail["summary"]["status"].string == "idle" { settled = true; break }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard settled, try await workspace.submit(create)["sessionId"].string == taskId else { throw NativeFailure.invalidRecord }
        _ = try await workspace.snapshot()
        guard let cached = try await workspace.cachedSnapshot(), cached["tasks"].array.contains(where: { $0["id"].string == taskId }) else { throw NativeFailure.storageUnavailable }
        // The list that survives offline holds only what its rows draw, and the bodies stay behind a window.
        guard cached["tasks"].array.allSatisfy({ $0["cwd"] == .null && $0["live"] == .null }), cached["catalog"]["providers"] == .null,
              cached["catalog"]["workspaces"].array.allSatisfy({ Set($0.object.keys) == ["id", "name"] }),
              cached["catalog"]["harnesses"].array.allSatisfy({ Set($0.object.keys) == ["id", "level", "capabilities"] && Set($0["capabilities"].object.keys) == ["display"] }),
              try await workspace.cachedDetail(taskId)?["summary"]["id"].string == taskId,
              try await workspace.cachedDetail("never-read") == nil else { throw NativeFailure.storageUnavailable }
        // A run that has ended answers 继续等 plainly; a note against a settled request is refused, not left unknown.
        guard try await workspace.keepWaiting(sessionId: taskId, runId: "gone", thresholdMs: 1000)["outcome"].string == "ended" else { throw NativeFailure.invalidRecord }
        var noteRefused = false
        do { _ = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/approvals/settled-request", fields: ["decision": .string("reject"), "note": .string("改用别的办法")])) }
        catch { noteRefused = (error as? NativeFailure) != .resultUnknown }
        guard noteRefused, try await workspace.pendingWrites().isEmpty else { throw NativeFailure.invalidRecord }
        // An earlier build kept a message for an assistant as an unconfirmed start. It is not offered again, and sent anyway
        // the Host refuses it rather than starting an ordinary session with it.
        let sessions = try await workspace.snapshot()["tasks"].array.count
        let assistantWrite = try NativePendingWrite(method: .post, path: "/link/api/tasks",
            fields: ["prompt": .string("For the assistant"), "assistantId": .string("asst_" + UUID().uuidString.lowercased())])
        try await vault.storeBody(JSONEncoder().encode(assistantWrite), name: "pending-" + assistantWrite.requestId, lease: lease)
        try await vault.storeMetadata(JSONEncoder().encode([assistantWrite.requestId]), name: "pending-index")
        guard try await workspace.pendingWrites().isEmpty else { throw NativeFailure.invalidRecord }
        var assistantRefused = false
        do { _ = try await workspace.submit(assistantWrite) } catch { assistantRefused = (error as? NativeFailure) != .resultUnknown }
        guard assistantRefused, try await workspace.pendingWrites().isEmpty,
              try await workspace.snapshot()["tasks"].array.count == sessions else { throw NativeFailure.invalidRecord }
        // The same build kept group messages, routine changes and assistant memories the same way; this Host has no such routes.
        let groupWrite = try NativePendingWrite(method: .post, path: "/link/api/personal/groups/grp_" + UUID().uuidString.lowercased() + "/messages",
            fields: ["text": .string("For the group")])
        let routineWrite = try NativePendingWrite(method: .delete, path: "/link/api/personal/routines/rtn_" + UUID().uuidString.lowercased(), fields: [:])
        for write in [groupWrite, routineWrite] {
            try await vault.storeBody(JSONEncoder().encode(write), name: "pending-" + write.requestId, lease: lease)
        }
        try await vault.storeMetadata(JSONEncoder().encode([groupWrite.requestId, routineWrite.requestId]), name: "pending-index")
        guard try await workspace.pendingWrites().isEmpty, try await workspace.pendingWrites().isEmpty else { throw NativeFailure.invalidRecord }
        // What the new-session sheet chooses by itself is something this Host accepts from this phone.
        let live = try await workspace.snapshot()
        let choice = PhoneStart.defaults(live["catalog"])
        guard PhoneStart.blocker(live["catalog"], choice: choice) == nil else { throw NativeFailure.invalidRecord }
        let started = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/tasks", fields: PhoneStart.fields(live["catalog"], choice: choice, prompt: "Started from the phone")))
        guard let startedId = started["sessionId"].string else { throw NativeFailure.invalidRecord }
        for _ in 0..<100 {
            if try await workspace.detail(startedId)["summary"]["status"].string == "idle" { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        _ = try await workspace.submit(NativePendingWrite(method: .delete, path: "/link/api/tasks/" + startedId, fields: [:]))
        let queuedWrite = try NativePendingWrite(method: .post, path: "/link/api/tasks/" + taskId + "/prompt", fields: ["prompt": .string("Queued Swift follow-up"), "queue": .bool(true)])
        _ = try await workspace.submit(queuedWrite)
        var queuedSettled = false
        for _ in 0..<100 {
            let value = try await workspace.detail(taskId)
            if value["summary"]["status"].string == "idle" {
                guard value["messages"].array.filter({ $0["requestId"].string == queuedWrite.requestId }).count == 1 else { throw NativeFailure.identityMismatch }
                queuedSettled = true; break
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard queuedSettled, try await workspace.submit(queuedWrite)["accepted"].bool else { throw NativeFailure.invalidRecord }
        let cancelPath = "/link/api/tasks/" + taskId + "/cancel"
        let controlFields: [String: NativeJSON] = ["requestId": .string(UUID().uuidString)]
        _ = try await workspace.freeAction(path: cancelPath, fields: controlFields)
        guard try await workspace.pendingControl() == nil else { throw NativeFailure.invalidRecord }
        // A dropped acknowledgement can leave this exact encrypted control intent even after the Host settled it.
        try await vault.storeMetadata(NativeJSON.object(["path": .string(cancelPath), "fields": .object(controlFields)]).encoded(), name: "control-pending")
        guard let pendingControl = try await workspace.pendingControl() else { throw NativeFailure.storageUnavailable }
        var changedControlRefused = false
        do { _ = try await workspace.freeAction(path: cancelPath, fields: ["requestId": .string(UUID().uuidString)]) }
        catch { changedControlRefused = (error as? NativeFailure) == .resultUnknown }
        guard changedControlRefused, try await workspace.pendingControl() == pendingControl,
              let controlPath = pendingControl["path"].string else { throw NativeFailure.identityMismatch }
        _ = try await workspace.freeAction(path: controlPath, fields: pendingControl["fields"].object)
        guard try await workspace.pendingControl() == nil else { throw NativeFailure.invalidRecord }
        var strictControl = false
        do { _ = try await workspace.freeAction(path: cancelPath, fields: ["requestId": .string(UUID().uuidString), "prompt": .string("forbidden input")]) }
        catch { strictControl = (error as? NativeFailure) == .invalidRecord }
        guard strictControl else { throw NativeFailure.identityMismatch }
        _ = try await workspace.submit(NativePendingWrite(method: .delete, path: "/link/api/tasks/" + taskId, fields: [:]))
        guard try await workspace.pendingWrites().isEmpty else { throw NativeFailure.storageUnavailable }
        await workspace.closeOpening(); await vault.lock()
        return ["windowRequired": true, "sameRequest": true, "cachedList": true, "pendingCleared": true, "controlRecovery": true, "strictControl": true, "phoneWorkspace": true, "assistantWrite": true]
    } catch {
        await workspace.closeOpening(); await vault.lock(); throw error
    }
}
