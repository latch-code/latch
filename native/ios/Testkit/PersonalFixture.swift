import Foundation
import LatchNativeCore

@MainActor func runNativePersonal(_ input: [String: Any]) async throws -> [String: Any] {
    let invitation = try PairingInvitation.parse(input["payload"] as? String ?? ""), port = try fixturePort(input), keys = try FixtureKeys()
    let pairing = try NativePairing(invitation: invitation, keys: keys)
    let temporary = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: invitation.rootSpki,
        knockKey: LinkBytes.hash(Data(invitation.invitation.utf8)))
    _ = try await pairing.begin(on: temporary, name: "Swift personal fixture")
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
        var privateScopeRequired = false
        do { _ = try await workspace.read("/link/api/personal", body: true) }
        catch { privateScopeRequired = (error as? NativeFailure) == .forbidden }
        guard privateScopeRequired else { throw NativeFailure.identityMismatch }
        FileHandle.standardError.write(Data("Native personal waiting for desktop grant\n".utf8))
        var granted = false
        for _ in 0..<60 {
            let snapshot = try await workspace.snapshot()
            if snapshot["device"]["dataScope"].string == "all" { granted = true; break }
            try await Task.sleep(for: .milliseconds(50))
        }
        guard granted else { throw NativeFailure.forbidden }
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
        _ = try await workspace.submit(NativePendingWrite(method: .delete, path: "/link/api/tasks/" + taskId, fields: [:]))
        _ = try await workspace.submit(NativePendingWrite(method: .delete, path: "/link/api/personal/assistants/" + assistantId, fields: [:]))
        guard try await workspace.pendingWrites().isEmpty else { throw NativeFailure.storageUnavailable }
        await workspace.closeOpening(); await vault.lock()
        return ["personal": true, "windowRequired": true, "privateScopeRequired": true, "privateHistory": true, "cachedClassification": true, "sameRequest": true, "pendingCleared": true]
    } catch {
        await workspace.closeOpening(); await vault.lock(); throw error
    }
}
