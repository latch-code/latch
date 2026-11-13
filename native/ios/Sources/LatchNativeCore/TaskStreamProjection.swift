import Foundation

/** A validated value, not a body lease or evidence that an App applied a native event cursor. */
public struct NativeTaskCandidate: Sendable, Equatable {
    public let detail: NativeJSON
    public let instanceId: String
    public let sessionId: String
    public let revision: UInt64
    fileprivate init(detail: NativeJSON, instanceId: String, sessionId: String, revision: UInt64) {
        self.detail = detail; self.instanceId = instanceId; self.sessionId = sessionId; self.revision = revision
    }
}

public enum NativeTaskStreamResult: Sendable, Equatable {
    case candidate(NativeTaskCandidate), ignore, repair
}

private enum TaskStreamCheck {
    static let appendLimit = 65_536
    static let textLimit = 16_777_216
    // Swift String equality is canonically equivalent; wire identities are exact scalar sequences, as in Web's ===.
    static func same(_ left: String?, _ right: String?) -> Bool {
        guard let left, let right else { return false }; return left.utf8.elementsEqual(right.utf8)
    }
    static func id(_ value: NativeJSON) -> String? {
        guard let text = value.string, !text.isEmpty, text.utf16.count <= 256 else { return nil }; return text
    }
    static func keys(_ value: NativeJSON, _ names: Set<String>) -> Bool {
        guard case let .object(fields) = value else { return false }; return Set(fields.keys) == names
    }
    static func time(_ value: NativeJSON) -> Bool {
        guard let text = value.string, text.utf16.count <= 64,
              LinkBytes.matches(text, "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})") else { return false }
        // Host clocks are ISO timestamps. This intentionally uses the native ISO parser, not JS's legacy date forms.
        return PhoneTime.parse(value) != nil
    }
    static func optionalTime(_ value: NativeJSON) -> Bool { value == .null || time(value) }
    static func detail(_ value: NativeJSON, sessionId: String) -> Bool {
        guard case .object = value, case .object = value["summary"],
              same(value["summary"]["id"].string, sessionId), case .array = value["messages"],
              case .array = value["approvals"], value["liveText"].string != nil else { return false }
        return true
    }
    static func bounded(_ value: NativeJSON) -> Bool {
        // Keep every NativeJSON bound, including object width after adding sync/clock fields. This round trip visits
        // the whole detail; this correctness checkpoint does not claim constant CPU cost for a native delta.
        guard let data = try? value.encoded() else { return false }
        return (try? NativeJSON.decode(data)) != nil
    }
}

private struct TaskStreamStamp: Sendable {
    let subscriptionId: String
    let sequence: UInt64
    init?(_ value: NativeJSON) {
        guard TaskStreamCheck.keys(value, ["protocol", "subscriptionId", "stateSeq"]),
              value["protocol"].string == "delta-v1", let id = value["subscriptionId"].string,
              LinkBytes.matches(id, "[A-Za-z0-9_-]{8,128}"), let sequence = value["stateSeq"].integer, sequence > 0 else { return nil }
        self.subscriptionId = id; self.sequence = sequence
    }
}

private struct TaskTextAppend: Sendable {
    let offset: Int
    let text: String
    let bytes: Int
    init?(_ value: NativeJSON) {
        guard TaskStreamCheck.keys(value, ["offset", "append"]), let offset = value["offset"].integer,
              offset <= UInt64(TaskStreamCheck.textLimit), let text = value["append"].string else { return nil }
        let bytes = text.utf8.count
        guard bytes <= TaskStreamCheck.appendLimit, Int(offset) + bytes <= TaskStreamCheck.textLimit else { return nil }
        self.offset = Int(offset); self.text = text; self.bytes = bytes
    }
}

private struct TaskDelta: Sendable {
    let value: NativeJSON
    let instanceId: String
    let sessionId: String
    let revision: UInt64
    let stamp: TaskStreamStamp
    let base: UInt64
    let runId: String
    let messageId: String
    let text: TaskTextAppend
    let reasoning: TaskTextAppend?
    init?(_ value: NativeJSON) {
        guard TaskStreamCheck.keys(value, ["type", "instanceId", "sessionId", "revision", "hostTime", "stream", "baseSeq",
            "runId", "liveMessageId", "text", "reasoning", "cursor", "updatedAt", "lastOutputAt", "live"]),
              value["type"].string == "task-delta", let instance = TaskStreamCheck.id(value["instanceId"]),
              let session = TaskStreamCheck.id(value["sessionId"]), let revision = value["revision"].integer,
              let stamp = TaskStreamStamp(value["stream"]), let base = value["baseSeq"].integer,
              base > 0, base < LinkBytes.maximumInteger, stamp.sequence == base + 1,
              let run = TaskStreamCheck.id(value["runId"]), let message = TaskStreamCheck.id(value["liveMessageId"]),
              let text = TaskTextAppend(value["text"]), value["cursor"].integer != nil,
              TaskStreamCheck.time(value["hostTime"]), TaskStreamCheck.time(value["updatedAt"]),
              TaskStreamCheck.optionalTime(value["lastOutputAt"]) else { return nil }
        let reasoning: TaskTextAppend?
        if value["reasoning"] == .null { reasoning = nil }
        else { guard let parsed = TaskTextAppend(value["reasoning"]) else { return nil }; reasoning = parsed }
        guard text.bytes + (reasoning?.bytes ?? 0) <= TaskStreamCheck.appendLimit else { return nil }
        if value["live"] != .null {
            guard TaskStreamCheck.keys(value["live"], ["lastEventAt", "lastOutputAt"]),
                  TaskStreamCheck.time(value["live"]["lastEventAt"]),
                  TaskStreamCheck.optionalTime(value["live"]["lastOutputAt"]) else { return nil }
        }
        self.value = value; self.instanceId = instance; self.sessionId = session; self.revision = revision
        self.stamp = stamp; self.base = base; self.runId = run; self.messageId = message; self.text = text; self.reasoning = reasoning
    }
}

/** One network subscription's immutable shadow. HTTP has no entry point here; reset on a new connection or lost lease. */
public struct NativeTaskStreamProjection: Sendable {
    private struct Baseline: Sendable {
        let candidate: NativeTaskCandidate
        let stamp: TaskStreamStamp
        let textBytes: Int
        let reasoningBytes: Int?
    }
    private let instanceId: String
    private let sessionId: String
    private var baseline: Baseline?
    public init(instanceId: String, sessionId: String) { self.instanceId = instanceId; self.sessionId = sessionId }
    public mutating func reset() { baseline = nil }

    public mutating func receive(type: String, data: Data) -> NativeTaskStreamResult {
        guard type == "task-state" || type == "task-delta" else { return .ignore }
        // JSONDecoder rejects invalid UTF-8 and unpaired surrogate escapes; no replacement character becomes a baseline.
        guard let value = try? NativeJSON.decode(data) else { return .repair }
        if type == "task-state" { return full(value) }
        guard let delta = TaskDelta(value) else { return .repair }
        guard TaskStreamCheck.same(delta.instanceId, instanceId), TaskStreamCheck.same(delta.sessionId, sessionId) else { return .ignore }
        guard let previous = baseline, TaskStreamCheck.same(delta.stamp.subscriptionId, previous.stamp.subscriptionId) else { return .repair }
        if delta.stamp.sequence <= previous.stamp.sequence { return .ignore }
        let old = previous.candidate.detail
        guard delta.base == previous.stamp.sequence, delta.revision >= previous.candidate.revision,
              old["summary"]["status"].string == "running", TaskStreamCheck.same(old["summary"]["runId"].string, delta.runId),
              TaskStreamCheck.same(old["liveMessageId"].string, delta.messageId), previous.textBytes == delta.text.offset else { return .repair }
        if let reasoning = delta.reasoning {
            guard old["liveReasoning"].string != nil, previous.reasoningBytes == reasoning.offset else { return .repair }
        } else if old.object["liveReasoning"] != nil { return .repair }
        if delta.value["live"] == .null {
            guard old["summary"].object["live"] == nil else { return .repair }
        } else {
            guard case .object = old["summary"]["live"],
                  TaskStreamCheck.same(old["summary"]["live"]["runId"].string, delta.runId) else { return .repair }
        }

        var detail = old.object, summary = old["summary"].object
        summary["updatedAt"] = delta.value["updatedAt"]
        if delta.value["live"] != .null {
            var live = old["summary"]["live"].object
            live["lastEventAt"] = delta.value["live"]["lastEventAt"]
            live.removeValue(forKey: "lastOutputAt")
            if delta.value["live"]["lastOutputAt"] != .null { live["lastOutputAt"] = delta.value["live"]["lastOutputAt"] }
            summary["live"] = .object(live)
        }
        detail["summary"] = .object(summary)
        detail["liveText"] = .string((old["liveText"].string ?? "") + delta.text.text)
        if let reasoning = delta.reasoning { detail["liveReasoning"] = .string((old["liveReasoning"].string ?? "") + reasoning.text) }
        detail["cursor"] = delta.value["cursor"]
        detail.removeValue(forKey: "lastOutputAt")
        if delta.value["lastOutputAt"] != .null { detail["lastOutputAt"] = delta.value["lastOutputAt"] }
        var sync = old["sync"].object
        sync["instanceId"] = .string(instanceId); sync["revision"] = .number(Double(delta.revision)); sync["hostTime"] = delta.value["hostTime"]
        detail["sync"] = .object(sync)
        let next = NativeJSON.object(detail)
        guard TaskStreamCheck.bounded(next) else { return .repair }
        let candidate = NativeTaskCandidate(detail: next, instanceId: instanceId, sessionId: sessionId, revision: delta.revision)
        baseline = Baseline(candidate: candidate, stamp: delta.stamp, textBytes: previous.textBytes + delta.text.bytes,
            reasoningBytes: delta.reasoning.map { (previous.reasoningBytes ?? 0) + $0.bytes })
        return .candidate(candidate)
    }

    private mutating func full(_ value: NativeJSON) -> NativeTaskStreamResult {
        guard value["type"].string == "task-state", let instance = value["instanceId"].string,
              let session = value["sessionId"].string, let revision = value["revision"].integer,
              TaskStreamCheck.detail(value["detail"], sessionId: session) else { return .repair }
        guard TaskStreamCheck.same(instance, instanceId), TaskStreamCheck.same(session, sessionId) else { return .ignore }
        var detail = value["detail"].object
        var sync: [String: NativeJSON] = ["instanceId": .string(instance), "revision": .number(Double(revision))]
        if let time = value["hostTime"].string { sync["hostTime"] = .string(time) }
        detail["sync"] = .object(sync)
        let next = NativeJSON.object(detail)
        guard TaskStreamCheck.bounded(next) else { return .repair }
        let candidate = NativeTaskCandidate(detail: next, instanceId: instance, sessionId: session, revision: revision)
        guard let acknowledged = value.object["stream"] else { reset(); return .candidate(candidate) }
        guard let stamp = TaskStreamStamp(acknowledged) else { return .repair }
        if let previous = baseline {
            guard TaskStreamCheck.same(stamp.subscriptionId, previous.stamp.subscriptionId) else { return .repair }
            if stamp.sequence <= previous.stamp.sequence { return .ignore }
            guard revision >= previous.candidate.revision else { return .repair }
        }
        baseline = Baseline(candidate: candidate, stamp: stamp, textBytes: next["liveText"].string!.utf8.count,
            reasoningBytes: next["liveReasoning"].string.map { $0.utf8.count })
        return .candidate(candidate)
    }
}

/** A local ordering ticket only. NativeWorkspace must still bind transport/selection/lease and prove cursor consumption. */
public struct NativeTaskPublicationTicket: Sendable {
    fileprivate let generation: UUID
}

/** Revision/source ordering for pure candidates. It neither acknowledges native cursors nor changes Workspace fetched revisions. */
public struct NativeTaskPublicationGate: Sendable {
    private var generation = UUID()
    private var instanceId: String
    private var sessionId: String
    private var revision: UInt64?
    private var priority = 0
    public init(instanceId: String, sessionId: String) { self.instanceId = instanceId; self.sessionId = sessionId }
    public func capture() -> NativeTaskPublicationTicket { NativeTaskPublicationTicket(generation: generation) }
    public mutating func bind(instanceId: String, sessionId: String) {
        if TaskStreamCheck.same(self.instanceId, instanceId), TaskStreamCheck.same(self.sessionId, sessionId) { return }
        self.instanceId = instanceId; self.sessionId = sessionId; generation = UUID(); revision = nil; priority = 0
    }
    /** A replacement connection invalidates old readers/responses without lowering the already published revision. */
    public mutating func replaceConnection() { generation = UUID() }
    public mutating func acceptStream(_ value: NativeTaskCandidate, ticket: NativeTaskPublicationTicket) -> NativeJSON? {
        accept(value, priority: 2, ticket: ticket) ? value.detail : nil
    }
    public mutating func acceptHTTP(_ data: Data, ticket: NativeTaskPublicationTicket) throws -> NativeJSON? {
        guard ticket.generation == generation else { return nil }
        let value = try NativeJSON.decode(data)
        guard let session = value["summary"]["id"].string, TaskStreamCheck.detail(value, sessionId: session),
              let instance = value["sync"]["instanceId"].string,
              let next = value["sync"]["revision"].integer, TaskStreamCheck.bounded(value) else { throw NativeFailure.invalidRecord }
        let candidate = NativeTaskCandidate(detail: value, instanceId: instance, sessionId: session, revision: next)
        return accept(candidate, priority: 1, ticket: ticket) ? value : nil
    }
    private mutating func accept(_ value: NativeTaskCandidate, priority nextPriority: Int, ticket: NativeTaskPublicationTicket) -> Bool {
        guard ticket.generation == generation, TaskStreamCheck.same(value.instanceId, instanceId),
              TaskStreamCheck.same(value.sessionId, sessionId) else { return false }
        if let revision {
            guard value.revision >= revision else { return false }
            if value.revision == revision, nextPriority <= priority { return false }
        }
        revision = value.revision; priority = nextPriority; return true
    }
}
