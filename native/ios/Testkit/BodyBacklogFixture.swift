import Foundation
import LatchNativeCore

private final class FixtureVaultPause: @unchecked Sendable {
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    func hasEntered() -> Bool { entered.wait(timeout: .now()) == .success }
}

private extension EncryptedVault {
    // This method exists only in Testkit. Blocking this owned actor models pending storage work, not an App callback.
    func fixturePause(_ pause: FixtureVaultPause) -> Bool {
        pause.entered.signal()
        return pause.release.wait(timeout: .now() + 5) == .timedOut
    }
}

/** Two distinct reasons why applied body proofs can remain behind one pending operation. */
@MainActor func bodyBacklogFixture(_ workspace: NativeWorkspace, vault: EncryptedVault, id: String, mode: String) async throws -> [String: Any] {
    let reading = try await workspace.beginBody(id), stream = try await workspace.events(for: reading, incremental: true)
    var iterator = stream.events.makeAsyncIterator(), held: NativeBodyUpdate?, diagnosis: NativeBodyRepair?
    var refresh: Task<NativeBodyUpdate, Error>?, acknowledgement: Task<Void, Error>?, storage: Task<Bool, Never>?
    var updates = 0, applied = 0
    let pause = FixtureVaultPause()
    defer { pause.release.signal() }
    for _ in 0..<9 {
        guard let event = try await iterator.next() else { throw NativeFailure.invalidRecord }
        switch try await workspace.receive(event, from: stream, for: reading) {
        case let .update(update):
            held = update; updates += 1
            if mode == "metadata-covered" {
                guard let receipt = reading.publication.apply(update, to: { _ in true }) else { throw NativeFailure.invalidRecord }
                try await workspace.applied(receipt); applied += 1
            } else if updates == 7 {
                storage = Task { await vault.fixturePause(pause) }
                var entered = false
                for _ in 0..<2000 {
                    if pause.hasEntered() { entered = true; break }
                    try await Task.sleep(for: .milliseconds(1))
                }
                guard entered, let receipt = reading.publication.apply(update, to: { _ in true }) else { throw NativeFailure.invalidRecord }
                acknowledgement = Task { try await workspace.applied(receipt) }
                applied += 1
            }
        case let .notice(notice):
            guard mode == "metadata-covered", refresh == nil else { throw NativeFailure.invalidRecord }
            refresh = Task { try await workspace.refreshBody(for: reading, after: notice) }
        case let .repair(value): diagnosis = value
        case .ignore, .hostState: throw NativeFailure.invalidRecord
        }
        if diagnosis != nil { break }
    }
    pause.release.signal(); let storageTimedOut = await storage?.value ?? false
    var receiptRefused = false
    do { try await acknowledgement?.value } catch { receiptRefused = true }
    let beforeMetadata = try await vault.metadata(name: "event-cursors")
    if diagnosis != nil {
        refresh?.cancel(); _ = try? await refresh?.value
    } else {
        if mode == "vault-covered", let held, let receipt = reading.publication.apply(held, to: { _ in true }) {
            try await workspace.applied(receipt); applied += 1
        }
        if let refresh {
            let value = try await refresh.value
            guard let receipt = reading.publication.apply(value, to: { $0.detail == nil && $0.snapshot != nil }) else { throw NativeFailure.invalidRecord }
            try await workspace.applied(receipt)
        }
    }
    let after = try await vault.metadata(name: "event-cursors").map { try NativeJSON.decode($0) }
    await stream.cancel(); await workspace.endBody(reading); await workspace.closeOpening()
    return ["storageTimedOut": storageTimedOut, "repaired": diagnosis != nil, "updates": updates, "applied": applied, "receiptRefused": receiptRefused,
        "cursorHeldBeforeMetadata": beforeMetadata == nil, "cursor": after?.array.first?["cursor"]["sequence"].integer ?? 0,
        "cause": diagnosis?.cause.rawValue ?? "none", "pending": diagnosis?.pending ?? 0, "covered": diagnosis?.covered ?? 0,
        "prefix": diagnosis?.coveredPrefixCount ?? 0, "firstUncovered": diagnosis?.firstUncoveredKind.rawValue ?? "none", "offers": diagnosis?.offers ?? 0]
}
