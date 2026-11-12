import Foundation
import LatchNativeCore
import CryptoKit
import Security

// Vitest supplies only synthetic, public vectors through stdin; this target is not part of the App product.
let data = try FileHandle.standardInput.read(upToCount: 1_048_577) ?? Data()

final class FixtureKeys: NativeIdentityProvider, @unchecked Sendable {
    let connection: SecKey, verification: SecKey
    let connectionSpki: Data, verificationSpki: Data
    let verificationCalls = FixtureCounter()
    init() throws {
        func memoryKey() throws -> SecKey {
            guard let value = SecKeyCreateRandomKey([kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits: 256,
                kSecPrivateKeyAttrs: [kSecAttrIsPermanent: false]] as CFDictionary, nil) else { throw NativeFailure.unavailable }
            return value
        }
        connection = try memoryKey(); verification = try memoryKey()
        connectionSpki = try SecureDeviceKeys.publicSpki(connection); verificationSpki = try SecureDeviceKeys.publicSpki(verification)
    }
    func identity() throws -> PlatformIdentity {
        let certificate = try P256Certificate.create(spki: connectionSpki, now: Date()) { try SecureDeviceKeys.signDER(connection, $0) }
        return try PlatformIdentity(key: connection, certificate: certificate)
    }
    func signEnrollment(_ statement: Data) throws -> Data {
        try P256.Signing.ECDSASignature(derRepresentation: SecureDeviceKeys.signDER(connection, statement)).rawRepresentation
    }
    func signVerification(_ statement: Data) async throws -> Data {
        await verificationCalls.increment()
        return try P256.Signing.ECDSASignature(derRepresentation: SecureDeviceKeys.signDER(verification, statement)).rawRepresentation
    }
}
actor FixtureCounter { var value = 0; func increment() { value += 1 } }
final class FixtureTransfer: @unchecked Sendable {
    private let lock = NSLock(), start = ProcessInfo.processInfo.systemUptime
    private var first = 0.0, chunks = 0, received = 0, expected = 0
    private var valid = true
    func progress(_ done: Int, _ total: Int) {
        lock.lock(); defer { lock.unlock() }
        if done <= received || done > total || done - received > 65_536 || (expected != 0 && expected != total) { valid = false }
        if chunks == 0 { first = (ProcessInfo.processInfo.systemUptime - start) * 1000 }
        chunks += 1; received = done; expected = total
    }
    var hasProgress: Bool { lock.lock(); defer { lock.unlock() }; return chunks > 0 }
    func result() throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        guard valid, expected > 0, received == expected else { throw NativeFailure.invalidRecord }
        return ["firstChunkMs": first, "totalMs": (ProcessInfo.processInfo.systemUptime - start) * 1000, "chunks": chunks]
    }
}
actor FixtureBookGate {
    var waiting = false
    private var released = false
    func wait() async throws {
        waiting = true
        while !released { try await Task.sleep(for: .milliseconds(5)) }
    }
    func release() { released = true }
    func reset() { waiting = false; released = false }
}
func fixturePort(_ input: [String: Any]) throws -> UInt16 {
    guard let number = input["port"] as? NSNumber, let port = UInt16(exactly: number.intValue), port > 0 else { throw NativeFailure.invalidRecord }
    return port
}
var stage = "input"
do {
    guard data.count <= 1_048_576 else { throw NativeFailure.invalidRecord }
    let input = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    var result: [String: Any] = [:]
    switch input["operation"] as? String {
    case "nativeWorkspace":
        stage = "workspace"
        result = try await runNativeWorkspace(input)
    case "phoneProjection": result = try phoneProjectionFixture(input)
    case "phoneAgents": result = try phoneAgentsFixture(input)
    case "phoneActions": result = try phoneActionsFixture(input)
    case "phoneFlows": result = try await phoneFlowsFixture()
    case "phoneReview": result = try phoneReviewFixture(input)
    case "phoneHistory": result = try phoneHistoryFixture(input)
    case "nativeHistory":
        stage = "history"
        result = try await runNativeHistory(input)
    case "phoneComputers": result = try phoneComputersFixture(input)
    case "nativeListWatcher":
        stage = "watcher"
        result = try await runNativeListWatcher(input)
    case "nativeListWatcherRevoked":
        stage = "watcher"
        result = try await runNativeListWatcherRevoked(input)
    case "fileShape": result = fileShapeFixture(input)
    case "nativeReview":
        stage = "review"
        result = try await runNativeReview(input)
    case "nativeActions":
        stage = "actions"
        result = try await runNativeActions(input)
    case "nativeAgents":
        stage = "agents"
        result = try await runNativeAgents(input)
    case "directoryResolver": result = try await directoryResolverFixture(input)
    case "directoryHTTP": result = try directoryHTTPFixture(input)
    case "directoryEpoch":
        guard let bytes = input["source"] as? String else { throw NativeFailure.invalidRecord }
        let source = try NativeDirectorySource.decode(LinkBytes.unhex(bytes))
        result = ["hash": try source.epoch, "absentHash": NativeDirectorySource.absentEpoch]
    case "directoryCache": result = try await directoryCacheFixture(input)
    case "directorySource":
        guard let value = input["source"] as? [String: Any], let bytes = value["bytes"] as? String,
              let invalid = value["invalidMirrors"] as? [String] else { throw NativeFailure.invalidRecord }
        let decoded = try NativeDirectorySource.decode(LinkBytes.unhex(bytes))
        var rejected = 0
        for url in invalid {
            let encoded = try Data([1]) + LinkBytes.fixed(decoded.anchors[0], 32) + Data([1]) + LinkBytes.field(Data(url.utf8)) + Data([0])
            do { _ = try NativeDirectorySource.decode(encoded) } catch { rejected += 1 }
        }
        guard rejected == invalid.count else { throw NativeFailure.invalidRecord }
        result = ["anchors": decoded.anchors.count, "mirrors": decoded.mirrors.map(\.absoluteString),
            "generation": decoded.minimum?.generation ?? 0, "rejected": rejected]
        if let online = decoded.minimumOnline { result["onlineGeneration"] = online.generation }
    case "directory":
        guard let vector = input["directory"] as? [String: Any], let now = vector["now"] as? NSNumber else { throw NativeFailure.invalidRecord }
        func bytes(_ name: String) throws -> Data { try LinkBytes.unhex(vector[name] as? String ?? "", maximum: 16_384) }
        let authority = try bytes("authority"), addresses = try bytes("addresses"), root = try bytes("root"), rootSignature = try bytes("rootSignature"), signature = try bytes("signature")
        let verified = try NativeRelayDirectory.verify(authority: authority, rootSignature: rootSignature, addresses: addresses, signature: signature, anchors: [root], nowMs: now.uint64Value)
        var rejected = 0
        for mode in 0..<3 {
            do {
                let checkpoint = mode == 2 ? try NativeDirectoryCheckpoint(rootGeneration: 2, rootHash: verified.checkpoint.rootHash, generation: 2, hash: verified.checkpoint.hash) : nil
                _ = try NativeRelayDirectory.verify(authority: authority, rootSignature: rootSignature, addresses: addresses, signature: signature,
                    anchors: [mode == 0 ? Data(repeating: 0, count: 32) : root], nowMs: mode == 1 ? 5_000_000 : now.uint64Value, prior: checkpoint)
            } catch { rejected += 1 }
        }
        guard rejected == 3 else { throw NativeFailure.identityMismatch }
        result = ["verified": true, "rejected": rejected, "rootHash": LinkBytes.hex(verified.checkpoint.rootHash), "hash": LinkBytes.hex(verified.checkpoint.hash)]
    case "outerPadding":
        guard let actions = input["actions"] as? [[String: Any]], actions.count <= 256 else { throw NativeFailure.invalidRecord }
        var writer = NativeRelayOuterPadding(), batches: [String] = []
        for action in actions {
            if let frames = action["frames"] as? [String] { for frame in frames { try writer.enqueue(LinkBytes.unhex(frame, maximum: 32_752)) } }
            guard let time = action["time"] as? NSNumber else { throw NativeFailure.invalidRecord }
            if let batch = try writer.batch(elapsedMs: time.uint64Value) { batches.append(LinkBytes.hex(batch)) }
        }
        result = ["batches": batches, "bufferedBytes": writer.bufferedBytes]
    case "padding":
        guard let vector = input["padding"] as? [String: String], let payload = vector["payload"], let encoded = vector["small"] else { throw NativeFailure.invalidRecord }
        let bytes = try LinkBytes.unhex(encoded, maximum: 16_384)
        for split in 0...bytes.count {
            var decoder = NativePaddingWire.Decoder()
            let decoded = try decoder.feed(Data(bytes.prefix(split))) + decoder.feed(Data(bytes.dropFirst(split)))
            guard decoded == [try LinkBytes.unhex(payload, maximum: 1021)] else { throw NativeFailure.invalidRecord }
        }
        result = ["small": LinkBytes.hex(try NativePaddingWire.cell(LinkBytes.unhex(payload, maximum: 1021))), "largeDummyHash": LinkBytes.hex(LinkBytes.hash(try NativePaddingWire.cell(Data(), large: true)))]
    case "pairingQr":
        guard let vector = input["pairingQr"] as? [String: Any], let payload = vector["payload"] as? String, let encoded = vector["encoded"] as? String,
              let invalid = vector["invalid"] as? [[String: Any]] else { throw NativeFailure.invalidRecord }
        let qr = try PairingInvitation.parse(payload, now: Date(timeIntervalSince1970: (vector["expiresAt"] as? NSNumber)?.doubleValue ?? 0).addingTimeInterval(-60)), decoded = try PairingInvitation.decode(LinkBytes.unhex(encoded))
        var rejected = 0
        for item in invalid {
            do { _ = try PairingInvitation.decode(LinkBytes.unhex(item["encoded"] as? String ?? "")) } catch { rejected += 1 }
        }
        var oldRefused = false, foreignRefused = false, expired = false, linkRefused = false, longRefused = false, publicRefused = false
        do { _ = try PairingInvitation.parse(payload, now: Date(timeIntervalSince1970: 0)) } catch { longRefused = (error as? NativeFailure) == .invalidRecord }
        if let bytes = try? LinkBytes.unhex(input["publicAddress"] as? String ?? "") {
            do { _ = try PairingInvitation.parse("LATCHPAIR2." + LinkBytes.base64url(bytes), now: Date(timeIntervalSince1970: (vector["expiresAt"] as? NSNumber)?.doubleValue ?? 0).addingTimeInterval(-60)) }
            catch { publicRefused = (error as? NativeFailure) == .invalidRecord }
        }
        do { _ = try PairingInvitation.parse("LATCHPAIR1." + payload.dropFirst(11)) } catch { oldRefused = (error as? NativePairingFailure) == .hostTooOld }
        do { _ = try PairingInvitation.parse("https://example.com/") } catch { foreignRefused = (error as? NativeFailure) == .invalidRecord }
        do { _ = try PairingInvitation.parse(payload, now: Date(timeIntervalSince1970: 2_000_000_000)) } catch { expired = (error as? NativePairingFailure) == .expired }
        do { _ = try PairingInvitation.parse("https://latch.invalid/pair#2." + payload.dropFirst(11)) } catch { linkRefused = (error as? NativeFailure) == .invalidRecord }
        result = ["rootSpki": LinkBytes.hex(qr.rootSpki), "secret": LinkBytes.hex(qr.secret), "expiresAt": qr.expiresAt.timeIntervalSince1970,
            "lan": qr.lan.map { ["address": $0.host, "port": Int($0.port)] }, "code": decoded.invitation, "knockKey": LinkBytes.hex(decoded.knockKey),
            "rejected": rejected, "oldRefused": oldRefused, "foreignRefused": foreignRefused, "expired": expired, "linkRefused": linkRefused, "longRefused": longRefused, "publicRefused": publicRefused,
            "recognized": PairingInvitation.recognizes(payload), "foreignRecognized": PairingInvitation.recognizes("https://example.com/")]
    case "pairingGateway":
        guard let rows = input["interfaces"] as? [[String: String]], let routers = input["routers"] as? [String], let peer = input["peer"] as? String else { throw NativeFailure.invalidRecord }
        let hash = NativeDiscoveryWire.pairingGatewayHash(peer: peer, interfaces: try rows.map { (address: $0["address"] ?? "", mask: try LinkBytes.unhex($0["mask"] ?? "")) }, routers: routers)
        result["hash"] = hash.map { LinkBytes.hex($0) }
    case "nativeRelayLifecycle", "nativeRelayTransferNormal", "nativeRelayTransferAfterCancel", "nativeRelayBulkNormal", "nativeRelayBulkLegacy", "nativeRelayBulkReauthenticate", "nativeRelayBulkAfterCancel", "nativeRelayBulkCancel", "nativeRelayBulkEarlyCancel", "nativeDirectTransfer":
        stage = "relay-pairing"
        let invitation = try PairingInvitation.parse(input["payload"] as? String ?? "", privateOnly: false), keys = try FixtureKeys()
        let anchor = try LinkBytes.unhex(input["trustAnchor"] as? String ?? "")
        let direct = input["operation"] as? String == "nativeDirectTransfer"
        let pairing = try NativePairing(invitation: invitation, keys: keys)
        // Pairing happens on the LAN listener only; the relay is what the paired phone dials afterwards.
        guard let location = invitation.lan.first else { throw NativeFailure.invalidRecord }
        let temporary = try await NativeHTTPConnection.open(host: location.host, port: location.port, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey)
        stage = "relay-begin"
        _ = try await pairing.begin(on: temporary, name: "Swift relay fixture", gatewayHash: Data(repeating: 0, count: 32))
        stage = "relay-approve"
        var approved = false
        for _ in 0..<60 {
            if let status = try await pairing.status(on: temporary), status.status == "approved" { approved = true; break }
            try await Task.sleep(for: .milliseconds(50))
        }
        guard approved else { throw NativeFailure.unavailable }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-relay-fixture-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: invitation.hostId), persisted = FixtureCounter()
        stage = "relay-complete"
        let device = try await pairing.complete(on: temporary) { value in
            try await vault.storeMetadata(JSONEncoder().encode(value), name: "device"); await persisted.increment()
        }
        guard await persisted.value == 1, device.signedAddressBook.utf8.count > 16_384 else { throw NativeFailure.storageUnavailable }
        await temporary.close()
        let now = UInt64(Date().timeIntervalSince1970 * 1000)
        let book = try AddressBookCodec.verify(device.signedAddressBook, rootSpki: device.rootSpki, deviceId: device.deviceId, nowMs: now)
        guard let endpoint = book.relays.first else { throw NativeFailure.invalidRecord }
        var usable: NativeRelayPass?
        for pass in endpoint.passes {
            let value = try AdmissionPass.decode(pass.bytes)
            if value.notBefore <= now / 1000, value.notAfter > now / 1000 { usable = pass; break }
        }
        guard let admission = usable else { throw NativeFailure.expired }
        let dial: @Sendable () async throws -> NativeHTTPConnection = {
            if direct {
                return try await NativeHTTPConnection.open(host: location.host, port: location.port, rootSpki: device.rootSpki,
                    knockKey: device.knockKey, identity: keys.identity())
            }
            return try await NativeHTTPConnection.relay(endpoint: endpoint, admission: admission, rootSpki: device.rootSpki,
                knockKey: device.knockKey, identity: keys.identity(), trustAnchor: anchor)
        }
        stage = "relay-pairing-refused"
        // The same QR knock, still valid on the LAN, opens nothing over the relay.
        var relayPairingRefused = false
        do {
            let refused = try await NativeHTTPConnection.relay(endpoint: endpoint, admission: admission, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey, trustAnchor: anchor)
            await refused.close()
        } catch { relayPairingRefused = true }
        guard relayPairingRefused else { throw NativeFailure.identityMismatch }
        stage = "relay-mtls"
        let workspace = try NativeWorkspace(device: device, keys: keys, vault: vault)
        let review = try await workspace.install(dial)
        guard review["device"]["status"].string == "active", review["device"]["dataScope"].string == "all",
              review["device"]["scopes"].array == [.string("view"), .string("run"), .string("approve:standard"), .string("approve:elevated")] else { throw NativeFailure.identityMismatch }
        var requiresWindow = false
        do { _ = try await workspace.events() } catch { requiresWindow = (error as? NativeFailure) == .expired }
        guard requiresWindow else { throw NativeFailure.identityMismatch }
        stage = "relay-unlock"
        let lease = try await workspace.verify()
        try await vault.storeBody(Data("relay private body".utf8), name: "body", lease: lease)
        stage = "relay-write"
        let create = try NativePendingWrite(method: .post, path: "/link/api/tasks",
            fields: ["prompt": .string("Swift relay fixture `notes.txt`")], requestId: input["requestId"] as? String ?? "")
        _ = try await workspace.submit(create)
        let snapshot = try await workspace.snapshot()
        guard let taskId = snapshot["tasks"].array.first?["id"].string,
              let runId = snapshot["tasks"].array.first?["runId"].string,
              try await workspace.pendingWrites().isEmpty else { throw NativeFailure.invalidRecord }
        stage = "relay-file"
        let files = try await workspace.resolveFile(sessionId: taskId, reference: "notes.txt", rootId: nil)
        guard let file = files["files"].array.first?["file"], let handle = file["handle"].string,
              let etag = file["etag"].string, let count = file["size"].integer,
              try await workspace.fileBytes(handle: handle, etag: etag, offset: 0, count: Int(count)) == Data("Swift relay file fixture".utf8) else { throw NativeFailure.invalidRecord }
        let bulk = direct || (input["operation"] as? String ?? "").hasPrefix("nativeRelayTransfer") || (input["operation"] as? String ?? "").hasPrefix("nativeRelayBulk")
        let companion = (input["operation"] as? String ?? "").hasPrefix("nativeRelayBulk")
        let afterCancel = (input["operation"] as? String ?? "").hasSuffix("AfterCancel")
        if bulk && !afterCancel {
            stage = "relay-large-file"
            let large = try await workspace.resolveFile(sessionId: taskId, reference: "large.txt", rootId: nil)
            guard let file = large["files"].array.first?["file"], let handle = file["handle"].string,
                  let etag = file["etag"].string, file["size"].integer == 1_048_576 else { throw NativeFailure.invalidRecord }
            try await Task.sleep(for: .milliseconds(5250))
            let timing = FixtureTransfer()
            if input["operation"] as? String == "nativeRelayBulkReauthenticate" {
                let reading = Task { try await workspace.fileBytes(handle: handle, etag: etag, offset: 0, count: 1_048_576,
                    explicitOpen: true, progress: timing.progress) }
                while !timing.hasProgress { try await Task.sleep(for: .milliseconds(5)) }
                let otherDirectory = directory.deletingLastPathComponent().appendingPathComponent("latch-swift-other-opening-" + UUID().uuidString)
                defer { try? FileManager.default.removeItem(at: otherDirectory) }
                let otherVault = try EncryptedVault(directory: otherDirectory, key: LinkBytes.random(32), binding: invitation.hostId)
                let other = try NativeWorkspace(device: device, keys: keys, vault: otherVault)
                stage = "relay-bulk-other-open"
                _ = try await other.install(dial); _ = try await other.verify()
                var blocked = false
                do { _ = try await reading.value } catch { blocked = true }
                guard blocked, await workspace.verifiedRevocation() == nil, await keys.verificationCalls.value == 2 else { throw NativeFailure.invalidRecord }
                stage = "relay-bulk-restored"
                _ = try await workspace.install(dial)
                guard await keys.verificationCalls.value == 2, await workspace.lease() == nil else { throw NativeFailure.invalidRecord }
                stage = "relay-bulk-explicit-unlock"
                _ = try await workspace.verify()
                guard await keys.verificationCalls.value == 3 else { throw NativeFailure.invalidRecord }
                guard try await workspace.fileBytes(handle: handle, etag: etag, offset: 0, count: 1_048_576, explicitOpen: true) == Data(repeating: 120, count: 1_048_576) else { throw NativeFailure.invalidRecord }
                result = ["supersededReadDenied": true, "reconnectDidNotSign": true, "explicitUnlockRetried": true, "signatures": 3]
                await other.closeOpening(); await workspace.closeOpening(); break
            }
            if ["nativeRelayBulkCancel", "nativeRelayBulkEarlyCancel"].contains(input["operation"] as? String ?? "") {
                let early = input["operation"] as? String == "nativeRelayBulkEarlyCancel"
                let reading = Task { try await workspace.fileBytes(handle: handle, etag: etag, offset: 0, count: 1_048_576,
                    explicitOpen: true, progress: timing.progress) }
                if early {
                    try await Task.sleep(for: .milliseconds(25))
                    guard !timing.hasProgress else { throw NativeFailure.invalidRecord }
                } else { while !timing.hasProgress { try await Task.sleep(for: .milliseconds(5)) } }
                let cancelledAt = ProcessInfo.processInfo.systemUptime
                reading.cancel()
                var cancelled = false
                do { _ = try await reading.value } catch { cancelled = error is CancellationError }
                let cancelMs = (ProcessInfo.processInfo.systemUptime - cancelledAt) * 1000
                guard cancelled, await workspace.lease()?.valid == true else { throw NativeFailure.invalidRecord }
                let retry = try await workspace.fileBytes(handle: handle, etag: etag, offset: 0, count: 1_048_576, explicitOpen: true)
                guard retry == Data(repeating: 120, count: 1_048_576), await keys.verificationCalls.value == 1 else { throw NativeFailure.invalidRecord }
                result = ["cancelled": true, "cancelMs": cancelMs, "retried": true, "identityKept": true]
                try await Task.sleep(for: .seconds(5)); await workspace.closeOpening(); break
            }
            guard try await workspace.fileBytes(handle: handle, etag: etag, offset: 0, count: 1_048_576, explicitOpen: companion, progress: timing.progress) == Data(repeating: 120, count: 1_048_576) else { throw NativeFailure.invalidRecord }
            result = try timing.result(); result["bulk"] = true; result["direct"] = direct; result["afterCancel"] = false; result["bytes"] = 1_048_576
            if companion { try await Task.sleep(for: .seconds(5)) }
            await workspace.closeOpening(); break
        }
        _ = try await workspace.freeAction(path: "/link/api/tasks/" + taskId + "/cancel",
            fields: ["runId": .string(runId), "requestId": .string(UUID().uuidString)])
        if bulk && afterCancel {
            stage = "relay-large-file-after-cancel"
            let large = try await workspace.resolveFile(sessionId: taskId, reference: "large.txt", rootId: nil)
            guard let file = large["files"].array.first?["file"], let handle = file["handle"].string,
                  let etag = file["etag"].string, file["size"].integer == 1_048_576 else { throw NativeFailure.invalidRecord }
            let timing = FixtureTransfer()
            guard try await workspace.fileBytes(handle: handle, etag: etag, offset: 0, count: 1_048_576, explicitOpen: companion, progress: timing.progress) == Data(repeating: 120, count: 1_048_576) else { throw NativeFailure.invalidRecord }
            result = try timing.result(); result["bulk"] = true; result["direct"] = direct; result["afterCancel"] = true; result["bytes"] = 1_048_576
            if companion { try await Task.sleep(for: .seconds(5)) }
            await workspace.closeOpening(); break
        }
        stage = "relay-events"
        let stream = try await workspace.events(sessionId: taskId)
        var applied = false
        for try await event in stream.events {
            guard try await workspace.accepts(event, from: stream, sessionId: taskId) else { continue }
            let detail = try await workspace.detail(taskId)
            guard let revision = detail["sync"]["revision"].integer else { throw NativeFailure.invalidRecord }
            try await workspace.acknowledge(event, from: stream, sessionId: taskId, appliedRevision: revision)
            applied = true; break
        }
        guard applied else { throw NativeFailure.invalidRecord }; await stream.cancel()
        _ = try await workspace.submit(NativePendingWrite(method: .patch, path: "/link/api/tasks/" + taskId,
            fields: ["title": .string("Relay replay fixture")]))
        try await Task.sleep(for: .milliseconds(100))
        stage = "relay-reconnect"
        let reconnected = try await workspace.install(dial)
        guard reconnected["device"]["id"].string == device.deviceId, await workspace.lease()?.valid == true,
              await keys.verificationCalls.value == 1 else { throw NativeFailure.identityMismatch }
        stage = "relay-replay"
        let replay = try await workspace.events(sessionId: taskId)
        var replayed = false
        for try await event in replay.events {
            guard try await workspace.accepts(event, from: replay, sessionId: taskId), event.type == "task-state" else { continue }
            let value = try NativeJSON.decode(event.data)
            guard value["detail"]["summary"]["title"].string == "Relay replay fixture" else { continue }
            let detail = try await workspace.detail(taskId)
            guard let revision = detail["sync"]["revision"].integer else { throw NativeFailure.invalidRecord }
            try await workspace.acknowledge(event, from: replay, sessionId: taskId, appliedRevision: revision)
            replayed = true; break
        }
        guard replayed else { throw NativeFailure.invalidRecord }; await replay.cancel()
        stage = "relay-revocation"
        _ = try? await workspace.submit(NativePendingWrite(method: .delete, path: "/link/api/devices/current", fields: [:]))
        var revoked = false
        do { _ = try await workspace.install(dial) } catch { revoked = (error as? NativeFailure) == .revoked }
        guard revoked, await workspace.verifiedRevocation() != nil, !lease.valid else { throw NativeFailure.identityMismatch }
        var closedBody = false
        do { _ = try await vault.body(name: "body", lease: lease) } catch { closedBody = true }
        guard closedBody else { throw NativeFailure.identityMismatch }
        await workspace.closeOpening()
        result = ["paired": true, "persistedBeforeComplete": true, "mutualTLS": true, "requiresWindow": true,
            "verified": true, "relayPairingRefused": true, "created": true, "files": true, "events": true, "resumedWithoutSigning": true,
            "replayedAfterReconnect": true, "rootRevocationClosedLease": true]
    case "nativeLeaseExpiry":
        stage = "recovered-expiry"
        let root = try LinkBytes.unhex(input["rootSpki"] as? String ?? ""), knock = try LinkBytes.unhex(input["knockKey"] as? String ?? "")
        let port = try fixturePort(input), keys = try FixtureKeys()
        let first = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: root, knockKey: knock)
        let verifier = NativeVerification(hostId: LinkBytes.base32(LinkBytes.hash(root)), deviceId: "dev_" + LinkBytes.base64url(Data(repeating: 0, count: 16)))
        var unknown = false
        do { _ = try await verifier.verify(on: first) { try await keys.signVerification($0) } }
        catch { unknown = (error as? NativeFailure) == .resultUnknown }
        guard unknown, await verifier.currentLease() == nil else { throw NativeFailure.invalidRecord }; await first.close()
        let second = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: root, knockKey: knock)
        let rejectRecovery = input["rejectRecovery"] as? Bool == true
        let restored = input["directRecovery"] as? Bool == true ? false : try await verifier.restore(on: second)
        if rejectRecovery {
            guard !restored, await verifier.currentLease() == nil, await keys.verificationCalls.value == 1 else { throw NativeFailure.identityMismatch }
            _ = try await verifier.verify(on: second) { try await keys.signVerification($0) }
        } else { guard restored else { throw NativeFailure.identityMismatch } }
        guard let lease = await verifier.currentLease(), await keys.verificationCalls.value == (rejectRecovery ? 2 : 1) else { throw NativeFailure.identityMismatch }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-expiry-fixture-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: "expiry")
        try await vault.storeBody(Data("private expiring body".utf8), name: "body", lease: lease)
        let start = ContinuousClock.now
        let waiting = Task { try await lease.waitForInvalidation() }
        let cancelled = Task { try await lease.waitForInvalidation() }; cancelled.cancel()
        var cancellation = false
        do { try await cancelled.value } catch { cancellation = error is CancellationError }
        try await Task.sleep(for: .milliseconds(50))
        let rebound = Task { try await lease.waitForInvalidation() }
        try await waiting.value; try await rebound.value
        guard cancellation, !lease.valid, start.duration(to: .now) < .seconds(3) else { throw NativeFailure.invalidRecord }
        var cacheClosed = false
        do { _ = try await vault.body(name: "body", lease: lease) } catch { cacheClosed = true }
        guard cacheClosed else { throw NativeFailure.identityMismatch }
        await verifier.closeOpening(); await second.close(); await vault.lock()
        result = ["recoveredWithoutSigning": !rejectRecovery, "rejectedRecoveryReverified": rejectRecovery, "expiredWithoutNetwork": true, "reboundObserverDidNotExtend": true,
            "cancelledObserverSettled": true, "cacheClosed": true]
    case "nativeProbe":
        let identity = input["withFixtureIdentity"] as? Bool == true ? try FixtureKeys().identity() : nil
        let connection = try await NativeHTTPConnection.open(host: "127.0.0.1", port: fixturePort(input), rootSpki: LinkBytes.unhex(input["rootSpki"] as? String ?? ""), knockKey: LinkBytes.unhex(input["knockKey"] as? String ?? ""), identity: identity)
        let response = try await connection.request(.get, path: "/link/api/snapshot")
        await connection.close()
        result["status"] = response.status
    case "nativePair":
        stage = "parse-pairing"
        let invitation = try PairingInvitation.parse(input["payload"] as? String ?? "", privateOnly: false), port = try fixturePort(input)
        let keys = try FixtureKeys(), pairing = try NativePairing(invitation: invitation, keys: keys)
        let temporary = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey)
        stage = "begin-pairing"
        _ = try await pairing.begin(on: temporary, name: "Swift fixture", gatewayHash: Data(repeating: 0, count: 32))
        stage = "wait-pairing"
        var approved = false
        for _ in 0..<60 {
            if let enrollment = try await pairing.status(on: temporary), enrollment.status == "approved" { approved = true; break }
            try await Task.sleep(for: .milliseconds(50))
        }
        guard approved else { throw NativeFailure.unavailable }
        stage = "create-vault"
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-fixture-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: invitation.hostId)
        let persisted = FixtureCounter()
        stage = "complete-pairing"
        let device = try await pairing.complete(on: temporary) { device in
            try await vault.storeMetadata(JSONEncoder().encode(device), name: "device")
            await persisted.increment()
        }
        guard await persisted.value == 1, let stored = try await vault.metadata(name: "device"),
            try JSONDecoder().decode(PreparedNativeDevice.self, from: stored).deviceId == device.deviceId else { throw NativeFailure.storageUnavailable }
        await temporary.close()
        stage = "mtls"
        let connection = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki,
            knockKey: device.knockKey, identity: keys.identity())
        stage = "expired-leaf"
        let expiredCertificate = try P256Certificate.create(spki: keys.connectionSpki, now: Date().addingTimeInterval(-7200), lifetime: 3600) {
            try SecureDeviceKeys.signDER(keys.connection, $0)
        }
        let expiredIdentity = try PlatformIdentity(key: keys.connection, certificate: expiredCertificate)
        var expiredLeafRejected = false
        do {
            let expired = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki,
                knockKey: device.knockKey, identity: expiredIdentity)
            await expired.close()
        } catch { expiredLeafRejected = true }
        guard expiredLeafRejected else { throw NativeFailure.identityMismatch }
        let verifier = NativeVerification(hostId: device.hostId, deviceId: device.deviceId), signed = FixtureCounter()
        stage = "verify"
        let lease = try await verifier.verify(on: connection) { statement in
            await signed.increment(); return try await keys.signVerification(statement)
        }
        _ = try await verifier.verify(on: connection) { statement in
            await signed.increment(); return try await keys.signVerification(statement)
        }
        stage = "body-cache"
        try await vault.storeBody(Data("private cached body".utf8), name: "detail", lease: lease)
        guard try await vault.body(name: "detail", lease: lease) == Data("private cached body".utf8) else { throw NativeFailure.storageUnavailable }
        stage = "create-task"
        let task = try JSONSerialization.data(withJSONObject: ["prompt": "Swift native fixture `notes.txt`", "requestId": input["requestId"] as? String ?? ""])
        let created = try await connection.request(.post, path: "/link/api/tasks", body: task)
        guard created.status == 201 else { throw NativeFailure.unavailable }
        stage = "reconnect"
        let replacement = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki,
            knockKey: device.knockKey, identity: keys.identity())
        stage = "resume"
        let restored = try await verifier.restore(on: replacement)
        stage = restored ? "resume-sign-count" : "resume-false"
        guard restored, await signed.value == 1 else { throw NativeFailure.identityMismatch }
        await verifier.closeOpening()
        var denied = false
        do { _ = try await vault.body(name: "detail", lease: lease) } catch { denied = true }
        guard denied else { throw NativeFailure.identityMismatch }
        stage = "workspace"
        let workspace = try NativeWorkspace(device: device, keys: keys, vault: vault)
        _ = try await workspace.install {
            try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki,
                knockKey: device.knockKey, identity: keys.identity())
        }
        guard let cachedList = try await workspace.cachedSnapshot(), cachedList["device"]["id"].string == device.deviceId,
              cachedList["approvals"].array.isEmpty, cachedList["questions"] == .null, cachedList["queue"] == .null else { throw NativeFailure.storageUnavailable }
        let bookCalls = FixtureCounter(), bookGate = FixtureBookGate()
        let bookOwner = NativeBookRefresher(workspace: workspace, persist: { refreshed in
            await bookCalls.increment(); try await bookGate.wait()
            try await vault.storeMetadata(JSONEncoder().encode(refreshed), name: "device")
        })
        await bookOwner.observe(nil, force: true)
        try await Task.sleep(for: .milliseconds(50))
        guard await bookCalls.value == 0 else { throw NativeFailure.identityMismatch }
        var streamRequiresWindow = false
        do { _ = try await workspace.events() }
        catch { streamRequiresWindow = (error as? NativeFailure) == .expired }
        guard streamRequiresWindow else { throw NativeFailure.identityMismatch }
        guard await workspace.noteProximity(gatewayHash: Data(repeating: 0, count: 32)) == false else { throw NativeFailure.identityMismatch }
        _ = try await workspace.verify()
        guard await workspace.noteProximity(gatewayHash: Data(repeating: 0, count: 32)) == false,
              await workspace.lease()?.valid == true else { throw NativeFailure.identityMismatch }
        stage = "refresh-book"
        let updated = try await workspace.refreshAddressBook { refreshed in
            try await vault.storeMetadata(JSONEncoder().encode(refreshed), name: "device")
        }
        guard updated.deviceId == device.deviceId, updated.bookGeneration >= device.bookGeneration,
              let saved = try await vault.metadata(name: "device"),
              try JSONDecoder().decode(PreparedNativeDevice.self, from: saved).bookHash == updated.bookHash else { throw NativeFailure.storageUnavailable }
        stage = "path-fallback"
        let paths = NativePathOwner()
        let faultPort = try fixturePort(["port": input["faultPort"] ?? 0])
        let unavailable = try NativePathCandidate(id: "failed", kind: .direct) {
            return try await NativeHTTPConnection.open(host: "127.0.0.1", port: faultPort, rootSpki: device.rootSpki,
                knockKey: device.knockKey, identity: keys.identity())
        }
        let candidate = try NativePathCandidate(id: "fixture", kind: .direct) {
            try await Task.sleep(for: .milliseconds(200))
            return try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki,
                knockKey: device.knockKey, identity: keys.identity())
        }
        let snapshot = try await paths.migrate([unavailable, candidate], workspace: workspace)
        let discoveryEpoch = try await workspace.discoveryEpoch()
        guard snapshot["host"]["native"]["discoveryEpoch"].string == discoveryEpoch else { throw NativeFailure.identityMismatch }
        _ = try await workspace.refreshAddressBook { refreshed in
            try await vault.storeMetadata(JSONEncoder().encode(refreshed), name: "device")
        }
        guard try await workspace.discoveryEpoch() == discoveryEpoch else { throw NativeFailure.identityMismatch }
        stage = "coalesced-book"
        await bookOwner.observe(discoveryEpoch, force: true)
        for _ in 0..<100 { if await bookGate.waiting { break }; try await Task.sleep(for: .milliseconds(10)) }
        guard await bookGate.waiting else { throw NativeFailure.unavailable }
        for _ in 0..<20 { await bookOwner.observe(discoveryEpoch) }
        await bookGate.release(); try await Task.sleep(for: .milliseconds(100))
        guard await bookCalls.value == 1 else { throw NativeFailure.invalidRecord }
        let untrustedHint = discoveryEpoch == String(repeating: "0", count: 64) ? String(repeating: "1", count: 64) : String(repeating: "0", count: 64)
        await bookOwner.observe(untrustedHint)
        for _ in 0..<100 { if await bookCalls.value == 2 { break }; try await Task.sleep(for: .milliseconds(10)) }
        for _ in 0..<20 { await bookOwner.observe(untrustedHint) }
        try await Task.sleep(for: .milliseconds(100))
        guard await bookCalls.value == 2, try await workspace.discoveryEpoch() == discoveryEpoch else { throw NativeFailure.identityMismatch }
        await bookGate.reset()
        let nextHint = String(repeating: "2", count: 64), latestHint = String(repeating: "3", count: 64)
        await bookOwner.observe(nextHint)
        for _ in 0..<100 { if await bookGate.waiting { break }; try await Task.sleep(for: .milliseconds(10)) }
        guard await bookGate.waiting else { throw NativeFailure.unavailable }
        for _ in 0..<20 { await bookOwner.observe(latestHint) }
        await bookGate.release()
        for _ in 0..<100 { if await bookCalls.value == 4 { break }; try await Task.sleep(for: .milliseconds(10)) }
        guard await bookCalls.value == 4 else { throw NativeFailure.invalidRecord }
        await bookOwner.connectionChanged(); await bookOwner.observe(latestHint)
        for _ in 0..<100 { if await bookCalls.value == 5 { break }; try await Task.sleep(for: .milliseconds(10)) }
        try await Task.sleep(for: .milliseconds(100))
        guard await bookCalls.value == 5 else { throw NativeFailure.invalidRecord }
        let directoryEpoch = try await workspace.directoryEpoch()
        guard snapshot["host"]["native"]["directoryEpoch"].string == directoryEpoch else { throw NativeFailure.identityMismatch }
        let directoryHint = String(repeating: "f", count: 64)
        await bookOwner.observe(discoveryEpoch, directoryHint: directoryHint)
        for _ in 0..<100 { if await bookCalls.value == 6 { break }; try await Task.sleep(for: .milliseconds(10)) }
        for _ in 0..<20 { await bookOwner.observe(discoveryEpoch, directoryHint: directoryHint) }
        try await Task.sleep(for: .milliseconds(100))
        guard await bookCalls.value == 6, try await workspace.directoryEpoch() == directoryEpoch else { throw NativeFailure.identityMismatch }
        await bookOwner.close()
        let delayedGate = FixtureBookGate(), staleUpdates = FixtureCounter()
        let delayed = NativeBookRefresher(workspace: workspace, persist: { _ in try await delayedGate.wait() },
            updated: { _ in await staleUpdates.increment() })
        await delayed.observe(nil, force: true)
        for _ in 0..<100 { if await delayedGate.waiting { break }; try await Task.sleep(for: .milliseconds(10)) }
        guard await delayedGate.waiting else { throw NativeFailure.unavailable }
        await delayed.close()
        guard await staleUpdates.value == 0 else { throw NativeFailure.identityMismatch }
        guard let taskId = snapshot["tasks"].array.first?["id"].string,
              let runId = snapshot["tasks"].array.first?["runId"].string else { throw NativeFailure.invalidRecord }
        _ = try await workspace.freeAction(path: "/link/api/tasks/\(taskId)/cancel", fields: ["requestId": .string(UUID().uuidString), "runId": .string(runId)])
        guard try await workspace.pendingControl() == nil else { throw NativeFailure.storageUnavailable }
        _ = try await workspace.verify()
        let rename = try NativePendingWrite(method: .patch, path: "/link/api/tasks/" + taskId, fields: ["title": .string("Swift fixture")])
        _ = try await workspace.submit(rename)
        guard try await workspace.pendingWrites().isEmpty else { throw NativeFailure.storageUnavailable }
        let files = try await workspace.resolveFile(sessionId: taskId, reference: "notes.txt", rootId: nil)
        guard let file = files["files"].array.first?["file"], let handle = file["handle"].string,
              let etag = file["etag"].string, let count = file["size"].integer,
              try await workspace.fileBytes(handle: handle, etag: etag, offset: 0, count: Int(count)) == Data("Swift file fixture".utf8) else { throw NativeFailure.invalidRecord }
        let detail = try await workspace.detail(taskId)
        guard detail["summary"]["id"].string == taskId else { throw NativeFailure.identityMismatch }
        let events = try await workspace.events(sessionId: taskId)
        var streamed = false
        for try await event in events.events {
            streamed = try await workspace.accepts(event, from: events, sessionId: taskId)
            guard streamed else { continue }
            let applied = try await workspace.detail(taskId)
            guard let revision = applied["sync"]["revision"].integer else { throw NativeFailure.invalidRecord }
            try await workspace.acknowledge(event, from: events, sessionId: taskId, appliedRevision: revision)
            break
        }
        guard streamed else { throw NativeFailure.invalidRecord }
        await events.cancel()
        stage = "offline-event"
        let offlineRename = try NativePendingWrite(method: .patch, path: "/link/api/tasks/" + taskId, fields: ["title": .string("Replayed fixture")])
        _ = try await workspace.submit(offlineRename)
        try await Task.sleep(for: .milliseconds(100))
        stage = "offline-rename"
        // Advancing the list checkpoint must not acknowledge the private session event.
        _ = try await workspace.submit(NativePendingWrite(method: .patch, path: "/link/api/devices/current", fields: ["name": .string("Swift fixture renamed")]))
        try await Task.sleep(for: .milliseconds(100))
        stage = "offline-snapshot"
        let newerMetadata = try await workspace.snapshot()
        stage = "open-replay"
        let replay = try await workspace.events(sessionId: taskId)
        var replayed = false
        for try await event in replay.events {
            stage = "read-replay"
            guard try await workspace.accepts(event, from: replay, sessionId: taskId) else { continue }
            guard event.type == "task-state" else { continue }
            let value = try NativeJSON.decode(event.data)
            if value["detail"]["summary"]["title"].string == "Replayed fixture" {
                guard let eventRevision = value["revision"].integer,
                      eventRevision < (newerMetadata["revision"].integer ?? 0) else { throw NativeFailure.invalidRecord }
                let applied = try await workspace.detail(taskId)
                guard applied["summary"]["title"].string == "Replayed fixture", let revision = applied["sync"]["revision"].integer else { throw NativeFailure.invalidRecord }
                try await workspace.acknowledge(event, from: replay, sessionId: taskId, appliedRevision: revision)
                replayed = true; break
            }
        }
        guard replayed else { throw NativeFailure.invalidRecord }; await replay.cancel()
        stage = "signed-revocation"
        let oldWindow = await workspace.lease()
        let revoke = try NativePendingWrite(method: .delete, path: "/link/api/devices/current", fields: [:])
        // The Host may close the revoked connection before returning its receipt.
        _ = try? await workspace.submit(revoke)
        var retired = false
        do {
            _ = try await workspace.install {
                try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki,
                    knockKey: device.knockKey, identity: keys.identity())
            }
        } catch { retired = (error as? NativeFailure) == .revoked }
        guard retired, await workspace.verifiedRevocation() != nil, oldWindow?.valid == false else { throw NativeFailure.identityMismatch }
        await workspace.closeOpening()
        result = ["paired": true, "verified": true, "created": true, "persistedBeforeComplete": true, "bookRefreshed": true, "bookRefreshCoalesced": true, "epochHintUntrusted": true, "resumedWithoutSigning": true, "oldLeaseClosed": true, "workspace": true, "events": true, "streamRequiresWindow": true, "replayedAfterMetadata": true, "rootRevocationClosedLease": true, "files": true, "pendingCleared": true, "freeCancel": true, "fallbackAfterHandshake": true, "fallbackAfterResumeFailure": true, "expiredLeafRejected": true]
        await connection.close(); await replacement.close()
    case "profiles":
        stage = "profiles"
        let directory = URL(fileURLWithPath: input["directory"] as? String ?? "", isDirectory: true)
        let key = try LinkBytes.fixed(LinkBytes.unhex(input["key"] as? String ?? ""), 32)
        let profiles = try JSONDecoder().decode([NativeRegisteredHost].self, from: JSONSerialization.data(withJSONObject: input["profiles"] ?? []))
        guard profiles.count == 2, profiles[0].device.deviceId == profiles[1].device.deviceId,
              profiles[0].id != profiles[1].id else { throw NativeFailure.invalidRecord }
        let erased = FixtureCounter()
        let first = try await NativeProfileStore.open(directory: directory, key: key, eraseKeys: { _ in await erased.increment() })
        async let a: Void = first.save(profiles[0])
        async let b: Void = first.save(profiles[1])
        _ = try await (a, b)
        guard await first.list().count == 2 else { throw NativeFailure.storageUnavailable }
        let ciphertext = try Data(contentsOf: directory.appendingPathComponent("profiles/meta-hosts.lcache"))
        for profile in profiles {
            guard ciphertext.range(of: Data(profile.name.utf8)) == nil, ciphertext.range(of: profile.device.knockKey) == nil,
                  ciphertext.range(of: profile.keys.connectionTag) == nil else { throw NativeFailure.storageUnavailable }
        }
        let oldCache = try await first.hostVault(profiles[0])
        try await oldCache.storeMetadata(Data("private profile cache".utf8), name: "sample")
        await first.lock()
        var lockDenied = false
        do { _ = try await oldCache.metadata(name: "sample") } catch { lockDenied = true }
        guard lockDenied, await first.list().isEmpty else { throw NativeFailure.storageUnavailable }
        let store = try await NativeProfileStore.open(directory: directory, key: key, eraseKeys: { _ in await erased.increment() })
        guard await store.list().count == 2 else { throw NativeFailure.storageUnavailable }
        let draft = try JSONDecoder().decode(NativePairingDraft.self, from: JSONSerialization.data(withJSONObject: input["draft"] ?? [:]))
        try await store.saveDraft(draft)
        guard try await store.draft()?.payload == draft.payload else { throw NativeFailure.storageUnavailable }
        var changedDraftDenied = false
        do { try await store.saveDraft(NativePairingDraft(payload: draft.payload, keys: draft.keys, name: "changed")) }
        catch { changedDraftDenied = (error as? NativeFailure) == .resultUnknown }
        guard changedDraftDenied else { throw NativeFailure.storageUnavailable }
        try await store.abandonDraft()
        guard await erased.value == 0 else { throw NativeFailure.identityMismatch }
        let cacheA = try await store.hostVault(profiles[0]), cacheB = try await store.hostVault(profiles[1])
        try await cacheB.storeMetadata(Data("other private cache".utf8), name: "sample")
        let revocation = try NativeJSON.decode(JSONSerialization.data(withJSONObject: input["revocation"] ?? [:]))
        let proof = try VerifiedNativeRevocation.verify(revocation, rootSpki: profiles[0].device.rootSpki,
            hostId: profiles[0].device.hostId, deviceId: profiles[0].device.deviceId)
        var otherDenied = false
        do { try await store.retire(profiles[1], proof: proof) } catch { otherDenied = true }
        guard otherDenied, await erased.value == 0 else { throw NativeFailure.identityMismatch }
        try await store.retire(profiles[0], proof: proof)
        guard await erased.value == 1, await store.list().map(\.id) == [profiles[1].id],
              !FileManager.default.fileExists(atPath: directory.appendingPathComponent("cache").appendingPathComponent(profiles[0].id).path),
              try await cacheB.metadata(name: "sample") == Data("other private cache".utf8) else { throw NativeFailure.storageUnavailable }
        var retiredCacheDenied = false
        do { _ = try await cacheA.metadata(name: "sample") } catch { retiredCacheDenied = true }
        guard retiredCacheDenied else { throw NativeFailure.storageUnavailable }
        await store.lock()
        let reopened = try await NativeProfileStore.open(directory: directory, key: key, eraseKeys: { _ in await erased.increment() })
        guard await reopened.list().map(\.id) == [profiles[1].id] else { throw NativeFailure.storageUnavailable }
        await reopened.lock()
        let secondNotice = try NativeJSON.decode(JSONSerialization.data(withJSONObject: input["secondRevocation"] ?? [:]))
        let secondProof = try VerifiedNativeRevocation.verify(secondNotice, rootSpki: profiles[1].device.rootSpki,
            hostId: profiles[1].device.hostId, deviceId: profiles[1].device.deviceId)
        let failing = try await NativeProfileStore.open(directory: directory, key: key, eraseKeys: { _ in
            await erased.increment(); throw NativeFailure.storageUnavailable
        })
        var cleanupUnknown = false
        do { try await failing.retire(profiles[1], proof: secondProof) }
        catch { cleanupUnknown = (error as? NativeFailure) == .storageUnavailable }
        guard cleanupUnknown, await failing.list().isEmpty, await erased.value == 2 else { throw NativeFailure.storageUnavailable }
        await failing.lock()
        let recovered = try await NativeProfileStore.open(directory: directory, key: key, eraseKeys: { _ in await erased.increment() })
        guard await recovered.list().isEmpty, await erased.value == 3 else { throw NativeFailure.storageUnavailable }
        await recovered.lock()
        result = ["sameDeviceIdIsolated": true, "concurrentSave": true, "encryptedRecovery": true, "lockClosedCache": true,
            "immutableDraft": true, "rootBoundRetirement": true, "otherCachePreserved": true, "retirementRetry": true, "ciphertextProtected": true]
    case "discovery":
        let key = try LinkBytes.unhex(input["key"] as? String ?? ""), day = (input["day"] as? NSNumber)?.uint64Value ?? 0
        let names = try NativeDiscoveryWire.names(key: key, day: day)
        var hashes: [String] = []
        for row in input["gateways"] as? [[String: Any]] ?? [] {
            let address = row["address"] as? String ?? "", gateway = row["gateway"] as? String ?? ""
            if let mask = row["mask"] as? String { hashes.append(try LinkBytes.hex(NativeDiscoveryWire.gatewayHash(address: address, mask: LinkBytes.unhex(mask), gateway: gateway))) }
            else { hashes.append(try LinkBytes.hex(NativeDiscoveryWire.gatewayHash(address: address,
                prefix: (row["prefixLength"] as? NSNumber)?.intValue ?? -1, gateway: gateway))) }
        }
        result = ["labels": [names.primary, names.alternate], "hashes": hashes, "epoch": try NativeDiscoveryWire.epoch(key: key)]
    case "revocation":
        let payload = NativeJSON.object(["hostId": .string(input["hostId"] as? String ?? ""), "deviceId": .string(input["deviceId"] as? String ?? ""),
            "revokedAt": .number((input["revokedAt"] as? NSNumber)?.doubleValue ?? -1), "signature": .string(input["signature"] as? String ?? "")])
        let proof = try VerifiedNativeRevocation.verify(payload, rootSpki: LinkBytes.unhex(input["rootSpki"] as? String ?? ""),
            hostId: input["expectedHostId"] as? String ?? input["hostId"] as? String ?? "", deviceId: input["expectedDeviceId"] as? String ?? input["deviceId"] as? String ?? "")
        result = ["verified": true, "tombstoneHash": proof.tombstoneHash]
    case "events":
        var parser = NativeEventParser(), all: [[String: String]] = []
        if input["oversizedLine"] as? Bool == true {
            for _ in 0..<17 { _ = try parser.feed(Data(repeating: 120, count: 65_536)) }
        }
        for item in input["chunks"] as? [String] ?? [] {
            for event in try parser.feed(LinkBytes.unhex(item, maximum: 1_048_576)) {
                guard let data = String(data: event.data, encoding: .utf8) else { throw NativeFailure.invalidRecord }
                var value = ["type": event.type, "data": data]
                if let cursor = event.cursor { value["cursor"] = "\(cursor.epoch):\(cursor.sequence)" }
                all.append(value)
            }
        }
        result["events"] = all
    case "relayFrames":
        var decoder = RelayWire.Decoder(), all: [[String: Any]] = []
        for item in input["chunks"] as? [String] ?? [] {
            for frame in try decoder.feed(LinkBytes.unhex(item, maximum: 65_550)) {
                all.append(["opcode": frame.opcode, "payload": LinkBytes.hex(frame.payload)])
            }
        }
        result["frames"] = all
        if let payload = input["payload"] as? String {
            result["encoded"] = try LinkBytes.hex(RelayWire.frame(opcode: 2, payload: LinkBytes.unhex(payload), mask: LinkBytes.unhex(input["mask"] as? String ?? "")))
        }
    case "addressBook":
        let book = try AddressBookCodec.verify(input["encoded"] as? String ?? "", rootSpki: LinkBytes.unhex(input["rootSpki"] as? String ?? ""),
            deviceId: input["deviceId"] as? String ?? "", nowMs: (input["timeMs"] as? NSNumber)?.uint64Value ?? 0,
            priorGeneration: (input["priorGeneration"] as? NSNumber)?.uint64Value ?? 0,
            priorHash: (input["priorHash"] as? String).map { try LinkBytes.unhex($0) })
        result = ["hostId": book.hostId, "deviceId": book.deviceId, "generation": book.generation, "payloadHash": LinkBytes.hex(book.payloadHash), "relays": book.relays.count]
        if let directory = book.directory { result["directoryAnchors"] = directory.anchors.count }
        if input["profiles"] as? Bool == true { result["profiles"] = book.relays.map { $0.profile?.rawValue ?? "legacy-v1" } }
    case "bookPathChange":
        let root = try LinkBytes.unhex(input["rootSpki"] as? String ?? ""), deviceId = input["deviceId"] as? String ?? ""
        let now = (input["timeMs"] as? NSNumber)?.uint64Value ?? 0
        let previous = try (input["previous"] as? String).map {
            try AddressBookCodec.verify($0, rootSpki: root, deviceId: deviceId, nowMs: now)
        }
        let current = try AddressBookCodec.verify(input["current"] as? String ?? "", rootSpki: root, deviceId: deviceId, nowMs: now)
        result["migrate"] = NativeBookPathChange.requiresMigration(previous: previous, current: current)
    case "relayAdmission":
        let book = try AddressBookCodec.verify(input["encoded"] as? String ?? "", rootSpki: LinkBytes.unhex(input["rootSpki"] as? String ?? ""),
            deviceId: input["deviceId"] as? String ?? "", nowMs: (input["timeMs"] as? NSNumber)?.uint64Value ?? 0)
        guard let endpoint = book.relays.first, let times = input["times"] as? [NSNumber] else { throw NativeFailure.invalidRecord }
        result["selected"] = try times.map { time in
            let selected = try NativeRelayAdmission.current(endpoint: endpoint, bookExpiresAt: book.expiresAt, nowMs: time.uint64Value)
            guard let index = endpoint.passes.firstIndex(where: { $0.bytes == selected.bytes }) else { throw NativeFailure.invalidRecord }
            return index
        }
    case "discoveryKey":
        result["key"] = try LinkBytes.hex(AddressBookCodec.discoveryKey(input["encoded"] as? String ?? "", rootSpki: LinkBytes.unhex(input["rootSpki"] as? String ?? ""),
            deviceId: input["deviceId"] as? String ?? "", nowMs: (input["timeMs"] as? NSNumber)?.uint64Value ?? 0,
            priorGeneration: (input["priorGeneration"] as? NSNumber)?.uint64Value ?? 0, priorHash: LinkBytes.unhex(input["priorHash"] as? String ?? "")))
    case "vault":
        let directory = URL(fileURLWithPath: input["directory"] as? String ?? "", isDirectory: true)
        let key = try LinkBytes.fixed(LinkBytes.unhex(input["key"] as? String ?? ""), 32)
        let vault = try EncryptedVault(directory: directory, key: key, binding: "fixture")
        if let text = input["text"] as? String { try await vault.storeMetadata(Data(text.utf8), name: "item") }
        let value = try await vault.metadata(name: input["name"] as? String ?? "item")
        result = ["matches": value == Data((input["expected"] as? String ?? "").utf8),
            "backupExcluded": try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true]
        await vault.lock()
    case "vectors":
        func bytes(_ text: Any?) throws -> Data { try LinkBytes.unhex(text as? String ?? "invalid") }
        let pairing = input["pairing"] as? [String: Any] ?? [:], verification = input["nativeVerification"] as? [String: Any] ?? [:]
        let route = LinkBytes.hash(Data("latch-route-id-v1\0".utf8) + (try bytes(input["routePub"]))).prefix(16)
        let binding: LinkBinding
        switch input["binding"] as? String {
        case "relay": binding = .relay(id: try bytes(input["relayId"]), route: route)
        case "relay-pad-v2": binding = .relayPaddedV2(id: try bytes(input["relayId"]), route: route)
        default: binding = .direct
        }
        result["knock"] = try LinkBytes.hex(NativeCrypto.knock(key: bytes(input["knockKey"]), binding: binding, timeMs: (input["timeMs"] as? NSNumber)?.uint64Value ?? 0, nonce: bytes(input["nonce"])))
        result["serverBinding"] = try LinkBytes.hex(NativeCrypto.serverBinding(key: bytes(input["knockKey"]), binding: binding, nonce: bytes(input["nonce"]), certificate: Data((input["certificate"] as? String ?? "").utf8)))
        result["knockSecret"] = try LinkBytes.hex(NativeCrypto.knockSecret(invitationHash: bytes(pairing["invitationHash"]), connectionSpki: bytes(pairing["connectionSpki"]), verificationSpki: bytes(pairing["verificationSpki"])))
        let statement = try NativeCrypto.verificationText(hostId: verification["hostId"] as? String ?? "", deviceId: verification["deviceId"] as? String ?? "", nonce: verification["nonce"] as? String ?? "", expiresAt: (verification["expiresAt"] as? NSNumber)?.uint64Value ?? 0, appOpenId: verification["appOpenId"] as? String ?? "")
        result["verificationText"] = statement
        result["recoverySecret"] = try LinkBytes.hex(NativeCrypto.recoverySecret(statement: statement, signature: bytes(verification["signature"])))
        result["verified"] = try NativeCrypto.verifyP256(spki: bytes(verification["verificationSpki"]), input: Data(statement.utf8), signature: bytes(verification["signature"]))
    case "hostProof":
        try NativeCrypto.verifyHostProof(LinkBytes.unhex(input["proof"] as? String ?? ""), rootSpki: LinkBytes.unhex(input["rootSpki"] as? String ?? ""), transportSpki: LinkBytes.unhex(input["transportSpki"] as? String ?? ""), nonce: LinkBytes.unhex(input["nonce"] as? String ?? ""), timeMs: (input["timeMs"] as? NSNumber)?.uint64Value ?? 0)
        result["verified"] = true
    case "reader":
        var reader = try LinkReader(LinkBytes.unhex(input["hex"] as? String ?? ""))
        result["integer"] = try reader.integer((input["size"] as? NSNumber)?.intValue ?? 0)
        try reader.done()
    default:
        let bytes = try LinkBytes.decode64(input["base64url"] as? String ?? "")
        result = ["base64url": LinkBytes.base64url(bytes), "base32": LinkBytes.base32(bytes)]
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
} catch {
    FileHandle.standardError.write(Data("Native fixture rejected the input (\(stage),\((error as? NativeFailure)?.rawValue ?? (error as? FixtureStage)?.name ?? "failure"))\n".utf8))
    exit(1)
}
