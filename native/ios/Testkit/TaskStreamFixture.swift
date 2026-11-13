import Foundation
import LatchNativeCore

/** The same public fixture events used by Web. No network, body lease or native cursor is fabricated here. */
func taskStreamFixture(_ input: [String: Any]) throws -> [String: Any] {
    guard let strings = input["strings"] as? [[String: Any]], strings.count <= 128,
          let groups = input["streams"] as? [[String: Any]], groups.count <= 128 else { throw NativeFailure.invalidRecord }
    let counts: [Any] = try strings.map { vector in
        let data: Data
        if let raw = vector["rawJSON"] as? String { data = Data(raw.utf8) }
        else if let text = vector["text"] as? String { data = try JSONEncoder().encode(text) }
        else { throw NativeFailure.invalidRecord }
        guard let decoded = try? NativeJSON.decode(data), let text = decoded.string else { return NSNull() }
        return text.utf8.count
    }
    func plain(_ value: NativeJSON) throws -> Any {
        try JSONSerialization.jsonObject(with: value.encoded(), options: .fragmentsAllowed)
    }
    var results: [[String: Any]] = []
    for group in groups {
        guard let name = group["name"] as? String, let instance = group["instanceId"] as? String,
              let session = group["sessionId"] as? String, let actions = group["actions"] as? [[String: Any]], actions.count <= 128 else {
            throw NativeFailure.invalidRecord
        }
        var shadow = NativeTaskStreamProjection(instanceId: instance, sessionId: session)
        var gate = NativeTaskPublicationGate(instanceId: instance, sessionId: session)
        var tickets: [String: NativeTaskPublicationTicket] = [:], candidates: [String: NativeTaskCandidate] = [:]
        var displayed: NativeJSON?, first: NativeJSON?, frozen: Data?, steps: [[String: Any]] = []
        for action in actions {
            let ticket: NativeTaskPublicationTicket
            if let name = action["ticket"] as? String {
                guard let found = tickets[name] else { throw NativeFailure.invalidRecord }; ticket = found
            } else { ticket = gate.capture() }
            var result: [String: Any]
            if let name = action["capture"] as? String {
                tickets[name] = gate.capture(); result = ["kind": "capture"]
            } else if let binding = action["bind"] as? [String: String], let host = binding["instanceId"], let session = binding["sessionId"] {
                gate.bind(instanceId: host, sessionId: session)
                shadow = NativeTaskStreamProjection(instanceId: host, sessionId: session)
                displayed = nil; result = ["kind": "bind"]
            } else if action["reset"] as? Bool == true {
                shadow.reset(); result = ["kind": "reset"]
            } else if let http = action["http"] as? [String: Any] {
                let next = try gate.acceptHTTP(JSONSerialization.data(withJSONObject: http), ticket: ticket)
                if let next { displayed = next }; result = ["kind": "http", "published": next != nil]
            } else if let saved = action["publishCandidate"] as? String {
                guard let candidate = candidates[saved] else { throw NativeFailure.invalidRecord }
                let next = gate.acceptStream(candidate, ticket: ticket)
                if let next { displayed = next }; result = ["kind": "publish", "published": next != nil]
            } else {
                let data: Data, type: String
                if let raw = action["raw"] as? String, let kind = action["event"] as? String { data = Data(raw.utf8); type = kind }
                else if let frame = action["frame"] as? [String: Any], let kind = (action["event"] ?? frame["type"]) as? String {
                    data = try JSONSerialization.data(withJSONObject: frame); type = kind
                } else { throw NativeFailure.invalidRecord }
                switch shadow.receive(type: type, data: data) {
                case .ignore: result = ["kind": "ignore"]
                case .repair: result = ["kind": "repair"]
                case let .candidate(candidate):
                    let value = candidate.detail
                    if first == nil { first = value; frozen = try value.encoded() }
                    if let name = action["saveCandidate"] as? String { candidates[name] = candidate }
                    let next = gate.acceptStream(candidate, ticket: ticket)
                    if let next { displayed = next }
                    result = ["kind": "detail", "detail": try plain(value), "published": next != nil,
                        "reasoningPresent": value.object["liveReasoning"] != nil, "outputPresent": value.object["lastOutputAt"] != nil,
                        "livePresent": value["summary"].object["live"] != nil,
                        "liveOutputPresent": value["summary"]["live"].object["lastOutputAt"] != nil]
                }
            }
            result["displayedText"] = displayed?["liveText"].string as Any? ?? NSNull()
            if let first, let frozen, try first.encoded() != frozen { throw NativeFailure.invalidRecord }
            steps.append(result)
        }
        results.append(["name": name, "steps": steps])
    }
    return ["strings": counts, "streams": results, "priorValuesUnchanged": true]
}

/** Native-only bounds and connection tickets; the input describes small public fixtures, never an actual session. */
func taskStreamBoundaryFixture(_ input: [String: Any]) throws -> [String: Any] {
    guard let frame = input["frame"] as? [String: Any], let delta = input["delta"] as? [String: Any],
          let original = frame["detail"] as? [String: Any] else { throw NativeFailure.invalidRecord }
    func bytes(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    func kind(_ value: NativeTaskStreamResult) -> String {
        switch value { case .candidate: "detail"; case .ignore: "ignore"; case .repair: "repair" }
    }
    var initial = frame, body = original
    body["padding"] = String(repeating: "a", count: 1_040_000); initial["detail"] = body
    var shadow = NativeTaskStreamProjection(instanceId: "host-a", sessionId: "session-a")
    guard case let .candidate(first) = shadow.receive(type: "task-state", data: try bytes(initial)) else { throw NativeFailure.invalidRecord }
    let retained = try first.detail.encoded()
    var bigger = delta
    bigger["text"] = ["offset": 7, "append": String(repeating: "x", count: 16_000)]
    let growth = shadow.receive(type: "task-delta", data: try bytes(bigger))
    let recovery = shadow.receive(type: "task-delta", data: try bytes(delta))
    guard try first.detail.encoded() == retained else { throw NativeFailure.invalidRecord }
    body["padding"] = String(repeating: "a", count: 1_048_576); initial["detail"] = body
    let oversized = try bytes(initial)
    var empty = NativeTaskStreamProjection(instanceId: "host-a", sessionId: "session-a")
    let inputLimit = empty.receive(type: "task-state", data: oversized)
    var wide = original
    for index in 0..<(512 - original.count) { wide["future-\(index)"] = true }
    var wideFrame = frame; wideFrame["detail"] = wide
    var wideShadow = NativeTaskStreamProjection(instanceId: "host-a", sessionId: "session-a")
    let objectLimit = wideShadow.receive(type: "task-state", data: try bytes(wideFrame))
    var excessive = delta
    excessive["text"] = ["offset": 7, "append": String(repeating: "a", count: 40_000)]
    excessive["reasoning"] = ["offset": 3, "append": String(repeating: "b", count: 40_000)]
    var suffixShadow = NativeTaskStreamProjection(instanceId: "host-a", sessionId: "session-a")
    _ = suffixShadow.receive(type: "task-state", data: try bytes(frame))
    let suffixLimit = suffixShadow.receive(type: "task-delta", data: try bytes(excessive))

    var gate = NativeTaskPublicationGate(instanceId: "host-a", sessionId: "session-a")
    let old = gate.capture()
    guard gate.acceptStream(first, ticket: old) != nil else { throw NativeFailure.invalidRecord }
    gate.replaceConnection()
    let stale = gate.acceptStream(first, ticket: old) == nil
    let staleHTTP = try gate.acceptHTTP(Data("not JSON".utf8), ticket: old) == nil
    let fresh = gate.capture()
    var http = first.detail.object
    http["sync"] = .object(["instanceId": .string("host-a"), "revision": .number(9)])
    let floor = try gate.acceptHTTP(NativeJSON.object(http).encoded(), ticket: fresh) == nil
    http["sync"] = .object(["instanceId": .string("host-a"), "revision": .number(20)])
    let ahead = try gate.acceptHTTP(NativeJSON.object(http).encoded(), ticket: fresh) != nil
    var otherFrame = frame; otherFrame["instanceId"] = "host-b"; otherFrame["revision"] = 100
    var other = NativeTaskStreamProjection(instanceId: "host-b", sessionId: "session-a")
    guard case let .candidate(otherCandidate) = other.receive(type: "task-state", data: try bytes(otherFrame)) else { throw NativeFailure.invalidRecord }
    let otherHost = gate.acceptStream(otherCandidate, ticket: fresh) == nil
    let invalidUTF8 = (try? NativeJSON.decode(Data([0x22, 0xff, 0x22]))) == nil
    let surrogateUTF8 = (try? NativeJSON.decode(Data([0x22, 0xed, 0xa0, 0x80, 0x22]))) == nil
    return ["initialBytes": retained.count, "oversizedInputBytes": oversized.count,
        "inputLimit": kind(inputLimit), "candidateGrowth": kind(growth), "validAfterRefusal": kind(recovery),
        "objectWidthLimit": kind(objectLimit), "combinedSuffixLimit": kind(suffixLimit),
        "priorValueUnchanged": true, "staleConnectionRejected": stale, "staleHTTPRejectedBeforeDecode": staleHTTP, "connectionKeepsRevisionFloor": floor,
        "newerHTTPAccepted": ahead, "otherInstanceRejected": otherHost, "invalidUTF8Rejected": invalidUTF8,
        "surrogateUTF8Rejected": surrogateUTF8]
}
