import Foundation

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
    public let comparisonCode: String
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
    public init(invitation: PairingInvitation, keys: any NativeIdentityProvider) throws {
        guard keys.connectionSpki.count == 91, keys.verificationSpki.count == 91,
              !LinkBytes.equal(keys.connectionSpki, keys.verificationSpki) else { throw NativeFailure.identityMismatch }
        self.invitation = invitation; self.keys = keys
    }
    public func begin(on connection: NativeHTTPConnection, name: String) async throws -> NativeEnrollment {
        guard !busy else { throw NativeFailure.unavailable }; busy = true; defer { busy = false }
        try deadline()
        guard !name.isEmpty, name.count <= 80, !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw NativeFailure.invalidRecord }
        let existing = try await own(connection)
        if let existing { return try view(existing) }
        let identity = try keys.identity()
        let body: [String: Any] = ["name": name, "publicKey": LinkBytes.base64url(keys.connectionSpki), "invitation": invitation.invitation,
            "native": ["certificate": identity.pem, "verificationKey": LinkBytes.base64url(keys.verificationSpki)]]
        let response: NativeHTTPResponse
        do { response = try await connection.request(.post, path: "/link/api/enrollments", body: JSONSerialization.data(withJSONObject: body)) }
        catch { throw NativeFailure.resultUnknown }
        guard response.status == 202, let enrollment = try object(response)["enrollment"] as? [String: Any] else { throw NativeFailure.resultUnknown }
        return try view(enrollment)
    }
    public func status(on connection: NativeHTTPConnection) async throws -> NativeEnrollment? {
        try deadline()
        guard let value = try await own(connection) else { return nil }
        return try view(value)
    }
    public func complete(on connection: NativeHTTPConnection,
        persist: @escaping @Sendable (PreparedNativeDevice) async throws -> Void) async throws -> PreparedNativeDevice {
        guard !busy else { throw NativeFailure.unavailable }; busy = true; defer { busy = false }
        try deadline()
        guard let value = try await own(connection) else { throw NativeFailure.unavailable }
        let enrollment = try view(value)
        guard ["approved", "completed"].contains(enrollment.status) else { throw NativeFailure.unavailable }
        let text = Data("latch-enroll-v1\n\(invitation.hostId)\n\(enrollment.id)\n\(enrollment.nonce)".utf8)
        let signature = try LinkBytes.fixed(keys.signEnrollment(text), 64)
        let body = try JSONSerialization.data(withJSONObject: ["signature": LinkBytes.base64url(signature)])
        let response = try await connection.request(.post, path: "/link/api/enrollments/\(enrollment.id)/prepare", body: body)
        let prepared = try object(response)
        guard response.status == 200, Set(prepared.keys) == Set(["deviceId", "addressBook"]),
              let deviceId = prepared["deviceId"] as? String, LinkBytes.matches(deviceId, "dev_[A-Za-z0-9_-]{22}"),
              let encoded = prepared["addressBook"] as? String else { throw NativeFailure.identityMismatch }
        let book = try AddressBookCodec.verify(encoded, rootSpki: invitation.rootSpki, deviceId: deviceId, nowMs: now())
        let key = try LinkBytes.hash(NativeCrypto.knockSecret(invitationHash: LinkBytes.hash(Data(invitation.invitation.utf8)),
            connectionSpki: keys.connectionSpki, verificationSpki: keys.verificationSpki))
        let device = PreparedNativeDevice(hostId: invitation.hostId, deviceId: deviceId, rootSpki: invitation.rootSpki, knockKey: key,
            signedAddressBook: encoded, bookGeneration: book.generation, bookHash: book.payloadHash)
        try await persist(device)
        try deadline()
        let completed: NativeHTTPResponse
        do { completed = try await connection.request(.post, path: "/link/api/enrollments/\(enrollment.id)/complete", body: body) }
        catch { throw NativeFailure.resultUnknown }
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
        guard Set(value.keys).isSubset(of: ["id", "status", "fingerprint", "nonce", "expiresAt", "hashDisplay", "reason"]),
              let id = value["id"] as? String, LinkBytes.matches(id, "[A-Za-z0-9_-]{1,64}"),
              let status = value["status"] as? String, ["pending", "approved", "completed", "denied", "expired", "cancelled"].contains(status),
              let nonce = value["nonce"] as? String, LinkBytes.matches(nonce, "[A-Za-z0-9_-]{16,128}"),
              let deadline = value["expiresAt"] as? String, let expires = ISO8601DateFormatter.latch.date(from: deadline),
              expires <= invitation.expiresAt.addingTimeInterval(60) else { throw NativeFailure.invalidRecord }
        return try NativeEnrollment(id: id, status: status, nonce: nonce, expiresAt: expires,
            comparisonCode: NativeCrypto.pairingCode(invitationHash: LinkBytes.hash(Data(invitation.invitation.utf8)),
                connectionSpki: keys.connectionSpki, verificationSpki: keys.verificationSpki))
    }
    private func object(_ response: NativeHTTPResponse) throws -> [String: Any] {
        guard response.body.count <= 131_072, let value = try JSONSerialization.jsonObject(with: response.body) as? [String: Any] else { throw NativeFailure.invalidRecord }; return value
    }
    private func now() throws -> UInt64 {
        let value = Date().timeIntervalSince1970 * 1000
        guard value >= 0, value <= Double(LinkBytes.maximumInteger) else { throw NativeFailure.expired }; return UInt64(value)
    }
    private func deadline() throws { guard Date() < invitation.expiresAt else { throw NativeFailure.expired } }
}
