import Foundation

/** One entry of a start menu: it is listed either way, and says where it can start when this phone cannot. */
public struct PhoneStartEntry: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let line: String?
    public let startable: Bool
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

/** What this phone may start. The Host enforces every rule again; this only keeps a choice from looking possible when it is not. */
public enum PhoneStart {
    public static let onMac = "在 Mac 上开始"
    public static func engineName(_ harness: NativeJSON) -> String {
        harness["source"].string == "builtin" ? "Latch 内置" : harness["name"].string ?? harness["id"].string ?? "Harness"
    }
    public static func level(_ harness: NativeJSON) -> String {
        harness["level"].string ?? (harness["source"].string == "builtin" ? "L1" : "L3")
    }
    private static func canStart(_ harness: NativeJSON) -> Bool {
        harness["status"].string == "ready" && level(harness) != "L3" && harness["remoteStart"] != .bool(false)
    }
    /** Ready engines with the built-in first; an engine that is not installed or not ready is not offered at all. */
    public static func engines(_ catalog: NativeJSON) -> [PhoneStartEntry] {
        let ready = catalog["harnesses"].array.filter { $0["status"].string == "ready" }
        let ordered = ready.filter { $0["source"].string == "builtin" } + ready.filter { $0["source"].string != "builtin" }
        return ordered.compactMap { harness in
            guard let id = harness["id"].string else { return nil }
            let startable = canStart(harness)
            return PhoneStartEntry(id: id, name: engineName(harness), line: startable ? nil : onMac, startable: startable)
        }
    }
    public static func projects(_ catalog: NativeJSON) -> [PhoneStartEntry] {
        catalog["workspaces"].array.compactMap { project in
            guard let id = project["id"].string, project["unavailable"].string == nil else { return nil }
            let startable = project["remoteStart"] != .bool(false)
            return PhoneStartEntry(id: id, name: project["name"].string ?? id, line: startable ? nil : onMac, startable: startable)
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
        let engines = engines(catalog).filter(\.startable), defaults = catalog["defaults"]
        let harnessId = engines.first { $0.id == defaults["harnessId"].string }?.id ?? engines.first?.id
        let projects = projects(catalog).filter(\.startable)
        let chat = defaults["mode"].string == "chat" && chatStartable(catalog)
        let workspaceId = chat ? nil : projects.first { $0.id == defaults["workspaceId"].string }?.id ?? projects.first?.id
        let models = models(catalog)
        let model = models.first { $0.providerId == defaults["model"]["providerId"].string && $0.model == defaults["model"]["model"].string } ?? models.first
        return PhoneStartChoice(harnessId: harnessId, workspaceId: workspaceId, model: model)
    }
    public static func acceptsChat(_ catalog: NativeJSON, harnessId: String?) -> Bool {
        catalog["harnesses"].array.first { $0["id"].string == harnessId }?["modes"].array.contains(.string("chat")) == true
    }
    /** A session outside any project runs in the Host's default folder, which the Host's policy can keep from other devices. */
    public static func chatStartable(_ catalog: NativeJSON) -> Bool {
        catalog["workspaces"].array.first { $0["id"].string == "default" }?["remoteStart"] != .bool(false)
    }
    /** Why this choice cannot start, in the words the sheet shows; nil when it can. */
    public static func blocker(_ catalog: NativeJSON, choice: PhoneStartChoice) -> String? {
        guard let harnessId = choice.harnessId, let harness = catalog["harnesses"].array.first(where: { $0["id"].string == harnessId }) else {
            return "这台手机现在没有能开始的 Harness。" + onMac + "。"
        }
        guard canStart(harness) else { return engineName(harness) + " 只能在 Mac 上开始。" }
        if let id = choice.workspaceId {
            guard let project = catalog["workspaces"].array.first(where: { $0["id"].string == id }) else { return "这个项目已不可用。" }
            if let reason = project["unavailable"].string { return reason }
            if project["remoteStart"] == .bool(false) { return "这个项目只能在 Mac 上开始新会话。" }
        } else if !acceptsChat(catalog, harnessId: harnessId) { return "先选一个项目。" }
        else if !chatStartable(catalog) { return "不用项目的对话只能在 Mac 上开始。" }
        if harness["models"].string == "host" && choice.model == nil { return "还没有模型服务。在 Mac 上的 Latch 里添加。" }
        return nil
    }
    public static func fields(_ choice: PhoneStartChoice, prompt: String) -> [String: NativeJSON] {
        var result: [String: NativeJSON] = ["prompt": .string(prompt)]
        if let harnessId = choice.harnessId { result["harnessId"] = .string(harnessId) }
        if let workspaceId = choice.workspaceId { result["workspaceId"] = .string(workspaceId); result["mode"] = .string("agent") }
        else { result["mode"] = .string("chat") }
        if let model = choice.model { result["model"] = .object(["providerId": .string(model.providerId), "model": .string(model.model)]) }
        return result
    }
}
