import Foundation

public struct PhoneHelperPermission: Sendable, Equatable {
    public let words: String
    public let warning: Bool
    public let blocked: Bool
}

/** Person-facing words are projections of Host events; tool evidence and actual failures remain unchanged. */
public enum PhoneHelperSpeech {
    public static func activity(_ task: NativeJSON) -> String? {
        switch task["live"]["activity"].string {
        case "starting": "在准备"
        case "model": "在想"
        case "command": "在跑命令"
        case "tool": "在动手"
        case "approval": "等你点头"
        case "cancelling": "在停下"
        default: nil
        }
    }
    public static func tool(_ message: NativeJSON) -> String {
        if message["subagent"] != .null { return "在分头做" }
        let name = message["toolName"].string ?? ""
        for source in [name, message["tool"]["title"].string ?? ""] where source.hasPrefix("mcp__") {
            let parts = source.dropFirst(5).components(separatedBy: "__")
            if parts.count > 1, let server = parts.first, !server.isEmpty { return "在用 " + PhoneConversation.visible(server) }
        }
        if name.hasPrefix("browser_") { return "在看网页" }
        if ["read_file", "list_files", "list_folders"].contains(name) { return "在看文件" }
        switch PhoneConversation.toolKind(message) {
        case "read": return "在看文件"
        case "search": return "在找东西"
        case "fetch": return "在查资料"
        case "edit", "delete", "move": return "在写文件"
        case "execute": return "在跑命令"
        case "think": return "在想"
        default: return "在动手"
        }
    }
    public static func status(_ detail: NativeJSON, stopping: Bool, engine: String, hostNow: Date) -> PhoneRunStatus {
        let original = PhoneConversation.runStatus(detail, stopping: stopping, engine: engine, hostNow: hostNow)
        guard original.tone == .plain || original.tone == .quiet else { return original }
        let phase = detail["activity"]["phase"].string ?? detail["summary"]["live"]["activity"].string
        let text: String
        if stopping || phase == "cancelling" { text = "在停下" }
        else if !detail["questions"].array.isEmpty || !detail["approvals"].array.isEmpty || phase == "approval" { text = "等你点头" }
        else if phase == "starting" { text = "在准备" }
        else if phase == "tool" || phase == "command" {
            let call = PhoneConversation.turns(detail["messages"].array).last?.replies.last { $0["role"].string == "tool" && $0["state"].string == "running" }
            text = tool(call ?? .object(["toolName": detail["activity"]["toolName"]]))
        } else if !(detail["liveText"].string ?? "").isEmpty { text = "在回复" }
        else if phase == "model" || !(detail["liveReasoning"].string ?? "").isEmpty { text = "在想" }
        else { text = original.text }
        return PhoneRunStatus(tone: original.tone, text: text, clock: original.clock)
    }
    public static func permission(_ detail: NativeJSON, harness: NativeJSON) -> PhoneHelperPermission? {
        guard (detail["permission"]["level"].string ?? harness["level"].string) == "L3", detail["summary"]["mode"].string != "chat" else { return nil }
        let permission = detail["permission"] == .null ? harness["permission"] : detail["permission"]
        let mode = detail["config"].array.first { $0["category"].string == "mode" }
        if permission["readback"].string == "mode", let expected = permission["expectedMode"].string,
           mode?["currentValue"].string != expected { return PhoneHelperPermission(words: "权限没确认", warning: true, blocked: true) }
        if let current = mode?["currentValue"].string {
            let tier = permission["modeTiers"][current]["tier"].string
            if tier == "never" { return PhoneHelperPermission(words: "不先问你", warning: true, blocked: false) }
            if tier == nil { return PhoneHelperPermission(words: PhoneConversation.visible(mode?["options"].array.first { $0["value"].string == current }?["name"].string ?? current), warning: false, blocked: false) }
        } else if permission["approvals"].string == "none" { return PhoneHelperPermission(words: "不先问你", warning: true, blocked: false) }
        else if permission["readback"].string == "none" { return PhoneHelperPermission(words: "权限没确认", warning: true, blocked: false) }
        return nil
    }
}
