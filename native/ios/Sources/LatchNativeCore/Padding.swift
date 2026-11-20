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

/**
 * The phone's cell schedule, with time passed in. Today's 250 ms grid on every connection; on a bulk connection, 3.5 s
 * after the padding layer started (past both outer legs' cover), whole large cells as soon as data is queued, capped by a
 * token bucket, and once quiet the bulk total padded to its size bucket. Mirrors `PADDING` and `PaddingClock` in link-wire.
 */
public struct NativePaddingPacer: Sendable {
    public static let large = 16_384, small = 1024, gridMs: UInt64 = 250
    public static let bulkDelayMs: UInt64 = 3500, bulkRate = 12 * 1024 * 1024, bulkBurst = 4 * 1024 * 1024
    public static let bulkQuietMs: UInt64 = 1000, bucketBase = 262_144
    /** The smallest size bucket at or above `bytes`: 256 KiB, then each ×1.25 rounded up to whole large cells. */
    public static func bucket(_ bytes: Int) -> Int {
        var bucket = bucketBase
        while bucket < bytes { bucket = (bucket * 5 + 4 * large - 1) / (4 * large) * large }
        return bucket
    }
    private let opened: UInt64
    private var holdUntil: UInt64 = 0, largeUntil: UInt64 = 0, modeBucket: UInt64
    public private(set) var bulk = false
    private var tokens = 0.0, refilled: UInt64 = 0, busyAt: UInt64 = 0
    public private(set) var bulkBytes = 0
    public init(openedMs: UInt64) { opened = openedMs; modeBucket = openedMs / 5000 }
    public mutating func protect(nowMs: UInt64) { holdUntil = max(holdUntil, nowMs + 15_000) }
    public mutating func enableBulk(nowMs: UInt64) {
        guard !bulk else { return }
        bulk = true; tokens = Double(Self.bulkBurst); refilled = nowMs; busyAt = nowMs
    }
    public func unclocked(nowMs: UInt64) -> Bool { bulk && nowMs >= opened + Self.bulkDelayMs }
    /** The size of the cell a 250 ms tick sends; the clocked schedule only. */
    public mutating func tick(nowMs: UInt64, queued: Int) -> Int {
        if bulk, queued > 0 { busyAt = nowMs }
        let current = nowMs / 5000
        if current > modeBucket { modeBucket = current; if nowMs >= holdUntil && queued > 4096 { largeUntil = (current + 1) * 5000 } }
        return nowMs < largeUntil ? Self.large : Self.small
    }
    /** Unclocked: a large cell now, or nothing and how long until it is worth asking again. */
    public mutating func next(nowMs: UInt64, queued: Int) -> (size: Int, waitMs: UInt64) {
        refill(nowMs)
        if queued > 0 { busyAt = nowMs }
        let quietAt = busyAt + Self.bulkQuietMs, owed = queued == 0 && nowMs >= quietAt && bulkBytes < Self.bucket(bulkBytes)
        if queued == 0 && !owed { return (0, nowMs >= quietAt ? Self.gridMs : max(1, min(Self.gridMs, quietAt - nowMs))) }
        if tokens < Double(Self.large) { return (0, max(1, UInt64(((Double(Self.large) - tokens) * 1000 / Double(Self.bulkRate)).rounded(.up)))) }
        return (Self.large, 0)
    }
    /** A cell went out: a bulk large cell spends tokens and counts towards the size bucket. */
    public mutating func record(size: Int, nowMs: UInt64) {
        guard bulk, size == Self.large else { return }
        refill(nowMs); tokens -= Double(size); bulkBytes += size
    }
    private mutating func refill(_ nowMs: UInt64) {
        tokens = min(Double(Self.bulkBurst), tokens + Double(nowMs - min(nowMs, refilled)) * Double(Self.bulkRate) / 1000); refilled = max(refilled, nowMs)
    }
}

/**
 * Client HTTP/2 bytes, including automatic flow control, share one 250 ms clock below the entire pipeline. A bulk
 * connection's queue may hold the Host's 4 MiB connection window plus 64 KiB: NIO never writes more DATA than that window.
 */
final class NativePaddingHandler: ChannelDuplexHandler, @unchecked Sendable {
    typealias InboundIn = ByteBuffer
    typealias InboundOut = ByteBuffer
    typealias OutboundIn = ByteBuffer
    typealias OutboundOut = ByteBuffer
    static let bulkQueue = 4 * 1024 * 1024 + 65_536
    private struct Pending { var bytes: ByteBuffer; let promise: EventLoopPromise<Void>? }
    private var decoder = NativePaddingWire.Decoder()
    private var pending: [Pending] = []
    private var queued = 0
    private var limit = 65_536, entries = 128
    private var pacer: NativePaddingPacer
    private var permitted: (@Sendable () -> Bool)?
    private var timer: Scheduled<Void>?
    private var wakeup: Scheduled<Void>?
    private var inboundAt: UInt64
    private var stopped = false
    private weak var context: ChannelHandlerContext?
    init() { let now = NIODeadline.now().uptimeNanoseconds / 1_000_000; pacer = NativePaddingPacer(openedMs: now); inboundAt = now }
    func protect() { pacer.protect(nowMs: milliseconds()) }
    /** Activated by the Host's answer; before every unclocked cell `permitted` is checked, and a refusal drops the queue. */
    func bulk(permitted: @escaping @Sendable () -> Bool) {
        self.permitted = permitted; limit = Self.bulkQueue; entries = 1024
        pacer.enableBulk(nowMs: milliseconds())
    }
    func inboundIdleMs() -> UInt64 { milliseconds() - min(milliseconds(), inboundAt) }
    private func milliseconds() -> UInt64 { NIODeadline.now().uptimeNanoseconds / 1_000_000 }
    func handlerAdded(context: ChannelHandlerContext) { self.context = context; schedule(context) }
    private func schedule(_ context: ChannelHandlerContext) {
        guard !stopped else { return }
        let delay = 250 - milliseconds() % 250
        timer = context.eventLoop.scheduleTask(in: .milliseconds(Int64(delay))) { [self] in if let context = self.context { tick(context) } }
    }
    private func tick(_ context: ChannelHandlerContext) {
        guard !stopped, context.channel.isActive else { return }
        let now = milliseconds()
        if pacer.unclocked(nowMs: now) { drain(context); schedule(context); return }
        // Network backpressure consumes a slot; there is no catch-up burst or unbounded timer queue.
        let size = pacer.tick(nowMs: now, queued: queued)
        if context.channel.isWritable { send(context, size: size, now: now) }
        schedule(context)
    }
    private func send(_ context: ChannelHandlerContext, size: Int, now: UInt64) {
        let large = size == NativePaddingPacer.large, capacity = size - 3
        var payload = Data(), completed: [EventLoopPromise<Void>] = []
        while payload.count < capacity, !pending.isEmpty {
            let amount = min(capacity - payload.count, pending[0].bytes.readableBytes)
            if let bytes = pending[0].bytes.readBytes(length: amount) { payload.append(contentsOf: bytes); queued -= amount }
            if pending[0].bytes.readableBytes == 0 { if let promise = pending.removeFirst().promise { completed.append(promise) } }
        }
        do {
            var buffer = context.channel.allocator.buffer(capacity: size)
            buffer.writeBytes(try NativePaddingWire.cell(payload, large: large))
            let written = context.eventLoop.makePromise(of: Void.self)
            let promises = completed
            written.futureResult.whenComplete { [self] result in
                for promise in promises { promise.completeWith(result) }
                if case .failure = result, !stopped, let context = self.context { fail(context) }
            }
            pacer.record(size: size, nowMs: now)
            context.writeAndFlush(wrapOutboundOut(buffer), promise: written)
        } catch { for promise in completed { promise.fail(NativeFailure.unavailable) }; fail(context) }
    }
    /** Unclocked: cells while TLS accepts them and tokens last; a later wakeup for tokens or the quiet padding. */
    private func drain(_ context: ChannelHandlerContext) {
        guard !stopped, context.channel.isActive else { return }
        wakeup?.cancel(); wakeup = nil
        while context.channel.isWritable {
            let now = milliseconds(), next = pacer.next(nowMs: now, queued: queued)
            guard next.size > 0 else {
                if next.waitMs < NativePaddingPacer.gridMs {
                    wakeup = context.eventLoop.scheduleTask(in: .milliseconds(Int64(next.waitMs))) { [self] in if let context = self.context { drain(context) } }
                }
                return
            }
            guard permitted?() ?? true else { fail(context); return }
            send(context, size: next.size, now: now)
            if stopped { return }
        }
    }
    func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
        let bytes = unwrapOutboundIn(data)
        guard !stopped, bytes.readableBytes <= limit - queued, pending.count < entries else { promise?.fail(NativeFailure.unavailable); fail(context); return }
        queued += bytes.readableBytes; pending.append(Pending(bytes: bytes, promise: promise))
    }
    /** Clocked, only the fixed timer flushes TLS cells; unclocked, a flush sends at once. */
    func flush(context: ChannelHandlerContext) { if pacer.unclocked(nowMs: milliseconds()) { drain(context) } }
    func channelWritabilityChanged(context: ChannelHandlerContext) {
        if context.channel.isWritable, pacer.unclocked(nowMs: milliseconds()) { drain(context) }
        context.fireChannelWritabilityChanged()
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        var input = unwrapInboundIn(data)
        inboundAt = milliseconds()
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
        stopped = true; timer?.cancel(); timer = nil; wakeup?.cancel(); wakeup = nil
        for entry in pending { entry.promise?.fail(NativeFailure.unavailable) }
        pending.removeAll(); queued = 0
    }
    private func fail(_ context: ChannelHandlerContext) { settle(); context.close(promise: nil) }
}
