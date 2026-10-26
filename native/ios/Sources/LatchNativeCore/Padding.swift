import Foundation
import NIOCore

public enum NativePaddingWire {
    public static func cell(_ payload: Data, large: Bool = false) throws -> Data {
        let size = large ? 16_384 : 1024
        guard payload.count <= size - 3 else { throw NativeFailure.invalidRecord }
        return Data([(large ? 128 : 0) | (payload.isEmpty ? 1 : 0)]) + (try LinkBytes.integer(UInt64(payload.count), size: 2)) + payload + Data(repeating: 0, count: size - 3 - payload.count)
    }
    public struct Decoder: Sendable {
        private var pending = Data()
        public init() {}
        public mutating func feed(_ data: Data) throws -> [Data] {
            guard data.count <= 65_536 else { throw NativeFailure.invalidRecord }
            pending.append(data)
            var output: [Data] = [], offset = 0
            while pending.count - offset >= 3 {
                let kind = pending[offset], size = kind & 128 == 0 ? 1024 : 16_384,
                    length = Int(pending[offset + 1]) * 256 + Int(pending[offset + 2])
                guard kind & 127 <= 1, length <= size - 3, (kind & 1 != 0) == (length == 0) else { throw NativeFailure.invalidRecord }
                if pending.count - offset < size { break }
                guard pending[(offset + 3 + length)..<(offset + size)].allSatisfy({ $0 == 0 }) else { throw NativeFailure.invalidRecord }
                if length > 0 { output.append(Data(pending[(offset + 3)..<(offset + 3 + length)])) }
                offset += size
            }
            pending = Data(pending.dropFirst(offset))
            guard pending.count < 16_384 else { throw NativeFailure.invalidRecord }
            return output
        }
    }
}

/** Client HTTP/2 bytes, including automatic flow control, share one 250 ms clock below the entire pipeline. */
final class NativePaddingHandler: ChannelDuplexHandler, @unchecked Sendable {
    typealias InboundIn = ByteBuffer
    typealias InboundOut = ByteBuffer
    typealias OutboundIn = ByteBuffer
    typealias OutboundOut = ByteBuffer
    private struct Pending { var bytes: ByteBuffer; let promise: EventLoopPromise<Void>? }
    private var decoder = NativePaddingWire.Decoder()
    private var pending: [Pending] = []
    private var queued = 0
    private var holdUntil: UInt64 = 0
    private var largeUntil: UInt64 = 0
    private var bucket = NIODeadline.now().uptimeNanoseconds / 5_000_000_000
    private var timer: Scheduled<Void>?
    private var stopped = false
    private weak var context: ChannelHandlerContext?
    func protect() { holdUntil = max(holdUntil, milliseconds() + 15_000) }
    private func milliseconds() -> UInt64 { NIODeadline.now().uptimeNanoseconds / 1_000_000 }
    func handlerAdded(context: ChannelHandlerContext) { self.context = context; schedule(context) }
    private func schedule(_ context: ChannelHandlerContext) {
        guard !stopped else { return }
        let delay = 250 - milliseconds() % 250
        timer = context.eventLoop.scheduleTask(in: .milliseconds(Int64(delay))) { [self] in if let context = self.context { tick(context) } }
    }
    private func tick(_ context: ChannelHandlerContext) {
        guard !stopped, context.channel.isActive else { return }
        let now = milliseconds(), current = now / 5000
        if current > bucket { bucket = current; if now >= holdUntil && queued > 4096 { largeUntil = (current + 1) * 5000 } }
        // Network backpressure consumes a slot; there is no catch-up burst or unbounded timer queue.
        if context.channel.isWritable {
            let large = now < largeUntil, capacity = large ? 16_381 : 1021
            var payload = Data(), completed: [EventLoopPromise<Void>] = []
            while payload.count < capacity, !pending.isEmpty {
                let amount = min(capacity - payload.count, pending[0].bytes.readableBytes)
                if let bytes = pending[0].bytes.readBytes(length: amount) { payload.append(contentsOf: bytes); queued -= amount }
                if pending[0].bytes.readableBytes == 0 { if let promise = pending.removeFirst().promise { completed.append(promise) } }
            }
            do {
                var buffer = context.channel.allocator.buffer(capacity: large ? 16_384 : 1024)
                buffer.writeBytes(try NativePaddingWire.cell(payload, large: large))
                let written = context.eventLoop.makePromise(of: Void.self)
                let promises = completed
                written.futureResult.whenComplete { [self] result in
                    for promise in promises { promise.completeWith(result) }
                    if case .failure = result, !stopped, let context = self.context { fail(context) }
                }
                context.writeAndFlush(wrapOutboundOut(buffer), promise: written)
            } catch { for promise in completed { promise.fail(NativeFailure.unavailable) }; fail(context) }
        }
        schedule(context)
    }
    func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
        let bytes = unwrapOutboundIn(data)
        guard !stopped, bytes.readableBytes <= 65_536 - queued, pending.count < 128 else { promise?.fail(NativeFailure.unavailable); fail(context); return }
        queued += bytes.readableBytes; pending.append(Pending(bytes: bytes, promise: promise))
    }
    func flush(context: ChannelHandlerContext) { /* Only the fixed timer flushes TLS cells. */ }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        var input = unwrapInboundIn(data)
        do {
            while input.readableBytes > 0 {
                guard let bytes = input.readBytes(length: min(input.readableBytes, 65_536)) else { throw NativeFailure.invalidRecord }
                for payload in try decoder.feed(Data(bytes)) {
                    var buffer = context.channel.allocator.buffer(capacity: payload.count); buffer.writeBytes(payload)
                    context.fireChannelRead(wrapInboundOut(buffer))
                }
            }
        } catch { fail(context) }
    }
    func channelInactive(context: ChannelHandlerContext) { settle(); context.fireChannelInactive() }
    func handlerRemoved(context: ChannelHandlerContext) { settle(); self.context = nil }
    private func settle() {
        stopped = true; timer?.cancel(); timer = nil
        for entry in pending { entry.promise?.fail(NativeFailure.unavailable) }
        pending.removeAll(); queued = 0
    }
    private func fail(_ context: ChannelHandlerContext) { settle(); context.close(promise: nil) }
}
