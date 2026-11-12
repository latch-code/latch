import Foundation

/** One entry of a start menu. */
public struct PhoneStartEntry: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
}

public struct PhoneModelChoice: Equatable, Hashable, Sendable, Identifiable {
    public let providerId: String
    public let providerName: String
    public let model: String
    public var id: String { providerId + "\u{0}" + model }
    public init(providerId: String, providerName: String, model: String) { self.providerId = providerId; self.providerName = providerName; self.model = model }
}

public struct PhoneStartChoice: Equatable, Sendable {
    public var harnessId: String?
    /** Nil: a conversation outside any project. */
    public var workspaceId: String?
    public var model: PhoneModelChoice?
    public init(harnessId: String? = nil, workspaceId: String? = nil, model: PhoneModelChoice? = nil) { self.harnessId = harnessId; self.workspaceId = workspaceId; self.model = model }
}

/** What a new session can run on. The Host enforces every rule again; this only keeps a choice from looking possible when it is not. */
public enum PhoneStart {
    public static func engineName(_ harness: NativeJSON) -> String {
        harness["capabilities"]["display"]["label"].string ?? harness["id"].string ?? "Harness"
    }
    /** The key of its icon, from the Host; nil draws the neutral glyph. */
    public static func mark(_ harness: NativeJSON) -> String? { harness["capabilities"]["display"]["mark"].string }
    /** The icon of a session whose engine is no longer listed: the Host derives a harness's identifier from its preset, as in codex-2. */
    public static func removedMark(_ harnessId: String) -> String {
        harnessId.range(of: "-[0-9]+$", options: .regularExpression).map { String(harnessId[..<$0.lowerBound]) } ?? harnessId
    }
    public static func usesServices(_ harness: NativeJSON) -> Bool { harness["capabilities"]["models"]["owner"].string == "latch" }
    /** Ready engines with the built-in first; an engine that is not installed or not ready is not offered at all. */
    public static func engines(_ catalog: NativeJSON) -> [PhoneStartEntry] {
        let ready = catalog["harnesses"].array.filter { $0["status"].string == "ready" }
        let enforced = { (harness: NativeJSON) in harness["capabilities"]["permission"]["enforcement"].string == "latch" }
        let ordered = ready.filter(enforced) + ready.filter { !enforced($0) }
        return ordered.compactMap { harness in
            guard let id = harness["id"].string else { return nil }
            return PhoneStartEntry(id: id, name: engineName(harness))
        }
    }
    public static func projects(_ catalog: NativeJSON) -> [PhoneStartEntry] {
        catalog["workspaces"].array.compactMap { project in
            guard let id = project["id"].string, project["unavailable"].string == nil else { return nil }
            return PhoneStartEntry(id: id, name: project["name"].string ?? id)
        }
    }
    public static func models(_ catalog: NativeJSON) -> [PhoneModelChoice] {
        catalog["providers"].array.flatMap { provider -> [PhoneModelChoice] in
            guard let id = provider["id"].string else { return [] }
            let name = provider["name"].string ?? id
            return provider["models"].array.compactMap { $0.string.map { PhoneModelChoice(providerId: id, providerName: name, model: $0) } }
        }
    }
    public static func defaults(_ catalog: NativeJSON) -> PhoneStartChoice {
        let engines = engines(catalog), defaults = catalog["defaults"]
        let harnessId = engines.first { $0.id == defaults["harnessId"].string }?.id ?? engines.first?.id
        let projects = projects(catalog)
        let chat = defaults["mode"].string == "chat"
        let workspaceId = chat ? nil : projects.first { $0.id == defaults["workspaceId"].string }?.id ?? projects.first?.id
        return PhoneStartChoice(harnessId: harnessId, workspaceId: workspaceId, model: defaultModel(catalog, harnessId: harnessId))
    }
    /** The Host's default model for a Harness that uses Latch's services; a Harness that chooses its own gets none. */
    public static func defaultModel(_ catalog: NativeJSON, harnessId: String?) -> PhoneModelChoice? {
        guard usesServices(harness(catalog, harnessId)) else { return nil }
        let models = models(catalog), defaults = catalog["defaults"]
        return models.first { $0.providerId == defaults["model"]["providerId"].string && $0.model == defaults["model"]["model"].string } ?? models.first
    }
    public static func harness(_ catalog: NativeJSON, _ id: String?) -> NativeJSON {
        catalog["harnesses"].array.first { $0["id"].string == id } ?? .null
    }
    public static func acceptsChat(_ catalog: NativeJSON, harnessId: String?) -> Bool {
        catalog["harnesses"].array.first { $0["id"].string == harnessId }?["modes"].array.contains(.string("chat")) == true
    }
    /** Why this choice cannot start, in the words the sheet shows; nil when it can. */
    public static func blocker(_ catalog: NativeJSON, choice: PhoneStartChoice) -> String? {
        guard let harnessId = choice.harnessId, let harness = catalog["harnesses"].array.first(where: { $0["id"].string == harnessId }) else {
            return "这台 Mac 现在没有能开始的 Harness。"
        }
        guard harness["status"].string == "ready" else { return engineName(harness) + " 现在不能开始。" }
        if let id = choice.workspaceId {
            guard let project = catalog["workspaces"].array.first(where: { $0["id"].string == id }) else { return "这个项目已不可用。" }
            if let reason = project["unavailable"].string { return reason }
        } else if !acceptsChat(catalog, harnessId: harnessId) { return "先选一个项目。" }
        if usesServices(harness) && choice.model == nil { return "还没有模型服务。在 Mac 上的 Latch 里添加。" }
        return nil
    }
    /**
     * A start's fields. A model goes only to a Harness that uses Latch's services; `forwarded` is a service the person sees
     * in the sheet for another Harness (a fork's), the only way a Harness with its own models is sent one.
     */
    public static func fields(_ catalog: NativeJSON, choice: PhoneStartChoice, prompt: String, forwarded: PhoneModelChoice? = nil) -> [String: NativeJSON] {
        var choice = choice
        choice.model = usesServices(harness(catalog, choice.harnessId)) ? choice.model : forwarded
        return fields(choice, prompt: prompt)
    }
    static func fields(_ choice: PhoneStartChoice, prompt: String) -> [String: NativeJSON] {
        var result: [String: NativeJSON] = ["prompt": .string(prompt)]
        if let harnessId = choice.harnessId { result["harnessId"] = .string(harnessId) }
        if let workspaceId = choice.workspaceId { result["workspaceId"] = .string(workspaceId); result["mode"] = .string("agent") }
        else { result["mode"] = .string("chat") }
        if let model = choice.model { result["model"] = .object(["providerId": .string(model.providerId), "model": .string(model.model)]) }
        return result
    }
}
