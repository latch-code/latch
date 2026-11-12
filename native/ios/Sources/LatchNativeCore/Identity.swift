import CryptoKit
import Foundation
import LocalAuthentication
import Security

/** Immutable public metadata. Private key material is never encoded. */
public struct DeviceKeyReference: Codable, Sendable {
    public let connectionTag: Data
    public let verificationTag: Data
    public let connectionSpki: Data
    public let verificationSpki: Data
    public init(connectionTag: Data, verificationTag: Data, connectionSpki: Data, verificationSpki: Data) {
        self.connectionTag = connectionTag; self.verificationTag = verificationTag
        self.connectionSpki = connectionSpki; self.verificationSpki = verificationSpki
    }
}

public enum SecureDeviceKeys {
    public static func create() throws -> DeviceKeyReference {
        guard SecureEnclave.isAvailable else { throw NativeFailure.unsupported }
        let prefix = "app.latch.ios.\(UUID().uuidString)."
        let connectionTag = Data((prefix + "connection").utf8), verificationTag = Data((prefix + "verification").utf8)
        do {
            let connection = try generate(tag: connectionTag, access: [.privateKeyUsage]), verification = try generate(tag: verificationTag, access: verificationAccess)
            return try DeviceKeyReference(connectionTag: connectionTag, verificationTag: verificationTag, connectionSpki: publicSpki(connection), verificationSpki: publicSpki(verification))
        } catch {
            remove(tag: connectionTag); remove(tag: verificationTag)
            throw NativeFailure.storageUnavailable
        }
    }
    /**
     * Trust is set once, when the phone is connected, so the content-window key signs without asking. Face ID, when the
     * person turns it on, is asked by `signVerification`. A key made with `.userPresence` keeps it, since access control
     * cannot change, so signing still lets the system ask.
     */
    public static let verificationAccess: SecAccessControlCreateFlags = [.privateKeyUsage]
    private static func generate(tag: Data, access flags: SecAccessControlCreateFlags) throws -> SecKey {
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, nil),
              let key = SecKeyCreateRandomKey([
                kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
                kSecAttrKeySizeInBits: 256,
                kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
                kSecPrivateKeyAttrs: [kSecAttrIsPermanent: true, kSecAttrApplicationTag: tag, kSecAttrAccessControl: access],
              ] as CFDictionary, nil) else { throw NativeFailure.storageUnavailable }
        return key
    }
    private static func find(tag: Data, context: LAContext? = nil) throws -> SecKey {
        var query: [CFString: Any] = [kSecClass: kSecClassKey, kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
                                    kSecAttrApplicationTag: tag, kSecReturnRef: true, kSecMatchLimit: kSecMatchLimitOne]
        let authentication = context ?? LAContext()
        if context == nil { authentication.interactionNotAllowed = true }
        query[kSecUseAuthenticationContext] = authentication
        var value: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess, let value,
              CFGetTypeID(value) == SecKeyGetTypeID() else { throw NativeFailure.storageUnavailable }
        return (value as! SecKey)
    }
    public static func connectionIdentity(_ reference: DeviceKeyReference, now: Date = Date()) throws -> PlatformIdentity {
        let key = try find(tag: reference.connectionTag)
        guard LinkBytes.equal(try publicSpki(key), reference.connectionSpki) else { throw NativeFailure.identityMismatch }
        let certificate = try P256Certificate.create(spki: reference.connectionSpki, now: now) { try signDER(key, $0) }
        return try PlatformIdentity(key: key, certificate: certificate)
    }
    public static func signEnrollment(_ reference: DeviceKeyReference, statement: Data) throws -> Data {
        let key = try find(tag: reference.connectionTag)
        guard LinkBytes.equal(try publicSpki(key), reference.connectionSpki) else { throw NativeFailure.identityMismatch }
        return try P256.Signing.ECDSASignature(derRepresentation: signDER(key, statement)).rawRepresentation
    }
    public static func signVerification(_ reference: DeviceKeyReference, statement: Data, askOwner: Bool = false) async throws -> Data {
        try await Task.detached(priority: .userInitiated) {
            let context = LAContext()
            context.localizedReason = "查看这台 Mac 上的会话"
            context.touchIDAuthenticationAllowableReuseDuration = 0
            defer { context.invalidate() }
            if askOwner {
                do { try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "查看这台 Mac 上的会话") }
                catch { let failure = error as NSError; throw verificationFailure(domain: failure.domain, code: failure.code) }
            }
            let key = try find(tag: reference.verificationTag, context: context)
            guard LinkBytes.equal(try publicSpki(key), reference.verificationSpki) else { throw NativeFailure.identityMismatch }
            var failure: Unmanaged<CFError>?
            guard SecKeyIsAlgorithmSupported(key, .sign, .ecdsaSignatureMessageX962SHA256),
                  let result = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, statement as CFData, &failure) as Data? else {
                let error = failure?.takeRetainedValue()
                throw verificationFailure(domain: error.map { CFErrorGetDomain($0) as String } ?? "", code: error.map { CFErrorGetCode($0) } ?? 0)
            }
            return try P256.Signing.ECDSASignature(derRepresentation: result).rawRepresentation
        }.value
    }
    /** Backing out of the system sheet, or the system taking it away, is a choice the App respects quietly; anything else is said. */
    public static func verificationFailure(domain: String, code: Int) -> NativeFailure {
        let cancelled = domain == LAErrorDomain ? [LAError.userCancel.rawValue, LAError.systemCancel.rawValue, LAError.appCancel.rawValue, LAError.userFallback.rawValue].contains(code)
            : domain == (kCFErrorDomainOSStatus as String) && code == Int(errSecUserCanceled)
        return cancelled ? .declined : .notVerified
    }
    public static func remove(_ reference: DeviceKeyReference) {
        remove(tag: reference.connectionTag); remove(tag: reference.verificationTag)
    }
    public static func removeChecked(_ reference: DeviceKeyReference) throws {
        var failed = false
        for tag in [reference.connectionTag, reference.verificationTag] {
            let status = SecItemDelete([kSecClass: kSecClassKey, kSecAttrApplicationTag: tag, kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom] as CFDictionary)
            if status != errSecSuccess && status != errSecItemNotFound { failed = true }
        }
        if failed { throw NativeFailure.storageUnavailable }
    }
    private static func remove(tag: Data) {
        SecItemDelete([kSecClass: kSecClassKey, kSecAttrApplicationTag: tag, kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom] as CFDictionary)
    }
    public static func publicSpki(_ privateKey: SecKey) throws -> Data {
        guard let key = SecKeyCopyPublicKey(privateKey), let bytes = SecKeyCopyExternalRepresentation(key, nil) as Data?,
              bytes.count == 65, bytes.first == 4 else { throw NativeFailure.identityMismatch }
        return try P256.Signing.PublicKey(x963Representation: bytes).derRepresentation
    }
    public static func signDER(_ key: SecKey, _ statement: Data) throws -> Data {
        guard SecKeyIsAlgorithmSupported(key, .sign, .ecdsaSignatureMessageX962SHA256),
              let result = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, statement as CFData, nil) as Data? else { throw NativeFailure.unavailable }
        return result
    }
}

/** Security.framework retains the SecKey reference; this object contains no exportable private key representation. */
public final class PlatformIdentity: @unchecked Sendable {
    public let certificate: Data
    public let spki: Data
    let identity: SecIdentity
    public init(key: SecKey, certificate: Data) throws {
        guard let cert = SecCertificateCreateWithData(nil, certificate as CFData), let identity = SecIdentityCreate(nil, cert, key) else { throw NativeFailure.identityMismatch }
        self.certificate = certificate
        self.spki = try SecureDeviceKeys.publicSpki(key)
        self.identity = identity
    }
    public var pem: String {
        let text = certificate.base64EncodedString(), rows = stride(from: 0, to: text.count, by: 64).map { at -> String in
            let start = text.index(text.startIndex, offsetBy: at), end = text.index(start, offsetBy: min(64, text.count - at))
            return String(text[start..<end])
        }
        return "-----BEGIN CERTIFICATE-----\n" + rows.joined(separator: "\n") + "\n-----END CERTIFICATE-----\n"
    }
}

/** Fixed-profile X.509 DER encoding. Cryptography and certificate validation are always platform implementations. */
public enum P256Certificate {
    private static func der(_ tag: UInt8, _ value: Data) throws -> Data {
        guard value.count <= 65_535 else { throw NativeFailure.invalidRecord }
        let count = value.count
        let length: [UInt8] = count < 128 ? [UInt8(count)] : count < 256 ? [0x81, UInt8(count)] : [0x82, UInt8(count >> 8), UInt8(count & 255)]
        return Data([tag] + length) + value
    }
    private static func sequence(_ parts: Data...) throws -> Data { try der(0x30, parts.reduce(Data(), +)) }
    private static func oid(_ text: String) throws -> Data { try der(6, LinkBytes.unhex(text)) }
    private static func name(_ value: String) throws -> Data { try sequence(der(0x31, sequence(oid("550403"), der(12, Data(value.utf8))))) }
    private static func time(_ value: Date) throws -> Data {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyyMMddHHmmss'Z'"
        return try der(0x18, Data(formatter.string(from: value).utf8))
    }
    private static func positive(_ value: Data) throws -> Data {
        var bytes = Data(value.drop(while: { $0 == 0 }))
        if bytes.isEmpty { bytes = Data([0]) }
        if bytes.first! & 0x80 != 0 { bytes.insert(0, at: 0) }
        return try der(2, bytes)
    }
    private static func ext(_ id: String, value: Data, critical: Bool = false) throws -> Data {
        try sequence(oid(id), critical ? der(1, Data([255])) : Data(), der(4, value))
    }
    public static func create(spki: Data, now: Date, lifetime: TimeInterval = 3600, sign: (Data) throws -> Data) throws -> Data {
        guard (60...43_200).contains(lifetime), now.timeIntervalSince1970 > 0, spki.count == 91 else { throw NativeFailure.invalidRecord }
        _ = try P256.Signing.PublicKey(derRepresentation: spki)
        let algorithm = try sequence(oid("2a8648ce3d040302"))
        let extensions = try der(0xa3, sequence(
            ext("551d13", value: sequence(), critical: true),
            ext("551d0f", value: der(3, Data([7, 0x80])), critical: true),
            ext("551d11", value: sequence(der(0x82, Data("transport.latch.invalid".utf8)))),
            ext("551d25", value: sequence(oid("2b06010505070301"), oid("2b06010505070302")))
        ))
        let tbs = try sequence(der(0xa0, der(2, Data([2]))), positive(LinkBytes.random(16)), algorithm,
                               name("transport.latch.invalid"), sequence(time(now.addingTimeInterval(-60)), time(now.addingTimeInterval(lifetime))),
                               name("connection.latch.invalid"), spki, extensions)
        let signature = try sign(tbs)
        let value = try P256.Signing.ECDSASignature(derRepresentation: signature)
        guard NativeCrypto.verifyP256(spki: spki, input: tbs, signature: value.rawRepresentation) else { throw NativeFailure.identityMismatch }
        return try sequence(tbs, algorithm, der(3, Data([0]) + signature))
    }
}
