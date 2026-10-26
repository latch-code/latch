import Foundation
import NIOCore
import NIOHTTP1

public struct NativeEvent: Sendable {
    public let type: String
    public let data: Data
    public let cursor: NativeEventCursor?
}
public struct NativeEventCursor: Codable, Sendable, Equatable {
    public let epoch: String
    public let sequence: UInt64
    public static func parse(_ text: String) throws -> NativeEventCursor {
        let pieces = text.split(separator: ":", omittingEmptySubsequences: false)
        guard pieces.count == 2, LinkBytes.matches(String(pieces[0]), "[A-Za-z0-9_-]{1,128}"),
              LinkBytes.matches(String(pieces[1]), "0|[1-9][0-9]{0,15}"), let value = UInt64(pieces[1]),
              value <= LinkBytes.maximumInteger else { throw NativeFailure.invalidRecord }
        return NativeEventCursor(epoch: String(pieces[0]), sequence: value)
    }
}
public struct NativeEventStream: Sendable {
    public let events: AsyncThrowingStream<NativeEvent, Error>
    let channel: any Channel
    public func cancel() async { try? await channel.close().get() }
}

/** Byte-based SSE boundaries preserve split UTF-8 scalars and the Host's distinct applied-event cursor. */
public struct NativeEventParser: Sendable {
    private var pending = Data()
    private var data = Data()
    private var type = "message"
    private var bytes = 0
    private var lines = 0
    private var cursor: NativeEventCursor?
    private var control: String?
    public init() {}
    public mutating func feed(_ chunk: Data) throws -> [NativeEvent] {
        guard chunk.count <= 1_048_576, pending.count + chunk.count <= 2_097_152 else { throw NativeFailure.invalidRecord }
        pending.append(chunk)
        var events: [NativeEvent] = []
        while let end = pending.firstIndex(of: 10) {
            var line = Data(pending[..<end]); pending = Data(pending[pending.index(after: end)...])
            if line.last == 13 { line.removeLast() }
            guard line.count <= 1_048_576 else { throw NativeFailure.invalidRecord }
            bytes += line.count + 1
            lines += 1
            guard bytes <= 1_048_576, lines <= 128, let text = String(data: line, encoding: .utf8) else { throw NativeFailure.invalidRecord }
            if line.isEmpty {
                if !data.isEmpty {
                    data.removeLast()
                    events.append(NativeEvent(type: type, data: data, cursor: cursor))
                    guard events.count <= 1024 else { throw NativeFailure.invalidRecord }
                }
                else if let control, cursor != nil { events.append(NativeEvent(type: control, data: Data(), cursor: cursor)) }
                type = "message"; data = Data(); bytes = 0; lines = 0; cursor = nil; control = nil
                continue
            }
            if text.hasPrefix(":") {
                let value = text.dropFirst().trimmingCharacters(in: .whitespaces)
                if value == "heartbeat" || value == "resumed" { control = value }
                continue
            }
            let pieces = text.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            let field = String(pieces[0]); var value = pieces.count == 2 ? String(pieces[1]) : ""
            if value.hasPrefix(" ") { value.removeFirst() }
            if field == "event" {
                guard LinkBytes.matches(value, "[A-Za-z0-9_-]{1,64}") else { throw NativeFailure.invalidRecord }; type = value
            } else if field == "data" { data.append(Data(value.utf8)); data.append(10) }
            else if field == "id" { cursor = try NativeEventCursor.parse(value) }
        }
        guard pending.count <= 1_048_576 else { throw NativeFailure.invalidRecord }
        return events
    }
}

final class NativeEventCollector: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = HTTPClientResponsePart
    private let ready: EventLoopPromise<Void>
    private let continuation: AsyncThrowingStream<NativeEvent, Error>.Continuation
    private let lease: BodyLease?
    private var parser = NativeEventParser()
    private var opened = false
    private var finished = false
    private var timer: Scheduled<Void>?
    private weak var context: ChannelHandlerContext?
    init(ready: EventLoopPromise<Void>, continuation: AsyncThrowingStream<NativeEvent, Error>.Continuation, lease: BodyLease?) {
        self.ready = ready; self.continuation = continuation; self.lease = lease
    }
    func handlerAdded(context: ChannelHandlerContext) { self.context = context; arm(context) }
    private func arm(_ context: ChannelHandlerContext) {
        timer?.cancel()
        timer = context.eventLoop.scheduleTask(in: .seconds(45)) { [self] in if let context = self.context { fail(context) } }
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        guard !finished else { return }
        do {
            try lease?.requireValid()
            arm(context)
            switch unwrapInboundIn(data) {
            case let .head(head):
                if head.status.code < 200 { return }
                guard !opened, head.status.code == 200, head.headers.count <= 64,
                      head.headers["content-type"].count == 1,
                      head.headers["content-type"].first?.lowercased().hasPrefix("text/event-stream") == true else { throw NativeFailure.expired }
                opened = true; ready.succeed(())
            case var .body(buffer):
                guard opened, let bytes = buffer.readBytes(length: buffer.readableBytes) else { throw NativeFailure.invalidRecord }
                for event in try parser.feed(Data(bytes)) {
                    try lease?.requireValid()
                    switch continuation.yield(event) {
                    case .enqueued: break
                    case .dropped: throw NativeFailure.eventOverflow
                    case .terminated: throw NativeFailure.unavailable
                    @unknown default: throw NativeFailure.unavailable
                    }
                }
            case .end: throw NativeFailure.unavailable
            }
        } catch { fail(context, error: (error as? NativeFailure) ?? .unavailable) }
    }
    func channelInactive(context: ChannelHandlerContext) { fail(context); context.fireChannelInactive() }
    func errorCaught(context: ChannelHandlerContext, error: Error) { fail(context) }
    func handlerRemoved(context: ChannelHandlerContext) { timer?.cancel(); self.context = nil }
    private func fail(_ context: ChannelHandlerContext, error: NativeFailure = .unavailable) {
        guard !finished else { return }; finished = true; timer?.cancel()
        if !opened { ready.fail(NativeFailure.expired) }
        continuation.finish(throwing: error)
        context.close(promise: nil)
    }
}
