import Foundation
import LatchNativeCore
import SwiftUI
import UIKit

/**
 * Canned scenes for screenshots, compiled only into the LatchScreens target. There is no network, no key and no secret
 * here: a launch argument picks the scene (`-LatchScene agents`), and the data below stands in for a Host's answers.
 */
@MainActor enum ScreensStage {
    static let marker = "LatchScreens fixture state"
    static var section: AgentSection?
    static var scanning = false
    static var scene: String { UserDefaults.standard.string(forKey: "LatchScene") ?? "code" }
    private static var locked = false

    static func stage(_ model: PhoneModel) {
        let name = scene
        locked = name == "agents-locked"
        var value = snapshot()
        if locked {
            value = patched(value) { object in
                var device = object["device"]!.object; device["dataScope"] = .string("work"); object["device"] = .object(device)
                object["customAgents"] = nil; object["automations"] = nil
            }
        }
        model.staged = true
        model.snapshot = value
        model.storeReady = true
        model.connected = true
        model.verifiedUntil = .distantFuture
        switch name {
        case "conversation":
            model.tab = .code; model.sessionId = "ses_review"; model.detail = conversation()
        case "agents", "agents-locked": model.tab = .agents
        case "agent-delegate": model.tab = .agents; model.agentPath = [review]; section = .delegate
        case "agent-memory": model.tab = .agents; model.agentPath = [review]; section = .memory
        case "agent-schedules": model.tab = .agents; model.agentPath = [daily]; section = .schedules
        case "agent-settings": model.tab = .agents; model.agentPath = [review]; section = .settings
        case "agent-unavailable": model.tab = .agents; model.agentPath = [docs]; section = .delegate
        case "general": model.tab = .agents; model.agentPath = [PhoneAgents.generalId]; section = .memory
        case "apps": model.tab = .apps
        case "app-page": model.tab = .apps; model.appPath = ["release-check/main"]
        case "pairing": scanning = true
        default: model.tab = .code
        }
    }
    static func read(_ path: String) -> PhoneAgentRead {
        if locked { return .locked }
        let id = String(path.split(separator: "/").last ?? "")
        if id == PhoneAgents.generalId { return .ready(json(general)) }
        if id == review { return .ready(json(reviewDetail)) }
        if id == daily || id == docs { return .ready(json(dailyDetail.replacingOccurrences(of: daily, with: id))) }
        if id == checks { return .ready(json(runs)) }
        return .missing
    }

    private static let review = "agt_5d3f8a10-2c4b-4e7a-9b1c-0a1b2c3d4e5f"
    private static let daily = "agt_7e9a1b20-3d5c-4f8b-8c2d-1b2c3d4e5f60"
    private static let docs = "agt_8f0b2c30-4e6d-4a9c-9d3e-2c3d4e5f6071"
    private static let checks = "auto_9a1c3d40-5f7e-4b0d-8e4f-3d4e5f607182"

    private static func patched(_ value: NativeJSON, _ change: (inout [String: NativeJSON]) -> Void) -> NativeJSON {
        var object = value.object; change(&object); return .object(object)
    }
    private static let stamp: ISO8601DateFormatter = {
        let value = ISO8601DateFormatter(); value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return value
    }()
    /** `{{-300}}` is five minutes ago. */
    private static func json(_ text: String) -> NativeJSON {
        let now = Date()
        var output = text
        while let range = output.range(of: "\\{\\{-?[0-9]+\\}\\}", options: .regularExpression) {
            let seconds = Double(output[range].dropFirst(2).dropLast(2)) ?? 0
            output.replaceSubrange(range, with: stamp.string(from: now.addingTimeInterval(seconds)))
        }
        return (try? NativeJSON.decode(Data(output.utf8))) ?? .null
    }
    private static func snapshot() -> NativeJSON { json(snapshotText) }
    private static func conversation() -> NativeJSON { json(conversationText) }

    private static let harnesses = """
    [{"id":"standard","status":"ready","modes":["agent","chat"],"agentContext":"private","capabilities":{"display":{"label":"Latch","mark":"latch"},"models":{"owner":"latch"},"permission":{"enforcement":"latch"}}},
     {"id":"codex","status":"ready","modes":["agent"],"agentContext":"first-turn","capabilities":{"display":{"label":"Codex","mark":"codex"},"models":{"owner":"harness"},"permission":{"enforcement":"harness"}}},
     {"id":"gemini","status":"missing","modes":["agent"],"agentContext":"first-turn","capabilities":{"display":{"label":"Gemini CLI","mark":"gemini"},"models":{"owner":"harness"},"permission":{"enforcement":"harness"}}}]
    """
    private static var snapshotText: String { """
    {"instanceId":"screens","revision":42,"hostName":"\(marker)","approvals":[],"hostTime":"{{0}}",
     "device":{"id":"dev_screens0000000000000000","status":"active","scopes":["view","run","approve:standard"],"dataScope":"all"},
     "catalog":{"features":{"customAgents":true,"automations":true,"appPages":1,"queue":true},"harnesses":\(harnesses),
      "providers":[{"id":"deepseek","name":"DeepSeek","models":["deepseek-chat","deepseek-reasoner"]}],
      "workspaces":[{"id":"default","name":"默认文件夹","path":"/work"},{"id":"latch","name":"latch","path":"/work/latch"},{"id":"site","name":"官网","path":"/work/site"}],
      "defaults":{"harnessId":"standard","workspaceId":"latch","model":{"providerId":"deepseek","model":"deepseek-chat"}},
      "skills":[{"id":"review","pluginId":"review-kit","pluginName":"审阅","name":"审阅清单","description":""}],"sessionFolders":true},
     "customAgents":[
      {"id":"\(review)","name":"代码审阅","glyph":"glasses","description":"只报真实的问题，按严重程度排","harnessId":"codex","mode":"agent","defaultProjectId":"latch","available":true,"canAutomate":false,"skillCount":1,"memoryCount":2,"sessionCount":3,"revision":3},
      {"id":"\(daily)","name":"每日简报","glyph":"newspaper","description":"每天早上汇总依赖更新与 CI","harnessId":"standard","mode":"chat","model":{"providerId":"deepseek","model":"deepseek-chat"},"available":true,"canAutomate":true,"skillCount":0,"memoryCount":0,"sessionCount":1,"revision":1},
      {"id":"\(docs)","name":"文档整理","glyph":"library","description":"把散落的说明整理进 docs","harnessId":"gemini","mode":"agent","defaultProjectId":"site","available":false,"unavailableReason":"Gemini CLI 现在不能开始：没有安装。","canAutomate":false,"skillCount":0,"memoryCount":0,"sessionCount":0,"revision":1}],
     "automations":[
      {"id":"\(checks)","name":"每日依赖检查","customAgentId":"\(daily)","schedule":{"kind":"weekdays","time":"09:00"},"enabled":true,"state":"ready","revision":2,"notify":true,"nextRunAt":"{{64800}}","lastRun":{"at":"{{-21600}}","state":"completed","trigger":"schedule","sessionId":"ses_daily"}},
      {"id":"auto_0b2d4e50-6a8f-4c1e-9f50-4e5f60718293","name":"周五周报","customAgentId":"\(daily)","schedule":{"kind":"weekly","day":5,"time":"17:30"},"enabled":false,"state":"paused","revision":4,"notify":false,"pause":{"reason":"unknown-outcome","message":"上一次运行的结果未知，确认后再开启。"},"lastRun":{"at":"{{-259200}}","state":"unknown","trigger":"schedule"}}],
     "apps":[
      {"pluginId":"release-check","appId":"main","title":"发布检查","icon":"list-checks","pluginName":"发布检查","version":"1.0.0","revision":"r1","status":"ready","capabilities":{},"dataVersion":1},
      {"pluginId":"standup","appId":"board","title":"站会看板","icon":"calendar","pluginName":"站会","version":"0.3.0","revision":"r2","status":"ready","capabilities":{},"dataVersion":1}],
     "tasks":[
      {"id":"ses_wait","title":"升级 swift-nio 到 2.104","status":"waiting-approval","updatedAt":"{{-120}}","harnessId":"codex","workspaceId":"latch","mode":"agent","branch":"deps/nio"},
      {"id":"ses_review","title":"复核 PhoneAgents 的改动","status":"idle","updatedAt":"{{-900}}","harnessId":"codex","workspaceId":"latch","mode":"agent","agent":{"customAgentId":"\(review)"}},
      {"id":"ses_run","title":"审阅配对页的粘贴入口","status":"running","updatedAt":"{{-30}}","harnessId":"codex","workspaceId":"latch","mode":"agent","agent":{"customAgentId":"\(review)"},"live":{"activity":"model","runStartedAt":"{{-95}}","lastEventAt":"{{-5}}"}},
      {"id":"ses_old","title":"检查 relay 的超时","status":"idle","runOutcome":"failed","updatedAt":"{{-180000}}","harnessId":"codex","workspaceId":"latch","mode":"agent","agent":{"customAgentId":"\(review)"}},
      {"id":"ses_daily","title":"每日依赖检查","status":"idle","updatedAt":"{{-21000}}","harnessId":"standard","mode":"chat","agent":{"customAgentId":"\(daily)"},"automationId":"\(checks)"},
      {"id":"ses_site","title":"官网首页换新截图","status":"idle","updatedAt":"{{-86400}}","harnessId":"standard","workspaceId":"site","mode":"agent"}]}
    """ }
    private static var conversationText: String { """
    {"summary":{"id":"ses_review","title":"复核 PhoneAgents 的改动","status":"idle","harnessId":"codex","workspaceId":"latch","mode":"agent","agent":{"customAgentId":"\(review)"},"branch":"step/ios-nav"},
     "sync":{"instanceId":"screens","revision":42},"approvals":[],"questions":[],"queue":[],
     "messages":[
      {"id":"m1","role":"user","text":"看一下 PhoneAgents 的改动，只报真实的问题。","createdAt":"{{-1000}}"},
      {"id":"m2","role":"assistant","text":"读完了。一处需要改：委托的模型只在 Harness 用 Latch 的模型服务时才发送，其余都符合 Host 的规则。","createdAt":"{{-940}}"}]}
    """ }
    private static var reviewDetail: String { """
    {"agent":{"id":"\(review)","name":"代码审阅","glyph":"glasses","description":"只报真实的问题，按严重程度排","harnessId":"codex","mode":"agent","defaultProjectId":"latch","available":true,"revision":3,
      "instructions":"先读改动涉及的源码与测试，再下结论。\\n只报会出错的地方，每条写清复现方法。","skills":["review-kit:review"],"createdAt":"{{-864000}}","updatedAt":"{{-3600}}"},
     "memories":[
      {"id":"mem_1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","content":"这个仓库用 pnpm，不要建议 npm 命令。","revision":1,"createdAt":"{{-600000}}","updatedAt":"{{-600000}}"},
      {"id":"mem_2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e","content":"Swift 代码按 native/ios/AGENTS.md 的规则审：写入超时保持结果未知。","revision":2,"createdAt":"{{-300000}}","updatedAt":"{{-7200}}"}],
     "sessions":[]}
    """ }
    private static var dailyDetail: String { """
    {"agent":{"id":"\(daily)","name":"每日简报","glyph":"newspaper","description":"每天早上汇总依赖更新与 CI","harnessId":"standard","mode":"chat","model":{"providerId":"deepseek","model":"deepseek-chat"},"available":true,"revision":1,
      "instructions":"汇总昨晚以来的依赖更新与失败的 CI。","skills":[],"tools":[],"createdAt":"{{-864000}}","updatedAt":"{{-864000}}"},
     "memories":[],"sessions":[]}
    """ }
    private static let general = """
    {"general":{"id":"general","instructions":"回答用中文，先给结论。","revision":2},
     "memories":[{"id":"mem_3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f","content":"我在东京时区工作。","revision":1,"createdAt":"{{-900000}}","updatedAt":"{{-900000}}"}]}
    """
    private static let runs = """
    {"automation":{"id":"auto_9a1c3d40-5f7e-4b0d-8e4f-3d4e5f607182","name":"每日依赖检查"},
     "runs":[{"at":"{{-21600}}","state":"completed","trigger":"schedule","sessionId":"ses_daily"},{"at":"{{-108000}}","state":"missed","trigger":"schedule"},
      {"at":"{{-180000}}","state":"failed","trigger":"manual"},{"at":"{{-194400}}","state":"completed","trigger":"schedule"}]}
    """
}

@main struct ScreensApp: App {
    @StateObject private var model = PhoneModel()
    /** `-LatchTheme dark` or `light`; absent: the device's own. */
    private var theme: ColorScheme? {
        switch UserDefaults.standard.string(forKey: "LatchTheme") { case "dark": .dark; case "light": .light; default: nil }
    }
    var body: some Scene {
        WindowGroup {
            PhoneRootView().environmentObject(model).tint(.blue).preferredColorScheme(theme)
                .task { ScreensStage.stage(model); ScreensStage.fitWindow() }
        }
    }
}

extension ScreensStage {
    /** On a Mac, `-LatchWidth` and `-LatchHeight` fix the window to a device's size in points. */
    static func fitWindow() {
        #if targetEnvironment(macCatalyst)
        let width = UserDefaults.standard.double(forKey: "LatchWidth"), height = UserDefaults.standard.double(forKey: "LatchHeight")
        guard width > 0, height > 0 else { return }
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            scene.sizeRestrictions?.minimumSize = CGSize(width: width, height: height)
            scene.sizeRestrictions?.maximumSize = CGSize(width: width, height: height)
        }
        #endif
    }
}
