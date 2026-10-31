import CryptoKit
import Darwin
import Foundation
import Network

/**
 * The universal-link form is `pairingLinkBase#2.<base64url>`, for example `https://<official-domain>/pair`. Empty until the
 * official domain exists, and then not accepted. Keep it equal to `PAIRING_LINK_BASE` in packages/link-wire/src/pairing.ts.
 */
public let pairingLinkBase = ""
private let pairingPrefix = "LATCHPAIR2.", oldPairingPrefix = "LATCHPAIR1."

/** Why pairing ended, as the Host or the network said it. Each maps to one sheet on the phone. */
public enum NativePairingFailure: Error, Equatable, Sendable {
    case unreachable, notNearby, expired, contended, cancelled, timedOut, blocked, hostTooOld
}

/** The binary QR: no relays, scopes or names. Addresses are hints; only the pinned root identifies the Mac. */
public struct PairingInvitation: Sendable {
    public struct Address: Codable, Sendable { public let host: String; public let port: UInt16 }
    public let rootSpki: Data
    public let secret: Data
    public let lan: [Address]
    public let expiresAt: Date
    public let hostId: String
    /** The secret as the enrollment request names it. */
    public var invitation: String { "lpi1-" + LinkBytes.base32(secret).uppercased() }
    public var knockKey: Data { LinkBytes.hash(Data(invitation.utf8)) }
    /** Whether a scanned text is ours at all, to tell a foreign QR from a bad one. */
    public static func recognizes(_ text: String) -> Bool {
        text.hasPrefix(pairingPrefix) || text.hasPrefix(oldPairingPrefix) || (!pairingLinkBase.isEmpty && text.hasPrefix(pairingLinkBase + "#2."))
    }
    /**
     * A scanned QR, which must still be live, have a life a real sheet gives, and name only private addresses: a crafted
     * QR must not make this phone keep dialing out. Fixtures on loopback pass `privateOnly: false`.
     */
    public static func parse(_ encoded: String, now: Date = Date(), privateOnly: Bool = true) throws -> PairingInvitation {
        let value = try parseStored(encoded)
        guard value.expiresAt > now else { throw NativePairingFailure.expired }
        guard value.expiresAt.timeIntervalSince(now) <= 660 else { throw NativeFailure.invalidRecord }
        if privateOnly {
            for address in value.lan {
                let ip = try NativeDiscoveryWire.ip(address.host)
                guard NativeDiscoveryWire.privatePeer(ip.bytes, family: ip.family) else { throw NativeFailure.invalidRecord }
            }
        }
        return value
    }
    /** A draft's QR, which may have expired while its enrollment still runs; the Host decides. */
    public static func parseStored(_ encoded: String) throws -> PairingInvitation {
        guard encoded.utf8.count <= 512 else { throw NativeFailure.invalidRecord }
        if encoded.hasPrefix(oldPairingPrefix) { throw NativePairingFailure.hostTooOld }
        let body: Substring
        if encoded.hasPrefix(pairingPrefix) { body = encoded.dropFirst(pairingPrefix.count) }
        else if !pairingLinkBase.isEmpty, encoded.hasPrefix(pairingLinkBase + "#2.") { body = encoded.dropFirst(pairingLinkBase.count + 3) }
        else { throw NativeFailure.invalidRecord }
        return try decode(LinkBytes.decode64(String(body), maximum: 256))
    }
    public static func decode(_ bytes: Data) throws -> PairingInvitation {
        var reader = try LinkReader(bytes, maximum: 256)
        guard try reader.integer(1) == 2 else { throw NativeFailure.invalidRecord }
        let root = try reader.take(91), secret = try reader.take(16), expires = try reader.integer(4), count = try reader.integer(1)
        _ = try P256.Signing.PublicKey(derRepresentation: root)
        guard (1...2).contains(count) else { throw NativeFailure.invalidRecord }
        var lan: [Address] = []
        for _ in 0..<count {
            let family = try reader.integer(1)
            guard family == 4 || family == 6 else { throw NativeFailure.invalidRecord }
            let raw = try reader.take(family == 4 ? 4 : 16), port = try reader.integer(2)
            guard (1...65_535).contains(port), let host = NativeDiscoveryWire.text(raw, family: UInt8(family)) else { throw NativeFailure.invalidRecord }
            lan.append(Address(host: host, port: UInt16(port)))
        }
        try reader.done()
        return PairingInvitation(rootSpki: root, secret: secret, lan: lan, expiresAt: Date(timeIntervalSince1970: TimeInterval(expires)), hostId: LinkBytes.base32(LinkBytes.hash(root)))
    }
}

extension NativeDiscoveryWire {
    static func text(_ bytes: Data, family: UInt8) -> String? {
        guard bytes.count == (family == 4 ? 4 : 16) else { return nil }
        var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
        let count = socklen_t(buffer.count)
        guard bytes.withUnsafeBytes({ inet_ntop(family == 4 ? AF_INET : AF_INET6, $0.baseAddress, &buffer, count) }) != nil else { return nil }
        return buffer.withUnsafeBufferPointer { $0.baseAddress.flatMap { String(validatingCString: $0) } }
    }
    /**
     * What this phone reports for the network it shares with `peer`. An interface in the peer's subnet, with the current
     * router on it if there is one. Without one this phone is the router: its Personal Hotspot. The Host alone decides
     * whether the peer is nearby; a tunnel or a route elsewhere gives no interface and so no claim.
     */
    public static func pairingGatewayHash(peer: String, interfaces: [(address: String, mask: Data)], routers: [String]) -> Data? {
        guard let target = try? ip(peer) else { return nil }
        for row in interfaces {
            guard let local = try? ip(row.address), local.family == target.family, row.mask.count == local.bytes.count,
                  privatePeer(local.bytes, family: local.family),
                  zip(local.bytes, row.mask).map({ $0 & $1 }) == zip(target.bytes, row.mask).map({ $0 & $1 }) else { continue }
            // An IPv6 router is normally link-local, outside the prefix; the Mac names the same one.
            let router = routers.first { candidate in
                guard let value = try? ip(candidate), value.family == local.family, value.bytes != local.bytes else { return false }
                if value.family == 6, value.bytes[0] == 254, value.bytes[1] & 192 == 128 { return true }
                return zip(local.bytes, row.mask).map({ $0 & $1 }) == zip(value.bytes, row.mask).map({ $0 & $1 })
            }
            if let hash = try? gatewayHash(address: row.address, mask: row.mask, gateway: router ?? row.address) { return hash }
        }
        return nil
    }
    /**
     * The LAN's own paths. The system default may be a tunnel or cellular while Wi‑Fi is up, and its routers are not the
     * LAN's, so each LAN interface type is asked for itself. A type that has no path yet answers empty within a moment.
     */
    public static func lanPaths() async -> [NWPath] {
        await withTaskGroup(of: NWPath?.self) { group in
            for type in [NWInterface.InterfaceType.wifi, .wiredEthernet] {
                group.addTask {
                    await withCheckedContinuation { (continuation: CheckedContinuation<NWPath?, Never>) in
                        let monitor = NWPathMonitor(requiredInterfaceType: type), once = NativePathOnce(continuation, monitor)
                        monitor.pathUpdateHandler = { once.finish($0) }
                        monitor.start(queue: DispatchQueue(label: "app.latch.pairing-lan-path"))
                        DispatchQueue.global().asyncAfter(deadline: .now() + 1) { once.finish(nil) }
                    }
                }
            }
            var paths: [NWPath] = []
            for await path in group { if let path { paths.append(path) } }
            return paths
        }
    }
    /** The live values for `pairingGatewayHash`: every interface that is up, and the routers of the given paths. */
    public static func pairingGatewayHash(peer: String, paths: [NWPath]) -> Data? {
        var routers: [String] = []
        for endpoint in paths.flatMap(\.gateways) {
            guard case let .hostPort(host, _) = endpoint else { continue }
            switch host {
            case let .ipv4(value): if let text = text(value.rawValue, family: 4) { routers.append(text) }
            case let .ipv6(value): if let text = text(value.rawValue, family: 6) { routers.append(text) }
            default: continue
            }
        }
        var first: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&first) == 0 else { return nil }
        defer { freeifaddrs(first) }
        var interfaces: [(address: String, mask: Data)] = [], cursor = first, visited = 0
        while let current = cursor, visited < 256 {
            defer { cursor = current.pointee.ifa_next }
            visited += 1
            let row = current.pointee
            guard row.ifa_flags & UInt32(IFF_UP) != 0, row.ifa_flags & UInt32(IFF_LOOPBACK) == 0,
                  let address = row.ifa_addr, let mask = row.ifa_netmask, address.pointee.sa_family == mask.pointee.sa_family else { continue }
            let family: UInt8
            switch Int32(address.pointee.sa_family) { case AF_INET: family = 4; case AF_INET6: family = 6; default: continue }
            func bytes(_ pointer: UnsafeMutablePointer<sockaddr>) -> Data {
                if family == 4 { return pointer.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                    var value = $0.pointee.sin_addr; return withUnsafeBytes(of: &value) { Data($0) }
                } }
                return pointer.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) {
                    var value = $0.pointee.sin6_addr; return withUnsafeBytes(of: &value) { Data($0) }
                }
            }
            if let text = text(bytes(address), family: family) { interfaces.append((text, bytes(mask))) }
        }
        return pairingGatewayHash(peer: peer, interfaces: interfaces, routers: routers)
    }
}

private final class NativePathOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<NWPath?, Never>?
    private let monitor: NWPathMonitor
    init(_ continuation: CheckedContinuation<NWPath?, Never>, _ monitor: NWPathMonitor) { self.continuation = continuation; self.monitor = monitor }
    func finish(_ path: NWPath?) {
        lock.lock(); let current = continuation; continuation = nil; lock.unlock()
        guard let current else { return }
        monitor.cancel(); current.resume(returning: path)
    }
}

public protocol NativeIdentityProvider: Sendable {
    var connectionSpki: Data { get }
    var verificationSpki: Data { get }
    func identity() throws -> PlatformIdentity
    func signEnrollment(_ statement: Data) throws -> Data
    func signVerification(_ statement: Data) async throws -> Data
}
public struct SecureIdentityProvider: NativeIdentityProvider {
    public let reference: DeviceKeyReference
    public init(reference: DeviceKeyReference) { self.reference = reference }
    public var connectionSpki: Data { reference.connectionSpki }
    public var verificationSpki: Data { reference.verificationSpki }
    public func identity() throws -> PlatformIdentity { try SecureDeviceKeys.connectionIdentity(reference) }
    public func signEnrollment(_ statement: Data) throws -> Data { try SecureDeviceKeys.signEnrollment(reference, statement: statement) }
    public func signVerification(_ statement: Data) async throws -> Data { try await SecureDeviceKeys.signVerification(reference, statement: statement) }
}

public struct NativeEnrollment: Sendable {
    public let id: String
    public let status: String
    public let nonce: String
    public let expiresAt: Date
    /** Cancelled because another device presented a QR of the same pairing sheet. */
    public let contended: Bool
}
public struct PreparedNativeDevice: Codable, Sendable {
    public let hostId: String
    public let deviceId: String
    public let rootSpki: Data
    public let knockKey: Data
    public let signedAddressBook: String
    public let bookGeneration: UInt64
    public let bookHash: Data
    public func replacingAddressBook(_ encoded: String, nowMs: UInt64) throws -> PreparedNativeDevice {
        let book = try AddressBookCodec.verify(encoded, rootSpki: rootSpki, deviceId: deviceId, nowMs: nowMs,
            priorGeneration: bookGeneration, priorHash: bookHash)
        return PreparedNativeDevice(hostId: hostId, deviceId: deviceId, rootSpki: rootSpki, knockKey: knockKey,
            signedAddressBook: encoded, bookGeneration: book.generation, bookHash: book.payloadHash)
    }
}

/** Recovery always queries this invitation's own enrollment. Completion follows durable, encrypted book storage. */
public actor NativePairing {
    private let invitation: PairingInvitation
    private let keys: any NativeIdentityProvider
    private var busy = false
    /** What the Mac calls itself, read while completing. */
    public private(set) var hostName: String?
    public init(invitation: PairingInvitation, keys: any NativeIdentityProvider) throws {
        guard keys.connectionSpki.count == 91, keys.verificationSpki.count == 91,
              !LinkBytes.equal(keys.connectionSpki, keys.verificationSpki) else { throw NativeFailure.identityMismatch }
        self.invitation = invitation; self.keys = keys
    }
    /**
     * Presents this phone's keys. The Host answers with the phone's own enrollment when it already has one, so the same
     * request is how a resumed draft finds its place; other keys on a spent QR burn it.
     */
    public func begin(on connection: NativeHTTPConnection, name: String, gatewayHash: Data) async throws -> NativeEnrollment {
        guard !busy else { throw NativeFailure.unavailable }; busy = true; defer { busy = false }
        guard !name.isEmpty, name.count <= 80, !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }), gatewayHash.count == 32 else { throw NativeFailure.invalidRecord }
        let identity = try keys.identity()
        let body: [String: Any] = ["name": name, "publicKey": LinkBytes.base64url(keys.connectionSpki), "invitation": invitation.invitation,
            "gatewayHash": LinkBytes.hex(gatewayHash),
            "native": ["certificate": identity.pem, "verificationKey": LinkBytes.base64url(keys.verificationSpki)]]
        let response: NativeHTTPResponse
        do { response = try await connection.request(.post, path: "/link/api/enrollments", body: JSONSerialization.data(withJSONObject: body)) }
        catch { throw NativeFailure.resultUnknown }
        guard response.status == 202 else { throw refusal(response) }
        guard let enrollment = try object(response)["enrollment"] as? [String: Any] else { throw NativeFailure.resultUnknown }
        return try view(enrollment)
    }
    private func refusal(_ response: NativeHTTPResponse) -> Error {
        switch (try? object(response))?["error"] as? String {
        case "pairing-not-nearby": NativePairingFailure.notNearby
        case "pairing-contended": NativePairingFailure.contended
        case "invitation-invalid": NativePairingFailure.expired
        case "presence-blocked": NativePairingFailure.blocked
        case "enrollment-pending": NativeFailure.resultUnknown
        default: NativeFailure.unavailable
        }
    }
    public func status(on connection: NativeHTTPConnection) async throws -> NativeEnrollment? {
        guard let value = try await own(connection) else { return nil }
        return try view(value)
    }
    public func complete(on connection: NativeHTTPConnection,
        persist: @escaping @Sendable (PreparedNativeDevice) async throws -> Void) async throws -> PreparedNativeDevice {
        guard !busy else { throw NativeFailure.unavailable }; busy = true; defer { busy = false }
        guard let value = try await own(connection) else { throw NativeFailure.unavailable }
        let enrollment = try view(value)
        guard ["approved", "completed"].contains(enrollment.status) else { throw NativeFailure.unavailable }
        let text = Data("latch-enroll-v1\n\(invitation.hostId)\n\(enrollment.id)\n\(enrollment.nonce)".utf8)
        let signature = try LinkBytes.fixed(keys.signEnrollment(text), 64)
        let body = try JSONSerialization.data(withJSONObject: ["signature": LinkBytes.base64url(signature)])
        let response = try await connection.request(.post, path: "/link/api/enrollments/\(enrollment.id)/prepare", body: body)
        let prepared = try object(response)
        guard response.status == 200, Set(prepared.keys) == Set(["deviceId", "addressBook", "hostName"]),
              let deviceId = prepared["deviceId"] as? String, LinkBytes.matches(deviceId, "dev_[A-Za-z0-9_-]{22}"),
              let encoded = prepared["addressBook"] as? String else { throw NativeFailure.identityMismatch }
        let book = try AddressBookCodec.verify(encoded, rootSpki: invitation.rootSpki, deviceId: deviceId, nowMs: now())
        let key = try LinkBytes.hash(NativeCrypto.knockSecret(invitationHash: LinkBytes.hash(Data(invitation.invitation.utf8)),
            connectionSpki: keys.connectionSpki, verificationSpki: keys.verificationSpki))
        let device = PreparedNativeDevice(hostId: invitation.hostId, deviceId: deviceId, rootSpki: invitation.rootSpki, knockKey: key,
            signedAddressBook: encoded, bookGeneration: book.generation, bookHash: book.payloadHash)
        hostName = prepared["hostName"] as? String
        try await persist(device)
        let completed: NativeHTTPResponse
        do { completed = try await connection.request(.post, path: "/link/api/enrollments/\(enrollment.id)/complete", body: body) }
        catch { throw NativeFailure.resultUnknown }
        guard completed.status != 409 || (try? object(completed))?["error"] as? String != "pairing-contended" else { throw NativePairingFailure.contended }
        guard completed.status == 200, let actual = try object(completed)["device"] as? [String: Any],
              actual["id"] as? String == deviceId else { throw NativeFailure.resultUnknown }
        return device
    }
    public func cancel(on connection: NativeHTTPConnection) async throws {
        guard let value = try await own(connection) else { return }
        let enrollment = try view(value)
        let response = try await connection.request(.delete, path: "/link/api/enrollments/\(enrollment.id)")
        guard response.status == 200 else { throw NativeFailure.resultUnknown }
    }
    private func own(_ connection: NativeHTTPConnection) async throws -> [String: Any]? {
        let response = try await connection.request(.get, path: "/link/api/native/pairing")
        let value = try object(response)
        guard response.status == 200, Set(value.keys) == Set(["enrollment"]) else { throw NativeFailure.identityMismatch }
        if value["enrollment"] is NSNull { return nil }
        guard let item = value["enrollment"] as? [String: Any] else { throw NativeFailure.invalidRecord }
        return item
    }
    private func view(_ value: [String: Any]) throws -> NativeEnrollment {
        guard Set(value.keys).isSubset(of: ["id", "status", "fingerprint", "nonce", "expiresAt", "hashDisplay", "reason", "contended"]),
              let id = value["id"] as? String, LinkBytes.matches(id, "[A-Za-z0-9_-]{1,64}"),
              let status = value["status"] as? String, ["pending", "approved", "completed", "denied", "expired", "cancelled"].contains(status),
              let nonce = value["nonce"] as? String, LinkBytes.matches(nonce, "[A-Za-z0-9_-]{16,128}"),
              let deadline = value["expiresAt"] as? String, let expires = ISO8601DateFormatter.latch.date(from: deadline),
              expires.timeIntervalSinceNow <= 300 else { throw NativeFailure.invalidRecord }
        return NativeEnrollment(id: id, status: status, nonce: nonce, expiresAt: expires, contended: value["contended"] as? Bool == true)
    }
    private func object(_ response: NativeHTTPResponse) throws -> [String: Any] {
        guard response.body.count <= 131_072, let value = try JSONSerialization.jsonObject(with: response.body) as? [String: Any] else { throw NativeFailure.invalidRecord }; return value
    }
    private func now() throws -> UInt64 {
        let value = Date().timeIntervalSince1970 * 1000
        guard value >= 0, value <= Double(LinkBytes.maximumInteger) else { throw NativeFailure.expired }; return UInt64(value)
    }
}
