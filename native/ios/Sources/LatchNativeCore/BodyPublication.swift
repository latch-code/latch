import Foundation

/** A lifecycle stamp, not network provenance. Workspace must issue it only for a validated read or its own stream. */
final class NativeBodyEvidence: Sendable {
    let id = UUID()
    let authority: NativeBodyAuthority
    let epoch: UUID
    let lease: BodyLease
    let origin: NativeEventOrigin?
    fileprivate init(authority: NativeBodyAuthority, epoch: UUID, lease: BodyLease, origin: NativeEventOrigin?) {
        self.authority = authority; self.epoch = epoch; self.lease = lease; self.origin = origin
    }
}

/** Serializes a synchronous publication with invalidation, never with network or storage work. */
final class NativeBodyAuthority: @unchecked Sendable {
    private let lock = NSLock()
    private var epoch = UUID()
    private var active = true
    private var origin: NativeEventOrigin?

    func issue(lease: BodyLease, origin: NativeEventOrigin? = nil) throws -> NativeBodyEvidence {
        lock.lock(); defer { lock.unlock() }
        guard active, origin == nil || origin === self.origin else { throw NativeFailure.expired }
        try lease.requireValid()
        return NativeBodyEvidence(authority: self, epoch: epoch, lease: lease, origin: origin)
    }

    func bindStream(_ origin: NativeEventOrigin?) {
        lock.lock(); defer { lock.unlock() }
        self.origin = origin
    }

    /** Replacing a transport invalidates its old updates; the publication's revision floor is separate. */
    func replaceConnection() {
        lock.lock(); defer { lock.unlock() }
        epoch = UUID(); origin = nil
    }

    func invalidate() {
        lock.lock(); defer { lock.unlock() }
        active = false; epoch = UUID(); origin = nil
    }

    func accepts(_ evidence: NativeBodyEvidence) -> Bool {
        whileCurrent(evidence) { true } == true
    }

    fileprivate func whileCurrent<Value>(_ evidence: NativeBodyEvidence, _ operation: () -> Value?) -> Value? {
        lock.lock(); defer { lock.unlock() }
        guard active, evidence.authority === self, evidence.epoch == epoch, evidence.lease.valid,
              evidence.origin == nil || evidence.origin === origin else { return nil }
        return operation()
    }
}

/** Only Workspace constructs updates. A pure TaskStreamProjection candidate cannot be submitted directly to a publication. */
public struct NativeBodyUpdate: Sendable {
    public let detail: NativeJSON
    public let snapshot: NativeJSON?
    let evidence: NativeBodyEvidence
    fileprivate let stream: NativeTaskCandidate?

    init(http detail: NativeJSON, snapshot: NativeJSON? = nil, evidence: NativeBodyEvidence) {
        self.detail = detail; self.snapshot = snapshot; self.evidence = evidence; self.stream = nil
    }

    init(stream candidate: NativeTaskCandidate, evidence: NativeBodyEvidence) {
        self.detail = candidate.detail; self.snapshot = nil; self.evidence = evidence; self.stream = candidate
    }
}

/** The consumer accepted one exact update. This does not prove a painted frame, grant a lease, or acknowledge a cursor. */
public struct NativeBodyApplied: Sendable {
    let evidence: NativeBodyEvidence
    let body: Bool
    let snapshot: Bool
    fileprivate init(_ evidence: NativeBodyEvidence, body: Bool, snapshot: Bool) {
        self.evidence = evidence; self.body = body; self.snapshot = snapshot
    }
}

/** Only the components that can be published now; a newer snapshot need not replace an already newer body. */
public struct NativeBodyValue: Sendable {
    public let detail: NativeJSON?
    public let snapshot: NativeJSON?
    fileprivate init(detail: NativeJSON?, snapshot: NativeJSON?) { self.detail = detail; self.snapshot = snapshot }
}

/**
 * Publication and the App's own selection check/assignment share one synchronous MainActor call. The Workspace later
 * checks this receipt against its bounded pending ledger before changing applied revisions or native cursors.
 */
@MainActor public final class NativeBodyPublication {
    private let authority: NativeBodyAuthority
    private let instanceId: String
    private var gate: NativeTaskPublicationGate
    private var snapshotRevision: UInt64?
    private var applying = false

    init(instanceId: String, sessionId: String, authority: NativeBodyAuthority) {
        self.authority = authority
        self.instanceId = instanceId
        self.gate = NativeTaskPublicationGate(instanceId: instanceId, sessionId: sessionId)
    }

    public func apply(_ update: NativeBodyUpdate, to publish: (NativeBodyValue) -> Bool) -> NativeBodyApplied? {
        guard !applying, update.evidence.authority === authority else { return nil }
        applying = true; defer { applying = false }

        // JSON bounds and source ordering may visit the body. Do them before taking the lifecycle lock, with no await.
        // A refused App assignment must not commit the proposed revision/source floor.
        var next = gate
        let ticket = next.capture()
        let accepted: NativeJSON?
        var snapshot: NativeJSON?, nextSnapshotRevision: UInt64?
        do {
            if let candidate = update.stream { accepted = next.acceptStream(candidate, ticket: ticket) }
            else { accepted = try next.acceptHTTP(update.detail.encoded(), ticket: ticket) }
            if let value = update.snapshot {
                let bounded = try NativeJSON.decode(value.encoded())
                guard let instance = bounded["instanceId"].string, instance.utf8.elementsEqual(instanceId.utf8),
                      let revision = bounded["revision"].integer else { return nil }
                if snapshotRevision == nil || revision > snapshotRevision! { snapshot = bounded; nextSnapshotRevision = revision }
            }
        } catch { return nil }
        guard accepted != nil || snapshot != nil else { return nil }

        return authority.whileCurrent(update.evidence) {
            guard publish(NativeBodyValue(detail: accepted, snapshot: snapshot)) else { return nil }
            gate = next
            if let nextSnapshotRevision { snapshotRevision = nextSnapshotRevision }
            return NativeBodyApplied(update.evidence, body: accepted != nil, snapshot: snapshot != nil)
        }
    }
}
