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
    public let effort: String?
    public var id: String { providerId + "\u{0}" + model }
    public init(providerId: String, providerName: String, model: String, effort: String? = nil) {
        self.providerId = providerId; self.providerName = providerName; self.model = model; self.effort = effort
    }
}

public struct PhoneStartChoice: Equatable, Sendable {
    public var harnessId: String? {
        didSet { if oldValue != harnessId { ownModel = nil; ownThinking = nil } }
    }
    /** Nil: a conversation outside any project. */
    public var workspaceId: String?
    public var model: PhoneModelChoice?
    /** A model reported by this exact Harness instance, including its account. */
    public var ownModel: PhoneConfigPick? {
        didSet { if ownModel?.configId != oldValue?.configId || ownModel?.value != oldValue?.value { ownThinking = nil } }
    }
    public var ownThinking: PhoneConfigPick?
    public init(harnessId: String? = nil, workspaceId: String? = nil, model: PhoneModelChoice? = nil) { self.harnessId = harnessId; self.workspaceId = workspaceId; self.model = model }
}

/** What a new session can run on. The Host enforces every rule again; this only keeps a choice from looking possible when it is not. */
public enum PhoneStart {
    enum ServiceRoute: Equatable { case passthrough, translate }
    private static let presetNames = ["codex": "Codex", "claude-agent": "Claude Agent", "pi": "pi", "opencode": "OpenCode",
        "dsh": "DeepSeek Harness", "qwen": "Qwen Code", "goose": "goose", "cursor": "Cursor", "antigravity": "Antigravity", "grok": "Grok Build"]
    private static let wires = ["openai-compatible": "chat-completions", "openai-responses": "responses", "anthropic": "anthropic-messages"]
    private static let translations = ["responses:chat-completions", "anthropic-messages:chat-completions", "anthropic-messages:responses", "responses:anthropic-messages"]
    static func serviceRoute(_ harness: NativeJSON, provider: NativeJSON) -> ServiceRoute? {
        guard let kind = provider["kind"].string, let wire = wires[kind] else { return nil }
        let accepted = harness["capabilities"]["models"]["wires"].array.compactMap(\.string)
        if accepted.contains(wire) { return .passthrough }
        return accepted.contains { translations.contains($0 + ":" + wire) } ? .translate : nil
    }
    public static func engineName(_ harness: NativeJSON) -> String {
        harness["capabilities"]["display"]["label"].string ?? harness["id"].string ?? "Harness"
    }
    public static func presetName(_ id: String) -> String? { presetNames[id] }
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
    public static func ownModels(_ harness: NativeJSON) -> [PhoneConfigPick] {
        guard !usesServices(harness),
              let option = harness["catalogue"]["options"].array.first(where: { $0["category"].string == "model" }),
              let id = option["id"].string else { return [] }
        var seen = Set<String>()
        let listed = option["options"].array.compactMap { row -> PhoneConfigPick? in
            guard let value = row["value"].string, seen.insert(value).inserted, row["unavailable"] == .null else { return nil }
            return PhoneConfigPick(kind: .model, configId: id, value: value, name: row["name"].string ?? value)
        }
        return listed + harness["customModels"].array.compactMap { row in
            guard let value = row.string, seen.insert(value).inserted else { return nil }
            return PhoneConfigPick(kind: .model, configId: id, value: value, name: value)
        }
    }
    /** What follows the chosen model is only what that model has reported. */
    static func options(_ catalogue: NativeJSON, forModel model: String?) -> [NativeJSON] {
        let options = catalogue["options"].array
        guard let model, model != options.first(where: { $0["category"].string == "model" })?["currentValue"].string else { return options }
        return options.filter { !["thought_level", "model_config"].contains($0["category"].string ?? "") }
            + (catalogue["perModel"].array.first { $0["model"].string == model }?["options"].array ?? [])
    }
    public static func ownThinking(_ harness: NativeJSON, model: PhoneConfigPick?) -> [PhoneConfigPick] {
        guard !usesServices(harness),
              let option = options(harness["catalogue"], forModel: model?.value).first(where: { $0["category"].string == "thought_level" }),
              let id = option["id"].string else { return [] }
        var seen = Set<String>()
        return option["options"].array.compactMap { row in
            guard let value = row["value"].string, seen.insert(value).inserted, row["unavailable"] == .null else { return nil }
            return PhoneConfigPick(kind: .thinking, configId: id, value: value, name: row["name"].string ?? value)
        }
    }
    public static func unreadThinkingModel(_ harness: NativeJSON, model: PhoneConfigPick?) -> String? {
        let catalogue = harness["catalogue"]
        guard let model, harness["offer"] == .null, harness["catalogueRead"]["modes"].bool,
              let current = catalogue["options"].array.first(where: { $0["category"].string == "model" }),
              current["currentValue"].string != model.value,
              !catalogue["perModel"].array.contains(where: { $0["model"].string == model.value }),
              ownModels(harness).contains(where: { $0.configId == model.configId && $0.value == model.value }) else { return nil }
        return model.value
    }
    public static func defaults(_ catalog: NativeJSON) -> PhoneStartChoice {
        let engines = engines(catalog), defaults = catalog["defaults"]
        let harnessId = engines.first { $0.id == defaults["harnessId"].string }?.id ?? engines.first?.id
        let projects = projects(catalog)
        let chat = defaults["mode"].string == "chat"
        let workspaceId = chat ? nil : projects.first { $0.id == defaults["workspaceId"].string }?.id ?? projects.first?.id
        return PhoneStartChoice(harnessId: harnessId, workspaceId: workspaceId, model: newSessionModel(catalog, harnessId: harnessId, workspaceId: workspaceId))
    }
    /** The default for starts that only use Latch's built-in model picker. */
    public static func defaultModel(_ catalog: NativeJSON, harnessId: String?) -> PhoneModelChoice? {
        guard usesServices(harness(catalog, harnessId)) else { return nil }
        let models = models(catalog), defaults = catalog["defaults"]
        let ref = defaults["model"]
        guard let model = models.first(where: { $0.providerId == ref["providerId"].string && $0.model == ref["model"].string }) else {
            return models.first
        }
        let provider = catalog["providers"].array.first { $0["id"].string == model.providerId }
        let declared = provider?["modelCapabilities"][model.model]["thinking"].array ?? []
        let effort = ref["effort"].string.flatMap { declared.contains(.string($0)) ? $0 : nil }
        return PhoneModelChoice(providerId: model.providerId, providerName: model.providerName, model: model.model, effort: effort)
    }
    /** A new conversation offers the project's usable model, then the gateway verified for this Harness. */
    public static func newSessionModel(_ catalog: NativeJSON, harnessId: String?, workspaceId: String?) -> PhoneModelChoice? {
        let engine = harness(catalog, harnessId)
        if usesServices(engine) { return defaultModel(catalog, harnessId: harnessId) }
        if engine["account"].bool { return nil }
        let choices = models(catalog)
        if let workspaceId, workspaceId != "default",
           let workspace = catalog["workspaces"].array.first(where: { $0["id"].string == workspaceId && $0["unavailable"] == .null }),
           let providerId = workspace["defaultModel"]["providerId"].string,
           let provider = catalog["providers"].array.first(where: { $0["id"].string == providerId }),
           serviceRoute(engine, provider: provider) != nil,
           let projectModel = choices.first(where: { $0.providerId == providerId && $0.model == workspace["defaultModel"]["model"].string }) {
            return projectModel
        }
        let defaults = catalog["defaults"]
        guard let harnessId, harnessId == defaults["harnessId"].string else { return nil }
        let ref = defaults["gateway"]
        return choices.first { $0.providerId == ref["providerId"].string && $0.model == ref["model"].string }
    }
    public static func harness(_ catalog: NativeJSON, _ id: String?) -> NativeJSON {
        catalog["harnesses"].array.first { $0["id"].string == id } ?? .null
    }
    /** A removed account can still be identified by the Harness ID stored on its conversations. */
    static func isBoundAccount(_ catalog: NativeJSON, _ id: String) -> Bool {
        harness(catalog, id)["account"].bool
            || LinkBytes.matches(id, "(?:account-[0-9a-f]{24}|cursor-key-[0-9a-f]{8}-[0-9a-f-]{27})")
    }
    public static func acceptsChat(_ catalog: NativeJSON, harnessId: String?) -> Bool {
        catalog["harnesses"].array.first { $0["id"].string == harnessId }?["modes"].array.contains(.string("chat")) == true
    }
    /** Why this choice cannot start, in the words the sheet shows; nil when it can. */
    public static func blocker(_ catalog: NativeJSON, choice: PhoneStartChoice) -> String? {
        guard let harnessId = choice.harnessId else {
            return "这台 Mac 现在没有能开始的 Harness。"
        }
        let harness = harness(catalog, harnessId)
        guard harness["status"].string == "ready" else {
            if isBoundAccount(catalog, harnessId) { return "原来选择的账号现在不能开始。请选择可用的 Harness。" }
            return harness == .null ? "这台 Mac 现在没有能开始的 Harness。" : engineName(harness) + " 现在不能开始。"
        }
        if let id = choice.workspaceId {
            guard let project = catalog["workspaces"].array.first(where: { $0["id"].string == id }) else { return "这个项目已不可用。" }
            if let reason = project["unavailable"].string { return reason }
        } else if !acceptsChat(catalog, harnessId: harnessId) { return "先选一个项目。" }
        if usesServices(harness) && choice.model == nil { return "还没有模型服务。在 Mac 上的 Latch 里添加。" }
        if let selected = choice.ownModel, !ownModels(harness).contains(where: { $0.configId == selected.configId && $0.value == selected.value }) {
            return "这个账号的模型列表已更新，请重新选择模型。"
        }
        if !usesServices(harness), !harness["account"].bool, choice.model == nil, choice.ownModel == nil, catalog["defaults"]["harnessId"].string == harnessId,
           catalog["defaults"]["gatewayUnavailable"].bool == true { return "原来选择的模型服务暂不可用。请在 Mac 上重新选择。" }
        return nil
    }
    /** Send what the person sees in the ordinary new session sheet, even if the Host's default has changed. */
    public static func newSessionFields(_ catalog: NativeJSON, choice: PhoneStartChoice, prompt: String) -> [String: NativeJSON] {
        var result = fields(choice, prompt: prompt)
        if let harnessId = choice.harnessId, !usesServices(harness(catalog, harnessId)), choice.model == nil {
            result["ownModel"] = .bool(true)
            let native = harness(catalog, harnessId)
            let thinking = choice.ownThinking.flatMap { pick in
                ownThinking(native, model: choice.ownModel).first { $0.configId == pick.configId && $0.value == pick.value }
            }
            let picks = [choice.ownModel, thinking].compactMap { $0 }
            if !picks.isEmpty { result["config"] = config(picks) }
        }
        return result
    }
    /** A fork can forward a service named by its own plan. */
    public static func fields(_ catalog: NativeJSON, choice: PhoneStartChoice, prompt: String, forwarded: PhoneModelChoice? = nil) -> [String: NativeJSON] {
        var choice = choice
        if !usesServices(harness(catalog, choice.harnessId)) {
            choice.model = forwarded
        }
        return fields(choice, prompt: prompt)
    }
    static func config(_ picks: [PhoneConfigPick]) -> NativeJSON {
        .array(picks.map { .object(["configId": .string($0.configId), "value": .string($0.value)]) })
    }
    static func fields(_ choice: PhoneStartChoice, prompt: String) -> [String: NativeJSON] {
        var result: [String: NativeJSON] = ["prompt": .string(prompt)]
        if let harnessId = choice.harnessId { result["harnessId"] = .string(harnessId) }
        if let workspaceId = choice.workspaceId { result["workspaceId"] = .string(workspaceId); result["mode"] = .string("agent") }
        else { result["mode"] = .string("chat") }
        if let model = choice.model {
            var value: [String: NativeJSON] = ["providerId": .string(model.providerId), "model": .string(model.model)]
            if let effort = model.effort { value["effort"] = .string(effort) }
            result["model"] = .object(value)
        }
        return result
    }
}
