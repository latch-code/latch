import Foundation
import LatchNativeCore

private actor DirectoryMirrorFixture {
    var payload: Data
    var calls = 0
    var blocked = false
    var waiting = false
    var stopped = false
    init(_ payload: Data) { self.payload = payload }
    func set(_ payload: Data, blocked: Bool = false) { self.payload = payload; self.blocked = blocked }
    func get() async throws -> Data {
        calls += 1
        if blocked {
            waiting = true
            do { while true { try await Task.sleep(for: .milliseconds(5)) } }
            catch { stopped = true; throw error }
        }
        return payload
    }
}

func directoryResolverFixture(_ input: [String: Any]) async throws -> [String: Any] {
    guard let value = input["cache"] as? [String: Any], let bookText = value["book"] as? String,
          let root = value["rootSpki"] as? String, let device = value["deviceId"] as? String,
          let now = value["now"] as? NSNumber, let bookTime = value["bookTime"] as? NSNumber else { throw NativeFailure.invalidRecord }
    func bytes(_ key: String) throws -> Data { try LinkBytes.unhex(value[key] as? String ?? "", maximum: 32_768) }
    let book = try AddressBookCodec.verify(bookText, rootSpki: LinkBytes.unhex(root), deviceId: device, nowMs: bookTime.uint64Value)
    guard let endpoint = book.relays.first else { throw NativeFailure.invalidRecord }
    let source = try NativeDirectorySource.decode(bytes("source")), directory = FileManager.default.temporaryDirectory.appendingPathComponent("latch-directory-resolver-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let vault = try EncryptedVault(directory: directory, key: LinkBytes.random(32), binding: book.hostId), mirror = try DirectoryMirrorFixture(bytes("first")), time = now.uint64Value
    let resolver = NativeDirectoryResolver(vault: vault, fetch: { _ in try await mirror.get() }, now: { time })
    try await resolver.configure(source)
    async let one: Void = resolver.refresh(); async let two: Void = resolver.refresh()
    _ = await (one, two)
    guard await mirror.calls == 1, await resolver.targets(for: endpoint).count == 1 else { throw NativeFailure.invalidRecord }
    await mirror.set(try bytes("revoked"))
    let changed = try NativeDirectorySource(anchors: source.anchors, mirrors: [URL(string: "https://directory.example/revoked.bin")!])
    try await resolver.configure(changed); await resolver.refresh()
    guard await mirror.calls == 2, await resolver.targets(for: endpoint).isEmpty else { throw NativeFailure.invalidRecord }
    await mirror.set(try bytes("revoked"), blocked: true)
    let next = try NativeDirectorySource(anchors: source.anchors, mirrors: [URL(string: "https://directory.example/pending.bin")!])
    try await resolver.configure(next)
    let pending = Task { await resolver.refresh() }
    for _ in 0..<200 {
        if await mirror.waiting { break }; try await Task.sleep(for: .milliseconds(5))
    }
    guard await mirror.waiting else { await resolver.close(); throw NativeFailure.invalidRecord }
    await resolver.close(); await pending.value
    guard await mirror.stopped, await resolver.targets(for: endpoint).isEmpty else { throw NativeFailure.invalidRecord }
    return ["coalesced": true, "revoked": true, "cancelled": true]
}

func directoryHTTPFixture(_ input: [String: Any]) throws -> [String: Any] {
    guard let cases = input["cases"] as? [[String: Any]], cases.count <= 256 else { throw NativeFailure.invalidRecord }
    var accepted = 0, rejected = 0
    for item in cases {
        guard let hex = item["bytes"] as? String, let fragment = item["fragment"] as? Int, let valid = item["valid"] as? Bool,
              (1...8192).contains(fragment) else { throw NativeFailure.invalidRecord }
        let bytes = try LinkBytes.unhex(hex, maximum: 65_537)
        var parser = NativeDirectoryHTTPParser(), body: Data?
        do {
            var offset = 0
            while offset < bytes.count {
                let end = min(bytes.count, offset + fragment)
                body = try parser.append(Data(bytes[offset..<end]), complete: end == bytes.count)
                offset = end
            }
            guard let body, valid, let hash = item["hash"] as? String, LinkBytes.hex(LinkBytes.hash(body)) == hash else { throw NativeFailure.invalidRecord }
            accepted += 1
        } catch {
            guard !valid else { throw error }; rejected += 1
        }
    }
    return ["accepted": accepted, "rejected": rejected]
}
