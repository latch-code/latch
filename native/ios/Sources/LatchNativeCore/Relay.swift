import CryptoKit
import Foundation
import Network
import Security

/** The relay uses the repository's binary, unfragmented WebSocket profile, below the inner platform TLS stack. */
public enum RelayWire {
    public struct Frame: Sendable { public let opcode: UInt8; public let payload: Data }
    public static func frame(opcode: UInt8, payload: Data, mask: Data) throws -> Data {
        guard [2, 8, 9, 10].contains(opcode), payload.count <= 65_536, opcode == 2 || payload.count <= 125,
              mask.count == 4 else { throw NativeFailure.invalidRecord }
        var header = Data([0x80 | opcode])
        if payload.count < 126 { header.append(0x80 | UInt8(payload.count)) }
        else if payload.count < 65_536 { header.append(0xfe); header.append(try LinkBytes.integer(UInt64(payload.count), size: 2)) }
        else { header.append(0xff); header.append(try LinkBytes.integer(UInt64(payload.count), size: 8)) }
        header.append(mask)
        for (index, byte) in payload.enumerated() { header.append(byte ^ mask[index % 4]) }
        return header
    }
    public struct Decoder: Sendable {
        private var pending = Data()
        public init() {}
        public mutating func feed(_ data: Data) throws -> [Frame] {
            guard data.count <= 65_550, pending.count + data.count <= 131_100 else { throw NativeFailure.invalidRecord }
            pending.append(data)
            var frames: [Frame] = []
            while pending.count >= 2 {
                let bytes = [UInt8](pending), head = bytes[0], second = bytes[1], opcode = head & 0x0f
                guard head & 0xf0 == 0x80, [2, 8, 9, 10].contains(opcode), second & 0x80 == 0 else { throw NativeFailure.invalidRecord }
                let code = second & 0x7f, extra = code == 127 ? 8 : code == 126 ? 2 : 0
                guard bytes.count >= 2 + extra else { break }
                var length = UInt64(code)
                if extra > 0 {
                    var reader = try LinkReader(Data(bytes[2..<(2 + extra)])); length = try reader.integer(extra)
                }
                guard length <= 65_536, code != 126 || length >= 126, code != 127 || length >= 65_536,
                      opcode == 2 || length <= 125 else { throw NativeFailure.invalidRecord }
                let end = 2 + extra + Int(length)
                guard bytes.count >= end else { break }
                guard opcode != 8 || length != 1, frames.count < 256 else { throw NativeFailure.invalidRecord }
                frames.append(Frame(opcode: opcode, payload: Data(bytes[(2 + extra)..<end])))
                pending = Data(bytes.dropFirst(end))
            }
            guard pending.count <= 65_550 else { throw NativeFailure.invalidRecord }
            return frames
        }
    }
}

/** Extract the exact DER SubjectPublicKeyInfo after Security.framework has parsed and validated the certificate. */
private func certificateSPKI(_ der: Data) throws -> Data {
    let bytes = [UInt8](der)
    guard bytes.count <= 65_536 else { throw NativeFailure.invalidRecord }
    func element(_ start: Int, limit: Int) throws -> (tag: UInt8, body: Range<Int>, end: Int) {
        guard start >= 0, start + 2 <= limit, limit <= bytes.count else { throw NativeFailure.invalidRecord }
        var at = start + 2, count = Int(bytes[start + 1])
        if count & 0x80 != 0 {
            let width = count & 0x7f
            guard (1...3).contains(width), at + width <= limit, bytes[at] != 0 else { throw NativeFailure.invalidRecord }
            count = 0
            for byte in bytes[at..<(at + width)] { count = count * 256 + Int(byte) }
            guard count >= 128 else { throw NativeFailure.invalidRecord }; at += width
        }
        guard count <= limit - at else { throw NativeFailure.invalidRecord }
        return (bytes[start], at..<(at + count), at + count)
    }
    let certificate = try element(0, limit: bytes.count)
    guard certificate.tag == 0x30, certificate.end == bytes.count else { throw NativeFailure.invalidRecord }
    let tbs = try element(certificate.body.lowerBound, limit: certificate.body.upperBound)
    guard tbs.tag == 0x30 else { throw NativeFailure.invalidRecord }
    var at = tbs.body.lowerBound
    if bytes[at] == 0xa0 { at = try element(at, limit: tbs.body.upperBound).end }
    for _ in 0..<5 { at = try element(at, limit: tbs.body.upperBound).end }
    let spki = try element(at, limit: tbs.body.upperBound)
    guard spki.tag == 0x30, spki.end - at <= 8192 else { throw NativeFailure.invalidRecord }
    return Data(bytes[at..<spki.end])
}

private final class RelaySetup: @unchecked Sendable {
    let endpoint: NativeRelayAddress
    let admission: NativeRelayPass
    let key: String
    init(endpoint: NativeRelayAddress, admission: NativeRelayPass) throws {
        self.endpoint = endpoint; self.admission = admission
        key = try LinkBytes.random(16).base64EncodedString()
    }
}

private final class RelayFramer: NWProtocolFramerImplementation {
    static let label = "Latch blind relay"
    static let definition = NWProtocolFramer.Definition(implementation: RelayFramer.self)
    private enum Phase { case upgrade, challenge, admitted, spliced, ready }
    private let setup: RelaySetup?
    private var phase = Phase.upgrade
    private var header = Data()
    private var decoder = RelayWire.Decoder()
    private var lastSeen = ContinuousClock.now
    private var drainScheduled = false
    required init(framer: NWProtocolFramer.Instance) { setup = framer.options["latch.relay"] as? RelaySetup }
    func start(framer: NWProtocolFramer.Instance) -> NWProtocolFramer.StartResult {
        guard let setup, let host = setup.endpoint.url.host else { framer.markFailed(error: .posix(.EAUTH)); return .willMarkReady }
        let authority = host + (setup.endpoint.url.port.map { ":\($0)" } ?? "")
        let request = "GET /v1/c HTTP/1.1\r\nHost: \(authority)\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: \(setup.key)\r\nSec-WebSocket-Protocol: latch-relay.1\r\n\r\n"
        framer.writeOutput(data: Data(request.utf8))
        framer.scheduleWakeup(wakeupTime: .milliseconds(8000))
        return .willMarkReady
    }
    private func send(_ payload: Data, opcode: UInt8 = 2, framer: NWProtocolFramer.Instance) throws {
        framer.writeOutput(data: try RelayWire.frame(opcode: opcode, payload: payload, mask: LinkBytes.random(4)))
    }
    func handleInput(framer: NWProtocolFramer.Instance) -> Int {
        // Input notifications are edge triggered. A partial WebSocket frame may have more TLS records already buffered.
        for _ in 0..<64 {
            var failed = false, consumed = 0
            let available = framer.parseInput(minimumIncompleteLength: 1, maximumLength: 65_550) { bytes, complete in
                guard let bytes, !bytes.isEmpty else {
                    if complete { failed = true; framer.markFailed(error: .posix(.ECONNRESET)) }
                    return 0
                }
                do { try input(Data(bytes), framer: framer); consumed = bytes.count }
                catch { failed = true; framer.markFailed(error: .posix(.EAUTH)) }
                return bytes.count
            }
            if failed { return 0 }
            if !available || consumed == 0 { return 1 }
        }
        if !drainScheduled {
            drainScheduled = true
            framer.async { [self] in drainScheduled = false; _ = handleInput(framer: framer) }
        }
        return 1
    }
    private func input(_ data: Data, framer: NWProtocolFramer.Instance) throws {
        guard let setup else { throw NativeFailure.invalidRecord }
        var remaining = data
        if phase == .upgrade {
            header.append(data)
            if let end = header.range(of: Data("\r\n\r\n".utf8)) {
                guard end.upperBound <= 16_384, let text = String(data: header[..<end.lowerBound], encoding: .ascii) else { throw NativeFailure.invalidRecord }
                let lines = text.components(separatedBy: "\r\n")
                guard let first = lines.first, first.hasPrefix("HTTP/1.1 101 "), lines.count <= 65 else { throw NativeFailure.invalidRecord }
                var fields: [String: String] = [:]
                for line in lines.dropFirst() {
                    guard let colon = line.firstIndex(of: ":"), line.utf8.allSatisfy({ $0 >= 32 && $0 < 127 }) else { throw NativeFailure.invalidRecord }
                    let name = line[..<colon].lowercased(), value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                    guard LinkBytes.matches(name, "[a-z0-9-]+"), fields[name] == nil else { throw NativeFailure.invalidRecord }
                    fields[name] = value
                }
                let expected = Data(Insecure.SHA1.hash(data: Data((setup.key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
                guard fields["sec-websocket-accept"] == expected, fields["sec-websocket-protocol"] == "latch-relay.1",
                    fields["upgrade"]?.lowercased() == "websocket", fields["sec-websocket-extensions"] == nil,
                    fields["connection"]?.lowercased().split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) }).contains("upgrade") == true else { throw NativeFailure.identityMismatch }
                remaining = Data(header[end.upperBound...]); header.removeAll(keepingCapacity: false)
                phase = .challenge
                try send(Data([0x20, 1]), framer: framer)
            } else {
                guard header.count <= 16_384 else { throw NativeFailure.invalidRecord }; return
            }
        }
        for frame in try decoder.feed(remaining) {
            lastSeen = .now
            if frame.opcode == 9 { try send(frame.payload, opcode: 10, framer: framer); continue }
            if frame.opcode == 10 { continue }
            guard frame.opcode == 2 else { throw NativeFailure.unavailable }
            switch phase {
            case .challenge:
                var reader = try LinkReader(frame.payload)
                guard try reader.integer(1) == 0x40, LinkBytes.equal(try reader.take(16), setup.endpoint.relayId) else { throw NativeFailure.identityMismatch }
                _ = try reader.take(32)
                let relayTime = try reader.integer(8), needsToken = try reader.integer(1)
                try reader.done()
                let now = Date().timeIntervalSince1970 * 1000, pass = try AdmissionPass.decode(setup.admission.bytes)
                guard needsToken <= 1, abs(Double(relayTime) - now) <= 86_400_000,
                      now / 1000 >= Double(pass.notBefore), now / 1000 <= Double(pass.notAfter) else { throw NativeFailure.expired }
                try send(Data([0x10]) + setup.admission.admission(timeMs: relayTime, nonce: LinkBytes.random(16)), framer: framer)
                phase = .admitted
            case .admitted:
                guard frame.payload == Data([0x60]) else { throw NativeFailure.unavailable }; phase = .spliced
            case .spliced:
                let pass = try AdmissionPass.decode(setup.admission.bytes)
                guard frame.payload.count == 25, frame.payload.first == 0x51,
                      LinkBytes.equal(Data(frame.payload.suffix(16)), pass.tag) else { throw NativeFailure.identityMismatch }
                phase = .ready; framer.markReady(); framer.scheduleWakeup(wakeupTime: .milliseconds(20_000))
            case .ready:
                guard frame.payload.first == 0, frame.payload.count <= 16_385 else { throw NativeFailure.invalidRecord }
                if frame.payload.count > 1 { framer.deliverInput(data: Data(frame.payload.dropFirst()), message: .init(instance: framer), isComplete: false) }
            case .upgrade: throw NativeFailure.invalidRecord
            }
        }
    }
    func handleOutput(framer: NWProtocolFramer.Instance, message: NWProtocolFramer.Message, messageLength: Int, isComplete: Bool) {
        guard phase == .ready else { framer.markFailed(error: .posix(.EAUTH)); return }
        var left = messageLength
        while left > 0 {
            var count = 0
            _ = framer.parseOutput(minimumIncompleteLength: 1, maximumLength: min(left, 16_384)) { bytes, _ in
                guard let bytes, !bytes.isEmpty else { return 0 }
                do { try send(Data([0]) + Data(bytes), framer: framer); count = bytes.count }
                catch { framer.markFailed(error: .posix(.EAUTH)) }
                return count
            }
            guard count > 0 else { framer.markFailed(error: .posix(.ECONNRESET)); return }
            left -= count
        }
    }
    func wakeup(framer: NWProtocolFramer.Instance) {
        guard phase == .ready, ContinuousClock.now - lastSeen < .seconds(60) else { framer.markFailed(error: .posix(.ETIMEDOUT)); return }
        do { try send(Data(), opcode: 9, framer: framer); framer.scheduleWakeup(wakeupTime: .milliseconds(20_000)) }
        catch { framer.markFailed(error: .posix(.EAUTH)) }
    }
    func stop(framer: NWProtocolFramer.Instance) -> Bool { true }
    func cleanup(framer: NWProtocolFramer.Instance) {}
}

extension NativeHTTPConnection {
    public static func relay(endpoint: NativeRelayAddress, admission: NativeRelayPass, rootSpki: Data, knockKey: Data,
        identity: PlatformIdentity? = nil, trustAnchor: Data? = nil) async throws -> NativeHTTPConnection {
        _ = try AddressBookCodec.relayURL(endpoint.url.absoluteString)
        guard let hostname = endpoint.url.host, endpoint.spkiHash.count == 32, endpoint.relayId.count == 16,
              LinkBytes.equal(try AdmissionPass.decode(admission.bytes).relayId, endpoint.relayId) else { throw NativeFailure.invalidRecord }
        let host = hostname.trimmingCharacters(in: CharacterSet(charactersIn: "[]")), outer = NWProtocolTLS.Options()
        let security = outer.securityProtocolOptions
        sec_protocol_options_set_min_tls_protocol_version(security, .TLSv13)
        sec_protocol_options_set_max_tls_protocol_version(security, .TLSv13)
        sec_protocol_options_set_tls_server_name(security, host)
        sec_protocol_options_add_tls_application_protocol(security, "http/1.1")
        sec_protocol_options_set_tls_tickets_enabled(security, false)
        sec_protocol_options_set_tls_resumption_enabled(security, false)
        sec_protocol_options_set_tls_false_start_enabled(security, false)
        sec_protocol_options_set_verify_block(security, { metadata, trust, complete in
            let actual = sec_trust_copy_ref(trust).takeRetainedValue()
            guard SecTrustSetPolicies(actual, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
                  SecTrustSetNetworkFetchAllowed(actual, false) == errSecSuccess else { complete(false); return }
            if let trustAnchor {
                guard let certificate = SecCertificateCreateWithData(nil, trustAnchor as CFData),
                      SecTrustSetAnchorCertificates(actual, [certificate] as CFArray) == errSecSuccess,
                      SecTrustSetAnchorCertificatesOnly(actual, true) == errSecSuccess else { complete(false); return }
            }
            guard SecTrustEvaluateWithError(actual, nil), let chain = SecTrustCopyCertificateChain(actual) as? [SecCertificate],
                  let leaf = chain.first, let spki = try? certificateSPKI(SecCertificateCopyData(leaf) as Data),
                  LinkBytes.equal(LinkBytes.hash(spki), endpoint.spkiHash),
                  sec_protocol_metadata_get_negotiated_tls_protocol_version(metadata) == .TLSv13,
                  let selected = sec_protocol_metadata_get_negotiated_protocol(metadata), String(cString: selected) == "http/1.1" else { complete(false); return }
            complete(true)
        }, DispatchQueue(label: "app.latch.relay.tls-verify"))
        let state = try HandshakeState(root: rootSpki, knockKey: knockKey,
            binding: .relay(id: endpoint.relayId, route: admission.routeId()))
        let inner = try NativeTLS.options(state: state, identity: identity)
        let knock = NWProtocolFramer.Options(definition: KnockFramer.definition); knock["latch.state"] = state
        let relay = NWProtocolFramer.Options(definition: RelayFramer.definition); relay["latch.relay"] = try RelaySetup(endpoint: endpoint, admission: admission)
        let tcp = NWProtocolTCP.Options(); tcp.noDelay = true; tcp.connectionTimeout = 5
        let parameters = NWParameters(tls: outer, tcp: tcp)
        parameters.defaultProtocolStack.applicationProtocols.insert(contentsOf: [inner, knock, relay], at: 0)
        parameters.includePeerToPeer = false
        let connection = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: UInt16(endpoint.url.port ?? 443))!, using: parameters)
        return try await establish(connection, state: state)
    }
}
