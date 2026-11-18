#if LATCH_SCREENS
import CryptoKit
import Foundation
import LatchNativeCore
import OSLog
import Security

/**
 * Live mode: the LatchScreens target, in the iOS Simulator, paired with a temporary test Host. The simulator has no
 * Secure Enclave, so the device keys are CryptoKit P-256 keys held by this process alone: never in the Keychain or on
 * disk, gone when it exits. The profile store's key is in memory too, over a directory of this process's own. TLS, the
 * knock, the root proof, the content window and requestIds are the product's. The Latch product never compiles this
 * file (`ios-app.e2e.ts` looks for the markers below; `pnpm check:boundaries` keeps them in LatchScreens code).
 */
enum PhoneLive {
    static let marker = "LatchLive software keys"
    enum PairingStage: String {
        case accepted, keysStarted, keysReady, draftSaved, dialStarted, dialReady, lanReady, beginStarted, beginReady, approved, completeReady, failed
    }
    enum ConnectionStage: String {
        case windowBound, windowClosed, readUnavailable, streamExpired, streamUnavailable, streamOther, metadataConfirmed, reconnectRequired, networkChanged, bookFailed, bodyReadRepair, eventBufferRepair, eventRecordRepair
    }
    private static let pairingStart = ContinuousClock.now
    private static let pairingLog = Logger(subsystem: "codes.latch.ios.screens", category: "pairing-timing")
    /** Fixed milestones only: no invitation, address, identifier or error description enters the diagnostic. */
    static func pairingCheckpoint(_ stage: PairingStage) {
        guard isOn else { return }
        let time = pairingStart.duration(to: .now).components
        let milliseconds = time.seconds * 1000 + time.attoseconds / 1_000_000_000_000_000
        pairingLog.notice("LatchLive pairing-stage \(stage.rawValue, privacy: .public) elapsed-ms \(milliseconds, privacy: .public)")
    }
    /** Booleans and monotonic time distinguish an expired body from a live connection; never record window receipts. */
    static func connectionCheckpoint(_ stage: ConnectionStage, leaseValid: Bool, connected: Bool) {
        guard isOn else { return }
        let time = pairingStart.duration(to: .now).components
        let milliseconds = time.seconds * 1000 + time.attoseconds / 1_000_000_000_000_000
        pairingLog.notice("LatchLive connection-stage \(stage.rawValue, privacy: .public) elapsed-ms \(milliseconds, privacy: .public) lease-valid \(leaseValid, privacy: .public) connected \(connected, privacy: .public)")
    }
    /** Fixed Core categories and bounded counters only. Diagnostics never alter the repair decision. */
    static func bodyRepairCheckpoint(_ value: NativeBodyRepair) {
        guard isOn else { return }
        let time = pairingStart.duration(to: .now).components
        let milliseconds = time.seconds * 1000 + time.attoseconds / 1_000_000_000_000_000
        pairingLog.notice("LatchLive body-repair \(value.cause.rawValue, privacy: .public) elapsed-ms \(milliseconds, privacy: .public) pending \(value.pending, privacy: .public) covered \(value.covered, privacy: .public) prefix \(value.coveredPrefixCount, privacy: .public) first-uncovered \(value.firstUncoveredKind.rawValue, privacy: .public) offers \(value.offers, privacy: .public) ordinal \(value.ordinal, privacy: .public)")
    }
    /** Only an explicit `-LatchLive 1` launch argument: no default, file or environment turns it on. */
    static let isOn: Bool = {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-LatchLive"), index + 1 < arguments.count else { return false }
        return arguments[index + 1] == "1"
    }()
    static let storeKey: Data = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    /** A directory per process; what an earlier one left is unreadable without its key, so it is cleared first. */
    static let storeDirectory: URL = {
        let parent = FileManager.default.temporaryDirectory
        for name in (try? FileManager.default.contentsOfDirectory(atPath: parent.path)) ?? [] where name.hasPrefix("LatchLive-") {
            try? FileManager.default.removeItem(at: parent.appendingPathComponent(name))
        }
        return parent.appendingPathComponent("LatchLive-" + UUID().uuidString, isDirectory: true)
    }()
}

/** The connection and verification keys of live mode, by the tags a `DeviceKeyReference` carries. */
final class LiveSoftwareKeys: @unchecked Sendable {
    private static let shared = LiveSoftwareKeys()
    private let lock = NSLock()
    private var keys: [Data: P256.Signing.PrivateKey] = [:]

    static func create() throws -> DeviceKeyReference {
        let prefix = "app.latch.ios.live.\(UUID().uuidString)."
        let connectionTag = Data((prefix + "connection").utf8), verificationTag = Data((prefix + "verification").utf8)
        let connection = P256.Signing.PrivateKey(), verification = P256.Signing.PrivateKey()
        shared.lock.lock(); defer { shared.lock.unlock() }
        shared.keys[connectionTag] = connection; shared.keys[verificationTag] = verification
        return DeviceKeyReference(connectionTag: connectionTag, verificationTag: verificationTag,
            connectionSpki: connection.publicKey.derRepresentation, verificationSpki: verification.publicKey.derRepresentation)
    }
    static func remove(_ reference: DeviceKeyReference) {
        shared.lock.lock(); defer { shared.lock.unlock() }
        shared.keys[reference.connectionTag] = nil; shared.keys[reference.verificationTag] = nil
    }
    static func key(_ tag: Data, spki: Data) throws -> P256.Signing.PrivateKey {
        shared.lock.lock(); let key = shared.keys[tag]; shared.lock.unlock()
        // A reference saved by an earlier process names keys that are gone with it.
        guard let key else { throw NativeFailure.storageUnavailable }
        guard LinkBytes.equal(key.publicKey.derRepresentation, spki) else { throw NativeFailure.identityMismatch }
        return key
    }
}

/** `SecureIdentityProvider`'s place in live mode. It never asks Face ID: the simulator has none to ask. */
struct LiveIdentityProvider: NativeIdentityProvider {
    let reference: DeviceKeyReference
    var connectionSpki: Data { reference.connectionSpki }
    var verificationSpki: Data { reference.verificationSpki }
    func identity() throws -> PlatformIdentity {
        let key = try LiveSoftwareKeys.key(reference.connectionTag, spki: reference.connectionSpki)
        // TLS takes a SecKey; this one is made from the bytes in memory and is not stored in the Keychain.
        guard let secKey = SecKeyCreateWithData(key.x963Representation as CFData, [kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass: kSecAttrKeyClassPrivate, kSecAttrKeySizeInBits: 256] as CFDictionary, nil) else { throw NativeFailure.unavailable }
        let certificate = try P256Certificate.create(spki: reference.connectionSpki, now: Date()) { try key.signature(for: $0).derRepresentation }
        return try PlatformIdentity(key: secKey, certificate: certificate)
    }
    func signEnrollment(_ statement: Data) throws -> Data {
        try LiveSoftwareKeys.key(reference.connectionTag, spki: reference.connectionSpki).signature(for: statement).rawRepresentation
    }
    func signVerification(_ statement: Data) async throws -> Data {
        try LiveSoftwareKeys.key(reference.verificationTag, spki: reference.verificationSpki).signature(for: statement).rawRepresentation
    }
}
#endif
