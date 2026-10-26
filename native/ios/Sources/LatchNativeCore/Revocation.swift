import Foundation

/** Only this verified Root statement authorizes retiring the device. Relay errors cannot construct one. */
public struct VerifiedNativeRevocation: Sendable {
    public let hostId: String
    public let deviceId: String
    public let revokedAt: UInt64
    public let tombstoneHash: String
    private init(hostId: String, deviceId: String, revokedAt: UInt64, tombstoneHash: String) {
        self.hostId = hostId; self.deviceId = deviceId; self.revokedAt = revokedAt; self.tombstoneHash = tombstoneHash
    }
    public static func verify(_ value: NativeJSON, rootSpki: Data, hostId: String, deviceId: String) throws -> VerifiedNativeRevocation {
        guard Set(value.object.keys) == Set(["hostId", "deviceId", "revokedAt", "signature"]),
              value["hostId"].string == hostId, value["deviceId"].string == deviceId,
              LinkBytes.matches(hostId, "[a-z2-7]{52}"), LinkBytes.matches(deviceId, "dev_[A-Za-z0-9_-]{22}"),
              LinkBytes.base32(LinkBytes.hash(rootSpki)) == hostId, let revokedAt = value["revokedAt"].integer,
              let encoded = value["signature"].string else { throw NativeFailure.identityMismatch }
        let signature = try LinkBytes.fixed(LinkBytes.decode64(encoded, maximum: 64), 64)
        let input = Data("latch-native-revoked-v1\n\(hostId)\n\(deviceId)\n\(revokedAt)".utf8)
        guard NativeCrypto.verifyP256(spki: rootSpki, input: input, signature: signature) else { throw NativeFailure.identityMismatch }
        return VerifiedNativeRevocation(hostId: hostId, deviceId: deviceId, revokedAt: revokedAt, tombstoneHash: LinkBytes.hex(LinkBytes.hash(input)))
    }
    func acknowledge(on connection: NativeHTTPConnection) async {
        let body = NativeJSON.object(["requestId": .string(UUID().uuidString), "tombstoneHash": .string(tombstoneHash)])
        // A lost acknowledgement must never prevent local credential removal after a verified revocation.
        await withTaskGroup(of: Void.self) { group in
            group.addTask { _ = try? await connection.request(.post, path: "/link/api/native/revocation/ack", body: body.encoded()) }
            group.addTask { try? await Task.sleep(for: .seconds(1)) }
            _ = await group.next(); group.cancelAll()
        }
    }
}
