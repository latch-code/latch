import Foundation
import NIOCore
import NIOHTTP1

/** Cancellation invalidates this transfer before the workspace can install another path epoch. */
final class NativeFileReadPermit: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var stream: (any Channel)?
    private let lease: BodyLease
    private let cancelUnbound: @Sendable () -> Void
    init(lease: BodyLease, cancelUnbound: @escaping @Sendable () -> Void) { self.lease = lease; self.cancelUnbound = cancelUnbound }
    func requireValid() throws {
        lock.lock(); let stopped = cancelled; lock.unlock()
        guard !stopped else { throw CancellationError() }; try lease.requireValid()
    }
    func bind(_ stream: any Channel) {
        lock.lock(); self.stream = stream; let stopped = cancelled; lock.unlock()
        if stopped { stream.close(promise: nil) }
    }
    func cancel() {
        lock.lock(); let previous = cancelled; cancelled = true; let stream = self.stream; lock.unlock()
        guard !previous else { return }
        if let stream { stream.close(promise: nil) } else { cancelUnbound() }
    }
    func finish() { lock.lock(); stream = nil; cancelled = true; lock.unlock() }
}

/** One fixed range, bounded to one MiB. No byte or progress is published before its versioned response head passes. */
final class NativeFileResponseCollector: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = HTTPClientResponsePart
    private let promise: EventLoopPromise<Data>
    private let permit: NativeFileReadPermit
    private let etag: String
    private let range: String
    private let count: Int
    private let progress: (@Sendable (Int, Int) -> Void)?
    private var body = Data()
    private var accepted = false
    private var settled = false
    init(promise: EventLoopPromise<Data>, permit: NativeFileReadPermit, etag: String, offset: Int, count: Int, total: Int,
        progress: (@Sendable (Int, Int) -> Void)?) {
        self.promise = promise; self.permit = permit; self.etag = etag; self.count = count; self.progress = progress
        range = "bytes \(offset)-\(offset + count - 1)/\(total)"
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        guard !settled else { return }
        do {
            try permit.requireValid()
            switch unwrapInboundIn(data) {
            case let .head(head):
                if head.status.code < 200 { return }
                guard !accepted, head.headers.count <= 64 else { throw NativeFailure.invalidRecord }
                if head.status.code == 401 || head.status.code == 403 { throw NativeFailure.forbidden }
                if head.status.code == 409 || head.status.code == 412 { throw NativeFailure.contextChanged }
                guard head.status.code == 206, head.headers["etag"] == [etag], head.headers["content-range"] == [range],
                      head.headers["content-length"] == [String(count)] else { throw NativeFailure.invalidRecord }
                accepted = true
            case var .body(buffer):
                guard accepted, buffer.readableBytes <= count - body.count else { throw NativeFailure.invalidRecord }
                while buffer.readableBytes > 0 {
                    try permit.requireValid()
                    guard let bytes = buffer.readBytes(length: min(65_536, buffer.readableBytes)) else { throw NativeFailure.invalidRecord }
                    body.append(contentsOf: bytes); progress?(body.count, count)
                }
            case .end:
                guard accepted, body.count == count else { throw NativeFailure.invalidRecord }
                try permit.requireValid(); settled = true; promise.succeed(body); context.close(promise: nil)
            }
        } catch { fail(context, error) }
    }
    func channelInactive(context: ChannelHandlerContext) { if !settled { fail(context, NativeFailure.resultUnknown) }; context.fireChannelInactive() }
    func errorCaught(context: ChannelHandlerContext, error: Error) { fail(context, NativeFailure.resultUnknown) }
    func handlerRemoved(context: ChannelHandlerContext) {
        body.removeAll()
        if !settled { settled = true; promise.fail(NativeFailure.resultUnknown) }
    }
    private func fail(_ context: ChannelHandlerContext, _ error: Error) {
        if !settled { settled = true; body.removeAll(); promise.fail(error) }
        context.close(promise: nil)
    }
}
