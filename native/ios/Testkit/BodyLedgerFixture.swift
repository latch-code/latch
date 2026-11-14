import Foundation
@testable import LatchNativeCore

/** Proof-container algebra complements the real HTTP/2 blocked-storage and metadata probes. */
@MainActor func bodyLedgerFixture(_ workspace: NativeWorkspace, lease: BodyLease, id: String) async throws -> [String: Any] {
    let reading = try await workspace.beginBody(id)
    let instance = try await workspace.snapshot()["instanceId"].string ?? ""
    func state(_ revision: UInt64 = 40, _ priority: Int = 2) -> NativeBodyState {
        let value = NativeBodyState(reading: reading, instanceId: instance, authority: reading.authority, lease: lease)
        value.bodyRevision = revision; value.bodyPriority = priority
        return value
    }
    func cursor(_ ordinal: UInt64) throws -> NativeEventCursor { try .parse(instance + ":" + String(ordinal)) }

    let duringWrite = state()
    for ordinal in 1...7 { _ = try duringWrite.record(ordinal: UInt64(ordinal), cursor: cursor(UInt64(ordinal)), requirement: .body(UInt64(ordinal))) }
    let captured = duringWrite.pending.prefix(while: duringWrite.covered).last!.ordinal
    _ = try duringWrite.record(ordinal: 8, cursor: cursor(8), requirement: .body(8))
    _ = try duringWrite.record(ordinal: 9, cursor: cursor(9), requirement: .body(9))
    duringWrite.persisted(through: captured)
    let tailSurvives = duringWrite.pending.map(\.ordinal) == [8, 9]
    let tailCursor = duringWrite.pending.compactMap(\.cursor).last?.sequence == 9

    let sparse = state()
    for ordinal in 1...8 { _ = try sparse.record(ordinal: UInt64(ordinal), cursor: ordinal == 1 ? cursor(1) : nil, requirement: .body(1)) }
    _ = try sparse.record(ordinal: 9, cursor: nil, requirement: .none)
    let nilKeepsCursor = sparse.pending.count == 2 && sparse.pending[0].cursor?.sequence == 1 && sparse.pending[0].ordinal == 8
        && sparse.pending[0].cursor?.epoch.utf8.elementsEqual(instance.utf8) == true

    let barrier = state()
    _ = try barrier.record(ordinal: 1, cursor: cursor(1), requirement: .body(1))
    let notice = try barrier.record(ordinal: 2, cursor: cursor(2), requirement: .snapshot(20))
    for ordinal in 3...9 { _ = try barrier.record(ordinal: UInt64(ordinal), cursor: cursor(UInt64(ordinal)), requirement: .body(UInt64(ordinal))) }
    let barrierKept = barrier.pending.count == 4 && barrier.pending[1].id == notice.id
        && barrier.pending.prefix(while: barrier.covered).count == 1
    barrier.snapshotRevision = 20
    for ordinal in 10...14 { _ = try barrier.record(ordinal: UInt64(ordinal), cursor: cursor(UInt64(ordinal)), requirement: .body(UInt64(ordinal))) }
    let appliedNoticeKept = barrier.pending.contains { $0.id == notice.id }

    let http = state(10, 1)
    for ordinal in 1...8 { _ = try http.record(ordinal: UInt64(ordinal), cursor: cursor(UInt64(ordinal)), requirement: .body(10)) }
    var httpDoesNotCover = false
    do { _ = try http.record(ordinal: 9, cursor: cursor(9), requirement: .body(10)) }
    catch { httpDoesNotCover = (error as? NativeFailure) == .eventOverflow && http.pending.count == 8 }
    http.bodyPriority = 2
    _ = try http.record(ordinal: 9, cursor: cursor(9), requirement: .body(10))
    let streamCovers = http.pending.count == 2

    let metadata = state()
    for ordinal in 1...8 { _ = try metadata.record(ordinal: UInt64(ordinal), cursor: cursor(UInt64(ordinal)), requirement: .snapshot(20)) }
    var metadataBounded = false
    do { _ = try metadata.record(ordinal: 9, cursor: cursor(9), requirement: .body(1)) }
    catch { metadataBounded = (error as? NativeFailure) == .eventOverflow && metadata.pending.count == 8 }

    let oldOrigin = NativeEventOrigin()
    duringWrite.authority.bindStream(oldOrigin)
    let evidence = try duringWrite.authority.issue(lease: lease, origin: oldOrigin)
    duringWrite.resetStream()
    let resetClearsProof = duringWrite.pending.isEmpty && duringWrite.cursor == 0 && duringWrite.ordinal == 0
        && !duringWrite.authority.accepts(evidence)
    await workspace.invalidateContentWindow(lease)
    var closedRefused = false
    do { _ = try duringWrite.authority.issue(lease: lease) } catch { closedRefused = (error as? NativeFailure) == .expired }
    await workspace.closeOpening()
    return ["tailSurvivesOldWrite": tailSurvives, "tailCursorKept": tailCursor, "nilKeepsLastCursor": nilKeepsCursor,
        "metadataBarrierKept": barrierKept, "appliedNoticeIdentityKept": appliedNoticeKept, "httpDoesNotCoverSameRevisionStream": httpDoesNotCover,
        "streamReceiptCovers": streamCovers, "metadataStillBounded": metadataBounded, "resetClearsProof": resetClearsProof, "closedRefused": closedRefused]
}
