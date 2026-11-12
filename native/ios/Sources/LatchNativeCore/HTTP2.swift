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
}

/** One authenticated inner TLS/HTTP2 channel; replacement is owned by the workspace, never by a write request. */
public actor NativeHTTPConnection {
    @TaskLocal static var fileTransferBuffer = false
    public nonisolated let usesRelay: Bool
    private let channel: any Channel
    private let streams: HTTP2StreamMultiplexer.SendableView
    private let group: NIOTSEventLoopGroup
    private let padding: NativePaddingHandler?
    private var requests = 0
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
        return try await establish(connection, state: state)
    }
    static func establish(_ connection: NWConnection, state: HandshakeState) async throws -> NativeHTTPConnection {
        guard !Task.isCancelled else { connection.cancel(); throw CancellationError() }
        let cancellation = NativeConnectionCancellation()
        return try await withTaskCancellationHandler {
            try await establishOnce(connection, state: state, cancellation: cancellation)
        } onCancel: { cancellation.cancel() }
    }
    private static func establishOnce(_ connection: NWConnection, state: HandshakeState,
        cancellation: NativeConnectionCancellation) async throws -> NativeHTTPConnection {
        let window = fileTransferBuffer ? 262_144 : 65_535
        let group = NIOTSEventLoopGroup(loopCount: 1)
        let completion = group.next().makePromise(of: Void.self), gate = HostProofGate(state: state, completion: completion)
        var established: (any Channel)?
        do {
            let channel = try await NIOTSConnectionBootstrap(group: group).connectTimeout(.seconds(8))
                .channelOption(ChannelOptions.writeBufferWaterMark, value: .init(low: 16_384, high: 32_768))
                .channelInitializer { channel in channel.pipeline.addHandler(gate).map { cancellation.bind(channel) } }
                .withExistingNWConnection(connection).get()
            established = channel
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
            guard !Task.isCancelled else { throw CancellationError() }
            return NativeHTTPConnection(channel: channel, streams: streams, group: group, padding: padding)
        } catch {
            cancellation.cancel()
            if let established { try? await established.close().get() }
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
        let response = channel.eventLoop.makePromise(of: NativeHTTPResponse.self), streamPromise = channel.eventLoop.makePromise(of: (any Channel).self)
        streams.createStreamChannel(promise: streamPromise) { stream in
            stream.eventLoop.makeCompletedFuture {
                try stream.pipeline.syncOperations.addHandlers(HTTP2FramePayloadToHTTP1ClientCodec(httpProtocol: .https), HTTPResponseCollector(promise: response, maximum: maximum, timeoutSeconds: timeoutSeconds))
            }
        }
        let stream = try await streamPromise.futureResult.get()
        do {
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
                try await response.futureResult.get()
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
     * One attachment as one stream of at most 1 MiB, written in 64 KiB chunks; before each chunk the body window and this
     * connection are checked again. Cancel closes the stream and waits for it; a lost or late answer is result unknown.
     */
    func upload(metadata: String, body: Data, lease: BodyLease, timeoutSeconds: Int64,
        progress: (@Sendable (Int, Int) -> Void)?) async throws -> NativeHTTPResponse {
        guard !closed, channel.isActive, requests < 16, (1...1_048_576).contains(body.count), (1...600).contains(timeoutSeconds),
              metadata.utf8.count <= 4096, LinkBytes.matches(metadata, "[A-Za-z0-9_-]{1,4096}") else { throw NativeFailure.invalidRecord }
        // Before a stream exists there is nothing of this upload to close; the connection is shared and stays open.
        let permit = NativeFileReadPermit(lease: lease) {}
        try permit.requireValid(); requests += 1
        defer { requests -= 1; permit.finish() }
        let response = channel.eventLoop.makePromise(of: NativeHTTPResponse.self), streamPromise = channel.eventLoop.makePromise(of: (any Channel).self)
        streams.createStreamChannel(promise: streamPromise) { stream in
            stream.eventLoop.makeCompletedFuture {
                try stream.pipeline.syncOperations.addHandlers(HTTP2FramePayloadToHTTP1ClientCodec(httpProtocol: .https),
                    HTTPResponseCollector(promise: response, maximum: 65_536, timeoutSeconds: timeoutSeconds))
            }
        }
        let stream = try await streamPromise.futureResult.get()
        permit.bind(stream)
        // The Host may answer before the whole body went (a refusal by size, scope or capability): that answer wins.
        let early = NativeEarlyAnswer()
        response.futureResult.whenSuccess { early.set($0) }
        let parent = channel
        do {
            return try await withTaskCancellationHandler {
                func current() throws { try Task.checkCancellation(); try permit.requireValid(); guard parent.isActive, stream.isActive else { throw NativeFailure.unavailable } }
                try current()
                let fields = HTTPHeaders([("host", "native.latch.invalid"), ("accept", "application/json"), ("content-type", "application/octet-stream"),
                    ("content-length", String(body.count)), ("x-latch-attachment", metadata)])
                try await stream.writeAndFlush(HTTPClientRequestPart.head(HTTPRequestHead(version: .http2, method: .POST, uri: "/link/api/attachments", headers: fields))).get()
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
                return try await response.futureResult.get()
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
    public func events(sessionId: String? = nil, lease: BodyLease? = nil, cursor: NativeEventCursor? = nil) async throws -> NativeEventStream {
        guard !closed, channel.isActive, eventCount < 2 else { throw NativeFailure.unavailable }
        if let sessionId {
            guard LinkBytes.matches(sessionId, "[A-Za-z0-9_-]{1,160}"), let lease else { throw NativeFailure.invalidRecord }
            try lease.requireValid()
        }
        eventCount += 1
        let pair = AsyncThrowingStream<NativeEvent, Error>.makeStream(bufferingPolicy: .bufferingOldest(8))
        let ready = channel.eventLoop.makePromise(of: Void.self), promise = channel.eventLoop.makePromise(of: (any Channel).self)
        var installed = false
        streams.createStreamChannel(promise: promise) { stream in
            stream.eventLoop.makeCompletedFuture {
                try stream.pipeline.syncOperations.addHandlers(HTTP2FramePayloadToHTTP1ClientCodec(httpProtocol: .https),
                    NativeEventCollector(ready: ready, continuation: pair.continuation, lease: lease))
            }
        }
        do {
            let stream = try await promise.futureResult.get()
            installed = true
            stream.closeFuture.whenComplete { _ in Task { await self.eventEnded() } }
            pair.continuation.onTermination = { _ in stream.close(promise: nil) }
            var query = sessionId.map { ["sessionId=" + $0] } ?? []
            if let cursor {
                _ = try NativeEventCursor.parse("\(cursor.epoch):\(cursor.sequence)")
                query += ["resumeEpoch=" + cursor.epoch, "resumeAfter=\(cursor.sequence)"]
            }
            let path = "/link/api/events" + (query.isEmpty ? "" : "?" + query.joined(separator: "&"))
            let fields = HTTPHeaders([("host", "native.latch.invalid"), ("accept", "text/event-stream")])
            stream.write(HTTPClientRequestPart.head(HTTPRequestHead(version: .http2, method: .GET, uri: path, headers: fields)), promise: nil)
            try await stream.writeAndFlush(HTTPClientRequestPart.end(nil)).get()
            try await ready.futureResult.get()
            return NativeEventStream(events: pair.stream, channel: stream)
        } catch {
            if !installed { eventCount = max(0, eventCount - 1) }
            pair.continuation.finish(throwing: NativeFailure.unavailable)
            throw NativeFailure.unavailable
        }
    }
    private func eventEnded() { eventCount = max(0, eventCount - 1) }
    public func isClosed() -> Bool { closed || !channel.isActive }
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
    func handlerRemoved(context: ChannelHandlerContext) { timer?.cancel(); self.context = nil }
    private func fail(_ context: ChannelHandlerContext) {
        if !settled { settled = true; timer?.cancel(); promise.fail(NativeFailure.resultUnknown) }
        context.close(promise: nil)
    }
}
