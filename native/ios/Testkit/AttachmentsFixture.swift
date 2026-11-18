import CoreGraphics
import Foundation
import ImageIO
import LatchNativeCore
import UniformTypeIdentifiers

/** A JPEG of `width`×`height` noise carrying a GPS position and camera metadata, as a phone photo would. */
func fixturePhoto(width: Int, height: Int, alpha: Bool = false) throws -> Data {
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: alpha ? CGImageAlphaInfo.premultipliedLast.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue),
          let pixels = context.data else { throw NativeFailure.unavailable }
    var seed: UInt32 = 2_463_534_242
    let bytes = pixels.bindMemory(to: UInt8.self, capacity: width * height * 4)
    for index in 0..<(width * height * 4) {
        seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5
        bytes[index] = alpha && index % 4 == 3 ? 128 : UInt8(truncatingIfNeeded: seed)
    }
    guard let image = context.makeImage() else { throw NativeFailure.unavailable }
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, (alpha ? UTType.png : UTType.jpeg).identifier as CFString, 1, nil) else { throw NativeFailure.unavailable }
    CGImageDestinationAddImage(destination, image, [
        kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 35.6812, kCGImagePropertyGPSLatitudeRef: "N",
            kCGImagePropertyGPSLongitude: 139.7671, kCGImagePropertyGPSLongitudeRef: "E"],
        kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: "FixtureCam", kCGImagePropertyTIFFModel: "Location Leaker"],
        kCGImagePropertyExifDictionary: [kCGImagePropertyExifUserComment: "taken at home"],
        kCGImageDestinationLossyCompressionQuality: 0.95,
    ] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw NativeFailure.unavailable }
    return output as Data
}

private func metadataKeys(_ data: Data) -> [String] {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any] else { return ["unreadable"] }
    var found: [String] = []
    if properties[kCGImagePropertyGPSDictionary as String] != nil { found.append("gps") }
    if let tiff = properties[kCGImagePropertyTIFFDictionary as String] as? [String: Any], tiff[kCGImagePropertyTIFFMake as String] != nil { found.append("make") }
    if let exif = properties[kCGImagePropertyExifDictionary as String] as? [String: Any], exif[kCGImagePropertyExifUserComment as String] != nil { found.append("comment") }
    return found
}

/** The composer's attachment decisions: capability reasons, limits, refusal classes, the tray and image re-encoding. */
func phoneAttachmentsFixture(_ input: [String: Any]) throws -> [String: Any] {
    func caps(_ fields: [String: NativeJSON]) -> PhoneAttachCaps? { PhoneAttachCaps.parse(.object(["capabilities": .object(fields)])) }
    let both = caps(["images": .bool(true), "text": .bool(true), "textBytes": .number(262_144), "fileBytes": .number(10_485_760), "imageBytes": .number(5_242_880)])!
    let textOnly = caps(["images": .bool(false), "text": .bool(true), "textBytes": .number(26_214_400), "reason": .string("这个 Harness 不接收图片。")])!
    let none = caps(["images": .bool(false), "text": .bool(false), "textBytes": .number(0), "reason": .string("这个 Harness 不接收图片和文件。")])!
    let started = NativeJSON.object(["status": .string("ready"), "attachmentsReported": .object(["images": .bool(false), "text": .bool(false)])])
    let fresh = NativeJSON.object(["status": .string("ready")])
    var result: [String: Any] = [:]
    result["limits"] = [PhoneAttachments.limitsLine(both), PhoneAttachments.limitsLine(textOnly), PhoneAttachments.limitsLine(none)]
    result["unavailable"] = [
        PhoneAttachments.unavailable(caps: both, harness: fresh, failed: false) ?? "",
        PhoneAttachments.unavailable(caps: none, harness: started, failed: false) ?? "",
        PhoneAttachments.unavailable(caps: nil, harness: started, failed: false) ?? "",
        PhoneAttachments.unavailable(caps: nil, harness: fresh, failed: false) ?? "",
        PhoneAttachments.unavailable(caps: nil, harness: fresh, failed: true) ?? "",
    ]
    result["revision"] = [PhoneAttachments.revision(fresh), PhoneAttachments.revision(started)]
    result["malformedCaps"] = caps(["images": .string("yes"), "text": .bool(true), "textBytes": .number(1)]) == nil
    result["kinds"] = ["public.png", "public.heic", "public.plain-text", "public.swift-source", "public.json", "com.adobe.pdf", "public.html", "com.microsoft.word.doc"]
        .map { PhoneAttachments.kind(typeIdentifier: $0)?.rawValue ?? "-" }
    result["admit"] = [
        PhoneAttachments.admit(kind: .text, name: "notes.md", size: 2_000, count: 0, caps: both) ?? "ok",
        PhoneAttachments.admit(kind: .text, name: "big.log", size: 300_000, count: 0, caps: both) ?? "ok",
        PhoneAttachments.admit(kind: .text, name: "huge.log", size: 12_000_000, count: 0, caps: textOnly) ?? "ok",
        PhoneAttachments.admit(kind: .image, name: "IMG_1.heic", size: 8_000_000, count: 0, caps: both) ?? "ok",
        PhoneAttachments.admit(kind: .image, name: "IMG_2.heic", size: 60_000_000, count: 0, caps: both) ?? "ok",
        PhoneAttachments.admit(kind: .image, name: "IMG_3.jpg", size: 100, count: 0, caps: textOnly) ?? "ok",
        PhoneAttachments.admit(kind: nil, name: "deck.pdf", size: 100, count: 0, caps: both) ?? "ok",
        PhoneAttachments.admit(kind: .text, name: "empty.txt", size: 0, count: 0, caps: both) ?? "ok",
        PhoneAttachments.admit(kind: .text, name: "ninth.txt", size: 10, count: 8, caps: both) ?? "ok",
        PhoneAttachments.admit(kind: .text, name: "a.txt", size: 10, count: 0, caps: none) ?? "ok",
    ]
    result["admitBytes"] = [
        PhoneAttachments.admitBytes(kind: .text, name: "nul.txt", data: Data([0x61, 0x00, 0x62]), caps: both) ?? "ok",
        PhoneAttachments.admitBytes(kind: .text, name: "latin.txt", data: Data([0xff, 0xfe, 0x41]), caps: both) ?? "ok",
        PhoneAttachments.admitBytes(kind: .text, name: "ok.txt", data: Data("你好".utf8), caps: both) ?? "ok",
        PhoneAttachments.admitBytes(kind: .image, name: "big.jpg", data: Data(count: 5_242_881), caps: both) ?? "ok",
    ]
    result["classes"] = ["attachment-too-large", "attachments-unsupported", "attachment-image-unsupported", "attachment-incomplete", "attachment-released",
        "attachment-secret", "request-conflict"].map { code -> String in
        switch PhoneAttachments.classify(code) { case .refused: "refused"; case .released: "released"; case .confirm: "confirm"; case .retry: "retry" }
    }
    result["heldBack"] = [
        PhoneAttachments.heldBack(.queue, running: true, count: 1) ?? "",
        PhoneAttachments.heldBack(.steer, running: true, count: 2) ?? "",
        PhoneAttachments.heldBack(.queue, running: true, count: 0) ?? "",
        PhoneAttachments.heldBack(.send, running: false, count: 1) ?? "",
    ]
    result["picks"] = [PhoneAttachPick.cancelled, .lost, .files(0), .files(2)].map { PhoneAttachments.pickNote($0) ?? "" }
    result["startSelection"] = [
        PhoneAttachments.selection(startFields: ["prompt": .string("x"), "customAgentId": .string("agt"), "harnessId": .string("fake"), "workspaceId": .string("default"),
            "mode": .string("agent"), "model": .object(["providerId": .string("p"), "model": .string("m"), "extra": .bool(true)])]).map { (try? String(data: $0.encoded(), encoding: .utf8)) ?? "" } ?? "",
        PhoneAttachments.selection(startFields: ["prompt": .string("x")]) == nil ? "none" : "some",
    ]
    result["names"] = [PhoneAttachments.fileName("IMG_0001.HEIC", ext: "jpg"), PhoneAttachments.fileName("../../etc/\u{202E}gpj.txt"), PhoneAttachments.fileName("", ext: "png")]

    // The tray: eight at most, refusals by class, what sends, release and clearing.
    let ref = { (id: String) in NativeJSON.object(["id": .string(id), "name": .string("a.txt"), "mime": .string("text/plain"), "kind": .string("text"),
        "size": .number(3), "sha256": .string(String(repeating: "a", count: 64))]) }
    var tray = PhoneAttachTray()
    var added = 0
    for index in 0..<9 { if tray.add(PhoneAttachDraft(name: "\(index).txt", kind: .text, data: Data("abc".utf8))) { added += 1 } }
    result["trayAdded"] = added
    result["trayNote"] = tray.note ?? ""
    let ids = tray.items.map(\.id)
    let waiting = tray.sendable(both) == .failure(.waiting)
    for (index, id) in ids.enumerated() { _ = tray.ready(id, ref: ref(String(format: "att%019d", index))) }
    let ready = (try? tray.sendable(both).get())?.count ?? -1
    let mismatch = tray.sendable(PhoneAttachCaps(images: true, text: false, textBytes: 0)) == .failure(.reason("当前 Harness 不接受这些附件。请移除附件或更换模型。"))
    tray.failed(ids[0], refusal: NativeHostRefusal(status: 415, code: "attachment-text-too-large", message: "当前 Harness 只接受 256 KB 以内的文本附件。", details: .null))
    tray.failed(ids[1], refusal: NativeHostRefusal(status: 400, code: "attachment-incomplete", message: "附件上传已中断。", details: .null))
    tray.failed(ids[2], refusal: nil, unknown: true)
    tray.failed(ids[3], refusal: nil, cancelled: true)
    tray.failed(ids[4], refusal: NativeHostRefusal(status: 409, code: "attachment-secret", message: "这个文件可能含有密钥。", details: .null))
    let statuses = tray.items.prefix(5).map { item -> String in
        switch item.status {
        case let .refused(words): "refused:" + words
        case let .failed(words): "failed:" + words
        case .unknown: "unknown"
        case let .confirm(words): "confirm:" + words
        default: "other"
        }
    }
    let blocked = tray.sendable(both)
    let removedId = tray.remove(ids[0]) ?? ""
    var released = PhoneAttachTray()
    _ = released.add(PhoneAttachDraft(name: "r.txt", kind: .text, data: Data("r".utf8)))
    _ = released.ready(released.items[0].id, ref: ref("rel0000000000000000000"))
    released.markReleased()
    let cleared = tray.clear()
    result["tray"] = [
        "waiting": waiting, "ready": ready, "mismatch": mismatch, "statuses": statuses,
        "blocked": blocked == .failure(.reason("有附件不能发送，请移除后再发送。")),
        "removed": removedId, "released": released.items.map { if case let .refused(words) = $0.status { words } else { "" } },
        "cleared": cleared.count, "empty": tray.isEmpty && tray.note == nil,
        "badRef": PhoneAttachTray().items.isEmpty && !PhoneAttachments.validRef(.object(["id": .string("x")])),
    ]

    // The header the Host reads, and the pending write a message with attachments is.
    let draft = PhoneAttachDraft(name: "photo.jpg", kind: .image, data: Data(count: 10))
    let header = try PhoneAttachments.header(draft, selection: PhoneAttachments.selection(harnessId: "fake", workspaceId: "default", model: nil), sessionId: "ses_1")
    let decoded = try NativeJSON.decode(LinkBytes.decode64(header, maximum: 4096))
    result["header"] = [
        "keys": decoded.object.keys.sorted(), "requestId": decoded["requestId"].string == draft.requestId, "size": decoded["size"].integer ?? 0,
        "selection": decoded["selection"].object.keys.sorted(), "mode": decoded["selection"]["mode"].string ?? "",
    ]
    let write = try NativePendingWrite(method: .post, path: "/link/api/tasks/ses_1/prompt", fields: ["prompt": .string("看图"), "attachmentIds": .array([.string("a"), .string("b")])])
    result["pendingCount"] = PhoneAttachments.count(write)
    // Bytes leave memory once the Host keeps the file; an image keeps a small thumbnail. Unfinished uploads are named for abort.
    let photoBytes = try PhoneImagePrep.prepare(data: try fixturePhoto(width: 800, height: 600), limit: PhoneAttachments.streamBytes).data
    var memory = PhoneAttachTray()
    let photoRow = PhoneAttachDraft(name: "p.jpg", kind: .image, data: photoBytes), pendingRow = PhoneAttachDraft(name: "q.txt", kind: .text, data: Data("q".utf8))
    _ = memory.add(photoRow); _ = memory.add(pendingRow)
    memory.started(photoRow.id, upload: String(repeating: "u", count: 22)); memory.started(pendingRow.id, upload: String(repeating: "v", count: 22))
    memory.started(pendingRow.id, upload: "not an id")
    let unfinishedBefore = memory.unfinishedUploads
    let before = memory.stagedBytes
    _ = memory.ready(photoRow.id, ref: .object(["id": .string(String(repeating: "a", count: 22)), "name": .string("p.jpg"), "kind": .string("image"),
        "mime": .string("image/jpeg"), "size": .number(Double(photoBytes.count)), "sha256": .string(String(repeating: "0", count: 64))]))
    let kept = memory.items[0], afterReady = memory.unfinishedUploads.count
    let removed = memory.removeRow(pendingRow.id)
    result["memory"] = [
        "unfinishedBefore": unfinishedBefore.count,
        "dropped": kept.data.isEmpty && kept.size == photoBytes.count && (kept.thumbnail?.count ?? 0) > 0 && kept.preview == kept.thumbnail,
        "smaller": memory.stagedBytes < before / 4,
        "unfinishedAfter": afterReady,
        "removedUpload": removed.upload == String(repeating: "v", count: 22) && removed.attachment == nil,
        "staged": [PhoneAttachments.admitStaged(staged: PhoneAttachments.stagedLimit - 10, adding: 11) ?? "ok",
                   PhoneAttachments.admitStaged(staged: 0, adding: 5 * 1_048_576) ?? "ok"],
    ]
    result["chips"] = PhoneAttachments.chips(.object(["attachments": .array([
        .object(["id": .string("img000000000000000000a"), "name": .string("shot.png"), "mime": .string("image/png"), "kind": .string("image"), "size": .number(204_800), "sha256": .string(String(repeating: "b", count: 64))]),
        .object(["id": .string("img000000000000000000b"), "name": .string("anim.gif"), "mime": .string("image/gif"), "kind": .string("image"), "size": .number(100), "sha256": .string(String(repeating: "c", count: 64))]),
        .object(["id": .string("bad"), "name": .string("x"), "kind": .string("text"), "size": .number(1), "sha256": .string("short")]),
    ])])).map { "\($0.name)|\($0.image)|\($0.size)|\($0.opens)" }

    // The file and camera paths: pixels only, the picker's copy gone, nothing else written; oversized text is never read.
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("latch-attach-pick-" + UUID().uuidString)
    let inbox = folder.appendingPathComponent("codes.latch.ios-Inbox")
    try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let photoCopy = inbox.appendingPathComponent("IMG_9001.JPG"), bigText = inbox.appendingPathComponent("big.log"), note = inbox.appendingPathComponent("note.md")
    try fixturePhoto(width: 1200, height: 900).write(to: photoCopy)
    try Data(repeating: 0x61, count: 300_000).write(to: bigText)
    try Data("# 笔记\n".utf8).write(to: note)
    let fromFile = PhoneAttachLoader.file(url: photoCopy, imageLimit: PhoneAttachments.streamBytes, textLimit: 262_144)
    let fromBig = PhoneAttachLoader.file(url: bigText, imageLimit: PhoneAttachments.streamBytes, textLimit: 262_144)
    let fromCamera = PhoneAttachLoader.camera(try fixturePhoto(width: 1600, height: 1200), limit: PhoneAttachments.streamBytes)
    let leftAfterReads = try FileManager.default.contentsOfDirectory(atPath: inbox.path)
    // A copy whose callback never came is purged at launch.
    try Data("left".utf8).write(to: note.deletingLastPathComponent().appendingPathComponent("orphan.txt"))
    let purged = PhoneAttachLoader.purgeInbox(temporary: folder)
    result["loader"] = [
        "file": fromFile.data.map(metadataKeys) ?? ["none"], "fileName": fromFile.name, "camera": fromCamera.data.map(metadataKeys) ?? ["none"],
        "cameraName": fromCamera.name, "bigRead": fromBig.data != nil, "bigSize": fromBig.size, "left": leftAfterReads.sorted(), "purged": purged,
        "afterPurge": (try? FileManager.default.contentsOfDirectory(atPath: inbox.path)) ?? ["?"],
    ]
    // Above 40 megapixels, as the Host refuses: said before any full decode.
    let huge = folder.appendingPathComponent("huge.png")
    if let context = CGContext(data: nil, width: 8000, height: 5100, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceGray(),
        bitmapInfo: CGImageAlphaInfo.none.rawValue), let image = context.makeImage(),
       let destination = CGImageDestinationCreateWithURL(huge as CFURL, UTType.png.identifier as CFString, 1, nil) {
        CGImageDestinationAddImage(destination, image, nil); _ = CGImageDestinationFinalize(destination)
    }
    result["hugeImage"] = PhoneAttachLoader.image(url: huge, name: "huge.png", limit: PhoneAttachments.streamBytes).failure ?? ""

    // When a place's attachments are locked, and when closing it lets them go.
    let start = try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["prompt": .string("x"), "attachmentIds": .array([.string("a")])])
    let topic = try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: ["prompt": .string("x"), "customAgentId": .string("agt_1"), "attachmentIds": .array([.string("a")])])
    let plain = try NativePendingWrite(method: .post, path: "/link/api/tasks/ses_1/prompt", fields: ["prompt": .string("x")])
    let prompt = try NativePendingWrite(method: .post, path: "/link/api/tasks/ses_1/prompt", fields: ["prompt": .string("x"), "attachmentIds": .array([.string("a")])])
    result["keys"] = [start, topic, prompt].map { PhoneAttachments.key(of: $0) == nil ? "-" : PhoneAttachments.key(of: $0)!.replacingOccurrences(of: "\u{0}", with: "~") }
    result["locked"] = [
        PhoneAttachments.locked(key: "ses_1", pending: [prompt], sending: false), PhoneAttachments.locked(key: "ses_1", pending: [plain], sending: false),
        PhoneAttachments.locked(key: "ses_1", pending: [], sending: true), PhoneAttachments.locked(key: "ses_2", pending: [prompt], sending: false),
        PhoneAttachments.locked(key: PhoneAttachments.topicKey("agt_1"), pending: [topic], sending: false),
    ]
    let sheet = PhoneAttachments.newSessionKey
    result["dropsOnClose"] = [
        PhoneAttachments.dropsOnClose(key: sheet, pending: [], starting: false, verifying: false, covered: false),
        PhoneAttachments.dropsOnClose(key: sheet, pending: [], starting: true, verifying: false, covered: false),
        PhoneAttachments.dropsOnClose(key: sheet, pending: [], starting: false, verifying: true, covered: false),
        PhoneAttachments.dropsOnClose(key: sheet, pending: [], starting: false, verifying: false, covered: true),
        PhoneAttachments.dropsOnClose(key: sheet, pending: [start], starting: false, verifying: false, covered: false),
        PhoneAttachments.dropsOnClose(key: sheet, pending: [prompt], starting: false, verifying: false, covered: false),
    ]
    // A send goes only to the place it began in, and only with every row it waited on.
    var sendTray = PhoneAttachTray()
    _ = sendTray.add(PhoneAttachDraft(name: "a.txt", kind: .text, data: Data("a".utf8)))
    _ = sendTray.ready(sendTray.items[0].id, ref: ref("snd0000000000000000000"))
    let plan = PhoneAttachSend(target: "ses_1", tray: sendTray)
    let moved = plan.finish(current: "ses_2", tray: sendTray, caps: both)
    let toStart = plan.finish(current: nil, tray: sendTray, caps: both)
    let ok = (try? plan.finish(current: "ses_1", tray: sendTray, caps: both).get()) ?? []
    var emptied = sendTray; emptied.clear()
    let gone = plan.finish(current: "ses_1", tray: emptied, caps: both)
    result["send"] = [
        moved == .failure(.reason(PhoneAttachSend.movedWords)) ? "moved" : "?", toStart == .failure(.reason(PhoneAttachSend.movedWords)) ? "moved" : "?",
        ok.joined(), gone == .failure(.reason(PhoneAttachSend.goneWords)) ? "gone" : "?",
    ]

    // A photo with a position and camera details comes out as pixels only, within one stream.
    let photo = try fixturePhoto(width: 3000, height: 2000)
    let prepared = try PhoneImagePrep.prepare(data: photo, limit: PhoneAttachments.streamBytes)
    let transparent = try PhoneImagePrep.prepare(data: try fixturePhoto(width: 300, height: 200, alpha: true), limit: PhoneAttachments.streamBytes)
    var tooBig = false
    do { _ = try PhoneImagePrep.prepare(data: photo, limit: 1_000) } catch { tooBig = (error as? NativeFailure) == .unsupported }
    result["image"] = [
        "sourceMetadata": metadataKeys(photo), "metadata": metadataKeys(prepared.data), "ext": prepared.ext, "fits": prepared.data.count <= PhoneAttachments.streamBytes,
        "longSide": max(prepared.width, prepared.height), "alphaExt": transparent.ext, "alphaMetadata": metadataKeys(transparent.data), "tooBig": tooBig,
    ]
    return result
}

/** Against a real Host: capabilities before and after a Harness starts, upload, retry, cancel, send with attachments and read back. */
@MainActor func runNativeAttachments(_ input: [String: Any]) async throws -> [String: Any] {
    let invitation = try PairingInvitation.parse(input["payload"] as? String ?? "", privateOnly: false), port = try fixturePort(input), keys = try FixtureKeys()
    let pairing = try NativePairing(invitation: invitation, keys: keys)
    let temporary = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey)
    _ = try await pairing.begin(on: temporary, name: "Swift attachments fixture", gatewayHash: Data(repeating: 0, count: 32))
    var approved = false
    for _ in 0..<60 {
        if let view = try await pairing.status(on: temporary), view.status == "approved" { approved = true; break }
        try await Task.sleep(for: .milliseconds(50))
    }
    guard approved else { throw NativeFailure.unavailable }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-attach-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: invitation.hostId)
    let device = try await pairing.complete(on: temporary) { device in try await vault.storeMetadata(JSONEncoder().encode(device), name: "device") }
    await temporary.close()
    let workspace = try NativeWorkspace(device: device, keys: keys, vault: vault)
    var stage = "start"
    func check(_ ok: Bool, _ name: String) throws { if !ok { throw FixtureStage(name: name) } }
    func idle(_ id: String) async throws -> NativeJSON {
        for _ in 0..<300 {
            let detail = try await workspace.detail(id)
            if detail["summary"]["status"].string == "idle" { return detail }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw FixtureStage(name: "idle " + stage)
    }
    func start(_ harness: String, _ prompt: String, attachments: [String] = []) async throws -> String {
        var fields: [String: NativeJSON] = ["harnessId": .string(harness), "workspaceId": .string("default"), "mode": .string("agent"), "prompt": .string(prompt)]
        if !attachments.isEmpty { fields["attachmentIds"] = .array(attachments.map { .string($0) }) }
        guard let id = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/tasks", fields: fields))["sessionId"].string else { throw FixtureStage(name: "start " + harness) }
        return id
    }
    var result: [String: Any] = [:]
    do {
        _ = try await workspace.install {
            try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
        }
        let selection = PhoneAttachments.selection(harnessId: "fake", workspaceId: "default", model: nil)
        // Behind the window: no capability read and no upload.
        stage = "window"
        var closed = 0
        do { _ = try await workspace.attachmentCapabilities(selection: selection, sessionId: nil) } catch { if (error as? NativeFailure) == .expired { closed += 1 } }
        do { _ = try await workspace.uploadAttachment(PhoneAttachDraft(name: "a.txt", kind: .text, data: Data("a".utf8)), selection: selection, sessionId: nil) }
        catch { if (error as? NativeFailure) == .expired { closed += 1 } }
        result["window"] = closed == 2
        _ = try await workspace.verify()

        // Not started yet: the Host says why, and the phone shows its words.
        stage = "fresh"
        let fresh = try await workspace.attachmentCapabilities(selection: selection, sessionId: nil)
        result["freshReason"] = PhoneAttachments.unavailable(caps: fresh, harness: .null, failed: false) ?? ""
        let first = try await start("fake", "hello")
        _ = try await idle(first)
        let snapshot = try await workspace.snapshot()
        let harness = PhoneStart.harness(snapshot["catalog"], "fake")
        result["reported"] = PhoneAttachments.revision(harness)
        let caps = try await workspace.attachmentCapabilities(selection: selection, sessionId: first)
        result["caps"] = PhoneAttachments.limitsLine(caps)

        // A photo re-encoded, uploaded in chunks; the same request again is the same attachment, as a retry after an unknown answer.
        stage = "upload"
        let prepared = try PhoneImagePrep.prepare(data: try fixturePhoto(width: 2400, height: 1600), limit: PhoneAttachments.streamBytes)
        let photo = PhoneAttachDraft(name: PhoneAttachments.fileName("IMG_0001.HEIC", ext: prepared.ext), kind: .image, data: prepared.data)
        let progress = FixtureTransfer()
        let ref = try await workspace.uploadAttachment(photo, selection: selection, sessionId: first) { done, total in progress.progress(done, total) }
        _ = try progress.result()
        let again = try await workspace.uploadAttachment(photo, selection: selection, sessionId: first)
        result["sameRequest"] = ref["id"] == again["id"] && ref["kind"].string == "image" && ref["mime"].string == "image/jpeg"
        let note = PhoneAttachDraft(name: "notes.md", kind: .text, data: Data("# 笔记\n只有文字。\n".utf8))
        let noteRef = try await workspace.uploadAttachment(note, selection: selection, sessionId: first)

        // Cancelled after its first chunk: no chunk after that, and the Host kept nothing of it, so the same request with
        // other bytes is a fresh upload rather than a conflict.
        stage = "cancel-mid"
        let mid = PhoneAttachDraft(name: "mid.txt", kind: .text, data: Data(repeating: 0x62, count: PhoneAttachments.streamBytes))
        let chunks = FixtureChunks()
        let midTask = Task { try await workspace.uploadAttachment(mid, selection: selection, sessionId: first) { done, _ in chunks.saw(done) } }
        chunks.onFirst = { midTask.cancel() }
        var midStopped = false
        do { _ = try await midTask.value } catch { midStopped = error is CancellationError }
        result["cancelMid"] = ["stopped": midStopped, "afterCancel": chunks.afterCancel, "partial": chunks.last < PhoneAttachments.streamBytes]
        // Cancel closes the stream and waits; the next upload goes through.
        stage = "cancel"
        let big = PhoneAttachDraft(name: "big.txt", kind: .text, data: Data(repeating: 0x61, count: PhoneAttachments.streamBytes))
        let cancelled = Task { try await workspace.uploadAttachment(big, selection: selection, sessionId: first) }
        cancelled.cancel()
        var stopped = false
        do { _ = try await cancelled.value } catch { stopped = error is CancellationError }
        let after = try await workspace.uploadAttachment(PhoneAttachDraft(name: "after.txt", kind: .text, data: Data("after".utf8)), selection: selection, sessionId: first)
        result["cancel"] = stopped && PhoneAttachments.validRef(after)
        try await workspace.removeAttachment(after["id"].string ?? "")

        // More than any Host takes is refused here, before anything is sent.
        var oversize = false
        do { _ = try await workspace.uploadAttachment(PhoneAttachDraft(name: "over.txt", kind: .text, data: Data(count: PhoneAttachments.largestFile + 1)), selection: selection, sessionId: first) }
        catch { oversize = (error as? NativeFailure) == .invalidRecord }
        result["oversize"] = oversize

        // Over one stream: parts of 1 MiB, one stream each; the Host assembles the file and checks its hash.
        stage = "chunked"
        func letters(_ count: Int, shift: Int) -> Data { Data((0..<count).map { $0 % 64 == 63 ? 0x0a : UInt8(97 + ($0 + shift) % 26) }) }
        let long = PhoneAttachDraft(name: "long.log", kind: .text, data: letters(3 * PhoneAttachments.streamBytes, shift: 0))
        let longProgress = FixtureTransfer()
        let longRef = try await workspace.uploadAttachment(long, selection: selection, sessionId: first) { done, total in longProgress.progress(done, total) }
        _ = try longProgress.result()
        // The same request again is answered by the Host without a part being sent.
        let resent = FixtureCross(threshold: 0)
        let longAgain = try await workspace.uploadAttachment(long, selection: selection, sessionId: first) { done, _ in resent.saw(done) }
        result["chunked"] = [
            "kept": longRef["kind"].string == "text" && longRef["size"].integer == UInt64(long.size)
                && longRef["sha256"].string == LinkBytes.hex(LinkBytes.hash(long.data)),
            "again": longAgain["id"] == longRef["id"] && resent.first == nil,
        ]
        // A large image, re-encoded under the Host's image limit rather than one stream's.
        stage = "large-image"
        let large = try PhoneImagePrep.prepare(data: try fixturePhoto(width: 2400, height: 1600, alpha: true), limit: PhoneAttachments.limit(.image, caps))
        let largeRef = try await workspace.uploadAttachment(PhoneAttachDraft(name: "large.png", kind: .image, data: large.data), selection: selection, sessionId: first)
        result["largeImage"] = large.data.count > PhoneAttachments.streamBytes && largeRef["mime"].string == "image/png"
            && largeRef["size"].integer == UInt64(large.data.count) && largeRef["width"].integer == UInt64(large.width)

        // The connection drops in the second part: the answer is unknown; the retry on a new path sends only what is missing.
        stage = "resume"
        let opened = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
        _ = try await workspace.install { opened }
        let resumable = PhoneAttachDraft(name: "resume.log", kind: .text, data: letters(3 * PhoneAttachments.streamBytes, shift: 7))
        let drop = FixtureCross(threshold: PhoneAttachments.streamBytes + 65_536)
        drop.onCross = { Task { await opened.close() } }
        var dropped = false
        do { _ = try await workspace.uploadAttachment(resumable, selection: selection, sessionId: first) { done, _ in drop.saw(done) } }
        catch { dropped = (error as? NativeFailure) == .resultUnknown }
        _ = try await workspace.install {
            try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
        }
        let resumed = FixtureCross(threshold: 0)
        let resumedRef = try await workspace.uploadAttachment(resumable, selection: selection, sessionId: first) { done, _ in resumed.saw(done) }
        result["resume"] = [
            "unknown": dropped,
            // The first part is not sent again.
            "fromPart": (resumed.first ?? 0) > PhoneAttachments.streamBytes,
            "kept": resumedRef["sha256"].string == LinkBytes.hex(LinkBytes.hash(resumable.data)),
        ]

        // Cancel in the second part closes its stream, waits, and aborts the upload on the Host: the same request starts over.
        stage = "cancel-parts"
        let stopping = PhoneAttachDraft(name: "stop.log", kind: .text, data: letters(2 * PhoneAttachments.streamBytes + 10, shift: 13))
        let stop = FixtureCross(threshold: PhoneAttachments.streamBytes + 65_536)
        let stopTask = Task { try await workspace.uploadAttachment(stopping, selection: selection, sessionId: first) { done, _ in stop.saw(done) } }
        stop.onCross = { stopTask.cancel() }
        var partsStopped = false
        do { _ = try await stopTask.value } catch { partsStopped = error is CancellationError }
        let restart = FixtureCross(threshold: 0)
        let restarted = try await workspace.uploadAttachment(stopping, selection: selection, sessionId: first) { done, _ in restart.saw(done) }
        result["cancelParts"] = ["stopped": partsStopped, "fromStart": (restart.first ?? .max) <= 65_536, "kept": PhoneAttachments.validRef(restarted)]
        for ref in [longRef, largeRef, resumedRef, restarted] { try await workspace.removeAttachment(ref["id"].string ?? "") }

        // A secret to confirm leaves the parts on the Host: removing that row aborts its upload there.
        stage = "secret-remove"
        let secret = PhoneAttachDraft(name: ".env", kind: .text, data: letters(PhoneAttachments.streamBytes + 100, shift: 3))
        let named = FixtureNamed()
        var secretCode = ""
        do { _ = try await workspace.uploadAttachment(secret, selection: selection, sessionId: first, started: { named.set($0) }) }
        catch let error as NativeHostRefusal { secretCode = error.code }
        if let upload = named.value { await workspace.abortAttachmentUpload(upload) }
        // Cancelled before its start is answered: the start still lands, and the upload it began is aborted.
        stage = "cancel-begin"
        let beforeBegin = PhoneAttachDraft(name: "early.log", kind: .text, data: letters(PhoneAttachments.streamBytes + 100, shift: 5))
        let earlyNamed = FixtureNamed()
        let earlyTask = Task { try await workspace.uploadAttachment(beforeBegin, selection: selection, sessionId: first, started: { earlyNamed.set($0) }) }
        earlyTask.cancel()
        var earlyStopped = false
        do { _ = try await earlyTask.value } catch { earlyStopped = error is CancellationError }
        result["leftovers"] = ["secret": secretCode, "secretNamed": named.value != nil, "earlyStopped": earlyStopped]

        // The message carries the attachments; the Host's transcript lists them, and the photo reads back byte for byte.
        stage = "send"
        let ids = [ref["id"].string ?? "", noteRef["id"].string ?? ""]
        _ = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/tasks/" + first + "/prompt", fields: ["prompt": .string("看图"), "attachmentIds": .array(ids.map { .string($0) })]))
        let detail = try await idle(first)
        let user = detail["messages"].array.last { $0["role"].string == "user" } ?? .null
        result["sent"] = PhoneAttachments.chips(user).map(\.name)
        let file = try await workspace.resolveAttachment(ids[0])
        guard let handle = file["handle"].string, let etag = file["etag"].string, let size = file["size"].integer else { throw FixtureStage(name: "resolve") }
        let bytes = try await workspace.fileBytes(handle: handle, etag: etag, offset: 0, count: Int(size), attachment: true)
        result["readBack"] = bytes == prepared.data

        // A Harness that takes nothing: its reason, and the Host's refusal of an upload is permanent.
        stage = "plain"
        let plain = try await start("plain", "hello")
        _ = try await idle(plain)
        let plainCaps = try await workspace.attachmentCapabilities(selection: PhoneAttachments.selection(harnessId: "plain", workspaceId: "default", model: nil), sessionId: plain)
        result["plainReason"] = PhoneAttachments.unavailable(caps: plainCaps, harness: .null, failed: false) ?? ""
        var refusal = ""
        do { _ = try await workspace.uploadAttachment(note, selection: PhoneAttachments.selection(harnessId: "plain", workspaceId: "default", model: nil), sessionId: plain) }
        catch let error as NativeHostRefusal { refusal = error.code + ":" + (PhoneAttachments.classify(error.code) == .refused ? "refused" : "other") }
        result["plainRefusal"] = refusal
        // A refusal the Host gives before the body is in is its answer, not an unknown result, however many chunks were left.
        var early = ""
        do { _ = try await workspace.uploadAttachment(PhoneAttachDraft(name: "long.txt", kind: .text, data: Data(repeating: 0x63, count: PhoneAttachments.streamBytes)),
                selection: PhoneAttachments.selection(harnessId: "plain", workspaceId: "default", model: nil), sessionId: plain) }
        catch let error as NativeHostRefusal { early = error.code } catch { early = String(describing: error) }
        result["earlyRefusal"] = early

        // A queued message cannot carry them: the Host's own refusal, said before sending on the phone.
        stage = "queue"
        let extra = try await workspace.uploadAttachment(PhoneAttachDraft(name: "q.txt", kind: .text, data: Data("q".utf8)), selection: selection, sessionId: first)
        do {
            _ = try await workspace.submit(NativePendingWrite(method: .post, path: "/link/api/tasks/" + first + "/prompt",
                fields: ["prompt": .string("later"), "queue": .bool(true), "attachmentIds": .array([extra["id"]])]), explain: true)
            result["queue"] = "accepted"
        } catch let error as NativeHostRefusal { result["queue"] = error.code }
        try await workspace.removeAttachment(extra["id"].string ?? "")
    } catch {
        await workspace.closeOpening()
        throw FixtureStage(name: stage + ": " + String(describing: error))
    }
    await workspace.closeOpening()
    return result
}

/** The upload ID a `started` callback heard. */
final class FixtureNamed: @unchecked Sendable {
    private let lock = NSLock()
    private var named: String?
    func set(_ value: String) { lock.lock(); named = value; lock.unlock() }
    var value: String? { lock.lock(); defer { lock.unlock() }; return named }
}

/** Progress of one upload: the first offset seen, and one action when it first passes `threshold`. */
final class FixtureCross: @unchecked Sendable {
    private let lock = NSLock()
    private let threshold: Int
    private var seen: Int?
    private var fired = false
    var onCross: (@Sendable () -> Void)?
    init(threshold: Int) { self.threshold = threshold }
    var first: Int? { lock.lock(); defer { lock.unlock() }; return seen }
    func saw(_ done: Int) {
        lock.lock()
        if seen == nil { seen = done }
        let fire = !fired && done > threshold ? onCross : nil
        if fire != nil { fired = true }
        lock.unlock()
        fire?()
    }
}

/** Progress of one upload: the first chunk triggers a cancel, and any chunk reported after it is counted. */
final class FixtureChunks: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private(set) var afterCancel = 0
    private(set) var last = 0
    var onFirst: (@Sendable () -> Void)?
    func saw(_ done: Int) {
        lock.lock()
        if cancelled { afterCancel += 1 }
        last = done
        let fire = !cancelled ? onFirst : nil
        cancelled = true
        lock.unlock()
        fire?()
    }
}

/** Which answers to a write leave its result unknown, and which are the Host's definite refusal with its own words. */
func phoneRefusalsFixture() -> [String: Any] {
    func body(_ code: String, _ message: String) -> Data { Data(#"{"error":"\#(code)","message":"\#(message)"}"#.utf8) }
    let cases: [(Int, String)] = [
        (503, "agent-start-failed"), (502, "agent-refused"), (504, "agent-handshake-timeout"), (503, "storage-unavailable"),
        (502, "harness-timeout"), (408, "timeout"), (409, "harness-version-unsupported"), (500, "internal-error"),
    ]
    return [
        "notAccepted": NativeHostRefusal.notAccepted5xx.sorted(),
        "unknown": cases.map { NativeHostRefusal.leavesUnknown(status: $0.0, body: body($0.1, "x")) },
        "refusal": NativeHostRefusal.parse(status: 503, body: body("agent-start-failed", "Flaky Agent 启动失败：进程退出（退出码 1）"))?.message ?? "",
        // A 5xx with no code, or not JSON at all, stays unknown.
        "bare": [NativeHostRefusal.leavesUnknown(status: 503, body: Data()), NativeHostRefusal.leavesUnknown(status: 503, body: Data("{}".utf8))],
    ]
}
