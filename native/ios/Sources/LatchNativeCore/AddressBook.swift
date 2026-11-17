import CryptoKit
import CoreFoundation
import Darwin
import Foundation

public struct NativeRelayPass: Codable, Sendable {
    public let bytes: Data
    public let holderSeed: Data
    public init(bytes: Data, holderSeed: Data) { self.bytes = bytes; self.holderSeed = holderSeed }
    public func routeId() throws -> Data { LinkBytes.hash(Data("latch-route-id-v1\0".utf8) + (try AdmissionPass.decode(bytes)).routePublicKey).prefix(16) }
    public func admission(timeMs: UInt64, nonce: Data) throws -> Data {
        let pass = try AdmissionPass.decode(bytes)
        let input = try Data("latch-relay-proof-v1\0".utf8) + pass.relayId + routeId() + pass.tag + LinkBytes.integer(timeMs, size: 8) + LinkBytes.fixed(nonce, 16)
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: LinkBytes.fixed(holderSeed, 32))
        guard LinkBytes.equal(key.publicKey.rawRepresentation, pass.holderPublicKey) else { throw NativeFailure.identityMismatch }
        return try bytes + LinkBytes.integer(timeMs, size: 8) + nonce + key.signature(for: input)
    }
    /** The edge kind's single-use proof (link-wire pass.ts `boundProofInput`): v1's fields plus the node's 32-byte nonce. */
    public func boundAdmission(timeMs: UInt64, nonce: Data, relayNonce: Data) throws -> Data {
        let pass = try AdmissionPass.decode(bytes)
        let input = try Data("latch-relay-proof-v2\0".utf8) + pass.relayId + routeId() + pass.tag + LinkBytes.integer(timeMs, size: 8)
            + LinkBytes.fixed(nonce, 16) + LinkBytes.fixed(relayNonce, 32)
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: LinkBytes.fixed(holderSeed, 32))
        guard LinkBytes.equal(key.publicKey.rawRepresentation, pass.holderPublicKey) else { throw NativeFailure.identityMismatch }
        return try bytes + LinkBytes.integer(timeMs, size: 8) + nonce + key.signature(for: input)
    }
}
/** An edge node proves itself with this Ed25519 key over the challenge; every origin is only an address of it. */
public struct NativeEdgeIdentity: Codable, Sendable, Equatable {
    public let relayKey: Data
    public let shard: Int
    public let extraURLs: [URL]
}
public struct NativeRelayAddress: Codable, Sendable {
    public let relayId: Data
    public let url: URL
    public let spkiHash: Data
    public let passes: [NativeRelayPass]
    public let profile: NativeRelayProfile?
    /** Present only for the edge kind; then `spkiHash` is 32 zero bytes, which no certificate matches. */
    public let edge: NativeEdgeIdentity?
    public let region: String?
    public init(relayId: Data, url: URL, spkiHash: Data, passes: [NativeRelayPass], profile: NativeRelayProfile? = nil,
                edge: NativeEdgeIdentity? = nil, region: String? = nil) {
        self.relayId = relayId; self.url = url; self.spkiHash = spkiHash; self.passes = passes; self.profile = profile
        self.edge = edge; self.region = region
    }
    /** Every origin of the node, in signed order. */
    public var urls: [URL] { [url] + (edge?.extraURLs ?? []) }
}
public struct NativeLanAddress: Codable, Sendable {
    public let address: String
    public let port: UInt16
    public let kind: String
    public let prefixLength: Int
    public let gatewayHash: Data
}
public struct NativeAddressBook: Codable, Sendable {
    public let hostId: String
    public let deviceId: String
    public let generation: UInt64
    public let issuedAt: UInt64
    public let expiresAt: UInt64
    public let discoveryKey: Data
    public let lan: [NativeLanAddress]
    public let relays: [NativeRelayAddress]
    public let payloadHash: Data
    public let directory: NativeDirectorySource?
    public var hostRegion: String? = nil
}
/** Relays in the Host's measured region first, then the rest in signed order (link-wire `orderRelays`). */
public enum NativeRelayOrder {
    // Match the Host's Workers release gate, including address books already stored on this phone.
    static let edgeAvailable = false
    public static func available(_ book: NativeAddressBook?) -> [NativeRelayAddress] {
        ordered(book).filter { $0.edge == nil || edgeAvailable }
    }
    public static func ordered(_ book: NativeAddressBook?) -> [NativeRelayAddress] {
        guard let book else { return [] }
        guard let near = book.hostRegion else { return book.relays }
        return book.relays.filter { $0.region == near } + book.relays.filter { $0.region != near }
    }
}

public struct AdmissionPass: Sendable {
    public let pairing: Bool
    public let relayId: Data
    public let day: UInt64
    public let notBefore: UInt64
    public let notAfter: UInt64
    public let routePublicKey: Data
    public let holderPublicKey: Data
    public let tag: Data
    public let signature: Data
    public static func decode(_ bytes: Data) throws -> AdmissionPass {
        var reader = try LinkReader(bytes, maximum: 174)
        guard try reader.integer(1) == 1 else { throw NativeFailure.invalidRecord }
        let flags = try reader.integer(1)
        guard flags <= 1 else { throw NativeFailure.invalidRecord }
        let value = try AdmissionPass(pairing: flags == 1, relayId: reader.take(16), day: reader.integer(4), notBefore: reader.integer(4), notAfter: reader.integer(4), routePublicKey: reader.take(32), holderPublicKey: reader.take(32), tag: reader.take(16), signature: reader.take(64))
        try reader.done()
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: value.routePublicKey)
        guard key.isValidSignature(value.signature, for: Data("latch-relay-pass-v1\0".utf8) + bytes.prefix(110)), value.notAfter > value.notBefore,
              value.notAfter - value.notBefore <= (value.pairing ? 600 : 88_200), value.notBefore + 900 >= value.day * 86_400,
              value.notAfter <= value.day * 86_400 + 87_300 else { throw NativeFailure.identityMismatch }
        return value
    }
}

public enum AddressBookCodec {
    public static func isIP(_ address: String) -> Bool {
        var v4 = in_addr(), v6 = in6_addr()
        return address.withCString { inet_pton(AF_INET, $0, &v4) == 1 || inet_pton(AF_INET6, $0, &v6) == 1 }
    }
    public static func relayURL(_ text: String) throws -> URL {
        guard text.count <= 512, LinkBytes.matches(text, "https://([a-z0-9.-]{1,253}|\\[[a-f0-9:]{2,45}\\])(:[0-9]{1,5})?/?"),
              let url = URL(string: text), let host = url.host, !host.isEmpty, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/", (1...65_535).contains(url.port ?? 443) else { throw NativeFailure.invalidRecord }
        return url
    }
    public static func verify(_ encoded: String, rootSpki: Data, deviceId: String, nowMs: UInt64, priorGeneration: UInt64 = 0, priorHash: Data? = nil) throws -> NativeAddressBook {
        try decode(encoded, rootSpki: rootSpki, deviceId: deviceId, nowMs: nowMs, priorGeneration: priorGeneration, priorHash: priorHash, discoveryOnly: false)
    }
    /** Expiry prevents dialing old addresses/passes; a signed key can still name a fresh local-network discovery. */
    public static func discoveryKey(_ encoded: String, rootSpki: Data, deviceId: String, nowMs: UInt64, priorGeneration: UInt64, priorHash: Data) throws -> Data {
        try decode(encoded, rootSpki: rootSpki, deviceId: deviceId, nowMs: nowMs, priorGeneration: priorGeneration, priorHash: priorHash, discoveryOnly: true).discoveryKey
    }
    private static func decode(_ encoded: String, rootSpki: Data, deviceId: String, nowMs: UInt64, priorGeneration: UInt64, priorHash: Data?, discoveryOnly: Bool) throws -> NativeAddressBook {
        guard encoded.hasPrefix("LATCHBOOK1."), encoded.utf8.count <= 90_011, nowMs <= LinkBytes.maximumInteger, priorGeneration <= LinkBytes.maximumInteger else { throw NativeFailure.invalidRecord }
        let bytes = try LinkBytes.decode64(String(encoded.dropFirst(11)), maximum: 65_600)
        guard bytes.count > 64 else { throw NativeFailure.invalidRecord }
        let payload = Data(bytes.dropLast(64)), signature = Data(bytes.suffix(64))
        guard NativeCrypto.verifyP256(spki: rootSpki, input: Data("latch-address-book-v1\0".utf8) + payload, signature: signature) else { throw NativeFailure.identityMismatch }
        var reader = try LinkReader(payload)
        let version = try reader.integer(1)
        guard [1, 2, 3, 4].contains(version), try reader.integer(1) == 0 else { throw NativeFailure.invalidRecord }
        func text(_ bytes: Data) throws -> String {
            guard bytes.allSatisfy({ (33...126).contains($0) }), let value = String(data: bytes, encoding: .ascii) else { throw NativeFailure.invalidRecord }
            return value
        }
        let hostId = try text(reader.field(52)), actualDevice = try text(reader.field(26)), generation = try reader.integer(8), issuedAt = try reader.integer(8), expiresAt = try reader.integer(8), discoveryKey = try reader.take(32)
        guard hostId == LinkBytes.base32(LinkBytes.hash(rootSpki)), LinkBytes.matches(hostId, "[a-z2-7]{52}"), actualDevice == deviceId,
              LinkBytes.matches(actualDevice, "dev_[A-Za-z0-9_-]{22}"), generation > 0, generation >= priorGeneration,
              issuedAt <= nowMs + 60_000, (discoveryOnly || expiresAt > nowMs), expiresAt > issuedAt, expiresAt - issuedAt <= 31 * 86_400_000 else { throw NativeFailure.expired }
        let payloadHash = LinkBytes.hash(payload)
        if generation == priorGeneration, let priorHash, !LinkBytes.equal(priorHash, payloadHash) { throw NativeFailure.identityMismatch }
        let count = try reader.integer(1)
        guard count <= 8 else { throw NativeFailure.invalidRecord }
        var lan: [NativeLanAddress] = [], known = Set<String>()
        for _ in 0..<count {
            let address = try text(reader.field(45)), port = try reader.integer(2), kind = try reader.integer(1), prefix = try reader.integer(1), gatewayHash = try reader.take(32)
            guard isIP(address), port > 0, kind < 3, prefix <= (address.contains(":") ? 128 : 32), known.insert("\(address):\(port)").inserted else { throw NativeFailure.invalidRecord }
            lan.append(NativeLanAddress(address: address, port: UInt16(port), kind: ["wifi", "ethernet", "tunnel"][Int(kind)], prefixLength: Int(prefix), gatewayHash: gatewayHash))
        }
        let relayCount = try reader.integer(1)
        guard relayCount <= 4 else { throw NativeFailure.invalidRecord }
        var relays: [NativeRelayAddress] = [], relayIds = Set<Data>()
        for _ in 0..<relayCount {
            let relayId = try reader.take(16), url = try relayURL(text(reader.field(512)))
            let kind = try version == 4 ? reader.integer(1) : 0, identity = try reader.take(32), profile = try version >= 3 ? reader.integer(1) : 0
            let shard = try version == 4 ? reader.integer(1) : 0, regionBytes = try version == 4 ? reader.field(16) : Data()
            let extraCount = try version == 4 ? reader.integer(1) : 0
            guard kind <= 1, kind == 1 || shard == 0, shard < 16, extraCount <= 3 else { throw NativeFailure.invalidRecord }
            var extra: [URL] = []
            for _ in 0..<extraCount { extra.append(try relayURL(text(reader.field(512)))) }
            let region = try regionBytes.isEmpty ? nil : text(regionBytes)
            let passCount = try reader.integer(1)
            guard profile <= 1, relayIds.insert(relayId).inserted, (1...64).contains(passCount),
                  region.map({ LinkBytes.matches($0, "[a-z0-9-]{1,16}") }) ?? true,
                  Set(([url] + extra).map(\.absoluteString)).count == extra.count + 1,
                  kind == 1 || extra.isEmpty,
                  kind == 0 || (profile == 1 && !identity.allSatisfy { $0 == 0 }) else { throw NativeFailure.invalidRecord }
            var passes: [NativeRelayPass] = [], days = Set<String>()
            for _ in 0..<passCount {
                let raw = try reader.take(174), seed = try reader.take(32), pass = try AdmissionPass.decode(raw)
                let holder = try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation
                guard !pass.pairing, LinkBytes.equal(pass.relayId, relayId), LinkBytes.equal(holder, pass.holderPublicKey),
                      days.insert("\(pass.day):\(LinkBytes.hex(pass.routePublicKey))").inserted else { throw NativeFailure.identityMismatch }
                passes.append(NativeRelayPass(bytes: raw, holderSeed: seed))
            }
            relays.append(NativeRelayAddress(relayId: relayId, url: url, spkiHash: kind == 1 ? Data(count: 32) : identity, passes: passes,
                profile: profile == 1 ? .outerPadV2 : nil, edge: kind == 1 ? NativeEdgeIdentity(relayKey: identity, shard: Int(shard), extraURLs: extra) : nil,
                region: region))
        }
        var directory: NativeDirectorySource?
        if version >= 2 {
            let bytes = try reader.field(2240)
            if !bytes.isEmpty { directory = try NativeDirectorySource.decode(bytes) }
            else if version == 2 { throw NativeFailure.invalidRecord }
        }
        var hostRegion: String?
        if version == 4 {
            let bytes = try reader.field(16)
            if !bytes.isEmpty {
                hostRegion = try text(bytes)
                guard LinkBytes.matches(hostRegion!, "[a-z0-9-]{1,16}") else { throw NativeFailure.invalidRecord }
            }
        }
        try reader.done()
        guard version != 3 || relays.contains(where: { $0.profile == .outerPadV2 }) else { throw NativeFailure.invalidRecord }
        guard version != 4 || hostRegion != nil || relays.contains(where: { $0.edge != nil || $0.region != nil }) else { throw NativeFailure.invalidRecord }
        var book = NativeAddressBook(hostId: hostId, deviceId: actualDevice, generation: generation, issuedAt: issuedAt, expiresAt: expiresAt, discoveryKey: discoveryKey, lan: lan, relays: relays, payloadHash: payloadHash, directory: directory)
        book.hostRegion = hostRegion
        return book
    }
}

extension ISO8601DateFormatter {
    static var latch: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }
}
