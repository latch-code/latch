import Foundation
import LatchNativeCore

private actor DirectoryFixtureStorage {
    let underlying: NativeDirectoryStorage
    var fail = false
    var failBefore = false
    init(_ underlying: NativeDirectoryStorage) { self.underlying = underlying }
    func failNext() { fail = true }
    func failBeforeNext() { failBefore = true }
    func read() async throws -> Data? { try await underlying.read() }
    func write(_ value: Data) async throws {
        if failBefore { failBefore = false; throw NativeFailure.resultUnknown }
        try await underlying.write(value)
        if fail { fail = false; throw NativeFailure.resultUnknown }
    }
}
func directoryCacheFixture(_ input: [String: Any]) async throws -> [String: Any] {
    guard let vector = input["cache"] as? [String: Any], let encodedBook = vector["book"] as? String,
          let root = vector["rootSpki"] as? String, let deviceId = vector["deviceId"] as? String,
          let now = vector["now"] as? NSNumber else { throw NativeFailure.invalidRecord }
    func bytes(_ name: String) throws -> Data { try LinkBytes.unhex(vector[name] as? String ?? "", maximum: 32_768) }
    let time = now.uint64Value
    let book = try AddressBookCodec.verify(encodedBook, rootSpki: LinkBytes.unhex(root), deviceId: deviceId, nowMs: (vector["bookTime"] as? NSNumber)?.uint64Value ?? time)
    guard let endpoint = book.relays.first else { throw NativeFailure.invalidRecord }
    let source = try NativeDirectorySource.decode(bytes("source")), freshSource = try NativeDirectorySource.decode(bytes("freshSource"))
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-swift-directory-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let vault = try EncryptedVault(directory: directory.appendingPathComponent("main"), key: LinkBytes.random(32), binding: book.hostId)
    let owner = DirectoryFixtureStorage(.encrypted(vault, source: source))
    let storage = NativeDirectoryStorage(read: { try await owner.read() }, write: { try await owner.write($0) })
    let first = try await NativeDirectoryCache.open(source: source, storage: storage, now: { time })
    try await first.adopt(bytes("first"))
    guard await first.candidates(for: endpoint).count == 1 else { throw NativeFailure.invalidRecord }
    await owner.failBeforeNext()
    var failedBefore = false
    do { try await first.adopt(bytes("second")) } catch { failedBefore = (error as? NativeFailure) == .resultUnknown }
    guard failedBefore else { throw NativeFailure.invalidRecord }
    try await first.retryPersistence()
    guard try await first.sources().minimumOnline?.generation == LinkBytes.maximumInteger else { throw NativeFailure.invalidRecord }
    await owner.failNext()
    var unknown = false
    do { try await first.adopt(bytes("second")) } catch { unknown = (error as? NativeFailure) == .resultUnknown }
    guard unknown, await first.candidates(for: endpoint).isEmpty else { throw NativeFailure.invalidRecord }
    var blocked = false
    do { _ = try await first.sources() } catch { blocked = (error as? NativeFailure) == .resultUnknown }
    guard blocked else { throw NativeFailure.invalidRecord }
    let restored = try await NativeDirectoryCache.open(source: source, storage: storage, now: { time })
    var refused = 0
    do { try await restored.adopt(bytes("first")) } catch { refused += 1 }
    do { try await restored.adopt(bytes("revoked")) } catch { refused += 1 }
    guard try await restored.sources().minimum?.generation == 2, try await restored.sources().minimumOnline == nil, await restored.candidates(for: endpoint).isEmpty else { throw NativeFailure.invalidRecord }
    let revoked = try await NativeDirectoryCache.open(source: source, storage: storage, now: { time })
    do { try await revoked.adopt(bytes("first")) } catch { refused += 1 }
    try await revoked.adopt(bytes("reissued"))
    guard try await revoked.sources().minimum?.generation == 3, await revoked.candidates(for: endpoint).count == 1 else { throw NativeFailure.invalidRecord }
    let freshVault = try EncryptedVault(directory: directory.appendingPathComponent("fresh"), key: LinkBytes.random(32), binding: book.hostId)
    let fresh = try await NativeDirectoryCache.open(source: freshSource, storage: .encrypted(freshVault, source: freshSource), now: { time })
    do { try await fresh.adopt(bytes("first")) } catch { refused += 1 }
    try await fresh.adopt(bytes("second"))
    guard try await fresh.sources().minimumOnline?.generation == LinkBytes.maximumInteger, await fresh.candidates(for: endpoint).count == 1, refused == 4 else { throw NativeFailure.invalidRecord }
    return ["unknownStayedClosed": true, "rootRevocationSurvivedRestart": true, "freshOfflineReplayRejected": true,
        "reissued": true, "rejected": refused]
}
