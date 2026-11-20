import LatchNativeCore
import NIOCore
import NIOEmbedded
import NIOHTTP2

/** The child fails to initialize during teardown, before a response collector can take ownership of its promise. */
func http2StreamOpeningFixture() throws -> [String: Any] {
    let channel = EmbeddedChannel()
    let loop = channel.embeddedEventLoop
    let streams = HTTP2StreamMultiplexer(mode: .client, channel: channel, inboundStreamInitializer: nil)
    try channel.pipeline.syncOperations.addHandler(streams)
    try channel.connect(to: SocketAddress(ipAddress: "127.0.0.1", port: 9)).wait()
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }

    let failed = openNativeHTTP2Stream(on: loop, using: streams.sendableView, response: Int.self) { child, _ in
        child.eventLoop.makeFailedFuture(ChannelError.ioOnClosedChannel)
    }
    let answers = NIOLoopBoundBox((opened: false, reply: false), eventLoop: loop)
    failed.stream.whenFailure { error in answers.value.opened = (error as? ChannelError) == .ioOnClosedChannel }
    failed.response.whenFailure { error in answers.value.reply = (error as? ChannelError) == .ioOnClosedChannel }
    loop.run()
    // An actual request awaits the child first. On failure it unwinds without ever observing the reply.
    func awaitOpeningFirst() throws {
        let request = openNativeHTTP2Stream(on: loop, using: streams.sendableView, response: Int.self) { child, _ in
            child.eventLoop.makeFailedFuture(ChannelError.ioOnClosedChannel)
        }
        loop.run()
        _ = try request.stream.wait()
        _ = try request.response.wait()
    }
    do { try awaitOpeningFirst(); throw NativeFailure.invalidRecord }
    catch ChannelError.ioOnClosedChannel {}

    // A failed child must not close the parent, and a later successful child still answers exactly once.
    let next = openNativeHTTP2Stream(on: loop, using: streams.sendableView, response: Int.self) { child, response in
        response.succeed(42)
        return child.eventLoop.makeSucceededVoidFuture()
    }
    loop.run()
    let opened = try next.stream.wait()
    let response = try next.response.wait()
    opened.close(promise: nil)
    loop.run()
    return ["openFailed": answers.value.opened, "responseFailed": answers.value.reply, "parentActive": channel.isActive,
        "laterResponse": response]
}
