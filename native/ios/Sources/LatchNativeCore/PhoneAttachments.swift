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
    /**
     * The Host takes every file for this Harness (`files`), what the agent cannot read natively by its path, so nothing is
     * refused for its type (the built-in Harness and every ACP agent).
     */
    public let files: Bool
    public init(images: Bool, text: Bool, textBytes: Int, fileBytes: Int = PhoneAttachments.largestFile, imageBytes: Int = 5 * 1_048_576, reason: String? = nil, files: Bool = false) {
        self.images = images; self.text = text; self.textBytes = textBytes; self.fileBytes = fileBytes; self.imageBytes = imageBytes; self.reason = reason
        self.files = files
    }
    /** From `{ capabilities }`; nil when the answer is not one. */
    public static func parse(_ value: NativeJSON) -> PhoneAttachCaps? {
        let caps = value["capabilities"]
        guard case let .bool(images) = caps["images"], case let .bool(text) = caps["text"], let textBytes = caps["textBytes"].integer else { return nil }
        let largest = UInt64(PhoneAttachments.largestFile)
        let bound = { (value: NativeJSON, fallback: Int) in value.integer.map { Int(min($0, largest)) } ?? fallback }
        return PhoneAttachCaps(images: images, text: text, textBytes: Int(min(textBytes, largest)),
            fileBytes: bound(caps["fileBytes"], PhoneAttachments.largestFile), imageBytes: bound(caps["imageBytes"], 5 * 1_048_576),
            reason: caps["reason"].string.map { String($0.prefix(400)) }, files: caps["files"].bool)
    }
    /** A picture is taken: natively, or by its path. */
    public var takesImages: Bool { images || files }
    /** A text file is taken: natively, or by its path. */
    public var takesText: Bool { text || files }
    public var any: Bool { images || text || files }
}

/**
 * What a picked file is on this phone: a picture it re-encoded, UTF-8 text, or any other file, sent as its own bytes and
 * taken only where the Host gives `files`. Only a re-encoded picture is declared `image` to the Host; text and files are
 * declared `file`, and the Host sniffs what they are.
 */
public enum PhoneAttachKind: String, Equatable, Sendable { case image, text, file }

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
    /** The bytes, staged on disk until the Host keeps the file; nil from then on (`PhoneAttachTray.ready`). */
    public internal(set) var file: PhoneStagedFile?
    public let size: Int
    /** A small redrawn picture for an image's row. */
    public let thumbnail: Data?
    public var status: PhoneAttachStatus
    public var ref: NativeJSON?
    public var secretAcknowledged = false
    /** The Host's chunked upload for these bytes while it is unfinished: removing the row aborts it there. */
    public var uploadId: String?
    public init(name: String, kind: PhoneAttachKind, file: PhoneStagedFile, thumbnail: Data? = nil) {
        id = UUID(); requestId = UUID().uuidString.lowercased(); self.name = name; self.kind = kind; self.file = file; size = file.size
        self.thumbnail = thumbnail; status = .preparing
    }
    /** Bytes this row keeps staged on disk. */
    public var stagedBytes: Int { file?.size ?? 0 }
    /** The type icon its row shows. */
    public var icon: PhoneAttachIcon { PhoneAttachments.icon(kind: kind.rawValue, mime: nil, name: name) }
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
 * The composer's attachments for one place (a session, or the new-session sheet). Bytes wait in staged files
 * (`PhoneAttachStage`), one per row, and go with the row: when the Host keeps it, on removal and on `clear`.
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
    /** The Host kept it: the staged file goes (an image keeps its small thumbnail), and nothing is left to abort. */
    public mutating func ready(_ id: UUID, ref: NativeJSON) -> Bool {
        guard let index = items.firstIndex(where: { $0.id == id }), PhoneAttachments.validRef(ref) else { return false }
        items[index].ref = ref; items[index].status = .ready; items[index].uploadId = nil
        PhoneAttachStage.remove(items[index].file); items[index].file = nil
        return true
    }
    /** The Host began a chunked upload for this row. */
    public mutating func started(_ id: UUID, upload: String) {
        guard let index = items.firstIndex(where: { $0.id == id }), items[index].ref == nil, LinkBytes.matches(upload, "[A-Za-z0-9_-]{22}") else { return }
        items[index].uploadId = upload
    }
    /** Bytes the rows of this tray keep staged on disk. */
    public var stagedBytes: Int { items.reduce(0) { $0 + $1.stagedBytes } }
    /** Unfinished chunked uploads of these rows on the Host, to abort when the rows go. */
    public var unfinishedUploads: [String] { items.compactMap { $0.ref == nil ? $0.uploadId : nil } }
    /** The row goes; what the Host holds for it comes back: its attachment ID, or its unfinished upload. */
    public mutating func removeRow(_ id: UUID) -> (attachment: String?, upload: String?) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return (nil, nil) }
        let row = items.remove(at: index)
        PhoneAttachStage.remove(row.file)
        return (row.attachmentId, row.ref == nil ? row.uploadId : nil)
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
        let row = items.remove(at: index)
        PhoneAttachStage.remove(row.file)
        return row.attachmentId
    }
    /** Everything goes with its staged files; the Host's IDs come back. */
    @discardableResult public mutating func clear() -> [String] {
        for item in items { PhoneAttachStage.remove(item.file) }
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
        guard let caps, items.allSatisfy({ PhoneAttachments.takes($0.kind, size: $0.size, caps) }) else {
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
    /** Bytes staged on disk across every composer before the Host keeps them: a whole message of the largest files and more. */
    public static let stagedLimit = 512 * 1_048_576
    public static let stagedWords = "等待上传的附件已占用 512 MB，请先发送或移除一些附件。"
    /** Refused when adding `adding` bytes would pass what all composers may stage at once. */
    public static func admitStaged(staged: Int, adding: Int) -> String? { staged + adding > stagedLimit ? stagedWords : nil }
    /** A native stream carries at most 1 MiB: a file up to that goes in one stream, a larger one in parts of this size. */
    public static let streamBytes = 1_048_576
    /** Parts in flight on a bulk upload companion: the Host takes four within four places of the first missing one. */
    public static let partsInFlight = 4
    /** After a bulk upload companion could not open, how long its parts go on the control connection before it is tried again. */
    public static let laneRetry: Duration = .seconds(3)
    /** The most this phone sends of one file, whatever a Host says: the Host's own largest file (`ATTACHMENT_FILE_BYTES`). */
    public static let largestFile = 50 * 1_048_576
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
    /**
     * The largest file of this kind this phone sends: the Host's limits for this Harness and kind. Where the Host takes
     * every file (`files`), text is a file like any other: what it cannot embed goes by its path.
     */
    public static func limit(_ kind: PhoneAttachKind, _ caps: PhoneAttachCaps) -> Int {
        switch kind {
        case .image: min(largestFile, caps.fileBytes, caps.imageBytes)
        case .text: caps.files ? min(largestFile, caps.fileBytes) : min(largestFile, caps.fileBytes, caps.textBytes)
        case .file: min(largestFile, caps.fileBytes)
        }
    }
    /** Whether the Host takes a row of this kind and size for this Harness. */
    public static func takes(_ kind: PhoneAttachKind, size: Int, _ caps: PhoneAttachCaps) -> Bool {
        switch kind {
        case .image: caps.takesImages
        case .text: caps.files || (caps.text && size <= caps.textBytes)
        case .file: caps.files
        }
    }
    public static func sizeText(_ bytes: Int) -> String {
        bytes >= 1_048_576 ? "\(Int((Double(bytes) / 1_048_576).rounded())) MB" : "\(max(1, Int((Double(bytes) / 1024).rounded()))) KB"
    }
    /** What may be attached, in the web's words, said with a refusal; empty when nothing can be. */
    public static func limitsLine(_ caps: PhoneAttachCaps?) -> String {
        guard let caps, caps.any else { return "" }
        if caps.files { return "每个文件 \(sizeText(limit(.file, caps))) 内 · 每条 8 个" }
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
    /**
     * What a file may be by its type, before its content is read: a picture to re-encode, text if its bytes turn out to be
     * UTF-8, or a file. SVG is text (it is XML), never a picture.
     */
    public static func kind(typeIdentifier: String) -> PhoneAttachKind {
        guard let type = UTType(typeIdentifier) else { return .file }
        if type.conforms(to: .svg) { return .text }
        if type.conforms(to: .image) { return .image }
        if type.conforms(to: .text) { return .text }
        return .file
    }
    /** Refused before any upload; nil when this file may be sent. `count`: rows already in the message. */
    public static func admit(kind: PhoneAttachKind?, name: String, size: Int, count: Int, caps: PhoneAttachCaps?) -> String? {
        guard count < perMessage else { return tooMany }
        guard let caps, caps.any else { return caps?.reason ?? "当前 Harness 不接收附件。" }
        guard let kind else { return "没能读取「\(shortName(name))」，没有添加。" }
        guard size > 0 else { return "空文件不能添加。" }
        if kind == .image && !caps.takesImages { return caps.reason ?? "当前模型不能看图片。" }
        if kind == .text && !caps.takesText { return caps.reason ?? "当前 Harness 不接收文字文件。" }
        if kind == .file && !caps.files { return "「\(shortName(name))」不能添加：只收图片和文字文件。" }
        let largest = kind == .image ? PhoneImagePrep.sourceBytes : limit(kind, caps)
        guard size <= largest else { return tooLarge(name, largest, caps) }
        return nil
    }
    /** After re-encoding, an image must still fit. */
    public static func admitSize(kind: PhoneAttachKind, name: String, size: Int, caps: PhoneAttachCaps) -> String? {
        size > limit(kind, caps) ? tooLarge(name, limit(kind, caps), caps) : nil
    }
    private static func tooLarge(_ name: String, _ largest: Int, _ caps: PhoneAttachCaps) -> String {
        "「\(shortName(name))」超过 \(sizeText(largest))，没有添加。可以添加：\(limitsLine(caps))。"
    }
    /** The symbol of a file's type, from its kind, MIME and name. */
    public static func icon(kind: String, mime: String?, name: String) -> PhoneAttachIcon {
        if kind == "image" { return .image }
        if kind == "text" { return .text }
        let ext = (name as NSString).pathExtension.lowercased()
        let type = mime.flatMap { UTType(mimeType: $0) }.flatMap { $0 == .data ? nil : $0 } ?? UTType(filenameExtension: ext)
        guard let type else { return .document }
        if type.conforms(to: .pdf) { return .pdf }
        if type.conforms(to: .movie) || type.conforms(to: .video) { return .video }
        if type.conforms(to: .audio) { return .audio }
        if [UTType.zip, .gzip, .bz2].contains(where: type.conforms(to:)) || ["tar", "tgz", "7z", "rar", "xz"].contains(ext) { return .archive }
        if type.conforms(to: .image) { return .image }
        if type.conforms(to: .text) { return .text }
        return .document
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
    /** The start of a chunked upload (`POST /attachments/uploads`): what the file is, and its SHA-256 for the Host to check. */
    public static func uploadStart(_ draft: PhoneAttachDraft, selection: NativeJSON, sessionId: String?) throws -> Data {
        var fields = context(selection: selection, sessionId: sessionId)
        guard let file = draft.file else { throw NativeFailure.invalidRecord }
        // Only a picture this phone re-encoded is declared one; the Host sniffs text and every other file itself.
        fields["requestId"] = .string(draft.requestId); fields["name"] = .string(draft.name); fields["kind"] = .string(draft.kind == .image ? "image" : "file")
        fields["size"] = .number(Double(draft.size)); fields["sha256"] = .string(file.sha256)
        return try NativeJSON.object(fields).encoded()
    }
    /** A Host `AttachmentRef`: only these keys, a fixed ID and hash. */
    public static func validRef(_ ref: NativeJSON) -> Bool {
        guard case let .object(fields) = ref, Set(fields.keys).isSubset(of: ["id", "name", "mime", "kind", "size", "sha256", "width", "height"]),
              let id = ref["id"].string, LinkBytes.matches(id, "[A-Za-z0-9_-]{22}"), let hash = ref["sha256"].string, LinkBytes.matches(hash, "[a-f0-9]{64}"),
              let name = ref["name"].string, !name.isEmpty, name.count <= 200, let size = ref["size"].integer, size > 0,
              ["image", "text", "file"].contains(ref["kind"].string ?? "") else { return false }
        return true
    }
    /** A sent message's attachments, as chips: name, kind, size. */
    public static func chips(_ message: NativeJSON) -> [PhoneAttachChip] {
        message["attachments"].array.prefix(perMessage).compactMap { ref in
            guard validRef(ref), let id = ref["id"].string, let name = ref["name"].string, let size = ref["size"].integer else { return nil }
            let image = ref["kind"].string == "image"
            // Quick Look stays with plain text and redrawn PNG/JPEG (native/ios/AGENTS.md).
            // A file the Host gave its agent by path (PDF, video, archive…) is listed by name only.
            let opens = image ? ["image/png", "image/jpeg"].contains(ref["mime"].string ?? "") : ref["kind"].string == "text" && size <= 524_288
            return PhoneAttachChip(id: id, name: name, image: image, size: sizeText(Int(size)), opens: opens,
                icon: icon(kind: ref["kind"].string ?? "file", mime: ref["mime"].string, name: name))
        }
    }
    /** The attachments a pending write carries. */
    public static func count(_ write: NativePendingWrite) -> Int { ((try? NativeJSON.decode(write.body))?["attachmentIds"].array.count) ?? 0 }
}

/**
 * A chunked upload as the Host has it: parts of `partBytes` in order from `next` (nil when every part is in), or the
 * attachment it already made.
 */
public struct PhoneAttachUpload: Equatable, Sendable {
    public let id: String
    public let parts: Int
    public var next: Int?
    public let attachment: NativeJSON?
    /** Parts the Host has, from its bitmap; a Host without one has every part before `next`. */
    public var received: Set<Int> = []
    /** Parts still to send, lowest first. */
    public var missing: [Int] { (0..<parts).filter { !received.contains($0) } }
    /** From `{ upload }` or `{ attachment }`, for a file of `size` bytes; nil when the answer is not one. */
    public static func parse(_ value: NativeJSON, size: Int) -> PhoneAttachUpload? {
        let attachment = value["attachment"] == .null ? value["upload"]["attachment"] : value["attachment"]
        if attachment != .null { return PhoneAttachments.validRef(attachment) ? PhoneAttachUpload(id: "", parts: 0, next: nil, attachment: attachment) : nil }
        let upload = value["upload"]
        let parts = (size + PhoneAttachments.streamBytes - 1) / PhoneAttachments.streamBytes
        guard let id = upload["id"].string, LinkBytes.matches(id, "[A-Za-z0-9_-]{22}"), upload["size"].integer == UInt64(size),
              upload["partBytes"].integer == UInt64(PhoneAttachments.streamBytes), upload["parts"].integer == UInt64(parts) else { return nil }
        let next: Int?
        switch upload["next"] {
        case .null: next = nil
        default:
            guard let value = upload["next"].integer, (0..<UInt64(parts)).contains(value) else { return nil }
            next = Int(value)
        }
        var received = Set(0..<(next ?? parts))
        if upload["bitmap"] != .null {
            // The bitmap agrees with `next`: every part before it is in, and that one is not.
            guard let bitmap = upload["bitmap"].string, bitmap.utf8.count == parts, bitmap.utf8.allSatisfy({ $0 == 48 || $0 == 49 }) else { return nil }
            received = Set(bitmap.utf8.enumerated().compactMap { $0.element == 49 ? $0.offset : nil })
            guard received.isSuperset(of: 0..<(next ?? parts)), next.map({ !received.contains($0) }) ?? (received.count == parts) else { return nil }
        }
        return PhoneAttachUpload(id: id, parts: parts, next: next, attachment: nil, received: received)
    }
}

public struct PhoneAttachChip: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let image: Bool
    public let size: String
    /** Whether this phone previews it; other formats say so when tapped. */
    public let opens: Bool
    public let icon: PhoneAttachIcon
}

/** A file's type, as its row and chip show it. */
public enum PhoneAttachIcon: String, Equatable, Sendable { case image, text, pdf, video, audio, archive, document }

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
    /** Whether ImageIO reads this file as a picture at all; one it cannot open is sent as a file. */
    public static func opens(url: URL) -> Bool {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return false }
        return CGImageSourceGetType(source) != nil && CGImageSourceGetCount(source) > 0
    }
    /** A JPEG of at most 160 pixels on its long side, for an image's row. */
    public static func thumbnail(_ data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 160, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? output as Data : nil
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

/** A picked file before it is checked: staged once (`PhoneAttachStage`), and the picker's copy is gone by then. */
public struct PhonePicked: Equatable, Sendable {
    public let name: String
    public let kind: PhoneAttachKind?
    /** The staged bytes; nil when it was refused before staging or could not be read. Whoever refuses it removes it. */
    public let file: PhoneStagedFile?
    public let thumbnail: Data?
    /** The original's size, for a refusal before reading or re-encoding it. */
    public let size: Int
    /** Why it could not be read or re-encoded; nil when `file` is there. */
    public var failure: String?
    public init(name: String, kind: PhoneAttachKind?, file: PhoneStagedFile?, thumbnail: Data? = nil, size: Int, failure: String? = nil) {
        self.name = name; self.kind = kind; self.file = file; self.thumbnail = thumbnail; self.size = size; self.failure = failure
    }
}

/**
 * Reading what a picker handed over into a staged file. Images keep their pixels alone, re-encoded in memory and staged;
 * any other file is moved from the picker's copy and read once in bounded chunks. A picker's copy is deleted whatever
 * happens, and one a picker left behind (its callback never came) is purged at launch with every staged file.
 */
public enum PhoneAttachLoader {
    public static let unreadable = "没能读取这张图片，没有添加。"
    public static let tooManyPixels = "图片超过 4000 万像素，没有添加。"
    /** A picture: re-encoded from its pixels and staged, or refused. Never sent as it was: its metadata stays on the phone. */
    public static func image(url: URL, name: String, limit: Int, temporary: URL = FileManager.default.temporaryDirectory) -> PhonePicked {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= PhoneImagePrep.sourceBytes else { return PhonePicked(name: name, kind: .image, file: nil, size: size) }
        if PhoneImagePrep.withinPixels(url: url) == false { return PhonePicked(name: name, kind: .image, file: nil, size: size, failure: tooManyPixels) }
        guard let prepared = try? PhoneImagePrep.prepare(url: url, limit: limit) else { return PhonePicked(name: name, kind: .image, file: nil, size: size, failure: unreadable) }
        return staged(prepared, name: name, size: size, temporary: temporary)
    }
    /** The camera's photo: only its pixels, never its metadata dictionary. */
    public static func camera(_ encoded: Data?, limit: Int, temporary: URL = FileManager.default.temporaryDirectory) -> PhonePicked {
        guard let encoded, let prepared = try? PhoneImagePrep.prepare(data: encoded, limit: limit) else {
            return PhonePicked(name: "照片", kind: .image, file: nil, size: 1, failure: unreadable)
        }
        return staged(prepared, name: "照片", size: encoded.count, temporary: temporary)
    }
    private static func staged(_ prepared: PhoneImagePrepared, name: String, size: Int, temporary: URL) -> PhonePicked {
        let named = PhoneAttachments.fileName(name, ext: prepared.ext)
        guard let file = try? PhoneAttachStage.write(prepared.data, temporary: temporary) else { return PhonePicked(name: named, kind: .image, file: nil, size: size, failure: unreadable) }
        return PhonePicked(name: named, kind: .image, file: file, thumbnail: PhoneImagePrep.thumbnail(prepared.data), size: size)
    }
    /**
     * A document picker's copy in this App's own sandbox. A picture ImageIO opens is re-encoded; one past its limits is
     * refused, never sent as it was. Anything else is moved into the stage and read once: UTF-8 without NUL of a text
     * type is text, the rest is a file. `largest`: what is staged at most; a larger one is refused by its size unread.
     */
    public static func file(url: URL, imageLimit: Int, largest: Int, temporary: URL = FileManager.default.temporaryDirectory) -> PhonePicked {
        defer { try? FileManager.default.removeItem(at: url) }
        let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey, .isRegularFileKey])
        let name = url.lastPathComponent, size = values?.fileSize ?? 0
        guard values?.isRegularFile == true else { return PhonePicked(name: name, kind: nil, file: nil, size: size) }
        let type = values?.contentType ?? UTType(filenameExtension: url.pathExtension)
        var kind = type.map { PhoneAttachments.kind(typeIdentifier: $0.identifier) } ?? .file
        if kind == .image {
            if PhoneImagePrep.opens(url: url) { return image(url: url, name: name, limit: imageLimit, temporary: temporary) }
            kind = .file
        }
        guard size > 0, size <= largest else { return PhonePicked(name: PhoneAttachments.fileName(name), kind: kind, file: nil, size: size) }
        guard let (file, scan) = try? PhoneAttachStage.adopt(url, temporary: temporary) else {
            return PhonePicked(name: PhoneAttachments.fileName(name), kind: kind, file: nil, size: size, failure: "没能读取「\(name)」，没有添加。")
        }
        if kind == .text && !scan.utf8 { kind = .file }
        return PhonePicked(name: PhoneAttachments.fileName(name), kind: kind, file: file, size: file.size)
    }
    /**
     * At launch: copies a document picker left in `tmp/<bundle>-Inbox` when its callback never came, and every staged
     * file. Returns how many went.
     */
    @discardableResult public static func purgeInbox(temporary: URL) -> Int {
        var removed = PhoneAttachStage.purge(temporary: temporary)
        let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey]
        guard let folders = try? FileManager.default.contentsOfDirectory(at: temporary, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return removed }
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
