import CryptoKit
import Darwin
import Foundation

public struct NativeAuthorityCheckpoint: Codable, Sendable {
    public let generation: UInt64
    public let hash: Data
    public init(generation: UInt64, hash: Data) throws {
        guard generation > 0, generation <= LinkBytes.maximumInteger, hash.count == 32 else { throw NativeFailure.invalidRecord }
        self.generation = generation; self.hash = hash
    }
}
public struct NativeDirectorySource: Codable, Sendable {
    public let anchors: [Data]
    public let mirrors: [URL]
    public let minimum: NativeAuthorityCheckpoint?
    public let minimumOnline: NativeAuthorityCheckpoint?
    private var original: Data? = nil
    private enum CodingKeys: String, CodingKey { case anchors, mirrors, minimum, minimumOnline }
    public func encoded() throws -> Data {
        _ = try NativeDirectorySource(anchors: anchors, mirrors: mirrors, minimum: minimum, minimumOnline: minimumOnline)
        if let original { return original }
        var result = Data([UInt8(anchors.count)])
        for anchor in anchors { result += try LinkBytes.fixed(anchor, 32) }
        result.append(UInt8(mirrors.count))
        for mirror in mirrors { result += try LinkBytes.field(Data(mirror.absoluteString.utf8)) }
        result.append((minimum == nil ? 0 : 1) | (minimumOnline == nil ? 0 : 2))
        for floor in [minimum, minimumOnline] { if let floor { result += try LinkBytes.integer(floor.generation, size: 8) + LinkBytes.fixed(floor.hash, 32) } }
        return result
    }
    public var epoch: String { get throws { LinkBytes.hex(LinkBytes.hash(try Data("latch-directory-epoch-v1\0".utf8) + encoded())) } }
    public static var absentEpoch: String { LinkBytes.hex(LinkBytes.hash(Data("latch-directory-epoch-v1\0".utf8))) }
    public init(anchors: [Data], mirrors: [URL], minimum: NativeAuthorityCheckpoint? = nil, minimumOnline: NativeAuthorityCheckpoint? = nil) throws {
        guard (1...2).contains(anchors.count), anchors.allSatisfy({ $0.count == 32 }), Set(anchors).count == anchors.count,
              (1...4).contains(mirrors.count), Set(mirrors).count == mirrors.count else { throw NativeFailure.invalidRecord }
        for url in mirrors { try Self.mirror(url.absoluteString) }
        if let minimum { _ = try NativeAuthorityCheckpoint(generation: minimum.generation, hash: minimum.hash) }
        if let minimumOnline { guard minimum != nil else { throw NativeFailure.invalidRecord }; _ = try NativeAuthorityCheckpoint(generation: minimumOnline.generation, hash: minimumOnline.hash) }
        self.anchors = anchors; self.mirrors = mirrors; self.minimum = minimum; self.minimumOnline = minimumOnline
    }
    static func mirror(_ value: String) throws {
        let tail = value.dropFirst(8)
        guard let start = tail.firstIndex(of: "/") else { throw NativeFailure.invalidRecord }
        let path = tail[start...]
        guard value.utf8.count <= 512, LinkBytes.matches(value, "https://(\\[[a-f0-9:]+\\]|[a-z0-9.-]+)(:[0-9]{1,5})?(/[A-Za-z0-9._/-]*)"),
              let url = URL(string: value), let host = url.host, !path.contains("//"),
              !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
              let port = UInt16(exactly: url.port ?? 443) else { throw NativeFailure.invalidRecord }
        _ = try NativeRelayDirectory.endpoint(host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")), port: port)
    }
    public static func decode(_ bytes: Data) throws -> NativeDirectorySource {
        var reader = try LinkReader(bytes, maximum: 2240)
        let count = try reader.integer(1); guard (1...2).contains(count) else { throw NativeFailure.invalidRecord }
        var anchors: [Data] = []; for _ in 0..<count { anchors.append(try reader.take(32)) }
        let sources = try reader.integer(1); guard (1...4).contains(sources) else { throw NativeFailure.invalidRecord }
        var mirrors: [URL] = []
        for _ in 0..<sources {
            let raw = try reader.field(512)
            guard raw.allSatisfy({ $0 >= 33 && $0 <= 126 }), let text = String(data: raw, encoding: .ascii), let url = URL(string: text) else { throw NativeFailure.invalidRecord }
            try mirror(text); mirrors.append(url)
        }
        let floor = try reader.integer(1); guard floor <= 3, floor != 2 else { throw NativeFailure.invalidRecord }
        let minimum = try floor & 1 == 1 ? NativeAuthorityCheckpoint(generation: reader.integer(8), hash: reader.take(32)) : nil
        let online = try floor & 2 == 2 ? NativeAuthorityCheckpoint(generation: reader.integer(8), hash: reader.take(32)) : nil
        try reader.done()
        var value = try NativeDirectorySource(anchors: anchors, mirrors: mirrors, minimum: minimum, minimumOnline: online)
        value.original = bytes; return value
    }
}
public struct NativeDirectoryCheckpoint: Codable, Sendable {
    public let rootGeneration: UInt64
    public let rootHash: Data
    public let generation: UInt64
    public let hash: Data
    public init(rootGeneration: UInt64, rootHash: Data, generation: UInt64, hash: Data) throws {
        guard rootGeneration > 0, rootGeneration <= LinkBytes.maximumInteger, generation > 0, generation <= LinkBytes.maximumInteger, rootHash.count == 32, hash.count == 32 else { throw NativeFailure.invalidRecord }
        self.rootGeneration = rootGeneration; self.rootHash = rootHash; self.generation = generation; self.hash = hash
    }
}
public struct NativeDirectoryNode: Sendable {
    public let relayId: Data
    public let region: String
    public let spkiHashes: [Data]
    public let ports: [UInt16]
}
public struct NativeDirectoryAddress: Sendable {
    public let relayId: Data
    public let host: String
    public let port: UInt16
    public let addresses: [String]
    public var url: URL { get throws { try NativeRelayDirectory.endpoint(host, port: port) } }
}
/** Constructed only after fixed offline Root verification and an active online delegation. Mac observer consent is separate. */
public struct VerifiedRelayDirectory: Sendable {
    public let checkpoint: NativeDirectoryCheckpoint
    public let expiresAt: UInt64
    public let nodes: [NativeDirectoryNode]
    public let addresses: [NativeDirectoryAddress]
}
public enum NativeRelayDirectory {
    fileprivate struct Key { let bytes: Data; let before: UInt64; let after: UInt64 }
    private static func ascii(_ bytes: Data) throws -> String {
        guard bytes.allSatisfy({ $0 >= 33 && $0 <= 126 }), let text = String(data: bytes, encoding: .ascii) else { throw NativeFailure.invalidRecord }; return text
    }
    private static func lifetime(_ generation: UInt64, _ issued: UInt64, _ expires: UInt64, days: UInt64) throws {
        guard generation > 0, issued < expires, expires - issued <= days * 86_400_000 else { throw NativeFailure.invalidRecord }
    }
    public static func publicAddress(_ value: String) -> Bool {
        if LinkBytes.matches(value, "(?:[0-9]+\\.){3}[0-9]+") {
            let parts = value.split(separator: "."), bytes = parts.compactMap { Int($0) }
            guard bytes.count == 4, zip(parts, bytes).allSatisfy({ String($0.1) == $0.0 && $0.1 <= 255 }) else { return false }
            let a = bytes[0], b = bytes[1], c = bytes[2]
            return a > 0 && a < 224 && a != 10 && a != 127 && !(a == 100 && (64..<128).contains(b))
                && !(a == 169 && b == 254) && !(a == 172 && (16..<32).contains(b))
                && !(a == 192 && (b == 168 || b == 0 && [0, 2].contains(c) || b == 88 && c == 99))
                && !(a == 198 && ([18, 19].contains(b) || b == 51 && c == 100)) && !(a == 203 && b == 0 && c == 113)
        }
        guard LinkBytes.matches(value, "[a-f0-9:]{2,39}") else { return false }
        var address = in6_addr()
        guard value.withCString({ inet_pton(AF_INET6, $0, &address) }) == 1 else { return false }
        let bytes = withUnsafeBytes(of: &address) { Array($0) }, a = Int(bytes[0]) * 256 + Int(bytes[1]), b = Int(bytes[2]) * 256 + Int(bytes[3])
        return a & 0xe000 == 0x2000 && !(a == 0x2001 && (b < 0x200 || b == 0xdb8)) && a != 0x2002 && !(a == 0x3fff && b < 0x1000)
    }
    public static func endpoint(_ host: String, port: UInt16) throws -> URL {
        let literal = host.contains(":") || LinkBytes.matches(host, "[0-9.]+")
        guard port > 0, host.utf8.count <= 253 else { throw NativeFailure.invalidRecord }
        if literal { guard publicAddress(host) else { throw NativeFailure.invalidRecord } }
        else {
            let labels = host.split(separator: ".", omittingEmptySubsequences: false)
            guard labels.count >= 2, labels.allSatisfy({ LinkBytes.matches(String($0), "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?") }),
                  !["localhost", "local", "invalid", "test"].contains(String(labels.last!)) else { throw NativeFailure.invalidRecord }
        }
        guard let url = URL(string: "https://" + (host.contains(":") ? "[\(host)]" : host) + (port == 443 ? "" : ":\(port)") + "/") else { throw NativeFailure.invalidRecord }; return url
    }
    public struct Authority: Sendable {
        public let checkpoint: NativeAuthorityCheckpoint
        public let issuedAt: UInt64
        public let expiresAt: UInt64
        public let nodes: [NativeDirectoryNode]
        fileprivate let keys: [Key]
        fileprivate let revoked: Set<Data>
    }
    public static func verifyAuthority(_ authority: Data, signature rootSignature: Data, anchors: [Data], nowMs: UInt64,
        prior: NativeAuthorityCheckpoint? = nil) throws -> Authority {
        guard authority.count <= 16_384, rootSignature.count == 64, (1...2).contains(anchors.count),
              Set(anchors).count == anchors.count, anchors.allSatisfy({ $0.count == 32 }), nowMs <= LinkBytes.maximumInteger else { throw NativeFailure.invalidRecord }
        let rootInput = Data("latch-relay-authority-v1\0".utf8) + authority
        guard anchors.contains(where: { (try? Curve25519.Signing.PublicKey(rawRepresentation: $0).isValidSignature(rootSignature, for: rootInput)) == true }) else { throw NativeFailure.identityMismatch }
        var root = try LinkReader(authority, maximum: 16_384)
        guard try root.integer(1) == 1 else { throw NativeFailure.invalidRecord }
        let rootGeneration = try root.integer(8), rootIssued = try root.integer(8), rootExpires = try root.integer(8), keyCount = try root.integer(1)
        try lifetime(rootGeneration, rootIssued, rootExpires, days: 365)
        guard (1...4).contains(keyCount) else { throw NativeFailure.invalidRecord }
        var keys: [Key] = []
        for _ in 0..<keyCount {
            let key = Key(bytes: try root.take(32), before: try root.integer(8), after: try root.integer(8))
            try lifetime(1, key.before, key.after, days: 365)
            guard key.before >= rootIssued, key.after <= rootExpires else { throw NativeFailure.invalidRecord }; keys.append(key)
        }
        guard Set(keys.map(\.bytes)).count == keys.count else { throw NativeFailure.invalidRecord }
        let revokedCount = try root.integer(1); guard revokedCount <= 16 else { throw NativeFailure.invalidRecord }
        var revoked = Set<Data>()
        for _ in 0..<revokedCount { guard revoked.insert(try root.take(32)).inserted else { throw NativeFailure.invalidRecord } }
        let nodeCount = try root.integer(1); guard nodeCount <= 4 else { throw NativeFailure.invalidRecord }
        var nodes: [NativeDirectoryNode] = []
        for _ in 0..<nodeCount {
            let id = try root.take(16), region = try ascii(root.field(64)), pinCount = try root.integer(1)
            guard !region.isEmpty, (1...2).contains(pinCount) else { throw NativeFailure.invalidRecord }
            var pins: [Data] = []; for _ in 0..<pinCount { pins.append(try root.take(32)) }
            let portCount = try root.integer(1); guard portCount <= 4 else { throw NativeFailure.invalidRecord }
            var ports: [UInt16] = []; for _ in 0..<portCount { let port = UInt16(try root.integer(2)); guard port > 0 else { throw NativeFailure.invalidRecord }; ports.append(port) }
            guard Set(pins).count == pins.count, Set(ports).count == ports.count, !nodes.contains(where: {$0.relayId == id}) else { throw NativeFailure.invalidRecord }
            nodes.append(NativeDirectoryNode(relayId: id, region: region, spkiHashes: pins, ports: ports))
        }
        try root.done()
        guard rootIssued <= nowMs + 300_000, rootExpires > nowMs else { throw NativeFailure.expired }
        let hash = LinkBytes.hash(authority)
        if let prior {
            _ = try NativeAuthorityCheckpoint(generation: prior.generation, hash: prior.hash)
            guard rootGeneration >= prior.generation, rootGeneration != prior.generation || LinkBytes.equal(hash, prior.hash) else { throw NativeFailure.invalidRecord }
        }
        return Authority(checkpoint: try NativeAuthorityCheckpoint(generation: rootGeneration, hash: hash), issuedAt: rootIssued,
            expiresAt: rootExpires, nodes: nodes, keys: keys, revoked: revoked)
    }
    public static func verify(authority: Data, rootSignature: Data, addresses: Data, signature: Data, anchors: [Data], nowMs: UInt64,
        prior: NativeDirectoryCheckpoint? = nil) throws -> VerifiedRelayDirectory {
        guard authority.count <= 16_384, addresses.count <= 16_384, authority.count + addresses.count + 132 <= 32_768,
              rootSignature.count == 64, signature.count == 64, (1...2).contains(anchors.count), Set(anchors).count == anchors.count,
              anchors.allSatisfy({ $0.count == 32 }), nowMs <= LinkBytes.maximumInteger else { throw NativeFailure.invalidRecord }
        let floor = try prior.map { try NativeAuthorityCheckpoint(generation: $0.rootGeneration, hash: $0.rootHash) }
        let verified = try verifyAuthority(authority, signature: rootSignature, anchors: anchors, nowMs: nowMs, prior: floor)
        let rootGeneration = verified.checkpoint.generation, rootIssued = verified.issuedAt, rootExpires = verified.expiresAt,
            keys = verified.keys, revoked = verified.revoked, nodes = verified.nodes
        var online = try LinkReader(addresses, maximum: 16_384)
        guard try online.integer(1) == 1 else { throw NativeFailure.invalidRecord }
        let generation = try online.integer(8), issued = try online.integer(8), expires = try online.integer(8), boundRoot = try online.integer(8), rootHash = try online.take(32), key = try online.take(32)
        try lifetime(generation, issued, expires, days: 180)
        guard rootIssued <= nowMs + 300_000, issued <= nowMs + 300_000, rootExpires > nowMs, expires > nowMs,
              boundRoot == rootGeneration, LinkBytes.equal(LinkBytes.hash(authority), rootHash), let delegated = keys.first(where: {$0.bytes == key}),
              !revoked.contains(key), nowMs >= delegated.before, nowMs < delegated.after, issued >= delegated.before, expires <= delegated.after,
              expires <= rootExpires, try Curve25519.Signing.PublicKey(rawRepresentation: key).isValidSignature(signature, for: Data("latch-relay-addresses-v1\0".utf8) + addresses) else { throw NativeFailure.identityMismatch }
        let hash = LinkBytes.hash(addresses)
        if let prior {
            guard prior.rootGeneration > 0, prior.generation > 0, prior.rootHash.count == 32, prior.hash.count == 32,
                  rootGeneration >= prior.rootGeneration,
                  rootGeneration != prior.rootGeneration || LinkBytes.equal(rootHash, prior.rootHash),
                  rootGeneration != prior.rootGeneration || (generation >= prior.generation && (generation != prior.generation || LinkBytes.equal(hash, prior.hash))) else { throw NativeFailure.invalidRecord }
        }
        let count = try online.integer(1); guard count <= 4 else { throw NativeFailure.invalidRecord }
        var entries: [NativeDirectoryAddress] = []
        for _ in 0..<count {
            let id = try online.take(16), host = try ascii(online.field(253)), port = UInt16(try online.integer(2)), addressCount = try online.integer(1)
            guard (1...8).contains(addressCount), let granted = nodes.first(where: {$0.relayId == id}), port == 443 || granted.ports.contains(port), !entries.contains(where: {$0.relayId == id}) else { throw NativeFailure.invalidRecord }
            _ = try endpoint(host, port: port)
            var ips: [String] = []; for _ in 0..<addressCount { let ip = try ascii(online.field(45)); guard publicAddress(ip), !ips.contains(ip) else { throw NativeFailure.invalidRecord }; ips.append(ip) }
            if host.contains(":") || LinkBytes.matches(host, "[0-9.]+") { guard ips.contains(host) else { throw NativeFailure.invalidRecord } }
            entries.append(NativeDirectoryAddress(relayId: id, host: host, port: port, addresses: ips))
        }
        try online.done()
        return VerifiedRelayDirectory(checkpoint: try NativeDirectoryCheckpoint(rootGeneration: rootGeneration, rootHash: rootHash, generation: generation, hash: hash), expiresAt: min(expires, rootExpires), nodes: nodes, addresses: entries)
    }
}
