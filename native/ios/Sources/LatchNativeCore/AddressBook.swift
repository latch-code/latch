import CryptoKit
import CoreFoundation
import Darwin
import Foundation

public struct NativeRelayPass: Codable, Sendable {
    public let bytes: Data
    public let holderSeed: Data
    public func routeId() throws -> Data { LinkBytes.hash(Data("latch-route-id-v1\0".utf8) + (try AdmissionPass.decode(bytes)).routePublicKey).prefix(16) }
    public func admission(timeMs: UInt64, nonce: Data) throws -> Data {
        let pass = try AdmissionPass.decode(bytes)
        let input = try Data("latch-relay-proof-v1\0".utf8) + pass.relayId + routeId() + pass.tag + LinkBytes.integer(timeMs, size: 8) + LinkBytes.fixed(nonce, 16)
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: LinkBytes.fixed(holderSeed, 32))
        guard LinkBytes.equal(key.publicKey.rawRepresentation, pass.holderPublicKey) else { throw NativeFailure.identityMismatch }
        return try bytes + LinkBytes.integer(timeMs, size: 8) + nonce + key.signature(for: input)
    }
}
public struct NativeRelayAddress: Codable, Sendable {
    public let relayId: Data
    public let url: URL
    public let spkiHash: Data
    public let passes: [NativeRelayPass]
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
        guard try reader.integer(1) == 1, try reader.integer(1) == 0 else { throw NativeFailure.invalidRecord }
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
            let relayId = try reader.take(16), url = try relayURL(text(reader.field(512))), spki = try reader.take(32), passCount = try reader.integer(1)
            guard relayIds.insert(relayId).inserted, (1...64).contains(passCount) else { throw NativeFailure.invalidRecord }
            var passes: [NativeRelayPass] = [], days = Set<String>()
            for _ in 0..<passCount {
                let raw = try reader.take(174), seed = try reader.take(32), pass = try AdmissionPass.decode(raw)
                let holder = try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation
                guard !pass.pairing, LinkBytes.equal(pass.relayId, relayId), LinkBytes.equal(holder, pass.holderPublicKey),
                      days.insert("\(pass.day):\(LinkBytes.hex(pass.routePublicKey))").inserted else { throw NativeFailure.identityMismatch }
                passes.append(NativeRelayPass(bytes: raw, holderSeed: seed))
            }
            relays.append(NativeRelayAddress(relayId: relayId, url: url, spkiHash: spki, passes: passes))
        }
        try reader.done()
        return NativeAddressBook(hostId: hostId, deviceId: actualDevice, generation: generation, issuedAt: issuedAt, expiresAt: expiresAt, discoveryKey: discoveryKey, lan: lan, relays: relays, payloadHash: payloadHash)
    }
}

public struct PairingInvitation: Sendable {
    public let rootSpki: Data
    public let invitation: String
    public let direct: [PairingAddress]
    public let relays: [NativeRelayAddress]
    public let expiresAt: Date
    public let hostId: String
    public struct PairingAddress: Codable, Sendable { public let host: String; public let port: UInt16 }
    public static func parse(_ encoded: String, now: Date = Date()) throws -> PairingInvitation {
        guard encoded.hasPrefix("LATCHPAIR1."), encoded.count <= 16_384 else { throw NativeFailure.invalidRecord }
        let bytes = try LinkBytes.decode64(String(encoded.dropFirst(11)), maximum: 12_288)
        guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(object.keys) == Set(["v", "rootSpki", "invitation", "direct", "relays", "expiresAt"]),
              let v = object["v"] as? NSNumber, CFGetTypeID(v) == CFNumberGetTypeID(), v.doubleValue == 1,
              let rootText = object["rootSpki"] as? String, let invitation = object["invitation"] as? String,
              LinkBytes.matches(invitation, "lpi1-[A-Z2-7]{26}"),
              let entries = object["direct"] as? [[String: Any]], entries.count <= 8,
              let relayEntries = object["relays"] as? [[String: Any]], relayEntries.count <= 2,
              let deadline = object["expiresAt"] as? String, let expires = ISO8601DateFormatter.latch.date(from: deadline) else { throw NativeFailure.invalidRecord }
        guard expires > now else { throw NativeFailure.expired }
        guard expires.timeIntervalSince(now) <= 660 else { throw NativeFailure.invalidRecord }
        let root = try LinkBytes.decode64(rootText, maximum: 256)
        _ = try P256.Signing.PublicKey(derRepresentation: root)
        var addresses: [PairingAddress] = []
        for item in entries {
            guard Set(item.keys) == Set(["host", "port"]), let host = item["host"] as? String, AddressBookCodec.isIP(host),
                  let port = item["port"] as? NSNumber, CFGetTypeID(port) == CFNumberGetTypeID(), port.doubleValue.rounded(.down) == port.doubleValue,
                  (1...65_535).contains(port.doubleValue) else { throw NativeFailure.invalidRecord }
            addresses.append(PairingAddress(host: host, port: port.uint16Value))
        }
        var relays: [NativeRelayAddress] = [], known = Set<Data>()
        for item in relayEntries {
            guard Set(item.keys) == Set(["relayId", "url", "spkiHash", "pass", "holderSeed"]),
                  let id = item["relayId"] as? String, let rawURL = item["url"] as? String, let hash = item["spkiHash"] as? String,
                  let rawPass = item["pass"] as? String, let rawSeed = item["holderSeed"] as? String else { throw NativeFailure.invalidRecord }
            let relayId = try LinkBytes.fixed(LinkBytes.unhex(id, maximum: 16), 16), spkiHash = try LinkBytes.fixed(LinkBytes.unhex(hash, maximum: 32), 32),
                bytes = try LinkBytes.fixed(LinkBytes.decode64(rawPass, maximum: 174), 174), seed = try LinkBytes.fixed(LinkBytes.decode64(rawSeed, maximum: 32), 32), pass = try AdmissionPass.decode(bytes)
            guard pass.pairing, LinkBytes.equal(pass.relayId, relayId), known.insert(relayId).inserted,
                  LinkBytes.equal(try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation, pass.holderPublicKey) else { throw NativeFailure.identityMismatch }
            relays.append(NativeRelayAddress(relayId: relayId, url: try AddressBookCodec.relayURL(rawURL), spkiHash: spkiHash, passes: [NativeRelayPass(bytes: bytes, holderSeed: seed)]))
        }
        guard !addresses.isEmpty || !relays.isEmpty else { throw NativeFailure.unsupported }
        return PairingInvitation(rootSpki: root, invitation: invitation, direct: addresses, relays: relays, expiresAt: expires, hostId: LinkBytes.base32(LinkBytes.hash(root)))
    }
}

extension ISO8601DateFormatter {
    static var latch: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }
}
