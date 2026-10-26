import Foundation

/** Bounds owned bytes and generated cover. Network.framework does not expose a flush receipt for framer-generated copies. */
public struct NativeRelayOuterPadding: Sendable {
    public static let tickMs: UInt64 = 40, durationMs: UInt64 = 3000
    public static let maximumQueueBytes = 65_536, maximumTickBytes = 32_768
    public static let maximumGeneratedBytes = 75 * maximumTickBytes
    private var frames: [Data] = []
    private var queuedBytes = 0
    private var lastGrid: UInt64 = 0
    private var generatedBytes = 0
    public init() {}
    public var pending: Bool { !frames.isEmpty }
    public var bufferedBytes: Int { queuedBytes }
    public mutating func enqueue(_ frame: Data) throws {
        guard frame.count <= Self.maximumTickBytes - 16, queuedBytes + frame.count <= Self.maximumQueueBytes, frames.count < 256 else { throw NativeFailure.unavailable }
        frames.append(frame); queuedBytes += frame.count
    }
    public mutating func batch(elapsedMs: UInt64) throws -> Data? {
        let cover = elapsedMs <= Self.durationMs
        if cover {
            let grid = elapsedMs / Self.tickMs
            guard grid > lastGrid, grid <= 75 else { return nil }; lastGrid = grid
        } else if frames.isEmpty { return nil }
        var output = Data(), taken = 0
        while taken < 7, let next = frames.first, output.count + next.count <= Self.maximumTickBytes - 16 {
            frames.removeFirst(); output += next; queuedBytes -= next.count; taken += 1
        }
        if cover {
            let mask = try LinkBytes.random(4)
            var target = max(4096, ((output.count + 7 + 4095) / 4096) * 4096), padding: Data?
            while padding == nil {
                for header in [2, 4] {
                    let count = target - output.count - header - 5
                    if count < 0 || count > 16_384 { continue }
                    let frame = try RelayWire.frame(opcode: 2, payload: Data([1]) + LinkBytes.random(count), mask: mask)
                    if frame.count == target - output.count { padding = frame; break }
                }
                if padding == nil { target += 4096 }
                guard target <= Self.maximumTickBytes else { throw NativeFailure.invalidRecord }
            }
            output += padding!
            guard generatedBytes + output.count <= Self.maximumGeneratedBytes else { throw NativeFailure.unavailable }
            generatedBytes += output.count
        }
        return output
    }
    public mutating func clear() { frames.removeAll(); queuedBytes = 0 }
}

final class RelayOuterSlot: @unchecked Sendable {
    private let lock = NSLock()
    private var held = false
    private final class Pool: @unchecked Sendable {
        static let shared = Pool()
        private let lock = NSLock()
        private var count = 0
        func acquire() throws { lock.lock(); defer { lock.unlock() }; guard count < 8 else { throw NativeFailure.unavailable }; count += 1 }
        func release() { lock.lock(); count -= 1; lock.unlock() }
    }
    init() throws { try Pool.shared.acquire(); held = true }
    func release() { lock.lock(); defer { lock.unlock() }; if held { held = false; Pool.shared.release() } }
    deinit { release() }
}
