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
    /** The origin this connection dials: the node's URL or, on an edge node, one of its further origins. */
    let origin: URL
    let key: String
    let outerSlot: RelayOuterSlot?
    /** Edge kind: this connection's nonce, signed back by the node with its relay key. */
    let clientNonce: Data
    /** Edge kind: the origins of one node race only up to the signature check; one winner then sends the proof. */
    let race: NativeEdgeRace?
    init(endpoint: NativeRelayAddress, admission: NativeRelayPass, origin: URL, race: NativeEdgeRace?) throws {
        self.endpoint = endpoint; self.admission = admission; self.origin = origin; self.race = race
        outerSlot = try endpoint.profile == .outerPadV2 ? RelayOuterSlot() : nil
        key = try LinkBytes.random(16).base64EncodedString()
        clientNonce = try LinkBytes.random(32)
    }
    var path: String { endpoint.edge.map { "/v1/c/\($0.shard)" } ?? "/v1/c" }
}

/** The edge kind's challenge text (link-wire relay-identity.ts `edgeChallengeInput`), for the client role. */
public enum NativeEdgeChallenge {
    public static func input(relayId: Data, clientNonce: Data, relayNonce: Data, timeMs: UInt64, requiresToken: Bool) throws -> Data {
        try Data("latch-relay-edge-challenge-v1\0".utf8) + LinkBytes.fixed(relayId, 16) + Data([3]) + LinkBytes.fixed(clientNonce, 32)
            + LinkBytes.fixed(relayNonce, 32) + LinkBytes.integer(timeMs, size: 8) + Data([requiresToken ? 1 : 0])
    }
    public static func verify(relayKey: Data, relayId: Data, clientNonce: Data, relayNonce: Data, timeMs: UInt64, requiresToken: Bool, signature: Data) -> Bool {
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: relayKey), signature.count == 64,
              let text = try? input(relayId: relayId, clientNonce: clientNonce, relayNonce: relayNonce, timeMs: timeMs, requiresToken: requiresToken) else { return false }
        return key.isValidSignature(signature, for: text)
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
    private var drainScheduled = false
    private var outer: NativeRelayOuterPadding?
    private var outerStart: ContinuousClock.Instant?
    private let started = ContinuousClock.now
    private var stopped = false
    /** Edge kind: when this origin's claim on the node lapses unless the connection is ready by then. */
    private var claimDeadline: ContinuousClock.Instant?
    required init(framer: NWProtocolFramer.Instance) { setup = framer.options["latch.relay"] as? RelaySetup }
    func start(framer: NWProtocolFramer.Instance) -> NWProtocolFramer.StartResult {
        guard let setup, let host = setup.origin.host else { framer.markFailed(error: .posix(.EAUTH)); return .willMarkReady }
        let authority = host + (setup.origin.port.map { ":\($0)" } ?? "")
        let protocolName = setup.endpoint.profile == .outerPadV2 ? "latch-relay.2" : "latch-relay.1"
        let request = "GET \(setup.path) HTTP/1.1\r\nHost: \(authority)\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: \(setup.key)\r\nSec-WebSocket-Protocol: \(protocolName)\r\n\r\n"
        do { try write(Data(request.utf8), framer: framer) }
        catch { framer.markFailed(error: .posix(.ECANCELED)); return .willMarkReady }
        framer.scheduleWakeup(wakeupTime: .milliseconds(8000))
        return .willMarkReady
    }
    private func write(_ bytes: Data, framer: NWProtocolFramer.Instance) throws {
        if let race = setup?.race {
            guard race.whileActive({ framer.writeOutput(data: bytes) }) else { throw CancellationError() }
        } else { framer.writeOutput(data: bytes) }
    }
    private func send(_ payload: Data, opcode: UInt8 = 2, framer: NWProtocolFramer.Instance) throws {
        guard !stopped else { throw NativeFailure.unavailable }
        let frame = try RelayWire.frame(opcode: opcode, payload: payload, mask: LinkBytes.random(4))
        if outer != nil {
            try outer!.enqueue(frame)
            if elapsedMs > NativeRelayOuterPadding.durationMs {
                while let batch = try outer!.batch(elapsedMs: elapsedMs) { try write(batch, framer: framer) }
                outer = nil
            }
        } else { try write(frame, framer: framer) }
    }
    private var elapsedMs: UInt64 {
        guard let outerStart else { return 0 }
        let duration = outerStart.duration(to: .now).components
        return UInt64(max(0, duration.seconds * 1000 + duration.attoseconds / 1_000_000_000_000_000))
    }
    private func schedule(framer: NWProtocolFramer.Instance) {
        guard !stopped else { return }
        if outer != nil, elapsedMs < NativeRelayOuterPadding.durationMs {
            framer.scheduleWakeup(wakeupTime: .milliseconds(NativeRelayOuterPadding.tickMs - elapsedMs % NativeRelayOuterPadding.tickMs))
        } else if phase == .ready { framer.scheduleWakeup(wakeupTime: .forever) }
        else {
            let spent = started.duration(to: .now).components
            let milliseconds = spent.seconds * 1000 + spent.attoseconds / 1_000_000_000_000_000
            var wait = max(1, 8000 - milliseconds)
            if let claimDeadline {
                let left = ContinuousClock.now.duration(to: claimDeadline).components
                wait = min(wait, max(1, left.seconds * 1000 + left.attoseconds / 1_000_000_000_000_000))
            }
            framer.scheduleWakeup(wakeupTime: .milliseconds(UInt64(wait)))
        }
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
                let protocolName = setup.endpoint.profile == .outerPadV2 ? "latch-relay.2" : "latch-relay.1"
                guard fields["sec-websocket-accept"] == expected, fields["sec-websocket-protocol"] == protocolName,
                    fields["upgrade"]?.lowercased() == "websocket", fields["sec-websocket-extensions"] == nil,
                    fields["connection"]?.lowercased().split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) }).contains("upgrade") == true else { throw NativeFailure.identityMismatch }
                remaining = Data(header[end.upperBound...]); header.removeAll(keepingCapacity: false)
                phase = .challenge
                if setup.endpoint.profile == .outerPadV2 { outer = NativeRelayOuterPadding(); outerStart = .now; schedule(framer: framer) }
                // Edge: EDGE-HELLO with this connection's nonce; self-hosted: the frozen HELLO.
                try send(setup.endpoint.edge == nil ? Data([0x20, 1]) : Data([0x27]) + setup.clientNonce, framer: framer)
            } else {
                guard header.count <= 16_384 else { throw NativeFailure.invalidRecord }; return
            }
        }
        for frame in try decoder.feed(remaining) {
            if frame.opcode == 9 { try send(frame.payload, opcode: 10, framer: framer); continue }
            if frame.opcode == 10 { continue }
            guard frame.opcode == 2 else { throw NativeFailure.unavailable }
            if frame.payload.first == 1 {
                guard setup.endpoint.profile == .outerPadV2, frame.payload.count <= 16_385 else { throw NativeFailure.invalidRecord }
                continue
            }
            switch phase {
            case .challenge:
                var reader = try LinkReader(frame.payload)
                let edge = setup.endpoint.edge
                guard try reader.integer(1) == (edge == nil ? 0x40 : 0x46), LinkBytes.equal(try reader.take(16), setup.endpoint.relayId) else { throw NativeFailure.identityMismatch }
                let relayNonce = try reader.take(32)
                let relayTime = try reader.integer(8), needsToken = try reader.integer(1)
                let signature = try edge == nil ? Data() : reader.take(64)
                try reader.done()
                // Edge: nothing that depends on the node is sent before its relay-key signature over our nonce verifies.
                if let edge {
                    guard needsToken == 0, NativeEdgeChallenge.verify(relayKey: edge.relayKey, relayId: setup.endpoint.relayId, clientNonce: setup.clientNonce,
                        relayNonce: relayNonce, timeMs: relayTime, requiresToken: false, signature: signature) else { throw NativeFailure.identityMismatch }
                }
                let now = Date().timeIntervalSince1970 * 1000, pass = try AdmissionPass.decode(setup.admission.bytes)
                guard needsToken <= 1, abs(Double(relayTime) - now) <= 86_400_000,
                      now / 1000 >= Double(pass.notBefore), now / 1000 <= Double(pass.notAfter) else { throw NativeFailure.expired }
                if edge != nil {
                    // Check again after signing. The batch write also checks cancellation before sending anything.
                    let admit = try Data([0x11]) + setup.admission.boundAdmission(timeMs: relayTime, nonce: LinkBytes.random(16), relayNonce: relayNonce)
                    if let race = setup.race {
                        guard race.claim(origin: setup.origin) else { throw NativeFailure.unavailable }
                        // The claimant has its own short deadline: a stalled origin must not hold the node's other origins.
                        claimDeadline = ContinuousClock.now + NativeEdgeRace.claimTimeout
                        schedule(framer: framer)
                    }
                    try send(admit, framer: framer)
                } else {
                    try send(Data([0x10]) + setup.admission.admission(timeMs: relayTime, nonce: LinkBytes.random(16)), framer: framer)
                }
                phase = .admitted
            case .admitted:
                guard frame.payload == Data([0x60]) else { throw NativeFailure.unavailable }; phase = .spliced
            case .spliced:
                let pass = try AdmissionPass.decode(setup.admission.bytes)
                guard frame.payload.count == 25, frame.payload.first == 0x51,
                      LinkBytes.equal(Data(frame.payload.suffix(16)), pass.tag) else { throw NativeFailure.identityMismatch }
                phase = .ready; framer.markReady(); schedule(framer: framer)
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
        guard !stopped else { return }
        if let claimDeadline, phase != .ready, ContinuousClock.now >= claimDeadline { framer.markFailed(error: .posix(.ETIMEDOUT)); return }
        do {
            if outer != nil {
                if let batch = try outer!.batch(elapsedMs: elapsedMs) { try write(batch, framer: framer) }
                if elapsedMs >= NativeRelayOuterPadding.durationMs {
                    while let batch = try outer!.batch(elapsedMs: NativeRelayOuterPadding.durationMs + 1) { try write(batch, framer: framer) }
                    outer = nil
                }
                schedule(framer: framer); return
            }
            guard phase == .ready else { framer.markFailed(error: .posix(.ETIMEDOUT)); return }
            framer.scheduleWakeup(wakeupTime: .forever)
        }
        catch { framer.markFailed(error: .posix(.EAUTH)) }
    }
    func stop(framer: NWProtocolFramer.Instance) -> Bool { stopped = true; outer?.clear(); outer = nil; return true }
    func cleanup(framer: NWProtocolFramer.Instance) {
        stopped = true; outer?.clear(); outer = nil; setup?.outerSlot?.release()
        // The connection is gone: an unfinished race may let another origin of the node try.
        if claimDeadline != nil, let setup { setup.race?.release(origin: setup.origin) }
    }
}

extension NativeHTTPConnection {
    public static func relay(target: NativeDirectoryTarget, admission: NativeRelayPass, rootSpki: Data, knockKey: Data,
        identity: PlatformIdentity? = nil, trustAnchor: Data? = nil) async throws -> NativeHTTPConnection {
        let address = try NativeDirectoryFetch.checkedAddress(target.address)
        guard target.endpoint.edge == nil else { throw NativeFailure.invalidRecord }
        return try await relay(endpoint: target.endpoint, origin: target.endpoint.url, admission: admission, rootSpki: rootSpki, knockKey: knockKey,
            identity: identity, trustAnchor: trustAnchor, dialAddress: address)
    }
    /**
     * Self-hosted: the one pinned URL. Edge: every origin of the node races, staggered by 250 ms, the last good one first;
     * the first whose relay-key signature verifies wins and the others are closed. The hostname never decides the node.
     */
    public static func relay(endpoint: NativeRelayAddress, admission: NativeRelayPass, rootSpki: Data, knockKey: Data,
        identity: PlatformIdentity? = nil, trustAnchor: Data? = nil) async throws -> NativeHTTPConnection {
        try Task.checkCancellation()
        guard endpoint.edge != nil else {
            return try await relay(endpoint: endpoint, origin: endpoint.url, admission: admission, rootSpki: rootSpki, knockKey: knockKey, identity: identity, trustAnchor: trustAnchor, dialAddress: nil)
        }
        guard NativeRelayOrder.edgeAvailable else { throw NativeFailure.unavailable }
        let origins = NativeEdgeOrigins.ordered(endpoint)
        guard let (winner, origin) = await NativeEdgeOrigins.race(origins, attempt: { origin, race in
            try await relay(endpoint: endpoint, origin: origin, admission: admission, rootSpki: rootSpki, knockKey: knockKey,
                identity: identity, trustAnchor: trustAnchor, dialAddress: nil, race: race)
        }, close: { await $0.close() }) else {
            try Task.checkCancellation()
            throw NativeFailure.unavailable
        }
        guard !Task.isCancelled else { await winner.close(); throw CancellationError() }
        NativeEdgeOrigins.remember(endpoint, origin: origin)
        return winner
    }
    private static func relay(endpoint: NativeRelayAddress, origin: URL, admission: NativeRelayPass, rootSpki: Data, knockKey: Data,
        identity: PlatformIdentity?, trustAnchor: Data?, dialAddress: String?, race: NativeEdgeRace? = nil) async throws -> NativeHTTPConnection {
        try Task.checkCancellation()
        _ = try AddressBookCodec.relayURL(origin.absoluteString)
        guard let hostname = origin.host, endpoint.spkiHash.count == 32, endpoint.relayId.count == 16,
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
            // Edge: ordinary WebPKI; the node's identity is checked by its relay-key signature after the upgrade.
            guard SecTrustEvaluateWithError(actual, nil), let chain = SecTrustCopyCertificateChain(actual) as? [SecCertificate],
                  let leaf = chain.first,
                  endpoint.edge != nil || (try? certificateSPKI(SecCertificateCopyData(leaf) as Data)).map({ LinkBytes.equal(LinkBytes.hash($0), endpoint.spkiHash) }) == true,
                  sec_protocol_metadata_get_negotiated_tls_protocol_version(metadata) == .TLSv13,
                  let selected = sec_protocol_metadata_get_negotiated_protocol(metadata), String(cString: selected) == "http/1.1" else { complete(false); return }
            complete(true)
        }, DispatchQueue(label: "app.latch.relay.tls-verify"))
        let binding: LinkBinding = try endpoint.profile == .outerPadV2 ? .relayPaddedV2(id: endpoint.relayId, route: admission.routeId()) : .relay(id: endpoint.relayId, route: admission.routeId())
        let state = try HandshakeState(root: rootSpki, knockKey: knockKey, binding: binding)
        let inner = try NativeTLS.options(state: state, identity: identity)
        let knock = NWProtocolFramer.Options(definition: KnockFramer.definition); knock["latch.state"] = state
        let relay = NWProtocolFramer.Options(definition: RelayFramer.definition); relay["latch.relay"] = try RelaySetup(endpoint: endpoint, admission: admission, origin: origin, race: race)
        let tcp = NWProtocolTCP.Options(); tcp.noDelay = true; tcp.connectionTimeout = 5
        tcp.enableKeepalive = true; tcp.keepaliveIdle = 60; tcp.keepaliveInterval = 15; tcp.keepaliveCount = 4
        let parameters = NWParameters(tls: outer, tcp: tcp)
        parameters.defaultProtocolStack.applicationProtocols.insert(contentsOf: [inner, knock, relay], at: 0)
        parameters.includePeerToPeer = false
        let connection = NWConnection(host: NWEndpoint.Host(dialAddress ?? host), port: NWEndpoint.Port(rawValue: UInt16(origin.port ?? 443))!, using: parameters)
        return try await establish(connection, state: state)
    }
}

/** The origin of each edge node that last passed the identity check, tried first next time (in memory, at most 64). */
public enum NativeEdgeOrigins {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var lastGood: [Data: URL] = [:]
    public static func ordered(_ endpoint: NativeRelayAddress) -> [URL] {
        let urls = Array(endpoint.urls.prefix(4))
        lock.lock(); let remembered = lastGood[endpoint.relayId]; lock.unlock()
        guard let remembered, let index = urls.firstIndex(of: remembered), index > 0 else { return urls }
        return [remembered] + urls.enumerated().filter { $0.offset != index }.map(\.element)
    }
    static func remember(_ endpoint: NativeRelayAddress, origin: URL?) {
        guard let origin else { return }
        lock.lock(); defer { lock.unlock() }
        if lastGood.count >= 64, lastGood[endpoint.relayId] == nil { lastGood.removeAll() }
        lastGood[endpoint.relayId] = origin
    }
}

/**
 * The first origin of an edge node to pass the signature check claims the node and alone sends the admission proof.
 * The claim lapses with its connection (`claimTimeout` after claiming at most): another origin that was refused while it
 * was held then dials again, so a stalled origin cannot keep the node's other origins waiting for the outer timeout.
 */
public final class NativeEdgeRace: @unchecked Sendable {
    static let claimTimeout: Duration = .seconds(4)
    private let lock = NSLock()
    private var holder: URL?
    private var finished = false
    private var cancelled = false
    private var refused = Set<URL>()
    private var waiters: [(origin: URL, resume: CheckedContinuation<Bool, Never>)] = []
    public init() {}
    public func claim(origin: URL) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if cancelled || finished { return false }
        guard holder == nil else { refused.insert(origin); return false }
        holder = origin; return true
    }
    /** The holder's connection ended before the race chose it: origins refused meanwhile may try again. */
    public func release(origin: URL) {
        lock.lock()
        guard holder == origin, !finished else { lock.unlock(); return }
        holder = nil
        let ready = waiters; waiters.removeAll()
        lock.unlock()
        for waiter in ready { waiter.resume.resume(returning: true) }
    }
    /** Whether `origin`, refused while another held the claim, should dial again: after a release, never after a winner. */
    func retryAfterRelease(origin: URL) async -> Bool {
        await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            lock.lock()
            guard !cancelled, !finished, refused.remove(origin) != nil else { lock.unlock(); continuation.resume(returning: false); return }
            if holder == nil { lock.unlock(); continuation.resume(returning: true); return }
            waiters.append((origin, continuation))
            lock.unlock()
        }
    }
    func whileActive(_ operation: () -> Void) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !cancelled else { return false }
        operation(); return true
    }
    func finish() { end(cancel: false) }
    func cancel() { end(cancel: true) }
    private func end(cancel: Bool) {
        lock.lock()
        if cancel { cancelled = true } else { finished = true }
        let waiting = waiters; waiters.removeAll()
        lock.unlock()
        for waiter in waiting { waiter.resume.resume(returning: false) }
    }
}

extension NativeEdgeOrigins {
    /**
     * The first success cancels the other attempts. Wait for the cancelled transports and any late successes to close.
     */
    public static func race<T: Sendable>(_ origins: [URL], stagger: Duration = .milliseconds(250),
        attempt: @escaping @Sendable (URL, NativeEdgeRace) async throws -> T,
        close: @escaping @Sendable (T) async -> Void) async -> (T, URL)? {
        guard !origins.isEmpty else { return nil }
        let race = NativeEdgeRace()
        let result = await withTaskCancellationHandler {
            await withTaskGroup(of: (T, URL)?.self) { group in
                for (index, origin) in origins.enumerated() {
                    group.addTask {
                        do {
                            if index > 0 { try await Task.sleep(for: stagger * index) }
                            // A second dial only when this origin was refused while a claimant held the node and that
                            // claimant's connection ended before winning.
                            for round in 0..<2 {
                                try Task.checkCancellation()
                                do { return (try await attempt(origin, race), origin) }
                                catch { guard round == 0, await race.retryAfterRelease(origin: origin) else { return nil } }
                            }
                            return nil
                        } catch { return nil }
                    }
                }
                var winner: (T, URL)?
                while let next = await group.next() {
                    guard let result = next else { continue }
                    if winner == nil, !Task.isCancelled {
                        winner = result
                        race.finish()
                        group.cancelAll()
                    } else { await close(result.0) }
                }
                return winner
            }
        } onCancel: { race.cancel() }
        if Task.isCancelled, let result {
            await close(result.0)
            return nil
        }
        return result
    }
}
