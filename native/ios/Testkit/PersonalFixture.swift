import Foundation
import LatchNativeCore

@MainActor func runNativePersonal(_ input: [String: Any]) async throws -> [String: Any] {
    let invitation = try PairingInvitation.parse(input["payload"] as? String ?? "", privateOnly: false), port = try fixturePort(input), keys = try FixtureKeys()
    let pairing = try NativePairing(invitation: invitation, keys: keys)
    let temporary = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey)
    _ = try await pairing.begin(on: temporary, name: "Swift personal fixture", gatewayHash: Data(repeating: 0, count: 32))
    var approved = false
    for _ in 0..<60 {
        if let view = try await pairing.status(on: temporary), view.status == "approved" { approved = true; break }
        try await Task.sleep(for: .milliseconds(50))
    }
    guard approved else { throw NativeFailure.unavailable }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-personal-" + UUID().uuidString)
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
        do { _ = try await workspace.read("/link/api/personal", body: true) }
        catch { windowRequired = (error as? NativeFailure) == .expired }
        guard windowRequired else { throw NativeFailure.identityMismatch }
        _ = try await workspace.verify()
        let assistant = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/personal/assistants", fields: [
            "name": .string("Swift personal"), "role": .string("Swift private role"), "harnessId": .string("standard"),
            "mode": .string("chat"), "pluginIds": .array([]),
        ]))
        guard let assistantId = assistant["id"].string else { throw NativeFailure.invalidRecord }
        let memory = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/personal/assistants/" + assistantId + "/memories", fields: [
            "content": .string("Swift private memory"),
        ]))
        guard memory["revision"].integer == 1 else { throw NativeFailure.invalidRecord }
        let create = try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["assistantId": .string(assistantId), "prompt": .string("Daily Swift conversation")])
        let task = try await workspace.submit(create)
        guard let taskId = task["sessionId"].string else { throw NativeFailure.invalidRecord }
        var settled = false
        for _ in 0..<100 {
            let detail = try await workspace.detail(taskId)
            guard detail["summary"]["personal"]["assistantId"].string == assistantId,
                  detail["messages"].array.first?["text"].string == "Daily Swift conversation",
                  detail["messages"].array.first?["requestId"].string == create.requestId,
                  !String(decoding: try detail.encoded(), as: UTF8.self).contains("Swift private") else { throw NativeFailure.identityMismatch }
            if detail["summary"]["status"].string == "idle" { settled = true; break }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard settled, try await workspace.submit(create)["sessionId"].string == taskId else { throw NativeFailure.invalidRecord }
        let profile = try await workspace.read("/link/api/personal/assistants/" + assistantId, body: true)
        guard profile["memories"].array.first?["content"].string == "Swift private memory",
              profile["sessions"].array.contains(where: { $0["id"].string == taskId }) else { throw NativeFailure.identityMismatch }
        _ = try await workspace.snapshot()
        guard let cached = try await workspace.cachedSnapshot(),
              cached["tasks"].array.first(where: { $0["id"].string == taskId })?["personal"]["assistantId"].string == assistantId,
              !String(decoding: try cached.encoded(), as: UTF8.self).contains("Swift private") else { throw NativeFailure.storageUnavailable }
        let queuedWrite = try NativePendingWrite(method: .post, path: "/link/api/tasks/" + taskId + "/prompt", fields: ["prompt": .string("Queued Swift follow-up"), "queue": .bool(true)])
        _ = try await workspace.submit(queuedWrite)
        var queuedSettled = false
        for _ in 0..<100 {
            let value = try await workspace.detail(taskId)
            if value["summary"]["status"].string == "idle" {
                guard value["messages"].array.filter({ $0["requestId"].string == queuedWrite.requestId }).count == 1,
                      !String(decoding: try value.encoded(), as: UTF8.self).contains("Swift private") else { throw NativeFailure.identityMismatch }
                queuedSettled = true; break
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard queuedSettled, try await workspace.submit(queuedWrite)["accepted"].bool else { throw NativeFailure.invalidRecord }
        let routine = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/personal/routines", fields: [
            "name": .string("Swift daily routine"), "assistantId": .string(assistantId), "prompt": .string("Organize today's notes"),
            "schedule": .object(["kind": .string("daily"), "time": .string("09:30"), "timeZone": .string("UTC")]),
        ]))
        guard let routineId = routine["id"].string, !routine["enabled"].bool else { throw NativeFailure.invalidRecord }
        let routinePath = "/link/api/personal/routines/" + routineId
        let renamed = try await workspace.submit(NativePendingWrite(method: .patch, path: routinePath, fields: ["baseRevision": routine["revision"], "name": .string("Updated Swift routine")]))
        guard renamed["name"].string == "Updated Swift routine" else { throw NativeFailure.invalidRecord }
        var desktopEnableRequired = false
        do { _ = try await workspace.submit(NativePendingWrite(method: .post, path: routinePath + "/enabled", fields: ["baseRevision": renamed["revision"], "enabled": .bool(true)])) }
        catch { desktopEnableRequired = (error as? NativeFailure) == .forbidden }
        guard desktopEnableRequired, try await workspace.pendingWrites().isEmpty else { throw NativeFailure.invalidRecord }
        _ = try await workspace.submit(NativePendingWrite(method: .delete, path: routinePath, fields: [:]))
        let group = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/personal/groups", fields: [
            "name": .string("Swift group"), "memberIds": .array([.string(assistantId)]), "defaultAssistantId": .string(assistantId),
            "instructions": .string("Explicit shared instructions"), "maxRelays": .number(0),
        ]))
        guard let groupId = group["id"].string else { throw NativeFailure.invalidRecord }
        let groupPath = "/link/api/personal/groups/" + groupId
        let groupInput = try NativePendingWrite(method: .post, path: groupPath + "/messages", fields: ["prompt": .string("Shared Swift task")])
        let accepted = try await workspace.submit(groupInput)
        guard let turnId = accepted["turnId"].string else { throw NativeFailure.invalidRecord }
        var groupSessions: [String] = []
        for _ in 0..<60 {
            let value = try await workspace.read(groupPath, body: true)
            if value["turn"]["state"].string == "completed" {
                guard value["messages"].array.first?["requestId"].string == groupInput.requestId,
                      !String(decoding: try value.encoded(), as: UTF8.self).contains("Swift private") else { throw NativeFailure.identityMismatch }
                groupSessions = value["turn"]["sessionIds"].array.compactMap(\.string); break
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        guard groupSessions.count == 1 else { throw NativeFailure.unavailable }
        let controlFields: [String: NativeJSON] = ["requestId": .string(UUID().uuidString), "turnId": .string(turnId)]
        let controlled = try await workspace.freeAction(path: groupPath + "/cancel", fields: controlFields)
        guard controlled["state"].string == "completed", try await workspace.pendingControl() == nil else { throw NativeFailure.invalidRecord }
        // A dropped acknowledgement can leave this exact encrypted control intent even after the Host settled it.
        try await vault.storeMetadata(NativeJSON.object(["path": .string(groupPath + "/cancel"), "fields": .object(controlFields)]).encoded(), name: "control-pending")
        guard let pendingControl = try await workspace.pendingControl() else { throw NativeFailure.storageUnavailable }
        var changedControlRefused = false
        do { _ = try await workspace.freeAction(path: groupPath + "/cancel", fields: ["requestId": .string(UUID().uuidString), "turnId": .string(turnId)]) }
        catch { changedControlRefused = (error as? NativeFailure) == .resultUnknown }
        guard changedControlRefused, try await workspace.pendingControl() == pendingControl,
              let controlPath = pendingControl["path"].string else { throw NativeFailure.identityMismatch }
        let recoveredControl = try await workspace.freeAction(path: controlPath, fields: pendingControl["fields"].object)
        guard recoveredControl["state"].string == "completed", try await workspace.pendingControl() == nil else { throw NativeFailure.invalidRecord }
        var strictControl = false
        do { _ = try await workspace.freeAction(path: groupPath + "/cancel", fields: ["requestId": .string(UUID().uuidString), "turnId": .string(turnId), "prompt": .string("forbidden input")]) }
        catch { strictControl = (error as? NativeFailure) == .invalidRecord }
        guard strictControl else { throw NativeFailure.identityMismatch }
        for id in groupSessions { _ = try await workspace.submit(NativePendingWrite(method: .delete, path: "/link/api/tasks/" + id, fields: [:])) }
        _ = try await workspace.submit(NativePendingWrite(method: .delete, path: groupPath, fields: [:]))
        _ = try await workspace.submit(NativePendingWrite(method: .delete, path: "/link/api/tasks/" + taskId, fields: [:]))
        _ = try await workspace.submit(NativePendingWrite(method: .delete, path: "/link/api/personal/assistants/" + assistantId, fields: [:]))
        guard try await workspace.pendingWrites().isEmpty else { throw NativeFailure.storageUnavailable }
        await workspace.closeOpening(); await vault.lock()
        return ["personal": true, "windowRequired": true, "privateHistory": true, "cachedClassification": true, "sameRequest": true, "pendingCleared": true,"group":true,"strictGroupCancel":true,"routine":true,"personalQueue":true,"controlRecovery":true]
    } catch {
        await workspace.closeOpening(); await vault.lock(); throw error
    }
}
