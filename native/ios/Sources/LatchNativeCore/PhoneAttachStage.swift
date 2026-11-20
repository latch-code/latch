import CryptoKit
import Foundation

/** One attachment's bytes waiting on this phone: a file of its own, its size and SHA-256 fixed when it was staged. */
public struct PhoneStagedFile: Equatable, Sendable {
    public let url: URL
    public let size: Int
    public let sha256: String
}

/** What a staged file's bytes are, read once in bounded chunks. */
public struct PhoneStagedScan: Equatable, Sendable {
    public let sha256: String
    /** Valid UTF-8 from start to end, with no NUL. */
    public let utf8: Bool
}

/**
 * Attachments waiting to upload, staged as files rather than held in memory: one folder in this App's temporary
 * directory (never Documents), excluded from backup, each file under a random name with complete protection. A file is
 * read back in chunks of at most 1 MiB; it goes when the Host keeps it, its row goes, or everything is let go (lock,
 * revoke, another computer, the window closing) and at launch.
 */
public enum PhoneAttachStage {
    public static let folderName = "latch-attachments"
    /** The largest chunk read at once, staging or uploading. */
    public static let chunkBytes = 1_048_576
    public static func folder(temporary: URL = FileManager.default.temporaryDirectory) -> URL {
        temporary.appendingPathComponent(folderName, isDirectory: true)
    }
    /** The folder, made private when missing; refused when what is there is a link or not a folder. */
    static func prepare(_ folder: URL) throws {
        let manager = FileManager.default
        if let values = try? folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]) {
            guard values.isDirectory == true, values.isSymbolicLink != true else { throw NativeFailure.unavailable }
        } else {
            try manager.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
        var marked = folder; try marked.setResourceValues(excluded)
    }
    /** Complete protection: the bytes cannot be read while the phone is locked. Required on the phone itself. */
    static func protect(_ url: URL) throws {
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600], ofItemAtPath: url.path)
        #else
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        #endif
    }
    private static func target(_ folder: URL) -> URL { folder.appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: false) }
    /** Bytes already in memory (a re-encoded picture), written as a staged file. */
    public static func write(_ data: Data, temporary: URL = FileManager.default.temporaryDirectory) throws -> PhoneStagedFile {
        let folder = folder(temporary: temporary)
        try prepare(folder)
        let url = target(folder)
        #if os(iOS)
        try data.write(to: url, options: [.withoutOverwriting, .completeFileProtection])
        #else
        try data.write(to: url, options: [.withoutOverwriting])
        #endif
        do { try protect(url) } catch { try? FileManager.default.removeItem(at: url); throw error }
        return PhoneStagedFile(url: url, size: data.count, sha256: LinkBytes.hex(LinkBytes.hash(data)))
    }
    /**
     * A picker's copy in this App's sandbox, moved (not copied again) into the folder and read once: its SHA-256 and
     * whether it is UTF-8 text. The picker's copy is gone either way.
     */
    public static func adopt(_ source: URL, temporary: URL = FileManager.default.temporaryDirectory) throws -> (PhoneStagedFile, PhoneStagedScan) {
        let folder = folder(temporary: temporary), manager = FileManager.default
        defer { try? manager.removeItem(at: source) }
        try prepare(folder)
        let url = target(folder)
        do { try manager.moveItem(at: source, to: url) } catch { try manager.copyItem(at: source, to: url) }
        do {
            try protect(url)
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? -1
            let scan = try self.scan(url, size: size)
            return (PhoneStagedFile(url: url, size: size, sha256: scan.sha256), scan)
        } catch {
            try? manager.removeItem(at: url); throw error
        }
    }
    /** SHA-256 and UTF-8 validity in one pass of bounded chunks; a sequence split across chunks carries over. */
    static func scan(_ url: URL, size: Int) throws -> PhoneStagedScan {
        guard size >= 0 else { throw NativeFailure.invalidRecord }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256(), utf8 = true, carry = Data(), read = 0
        while true {
            guard let chunk = try handle.read(upToCount: chunkBytes), !chunk.isEmpty else { break }
            read += chunk.count
            guard read <= size else { throw NativeFailure.invalidRecord }
            hash.update(data: chunk)
            if utf8 {
                if chunk.contains(0) { utf8 = false; continue }
                let joined = carry + chunk, cut = completeLength(joined)
                carry = joined.subdata(in: cut..<joined.count)
                if cut > 0, String(data: joined.subdata(in: 0..<cut), encoding: .utf8) == nil { utf8 = false }
            }
        }
        guard read == size else { throw NativeFailure.invalidRecord }
        return PhoneStagedScan(sha256: LinkBytes.hex(Data(hash.finalize())), utf8: utf8 && carry.isEmpty)
    }
    /** How much of `data` ends on a whole UTF-8 sequence: an unfinished lead at the end, up to three bytes back, is left. */
    static func completeLength(_ data: Data) -> Int {
        let bytes = [UInt8](data.suffix(3)), base = data.count - bytes.count
        for back in 1...max(1, bytes.count) where back <= bytes.count {
            let byte = bytes[bytes.count - back]
            if byte & 0xC0 == 0x80 { continue }
            let needed = byte >= 0xF0 ? 4 : byte >= 0xE0 ? 3 : byte >= 0xC0 ? 2 : 1
            return needed > back ? base + bytes.count - back : data.count
        }
        return data.count
    }
    /** `count` bytes from `offset` of a staged file, exactly; a file that changed size is refused. */
    public static func read(_ file: PhoneStagedFile, offset: Int, count: Int) throws -> Data {
        guard offset >= 0, count >= 0, count <= chunkBytes, offset + count <= file.size else { throw NativeFailure.invalidRecord }
        let handle = try FileHandle(forReadingFrom: file.url)
        defer { try? handle.close() }
        guard try handle.seekToEnd() == UInt64(file.size) else { throw NativeFailure.invalidRecord }
        try handle.seek(toOffset: UInt64(offset))
        let data = try handle.read(upToCount: count) ?? Data()
        guard data.count == count else { throw NativeFailure.invalidRecord }
        return data
    }
    public static func remove(_ file: PhoneStagedFile?) {
        guard let file else { return }
        try? FileManager.default.removeItem(at: file.url)
    }
    /** Every staged file goes: on lock, revoke, another computer, the window closing, and at launch. Returns how many. */
    @discardableResult public static func purge(temporary: URL = FileManager.default.temporaryDirectory) -> Int {
        let folder = folder(temporary: temporary), manager = FileManager.default
        guard let values = try? folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]) else { return 0 }
        guard values.isDirectory == true, values.isSymbolicLink != true else { try? manager.removeItem(at: folder); return 0 }
        var removed = 0
        for item in (try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] where (try? manager.removeItem(at: item)) != nil { removed += 1 }
        return removed
    }
}
