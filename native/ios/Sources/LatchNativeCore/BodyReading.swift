import Foundation

/** One selected body, owned by one Workspace. Its constructor and identity never come from network JSON. */
public struct NativeBodyReading: Sendable {
    public let publication: NativeBodyPublication
    let id: UUID
    let owner: UUID
    let sessionId: String
    init(publication: NativeBodyPublication, owner: UUID, sessionId: String) {
        self.publication = publication; self.owner = owner; self.sessionId = sessionId; self.id = UUID()
    }
}

/** A real event that needs a metadata refresh; neither its cursor nor its required revision is supplied by the App. */
public struct NativeBodyNotice: Sendable {
    public let event: NativeEvent
    let reading: UUID
    let id: UUID
    init(event: NativeEvent, reading: UUID, id: UUID) { self.event = event; self.reading = reading; self.id = id }
}

public enum NativeBodyEventResult: Sendable {
    case update(NativeBodyUpdate), notice(NativeBodyNotice), hostState(NativeEvent), ignore, repair
}

enum NativeBodyRequirement {
    case body(UInt64), snapshot(UInt64), none
}

struct NativeBodyPosition {
    let id = UUID()
    let ordinal: UInt64
    let cursor: NativeEventCursor?
    let requirement: NativeBodyRequirement
}

struct NativeBodyOffer {
    let evidence: NativeBodyEvidence
    let bodyRevision: UInt64
    let priority: Int
    let snapshotRevision: UInt64?
    var applied = false
}

/** Workspace-actor confined. The eight-slot ledger retains only proof metadata, never eight copies of the history. */
final class NativeBodyState {
    static let pendingLimit = 8
    let reading: NativeBodyReading
    let instanceId: String
    let authority: NativeBodyAuthority
    let lease: BodyLease
    var expiry: Task<Void, Never>?
    var shadow: NativeTaskStreamProjection
    var stream: NativeWorkspaceEvents?
    var opening: Task<NativeWorkspaceEvents, Error>?
    var streamAttempt = UUID()
    var origin: NativeEventOrigin?
    var ordinal: UInt64 = 0
    var cursor: UInt64 = 0
    var pending: [NativeBodyPosition] = []
    var offers: [UUID: NativeBodyOffer] = [:]
    var latest: NativeBodyUpdate?
    var bodyRevision: UInt64?
    var bodyPriority = 0
    var snapshotRevision: UInt64?
    var repaired = false

    init(reading: NativeBodyReading, instanceId: String, authority: NativeBodyAuthority, lease: BodyLease) {
        self.reading = reading; self.instanceId = instanceId; self.authority = authority; self.lease = lease
        self.shadow = NativeTaskStreamProjection(instanceId: instanceId, sessionId: reading.sessionId)
    }

    func resetStream() {
        streamAttempt = UUID(); opening?.cancel(); opening = nil
        authority.bindStream(nil); shadow.reset(); stream = nil; origin = nil; ordinal = 0; cursor = 0
        pending.removeAll(); offers = offers.filter { $0.value.evidence.origin == nil }; latest = nil
    }

    func withdraw() {
        authority.invalidate(); expiry?.cancel(); expiry = nil; resetStream(); offers.removeAll()
    }

    func record(ordinal: UInt64, cursor: NativeEventCursor?, requirement: NativeBodyRequirement) throws -> NativeBodyPosition {
        guard pending.count < Self.pendingLimit else { throw NativeFailure.eventOverflow }
        let position = NativeBodyPosition(ordinal: ordinal, cursor: cursor, requirement: requirement)
        pending.append(position)
        return position
    }

    func offer(_ update: NativeBodyUpdate, priority: Int) throws -> NativeBodyUpdate {
        pruneOffers()
        guard offers.count < Self.pendingLimit, let revision = update.detail["sync"]["revision"].integer else { throw NativeFailure.eventOverflow }
        offers[update.evidence.id] = NativeBodyOffer(evidence: update.evidence, bodyRevision: revision, priority: priority,
            snapshotRevision: update.snapshot?["revision"].integer)
        latest = update
        return update
    }

    func covered(_ position: NativeBodyPosition) -> Bool {
        switch position.requirement {
        case let .body(required):
            guard let bodyRevision else { return false }
            return bodyRevision > required || bodyRevision == required && bodyPriority >= 2
        case let .snapshot(required): return snapshotRevision.map { $0 >= required } ?? false
        case .none: return true
        }
    }

    func pruneOffers() {
        offers = offers.filter { _, value in
            !value.applied && (bodyRevision == nil || value.bodyRevision > bodyRevision!
                || value.bodyRevision == bodyRevision && value.priority > bodyPriority
                || value.snapshotRevision.map { $0 > (snapshotRevision ?? 0) } == true)
        }
    }
}
