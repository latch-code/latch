import CryptoKit
import Foundation
import Network
import NIOCore
import NIOTransportServices
import Security

struct PreflightCertificate: Sendable {
    let certificate: Data
    let spki: Data
}

/** A relay has several serial handshakes on the same NWConnection. Only a completed step buys the next step time. */
package final class NativeRelayHandshakeDeadline: @unchecked Sendable {
    static let total = TimeAmount.seconds(24)
    private static let step = TimeAmount.seconds(8)
    private let lock = NSLock()
    private let limit: NIODeadline
    private var next: NIODeadline
    package init(now: NIODeadline = .now()) {
        limit = now + Self.total; next = now + Self.step
    }
    package func advanced(at now: NIODeadline = .now()) {
        lock.lock(); defer { lock.unlock() }
        guard now < next else { return }
        next = min(now + Self.step, limit)
    }
    package var deadline: NIODeadline { lock.lock(); defer { lock.unlock() }; return next }
}

/** The preflight runs below TLS; access from Network.framework and NIO queues is protected by this lock. */
final class HandshakeState: @unchecked Sendable {
    let root: Data
    let knockKey: Data
    let binding: LinkBinding
    let relayDeadline: NativeRelayHandshakeDeadline?
    let nonce: Data
    let startedAt: UInt64
    private let lock = NSLock()
    private var peer: PreflightCertificate?
    private var tlsAccepted = false
    init(root: Data, knockKey: Data, binding: LinkBinding, relayDeadline: NativeRelayHandshakeDeadline? = nil) throws {
        self.relayDeadline = relayDeadline
        let parsedRoot = try P256.Signing.PublicKey(derRepresentation: root)
        guard root.count == 91, LinkBytes.equal(parsedRoot.derRepresentation, root) else { throw NativeFailure.identityMismatch }
        self.root = root; self.knockKey = try LinkBytes.fixed(knockKey, 32); self.binding = binding
        self.nonce = try LinkBytes.random(16)
        let now = Date().timeIntervalSince1970 * 1000
        guard now >= 0, now <= Double(LinkBytes.maximumInteger) else { throw NativeFailure.expired }
        self.startedAt = UInt64(now)
    }
    func certificate() -> PreflightCertificate? { lock.lock(); defer { lock.unlock() }; return peer }
    func acceptTLS() { lock.lock(); defer { lock.unlock() }; tlsAccepted = true }
    func verifiedTLS() -> Bool { lock.lock(); defer { lock.unlock() }; return tlsAccepted }
    func accept(_ record: Data) throws {
        var reader = try LinkReader(record, maximum: 8192)
        let der = try reader.field(4096), mac = try reader.take(32)
        try reader.done()
        let expected = try NativeCrypto.serverBinding(key: knockKey, binding: binding, nonce: nonce, certificate: der)
        guard LinkBytes.equal(mac, expected), let cert = SecCertificateCreateWithData(nil, der as CFData),
              let key = SecCertificateCopyKey(cert), let point = SecKeyCopyExternalRepresentation(key, nil) as Data?,
              point.count == 65 else { throw NativeFailure.identityMismatch }
        let spki = try P256.Signing.PublicKey(x963Representation: point).derRepresentation
        lock.lock(); defer { lock.unlock() }
        guard peer == nil else { throw NativeFailure.invalidRecord }
        peer = PreflightCertificate(certificate: der, spki: spki)
    }
}

final class KnockFramer: NWProtocolFramerImplementation {
    static let label = "Latch authenticated preflight"
    static let definition = NWProtocolFramer.Definition(implementation: KnockFramer.self)
    private let state: HandshakeState?
    private var size: Int?
    private var ready = false
    required init(framer: NWProtocolFramer.Instance) { state = framer.options["latch.state"] as? HandshakeState }
    func start(framer: NWProtocolFramer.Instance) -> NWProtocolFramer.StartResult {
        do {
            guard let state else { throw NativeFailure.invalidRecord }
            framer.writeOutput(data: try NativeCrypto.knock(key: state.knockKey, binding: state.binding, timeMs: state.startedAt, nonce: state.nonce))
            framer.scheduleWakeup(wakeupTime: .milliseconds(3000))
        } catch { framer.markFailed(error: .posix(.EAUTH)) }
        return .willMarkReady
    }
    func handleInput(framer: NWProtocolFramer.Instance) -> Int {
        if ready { return 0 }
        if size == nil {
            let parsed = framer.parseInput(minimumIncompleteLength: 2, maximumLength: 2) { buffer, complete in
                guard let buffer, buffer.count >= 2 else { if complete { framer.markFailed(error: .posix(.ECONNRESET)) }; return 0 }
                size = Int(buffer[0]) * 256 + Int(buffer[1])
                return 2
            }
            guard parsed, let size else { return 2 }
            guard (1...8192).contains(size) else { framer.markFailed(error: .posix(.EMSGSIZE)); return 0 }
        }
        guard let size, let state else { framer.markFailed(error: .posix(.EAUTH)); return 0 }
        _ = framer.parseInput(minimumIncompleteLength: size, maximumLength: size) { buffer, complete in
            guard let buffer, buffer.count >= size else { if complete { framer.markFailed(error: .posix(.ECONNRESET)) }; return 0 }
            do {
                try state.accept(Data(buffer.prefix(size)))
                state.relayDeadline?.advanced()
                ready = true
                framer.passThroughInput(); framer.passThroughOutput(); framer.markReady()
            } catch { framer.markFailed(error: .posix(.EAUTH)) }
            return size
        }
        return ready ? 0 : size
    }
    func handleOutput(framer: NWProtocolFramer.Instance, message: NWProtocolFramer.Message, messageLength: Int, isComplete: Bool) {
        // TLS must never emit a client certificate before the service proves possession of the knock key.
        guard ready else { framer.markFailed(error: .posix(.EAUTH)); return }
        do { try framer.writeOutputNoCopy(length: messageLength) } catch { framer.markFailed(error: .posix(.ECONNRESET)) }
    }
    func wakeup(framer: NWProtocolFramer.Instance) { if !ready { framer.markFailed(error: .posix(.ETIMEDOUT)) } }
    func stop(framer: NWProtocolFramer.Instance) -> Bool { true }
    func cleanup(framer: NWProtocolFramer.Instance) {}
}

enum NativeTLS {
    static func applicationProtocol(_ state: HandshakeState) -> String {
        switch state.binding { case .direct: return "h2"; case .relay, .relayPaddedV2: return "latch-pad/1" }
    }
    static func options(state: HandshakeState, identity: PlatformIdentity?) throws -> NWProtocolTLS.Options {
        let options = NWProtocolTLS.Options(), security = options.securityProtocolOptions
        sec_protocol_options_set_min_tls_protocol_version(security, .TLSv13)
        sec_protocol_options_set_max_tls_protocol_version(security, .TLSv13)
        let applicationProtocol = applicationProtocol(state)
        sec_protocol_options_add_tls_application_protocol(security, applicationProtocol)
        sec_protocol_options_set_tls_server_name(security, "transport.latch.invalid")
        sec_protocol_options_set_tls_tickets_enabled(security, false)
        sec_protocol_options_set_tls_resumption_enabled(security, false)
        sec_protocol_options_set_tls_false_start_enabled(security, false)
        if let identity {
            guard let local = sec_identity_create(identity.identity) else { throw NativeFailure.identityMismatch }
            sec_protocol_options_set_local_identity(security, local)
        }
        sec_protocol_options_set_verify_block(security, { metadata, trust, complete in
            guard let peer = state.certificate(), let certificate = SecCertificateCreateWithData(nil, peer.certificate as CFData) else { complete(false); return }
            let actual = sec_trust_copy_ref(trust).takeRetainedValue()
            guard SecTrustSetPolicies(actual, SecPolicyCreateSSL(true, "transport.latch.invalid" as CFString)) == errSecSuccess,
                  SecTrustSetAnchorCertificates(actual, [certificate] as CFArray) == errSecSuccess,
                  SecTrustSetAnchorCertificatesOnly(actual, true) == errSecSuccess,
                  SecTrustSetNetworkFetchAllowed(actual, false) == errSecSuccess,
                  SecTrustEvaluateWithError(actual, nil), let chain = SecTrustCopyCertificateChain(actual) as? [SecCertificate],
                  let first = chain.first, LinkBytes.equal(SecCertificateCopyData(first) as Data, peer.certificate),
                  sec_protocol_metadata_get_negotiated_tls_protocol_version(metadata) == .TLSv13,
                  let protocolName = sec_protocol_metadata_get_negotiated_protocol(metadata), String(cString: protocolName) == applicationProtocol else { complete(false); return }
            state.acceptTLS()
            state.relayDeadline?.advanced()
            complete(true)
        }, DispatchQueue(label: "app.latch.native.tls-verify"))
        return options
    }
    static func parameters(state: HandshakeState, identity: PlatformIdentity?) throws -> NWParameters {
        let tcp = NWProtocolTCP.Options(); tcp.noDelay = true; tcp.connectionTimeout = 5
        // Direct paths: a dead LAN peer is noticed by the OS too, beside the HTTP/2 PINGs.
        tcp.enableKeepalive = true; tcp.keepaliveIdle = 15; tcp.keepaliveInterval = 5; tcp.keepaliveCount = 2
        let parameters = NWParameters(tls: try options(state: state, identity: identity), tcp: tcp)
        let preflight = NWProtocolFramer.Options(definition: KnockFramer.definition)
        preflight["latch.state"] = state
        // Closest to the application first: TLS is suspended until the lower preflight marks ready.
        parameters.defaultProtocolStack.applicationProtocols.append(preflight)
        parameters.includePeerToPeer = false
        return parameters
    }
    static func validate(_ state: HandshakeState) throws {
        guard state.verifiedTLS() else { throw NativeFailure.identityMismatch }
    }
}

/** Event-loop confined. No HTTP/2 preface or application request is installed until the root signature is verified. */
final class HostProofGate: ChannelInboundHandler, RemovableChannelHandler, @unchecked Sendable {
    typealias InboundIn = ByteBuffer
    typealias InboundOut = ByteBuffer
    private let state: HandshakeState
    private let completion: EventLoopPromise<Void>
    private var buffer = ByteBuffer()
    private var verified = false
    private var settled = false
    private var timer: Scheduled<Void>?
    private weak var context: ChannelHandlerContext?
    init(state: HandshakeState, completion: EventLoopPromise<Void>) { self.state = state; self.completion = completion }
    func handlerAdded(context: ChannelHandlerContext) {
        self.context = context
        scheduleDeadline(on: context.eventLoop, at: state.relayDeadline?.deadline ?? (.now() + .seconds(8)))
    }
    private func scheduleDeadline(on loop: any EventLoop, at deadline: NIODeadline) {
        timer = loop.scheduleTask(deadline: deadline) { [self] in
            guard let context = self.context, !settled else { return }
            if let next = state.relayDeadline?.deadline, next > .now() {
                scheduleDeadline(on: loop, at: next)
            } else { fail(context) }
        }
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        var incoming = unwrapInboundIn(data)
        guard buffer.readableBytes + incoming.readableBytes <= 65_536 else { fail(context); return }
        buffer.writeBuffer(&incoming)
        guard !verified, let size: UInt16 = buffer.getInteger(at: buffer.readerIndex) else { return }
        guard size > 0, size <= 8192 else { fail(context); return }
        guard buffer.readableBytes >= Int(size) + 2 else { return }
        buffer.moveReaderIndex(forwardBy: 2)
        guard let bytes = buffer.readBytes(length: Int(size)), let peer = state.certificate() else { fail(context); return }
        do {
            let now = Date().timeIntervalSince1970 * 1000
            guard now >= 0, now <= Double(LinkBytes.maximumInteger) else { throw NativeFailure.expired }
            try NativeCrypto.verifyHostProof(Data(bytes), rootSpki: state.root, transportSpki: peer.spki, nonce: state.nonce, timeMs: UInt64(now))
            verified = true; settled = true; timer?.cancel(); completion.succeed(())
        } catch { fail(context) }
    }
    func handlerRemoved(context: ChannelHandlerContext) {
        timer?.cancel()
        if !settled { settled = true; completion.fail(NativeFailure.identityMismatch) }
        if verified, buffer.readableBytes > 0 { context.fireChannelRead(wrapInboundOut(buffer)); context.fireChannelReadComplete() }
        self.context = nil
    }
    func channelInactive(context: ChannelHandlerContext) { fail(context); context.fireChannelInactive() }
    func errorCaught(context: ChannelHandlerContext, error: Error) { fail(context) }
    private func fail(_ context: ChannelHandlerContext) {
        if !settled { settled = true; timer?.cancel(); completion.fail(NativeFailure.identityMismatch) }
        context.close(promise: nil)
    }
}
