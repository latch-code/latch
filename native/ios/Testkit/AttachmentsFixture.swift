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

/** A fixture's own temporary folder, so staging and purges never touch another folder's files. */
let fixtureTemporary: URL = {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("latch-attach-fixture-" + UUID().uuidString, isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}()

/** A row whose bytes are staged as the App stages them. */
func fixtureDraft(name: String, kind: PhoneAttachKind, data: Data) throws -> PhoneAttachDraft {
    try FileManager.default.createDirectory(at: fixtureTemporary, withIntermediateDirectories: true)
    return PhoneAttachDraft(name: name, kind: kind, file: try PhoneAttachStage.write(data, temporary: fixtureTemporary),
        thumbnail: kind == .image ? PhoneImagePrep.thumbnail(data) : nil)
}

/** The composer's attachment decisions: capability reasons, limits, refusal classes, the tray, staging and image re-encoding. */
func phoneAttachmentsFixture(_ input: [String: Any]) throws -> [String: Any] {
    defer { try? FileManager.default.removeItem(at: fixtureTemporary) }
    func caps(_ fields: [String: NativeJSON]) -> PhoneAttachCaps? { PhoneAttachCaps.parse(.object(["capabilities": .object(fields)])) }
    let both = caps(["images": .bool(true), "text": .bool(true), "textBytes": .number(262_144), "fileBytes": .number(52_428_800), "imageBytes": .number(5_242_880)])!
    let textOnly = caps(["images": .bool(false), "text": .bool(true), "textBytes": .number(26_214_400), "reason": .string("这个 Harness 不接收图片。")])!
    let none = caps(["images": .bool(false), "text": .bool(false), "textBytes": .number(0), "reason": .string("这个 Harness 不接收图片和文件。")])!
    let files = caps(["images": .bool(true), "text": .bool(true), "textBytes": .number(262_144), "fileBytes": .number(52_428_800), "imageBytes": .number(5_242_880), "files": .bool(true)])!
    let started = NativeJSON.object(["status": .string("ready"), "attachmentsReported": .object(["images": .bool(false), "text": .bool(false)])])
    let fresh = NativeJSON.object(["status": .string("ready")])
    var result: [String: Any] = [:]
    result["limits"] = [PhoneAttachments.limitsLine(both), PhoneAttachments.limitsLine(textOnly), PhoneAttachments.limitsLine(none), PhoneAttachments.limitsLine(files)]
    // A Host saying more than 50 MB is held to the phone's own largest file.
    result["clamped"] = caps(["images": .bool(false), "text": .bool(true), "textBytes": .number(1e9), "fileBytes": .number(1e9), "files": .bool(true)]).map { [$0.fileBytes, $0.textBytes] } ?? []
    result["unavailable"] = [
        PhoneAttachments.unavailable(caps: both, harness: fresh, failed: false) ?? "",
        PhoneAttachments.unavailable(caps: none, harness: started, failed: false) ?? "",
        PhoneAttachments.unavailable(caps: nil, harness: started, failed: false) ?? "",
        PhoneAttachments.unavailable(caps: nil, harness: fresh, failed: false) ?? "",
        PhoneAttachments.unavailable(caps: nil, harness: fresh, failed: true) ?? "",
    ]
    result["revision"] = [PhoneAttachments.revision(fresh), PhoneAttachments.revision(started)]
    result["malformedCaps"] = caps(["images": .string("yes"), "text": .bool(true), "textBytes": .number(1)]) == nil
    result["kinds"] = ["public.png", "public.heic", "public.plain-text", "public.swift-source", "public.json", "com.adobe.pdf", "public.html", "com.microsoft.word.doc",
        "public.svg-image", "public.mpeg-4", "public.zip-archive"].map { PhoneAttachments.kind(typeIdentifier: $0).rawValue }
    result["admit"] = [
        PhoneAttachments.admit(kind: .text, name: "notes.md", size: 2_000, count: 0, caps: both) ?? "ok",
        PhoneAttachments.admit(kind: .text, name: "big.log", size: 300_000, count: 0, caps: both) ?? "ok",
        PhoneAttachments.admit(kind: .text, name: "huge.log", size: 30_000_000, count: 0, caps: textOnly) ?? "ok",
        PhoneAttachments.admit(kind: .image, name: "IMG_1.heic", size: 8_000_000, count: 0, caps: both) ?? "ok",
        PhoneAttachments.admit(kind: .image, name: "IMG_2.heic", size: 60_000_000, count: 0, caps: both) ?? "ok",
        PhoneAttachments.admit(kind: .image, name: "IMG_3.jpg", size: 100, count: 0, caps: textOnly) ?? "ok",
        PhoneAttachments.admit(kind: .file, name: "deck.pdf", size: 100, count: 0, caps: both) ?? "ok",
        PhoneAttachments.admit(kind: .text, name: "empty.txt", size: 0, count: 0, caps: both) ?? "ok",
        PhoneAttachments.admit(kind: .text, name: "ninth.txt", size: 10, count: 8, caps: both) ?? "ok",
        PhoneAttachments.admit(kind: .text, name: "a.txt", size: 10, count: 0, caps: none) ?? "ok",
        PhoneAttachments.admit(kind: nil, name: "bundle.app", size: 10, count: 0, caps: files) ?? "ok",
    ]
    // Where the Host takes every file: any type, text held to the file limit rather than 256 KB, 50 MB exactly and no more.
    result["admitFiles"] = [
        PhoneAttachments.admit(kind: .file, name: "deck.pdf", size: 100, count: 0, caps: files) ?? "ok",
        PhoneAttachments.admit(kind: .text, name: "big.log", size: 300_000, count: 0, caps: files) ?? "ok",
        PhoneAttachments.admit(kind: .file, name: "clip.mov", size: 52_428_800, count: 0, caps: files) ?? "ok",
        PhoneAttachments.admit(kind: .file, name: "clip.mov", size: 52_428_801, count: 0, caps: files) ?? "ok",
        PhoneAttachments.admit(kind: .text, name: "dump.log", size: 52_428_801, count: 0, caps: files) ?? "ok",
    ]
    result["admitSize"] = [
        PhoneAttachments.admitSize(kind: .text, name: "ok.txt", size: 3, caps: both) ?? "ok",
        PhoneAttachments.admitSize(kind: .image, name: "big.jpg", size: 5_242_881, caps: both) ?? "ok",
        PhoneAttachments.admitSize(kind: .image, name: "fit.jpg", size: 5_242_880, caps: files) ?? "ok",
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
    let originalSend = UUID(), subsequentSend = UUID()
    var locks = ["s": originalSend]
    PhoneAttachments.releaseSend("s", owner: originalSend, locks: &locks)
    let ownLockReleased = locks["s"] == nil
    locks["s"] = subsequentSend
    PhoneAttachments.releaseSend("s", owner: originalSend, locks: &locks)
    result["sendOwnership"] = [ownLockReleased, locks["s"] == subsequentSend]
    let stagedWindowImage = try PhoneAttachStage.write(Data([137, 80, 78, 71]), temporary: fixtureTemporary)
    let latePick = PhonePicked(name: "screen.png", kind: .image, file: stagedWindowImage, size: stagedWindowImage.size)
    let firstWindow = UUID(), nextWindow = UUID()
    let timely = PhoneAttachments.takePicked([latePick], window: firstWindow, currentWindow: firstWindow, sameTarget: true)
    let afterRenewal = PhoneAttachments.takePicked([latePick], window: firstWindow, currentWindow: nextWindow, sameTarget: true)
    result["renewedWindowImage"] = [timely?.first == latePick, afterRenewal == nil, !FileManager.default.fileExists(atPath: stagedWindowImage.url.path)]
    let sourceReference = "[conversation-ref:00000000-0000-4000-8000-000000000000] Earlier work · read_conversation_reference"
    let quote = PhoneReplyQuote.create(session: "s:1", message: "m/1", selected: "quoted words", body: "Now: quoted words.") ?? ""
    let richBody = "Before **red moon** after red moon."
    let rich = PhoneReplyQuote.create(session: "s", message: "m", selected: "moon after", body: richBody) ?? ""
    let repeated = PhoneReplyQuote.create(session: "s", message: "m", selected: "red moon", body: richBody, block: "Before red moon after red moon.", blockOffset: 22) ?? ""
    let wire = "A\n" + sourceReference + "\n" + quote + "\nB"
    let labels = PhoneInputReferences(wire)
    result["conversationReferences"] = [
        labels.display, labels.restore(labels.display + "!") == wire + "!" ? "roundtrip" : "lost",
        labels.restore(labels.display.replacingOccurrences(of: "〔会话：Earlier work〕", with: "")).contains("conversation-ref:") ? "kept" : "removed",
        PhoneReplyQuote.parse(quote).first?.original(in: "Now: quoted words.")?.range.location == 5 ? "located" : "missing",
        PhoneReplyQuote.parse(rich).first?.original(in: richBody)?.range.location == 11 ? "formatted" : "missing",
        PhoneReplyQuote.parse(repeated).first?.original(in: richBody)?.range.location == 22 ? "second" : "ambiguous",
        PhoneInputReferences(sourceReference + "\nB").restore("〔会话：Earlier work〕 copy\n" + PhoneInputReferences(sourceReference + "\nB").display).components(separatedBy: sourceReference).count == 2 ? "one reference" : "duplicated",
    ]
    result["picks"] = [PhoneAttachPick.cancelled, .lost, .files(0), .files(2)].map { PhoneAttachments.pickNote($0) ?? "" }
    result["startSelection"] = [
        PhoneAttachments.selection(startFields: ["prompt": .string("x"), "customAgentId": .string("agt"), "harnessId": .string("fake"), "workspaceId": .string("default"),
            "mode": .string("agent"), "model": .object(["providerId": .string("p"), "model": .string("m"), "extra": .bool(true)])]).map { (try? String(data: $0.encoded(), encoding: .utf8)) ?? "" } ?? "",
        PhoneAttachments.selection(startFields: ["prompt": .string("x")]) == nil ? "none" : "some",
    ]
    result["names"] = [PhoneAttachments.fileName("IMG_0001.HEIC", ext: "jpg"), PhoneAttachments.fileName("../../etc/\u{202E}gpj.txt"), PhoneAttachments.fileName("", ext: "png")]
    result["icons"] = [("image", "image/png", "a.png"), ("text", "text/plain", "a.md"), ("file", "application/pdf", "a.pdf"), ("file", "video/quicktime", "a.mov"),
        ("file", "audio/mpeg", "a.mp3"), ("file", "application/zip", "a.zip"), ("file", "application/octet-stream", "a.bin"),
        ("file", "application/octet-stream", "b.key"), ("file", "application/octet-stream", "c.mp4")]
        .map { PhoneAttachments.icon(kind: $0.0, mime: $0.1, name: $0.2).rawValue }
    // Text sent where the Host takes files is a file: the built-in Harness no longer refuses text past 256 KB.
    result["takes"] = [PhoneAttachments.takes(.text, size: 300_000, both), PhoneAttachments.takes(.text, size: 300_000, files), PhoneAttachments.takes(.file, size: 1, both),
        PhoneAttachments.takes(.file, size: 1, files)]

    // The tray: eight at most, refusals by class, what sends, release and clearing.
    let ref = { (id: String) in NativeJSON.object(["id": .string(id), "name": .string("a.txt"), "mime": .string("text/plain"), "kind": .string("text"),
        "size": .number(3), "sha256": .string(String(repeating: "a", count: 64))]) }
    var tray = PhoneAttachTray()
    var added = 0
    for index in 0..<9 { if tray.add(try fixtureDraft(name: "\(index).txt", kind: .text, data: Data("abc".utf8))) { added += 1 } }
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
    _ = released.add(try fixtureDraft(name: "r.txt", kind: .text, data: Data("r".utf8)))
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

    // The header the Host reads, the start of a chunked upload, and the pending write a message with attachments is.
    let draft = try fixtureDraft(name: "photo.jpg", kind: .image, data: Data(count: 10))
    let header = try PhoneAttachments.header(draft, selection: PhoneAttachments.selection(harnessId: "fake", workspaceId: "default", model: nil), sessionId: "ses_1")
    let decoded = try NativeJSON.decode(LinkBytes.decode64(header, maximum: 4096))
    result["header"] = [
        "keys": decoded.object.keys.sorted(), "requestId": decoded["requestId"].string == draft.requestId, "size": decoded["size"].integer ?? 0,
        "selection": decoded["selection"].object.keys.sorted(), "mode": decoded["selection"]["mode"].string ?? "",
    ]
    // Only a re-encoded picture is declared one; text and every other file are declared files, for the Host to sniff.
    let declared = try [draft, try fixtureDraft(name: "a.md", kind: .text, data: Data("a".utf8)), try fixtureDraft(name: "a.pdf", kind: .file, data: Data("%PDF".utf8))]
        .map { try NativeJSON.decode(PhoneAttachments.uploadStart($0, selection: .object([:]), sessionId: nil)) }
    result["declared"] = declared.map { $0["kind"].string ?? "" }
    result["declaredHash"] = declared[0]["sha256"].string == LinkBytes.hex(LinkBytes.hash(Data(count: 10)))
    let write = try NativePendingWrite(method: .post, path: "/link/api/tasks/ses_1/prompt", fields: ["prompt": .string("看图"), "attachmentIds": .array([.string("a"), .string("b")])])
    result["pendingCount"] = PhoneAttachments.count(write)

    // Staged on disk, not in memory: a random name in this App's temporary folder, excluded from backup, read back in
    // bounded chunks, and gone when the Host keeps it, its row goes, the tray clears, or everything is purged.
    let stageFolder = PhoneAttachStage.folder(temporary: fixtureTemporary)
    func exists(_ file: PhoneStagedFile?) -> Bool { file.map { FileManager.default.fileExists(atPath: $0.url.path) } ?? false }
    let photoBytes = try PhoneImagePrep.prepare(data: try fixturePhoto(width: 800, height: 600), limit: PhoneAttachments.streamBytes).data
    var memory = PhoneAttachTray()
    let photoRow = try fixtureDraft(name: "p.jpg", kind: .image, data: photoBytes), pendingRow = try fixtureDraft(name: "q.txt", kind: .text, data: Data("q".utf8))
    let clearedRow = try fixtureDraft(name: "c.bin", kind: .file, data: Data([0, 1, 2]))
    let photoFile = photoRow.file, pendingFile = pendingRow.file
    _ = memory.add(photoRow); _ = memory.add(pendingRow)
    memory.started(photoRow.id, upload: String(repeating: "u", count: 22)); memory.started(pendingRow.id, upload: String(repeating: "v", count: 22))
    memory.started(pendingRow.id, upload: "not an id")
    let unfinishedBefore = memory.unfinishedUploads
    let before = memory.stagedBytes
    let backup = (try? stageFolder.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup == true
    let chunk = try PhoneAttachStage.read(photoFile!, offset: 2, count: 5)
    _ = memory.ready(photoRow.id, ref: .object(["id": .string(String(repeating: "a", count: 22)), "name": .string("p.jpg"), "kind": .string("image"),
        "mime": .string("image/jpeg"), "size": .number(Double(photoBytes.count)), "sha256": .string(String(repeating: "0", count: 64))]))
    let kept = memory.items[0], afterReady = memory.unfinishedUploads.count
    let removed = memory.removeRow(pendingRow.id)
    var clearing = PhoneAttachTray(); _ = clearing.add(clearedRow); clearing.clear()
    let orphan = try PhoneAttachStage.write(Data("left".utf8), temporary: fixtureTemporary)
    let mode = ((try? FileManager.default.attributesOfItem(atPath: orphan.url.path))?[.posixPermissions] as? NSNumber)?.intValue ?? 0
    let purged = PhoneAttachStage.purge(temporary: fixtureTemporary)
    result["stage"] = [
        "folder": photoFile!.url.deletingLastPathComponent().lastPathComponent, "random": UUID(uuidString: photoFile!.url.lastPathComponent) != nil,
        "backup": backup, "mode": String(mode, radix: 8),
        "hash": photoFile!.sha256 == LinkBytes.hex(LinkBytes.hash(photoBytes)), "chunk": chunk == photoBytes.subdata(in: 2..<7),
        "past": (try? PhoneAttachStage.read(photoFile!, offset: photoBytes.count - 1, count: 2)) == nil,
        "readyGone": !exists(photoFile), "removedGone": !exists(pendingFile), "clearedGone": !exists(clearedRow.file),
        "purged": purged > 0, "orphanGone": !exists(orphan),
    ]
    result["memory"] = [
        "unfinishedBefore": unfinishedBefore.count,
        "dropped": kept.file == nil && kept.size == photoBytes.count && (kept.thumbnail?.count ?? 0) > 0,
        "smaller": memory.stagedBytes < before,
        "unfinishedAfter": afterReady,
        "removedUpload": removed.upload == String(repeating: "v", count: 22) && removed.attachment == nil,
        "staged": [PhoneAttachments.admitStaged(staged: PhoneAttachments.stagedLimit - 10, adding: 11) ?? "ok",
                   PhoneAttachments.admitStaged(staged: 0, adding: 50 * 1_048_576) ?? "ok"],
    ]
    result["chips"] = PhoneAttachments.chips(.object(["attachments": .array([
        .object(["id": .string("img000000000000000000a"), "name": .string("shot.png"), "mime": .string("image/png"), "kind": .string("image"), "size": .number(204_800), "sha256": .string(String(repeating: "b", count: 64))]),
        .object(["id": .string("img000000000000000000b"), "name": .string("anim.gif"), "mime": .string("image/gif"), "kind": .string("image"), "size": .number(100), "sha256": .string(String(repeating: "c", count: 64))]),
        .object(["id": .string("pdf000000000000000000c"), "name": .string("spec.pdf"), "mime": .string("application/pdf"), "kind": .string("file"), "size": .number(2_097_152), "sha256": .string(String(repeating: "d", count: 64))]),
        .object(["id": .string("bad"), "name": .string("x"), "kind": .string("text"), "size": .number(1), "sha256": .string("short")]),
    ])])).map { "\($0.name)|\($0.image)|\($0.size)|\($0.opens)|\($0.icon.rawValue)" }

    // The file and camera paths: pixels only for pictures, any other file moved into the stage and read once by its
    // content; the picker's copy is gone either way, and a file past the limit is never read.
    let folder = fixtureTemporary.appendingPathComponent("pick-" + UUID().uuidString)
    let inbox = folder.appendingPathComponent("codes.latch.ios-Inbox")
    try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
    // A keyboard that vends only PNG bytes must stage exactly the same metadata-free pixels as the file picker.
    let pastePng = try fixturePhoto(width: 120, height: 90, alpha: true)
    let pasteURL = folder.appendingPathComponent("paste-source.png")
    try pastePng.write(to: pasteURL)
    let pasteDataImage = PhoneAttachLoader.image(data: pastePng, name: "screen.png", limit: PhoneAttachments.streamBytes, temporary: folder)
    let pasteFileImage = PhoneAttachLoader.image(url: pasteURL, name: "screen.png", limit: PhoneAttachments.streamBytes, temporary: folder)
    guard let pasteStage = pasteDataImage.file, let fileStage = pasteFileImage.file else { throw NativeFailure.unavailable }
    let pastePixels = try Data(contentsOf: pasteStage.url)
    let excess = PhoneImagePrep.sourceBytes + 1
    let refusedPaste = PhoneAttachLoader.image(data: Data(count: excess), name: "large.png", limit: PhoneAttachments.streamBytes, temporary: folder)
    result["pastedPng"] = [
        pasteStage.sha256 == fileStage.sha256, pastePixels != pastePng, metadataKeys(pastePixels).isEmpty,
        refusedPaste.file == nil && refusedPaste.size == excess,
    ]
    PhoneAttachStage.remove(pasteStage); PhoneAttachStage.remove(fileStage)
    try FileManager.default.removeItem(at: pasteURL)
    var picks: [String: Data] = [
        "IMG_9001.JPG": try fixturePhoto(width: 1200, height: 900), "big.log": Data(repeating: 0x61, count: 300_000), "note.md": Data("# 笔记\n".utf8),
        "deck.pdf": Data("%PDF-1.7\n%\u{e2}\u{e3}\n1 0 obj\n".utf8), "page.html": Data("<!doctype html><p>你好</p>\n".utf8), "blob.bin": Data([0, 1, 2, 3, 0xff, 0xfe]),
        "nul.txt": Data([0x61, 0x00, 0x62]), "latin.txt": Data([0xff, 0xfe, 0x41]), "icon.svg": Data(#"<svg xmlns="http://www.w3.org/2000/svg"/>"#.utf8),
        "fake.png": Data("not a picture at all".utf8),
    ]
    // A three-byte character split across the first 1 MiB chunk: still text.
    picks["split.txt"] = Data(repeating: 0x61, count: PhoneAttachStage.chunkBytes - 1) + Data("中文".utf8)
    for (name, data) in picks { try data.write(to: inbox.appendingPathComponent(name)) }
    func pick(_ name: String, largest: Int = 52_428_800) -> PhonePicked {
        PhoneAttachLoader.file(url: inbox.appendingPathComponent(name), imageLimit: PhoneAttachments.streamBytes, largest: largest, temporary: fixtureTemporary)
    }
    let fromFile = pick("IMG_9001.JPG"), fromBig = pick("big.log", largest: 262_144)
    var kinds: [String: String] = [:]
    for name in ["note.md", "deck.pdf", "page.html", "blob.bin", "nul.txt", "latin.txt", "icon.svg", "fake.png", "split.txt"] {
        let picked = pick(name)
        kinds[name] = (picked.kind?.rawValue ?? "-") + (picked.file.map { $0.size == picks[name]!.count && $0.sha256 == LinkBytes.hex(LinkBytes.hash(picks[name]!)) ? "" : ":bad" } ?? ":none")
    }
    let fromCamera = PhoneAttachLoader.camera(try fixturePhoto(width: 1600, height: 1200), limit: PhoneAttachments.streamBytes, temporary: fixtureTemporary)
    let fileMetadata = fromFile.file.flatMap { try? Data(contentsOf: $0.url) }.map(metadataKeys) ?? ["none"]
    let cameraMetadata = fromCamera.file.flatMap { try? Data(contentsOf: $0.url) }.map(metadataKeys) ?? ["none"]
    let leftAfterReads = try FileManager.default.contentsOfDirectory(atPath: inbox.path)
    // 50 MB exactly is staged; a byte more is refused by its size and never read.
    let edge = inbox.appendingPathComponent("edge.bin"), over = inbox.appendingPathComponent("over.bin")
    for (url, size) in [(edge, 52_428_800), (over, 52_428_801)] {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url); try handle.truncate(atOffset: UInt64(size)); try handle.close()
    }
    let atEdge = pick("edge.bin"), pastEdge = pick("over.bin")
    let boundary = [atEdge.file?.size ?? -1, pastEdge.file?.size ?? -1, pastEdge.size]
    PhoneAttachStage.remove(atEdge.file)
    // A copy whose callback never came, and every staged file, are purged at launch.
    try Data("left".utf8).write(to: inbox.appendingPathComponent("orphan.txt"))
    let stagedBefore = (try? FileManager.default.contentsOfDirectory(atPath: stageFolder.path).count) ?? 0
    let purgedAll = PhoneAttachLoader.purgeInbox(temporary: folder) + PhoneAttachLoader.purgeInbox(temporary: fixtureTemporary)
    result["loader"] = [
        "file": fileMetadata, "fileName": fromFile.name, "fileKind": fromFile.kind?.rawValue ?? "-",
        "thumbnail": (fromFile.thumbnail?.count ?? 0) > 0,
        "camera": cameraMetadata, "cameraName": fromCamera.name,
        "bigStaged": fromBig.file != nil, "bigKind": fromBig.kind?.rawValue ?? "-", "bigSize": fromBig.size, "kinds": kinds, "left": leftAfterReads.sorted(),
        "boundary": boundary, "purged": purgedAll == stagedBefore + 1,
        "afterPurge": ((try? FileManager.default.contentsOfDirectory(atPath: inbox.path)) ?? ["?"]) + ((try? FileManager.default.contentsOfDirectory(atPath: stageFolder.path)) ?? []),
    ]
    // Above 40 megapixels, as the Host refuses: said before any full decode, and never sent as the original instead.
    let huge = folder.appendingPathComponent("huge.png")
    if let context = CGContext(data: nil, width: 8000, height: 5100, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceGray(),
        bitmapInfo: CGImageAlphaInfo.none.rawValue), let image = context.makeImage(),
       let destination = CGImageDestinationCreateWithURL(huge as CFURL, UTType.png.identifier as CFString, 1, nil) {
        CGImageDestinationAddImage(destination, image, nil); _ = CGImageDestinationFinalize(destination)
    }
    let hugeCopy = inbox.appendingPathComponent("huge.png")
    try FileManager.default.copyItem(at: huge, to: hugeCopy)
    let hugeFromFiles = pick("huge.png")
    result["hugeImage"] = [PhoneAttachLoader.image(url: huge, name: "huge.png", limit: PhoneAttachments.streamBytes, temporary: fixtureTemporary).failure ?? "",
        (hugeFromFiles.kind?.rawValue ?? "-") + ":" + (hugeFromFiles.file == nil ? "unstaged" : "staged") + ":" + (hugeFromFiles.failure ?? "")]
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
    _ = sendTray.add(try fixtureDraft(name: "a.txt", kind: .text, data: Data("a".utf8)))
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
    defer { try? FileManager.default.removeItem(at: directory); try? FileManager.default.removeItem(at: fixtureTemporary) }
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
        do { _ = try await workspace.uploadAttachment(try fixtureDraft(name: "a.txt", kind: .text, data: Data("a".utf8)), selection: selection, sessionId: nil) }
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
        let photo = try fixtureDraft(name: PhoneAttachments.fileName("IMG_0001.HEIC", ext: prepared.ext), kind: .image, data: prepared.data)
        let progress = FixtureTransfer()
        let ref = try await workspace.uploadAttachment(photo, selection: selection, sessionId: first) { done, total in progress.progress(done, total) }
        _ = try progress.result()
        let again = try await workspace.uploadAttachment(photo, selection: selection, sessionId: first)
        result["sameRequest"] = ref["id"] == again["id"] && ref["kind"].string == "image" && ref["mime"].string == "image/jpeg"
        let note = try fixtureDraft(name: "notes.md", kind: .text, data: Data("# 笔记\n只有文字。\n".utf8))
        let noteRef = try await workspace.uploadAttachment(note, selection: selection, sessionId: first)

        // Cancelled after its first chunk: no chunk after that, and the Host kept nothing of it, so the same request with
        // other bytes is a fresh upload rather than a conflict.
        stage = "cancel-mid"
        let mid = try fixtureDraft(name: "mid.txt", kind: .text, data: Data(repeating: 0x62, count: PhoneAttachments.streamBytes))
        let chunks = FixtureChunks()
        let midTask = Task { try await workspace.uploadAttachment(mid, selection: selection, sessionId: first) { done, _ in chunks.saw(done) } }
        chunks.onFirst = { midTask.cancel() }
        var midStopped = false
        do { _ = try await midTask.value } catch { midStopped = error is CancellationError }
        result["cancelMid"] = ["stopped": midStopped, "afterCancel": chunks.afterCancel, "partial": chunks.last < PhoneAttachments.streamBytes]
        // Cancel closes the stream and waits; the next upload goes through.
        stage = "cancel"
        let big = try fixtureDraft(name: "big.txt", kind: .text, data: Data(repeating: 0x61, count: PhoneAttachments.streamBytes))
        let cancelled = Task { try await workspace.uploadAttachment(big, selection: selection, sessionId: first) }
        cancelled.cancel()
        var stopped = false
        do { _ = try await cancelled.value } catch { stopped = error is CancellationError }
        let after = try await workspace.uploadAttachment(try fixtureDraft(name: "after.txt", kind: .text, data: Data("after".utf8)), selection: selection, sessionId: first)
        result["cancel"] = stopped && PhoneAttachments.validRef(after)
        try await workspace.removeAttachment(after["id"].string ?? "")

        // More than any Host takes is refused here, before anything is sent.
        var oversize = false
        do { _ = try await workspace.uploadAttachment(try fixtureDraft(name: "over.txt", kind: .text, data: Data(count: PhoneAttachments.largestFile + 1)), selection: selection, sessionId: first) }
        catch { oversize = (error as? NativeFailure) == .invalidRecord }
        result["oversize"] = oversize

        // Over one stream: parts of 1 MiB, one stream each; the Host assembles the file and checks its hash.
        stage = "chunked"
        func letters(_ count: Int, shift: Int) -> Data { Data((0..<count).map { $0 % 64 == 63 ? 0x0a : UInt8(97 + ($0 + shift) % 26) }) }
        let longData = letters(3 * PhoneAttachments.streamBytes, shift: 0)
        let long = try fixtureDraft(name: "long.log", kind: .text, data: longData)
        let longProgress = FixtureTransfer()
        let longRef = try await workspace.uploadAttachment(long, selection: selection, sessionId: first) { done, total in longProgress.progress(done, total) }
        _ = try longProgress.result()
        // The same request again is answered by the Host without a part being sent.
        let resent = FixtureCross(threshold: 0)
        let longAgain = try await workspace.uploadAttachment(long, selection: selection, sessionId: first) { done, _ in resent.saw(done) }
        // Any file goes where the Host takes files: a PDF as its own bytes, and text past 256 KB, both declared files.
        stage = "files"
        let pdfData = Data("%PDF-1.7\n%\u{e2}\u{e3}\n1 0 obj\n".utf8), bigText = letters(300_000, shift: 11)
        let pdfRef = try await workspace.uploadAttachment(try fixtureDraft(name: "deck.pdf", kind: .file, data: pdfData), selection: selection, sessionId: first)
        let bigTextRef = try await workspace.uploadAttachment(try fixtureDraft(name: "trace.log", kind: .text, data: bigText), selection: selection, sessionId: first)
        result["files"] = [pdfRef["kind"].string ?? "", pdfRef["mime"].string ?? "", bigTextRef["kind"].string ?? "", String(bigTextRef["size"].integer ?? 0)]
        for ref in [pdfRef, bigTextRef] { try await workspace.removeAttachment(ref["id"].string ?? "") }
        result["chunked"] = [
            "kept": longRef["kind"].string == "text" && longRef["size"].integer == UInt64(long.size)
                && longRef["sha256"].string == LinkBytes.hex(LinkBytes.hash(longData)),
            "again": longAgain["id"] == longRef["id"] && resent.first == nil,
        ]
        // A large image, re-encoded under the Host's image limit rather than one stream's.
        stage = "large-image"
        let large = try PhoneImagePrep.prepare(data: try fixturePhoto(width: 2400, height: 1600, alpha: true), limit: PhoneAttachments.limit(.image, caps))
        let largeRef = try await workspace.uploadAttachment(try fixtureDraft(name: "large.png", kind: .image, data: large.data), selection: selection, sessionId: first)
        result["largeImage"] = large.data.count > PhoneAttachments.streamBytes && largeRef["mime"].string == "image/png"
            && largeRef["size"].integer == UInt64(large.data.count) && largeRef["width"].integer == UInt64(large.width)

        // The connection drops in the second part: the answer is unknown; the retry on a new path sends only what is missing.
        stage = "resume"
        let opened = try await NativeHTTPConnection.open(host: "127.0.0.1", port: port, rootSpki: device.rootSpki, knockKey: device.knockKey, identity: keys.identity())
        _ = try await workspace.install { opened }
        let resumableData = letters(3 * PhoneAttachments.streamBytes, shift: 7)
        let resumable = try fixtureDraft(name: "resume.log", kind: .text, data: resumableData)
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
            "kept": resumedRef["sha256"].string == LinkBytes.hex(LinkBytes.hash(resumableData)),
        ]

        // Cancel in the second part closes its stream, waits, and aborts the upload on the Host: the same request starts over.
        stage = "cancel-parts"
        let stopping = try fixtureDraft(name: "stop.log", kind: .text, data: letters(2 * PhoneAttachments.streamBytes + 10, shift: 13))
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
        let secret = try fixtureDraft(name: ".env", kind: .text, data: letters(PhoneAttachments.streamBytes + 100, shift: 3))
        let named = FixtureNamed()
        var secretCode = ""
        do { _ = try await workspace.uploadAttachment(secret, selection: selection, sessionId: first, started: { named.set($0) }) }
        catch let error as NativeHostRefusal { secretCode = error.code }
        if let upload = named.value { await workspace.abortAttachmentUpload(upload) }
        // Cancelled before its start is answered: the start still lands, and the upload it began is aborted.
        stage = "cancel-begin"
        let beforeBegin = try fixtureDraft(name: "early.log", kind: .text, data: letters(PhoneAttachments.streamBytes + 100, shift: 5))
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

        // A Harness that reads neither natively: the Host still takes every file, by its path, so the phone offers both kinds
        // and the upload goes through.
        stage = "plain"
        let plain = try await start("plain", "hello")
        _ = try await idle(plain)
        let plainSelection = PhoneAttachments.selection(harnessId: "plain", workspaceId: "default", model: nil)
        let plainCaps = try await workspace.attachmentCapabilities(selection: plainSelection, sessionId: plain)
        result["plainReason"] = PhoneAttachments.unavailable(caps: plainCaps, harness: .null, failed: false) ?? ""
        result["plainOffers"] = plainCaps.takesImages && plainCaps.takesText && PhoneAttachments.admit(kind: .text, name: "notes.md", size: 10, count: 0, caps: plainCaps) == nil
        var plainTaken = false
        do { plainTaken = try await workspace.uploadAttachment(note, selection: plainSelection, sessionId: plain)["kind"].string == "text" }
        catch let error as NativeHostRefusal { result["plainRefusal"] = error.code }
        result["plainTaken"] = plainTaken
        // A refusal the Host gives before the body is in is its answer, not an unknown result, however many chunks were left:
        // a picture declared past the 5 MB a model is shown is refused at the start, as permanent.
        var early = ""
        do { _ = try await workspace.uploadAttachment(try fixtureDraft(name: "large.jpg", kind: .image, data: Data(repeating: 0x63, count: 5 * 1_048_576 + 1)),
                selection: plainSelection, sessionId: plain) }
        catch let error as NativeHostRefusal { early = error.code + ":" + (PhoneAttachments.classify(error.code) == .refused ? "refused" : "other") }
        catch { early = String(describing: error) }
        result["earlyRefusal"] = early

        // This turn settled before enqueue: the queued request delivers its uploaded file immediately.
        stage = "queue"
        let extra = try await workspace.uploadAttachment(try fixtureDraft(name: "q.txt", kind: .text, data: Data("q".utf8)), selection: selection, sessionId: first)
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

/** Only a picture, queued during a turn and still attached to that session after reading another. */
@MainActor func queuedScreenshotFixture(_ workspace: NativeWorkspace, target: String, other: String, marker: URL) async throws -> [String: Any] {
    defer { try? FileManager.default.removeItem(at: fixtureTemporary) }
    func open(_ id: String) async throws -> NativeJSON {
        let reading = try await workspace.beginBody(id)
        let update = try await workspace.readBody(for: reading)
        var detail = NativeJSON.null
        guard let receipt = reading.publication.apply(update, to: { value in detail = value.detail ?? .null; return true }) else {
            throw FixtureStage(name: "open screenshot session")
        }
        try await workspace.applied(receipt)
        return detail
    }
    guard try await workspace.snapshot()["catalog"]["features"]["queueAttachments"].bool,
          try await open(target)["summary"]["status"].string == "running" else { throw FixtureStage(name: "screenshot target") }
    let selection = PhoneAttachments.selection(harnessId: "standard", workspaceId: nil, model: nil)
    let caps = try await workspace.attachmentCapabilities(selection: selection, sessionId: target)
    let source = fixtureTemporary.appendingPathComponent("clipboard.png")
    try fixturePhoto(width: 16, height: 12, alpha: true).write(to: source)
    let picked = PhoneAttachLoader.image(url: source, name: "screen.png", limit: PhoneAttachments.limit(.image, caps), temporary: fixtureTemporary)
    guard picked.kind == .image, let file = picked.file else { throw FixtureStage(name: "screenshot intake") }
    let originalImage = try PhoneAttachStage.read(file, offset: 0, count: file.size)
    let shot = PhoneAttachDraft(name: picked.name, kind: .image, file: file, thumbnail: picked.thumbnail)
    var tray = PhoneAttachTray()
    guard tray.add(shot) else { throw FixtureStage(name: "screenshot tray") }
    let plan = PhoneAttachSend(target: target, tray: tray)
    let ref = try await workspace.uploadAttachment(shot, selection: selection, sessionId: target)
    guard tray.ready(shot.id, ref: ref), case let .success(ids) = plan.finish(current: target, tray: tray, caps: caps),
          ids.count == 1, ref["id"].string == ids.first else { throw FixtureStage(name: "screenshot upload") }
    let request = try NativePendingWrite(method: .post, path: "/link/api/tasks/" + target + "/prompt",
        fields: ["prompt": .string(""), "queue": .bool(true), "attachmentIds": .array(ids.map { .string($0) })])
    _ = try await workspace.submit(request, explain: true)
    tray.clear()
    let original = try await workspace.detail(target)
    guard original["queue"].array.count == 1, let item = original["queue"].array.first, item["state"].string == "waiting",
          item["text"].string == "", item["attachmentCount"].integer == 1 else { throw FixtureStage(name: "screenshot waiting") }
    let elsewhere = try await open(other)
    guard elsewhere["queue"].array.isEmpty, elsewhere["messages"].array.allSatisfy({ $0["attachments"].array.isEmpty }),
          try await open(target)["queue"].array.first == item else { throw FixtureStage(name: "screenshot after switching") }
    // The local test model may finish its first turn only after the phone saw the same waiting item on return.
    try Data().write(to: marker, options: .atomic)
    for _ in 0..<200 {
        let detail = try await workspace.detail(target)
        let photos = detail["messages"].array.filter { $0["role"].string == "user" && !$0["attachments"].array.isEmpty }
        if detail["summary"]["status"].string == "idle", detail["queue"].array.isEmpty, let photo = photos.first {
            guard photos.count == 1, photo["text"].string == "", photo["attachments"].array.map({ $0["id"] }) == [ref["id"]] else {
                throw FixtureStage(name: "screenshot transcript")
            }
            _ = try await workspace.submit(request, explain: true)
            await workspace.closeOpening()
            return ["original": originalImage.base64EncodedString(), "id": ids[0]]
        }
        try await Task.sleep(for: .milliseconds(25))
    }
    throw FixtureStage(name: "screenshot queued delivery")
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
