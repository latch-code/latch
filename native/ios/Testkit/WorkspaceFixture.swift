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
    let vaultKey = try LinkBytes.random(32)
    let pairingVault = try EncryptedVault(directory: directory, key: vaultKey, binding: invitation.hostId)
    let device = try await pairing.complete(on: temporary) { device in
        try await pairingVault.storeMetadata(JSONEncoder().encode(device), name: "device")
    }
    await temporary.close()
    let transports = WorkTransportFixture()
    let vault: EncryptedVault
    let profile: (store: NativeProfileStore, host: NativeRegisteredHost)?
    if input["workCacheLockOpen"] as? Bool == true {
        let store = try await NativeProfileStore.open(directory: directory, key: vaultKey, eraseKeys: { _ in })
        let reference = DeviceKeyReference(connectionTag: Data("fixture.work-cache.connection".utf8),
            verificationTag: Data("fixture.work-cache.verification".utf8), connectionSpki: keys.connectionSpki,
            verificationSpki: keys.verificationSpki)
        let host = NativeRegisteredHost(name: "Swift workspace fixture", device: device, keys: reference, prepared: false)
        try await store.save(host)
        vault = try await store.hostVault(host)
        profile = (store, host)
    } else {
        vault = pairingVault
        profile = nil
    }
    let workspace = try NativeWorkspace(device: device, keys: keys, vault: vault, onTransportInstalled: { transports.record($0) })
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
        if let markers = input["initialListMarkers"] as? String {
            return try await transports.exerciseInitialList(workspace, markers: URL(fileURLWithPath: markers, isDirectory: true))
        }
        if let lead = input["mentionLead"] as? String {
            _ = try await workspace.verify()
            return try await teamRoundRetryFixture(workspace, lead: lead)
        }
        if let agent = input["mentionAgent"] as? String, let item = input["mentionItem"] as? String {
            _ = try await workspace.verify()
            return try await workAgentRetryFixture(workspace, agent: agent, item: item)
        }
        if let project = input["mentionProject"] as? String, let transport = transports.latest?.epoch {
            let access = NativeFileAccess(lease: try await workspace.verify(), transport: transport)
            let live = try await workspace.snapshot(), scope = PhoneMentionScope.project(workspace: project, harness: "standard")
            let all = try await workspace.findMentionFiles("", in: scope, access: access)
            guard let hit = all.files.first(where: { $0.path == "meeting notes.md" }) else { throw NativeFailure.invalidRecord }
            let marker = "@" + hit.root + ":" + hit.path
            let choice = PhoneStartChoice(harnessId: "standard", workspaceId: project, model: PhoneStart.defaultModel(live["catalog"], harnessId: "standard"))
            var fields = PhoneStart.newSessionFields(live["catalog"], choice: choice, prompt: "First " + marker)
            try scope.attach([hit], to: &fields, snapshot: live)
            let create = try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: fields)
            guard let id = try await workspace.submit(create)["sessionId"].string else { throw NativeFailure.invalidRecord }
            for _ in 0..<100 {
                if try await workspace.detail(id)["summary"]["status"].string == "idle" { break }
                try await Task.sleep(for: .milliseconds(50))
            }
            let selected = PhoneMentionScope.session(id), refreshed = try await workspace.snapshot()
            let found = try await workspace.findMentionFiles("meeting", in: selected, access: access)
            guard found.files.map(\.id) == [hit.id] else { throw NativeFailure.invalidRecord }
            var next: [String: NativeJSON] = ["prompt": .string("Next " + marker)]
            try selected.attach(found.files, to: &next, snapshot: refreshed)
            let write = try NativePendingWrite(method: .post, path: "/link/api/tasks/" + id + "/prompt", fields: next)
            _ = try await workspace.submit(write)
            var queue: [String: NativeJSON] = ["queue": .bool(true)], steer: [String: NativeJSON] = ["steer": .bool(true)]
            let blocksQueue = (try? selected.attach(found.files, to: &queue, snapshot: refreshed)) == nil
            let blocksSteer = (try? selected.attach(found.files, to: &steer, snapshot: refreshed)) == nil
            _ = await workspace.closeOpening()
            let afterClose = try? await workspace.findMentionFiles("", in: scope, access: access)
            return ["session": id, "blocksQueue": blocksQueue, "blocksSteer": blocksSteer, "oldWindowClosed": afterClose == nil]
        }
        if let session = input["fileBrowserSession"] as? String, let transport = transports.latest?.epoch {
            let access = NativeFileAccess(lease: try await workspace.verify(), transport: transport)
            _ = try await workspace.snapshot()
            let roots = try await workspace.fileDirectory(session: session, folder: PhoneFileFolder(), access: access)
            guard let root = roots.roots.first else { throw NativeFailure.invalidRecord }
            let top = try await workspace.fileDirectory(session: session, folder: PhoneFileFolder(root: root.id), access: access)
            guard let folder = top.entries.first(where: { $0.kind == .directory && $0.name == "资料 + #" }) else { throw NativeFailure.invalidRecord }
            let location = PhoneFileFolder(root: root.id, dir: folder.name)
            let page = try await workspace.fileDirectory(session: session, folder: location, access: access)
            guard let file = page.entries.first(where: { $0.kind == .file && $0.name == "验收.md" }) else { throw NativeFailure.invalidRecord }
            let matches = try await workspace.findProjectFiles(session: session, query: "验收", access: access)
            let partial = try PhoneFileMatches(.object(["files": .array([]), "truncated": .bool(false),
                "unchecked": .object(["files": .number(1), "directories": .number(2)])]))
            guard matches.uncheckedCount == 0, partial.uncheckedCount == 3,
                  matches.files.contains(where: { $0.root == root.id && $0.path.utf8.elementsEqual(location.appending(file.name).utf8) }) else {
                throw NativeFailure.invalidRecord
            }
            let previews = try await workspace.resolveFile(sessionId: session, reference: location.appending(file.name), rootId: root.id, access: access)
            let previewable = previews["files"].array.first?["file"]["handle"].string != nil
            let path = location.appending(file.name)
            let inline = try await workspace.knownFileReferences(sessionId: session, references: [path, "does-not-exist.txt"], access: access)
            let unsafe = (try? PhoneFileFolder(root: root.id, dir: "../other").path(session: session)) == nil
            let wrongRoot = (try? PhoneFileDirectory(.object(["context": .object(["kind": .string("session"), "sessionId": .string(session)]),
                "roots": .array([]), "entries": .array([]), "truncated": .bool(false)]), session: session, folder: location)) == nil
            _ = try await workspace.install {
                try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
            }
            let oldPreview = try? await workspace.resolveFile(sessionId: session, reference: location.appending(file.name), rootId: root.id, access: access)
            let oldList = try? await workspace.fileDirectory(session: session, folder: location, access: access)
            let oldInline = try? await workspace.knownFileReferences(sessionId: session, references: [path], access: access)
            _ = await workspace.closeOpening()
            return ["inlineFiles": inline, "oldPanelClosed": oldPreview == nil && oldList == nil && oldInline == nil, "previewable": previewable, "badFolderRejected": unsafe, "wrongRootRejected": wrongRoot]
        }
        let lease = try await workspace.verify()
        if let target = input["queuedScreenshot"] as? String, let other = input["otherSession"] as? String,
           let marker = input["returnedMarker"] as? String {
            return try await queuedScreenshotFixture(workspace, target: target, other: other, marker: URL(fileURLWithPath: marker))
        }
        if let id = input["workSettlementItem"] as? String, let markers = input["workSettlementMarkers"] as? String {
            return try await settledWorkWindowFixture(workspace, vault: vault, lease: lease, item: id, markers: URL(fileURLWithPath: markers))
        }
        if let landed = input["workCreationReceipt"] as? Bool {
            _ = try await workspace.snapshot()
            let change = PhoneWorkChange.creation(title: "移动端草稿", prompt: "保存后不启动", project: nil)
            let request = try change.request()
            do { _ = try await workspace.submit(request); throw NativeFailure.invalidRecord }
            catch { guard (error as? NativeFailure) == .resultUnknown else { throw error } }
            let pending = try await workspace.pendingWrites()
            guard pending.count == 1, let original = pending.first, original.requestId == request.requestId,
                  original.body == request.body, PhoneWorkChange(original) == change else { throw NativeFailure.invalidRecord }
            if landed {
                let answer = try await workspace.submit(original, mustBePending: true)
                guard change.confirmed(by: answer, requestId: original.requestId), try await workspace.pendingWrites().isEmpty else {
                    throw NativeFailure.invalidRecord
                }
            } else {
                do { _ = try await workspace.submit(original, mustBePending: true); throw NativeFailure.invalidRecord }
                catch { guard (error as? NativeFailure) == .resultUnknown else { throw error } }
                guard try await workspace.pendingWrites().first?.requestId == original.requestId else { throw NativeFailure.invalidRecord }
                try await workspace.settlePending(original.requestId)
            }
            let cleared = try await workspace.pendingWrites().isEmpty
            do { _ = try await workspace.submit(original, mustBePending: true); throw NativeFailure.invalidRecord }
            catch { guard (error as? NativeFailure) == .changedElsewhere else { throw error } }
            _ = await workspace.closeOpening()
            return ["confirmed": landed, "cleared": cleared]
        }
        if let id = input["workChangesItem"] as? String, let memberItem = input["workMemberItem"] as? String, let session = input["workMember"] as? String {
            return try await workChangesFixture(workspace, item: id, memberItem: memberItem, session: session, denied: input["workChangesDenied"] as? Bool == true)
        }
        if let profile, let itemId = input["workCacheItem"] as? String {
            return try await transports.exerciseLockOpen(workspace, vault: vault, keys: keys, store: profile.store,
                host: profile.host, directory: directory, vaultKey: vaultKey, itemId: itemId)
        }
        if let itemId = input["workCacheItem"] as? String, let markers = input["workCacheMarkers"] as? String {
            return try await transports.exerciseCache(workspace, vault: vault, keys: keys, directory: directory,
                vaultKey: vaultKey, itemId: itemId, markers: URL(fileURLWithPath: markers, isDirectory: true)) {
                try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki,
                    knockKey: device.knockKey, identity: keys.identity())
            }
        }
        if let itemId = input["workTransportItem"] as? String {
            return try await transports.exercise(workspace, keys: keys, lease: lease, itemId: itemId) {
                try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki,
                    knockKey: device.knockKey, identity: keys.identity())
            }
        }
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
