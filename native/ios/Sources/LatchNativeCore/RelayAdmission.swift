import Foundation

/** Called at dial time with an endpoint from the fixed, Root-verified book; it never learns a new endpoint. */
public enum NativeRelayAdmission {
    public static func current(endpoint: NativeRelayAddress, bookExpiresAt: UInt64, nowMs: UInt64) throws -> NativeRelayPass {
        guard nowMs < bookExpiresAt else { throw NativeFailure.expired }
        for entry in endpoint.passes {
            let pass = try AdmissionPass.decode(entry.bytes)
            guard !pass.pairing, LinkBytes.equal(pass.relayId, endpoint.relayId) else { throw NativeFailure.identityMismatch }
            if pass.notBefore <= nowMs / 1000, nowMs / 1000 <= pass.notAfter { return entry }
        }
        throw NativeFailure.expired
    }
}
