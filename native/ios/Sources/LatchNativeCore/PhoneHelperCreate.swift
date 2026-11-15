import Foundation

public struct PhoneHelperCandidate: Sendable, Identifiable {
    public let id: String
    public let name: String
    public let mark: String?
    public let card: NativeJSON
    public let abilities: [String]
    public let unasked: Bool
    public let reason: String?
}

/** A local draft only. A request is allocated once, when the person chooses Create. */
public struct PhoneHelperDraft: Sendable {
    public var harnessId: String
    public var name = ""
    public var description = ""
    public var instructions = ""
    public var avatar = NativeJSON.null
    public var model: NativeJSON?
    public var engineOptions: [String: String] = [:]
    public var defaultProjectId: String?
    public init(harnessId: String) { self.harnessId = harnessId }
}

public struct PhoneHelperModel: Sendable, Identifiable {
    public let choice: PhoneModelChoice
    public let experimental: Bool
    public var id: String { LinkBytes.base64url(Data(choice.id.utf8)) }
}

public enum PhoneHelperCreate {
    private static let base = "/link/api/custom-agents"
    private static let abilities = ["files", "commands", "mcp", "ask", "memory", "schedule"]
    private static func same(_ left: String?, _ right: String?) -> Bool {
        guard let left, let right else { return false }; return left.utf8.elementsEqual(right.utf8)
    }
    private static func supported(_ harness: NativeJSON) -> Bool {
        ["private", "first-turn"].contains(harness["agentContext"].string ?? "") && harness["offer"] == .null
    }
    private static func builtin(_ harness: NativeJSON) -> Bool { harness["capabilities"]["permission"]["enforcement"].string == "latch" }
    private static func harness(_ catalog: NativeJSON, id: String) -> NativeJSON? {
        guard LinkBytes.matches(id, "[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}") else { return nil }
        return catalog["harnesses"].array.first { same($0["id"].string, id) && supported($0) && $0["status"].string == "ready" }
    }
    public static func candidates(_ catalog: NativeJSON) -> (ready: [PhoneHelperCandidate], waiting: [PhoneHelperCandidate]) {
        let all = catalog["harnesses"].array.filter(supported)
        let sorted = all.filter(builtin) + all.filter { !builtin($0) }
        func entry(_ value: NativeJSON) -> PhoneHelperCandidate? {
            guard let id = value["id"].string, LinkBytes.matches(id, "[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}") else { return nil }
            let card = value["helperCard"], proposes = value["agentContext"].string == "private" || value["skills"].string == "server"
            var seen = Set<String>()
            let tags = card["abilities"].array.compactMap(\.string).filter {
                abilities.contains($0) && seen.insert($0).inserted && ($0 != "commands" || value["capabilities"]["tools"]["shell"].bool)
                    && (!["memory", "schedule"].contains($0) || proposes)
            }
            return PhoneHelperCandidate(id: id, name: PhoneStart.engineName(value), mark: PhoneStart.mark(value), card: card,
                abilities: tags, unasked: value["permission"]["approvals"].string == "none",
                reason: value["status"] == .string("ready") ? nil : value["statusMessage"].string ?? (value["statusReason"].string == "outdated" ? "需要升级" : "没准备好"))
        }
        return (sorted.filter { $0["status"].string == "ready" }.compactMap(entry), sorted.filter { $0["status"].string != "ready" }.compactMap(entry))
    }
    public static func firstFace(_ card: NativeJSON, agents: [NativeJSON]) -> NativeJSON {
        let used = Set(agents.compactMap { $0["avatar"]["hue"].string })
        let hue = PhoneAgentAvatar.hues.first { !used.contains($0) } ?? PhoneAgentAvatar.hues[agents.count % PhoneAgentAvatar.hues.count]
        let bracket = card["face"]["bracket"].string.flatMap { PhoneAgentAvatar.brackets.contains($0) ? $0 : nil } ?? "round"
        let eyes = card["face"]["eyes"].string.flatMap { PhoneAgentAvatar.eyeKinds.contains($0) ? $0 : nil } ?? "dot"
        return .object(["kind": .string("face"), "bracket": .string(bracket), "eyes": .string(eyes), "hue": .string(hue)])
    }
    public static func choose(_ catalog: NativeJSON, harnessId: String, agents: [NativeJSON], previous: PhoneHelperDraft? = nil) throws -> PhoneHelperDraft {
        guard let selected = harness(catalog, id: harnessId) else { throw NativeFailure.invalidRecord }
        var draft = previous ?? PhoneHelperDraft(harnessId: harnessId)
        if !same(draft.harnessId, harnessId) { draft.model = nil; draft.engineOptions = [:] }
        draft.harnessId = harnessId
        if draft.avatar == .null { draft.avatar = firstFace(selected["helperCard"], agents: agents) }
        return draft
    }
    /** The shared location rules include folder limits; the default row denotes the helper's own home. */
    public static func projects(_ catalog: NativeJSON, harnessId: String) -> [PhoneScheduleLocation] {
        guard let selected = harness(catalog, id: harnessId) else { return [] }
        return PhoneScheduleProposals.locations(catalog, harness: selected)
    }
    private static func modelKey(_ value: String) -> String {
        let leaf = value.lowercased().split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        return leaf.replacingOccurrences(of: "-(?:[0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})$", with: "", options: .regularExpression)
    }
    /** Only supported service routes and, where required, models this Harness itself knows. No default is selected here. */
    public static func services(_ catalog: NativeJSON, harnessId: String) -> [PhoneHelperModel] {
        guard let selected = harness(catalog, id: harnessId) else { return [] }
        let capabilities = selected["capabilities"]["models"], direct = PhoneStart.usesServices(selected)
        let known = selected["catalogue"]["options"].array.filter { $0["category"].string == "model" }
            .flatMap { $0["options"].array.compactMap { $0["value"].string.map(modelKey) } }
        return catalog["providers"].array.flatMap { provider -> [PhoneHelperModel] in
            guard let id = provider["id"].string else { return [] }
            let route = PhoneStart.serviceRoute(selected, provider: provider)
            guard direct || route != nil else { return [] }
            return provider["models"].array.compactMap { value in
                guard let model = value.string, direct || !capabilities["knownOnly"].bool || known.contains(where: { same($0, modelKey(model)) }) else { return nil }
                return PhoneHelperModel(choice: PhoneModelChoice(providerId: id, providerName: provider["name"].string ?? id, model: model),
                    experimental: !direct && (capabilities["experimental"].bool || route != .passthrough))
            }
        }
    }
    private static func printable(_ value: String, newline: Bool = false) -> Bool {
        value.unicodeScalars.allSatisfy { scalar in
            (newline && scalar == "\n") || ![Unicode.GeneralCategory.control, .format].contains(scalar.properties.generalCategory)
        }
    }
    private static func validateModel(_ model: NativeJSON, catalog: NativeJSON, harnessId: String) throws {
        guard case .object = model, Set(model.object.keys).isSubset(of: ["providerId", "model", "effort"]),
              let provider = model["providerId"].string, let id = model["model"].string,
              LinkBytes.matches(provider, "[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}"), !id.isEmpty, id.utf16.count <= 256,
              services(catalog, harnessId: harnessId).contains(where: { same($0.choice.providerId, provider) && same($0.choice.model, id) }) else { throw NativeFailure.invalidRecord }
        if let effort = model.object["effort"] {
            guard let level = effort.string, LinkBytes.matches(level, "[a-z][a-z0-9_-]{0,31}"),
                  catalog["providers"].array.first(where: { same($0["id"].string, provider) })?["modelCapabilities"][id]["thinking"].array.contains(.string(level)) == true else { throw NativeFailure.invalidRecord }
        }
    }
    /** Offered values only. A creation never imports Code's last mode or guesses a permissive default. */
    private static func validateOptions(_ options: [String: String], harness: NativeJSON, service: Bool) throws {
        guard options.count <= 8, !PhoneStart.usesServices(harness) || options.isEmpty else { throw NativeFailure.invalidRecord }
        var offered = harness["catalogue"]["options"].array
        if let model = offered.first(where: { $0["category"].string == "model" }), let key = model["id"].string, let selected = options[key],
           !same(selected, model["currentValue"].string) {
            offered = offered.filter { !["thought_level", "model_config"].contains($0["category"].string ?? "") }
                + (harness["catalogue"]["perModel"].array.first { same($0["model"].string, selected) }?["options"].array ?? [])
        }
        for (key, value) in options {
            guard !key.isEmpty, key.utf16.count <= 128, value.utf16.count <= 1024 else { throw NativeFailure.invalidRecord }
            if key == "~mode" {
                guard harness["permission"]["modes"].array.contains(.string(value)) else { throw NativeFailure.invalidRecord }
            } else {
                guard let option = offered.first(where: { same($0["id"].string, key) }),
                      !(service && ["model", "thought_level", "model_config"].contains(option["category"].string ?? "")),
                      option["options"].array.contains(where: { same($0["value"].string, value) })
                        || option["category"].string == "model" && harness["customModels"].array.contains(where: { same($0.string, value) }) else { throw NativeFailure.invalidRecord }
            }
        }
    }
    public static func create(_ catalog: NativeJSON, draft: PhoneHelperDraft, requestId: String = UUID().uuidString) throws -> NativePendingWrite {
        guard let selected = harness(catalog, id: draft.harnessId) else { throw NativeFailure.invalidRecord }
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let description = draft.description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf16.count <= 80, printable(name), description.utf16.count <= 200,
              printable(description, newline: true), draft.instructions.utf16.count <= 32_000 else { throw NativeFailure.invalidRecord }
        let modes = selected["modes"].array.compactMap(\.string)
        guard let mode = modes.contains("agent") ? "agent" : modes.first(where: { $0 == "chat" }) else { throw NativeFailure.invalidRecord }
        var fields: [String: NativeJSON] = ["name": .string(name), "description": .string(description), "instructions": .string(draft.instructions),
            "harnessId": .string(draft.harnessId), "mode": .string(mode), "skills": .array([])]
        if draft.avatar != .null {
            guard Set(draft.avatar.object.keys) == Set(["kind", "bracket", "eyes", "hue"]), draft.avatar["kind"].string == "face",
                  PhoneAgentAvatar.brackets.contains(draft.avatar["bracket"].string ?? ""), PhoneAgentAvatar.eyeKinds.contains(draft.avatar["eyes"].string ?? ""),
                  PhoneAgentAvatar.hues.contains(draft.avatar["hue"].string ?? "") else { throw NativeFailure.invalidRecord }
            fields["avatar"] = draft.avatar
        }
        if let model = draft.model { try validateModel(model, catalog: catalog, harnessId: draft.harnessId); fields["model"] = model }
        try validateOptions(draft.engineOptions, harness: selected, service: draft.model != nil)
        if !draft.engineOptions.isEmpty { fields["engineOptions"] = .object(draft.engineOptions.mapValues(NativeJSON.string)) }
        if let project = draft.defaultProjectId, project != "default" {
            guard LinkBytes.matches(project, "[a-z0-9][a-z0-9_-]{0,63}"), projects(catalog, harnessId: draft.harnessId).contains(where: { $0.id == project && $0.unavailable == nil }) else { throw NativeFailure.invalidRecord }
            fields["defaultProjectId"] = .string(project)
        }
        return try NativePendingWrite(method: .post, path: base, fields: fields, requestId: requestId)
    }
    public static func isCreation(_ write: NativePendingWrite) -> Bool { write.method == "POST" && write.path == base }
    public static func defaults(_ agent: NativeJSON) -> PhoneHelperDraft {
        var draft = PhoneHelperDraft(harnessId: agent["harnessId"].string ?? "")
        draft.model = agent["model"] == .null ? nil : agent["model"]
        draft.engineOptions = agent["engineOptions"].object.compactMapValues(\.string)
        draft.defaultProjectId = agent["defaultProjectId"].string
        return draft
    }
    /** Model-dependent settings belong to the old model, including when the person returns to the default. */
    public static func selectNativeModel(_ catalog: NativeJSON, draft: PhoneHelperDraft, value: String?) throws -> PhoneHelperDraft {
        guard let selected = harness(catalog, id: draft.harnessId), draft.model == nil,
              let option = selected["catalogue"]["options"].array.first(where: { $0["category"].string == "model" }),
              let key = option["id"].string else { throw NativeFailure.invalidRecord }
        if let value {
            guard option["options"].array.contains(where: { same($0["value"].string, value) })
                || selected["customModels"].array.contains(where: { same($0.string, value) }) else { throw NativeFailure.invalidRecord }
        }
        let all = selected["catalogue"]["options"].array + selected["catalogue"]["perModel"].array.flatMap { $0["options"].array }
        let dependent = Set(all.filter { ["thought_level", "model_config"].contains($0["category"].string ?? "") }.compactMap { $0["id"].string })
        var next = draft
        next.engineOptions = next.engineOptions.filter { !dependent.contains($0.key) }
        next.engineOptions[key] = value
        return next
    }
    /** A narrow defaults patch cannot change the helper's identity, instructions, tools or fixed Harness. */
    public static func changeDefaults(_ catalog: NativeJSON, agent: NativeJSON, draft: PhoneHelperDraft,
        requestId: String = UUID().uuidString) throws -> NativePendingWrite {
        guard let id = agent["id"].string, id != PhoneAgents.generalId, PhoneAgents.validId(id),
              let revision = agent["revision"].integer, revision > 0, same(agent["harnessId"].string, draft.harnessId),
              let selected = harness(catalog, id: draft.harnessId) else { throw NativeFailure.invalidRecord }
        if let model = draft.model { try validateModel(model, catalog: catalog, harnessId: draft.harnessId) }
        try validateOptions(draft.engineOptions, harness: selected, service: draft.model != nil)
        let project = draft.defaultProjectId == "default" ? nil : draft.defaultProjectId
        if let project {
            guard projects(catalog, harnessId: draft.harnessId).contains(where: { $0.id == project && $0.unavailable == nil }) else { throw NativeFailure.invalidRecord }
        }
        return try NativePendingWrite(method: .patch, path: base + "/" + id,
            fields: ["baseRevision": .number(Double(revision)), "model": draft.model ?? .null,
                "engineOptions": draft.engineOptions.isEmpty ? .null : .object(draft.engineOptions.mapValues(NativeJSON.string)),
                "defaultProjectId": project.map(NativeJSON.string) ?? .null], requestId: requestId)
    }
    /** A held request is returned unchanged; none of today's catalog or defaults rewrites its bytes. */
    public static func pending(_ writes: [NativePendingWrite]) throws -> NativePendingWrite? {
        let held = writes.filter(isCreation)
        guard held.count <= 1 else { throw NativeFailure.storageUnavailable }; return held.first
    }
    /** Only the successful response to this exact write supplies its new identity; a list or matching name does not. */
    public static func createdId(_ response: NativeJSON, for write: NativePendingWrite) throws -> String {
        guard isCreation(write), let fields = try? NativeJSON.decode(write.body), fields["requestId"].string == write.requestId,
              let id = response["id"].string, id != PhoneAgents.generalId, PhoneAgents.validId(id), (response["revision"].integer ?? 0) > 0,
              same(fields["harnessId"].string, response["harnessId"].string) else { throw NativeFailure.invalidRecord }
        return id
    }
}
