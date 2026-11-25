import Foundation

/** A discussion can address a linked, visible session or one of this device's explicitly projected Agent chats. */
public struct PhoneWorkPostChoice: Equatable, Identifiable, Sendable {
    public let id: PhoneWorkPostTarget
    public let label: String
    public let harnessId: String?
    public let disabled: String?

    public static func choices(snapshot: NativeJSON, item: PhoneWorkItemSummary) -> [Self] {
        let device = snapshot["device"], scopes = device["scopes"].array
        guard PhoneWorkItems.supported(snapshot), device["status"].string == "active", scopes.contains(.string("view")),
              scopes.contains(.string("run")), !item.isPrivate || device["dataScope"].string == "all" else { return [] }
        let tasks = snapshot["tasks"].array
        func refusal(_ task: NativeJSON) -> String? {
            if task["archived"].bool { return "会话已归档" }
            return ["running", "waiting-approval"].contains(task["status"].string) ? "这一轮还没结束" : nil
        }
        var rows = item.sessionIds.compactMap { id -> Self? in
            guard let task = tasks.first(where: { $0["id"].string == id }) else { return nil }
            let label = task["title"].string.flatMap { $0.isEmpty ? nil : $0 } ?? "未命名会话"
            return Self(id: .session(id), label: label, harnessId: task["harnessId"].string, disabled: refusal(task))
        }
        guard PhoneAgents.access(snapshot) == .ready, case let .array(agents) = snapshot["customAgents"] else { return rows }
        func agent(_ id: String, name: String) -> Self {
            let disabled: String?
            if let chatId = PhoneAgentChat.session(snapshot, owner: id) {
                if let task = tasks.first(where: { $0["id"].string == chatId }) { disabled = refusal(task) }
                else { disabled = snapshot["tasksComplete"].bool ? "会话不在列表中" : nil }
            } else { disabled = PhoneAgentChat.slot(snapshot, owner: id)["state"].string == "starting" ? "聊天正在开始" : "还没有聊天" }
            return Self(id: .agent(id), label: name, harnessId: nil, disabled: disabled)
        }
        rows.append(agent(PhoneAgents.generalId, name: PhoneAgents.generalName))
        for entry in agents {
            guard let id = entry["id"].string, PhoneAgents.validId(id), id != PhoneAgents.generalId, let name = entry["name"].string else { continue }
            rows.append(agent(id, name: name))
        }
        return rows
    }

    public static func matching(_ choices: [Self], query: String) -> [Self] {
        let needle = query.lowercased(with: .current)
        guard !needle.isEmpty else { return choices }
        return choices.filter { $0.label.lowercased(with: .current).range(of: needle, options: .literal) != nil }
    }
}
