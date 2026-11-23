import Foundation
import Network
import NIOCore
import NIOHTTP1
import NIOHTTP2
import NIOTransportServices

public struct NativeHTTPResponse: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: Data
}
public enum NativeHTTPMethod: String, Sendable { case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE", head = "HEAD" }

/** NIOTS must close its channel before NWConnection emits cancelled. */
private final class NativeConnectionCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var channel: (any Channel)?
    private var cancelled = false
    func bind(_ channel: any Channel) {
        lock.lock(); self.channel = channel; let close = cancelled; lock.unlock()
        if close { channel.close(promise: nil) }
    }
    func cancel() {
        lock.lock(); cancelled = true; let channel = self.channel; lock.unlock()
        channel?.close(promise: nil)
    }
    func waitForClose() async {
        let bound = lock.withLock { channel }
        if let bound { try? await bound.closeFuture.get() }
    }
}

/** Opening can fail before a collector is installed. In that case there can be no response on this child stream. */
package func openNativeHTTP2Stream<Value: Sendable>(on loop: any EventLoop, using streams: HTTP2StreamMultiplexer.SendableView,
    response: Value.Type, initialize: @escaping @Sendable (any Channel, EventLoopPromise<Value>) -> EventLoopFuture<Void>)
    -> (stream: EventLoopFuture<any Channel>, response: EventLoopFuture<Value>) {
    let opened = loop.makePromise(of: (any Channel).self), reply = loop.makePromise(of: response)
    opened.futureResult.cascadeFailure(to: reply)
    streams.createStreamChannel(promise: opened) { stream in initialize(stream, reply) }
    return (opened.futureResult, reply.futureResult)
}

/** One authenticated inner TLS/HTTP2 channel; replacement is owned by the workspace, never by a write request. */
public actor NativeHTTPConnection {
    @TaskLocal static var fileTransferBuffer = false
    @TaskLocal static var workspaceDirectDial = false
    /** The normal HTTP/2 PING period. Paired workspace direct paths lower it when needed. */
    @TaskLocal public static var livenessInterval: TimeAmount = NativeLivenessHandler.interval
    public nonisolated let usesRelay: Bool
    private let channel: any Channel
    private let streams: HTTP2StreamMultiplexer.SendableView
    private let group: NIOTSEventLoopGroup
    private let padding: NativePaddingHandler?
    private var requests = 0 { didSet { gauge.set(requests) } }
    private nonisolated let gauge = NativeRequestGauge()
    /** No request, file range or upload is in flight; event streams do not count. Readable without hopping to the actor. */
    public nonisolated var idle: Bool { gauge.idle }
    private var eventCount = 0
    private var closed = false
    private var closeTask: Task<Void, Never>?
    private init(channel: any Channel, streams: HTTP2StreamMultiplexer.SendableView, group: NIOTSEventLoopGroup, padding: NativePaddingHandler?) {
        self.channel = channel; self.streams = streams; self.group = group; self.padding = padding
        usesRelay = padding != nil
    }
    public static func open(host: String, port: UInt16, rootSpki: Data, knockKey: Data, identity: PlatformIdentity? = nil,
        binding: LinkBinding = .direct, interface: NWInterface? = nil) async throws -> NativeHTTPConnection {
        let scoped = host.split(separator: "%", omittingEmptySubsequences: false), address = String(scoped[0])
        guard port > 0, scoped.count <= 2, AddressBookCodec.isIP(address) else { throw NativeFailure.invalidRecord }
        if scoped.count == 2 {
            guard let interface, address.contains(":"), scoped[1] == Substring(interface.name) || Int(scoped[1]) == interface.index else { throw NativeFailure.invalidRecord }
        }
        let state = try HandshakeState(root: rootSpki, knockKey: knockKey, binding: binding)
        let parameters = try NativeTLS.parameters(state: state, identity: identity)
        if let interface { parameters.requiredInterface = interface }
        let connection = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: parameters)
        let fastLiveness: Bool
        if case .direct = binding { fastLiveness = workspaceDirectDial && identity != nil }
        else { fastLiveness = false }
        return try await establish(connection, state: state, fastLiveness: fastLiveness)
    }
    static func establish(_ connection: NWConnection, state: HandshakeState, fastLiveness: Bool = false) async throws -> NativeHTTPConnection {
        guard !Task.isCancelled else { connection.cancel(); throw CancellationError() }
        let cancellation = NativeConnectionCancellation()
        return try await withTaskCancellationHandler {
            try await establishOnce(connection, state: state, cancellation: cancellation, fastLiveness: fastLiveness)
        } onCancel: { cancellation.cancel() }
    }
    private static func establishOnce(_ connection: NWConnection, state: HandshakeState,
        cancellation: NativeConnectionCancellation, fastLiveness: Bool) async throws -> NativeHTTPConnection {
        // A bulk companion's stream and connection windows near the BDP of a fast, far link; the Host bounds the rest.
        let window = fileTransferBuffer ? 2_097_152 : 65_535
        let group = NIOTSEventLoopGroup(loopCount: 1)
        let completion = group.next().makePromise(of: Void.self), gate = HostProofGate(state: state, completion: completion)
        do {
            // NIOTS resolves only after the entire Network.framework stack, including relay splice and inner TLS, is ready.
            let timeout: TimeAmount = state.relayDeadline == nil ? .seconds(8) : NativeRelayHandshakeDeadline.total
            let opening = NIOTSConnectionBootstrap(group: group).connectTimeout(timeout)
                .channelOption(ChannelOptions.writeBufferWaterMark, value: .init(low: 16_384, high: 32_768))
                .channelInitializer { channel in channel.pipeline.addHandler(gate).map { cancellation.bind(channel) } }
                .withExistingNWConnection(connection)
            opening.cascadeFailure(to: completion)
            let channel = try await opening.get()
            guard !Task.isCancelled else { throw CancellationError() }
            try NativeTLS.validate(state)
            try await completion.futureResult.get()
            let padding = NativeTLS.applicationProtocol(state) == "latch-pad/1" ? NativePaddingHandler() : nil
            if let padding { try await channel.pipeline.addHandler(padding, position: .after(gate)).get() }
            let streams = try await channel.configureHTTP2Pipeline(mode: .client, initialLocalSettings: [
                HTTP2Setting(parameter: .headerTableSize, value: 0), HTTP2Setting(parameter: .enablePush, value: 0),
                HTTP2Setting(parameter: .initialWindowSize, value: window),
                HTTP2Setting(parameter: .maxConcurrentStreams, value: 32), HTTP2Setting(parameter: .maxHeaderListSize, value: 32_768),
            ], targetWindowSize: window, inboundStreamInitializer: { stream in stream.close() }).map { $0.sendableView }.get()
            try await channel.pipeline.removeHandler(gate).get()
            try await channel.pipeline.addHandler(NativeLivenessHandler(fast: fastLiveness, interval: livenessInterval)).get()
            guard !Task.isCancelled else { throw CancellationError() }
            return NativeHTTPConnection(channel: channel, streams: streams, group: group, padding: padding)
        } catch {
            cancellation.cancel()
            await cancellation.waitForClose()
            try? await group.shutdownGracefully()
            connection.cancel()
            if Task.isCancelled { throw CancellationError() }
            throw NativeFailure.identityMismatch
        }
    }
    public func request(_ method: NativeHTTPMethod, path: String, body: Data? = nil, headers: [String: String] = [:], maximum: Int = 1_048_576, timeoutSeconds: Int64 = 15) async throws -> NativeHTTPResponse {
        guard !closed, channel.isActive else { throw NativeFailure.unavailable }
        guard requests < 16, path.hasPrefix("/link/api/"), path.utf8.count <= 4096, path.utf8.allSatisfy({ $0 >= 33 && $0 < 127 }),
              (body?.count ?? 0) <= 1_048_576, (0...1_048_576).contains(maximum), headers.count <= 8,
              headers.keys.allSatisfy({ ["content-type", "range", "if-match", "if-none-match", "x-latch-attachment"].contains($0) }),
              headers.values.allSatisfy({ $0.utf8.count <= 8192 && $0.utf8.allSatisfy({ $0 >= 32 && $0 < 127 }) }) else { throw NativeFailure.invalidRecord }
        requests += 1
        defer { requests -= 1 }
        if let padding, path.hasSuffix("/cancel") || path.contains("/approvals/") {
            try await channel.eventLoop.submit { [padding] in padding.protect() }.get()
        }
        let opening = openNativeHTTP2Stream(on: channel.eventLoop, using: streams, response: NativeHTTPResponse.self) { stream, response in
            stream.eventLoop.makeCompletedFuture {
                try stream.pipeline.syncOperations.addHandlers(HTTP2FramePayloadToHTTP1ClientCodec(httpProtocol: .https), HTTPResponseCollector(promise: response, maximum: maximum, timeoutSeconds: timeoutSeconds))
            }
        }
        let stream = try await opening.stream.get()
        do {
            if method == .get || method == .head { try Task.checkCancellation() }
            var fields = HTTPHeaders([("host", "native.latch.invalid"), ("accept", "application/json")])
            if body != nil { fields.add(name: "content-type", value: headers["content-type"] ?? "application/json") }
            for (name, value) in headers where name != "content-type" { fields.add(name: name, value: value) }
            stream.write(HTTPClientRequestPart.head(HTTPRequestHead(version: .http2, method: HTTPMethod(rawValue: method.rawValue), uri: path, headers: fields)), promise: nil)
            if let body, !body.isEmpty {
                var buffer = stream.allocator.buffer(capacity: body.count); buffer.writeBytes(body)
                stream.write(HTTPClientRequestPart.body(.byteBuffer(buffer)), promise: nil)
            }
            try await stream.writeAndFlush(HTTPClientRequestPart.end(nil)).get()
            return try await withTaskCancellationHandler {
                try await opening.response.get()
            } onCancel: { stream.close(promise: nil) }
        } catch {
            try? await stream.close().get()
            if Task.isCancelled && (method == .get || method == .head) { throw CancellationError() }
            throw NativeFailure.resultUnknown
        }
    }
    public func close() async {
        if let closeTask { await closeTask.value; return }
        closed = true
        let task = Task { [channel, group] in
            try? await channel.close().get()
            try? await channel.closeFuture.get()
            try? await group.shutdownGracefully()
        }
        closeTask = task; await task.value
    }
    func fileRange(handle: String, etag: String, offset: Int, count: Int, total: Int, lease: BodyLease,
        progress: (@Sendable (Int, Int) -> Void)?) async throws -> Data {
        guard !closed, channel.isActive, usesRelay, requests < 16, LinkBytes.matches(handle, "[A-Za-z0-9_-]{22}"),
              LinkBytes.matches(etag, "\"[a-f0-9]{32}\""), offset >= 0, count > 0, count <= 1_048_576,
              total >= count, total <= 8_388_608, offset <= total - count else { throw NativeFailure.invalidRecord }
        let permit = NativeFileReadPermit(lease: lease) { [channel] in channel.close(promise: nil) }
        try permit.requireValid(); requests += 1
        let timer = channel.eventLoop.scheduleTask(in: .seconds(15)) { permit.cancel() }
        defer { requests -= 1; timer.cancel(); permit.finish() }
        do { return try await withTaskCancellationHandler {
            let streamPromise = channel.eventLoop.makePromise(of: (any Channel).self)
            streams.createStreamChannel(promise: streamPromise) { stream in
                stream.pipeline.addHandler(HTTP2FramePayloadToHTTP1ClientCodec(httpProtocol: .https))
            }
            let stream = try await streamPromise.futureResult.get()
            permit.bind(stream)
            let response = stream.eventLoop.makePromise(of: Data.self)
            var collectorAdded = false
            do {
                try await stream.pipeline.addHandler(NativeFileResponseCollector(promise: response, permit: permit, etag: etag,
                    offset: offset, count: count, total: total, progress: progress)).get()
                collectorAdded = true
                try permit.requireValid()
                let fields = HTTPHeaders([("host", "native.latch.invalid"), ("accept", "application/octet-stream"),
                    ("if-match", etag), ("range", "bytes=\(offset)-\(offset + count - 1)")])
                stream.write(HTTPClientRequestPart.head(HTTPRequestHead(version: .http2, method: .GET, uri: "/link/api/files/" + handle, headers: fields)), promise: nil)
                try await stream.writeAndFlush(HTTPClientRequestPart.end(nil)).get()
                let bytes = try await response.futureResult.get()
                try permit.requireValid(); return bytes
            } catch {
                if !collectorAdded { response.fail(error) }
                permit.cancel(); try? await stream.close().get()
                if Task.isCancelled { throw CancellationError() }; throw error
            }
        } onCancel: { permit.cancel() }
        } catch {
            if Task.isCancelled { throw CancellationError() }
            if error is CancellationError { throw NativeFailure.resultUnknown }
            throw error
        }
    }
    /**
     * One attachment, or one part of a chunked one (`part`: the PUT path of `/link/api/attachments/uploads/<id>/parts/<n>`),
     * as one stream of at most 1 MiB, written in 64 KiB chunks; before each chunk the body window and this connection are
     * checked again. Cancel closes the stream and waits for it; a lost or late answer is result unknown.
     */
    func upload(metadata: String?, part: String? = nil, body: Data, lease: BodyLease, timeoutSeconds: Int64,
        progress: (@Sendable (Int, Int) -> Void)?) async throws -> NativeHTTPResponse {
        guard !closed, channel.isActive, requests < 16, (1...1_048_576).contains(body.count), (1...600).contains(timeoutSeconds),
              (metadata == nil) != (part == nil),
              metadata.map({ $0.utf8.count <= 4096 && LinkBytes.matches($0, "[A-Za-z0-9_-]{1,4096}") }) ?? true,
              part.map({ LinkBytes.matches($0, "/link/api/attachments/uploads/[A-Za-z0-9_-]{22}/parts/[0-9]{1,3}") }) ?? true
        else { throw NativeFailure.invalidRecord }
        // Before a stream exists there is nothing of this upload to close; the connection is shared and stays open.
        let permit = NativeFileReadPermit(lease: lease) {}
        try permit.requireValid(); requests += 1
        defer { requests -= 1; permit.finish() }
        let opening = openNativeHTTP2Stream(on: channel.eventLoop, using: streams, response: NativeHTTPResponse.self) { stream, response in
            stream.eventLoop.makeCompletedFuture {
                try stream.pipeline.syncOperations.addHandlers(HTTP2FramePayloadToHTTP1ClientCodec(httpProtocol: .https),
                    HTTPResponseCollector(promise: response, maximum: 65_536, timeoutSeconds: timeoutSeconds))
            }
        }
        let stream = try await opening.stream.get()
        permit.bind(stream)
        // The Host may answer before the whole body went (a refusal by size, scope or capability): that answer wins.
        let early = NativeEarlyAnswer()
        opening.response.whenSuccess { early.set($0) }
        let parent = channel
        do {
            return try await withTaskCancellationHandler {
                func current() throws { try Task.checkCancellation(); try permit.requireValid(); guard parent.isActive, stream.isActive else { throw NativeFailure.unavailable } }
                try current()
                var fields = HTTPHeaders([("host", "native.latch.invalid"), ("accept", "application/json"), ("content-type", "application/octet-stream"),
                    ("content-length", String(body.count))])
                if let metadata { fields.add(name: "x-latch-attachment", value: metadata) }
                let head = HTTPRequestHead(version: .http2, method: part == nil ? .POST : .PUT, uri: part ?? "/link/api/attachments", headers: fields)
                try await stream.writeAndFlush(HTTPClientRequestPart.head(head)).get()
                var offset = 0
                while offset < body.count {
                    try current()
                    let end = min(offset + 65_536, body.count)
                    var buffer = stream.allocator.buffer(capacity: end - offset); buffer.writeBytes(body[body.startIndex + offset..<body.startIndex + end])
                    try await stream.writeAndFlush(HTTPClientRequestPart.body(.byteBuffer(buffer))).get()
                    offset = end; progress?(offset, body.count)
                }
                try current()
                try await stream.writeAndFlush(HTTPClientRequestPart.end(nil)).get()
                return try await opening.response.get()
            } onCancel: { permit.cancel() }
        } catch {
            permit.cancel(); stream.close(promise: nil)
            // Waits until the stream is really closed, as a cancelled file read does.
            try? await stream.closeFuture.get()
            if let answer = early.value { return answer }
            if Task.isCancelled { throw CancellationError() }
            if let failure = error as? NativeFailure, failure == .expired { throw failure }
            throw NativeFailure.resultUnknown
        }
    }
    public func events(sessionId: String? = nil, lease: BodyLease? = nil, cursor: NativeEventCursor? = nil, incremental: Bool = false) async throws -> NativeEventStream {
        guard !closed, channel.isActive, eventCount < 2 else { throw NativeFailure.unavailable }
        guard !incremental || sessionId != nil else { throw NativeFailure.invalidRecord }
        if let sessionId {
            guard LinkBytes.matches(sessionId, "[A-Za-z0-9_-]{1,160}"), let lease else { throw NativeFailure.invalidRecord }
            try lease.requireValid()
        }
        eventCount += 1
        let origin = NativeEventOrigin()
        let pair = AsyncThrowingStream<NativeEvent, Error>.makeStream(bufferingPolicy: .bufferingOldest(8))
        var installed = false
        let cancellation = NativeConnectionCancellation()
        let opening = openNativeHTTP2Stream(on: channel.eventLoop, using: streams, response: Void.self) { stream, ready in
            stream.eventLoop.makeCompletedFuture {
                try stream.pipeline.syncOperations.addHandlers(HTTP2FramePayloadToHTTP1ClientCodec(httpProtocol: .https),
                    NativeEventCollector(ready: ready, continuation: pair.continuation, lease: lease, origin: origin))
            }
        }
        do { return try await withTaskCancellationHandler {
            let stream = try await opening.stream.get()
            installed = true
            stream.closeFuture.whenComplete { _ in Task { await self.eventEnded() } }
            pair.continuation.onTermination = { _ in stream.close(promise: nil) }
            cancellation.bind(stream)
            try Task.checkCancellation()
            var query = sessionId.map { ["sessionId=" + $0] } ?? []
            if let cursor {
                _ = try NativeEventCursor.parse("\(cursor.epoch):\(cursor.sequence)")
                query += ["resumeEpoch=" + cursor.epoch, "resumeAfter=\(cursor.sequence)"]
            }
            let path = "/link/api/events" + (query.isEmpty ? "" : "?" + query.joined(separator: "&"))
            var fields = HTTPHeaders([("host", "native.latch.invalid"), ("accept", "text/event-stream")])
            if incremental { fields.add(name: "x-latch-state", value: "delta-v1") }
            stream.write(HTTPClientRequestPart.head(HTTPRequestHead(version: .http2, method: .GET, uri: path, headers: fields)), promise: nil)
            try await stream.writeAndFlush(HTTPClientRequestPart.end(nil)).get()
            try await opening.response.get()
            try Task.checkCancellation()
            return NativeEventStream(events: pair.stream, channel: stream, origin: origin)
        } onCancel: { cancellation.cancel() }
        } catch {
            cancellation.cancel()
            if !installed { eventCount = max(0, eventCount - 1) }
            if Task.isCancelled { pair.continuation.finish(throwing: CancellationError()); throw CancellationError() }
            let failure: NativeFailure = (error as? NativeFailure) == .expired ? .expired : .unavailable
            pair.continuation.finish(throwing: failure)
            throw failure
        }
    }
    private func eventEnded() { eventCount = max(0, eventCount - 1) }
    public func isClosed() -> Bool { closed || !channel.isActive }
    /** Returns once the channel has closed, for whatever reason. */
    public func waitForClose() async { try? await channel.closeFuture.get() }
    func waitForCloseOrCancellation() async {
        // Waiting on the stream lets a caller cancel its observation without closing the channel.
        let (notification, continuation) = AsyncStream<Void>.makeStream()
        channel.closeFuture.whenComplete { _ in continuation.finish() }
        var iterator = notification.makeAsyncIterator()
        _ = await iterator.next()
    }
    /** After the Host activated this companion: its uplink goes unclocked past the bulk delay, each cell checked first. */
    func enableBulk(permitted: @escaping @Sendable () -> Bool) async throws {
        guard let padding, !closed else { throw NativeFailure.unavailable }
        try await channel.eventLoop.submit { padding.bulk(permitted: permitted) }.get()
    }
    /** Whether this companion's own uplink sent its end padding, so an upload companion closes only after it. */
    func outboundSettled() async -> Bool {
        guard let padding, !closed, channel.isActive else { return true }
        return (try? await channel.eventLoop.submit { padding.outboundSettled() }.get()) ?? true
    }
    /** How long since the Host's last cell arrived, so a companion closes only after the Host's end padding. */
    func inboundIdleMs() async -> UInt64? {
        guard let padding, !closed, channel.isActive else { return nil }
        return try? await channel.eventLoop.submit { padding.inboundIdleMs() }.get()
    }
}

/** An upload's answer that came before its body finished. */
private final class NativeEarlyAnswer: @unchecked Sendable {
    private let lock = NSLock()
    private var answer: NativeHTTPResponse?
    func set(_ value: NativeHTTPResponse) { lock.lock(); answer = value; lock.unlock() }
    var value: NativeHTTPResponse? { lock.lock(); defer { lock.unlock() }; return answer }
}

/** Confined to its child stream's event loop. Every response has an explicit byte and time budget. */
private final class HTTPResponseCollector: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = HTTPClientResponsePart
    private let promise: EventLoopPromise<NativeHTTPResponse>
    private let maximum: Int
    private var status = 0
    private var headers: [String: String] = [:]
    private var body = Data()
    private var settled = false
    private weak var context: ChannelHandlerContext?
    private var timer: Scheduled<Void>?
    private let timeoutSeconds: Int64
    init(promise: EventLoopPromise<NativeHTTPResponse>, maximum: Int, timeoutSeconds: Int64) { self.promise = promise; self.maximum = maximum; self.timeoutSeconds = timeoutSeconds }
    func handlerAdded(context: ChannelHandlerContext) {
        self.context = context
        timer = context.eventLoop.scheduleTask(in: .seconds(timeoutSeconds)) { [self] in if let context = self.context { fail(context) } }
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        guard !settled else { return }
        switch unwrapInboundIn(data) {
        case let .head(head):
            if head.status.code < 200 { return }
            guard status == 0, head.headers.count <= 64 else { fail(context); return }
            status = Int(head.status.code)
            for name in ["content-type", "content-length", "content-range", "etag", "x-latch-audit", "retry-after"] {
                if let value = head.headers[name].first, value.utf8.count <= 4096 { headers[name] = value }
            }
        case var .body(buffer):
            guard status != 0, buffer.readableBytes <= maximum - body.count else { fail(context); return }
            if let bytes = buffer.readBytes(length: buffer.readableBytes) { body.append(contentsOf: bytes) }
        case .end:
            guard status != 0 else { fail(context); return }
            settled = true; timer?.cancel(); promise.succeed(NativeHTTPResponse(status: status, headers: headers, body: body))
            context.close(promise: nil)
        }
    }
    func channelInactive(context: ChannelHandlerContext) { if !settled { fail(context) }; context.fireChannelInactive() }
    func errorCaught(context: ChannelHandlerContext, error: Error) { fail(context) }
    func handlerRemoved(context: ChannelHandlerContext) { self.context = nil; failResponse() }
    private func failResponse() {
        guard !settled else { return }
        settled = true; timer?.cancel(); promise.fail(NativeFailure.resultUnknown)
    }
    private func fail(_ context: ChannelHandlerContext) {
        failResponse()
        context.close(promise: nil)
    }
}

/**
 * Two unanswered PINGs close this parent channel. A paired workspace's direct path uses a shorter interval so even
 * packet loss without a Network.framework event is detected. A route hint from that connection starts a prompt probe.
 */
public final class NativeLivenessHandler: ChannelInboundHandler, @unchecked Sendable {
    public typealias InboundIn = HTTP2Frame
    public typealias OutboundOut = HTTP2Frame
    public static let interval: TimeAmount = .seconds(10)
    public static let misses = 2
    private let interval: TimeAmount
    private let misses: Int
    private let fast: Bool
    private var timer: RepeatedTask?
    private var pathProbe: (sequence: UInt64, deadline: Scheduled<Void>)?
    private var outstanding = false
    private var missed = 0
    private var sequence: UInt64 = 0
    public convenience init(interval: TimeAmount = NativeLivenessHandler.interval, misses: Int = NativeLivenessHandler.misses) {
        self.init(fast: false, interval: interval, misses: misses)
    }
    package init(fast: Bool, interval: TimeAmount = NativeLivenessHandler.interval, misses: Int = NativeLivenessHandler.misses) {
        self.fast = fast
        self.interval = max(fast ? min(interval, .seconds(2)) : interval, .milliseconds(10))
        self.misses = max(1, misses)
    }
    public func handlerAdded(context: ChannelHandlerContext) { if context.channel.isActive { start(context) } }
    public func channelActive(context: ChannelHandlerContext) { start(context); context.fireChannelActive() }
    public func channelInactive(context: ChannelHandlerContext) { stop(); context.fireChannelInactive() }
    public func handlerRemoved(context: ChannelHandlerContext) { stop() }
    public func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if fast, context.channel.isActive, pathProbe == nil,
           (event as? NIOTSNetworkEvents.ViabilityUpdate)?.isViable == false || event is NIOTSNetworkEvents.PathChanged {
            ping(context)
            let deadline = context.eventLoop.scheduleTask(in: interval) { [weak self, weak channel = context.channel] in
                guard let self, let channel else { return }
                self.stop(); channel.close(promise: nil)
            }
            pathProbe = (sequence, deadline)
        }
        context.fireUserInboundEventTriggered(event)
    }
    public func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        if case let .ping(value, ack: true) = unwrapInboundIn(data).payload {
            outstanding = false; missed = 0
            // An ACK to an earlier ping may already be in flight when the route changes.
            if let pathProbe, pathProbe.sequence == value.integer {
                pathProbe.deadline.cancel(); self.pathProbe = nil
            }
        }
        context.fireChannelRead(data)
    }
    private func start(_ context: ChannelHandlerContext) {
        guard timer == nil else { return }
        ping(context)
        let loop = context.eventLoop
        timer = loop.scheduleRepeatedTask(initialDelay: interval, delay: interval) { [weak self, weak context] _ in
            guard let self, let context else { return }
            self.tick(context)
        }
    }
    private func stop() {
        timer?.cancel(); timer = nil
        pathProbe?.deadline.cancel(); pathProbe = nil
    }
    private func tick(_ context: ChannelHandlerContext) {
        guard pathProbe == nil else { return }
        if outstanding {
            missed += 1
            if missed >= misses { stop(); context.close(promise: nil); return }
        }
        ping(context)
    }
    private func ping(_ context: ChannelHandlerContext) {
        sequence &+= 1; outstanding = true
        context.writeAndFlush(wrapOutboundOut(HTTP2Frame(streamID: .rootStream, payload: .ping(HTTP2PingData(withInteger: sequence), ack: false))), promise: nil)
    }
}

/** A lock-guarded copy of a connection's request count, so a path swap can check it in the same actor turn. */
final class NativeRequestGauge: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func set(_ value: Int) { lock.lock(); count = value; lock.unlock() }
    var idle: Bool { lock.lock(); defer { lock.unlock() }; return count == 0 }
}
