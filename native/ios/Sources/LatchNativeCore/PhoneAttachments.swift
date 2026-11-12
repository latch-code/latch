import Foundation
import ImageIO
import UniformTypeIdentifiers

/** What the Host says this composer's Harness and model take (`POST /attachments/capabilities`). */
public struct PhoneAttachCaps: Equatable, Sendable {
    public let images: Bool
    public let text: Bool
    public let textBytes: Int
    public let fileBytes: Int
    public let imageBytes: Int
    public let reason: String?
    public init(images: Bool, text: Bool, textBytes: Int, fileBytes: Int = 10 * 1_048_576, imageBytes: Int = 5 * 1_048_576, reason: String? = nil) {
        self.images = images; self.text = text; self.textBytes = textBytes; self.fileBytes = fileBytes; self.imageBytes = imageBytes; self.reason = reason
    }
    /** From `{ capabilities }`; nil when the answer is not one. */
    public static func parse(_ value: NativeJSON) -> PhoneAttachCaps? {
        let caps = value["capabilities"]
        guard case let .bool(images) = caps["images"], case let .bool(text) = caps["text"], let textBytes = caps["textBytes"].integer else { return nil }
        let bound = { (value: NativeJSON, fallback: Int) in value.integer.map { Int(min($0, 25 * 1_048_576)) } ?? fallback }
        return PhoneAttachCaps(images: images, text: text, textBytes: Int(min(textBytes, 25 * 1_048_576)),
            fileBytes: bound(caps["fileBytes"], 10 * 1_048_576), imageBytes: bound(caps["imageBytes"], 5 * 1_048_576),
            reason: caps["reason"].string.map { String($0.prefix(400)) })
    }
    public var any: Bool { images || text }
}

public enum PhoneAttachKind: String, Equatable, Sendable { case image, text }

/** A row of the composer's attachments. `unknown`: the upload's answer never came; 重试 sends the same bytes under the same requestId. */
public enum PhoneAttachStatus: Equatable, Sendable {
    case preparing
    case uploading(Double)
    case ready
    case failed(String)
    case unknown
    /** The Host will not take this file as it is; only 移除 helps. */
    case refused(String)
    /** The Host asks before it keeps a file that may hold a secret. */
    case confirm(String)
}

public struct PhoneAttachDraft: Equatable, Sendable, Identifiable {
    public let id: UUID
    /** One upload request; the same for every retry of these bytes. */
    public let requestId: String
    public let name: String
    public let kind: PhoneAttachKind
    public let data: Data
    public var status: PhoneAttachStatus
    public var ref: NativeJSON?
    public var secretAcknowledged = false
    public init(name: String, kind: PhoneAttachKind, data: Data) {
        id = UUID(); requestId = UUID().uuidString.lowercased(); self.name = name; self.kind = kind; self.data = data; status = .preparing
    }
    public var size: Int { data.count }
    /** The Host's attachment ID, once it kept the file. */
    public var attachmentId: String? { ref?["id"].string }
}

/** How a Host answer to an upload or send is shown. */
public enum PhoneAttachFailure: Equatable, Sendable {
    /** Type, size or capability: holds however often it is sent. */
    case refused
    /** `attachment-released`: the Host proves the message was not delivered; the text goes back. */
    case released
    case confirm
    case retry
}

/**
 * The composer's attachments for one place (a session, or the new-session sheet). Bytes live only in memory, never in a
 * file, and go with the window: `clear` is called on lock, removal and window close.
 */
public struct PhoneAttachTray: Equatable, Sendable {
    public private(set) var items: [PhoneAttachDraft] = []
    /** Why ＋ cannot add, or why a pick was not added; shown next to the input, as there is no hover on a phone. */
    public var note: String?
    public init() {}
    public var isEmpty: Bool { items.isEmpty }
    public var busy: Bool { items.contains { if case .uploading = $0.status { true } else { $0.status == .preparing } } }
    /** False with a note when the message already holds eight. */
    public mutating func add(_ draft: PhoneAttachDraft) -> Bool {
        guard items.count < PhoneAttachments.perMessage else { note = PhoneAttachments.tooMany; return false }
        items.append(draft); return true
    }
    public mutating func set(_ id: UUID, _ status: PhoneAttachStatus) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].status = status
    }
    public mutating func ready(_ id: UUID, ref: NativeJSON) -> Bool {
        guard let index = items.firstIndex(where: { $0.id == id }), PhoneAttachments.validRef(ref) else { return false }
        items[index].ref = ref; items[index].status = .ready; return true
    }
    public mutating func acknowledge(_ id: UUID) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].secretAcknowledged = true
    }
    /** A Host answer to this row's upload. `cancelled`: the person stopped it. */
    public mutating func failed(_ id: UUID, refusal: NativeHostRefusal?, unknown: Bool = false, cancelled: Bool = false) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        if cancelled { items[index].status = .failed("上传已取消，可以重试。"); return }
        if unknown { items[index].status = .unknown; return }
        let words = refusal.map { $0.message.isEmpty ? "附件没有上传。" : $0.message } ?? "附件没有上传，可以重试。"
        switch PhoneAttachments.classify(refusal?.code) {
        case .refused, .released: items[index].status = .refused(words)
        case .confirm: items[index].status = .confirm(words)
        case .retry: items[index].status = .failed(words)
        }
    }
    /** The row goes; its Host attachment ID comes back to drop the draft there. */
    public mutating func remove(_ id: UUID) -> String? {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
        return items.remove(at: index).attachmentId
    }
    /** Everything goes with its bytes; the Host's IDs come back. */
    @discardableResult public mutating func clear() -> [String] {
        let ids = items.compactMap(\.attachmentId); items = []; note = nil; return ids
    }
    /** The Host released these uploads in 设置 › 设备: each row says so and can only be removed. */
    public mutating func markReleased() {
        for index in items.indices where items[index].ref != nil { items[index].status = .refused(PhoneAttachments.releasedWords) }
    }
    /** The IDs to send, or why not yet. */
    public func sendable(_ caps: PhoneAttachCaps?) -> Result<[String], PhoneAttachBlock> {
        if items.isEmpty { return .success([]) }
        if busy { return .failure(.waiting) }
        if items.contains(where: { if case .refused = $0.status { true } else { false } }) { return .failure(.reason("有附件不能发送，请移除后再发送。")) }
        guard items.allSatisfy({ $0.status == .ready && $0.attachmentId != nil }) else { return .failure(.reason("附件尚未准备好。请重试失败的文件，或移除后发送。")) }
        guard let caps, items.allSatisfy({ $0.kind == .image ? caps.images : caps.text && $0.size <= caps.textBytes }) else {
            return .failure(.reason(caps?.reason ?? "当前 Harness 不接受这些附件。请移除附件或更换模型。"))
        }
        return .success(items.compactMap(\.attachmentId))
    }
}

public enum PhoneAttachBlock: Error, Equatable, Sendable {
    /** An upload is still on its way; sending waits for it. */
    case waiting
    case reason(String)
}

/** What a picker handed back: nothing because the person cancelled, nothing at all (lost), or this many files. */
public enum PhoneAttachPick: Equatable, Sendable {
    case cancelled
    /** The picker went away without a callback. */
    case lost
    case files(Int)
}

/** The same rules as the web composer, plus this phone's one-stream bound. The Host checks every one again. */
public enum PhoneAttachments {
    public static let pickedNothing = "没有收到选中的文件，请再选一次。"
    /** A pick that yields nothing always says so; only a cancel is silent. */
    public static func pickNote(_ pick: PhoneAttachPick) -> String? {
        switch pick {
        case .cancelled: nil
        case .lost, .files(0): pickedNothing
        case .files: nil
        }
    }
    /** The selection an upload is checked against, taken from a start's own fields (新会话 or a new topic). */
    public static func selection(startFields fields: [String: NativeJSON]) -> NativeJSON? {
        guard case .string = fields["harnessId"] ?? .null else { return nil }
        var value: [String: NativeJSON] = [:]
        for key in ["harnessId", "workspaceId", "mode"] { if case .string = fields[key] ?? .null { value[key] = fields[key] } }
        if case let .object(model) = fields["model"] ?? .null {
            value["model"] = .object(model.filter { ["providerId", "model", "effort"].contains($0.key) })
        }
        return .object(value)
    }
    public static let perMessage = 8
    /** One upload is one stream, and a native stream carries at most 1 MiB. */
    public static let streamBytes = 1_048_576
    public static let tooMany = "每条消息最多添加 8 个附件。"
    public static let releasedWords = "已在 设置 › 设备 里释放，请移除后重新添加"
    /** The Host takes a queued or steered message as text only (`queue-attachments-unsupported`). */
    public static func heldBack(_ followUp: PhoneFollowUp, running: Bool, count: Int) -> String? {
        guard running, count > 0, followUp == .queue || followUp == .steer else { return nil }
        return "\(followUp == .steer ? "追加" : "排队")的消息不能带附件，本轮结束后再发送。"
    }
    private static let refused: Set<String> = [
        "attachment-invalid", "attachment-too-large", "attachment-type-unsupported", "attachment-image-unsupported", "attachment-image-invalid",
        "attachment-text-invalid", "attachment-text-unsupported", "attachment-text-too-large", "attachments-unsupported",
    ]
    /** By code, not status: `attachment-incomplete` is a 400 that a retry fixes. */
    public static func classify(_ code: String?) -> PhoneAttachFailure {
        guard let code else { return .retry }
        if code == "attachment-released" { return .released }
        if code == "attachment-secret" { return .confirm }
        return refused.contains(code) ? .refused : .retry
    }
    /** The largest file of this kind this phone sends: the Host's limits and one stream. */
    public static func limit(_ kind: PhoneAttachKind, _ caps: PhoneAttachCaps) -> Int {
        min(streamBytes, caps.fileBytes, kind == .image ? caps.imageBytes : caps.textBytes)
    }
    public static func sizeText(_ bytes: Int) -> String {
        bytes >= 1_048_576 ? "\(Int((Double(bytes) / 1_048_576).rounded())) MB" : "\(max(1, Int((Double(bytes) / 1024).rounded()))) KB"
    }
    /** The ＋ menu's line: what may be attached, in the web's words; empty when nothing can be. */
    public static func limitsLine(_ caps: PhoneAttachCaps?) -> String {
        guard let caps, caps.any else { return "" }
        return [caps.images ? "图片 \(sizeText(limit(.image, caps))) 内" : nil, caps.text ? "文字文件 \(sizeText(limit(.text, caps))) 内" : nil, "每条 8 个"]
            .compactMap { $0 }.joined(separator: " · ")
    }
    /**
     * Why pressing ＋ adds nothing, said next to the input; nil when it can. Before the Host answers, the snapshot's
     * `attachmentsReported` already says when the Harness takes neither.
     */
    public static func unavailable(caps: PhoneAttachCaps?, harness: NativeJSON, failed: Bool) -> String? {
        if let caps { return caps.any ? nil : caps.reason ?? "当前 Harness 不接收附件。" }
        let reported = harness["attachmentsReported"]
        if case .object = reported, !reported["images"].bool, !reported["text"].bool { return "这个 Harness 不接收图片和文件。" }
        return failed ? "没能读取这个 Harness 能收的附件，稍后再试。" : "正在读取这个 Harness 能收的附件…"
    }
    /** What makes the ＋ re-read capabilities: the Harness's state and what it reported when it last started. */
    public static func revision(_ harness: NativeJSON) -> String {
        let reported = harness["attachmentsReported"]
        guard case .object = reported else { return (harness["status"].string ?? "") + ":-" }
        return (harness["status"].string ?? "") + ":" + (reported["images"].bool ? "i" : "") + (reported["text"].bool ? "t" : "")
    }
    /** What a file is by its type: images are re-encoded, text is sent as it is, anything else is not offered. */
    public static func kind(typeIdentifier: String) -> PhoneAttachKind? {
        guard let type = UTType(typeIdentifier) else { return nil }
        if type.conforms(to: .image) { return .image }
        if type.conforms(to: .pdf) || type.conforms(to: .rtf) || type.conforms(to: .html) { return nil }
        if type.conforms(to: .text) || type.conforms(to: .sourceCode) || type.conforms(to: .json) || type.conforms(to: .xml) || type.conforms(to: .propertyList) { return .text }
        return nil
    }
    /** Refused before any upload; nil when this file may be sent. `count`: rows already in the message. */
    public static func admit(kind: PhoneAttachKind?, name: String, size: Int, count: Int, caps: PhoneAttachCaps?) -> String? {
        guard count < perMessage else { return tooMany }
        guard let caps, caps.any else { return caps?.reason ?? "当前 Harness 不接收附件。" }
        guard let kind else { return "「\(shortName(name))」不能添加：只收图片和文字文件。" }
        guard size > 0 else { return "空文件不能添加。" }
        if kind == .image && !caps.images { return caps.reason ?? "当前模型不能看图片。" }
        if kind == .text && !caps.text { return caps.reason ?? "当前 Harness 不接收文字文件。" }
        let largest = kind == .image ? PhoneImagePrep.sourceBytes : limit(.text, caps)
        guard size <= largest else { return "「\(shortName(name))」超过 \(sizeText(largest))，没有添加。可以添加：\(limitsLine(caps))。" }
        return nil
    }
    /** After re-encoding, an image must still fit; text must decode as UTF-8 without NUL, as the Host requires. */
    public static func admitBytes(kind: PhoneAttachKind, name: String, data: Data, caps: PhoneAttachCaps) -> String? {
        if data.count > limit(kind, caps) { return "「\(shortName(name))」超过 \(sizeText(limit(kind, caps)))，没有添加。可以添加：\(limitsLine(caps))。" }
        if kind == .text, data.contains(0) || String(data: data, encoding: .utf8) == nil { return "「\(shortName(name))」不是 UTF-8 文字文件，没有添加。" }
        return nil
    }
    private static func shortName(_ name: String) -> String { name.count > 40 ? String(name.prefix(37)) + "…" : name }
    /** A name the Host takes: no path, no control characters, at most 200 characters with its extension. */
    public static func fileName(_ raw: String, ext: String? = nil) -> String {
        var base = raw.split(separator: "/").last.map(String.init) ?? ""
        base = String(base.unicodeScalars.filter { $0.value >= 32 && $0.value != 127 && !(0x202A...0x202E).contains($0.value) && !(0x2066...0x2069).contains($0.value) })
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let ext {
            if let dot = base.lastIndex(of: "."), dot != base.startIndex { base = String(base[..<dot]) }
            base = String((base.isEmpty ? "图片" : base).prefix(180)) + "." + ext
        } else if base.isEmpty || base == "." || base == ".." { base = "文件.txt" }
        return String(base.prefix(200))
    }
    /** The selection the Host checks an upload against: the new session's choice, or the open session's Harness. */
    public static func selection(harnessId: String, workspaceId: String?, model: PhoneModelChoice?) -> NativeJSON {
        var value: [String: NativeJSON] = ["harnessId": .string(harnessId)]
        if let workspaceId { value["workspaceId"] = .string(workspaceId); value["mode"] = .string("agent") } else { value["mode"] = .string("chat") }
        if let model { value["model"] = .object(["providerId": .string(model.providerId), "model": .string(model.model)]) }
        return .object(value)
    }
    public static func context(selection: NativeJSON, sessionId: String?) -> [String: NativeJSON] {
        var fields: [String: NativeJSON] = ["selection": selection]
        if let sessionId { fields["sessionId"] = .string(sessionId) }
        return fields
    }
    /** `x-latch-attachment`: base64url JSON of at most 4 KiB, as the Host reads it. */
    public static func header(_ draft: PhoneAttachDraft, selection: NativeJSON, sessionId: String?) throws -> String {
        var fields = context(selection: selection, sessionId: sessionId)
        fields["requestId"] = .string(draft.requestId); fields["name"] = .string(draft.name); fields["size"] = .number(Double(draft.size))
        if draft.secretAcknowledged { fields["secretAcknowledged"] = .bool(true) }
        let value = LinkBytes.base64url(try NativeJSON.object(fields).encoded())
        guard value.utf8.count <= 4096 else { throw NativeFailure.invalidRecord }
        return value
    }
    /** A Host `AttachmentRef`: only these keys, a fixed ID and hash. */
    public static func validRef(_ ref: NativeJSON) -> Bool {
        guard case let .object(fields) = ref, Set(fields.keys).isSubset(of: ["id", "name", "mime", "kind", "size", "sha256", "width", "height"]),
              let id = ref["id"].string, LinkBytes.matches(id, "[A-Za-z0-9_-]{22}"), let hash = ref["sha256"].string, LinkBytes.matches(hash, "[a-f0-9]{64}"),
              let name = ref["name"].string, !name.isEmpty, name.count <= 200, let size = ref["size"].integer, size > 0,
              ["image", "text"].contains(ref["kind"].string ?? "") else { return false }
        return true
    }
    /** A sent message's attachments, as chips: name, kind, size. */
    public static func chips(_ message: NativeJSON) -> [PhoneAttachChip] {
        message["attachments"].array.prefix(perMessage).compactMap { ref in
            guard validRef(ref), let id = ref["id"].string, let name = ref["name"].string, let size = ref["size"].integer else { return nil }
            let image = ref["kind"].string == "image"
            // Quick Look stays with plain text and redrawn PNG/JPEG (native/ios/AGENTS.md).
            let opens = image ? ["image/png", "image/jpeg"].contains(ref["mime"].string ?? "") : size <= 524_288
            return PhoneAttachChip(id: id, name: name, image: image, size: sizeText(Int(size)), opens: opens)
        }
    }
    /** The attachments a pending write carries. */
    public static func count(_ write: NativePendingWrite) -> Int { ((try? NativeJSON.decode(write.body))?["attachmentIds"].array.count) ?? 0 }
}

public struct PhoneAttachChip: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let image: Bool
    public let size: String
    /** Whether this phone previews it; other formats say so when tapped. */
    public let opens: Bool
}

/** An image ready to upload: re-encoded from its pixels alone, so location, camera and other metadata do not leave the phone. */
public struct PhoneImagePrepared: Equatable, Sendable {
    public let data: Data
    public let ext: String
    public let width: Int
    public let height: Int
}

public enum PhoneImagePrep {
    /** The largest original this phone reads before re-encoding. */
    public static let sourceBytes = 50 * 1_048_576
    /** As the Host: no image above 40 megapixels. Only a downsampled thumbnail is ever decoded, never the full image. */
    public static let maxPixels = 40_000_000
    /** Whether an image's header is within `maxPixels`; nil when it cannot be read. */
    public static func withinPixels(url: URL) -> Bool? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue else { return nil }
        return width * height <= Double(maxPixels)
    }
    public static func prepare(data: Data, limit: Int) throws -> PhoneImagePrepared {
        guard data.count <= sourceBytes, let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { throw NativeFailure.unsupported }
        return try prepare(source: source, limit: limit)
    }
    public static func prepare(url: URL, limit: Int) throws -> PhoneImagePrepared {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? Int.max
        guard size <= sourceBytes, let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { throw NativeFailure.unsupported }
        return try prepare(source: source, limit: limit)
    }
    /** Smaller sides and lower quality until it fits; PNG keeps transparency, everything else becomes JPEG. */
    static func prepare(source: CGImageSource, limit: Int) throws -> PhoneImagePrepared {
        guard CGImageSourceGetCount(source) > 0, let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue, let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
              width > 0, height > 0, width <= 100_000, height <= 100_000, width * height <= Double(maxPixels) else { throw NativeFailure.unsupported }
        let alpha = properties[kCGImagePropertyHasAlpha] as? Bool ?? false
        for side in [2048, 1600, 1280, 1024, 800, 640] {
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: min(side, Int(max(width, height))), kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true, kCGImageSourceShouldCache: false] as CFDictionary) else { throw NativeFailure.unsupported }
            for quality in alpha ? [1.0] : [0.82, 0.68] {
                let type = alpha ? UTType.png : UTType.jpeg
                let output = NSMutableData()
                guard let destination = CGImageDestinationCreateWithData(output, type.identifier as CFString, 1, nil) else { throw NativeFailure.unsupported }
                // Only the pixels: no source properties are copied, so EXIF, GPS, TIFF and maker notes are gone.
                CGImageDestinationAddImage(destination, image, alpha ? nil : [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
                guard CGImageDestinationFinalize(destination) else { throw NativeFailure.unsupported }
                if output.length <= limit { return PhoneImagePrepared(data: output as Data, ext: alpha ? "png" : "jpg", width: image.width, height: image.height) }
            }
        }
        throw NativeFailure.unsupported
    }
}

/** A picked file before it is checked: its bytes are read once, into memory, and the picker's copy is gone by then. */
public struct PhonePicked: Equatable, Sendable {
    public let name: String
    public let kind: PhoneAttachKind?
    public let data: Data?
    /** The original's size, for a refusal before reading or re-encoding it. */
    public let size: Int
    /** Why it could not be read or re-encoded; nil when `data` is there. */
    public var failure: String?
    public init(name: String, kind: PhoneAttachKind?, data: Data?, size: Int, failure: String? = nil) {
        self.name = name; self.kind = kind; self.data = data; self.size = size; self.failure = failure
    }
}

/**
 * Reading what a picker handed over. Bytes go to memory only: a file picker's copy is deleted whatever happens, images
 * keep their pixels alone, and a copy a picker left behind (its callback never came) is purged at launch.
 */
public enum PhoneAttachLoader {
    public static let unreadable = "没能读取这张图片，没有添加。"
    public static let tooManyPixels = "图片超过 4000 万像素，没有添加。"
    public static func image(url: URL, name: String, limit: Int) -> PhonePicked {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= PhoneImagePrep.sourceBytes else { return PhonePicked(name: name, kind: .image, data: nil, size: size) }
        if PhoneImagePrep.withinPixels(url: url) == false { return PhonePicked(name: name, kind: .image, data: nil, size: size, failure: tooManyPixels) }
        guard let prepared = try? PhoneImagePrep.prepare(url: url, limit: limit) else { return PhonePicked(name: name, kind: .image, data: nil, size: size, failure: unreadable) }
        return PhonePicked(name: PhoneAttachments.fileName(name, ext: prepared.ext), kind: .image, data: prepared.data, size: size)
    }
    /** The camera's photo: only its pixels, never its metadata dictionary. */
    public static func camera(_ encoded: Data?, limit: Int) -> PhonePicked {
        guard let encoded, let prepared = try? PhoneImagePrep.prepare(data: encoded, limit: limit) else {
            return PhonePicked(name: "照片", kind: .image, data: nil, size: 1, failure: unreadable)
        }
        return PhonePicked(name: PhoneAttachments.fileName("照片", ext: prepared.ext), kind: .image, data: prepared.data, size: encoded.count)
    }
    /** A document picker's copy in this App's own sandbox: read once into memory and removed. */
    public static func file(url: URL, imageLimit: Int, textLimit: Int) -> PhonePicked {
        defer { try? FileManager.default.removeItem(at: url) }
        let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey, .isRegularFileKey])
        let name = url.lastPathComponent, size = values?.fileSize ?? 0
        let kind = values?.contentType.flatMap { PhoneAttachments.kind(typeIdentifier: $0.identifier) }
            ?? UTType(filenameExtension: url.pathExtension).flatMap { PhoneAttachments.kind(typeIdentifier: $0.identifier) }
        guard values?.isRegularFile == true else { return PhonePicked(name: name, kind: nil, data: nil, size: size) }
        switch kind {
        case .image: return image(url: url, name: name, limit: imageLimit)
        case .text:
            guard size > 0, size <= textLimit, let handle = try? FileHandle(forReadingFrom: url) else { return PhonePicked(name: PhoneAttachments.fileName(name), kind: .text, data: nil, size: size) }
            defer { try? handle.close() }
            guard let data = (try? handle.read(upToCount: textLimit + 1)) ?? nil, data.count == size else {
                return PhonePicked(name: PhoneAttachments.fileName(name), kind: .text, data: nil, size: size, failure: "没能读取「\(name)」，没有添加。")
            }
            return PhonePicked(name: PhoneAttachments.fileName(name), kind: .text, data: data, size: size)
        case nil: return PhonePicked(name: name, kind: nil, data: nil, size: size)
        }
    }
    /** Copies a document picker left in `tmp/<bundle>-Inbox` when its callback never came. Returns how many went. */
    @discardableResult public static func purgeInbox(temporary: URL) -> Int {
        var removed = 0
        let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey]
        guard let folders = try? FileManager.default.contentsOfDirectory(at: temporary, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return 0 }
        for folder in folders.prefix(200) where folder.lastPathComponent.hasSuffix("-Inbox") {
            guard let values = try? folder.resourceValues(forKeys: Set(keys)), values.isDirectory == true, values.isSymbolicLink != true,
                  let items = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { continue }
            for item in items.prefix(2000) where (try? FileManager.default.removeItem(at: item)) != nil { removed += 1 }
        }
        return removed
    }
}

/** Which composer a write's attachments came from, and when that composer's attachments may not change. */
extension PhoneAttachments {
    public static let newSessionKey = "\u{0}new"
    public static func topicKey(_ owner: String) -> String { "\u{0}topic:" + owner }
    public static let lockedWords = "这条消息正在发送，附件确认前不能更改。"
    public static func key(of write: NativePendingWrite) -> String? {
        switch PhonePending.kind(write) {
        case .start: newSessionKey
        case let .topic(owner): topicKey(owner)
        case let .session(id): id
        default: nil
        }
    }
    /** Locked while its message is being sent, or an unconfirmed write carries attachments from it. */
    public static func locked(key: String, pending: [NativePendingWrite], sending: Bool) -> Bool {
        sending || pending.contains { count($0) > 0 && self.key(of: $0) == key }
    }
    /**
     * Whether closing a start's place (the sheet, a new topic) lets go of its attachments: not while a start is being
     * sent or the window is being opened for it, not while its write is unconfirmed, and not while a cover sits over it.
     */
    public static func dropsOnClose(key: String, pending: [NativePendingWrite], starting: Bool, verifying: Bool, covered: Bool) -> Bool {
        !starting && !verifying && !covered && !pending.contains { self.key(of: $0) == key }
    }
}

/**
 * One send with attachments: the target and the rows it waits on are fixed before the wait. After the wait it goes only
 * to that same place, and only with every one of those rows still there; otherwise nothing is sent and the reason is said.
 */
public struct PhoneAttachSend: Equatable, Sendable {
    public static let movedWords = "已切换到另一个会话，这条消息没有发送。"
    public static let goneWords = "附件已被撤下，这条消息没有发送，请重新添加。"
    /** The open session, or nil for a start. */
    public let target: String?
    public let rows: [UUID]
    public init(target: String?, tray: PhoneAttachTray) { self.target = target; rows = tray.items.map(\.id) }
    public func finish(current: String?, tray: PhoneAttachTray, caps: PhoneAttachCaps?) -> Result<[String], PhoneAttachBlock> {
        guard current == target else { return .failure(.reason(Self.movedWords)) }
        let present = Set(tray.items.map(\.id))
        guard rows.allSatisfy(present.contains) else { return .failure(.reason(Self.goneWords)) }
        return tray.sendable(caps)
    }
}
