import AppKit
import Darwin
import Foundation

// This test-only process never sends clipboard data back to Vitest. Saved formats stay in this process.
private var stopping: Int32 = 0
private func stop(_ number: Int32) { stopping = number }
private let markerPrefix = "latch-public-clipboard-"
private let maxBytes = 64 * 1024 * 1024

private struct Command: Decodable {
    let id: Int
    let op: String
    let marker: String?
    let milliseconds: Int?
}
private struct Reply: Encodable {
    let id: Int
    let ok: Bool
    var reason: String? = nil
    var remoteSeen: Bool? = nil
    var restored: Bool? = nil
    var originalMatches: Bool? = nil
    var externalMatches: Bool? = nil
    var promiseIntact: Bool? = nil
    var empty: Bool? = nil
    var waitingForGui: Bool? = nil
}
private func emit(_ reply: Reply) {
    if let data = try? JSONEncoder().encode(reply) {
        let line = data + Data([10])
        line.withUnsafeBytes { bytes in
            // A dead controller must not crash the in-memory holder through a broken stdout pipe.
            if let base = bytes.baseAddress { _ = write(STDOUT_FILENO, base, bytes.count) }
        }
    }
}

private final class ClipboardLease {
    let board: NSPasteboard
    let fixture: Bool
    let testGuiProbe: String?
    var original: [[(NSPasteboard.PasteboardType, Data)]]? = nil
    var expectedCount = 0
    var lastMarker: String? = nil
    var expectedRemote: String? = nil
    var markers = Set<String>()
    var remoteSeen = false
    var deadline = Double.infinity
    var failure: String? = nil
    var wrote = false
    var fixtureFailWrite = false

    init(board: NSPasteboard, fixture: Bool, testGuiProbe: String?) {
        self.board = board; self.fixture = fixture; self.testGuiProbe = testGuiProbe
    }

    func guiClosed() -> Bool {
        if fixture {
            guard let path = testGuiProbe else { return true }
            return (try? String(contentsOfFile: path, encoding: .utf8)) == "closed"
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        process.arguments = ["-x", "Simulator|DeviceHub"]
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return false }
        let until = ProcessInfo.processInfo.systemUptime + 1
        while process.isRunning && ProcessInfo.processInfo.systemUptime < until { Thread.sleep(forTimeInterval: 0.01) }
        if process.isRunning { kill(process.processIdentifier, SIGKILL); process.waitUntilExit(); return false }
        return process.terminationReason == .exit && process.terminationStatus == 1
    }

    func capture() -> Bool {
        guard original == nil, failure == nil else { return false }
        let before = board.changeCount
        guard let items = board.pasteboardItems else { return (board.types ?? []).isEmpty ? captureEmpty(before) : false }
        guard items.count <= 32 else { return false }
        let promised = Set(NSFilePromiseReceiver.readableDraggedTypes)
        var size = 0
        var saved: [[(NSPasteboard.PasteboardType, Data)]] = []
        for item in items {
            guard item.types.count <= 64 else { return false }
            // A promised file needs its live owner's callback; a byte copy could not restore that behavior.
            guard !item.types.contains(where: { promised.contains($0.rawValue) }) else { return false }
            var formats: [(NSPasteboard.PasteboardType, Data)] = []
            for type in item.types {
                guard let value = item.data(forType: type) else { return false }
                size += value.count
                guard size <= maxBytes, board.changeCount == before else { return false }
                formats.append((type, value))
            }
            saved.append(formats)
        }
        guard board.changeCount == before else { return false }
        original = saved; expectedCount = before
        return true
    }
    private func captureEmpty(_ before: Int) -> Bool {
        guard board.changeCount == before else { return false }
        original = []; expectedCount = before; return true
    }

    func tick() {
        guard original != nil, failure == nil else { return }
        if ProcessInfo.processInfo.systemUptime >= deadline { failure = "expired"; return }
        guard board.changeCount != expectedCount else { return }
        // Only one previously announced public transfer may change the clipboard during a positive control.
        if let remote = expectedRemote, board.string(forType: .string) == remote {
            expectedCount = board.changeCount; lastMarker = remote; remoteSeen = true
        } else if let value = board.string(forType: .string), markers.contains(value) {
            expectedCount = board.changeCount; lastMarker = value; failure = "unexpected-test-transfer"
        } else { failure = "external-change" }
    }

    func writeMarker(_ marker: String) -> Bool {
        tick()
        guard original != nil, failure == nil else { return false }
        // ON and OFF controls use exactly the same types/options; local-only flags must not fake a negative control.
        expectedCount = board.clearContents(); wrote = true; lastMarker = nil
        if fixture && fixtureFailWrite { fixtureFailWrite = false; failure = "write-failed"; return false }
        guard board.setString(marker, forType: .string) else { failure = "write-failed"; return false }
        markers.insert(marker)
        expectedCount = board.changeCount; lastMarker = marker; expectedRemote = nil; remoteSeen = false
        return true
    }

    func restore() -> Bool? {
        guard let saved = original else { return true }
        // Never replace something copied by the person while the test was running.
        guard failure != "external-change", board.changeCount == expectedCount else {
            original = nil; failure = "external-change"; return false
        }
        if let marker = lastMarker, board.string(forType: .string) != marker {
            original = nil; failure = "external-change"; return false
        }
        guard wrote else { original = nil; return true }
        // Enforced in this process on every exit path, including a dead controller. OFF is never a bypass here.
        guard guiClosed() else { return nil }
        let items = saved.map { formats -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, value) in formats { item.setData(value, forType: type) }
            return item
        }
        guard board.changeCount == expectedCount else { original = nil; failure = "external-change"; return false }
        guard guiClosed() else { return nil }
        // Restoring the person's formats is local to this Mac, never a new Universal Clipboard publication.
        board.prepareForNewContents(with: [.currentHostOnly])
        let restored = items.isEmpty || board.writeObjects(items)
        expectedCount = board.changeCount; lastMarker = nil
        if restored { original = nil; return true }
        return nil
    }

    func process(_ command: Command) -> Reply {
        tick()
        if command.op == "restore" {
            let result = restore()
            return Reply(id: command.id, ok: true, restored: result, waitingForGui: result == nil)
        }
        if fixture, command.op.hasPrefix("fixture-") { return fixtureCommand(command) }
        if let failure { return Reply(id: command.id, ok: false, reason: failure) }
        switch command.op {
        case "capture":
            guard let milliseconds = command.milliseconds, (1...180_000).contains(milliseconds), capture() else {
                return Reply(id: command.id, ok: false, reason: "capture-refused")
            }
            deadline = ProcessInfo.processInfo.systemUptime + Double(milliseconds) / 1000
        case "write", "expect-remote", "track":
            guard let marker = command.marker, marker.hasPrefix(markerPrefix), marker.utf8.count <= 128,
                  marker.dropFirst(markerPrefix.count).allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }),
                  original != nil, markers.count < 32 else { return Reply(id: command.id, ok: false, reason: "invalid-marker") }
            markers.insert(marker)
            if command.op == "write" {
                guard writeMarker(marker) else { return Reply(id: command.id, ok: false, reason: failure ?? "write-refused") }
            } else if command.op == "expect-remote" { expectedRemote = marker; remoteSeen = false }
        case "check": break
        default: return Reply(id: command.id, ok: false, reason: "unknown-operation")
        }
        return Reply(id: command.id, ok: true, remoteSeen: remoteSeen)
    }

    // Named-board fixtures prove exact multi-item/binary restoration without touching the system clipboard.
    private func fixtureItems() -> [NSPasteboardItem] {
        let one = NSPasteboardItem()
        one.setString("fixture original", forType: .string)
        one.setData(Data([0, 255, 1, 128, 2]), forType: NSPasteboard.PasteboardType("dev.latch.test.binary"))
        let two = NSPasteboardItem()
        two.setData(Data("{\\rtf1 fixture}".utf8), forType: .rtf)
        return [one, two]
    }
    private func fixtureCommand(_ command: Command) -> Reply {
        switch command.op {
        case "fixture-seed": board.clearContents(); _ = board.writeObjects(fixtureItems())
        case "fixture-external": board.clearContents(); _ = board.setString("fixture external copy", forType: .string)
        case "fixture-empty": board.clearContents()
        case "fixture-fail-write": fixtureFailWrite = true
        case "fixture-promise":
            let item = NSPasteboardItem()
            item.setString("fixture promise", forType: .string)
            item.setData(Data(), forType: NSPasteboard.PasteboardType(NSFilePromiseReceiver.readableDraggedTypes[0]))
            board.clearContents(); _ = board.writeObjects([item])
        case "fixture-remote":
            guard let marker = command.marker, marker.hasPrefix(markerPrefix), marker.count <= 128 else {
                return Reply(id: command.id, ok: false, reason: "invalid-marker")
            }
            board.clearContents(); _ = board.setString(marker, forType: .string)
        case "fixture-inspect":
            let probe = NSPasteboard.withUniqueName()
            _ = probe.writeObjects(fixtureItems())
            defer { probe.releaseGlobally() }
            let actual = board.pasteboardItems ?? [], wanted = probe.pasteboardItems ?? []
            let same = actual.count == wanted.count && zip(actual, wanted).allSatisfy { left, right in
                Set(left.types) == Set(right.types) && right.types.allSatisfy { left.data(forType: $0) == right.data(forType: $0) }
            }
            return Reply(id: command.id, ok: true, originalMatches: same,
                         externalMatches: board.string(forType: .string) == "fixture external copy",
                         promiseIntact: board.string(forType: .string) == "fixture promise"
                            && (board.types ?? []).contains(NSPasteboard.PasteboardType(NSFilePromiseReceiver.readableDraggedTypes[0])),
                         empty: actual.isEmpty && (board.types ?? []).isEmpty)
        case "fixture-destroy": board.releaseGlobally()
        case "fixture-marker-present":
            return Reply(id: command.id, ok: true, remoteSeen: board.string(forType: .string)?.hasPrefix(markerPrefix) == true)
        default: return Reply(id: command.id, ok: false, reason: "unknown-operation")
        }
        return Reply(id: command.id, ok: true)
    }
}

@main private enum Main {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        let board: NSPasteboard
        let fixture: Bool
        let probe: String?
        if args == ["--general"] { board = .general; fixture = false; probe = nil }
        else if (args.count == 2 || args.count == 4 && args[2] == "--gui-probe"),
                args[0] == "--test-board", UUID(uuidString: args[1]) != nil {
            board = NSPasteboard(name: NSPasteboard.Name("dev.latch.test.clipboard." + args[1])); fixture = true
            probe = args.count == 4 ? args[3] : nil
        } else { emit(Reply(id: 0, ok: false, reason: "invalid-mode")); return }
        let lease = ClipboardLease(board: board, fixture: fixture, testGuiProbe: probe)
        signal(SIGTERM, stop); signal(SIGINT, stop); signal(SIGPIPE, SIG_IGN)
        var buffer = Data()
        func finish(_ reason: String? = nil) {
            var reported = false
            while true {
                if let result = lease.restore() {
                    let why = lease.failure ?? reason
                    emit(Reply(id: 0, ok: why == nil, reason: why, restored: result)); return
                }
                if !reported { emit(Reply(id: 0, ok: true, waitingForGui: true)); reported = true }
                // No disk fallback and no timeout that restores into an unverified open GUI.
                Thread.sleep(forTimeInterval: 0.2)
            }
        }
        while stopping == 0 {
            lease.tick()
            if let failure = lease.failure {
                emit(Reply(id: 0, ok: false, reason: failure))
                finish(failure); return
            }
            var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
            if poll(&descriptor, 1, 20) < 0 { if errno == EINTR { continue }; break }
            guard descriptor.revents != 0 else { continue }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = read(STDIN_FILENO, &bytes, bytes.count)
            guard count > 0 else { break }
            buffer.append(contentsOf: bytes.prefix(count))
            if buffer.count > 8192 { finish("input-limit"); return }
            while let end = buffer.firstIndex(of: 10) {
                let line = buffer.prefix(upTo: end); buffer.removeSubrange(...end)
                guard let command = try? JSONDecoder().decode(Command.self, from: line), command.id > 0 else {
                    finish("invalid-command"); return
                }
                emit(lease.process(command))
            }
        }
        finish(stopping == 0 ? nil : "interrupted")
    }
}
