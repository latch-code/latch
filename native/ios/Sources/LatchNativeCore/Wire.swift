import CryptoKit
import Foundation
import Security

public enum NativeFailure: String, Error, LocalizedError, Sendable {
    case invalidRecord, identityMismatch, expired, unavailable, unsupported, resultUnknown, storageUnavailable, revoked, eventOverflow, forbidden, contextChanged, declined, notVerified, changedElsewhere, terminalOpen, notStoppable, busy, sessionLost
    public var errorDescription: String? {
        switch self {
        case .invalidRecord: "连接资料无法验证。"
        case .identityMismatch: "电脑身份验证失败，连接已关闭。"
        case .expired: "请解锁后继续。"
        case .unavailable: "暂时无法连接这台电脑。"
        case .unsupported: "当前设备或 Host 尚不支持这项功能。"
        case .resultUnknown: "结果尚未确认，请重试同一次提交。"
        case .storageUnavailable: "本设备的安全存储不可用。"
        case .revoked: "这台电脑已移除此设备，请重新连接。"
        case .eventOverflow: "会话正在重新同步，请稍候。"
        case .forbidden: "这台电脑尚未允许此操作，请在电脑上调整权限。"
        case .contextChanged: "会话的文件夹或权限已变化，请在电脑上重新确认。"
        case .declined: "你取消了这次确认。"
        case .notVerified: "没能确认是你本人，请再试一次。"
        case .changedElsewhere: "这项记录已在别处修改。"
        // The Host's own words for both.
        case .terminalOpen: "这个会话还有终端在运行，请先在 Mac 上关闭终端"
        case .busy: "请稍后再试。"
        case .notStoppable: "这个子 Agent 已经结束，或它的 Harness 不能单独停止它。"
        case .sessionLost: "这个 Harness 已找不到原来的会话，换个新会话继续"
        }
    }
}

public enum LinkBytes {
    public static let maximumInteger: UInt64 = 9_007_199_254_740_991
    public static func integer(_ value: UInt64, size: Int) throws -> Data {
        guard [1, 2, 4, 8].contains(size), value <= maximumInteger,
              size == 8 || value < (UInt64(1) << (size * 8)) else { throw NativeFailure.invalidRecord }
        return Data((0..<size).reversed().map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) })
    }
    public static func field(_ value: Data) throws -> Data {
        guard value.count <= 65_535 else { throw NativeFailure.invalidRecord }
        return try integer(UInt64(value.count), size: 2) + value
    }
    public static func fixed(_ value: Data, _ count: Int) throws -> Data {
        guard value.count == count else { throw NativeFailure.invalidRecord }
        return value
    }
    public static func ascii(_ value: String) throws -> Data {
        guard value.utf8.allSatisfy({ $0 < 128 }) else { throw NativeFailure.invalidRecord }
        return Data(value.utf8)
    }
    public static func equal(_ left: Data, _ right: Data) -> Bool {
        let a = [UInt8](left), b = [UInt8](right)
        var difference = a.count ^ b.count
        for i in 0..<max(a.count, b.count) { difference |= Int((i < a.count ? a[i] : 0) ^ (i < b.count ? b[i] : 0)) }
        return difference == 0
    }
    public static func matches(_ value: String, _ pattern: String) -> Bool {
        guard value.utf8.allSatisfy({ $0 < 128 }), let range = value.range(of: pattern, options: .regularExpression) else { return false }
        return range == value.startIndex..<value.endIndex
    }
    public static func base64url(_ value: Data) -> String {
        value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    public static func decode64(_ value: String, maximum: Int = 65_536) throws -> Data {
        guard (0...1_048_576).contains(maximum), value.count <= (maximum * 4 + 2) / 3, matches(value, "[A-Za-z0-9_-]*"), value.count % 4 != 1 else { throw NativeFailure.invalidRecord }
        let padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)
        guard let result = Data(base64Encoded: padded), result.count <= maximum, base64url(result) == value else { throw NativeFailure.invalidRecord }
        return result
    }
    public static func random(_ count: Int) throws -> Data {
        guard (1...65_536).contains(count) else { throw NativeFailure.invalidRecord }
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { throw NativeFailure.unavailable }
        return Data(bytes)
    }
    public static func hash(_ value: Data) -> Data { Data(SHA256.hash(data: value)) }
    public static func hex(_ value: Data) -> String { value.map { String(format: "%02x", $0) }.joined() }
    public static func unhex(_ value: String, maximum: Int = 65_536) throws -> Data {
        guard (0...1_048_576).contains(maximum), value.count <= maximum * 2, value.count % 2 == 0,
              matches(value, "[a-f0-9]*") else { throw NativeFailure.invalidRecord }
        let bytes = Array(value.utf8)
        func nibble(_ byte: UInt8) -> UInt8 { byte <= 57 ? byte - 48 : byte - 87 }
        return Data(stride(from: 0, to: bytes.count, by: 2).map { (nibble(bytes[$0]) << 4) | nibble(bytes[$0 + 1]) })
    }
    public static func hmac(_ key: Data, _ input: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: input, using: SymmetricKey(data: key)))
    }
    public static func derive(_ seed: Data, salt: Data, info: Data, count: Int = 32) throws -> Data {
        guard (1...8160).contains(count) else { throw NativeFailure.invalidRecord }
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: seed), salt: salt, info: info, outputByteCount: count).withUnsafeBytes { Data($0) }
    }
    public static func base32(_ value: Data) -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567")
        var buffer: UInt32 = 0, bits = 0, result = ""
        for byte in value {
            buffer = (buffer << 8) | UInt32(byte); bits += 8
            while bits >= 5 { bits -= 5; result.append(alphabet[Int((buffer >> bits) & 31)]) }
        }
        if bits > 0 { result.append(alphabet[Int((buffer << (5 - bits)) & 31)]) }
        return result
    }
}

public struct LinkReader {
    private let bytes: Data
    private var at = 0
    public init(_ bytes: Data, maximum: Int = 65_536) throws {
        guard bytes.count <= maximum else { throw NativeFailure.invalidRecord }
        self.bytes = bytes
    }
    public mutating func take(_ count: Int) throws -> Data {
        guard count >= 0, count <= bytes.count - at else { throw NativeFailure.invalidRecord }
        defer { at += count }
        return bytes.subdata(in: at..<(at + count))
    }
    public mutating func integer(_ size: Int) throws -> UInt64 {
        guard [1, 2, 4, 8].contains(size) else { throw NativeFailure.invalidRecord }
        let result = try take(size).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        guard result <= LinkBytes.maximumInteger else { throw NativeFailure.invalidRecord }
        return result
    }
    public mutating func field(_ maximum: Int) throws -> Data {
        let count = try Int(integer(2))
        guard count <= maximum else { throw NativeFailure.invalidRecord }
        return try take(count)
    }
    public func done() throws { guard at == bytes.count else { throw NativeFailure.invalidRecord } }
}

public enum NativeRelayProfile: String, Codable, Sendable { case outerPadV2 = "outer-pad-v2" }

public enum LinkBinding: Sendable {
    case direct
    case relay(id: Data, route: Data)
    case relayPaddedV2(id: Data, route: Data)
    public func encoded() throws -> Data {
        switch self {
        case .direct: return try LinkBytes.field(Data("direct".utf8)) + LinkBytes.field(Data())
        case let .relay(id, route): return try LinkBytes.field(Data("relay".utf8)) + LinkBytes.field(LinkBytes.fixed(id, 16) + LinkBytes.fixed(route, 16))
        case let .relayPaddedV2(id, route): return try LinkBytes.field(Data("relay-pad-v2".utf8)) + LinkBytes.field(LinkBytes.fixed(id, 16) + LinkBytes.fixed(route, 16))
        }
    }
}

public enum NativeCrypto {
    public static func knock(key: Data, binding: LinkBinding, timeMs: UInt64, nonce: Data) throws -> Data {
        let input = try Data("latch-knock-v1\0".utf8) + binding.encoded() + LinkBytes.integer(timeMs / 60_000, size: 4) + LinkBytes.fixed(nonce, 16)
        return try LinkBytes.fixed(nonce, 16) + LinkBytes.hmac(LinkBytes.fixed(key, 32), input).prefix(16)
    }
    public static func serverBinding(key: Data, binding: LinkBinding, nonce: Data, certificate: Data) throws -> Data {
        let input = try Data("latch-server-bind-v1\0".utf8) + binding.encoded() + LinkBytes.fixed(nonce, 16) + LinkBytes.hash(certificate)
        return try LinkBytes.hmac(LinkBytes.fixed(key, 32), input)
    }
    public static func knockSecret(invitationHash: Data, connectionSpki: Data, verificationSpki: Data) throws -> Data {
        guard connectionSpki.count <= 256, verificationSpki.count <= 256 else { throw NativeFailure.invalidRecord }
        return try LinkBytes.derive(LinkBytes.fixed(invitationHash, 32), salt: LinkBytes.hash(connectionSpki), info: Data("latch-native-knock-key-v1\0".utf8) + LinkBytes.field(verificationSpki))
    }
    public static func verificationText(hostId: String, deviceId: String, nonce: String, expiresAt: UInt64, appOpenId: String) throws -> String {
        guard LinkBytes.matches(hostId, "[a-z2-7]{52}"), LinkBytes.matches(deviceId, "dev_[A-Za-z0-9_-]{22}"),
              LinkBytes.matches(nonce, "[A-Za-z0-9_-]{16,80}"), LinkBytes.matches(appOpenId, "[A-Za-z0-9_-]{16,80}"),
              expiresAt <= LinkBytes.maximumInteger else { throw NativeFailure.invalidRecord }
        return "latch-native-verify-v1\n\(hostId)\n\(deviceId)\n\(nonce)\n\(expiresAt)\n\(appOpenId)"
    }
    public static func recoverySecret(statement: String, signature: Data) throws -> Data {
        guard statement.utf8.count <= 512, statement.hasPrefix("latch-native-verify-v1\n") else { throw NativeFailure.invalidRecord }
        return try LinkBytes.hash(Data("latch-native-recovery-v1\0".utf8) + LinkBytes.field(LinkBytes.ascii(statement)) + LinkBytes.fixed(signature, 64))
    }
    public static func verifyP256(spki: Data, input: Data, signature: Data) -> Bool {
        guard spki.count <= 256, signature.count == 64,
              let key = try? P256.Signing.PublicKey(derRepresentation: spki),
              let value = try? P256.Signing.ECDSASignature(rawRepresentation: signature) else { return false }
        return key.isValidSignature(value, for: input)
    }
    public static func hostProofInput(transportSpki: Data, nonce: Data, before: UInt64, after: UInt64) throws -> Data {
        try Data("latch-host-proof-v1\0".utf8) + LinkBytes.field(transportSpki) + LinkBytes.fixed(nonce, 16) + LinkBytes.integer(before, size: 8) + LinkBytes.integer(after, size: 8)
    }
    public static func verifyHostProof(_ proof: Data, rootSpki: Data, transportSpki: Data, nonce: Data, timeMs: UInt64) throws {
        var reader = try LinkReader(proof, maximum: 8192)
        let root = try reader.field(256), before = try reader.integer(8), after = try reader.integer(8), signature = try reader.take(64)
        try reader.done()
        guard LinkBytes.equal(root, rootSpki), after >= before, after - before <= 360_000, timeMs >= before, timeMs <= after,
              verifyP256(spki: rootSpki, input: try hostProofInput(transportSpki: transportSpki, nonce: nonce, before: before, after: after), signature: signature) else { throw NativeFailure.identityMismatch }
    }
}
