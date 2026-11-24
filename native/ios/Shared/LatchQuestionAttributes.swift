import ActivityKit
import Foundation

/** Routing hints are opaque. A public approval can carry only fixed presentation facts. */
struct LatchQuestionAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var approvalOperation: String? = nil
        var approvalManifest: String? = nil
        var approvalCommand: String? = nil
        var approvalTargetCount: Int? = nil
        var approvalFileType: String? = nil
        var approvalFileChange: String? = nil
        var approvalAgent: String? = nil
        var approvalRisk: String? = nil
        var approvalOutsideSandbox: Bool? = nil
        var approvalSession: String? = nil

        private static let manifests: Set<String> = ["package.json", "Package.swift", "pyproject.toml", "Cargo.toml", "go.mod"]
        private static let commands: Set<String> = [
            "pnpm test", "pnpm check:quick", "npm test", "swift test", "swift test --parallel",
            "git status", "git status --short", "git diff", "git diff --stat", "cargo test", "go test ./...", "python -m pytest",
        ]
        private static let files: Set<String> = ["Swift", "TypeScript", "JavaScript", "Python", "Rust", "Go", "JSON", "Markdown", "TOML", "YAML"]
        private static let agents = [
            "codex": "Codex", "claude-agent": "Claude Agent", "pi": "pi", "opencode": "OpenCode", "dsh": "DeepSeek Harness",
            "qwen": "Qwen Code", "goose": "goose", "cursor": "Cursor", "antigravity": "Antigravity", "grok": "Grok Build",
        ]

        var agentName: String? { approvalAgent.flatMap { Self.agents[$0] } }
        var isElevated: Bool { approvalRisk == "elevated" }

        var operation: String? {
            switch approvalOperation {
            case "readFile": "读取文件"
            case "editFile": approvalFileChange == "create" ? "新建文件" : "修改文件"
            case "deleteFile": "删除文件"
            case "moveFile": "移动文件"
            case "search": "搜索内容"
            case "runCommand": approvalOutsideSandbox == true ? "在 Agent 沙箱外运行命令" : "运行命令"
            case "fetch": "获取网络内容"
            case "allowNetwork": "授予联网权限"
            case "grantAccess": "扩大访问权限"
            case "provideInput": "向运行中的命令输入"
            case "reviewPlan": "审阅执行计划"
            default: nil
            }
        }

        var technicalTarget: String? {
            switch approvalOperation {
            case "readFile", "editFile", "deleteFile", "moveFile": approvalManifest.flatMap { Self.manifests.contains($0) ? $0 : nil }
            case "runCommand": approvalCommand.flatMap { Self.commands.contains($0) ? $0 : nil }
            default: nil
            }
        }

        var fileSummary: String? {
            guard technicalTarget == nil, ["readFile", "editFile", "deleteFile", "moveFile"].contains(approvalOperation ?? ""),
                  let count = approvalTargetCount, (1...10_000).contains(count) else { return nil }
            if let type = approvalFileType, Self.files.contains(type) { return "\(count) 个 \(type) 文件" }
            return "\(count) 个文件目标"
        }
    }
    var route: String? = nil
    var ticket: String? = nil
    var approval: Bool? = nil
    func link(reject: Bool = false) -> URL {
        guard let route, let ticket, UUID(uuidString: route) != nil, ticket.count == 32,
              ticket.allSatisfy({ "0123456789abcdef".contains($0) }) else { return Self.link }
        return Self.link.appendingPathComponent(route).appendingPathComponent(ticket).appendingPathComponent(reject ? "reject" : "review")
    }
    static var link: URL { URL(string: LatchLink.scheme + "://pending")! }
}
