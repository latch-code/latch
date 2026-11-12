import Foundation

/**
 * The web's readable Markdown transcript (`exportMarkdown.ts`) for 复制为 Markdown and 复制到这里为止的记录: turns as
 * headings, tools folded into `<details>`, model text made inert outside code so a viewer loads nothing. File diffs of
 * tool calls are listed by path only; the web's export prints them as unified diffs.
 */
public enum PhoneMarkdown {
    static let toolStates = ["queued": "等待执行", "awaiting-approval": "待批准", "running": "执行中", "completed": "已完成", "failed": "失败",
                             "cancelled": "已停止", "rejected": "已拒绝", "expired": "已过期", "blocked": "拦下"]
    static func fence(_ text: String, language: String = "") -> String {
        let marks = PhoneDelivery.fence(text)
        var body = text
        if body.hasSuffix("\n") { body.removeLast() }
        return marks + language + "\n" + body + "\n" + marks
    }
    static func code(_ text: String) -> String {
        let value = text.replacingOccurrences(of: "\r\n", with: " ").replacingOccurrences(of: "\n", with: " ")
        var longest = 0, run = 0
        for character in value { if character == "`" { run += 1; longest = max(longest, run) } else { run = 0 } }
        let marks = String(repeating: "`", count: longest + 1)
        let pad = value.hasPrefix("`") || value.hasSuffix("`") ? " " : ""
        return marks + pad + value + pad + marks
    }
    static func escapeHtml(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }
    /** Outside inline code: images become plain links and tags plain text. */
    static func inertInline(_ line: String) -> String {
        var out = "", rest = Substring(line), inCode: Substring? = nil
        while !rest.isEmpty {
            if let open = inCode {
                if let close = rest.range(of: open) { out += rest[..<close.upperBound]; rest = rest[close.upperBound...]; inCode = nil }
                else { out += rest; rest = "" }
                continue
            }
            guard let tick = rest.firstIndex(of: "`") else {
                out += rest.replacingOccurrences(of: "![", with: "\\![").replacingOccurrences(of: "<", with: "&lt;"); break
            }
            out += rest[..<tick].replacingOccurrences(of: "![", with: "\\![").replacingOccurrences(of: "<", with: "&lt;")
            var end = tick
            while end < rest.endIndex && rest[end] == "`" { end = rest.index(after: end) }
            let marks = rest[tick..<end]
            out += marks
            rest = rest[end...]
            if rest.contains(marks) { inCode = marks }
        }
        return out
    }
    /** Model text for a file other viewers open: inert outside fences, turn-like headings escaped, an open fence closed. */
    static func inert(_ text: String) -> String {
        var fenceMark: String?, previous = "", lines: [String] = []
        for line in text.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let open = fenceMark {
                if trimmed.hasPrefix(open), trimmed.allSatisfy({ $0 == open.first }) { fenceMark = nil }
                previous = ""; lines.append(line); continue
            }
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                fenceMark = String(line.prefix { $0 == line.first }); previous = ""; lines.append(line); continue
            }
            let heading = trimmed.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)
            let turnWord = ["你", "Agent", "Agent（生成中）"]
            let atx = trimmed.hasPrefix("#") && turnWord.contains(heading.trimmingCharacters(in: CharacterSet(charactersIn: "# ")))
            let setext = !trimmed.isEmpty && (trimmed.allSatisfy { $0 == "=" } || trimmed.allSatisfy { $0 == "-" }) && turnWord.contains(previous.trimmingCharacters(in: .whitespaces))
            previous = line
            lines.append(atx || setext ? "\\" + inertInline(String(line.drop { $0 == " " })) : inertInline(line))
        }
        if let fenceMark { lines.append(fenceMark) }
        return lines.joined(separator: "\n")
    }
    static func toolBlock(_ message: NativeJSON) -> [String] {
        let label = PhoneConversation.toolLabel(message)
        let title = [label.verb, label.object].compactMap { $0 }.joined(separator: " ")
        let state = message["state"].string.flatMap { toolStates[$0] }.map { "（" + $0 + "）" } ?? ""
        var out = ["<details>", "<summary>工具：" + escapeHtml(title.isEmpty ? "工具" : title) + escapeHtml(state) + "</summary>", ""]
        if let name = message["toolName"].string, name != title { out += ["工具名：" + code(name), ""] }
        if let input = message["tool"]["input"].string, !input.isEmpty { out += ["参数：", "", fence(input, language: "json"), ""] }
        for diff in message["tool"]["diffs"].array.prefix(64) { if let path = diff["path"].string { out += ["改动：" + code(path), ""] } }
        if let output = message["tool"]["output"].string ?? message["text"].string, !output.isEmpty { out += ["输出：", "", fence(output), ""] }
        out += ["</details>", ""]
        return out
    }
    public static func transcript(_ detail: NativeJSON, harness: String?, upTo messageId: String? = nil, now: Date = Date()) -> String {
        let summary = detail["summary"]
        var messages = detail["messages"].array
        if let messageId, let index = messages.firstIndex(where: { $0["id"].string == messageId }) { messages = Array(messages[...index]) }
        let title = (summary["title"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var facts: [String] = []
        if let harness, !harness.isEmpty { facts.append("Harness：" + harness) }
        if let model = summary["model"].string, !model.isEmpty { facts.append("模型：" + model) }
        facts.append("模式：" + (summary["mode"].string == "chat" ? "对话" : "Agent"))
        if let cwd = summary["cwd"].string, !cwd.isEmpty { facts.append("项目：" + code(cwd)) }
        facts.append("导出于：" + PhoneTime.message(now, now: now))
        var out = ["# " + (title.isEmpty ? "未命名会话" : title), ""] + facts.map { "- " + $0 } + [""]
        for message in messages {
            let text = message["text"].string ?? ""
            switch message["role"].string {
            case "user": out += ["## 你", "", text, ""]
            case "assistant":
                out += ["## Agent", ""]
                if let reasoning = message["reasoning"].string, !reasoning.isEmpty {
                    out += ["<details>", "<summary>思考过程</summary>", "", inert(reasoning).components(separatedBy: "\n").map { "> " + $0 }.joined(separator: "\n"), "", "</details>", ""]
                }
                if !text.isEmpty { out += [inert(text), ""] }
                let kept = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                if message["state"].string == "cancelled" { out += [kept ? "_已停止，保留了部分回复。_" : "_已停止。_", ""] }
                else if message["state"].string == "failed" { out += [kept ? "_回复中断，保留了部分内容。_" : "_回复中断。_", ""] }
            case "tool": out += toolBlock(message)
            default: out += [inert(text).components(separatedBy: "\n").map { "> " + $0 }.joined(separator: "\n"), ""]
            }
        }
        if messageId == nil, let live = detail["liveText"].string, !live.isEmpty { out += ["## Agent（生成中）", "", inert(live), ""] }
        var result = out.joined(separator: "\n")
        while let last = result.last, last.isWhitespace { result.removeLast() }
        return result + "\n"
    }
}
