import CryptoKit
import Darwin
import Foundation
import LocalAuthentication
import Security

/** The App calls this only after protected data is available. Tests inject their own nonpersistent key instead. */
public enum CacheKeychain {
    public static func loadOrCreate(account: String) throws -> Data {
        guard LinkBytes.matches(account, "[A-Za-z0-9_-]{1,80}") else { throw NativeFailure.invalidRecord }
        let context = LAContext(); context.interactionNotAllowed = true
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "app.latch.ios.cache",
            kSecAttrAccount: account, kSecAttrSynchronizable: false, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne,
            kSecUseAuthenticationContext: context]
        var found: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &found)
        if status == errSecSuccess, let key = found as? Data { return try LinkBytes.fixed(key, 32) }
        guard status == errSecItemNotFound else { throw CacheKeychainFailure(status: status) }
        let key = try LinkBytes.random(32)
        let add: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "app.latch.ios.cache",
            kSecAttrAccount: account, kSecAttrSynchronizable: false, kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData: key]
        let saved = SecItemAdd(add as CFDictionary, nil)
        guard saved == errSecSuccess else { throw CacheKeychainFailure(status: saved) }
        return key
    }
}

/** The keychain's own status when the cache key cannot be read or made; the status is a number, never key material. */
public struct CacheKeychainFailure: Error, LocalizedError, Sendable, Equatable {
    public let status: OSStatus
    public var errorDescription: String? { NativeFailure.storageUnavailable.errorDescription }
}

/** What the App's failure screen can tell apart when its store does not open: only what the open path reports. */
public enum NativeStoreFailure: Equatable, Sendable {
    /** The item is readable only while the device is unlocked. */
    case locked
    case keychain(OSStatus)
    /** The encrypted files or the saved profiles; the code is the failure's name or the system error's domain and number. */
    case files(String)

    public init(_ error: any Error) {
        if let keychain = error as? CacheKeychainFailure {
            self = keychain.status == errSecInteractionNotAllowed ? .locked : .keychain(keychain.status)
        } else if let failure = error as? NativeFailure {
            self = .files(failure.rawValue)
        } else {
            let system = error as NSError
            self = .files("\(system.domain) \(system.code)")
        }
    }
    public var advice: String {
        switch self {
        case .locked: "请解锁这台设备，再试一次。"
        case .keychain: "系统钥匙串不可用。"
        case .files: "本机资料无法读取。"
        }
    }
    /** A short code for reporting the failure. */
    public var code: String {
        switch self {
        case .locked: "OSStatus \(errSecInteractionNotAllowed)"
        case let .keychain(status): "OSStatus \(status)"
        case let .files(name): name
        }
    }
}

/** An offline projection of a checkpoint the Workspace accepted on its active transport. */
struct NativeSnapshotWrite: Sendable {
    let order: UInt64
    let instance: String
    let revision: UInt64
    let bytes: Data
}

/** Authenticated ciphertext only. Body reads require the original, live App-opening lease, including offline reads. */
public actor EncryptedVault {
    private static let maximumFile = 8 * 1024 * 1024
    private static let maximumTotal = 256 * 1024 * 1024
    private static let maximumFiles = 256
    private let directory: URL
    private let fd: Int32
    private let device: Int32
    private let inode: UInt64
    private let binding: Data
    private var key: SymmetricKey?
    private var snapshotOrder: UInt64 = 0
    private var storedSnapshotOrder: UInt64 = 0
    private var snapshotFloor: (instance: String, revision: UInt64)?
    private var snapshotFloorLoaded = false

    public init(directory: URL, key: Data, binding: String) throws {
        guard directory.isFileURL, directory.path.hasPrefix("/"), key.count == 32,
              LinkBytes.matches(binding, "[A-Za-z0-9_-]{1,100}") else { throw NativeFailure.storageUnavailable }
        let path = directory.standardizedFileURL
        self.directory = path.deletingLastPathComponent().resolvingSymlinksInPath().appendingPathComponent(path.lastPathComponent)
        self.binding = Data(binding.utf8)
        try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let fd = Darwin.open(self.directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw NativeFailure.storageUnavailable }
        var value = stat()
        guard fstat(fd, &value) == 0, value.st_uid == geteuid(), value.st_mode & 0o077 == 0 else {
            Darwin.close(fd); throw NativeFailure.storageUnavailable
        }
        do {
            var url = self.directory, resources = URLResourceValues()
            resources.isExcludedFromBackup = true
            try url.setResourceValues(resources)
            var named = stat()
            guard lstat(self.directory.path, &named) == 0, named.st_dev == value.st_dev, named.st_ino == value.st_ino,
                  named.st_mode & S_IFMT == S_IFDIR else { throw NativeFailure.storageUnavailable }
        } catch { Darwin.close(fd); throw NativeFailure.storageUnavailable }
        self.fd = fd; device = value.st_dev; inode = value.st_ino
        self.key = SymmetricKey(data: key)
    }
    deinit { Darwin.close(fd) }
    public func lock() { key = nil }

    public func storeMetadata(_ data: Data, name: String) throws { try store(data, name: name, body: false) }
    public func metadata(name: String) throws -> Data? { try read(name: name, body: false) }

    /** The actor can receive newer writes before older callers cross their await. Check and replace in one turn. */
    func storeSnapshot(_ write: NativeSnapshotWrite) throws {
        guard write.order >= snapshotOrder, write.order != storedSnapshotOrder else { return }
        snapshotOrder = write.order
        if !snapshotFloorLoaded {
            if let cached = try? read(name: "snapshot", body: false), let value = try? NativeJSON.decode(cached),
               let instance = value["instanceId"].string, let revision = value["revision"].integer {
                snapshotFloor = (instance, revision)
            }
            snapshotFloorLoaded = true
        }
        if let floor = snapshotFloor, floor.instance == write.instance, floor.revision > write.revision {
            throw NativeFailure.invalidRecord
        }
        do {
            try store(write.bytes, name: "snapshot", body: false)
        } catch {
            // A known superseded public projection must not serve as the fallback for a failed save.
            try? remove(name: "snapshot", body: false)
            throw error
        }
        snapshotFloor = (write.instance, write.revision)
        storedSnapshotOrder = write.order
    }
    public func storeBody(_ data: Data, name: String, lease: BodyLease) throws {
        try lease.requireValid(); try store(data, name: name, body: true); try lease.requireValid()
    }
    public func body(name: String, lease: BodyLease) throws -> Data? {
        try lease.requireValid(); let value = try read(name: name, body: true); try lease.requireValid(); return value
    }
    public func remove(name: String, body: Bool) throws {
        let path = try filename(name, body: body)
        try validate()
        if unlinkat(fd, path, 0) != 0 && errno != ENOENT { throw NativeFailure.storageUnavailable }
        guard fsync(fd) == 0 else { throw NativeFailure.storageUnavailable }
    }
    private func filename(_ value: String, body: Bool) throws -> String {
        guard LinkBytes.matches(value, "[A-Za-z0-9_-]{1,100}") else { throw NativeFailure.invalidRecord }
        return (body ? "body-" : "meta-") + value + ".lcache"
    }
    private func validate() throws {
        guard key != nil else { throw NativeFailure.storageUnavailable }
        var current = stat(), named = stat()
        guard fstat(fd, &current) == 0, lstat(directory.path, &named) == 0,
              current.st_dev == device, current.st_ino == inode, named.st_dev == device, named.st_ino == inode,
              current.st_uid == geteuid(), current.st_mode & 0o077 == 0, named.st_mode & S_IFMT == S_IFDIR else { throw NativeFailure.storageUnavailable }
    }
    private func aad(_ filename: String) -> Data { Data("latch-ios-cache-v1\0".utf8) + binding + Data([0]) + Data(filename.utf8) }
    private func usage(replacing: String) throws -> (Int, Int) {
        let copy = dup(fd)
        guard copy >= 0 else { throw NativeFailure.storageUnavailable }
        guard let stream = fdopendir(copy) else { Darwin.close(copy); throw NativeFailure.storageUnavailable }
        defer { closedir(stream) }
        rewinddir(stream)
        var files = 0, bytes = 0, visited = 0
        while true {
            errno = 0
            guard let entry = readdir(stream) else {
                guard errno == 0 else { throw NativeFailure.storageUnavailable }; break
            }
            visited += 1
            guard visited <= Self.maximumFiles + 32 else { throw NativeFailure.storageUnavailable }
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(validatingCString: $0) }
            }
            guard let name else { throw NativeFailure.storageUnavailable }
            if name == "." || name == ".." || name == replacing { continue }
            var value = stat()
            guard fstatat(fd, name, &value, AT_SYMLINK_NOFOLLOW) == 0, value.st_mode & S_IFMT == S_IFREG,
                  value.st_nlink == 1, value.st_uid == geteuid(), value.st_size >= 0,
                  value.st_size <= Self.maximumFile + 64 else { throw NativeFailure.storageUnavailable }
            files += 1; bytes += Int(value.st_size)
            guard files <= Self.maximumFiles, bytes <= Self.maximumTotal else { throw NativeFailure.storageUnavailable }
        }
        return (files, bytes)
    }
    private func store(_ plaintext: Data, name: String, body: Bool) throws {
        guard plaintext.count <= Self.maximumFile else { throw NativeFailure.storageUnavailable }
        let name = try filename(name, body: body)
        try validate()
        guard let key else { throw NativeFailure.storageUnavailable }
        let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: aad(name))
        guard let combined = sealed.combined else { throw NativeFailure.storageUnavailable }
        let data = Data([1]) + combined
        let (files, bytes) = try usage(replacing: name)
        guard files < Self.maximumFiles, bytes + data.count <= Self.maximumTotal else { throw NativeFailure.storageUnavailable }
        let temporary = ".cache-" + UUID().uuidString
        let file = openat(fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard file >= 0 else { throw NativeFailure.storageUnavailable }
        defer { Darwin.close(file); unlinkat(fd, temporary, 0) }
        #if os(iOS)
        guard fcntl(file, F_SETPROTECTIONCLASS, 1) == 0 else { throw NativeFailure.storageUnavailable }
        #endif
        try data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let written = Darwin.write(file, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if written < 0 && errno == EINTR { continue }
                guard written > 0 else { throw NativeFailure.storageUnavailable }
                offset += written
            }
        }
        guard fsync(file) == 0 else { throw NativeFailure.storageUnavailable }
        try validate()
        guard renameat(fd, temporary, fd, name) == 0, fsync(fd) == 0 else { throw NativeFailure.storageUnavailable }
        try validate()
    }
    private func read(name: String, body: Bool) throws -> Data? {
        let name = try filename(name, body: body)
        try validate()
        let file = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if file < 0 && errno == ENOENT { return nil }
        guard file >= 0 else { throw NativeFailure.storageUnavailable }
        defer { Darwin.close(file) }
        var before = stat()
        guard fstat(file, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_nlink == 1,
              before.st_uid == geteuid(), before.st_mode & 0o077 == 0,
              before.st_size >= 29, before.st_size <= Self.maximumFile + 64 else { throw NativeFailure.storageUnavailable }
        var data = Data(count: Int(before.st_size))
        try data.withUnsafeMutableBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.read(file, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw NativeFailure.storageUnavailable }
                offset += count
            }
        }
        var after = stat(), named = stat()
        guard fstat(file, &after) == 0, fstatat(fd, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
              before.st_dev == named.st_dev, before.st_ino == named.st_ino, before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              data.first == 1, let key else { throw NativeFailure.storageUnavailable }
        try validate()
        do { return try AES.GCM.open(AES.GCM.SealedBox(combined: data.dropFirst()), using: key, authenticating: aad(name)) }
        catch { throw NativeFailure.storageUnavailable }
    }
}
