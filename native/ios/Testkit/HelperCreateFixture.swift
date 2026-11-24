import Foundation
import LatchNativeCore

/** Public draft fixtures only; no Host credentials or private CLI data enter this operation. */
func phoneHelperCreateFixture(_ input: [String: Any]) throws -> [String: Any] {
    let value = try NativeJSON.decode(JSONSerialization.data(withJSONObject: input)), catalog = value["catalog"]
    func plain(_ value: NativeJSON) throws -> Any { try JSONSerialization.jsonObject(with: value.encoded(), options: .fragmentsAllowed) }
    let candidates = PhoneHelperCreate.candidates(catalog)
    func entry(_ row: PhoneHelperCandidate) -> [String: Any] {
        ["id": row.id, "name": row.name, "mark": row.mark as Any? ?? NSNull(), "abilities": row.abilities,
            "unasked": row.unasked, "reason": row.reason as Any? ?? NSNull()]
    }
    var rows: [[String: Any]] = []
    for item in value["cases"].array {
        do {
            var draft = PhoneHelperDraft(harnessId: "")
            draft.name = item["name"].string ?? "Helper"
            draft.description = item["description"].string ?? ""
            draft = try PhoneHelperCreate.choose(catalog, harnessId: item["harnessId"].string ?? "", agents: value["agents"].array, previous: draft)
            draft.instructions = item["instructions"].string ?? ""
            if item.object["avatar"] != nil { draft.avatar = item["avatar"] }
            if item["model"] != .null { draft.model = item["model"] }
            for (key, picked) in item["engineOptions"].object {
                guard let text = picked.string else { throw NativeFailure.invalidRecord }; draft.engineOptions[key] = text
            }
            draft.defaultProjectId = item["defaultProjectId"].string
            for id in item["chooseAgain"].array.compactMap(\.string) {
                draft = try PhoneHelperCreate.choose(catalog, harnessId: id, agents: value["agents"].array, previous: draft)
            }
            let currentCatalog = item["catalogAfter"] == .null ? catalog : item["catalogAfter"]
            let write = try PhoneHelperCreate.create(currentCatalog, draft: draft, requestId: "helper-fixture-request-0001")
            let restored = try JSONDecoder().decode(NativePendingWrite.self, from: JSONEncoder().encode(write))
            let held = try PhoneHelperCreate.pending([restored])
            let other = try NativePendingWrite(method: .post, path: write.path, fields: [:], requestId: "helper-fixture-request-0002")
            let duplicateRefused = (try? PhoneHelperCreate.pending([write, other])) == nil
            let ids = value["responses"].array.map { (try? PhoneHelperCreate.createdId($0, for: write)) as Any? ?? NSNull() }
            rows.append(["accepted": true, "method": write.method, "path": write.path, "body": try plain(NativeJSON.decode(write.body)),
                "sameHeldBytes": held?.body == write.body && held?.requestId == write.requestId,
                "duplicateHeldRefused": duplicateRefused, "createdIds": ids])
        } catch NativeFailure.invalidRecord { rows.append(["accepted": false]) }
    }
    let models = Dictionary(uniqueKeysWithValues: candidates.ready.map { candidate in
        (candidate.id, PhoneHelperCreate.services(catalog, harnessId: candidate.id).map { ["id": $0.id, "providerId": $0.choice.providerId, "model": $0.choice.model, "experimental": $0.experimental] as [String: Any] })
    })
    let changes = try value["changes"].array.map { item -> [String: Any] in
        let agent = item["agent"]
        var draft = PhoneHelperCreate.defaults(agent)
        if let harness = item["harnessId"].string { draft.harnessId = harness }
        if item.object["model"] != nil { draft.model = item["model"] == .null ? nil : item["model"] }
        if item.object["engineOptions"] != nil { draft.engineOptions = item["engineOptions"].object.compactMapValues(\.string) }
        if item.object["project"] != nil { draft.defaultProjectId = item["project"].string }
        do {
            if item.object["selectNativeModel"] != nil { draft = try PhoneHelperCreate.selectNativeModel(catalog, draft: draft, value: item["selectNativeModel"].string) }
            let write = try PhoneHelperCreate.changeDefaults(catalog, agent: agent, draft: draft, requestId: item["requestId"].string ?? "helper-default-fixture-0001")
            return ["accepted": true, "path": write.path, "method": write.method, "body": try plain(NativeJSON.decode(write.body))]
        } catch NativeFailure.invalidRecord { return ["accepted": false] }
    }
    let speech = value["speech"].array.map { item -> [String: Any] in
        let detail = item["detail"], note = PhoneHelperSpeech.permission(detail, harness: item["harness"])
        let status = PhoneHelperSpeech.status(detail, stopping: item["stopping"].bool, engine: "Fixture CLI", hostNow: Date(timeIntervalSince1970: 1000))
        return ["activity": PhoneHelperSpeech.activity(detail["summary"]) as Any? ?? NSNull(), "status": status.text,
            "permission": note?.words as Any? ?? NSNull(), "blocked": note?.blocked ?? false]
    }
    return ["ready": candidates.ready.map(entry), "waiting": candidates.waiting.map(entry), "cases": rows, "models": models, "changes": changes, "speech": speech]
}
