import Foundation
import LatchNativeCore
import SwiftUI
import UIKit

/**
 * Canned scenes for screenshots, compiled only into the LatchScreens target. There is no network, no key and no secret
 * here: a launch argument picks the scene (`-LatchScene agents`), and the data below stands in for a Host's answers.
 * Live mode (`LiveKeys.swift`) skips the scenes and talks to a real test Host.
 */
@MainActor enum ScreensStage {
    static let marker = "LatchScreens fixture state"
    /** The Agent scenes: the profile sheet open (at 动态 or 记忆) or a new topic shown. */
    static var profile = false
    static var profilePart: AgentProfileSheet.Part?
    /** The profile scrolled to 「电脑」, at full height. */
    static var profileComputer = false
    static var scanning = false
    /** The list's search field, for the 内容中包含 scene. */
    static var query = ""
    static var scene: String { UserDefaults.standard.string(forKey: "LatchScene") ?? "code" }
    private static var locked = false

    static func stage(_ model: PhoneModel) {
        let name = scene
        locked = name == "agents-locked"
        var value = snapshot()
        if locked {
            value = patched(value) { object in
                var device = object["device"]!.object; device["dataScope"] = .string("work"); object["device"] = .object(device)
                object["customAgents"] = nil; object["agentChats"] = nil; object["automations"] = nil
            }
        }
        model.staged = true
        model.snapshot = value
        model.storeState = .ready
        model.connected = true
        model.verifiedUntil = .distantFuture
        _ = model.privateSnapshot.adopt(model.snapshot, captured: model.privateSnapshot.epoch, windowOpen: true)
        switch name {
        case "question-reminder":
            stageQuestionReminder(model)
        case "session-team":
            model.snapshot = sessionTeamSnapshot(value)
        case "workspace", "workspace-offline":
            model.snapshot = workSnapshot()
            if name == "workspace-offline" { stageDisconnected(model) }
        case "harness-menu":
            creating = true
            let names = [("standard", "Latch 内置"), ("codex", "Codex"), ("claude-agent", "Claude Agent"),
                ("qwen", "Qwen Code"), ("goose", "goose"), ("cursor", "Cursor"),
                ("pi", "pi"), ("dsh", "DeepSeek Harness"), ("opencode", "OpenCode"), ("grok", "Grok Build"), ("antigravity", "Antigravity")]
            model.snapshot = patched(model.snapshot) { object in
                var catalog = object["catalog"]!.object
                let original = catalog["harnesses"]!.array
                let prototype = original.first { $0["id"].string == "codex" } ?? original[0]
                catalog["harnesses"] = .array(names.map { id, name in
                    patched(prototype) { harness in
                        harness["id"] = .string(id); harness["name"] = .string(name)
                        var capabilities = harness["capabilities"]!.object
                        capabilities["display"] = .object(["label": .string(name), "mark": .string(id == "standard" ? "latch" : id)])
                        harness["capabilities"] = .object(capabilities)
                    }
                })
                object["catalog"] = .object(catalog)
            }
        case "conversation":
            model.tab = .code; model.sessionId = "ses_review"; model.detail = conversation()
        case "conversation-reading", "project-files":
            if name == "project-files" {
                model.snapshot = patched(value) { root in
                    root["catalog"] = patched(value["catalog"]) { catalog in
                        catalog["features"] = patched(value["catalog"]["features"]) { $0["fileTree"] = .bool(true); $0["fileSearch"] = .bool(true) }
                    }
                }
            }
            model.tab = .agents; model.agentPath = [review]; model.sessionId = "ses_review"
            model.detail = patched(conversation()) { detail in
                let notes = [
                    ("配对", "在 Mac 创建邀请，在手机确认显示的是预期的电脑。完成后回到会话列表。"),
                    ("项目", "分别展开两个项目，记下它们最近更新的会话。收起其中一个，确认仍能打开另一个项目里的会话。"),
                    ("搜索", "按会话标题搜索，进入一个结果，再回到列表清除搜索。"),
                    ("阅读", "打开较长的回复，向上翻到较早的段落，逐段检查文字是否完整。"),
                    ("草稿", "输入几行文字，收起键盘阅读前文，再点回输入框继续写。"),
                    ("切换", "到另一个会话看最新的回复，再返回之前的会话，检查草稿仍在原处。"),
                    ("待办", "打开等你处理的待办，从讨论进入关联会话，再返回原来读到的位置。"),
                    ("离线", "断开测试电脑的连接，确认手机显示离线。恢复连接后，检查任务的最新状态。"),
                ]
                detail["messages"] = .array([
                    .object(["id": .string("early-question"), "role": .string("user"), "text": .string("先看哪个项目？")]),
                    .object(["id": .string("early-reply"), "role": .string("assistant"), "text": .string("先看手机工作台。")]),
                    .object(["id": .string("next-question"), "role": .string("user"), "text": .string("需要核对哪些页面？")]),
                    .object(["id": .string("next-reply"), "role": .string("assistant"), "text": .string("会话、待办和文件。")]),
                    .object(["id": .string("checklist-request"), "role": .string("user"), "text": .string("把手机验收的步骤整理给我。")]),
                    .object(["id": .string("checklist-reply"), "role": .string("assistant"),
                        "text": .string(notes.map { "**\($0.0)**\n\n\($0.1)" }.joined(separator: "\n\n") + "\n\n以上八项都可以在测试项目里检查。")]),
                ])
            }
        case "conversation-actions":
            model.tab = .code; model.sessionId = "ses_actions"; model.detail = json(actionsText)
        case "subagents":
            model.tab = .code; model.sessionId = "ses_actions"; _ = model.subagentStops.begin("m3")
            model.snapshot = patched(model.snapshot) { object in
                object["tasks"] = .array(object["tasks"]!.array.map { task in task["id"].string == "ses_actions" ? patched(task) { $0["status"] = .string("running") } : task })
            }
            model.detail = json(actionsText.replacingOccurrences(of: "\"status\":\"idle\",\"harnessId\"", with: "\"status\":\"running\",\"harnessId\"")
                .replacingOccurrences(of: "\"clearContext\":true", with: "\"runStartedAt\":\"{{-80}}\""))
        case "steer":
            model.tab = .code; model.sessionId = "ses_run"; model.detail = json(steerText); model.heldDrafts["ses_run"] = "顺便看一下测试有没有覆盖粘贴"
        case "clearing":
            model.tab = .code; model.sessionId = "ses_review"; model.detail = conversation(); model.clearing = ["ses_review"]
        case "approval-more":
            model.tab = .code; model.sessionId = "ses_wait"; model.detail = json(approvalText)
        case "approval-hidden":
            model.tab = .code; model.sessionId = "ses_wait"
            model.detail = json(approvalText.replacingOccurrences(of: "\"locations\":[\"native/ios/Package.swift\"]}", with: "\"locations\":[\"native/ios/Package\u{200B}.swift\"]}")
                .replacingOccurrences(of: "{\"id\":\"once\",\"kind\":\"allow_once\",\"label\":\"允许一次\"},", with: ""))
        case "fork":
            model.tab = .code; model.sessionId = "ses_actions"; model.detail = json(actionsText)
            model.forkDraft = PhoneForkDraft(taskId: "ses_actions", upToMessageId: "m5", title: "让 relay 的超时可配置", turn: 1)
        case "rename":
            model.tab = .code; model.renaming = value["tasks"].array.first { $0["id"].string == "ses_site" }
        case "delete":
            model.tab = .code; model.deleting = value["tasks"].array.first { $0["id"].string == "ses_site" }
        case "archived": model.tab = .code; model.showArchived = true
        case "search":
            model.tab = .code; query = "relay"
            model.contentSearch = PhoneContentSearch(query: "relay", hits: PhoneSearch.results(json(hitsText)).hits, truncated: false)
        case "agents", "agents-locked": model.tab = .agents
        case "agents-loading":
            model.tab = .agents
            model.snapshot = PhoneAgents.withoutPrivate(model.snapshot)
            model.privateSnapshot.clear()
            model.openingAgentsFor = model.generation
        case "agents-faces":
            // Every state a face shows: 运行中 (代码审阅), 等你处理 (每日简报), 休息 (文档整理) and 失败 (发布检查).
            model.tab = .agents
            model.snapshot = patched(model.snapshot) { object in
                object["customAgents"] = .array(object["customAgents"]!.array + [json(releaseAgent)])
                object["tasks"] = .array(object["tasks"]!.array + [json(waitingTask), json(failedTask)])
            }
        case "agent-chat", "agent-profile", "agent-memory":
            // 代码审阅's current topic, with a 「记住…」 proposal after its turn and one from outside content.
            model.tab = .agents; model.agentPath = [review]
            model.snapshot = patched(model.snapshot) { object in
                object["tasks"] = .array(object["tasks"]!.array.map { task in task["id"].string == "ses_review" ? patched(task) { $0["updatedAt"] = .string(stamp.string(from: Date().addingTimeInterval(-10))) } : task })
            }
            model.sessionId = "ses_review"; model.detail = conversation()
            var store = PhoneProposalStore(); let token = store.begin(review); store.finish(review, token: token, list: json(proposalsText), windowOpen: true); model.proposals = store
            profile = name != "agent-chat"; profilePart = name == "agent-memory" ? .memory : .activity
        case "agent-new":
            model.tab = .agents; model.agentPath = [review]; chat(model, owner: review, session: nil)
        case "agent-waiting":
            model.tab = .agents; model.agentPath = [daily]
            model.snapshot = patched(model.snapshot) { object in object["tasks"] = .array(object["tasks"]!.array + [json(waitingTask)]) }
            chat(model, owner: daily, session: "ses_brief")
            model.sessionId = "ses_brief"
            model.detail = json(approvalText.replacingOccurrences(of: "\"id\":\"ses_wait\",\"title\":\"升级 swift-nio 到 2.104\"", with: "\"id\":\"ses_brief\",\"title\":\"汇总本周依赖更新\""))
        case "agent-schedules": model.tab = .agents; model.agentPath = [daily]; profile = true; profilePart = .activity
        case "agent-computer":
            // 每日简报 with two missed times of one schedule, kept awake for a schedule, and its 完成 notification off.
            model.tab = .agents; model.agentPath = [daily]; profile = true; profilePart = .activity; profileComputer = true
            model.snapshot = patched(model.snapshot) { object in
                object["computer"] = json(#"{"desktop":true,"keepAwake":"schedule","wokeAt":"{{-10800}}"}"#)
                object["customAgents"] = .array(object["customAgents"]!.array.map { agent in
                    agent["id"].string == daily ? patched(agent) { $0["notifications"] = json(#"{"completed":false,"failed":true,"waiting":true}"#); $0["keepAwakeForSchedules"] = .bool(true) } : agent
                })
            }
        case "agent-results", "agent-activity", "agent-library":
            // 每日简报's topic with its runs' cards (one more than a place shows), a failure 立即运行 can retry, and a schedule proposal.
            model.tab = .agents; model.agentPath = [daily]
            model.snapshot = patched(model.snapshot) { object in object["tasks"] = .array(object["tasks"]!.array + [json(dailyTopic)]) }
            chat(model, owner: daily, session: "ses_daily_talk")
            model.sessionId = "ses_daily_talk"; model.detail = json(dailyConversation)
            var store = PhoneProposalStore(); let token = store.begin(daily); store.finish(daily, token: token, list: json(scheduleProposals), windowOpen: true); model.proposals = store
            profile = name != "agent-results"; profilePart = name == "agent-library" ? .library : .activity
        case "agent-unavailable": model.tab = .agents; model.agentPath = [docs]
        case "general": model.tab = .agents; model.agentPath = [PhoneAgents.generalId]
        case "apps": model.tab = .apps
        case "app-page": model.tab = .apps; model.appPath = ["release-check/main"]
        case "pairing": scanning = true
        case _ where stageComputers(model, name): break
        case _ where stageWork(model, name): break
        case _ where stageReview(model, name, snapshot: value): break
        case _ where stageHistory(model, name, snapshot: value): break
        case _ where stageAttachments(model, name): break
        default: model.tab = .code
        }
    }
    /** The composer's attachments in each state, the reason ＋ gives, a held-back follow-up, the new-session sheet and sent chips. */
    fileprivate static func stageAttachments(_ model: PhoneModel, _ name: String) -> Bool {
        guard name.hasPrefix("attach") else { return false }
        model.tab = .code
        let both = PhoneAttachCaps(images: true, text: true, textBytes: 262_144, fileBytes: PhoneAttachments.largestFile, imageBytes: 5_242_880, files: true)
        func photo(_ hue: CGFloat) -> Data {
            UIGraphicsImageRenderer(size: CGSize(width: 120, height: 90)).image { context in
                UIColor(hue: hue, saturation: 0.35, brightness: 0.85, alpha: 1).setFill(); context.fill(CGRect(x: 0, y: 0, width: 120, height: 90))
                UIColor(hue: hue, saturation: 0.5, brightness: 0.6, alpha: 1).setFill(); context.fill(CGRect(x: 0, y: 55, width: 120, height: 35))
            }.jpegData(compressionQuality: 0.8) ?? Data()
        }
        func ref(_ id: String, _ name: String, image: Bool, size: Int) -> NativeJSON {
            .object(["id": .string(id), "name": .string(name), "mime": .string(image ? "image/jpeg" : "text/plain"), "kind": .string(image ? "image" : "text"),
                "size": .number(Double(size)), "sha256": .string(String(repeating: "a", count: 64))])
        }
        func tray(_ rows: [(String, PhoneAttachKind, PhoneAttachStatus)]) -> PhoneAttachTray {
            var tray = PhoneAttachTray()
            for (index, row) in rows.enumerated() {
                let data = row.1 == .image ? photo(CGFloat(index) * 0.17 + 0.55) : Data(repeating: 0x61, count: row.1 == .file ? 2_400_000 : 18_000)
                guard let file = try? PhoneAttachStage.write(data) else { continue }
                let draft = PhoneAttachDraft(name: row.0, kind: row.1, file: file, thumbnail: row.1 == .image ? PhoneImagePrep.thumbnail(data) : nil)
                _ = tray.add(draft)
                if row.2 == .ready { _ = tray.ready(draft.id, ref: ref(String(format: "att%019d", index), row.0, image: row.1 == .image, size: draft.size)) }
                else { tray.set(draft.id, row.2) }
            }
            return tray
        }
        switch name {
        case "attach":
            model.sessionId = "ses_review"; model.detail = conversation()
            model.attachStates["ses_review"] = PhoneAttachState(revision: "staged", caps: both)
            model.attachTrays["ses_review"] = tray([("IMG_0412.jpg", .image, .ready), ("spec.pdf", .file, .uploading(0.6)),
                ("IMG_0413.jpg", .image, .unknown), ("demo.mov", .file, .refused("每个文件最多 50 MB。")), ("build.log", .text, .ready)])
            model.heldDrafts["ses_review"] = "这两张截图里按钮的间距不一样，看看是哪里的样式"
        case "attach-unavailable":
            model.sessionId = "ses_review"; model.detail = conversation()
            model.attachStates["ses_review"] = PhoneAttachState(revision: "staged",
                caps: PhoneAttachCaps(images: false, text: false, textBytes: 0, reason: "这个 Harness 不接收图片和文件。"))
            var held = PhoneAttachTray(); held.note = "这个 Harness 不接收图片和文件。"; model.attachTrays["ses_review"] = held
        case "attach-held":
            model.sessionId = "ses_run"; model.detail = json(steerText)
            model.attachStates["ses_run"] = PhoneAttachState(revision: "staged", caps: both)
            model.attachTrays["ses_run"] = tray([("IMG_0420.jpg", .image, .ready)])
            model.heldDrafts["ses_run"] = "顺便看一下这张截图"
        case "attach-new":
            creating = true
            model.attachStates[PhoneModel.newSessionTray] = PhoneAttachState(revision: "staged", caps: both)
            model.attachTrays[PhoneModel.newSessionTray] = tray([("IMG_0431.jpg", .image, .ready), ("crash.txt", .text, .ready)])
        case "attach-topic":
            model.tab = .agents; model.agentPath = [review]; chat(model, owner: review, session: nil)
            let key = PhoneModel.topicTray(review)
            model.attachStates[key] = PhoneAttachState(revision: "staged", caps: both)
            var held = tray([("IMG_0440.jpg", .image, .ready), ("trace.log", .text, .uploading(0.4))]); held.note = PhoneAttachments.pickedNothing
            model.attachTrays[key] = held
        case "attach-sent":
            model.sessionId = "ses_review"
            model.detail = json(conversationText.replacingOccurrences(of: #""text":"看一下 PhoneAgents 的改动，只报真实的问题。","#,
                with: #""text":"看一下这两个附件里的问题。","attachments":[{"id":"att0000000000000000001","name":"IMG_0412.jpg","mime":"image/jpeg","kind":"image","size":412000,"sha256":"\#(String(repeating: "a", count: 64))","width":2048,"height":1536},{"id":"att0000000000000000002","name":"build.log","mime":"text/plain","kind":"text","size":18000,"sha256":"\#(String(repeating: "b", count: 64))"},{"id":"att0000000000000000003","name":"spec.pdf","mime":"application/pdf","kind":"file","size":2400000,"sha256":"\#(String(repeating: "c", count: 64))"}],"#))
        default: return false
        }
        return true
    }
    static func read(_ path: String) -> PhoneAgentRead {
        if locked { return .locked }
        if path.contains("/activity") { return .ready(json(activityText)) }
        if path.contains("/library") { return .ready(json(libraryText)) }
        if path.hasSuffix("/results") { return .ready(json(#"{"results":[]}"#)) }
        if path.hasSuffix("/computer") { return .ready(json(path.contains(daily) ? computerText : #"{"computer":{"desktop":true},"missed":[]}"#)) }
        if path.hasSuffix("/proposals") {
            return .ready(path.contains(review) ? json(proposalsText) : path.contains(daily) ? json(scheduleProposals) : json(#"{"proposals":[]}"#))
        }
        let id = String(path.split(separator: "/").last ?? "")
        if id == PhoneAgents.generalId { return .ready(json(general)) }
        if id == review { return .ready(json(reviewDetail)) }
        if id == daily || id == docs { return .ready(json(dailyDetail.replacingOccurrences(of: daily, with: id))) }
        if id == checks { return .ready(json(runs)) }
        return .missing
    }

    private static var computerText: String { """
    {"computer":{"desktop":true,"keepAwake":"schedule","wokeAt":"{{-10800}}"},
     "missed":[{"automationId":"\(checks)","name":"每日依赖检查","at":"{{-14400}}","cause":"sleep"},
      {"automationId":"\(checks)","name":"每日依赖检查","at":"{{-100800}}","cause":"unknown"}]}
    """ }
    private static var releaseAgent: String { """
    {"id":"\(release)","name":"发布检查","avatar":{"kind":"face","bracket":"angle","eyes":"sleepy","hue":"wisteria"},"description":"发版前过一遍清单","harnessId":"standard","mode":"agent","defaultProjectId":"latch","available":true,"canAutomate":true,"skillCount":0,"memoryCount":0,"sessionCount":1,"revision":1}
    """ }
    private static var waitingTask: String { """
    {"id":"ses_brief","title":"汇总本周依赖更新","status":"waiting-approval","updatedAt":"{{-60}}","harnessId":"standard","mode":"chat","agent":{"customAgentId":"\(daily)"}}
    """ }
    private static var failedTask: String { """
    {"id":"ses_release","title":"0.4 发版检查","status":"failed","updatedAt":"{{-3000}}","harnessId":"standard","workspaceId":"latch","mode":"agent","agent":{"customAgentId":"\(release)"}}
    """ }
    private static let release = "agt_9a1c3d40-5f7e-4b0d-8e4f-3d4e5f607183"
    private static let review = "agt_5d3f8a10-2c4b-4e7a-9b1c-0a1b2c3d4e5f"
    private static let daily = "agt_7e9a1b20-3d5c-4f8b-8c2d-1b2c3d4e5f60"
    private static let docs = "agt_8f0b2c30-4e6d-4a9c-9d3e-2c3d4e5f6071"
    private static let checks = "auto_9a1c3d40-5f7e-4b0d-8e4f-3d4e5f607182"

    static func fileMatches(_ query: String) throws -> PhoneFileMatches {
        let paths = ["文档/验收步骤.md", "README.md"].filter { $0.localizedCaseInsensitiveContains(query) }
        return try PhoneFileMatches(.object(["files": .array(paths.map { path in
            .object(["root": .string("default"), "name": .string(String(path.split(separator: "/").last!)), "path": .string(path)])
        }), "truncated": .bool(false)]))
    }

    static func fileDirectory(session: String, folder: PhoneFileFolder) throws -> PhoneFileDirectory {
        guard scene == "project-files", session == "ses_review" else { throw NativeFailure.unavailable }
        var value = json(#"{"context":{"kind":"session","sessionId":"ses_review"},"roots":[{"id":"default","name":"移动工作台"}],"entries":[],"truncated":false}"#).object
        if let root = folder.root {
            value["rootId"] = .string(root); value["dir"] = .string(folder.dir)
            let files = folder.dir == "" ? [("文档", "directory"), ("README.md", "file")] : [("验收步骤.md", "file")]
            value["entries"] = .array(files.map { .object(["name": .string($0.0), "kind": .string($0.1)]) })
        }
        return try PhoneFileDirectory(.object(value), session: session, folder: folder)
    }

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
    private static func chat(_ model: PhoneModel, owner: String, session: String?) {
        model.snapshot = patched(model.snapshot) { value in
            var chats = value["agentChats"]?.object ?? [:]
            chats[owner] = .object(session.map { ["state": .string("ready"), "sessionId": .string($0)] } ?? ["state": .string("empty")])
            value["agentChats"] = .object(chats)
        }
    }
    private static func snapshot() -> NativeJSON { json(snapshotText) }
    private static func conversation() -> NativeJSON { json(conversationText) }

    private static let harnesses = """
    [{"id":"standard","status":"ready","modes":["agent","chat"],"agentContext":"private","capabilities":{"display":{"label":"Latch","mark":"latch"},"models":{"owner":"latch"},"permission":{"enforcement":"latch"}}},
     {"id":"codex","status":"ready","modes":["agent"],"agentContext":"first-turn","capabilities":{"display":{"label":"Codex","mark":"codex"},"models":{"owner":"harness"},"permission":{"enforcement":"harness"}}},
     {"id":"qwen","status":"missing","modes":["agent"],"agentContext":"first-turn","capabilities":{"display":{"label":"Qwen Code","mark":"qwen"},"models":{"owner":"harness"},"permission":{"enforcement":"harness"}}}]
    """
    private static var snapshotText: String { """
    {"instanceId":"screens","revision":42,"hostName":"\(marker)","approvals":[],"hostTime":"{{0}}",
     "device":{"id":"dev_screens0000000000000000","status":"active","scopes":["view","run","approve:standard"],"dataScope":"all"},
     "catalog":{"features":{"customAgents":true,"singleAgentChat":true,"automations":true,"appPages":1,"queue":true,"fork":true,"search":true},"harnesses":\(harnesses),
      "providers":[{"id":"deepseek","name":"DeepSeek","models":["deepseek-chat","deepseek-reasoner"]}],
      "workspaces":[{"id":"default","name":"默认文件夹","path":"/work"},{"id":"latch","name":"latch","path":"/work/latch"},{"id":"site","name":"官网","path":"/work/site"}],
      "defaults":{"harnessId":"standard","workspaceId":"latch","model":{"providerId":"deepseek","model":"deepseek-chat"}},
      "skills":[{"id":"review","pluginId":"review-kit","pluginName":"审阅","name":"审阅清单","description":""}],"sessionFolders":true},
     "agentChats":{"general":{"state":"empty"},"\(review)":{"state":"ready","sessionId":"ses_review"},"\(daily)":{"state":"empty"},"\(docs)":{"state":"empty"}},
     "customAgents":[
      {"id":"\(review)","name":"代码审阅","avatar":{"kind":"face","bracket":"curly","eyes":"dot","hue":"pine"},"description":"只报真实的问题，按严重程度排","harnessId":"codex","mode":"agent","defaultProjectId":"latch","available":true,"canAutomate":false,"skillCount":1,"memoryCount":2,"sessionCount":3,"revision":3},
      {"id":"\(daily)","name":"每日简报","avatar":{"kind":"face","bracket":"round","eyes":"arc","hue":"slate"},"description":"每天早上汇总依赖更新与 CI","harnessId":"standard","mode":"chat","model":{"providerId":"deepseek","model":"deepseek-chat"},"available":true,"canAutomate":true,"skillCount":0,"memoryCount":0,"sessionCount":1,"revision":1},
      {"id":"\(docs)","name":"文档整理","avatar":{"kind":"face","bracket":"square","eyes":"oval","hue":"cocoa"},"description":"把散落的说明整理进 docs","harnessId":"qwen","mode":"agent","defaultProjectId":"site","available":false,"unavailableReason":"Qwen Code 现在不能开始：没有安装。","canAutomate":false,"skillCount":0,"memoryCount":0,"sessionCount":0,"revision":1}],
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
      {"id":"ses_site","title":"官网首页换新截图","status":"idle","updatedAt":"{{-86400}}","harnessId":"standard","workspaceId":"site","mode":"agent"},
      {"id":"ses_actions","title":"让 relay 的超时可配置","status":"idle","updatedAt":"{{-400}}","harnessId":"codex","workspaceId":"latch","mode":"agent","level":"L3","pinned":true},
      {"id":"ses_arch1","title":"整理旧的配对文档","status":"idle","archived":true,"updatedAt":"{{-400000}}","harnessId":"standard","workspaceId":"site","mode":"agent"},
      {"id":"ses_arch2","title":"试验 relay 的 v2 填充","status":"idle","archived":true,"runOutcome":"failed","updatedAt":"{{-900000}}","harnessId":"codex","workspaceId":"latch","mode":"agent"}]}
    """ }
    private static var conversationText: String { """
    {"summary":{"id":"ses_review","title":"复核 PhoneAgents 的改动","status":"idle","harnessId":"codex","workspaceId":"latch","mode":"agent","agent":{"customAgentId":"\(review)"},"branch":"step/ios-nav"},
     "sync":{"instanceId":"screens","revision":42},"approvals":[],"questions":[],"queue":[],
     "messages":[
      {"id":"m1","role":"user","text":"看一下 PhoneAgents 的改动，只报真实的问题。","createdAt":"{{-1000}}"},
      {"id":"m2","role":"assistant","text":"读完了。一处需要改：委托的模型只在 Harness 用 Latch 的模型服务时才发送，其余都符合 Host 的规则。","createdAt":"{{-940}}"}]}
    """ }
    private static var actionsText: String { """
    {"summary":{"id":"ses_actions","title":"让 relay 的超时可配置","status":"idle","harnessId":"codex","workspaceId":"latch","mode":"agent","level":"L3","branch":"relay/timeout",
      "forkOf":{"taskId":"ses_review","title":"复核 PhoneAgents 的改动","turn":1,"upToMessageId":"m2","prefixLength":0}},
     "sync":{"instanceId":"screens","revision":42},"approvals":[],"questions":[],"queue":[],"clearContext":true,
     "permission":{"modeTiers":{"read-only":{"tier":"plan"},"default":{"tier":"ask"},"auto":{"tier":"model"},"full":{"tier":"never"}},"defaultMode":"default","readback":"mode"},
     "config":[{"id":"mode","category":"mode","currentValue":"default","options":[{"value":"read-only","name":"Read only"},{"value":"default","name":"Default"},{"value":"auto","name":"Auto"},{"value":"full","name":"Full access"}]},
      {"id":"model","category":"model","currentValue":"gpt-5.5","options":[{"value":"gpt-5.5","name":"gpt-5.5"},{"value":"gpt-5.5-mini","name":"gpt-5.5-mini"}]},
      {"id":"effort","category":"thought_level","currentValue":"medium","options":[{"value":"low","name":"低"},{"value":"medium","name":"中"},{"value":"high","name":"高"}]}],
     "messages":[
      {"id":"m1","role":"user","text":"把 relay 的连接超时做成可配置，并补测试。","createdAt":"{{-700}}"},
      {"id":"m2","role":"tool","toolName":"task","state":"running","subagent":{"title":"跑测试","status":"running","stoppable":true,"steps":[{"id":"x1","role":"tool","toolName":"shell","tool":{"kind":"execute","input":"{\\"command\\":\\"swift test\\"}"}}]}},
      {"id":"m3","role":"tool","toolName":"task","state":"running","subagent":{"title":"检查格式","status":"running","stoppable":true,"steps":[]}},
      {"id":"m4","role":"tool","toolName":"task","state":"completed","subagent":{"title":"读文档","status":"done","steps":[]}},
      {"id":"m5","role":"assistant","text":"超时现在从 relay.json 读取，默认 15 秒；测试覆盖了缺省值和越界值。","createdAt":"{{-500}}"}]}
    """ }
    private static var steerText: String { """
    {"summary":{"id":"ses_run","title":"审阅配对页的粘贴入口","status":"running","harnessId":"codex","workspaceId":"latch","mode":"agent","level":"L3","live":{"activity":"model","runStartedAt":"{{-95}}","lastEventAt":"{{-5}}"}},
     "sync":{"instanceId":"screens","revision":42},"approvals":[],"questions":[],"queue":[],"steer":true,"runStartedAt":"{{-95}}",
     "messages":[{"id":"r1","role":"user","text":"审阅配对页新加的粘贴入口。","createdAt":"{{-100}}"},
      {"id":"r2","role":"tool","toolName":"read","state":"completed","tool":{"kind":"read","locations":["native/ios/App/Pairing/PairingView.swift"]}}]}
    """ }
    private static var approvalText: String { """
    {"summary":{"id":"ses_wait","title":"升级 swift-nio 到 2.104","status":"waiting-approval","harnessId":"codex","workspaceId":"latch","mode":"agent","branch":"deps/nio"},
     "sync":{"instanceId":"screens","revision":42},"questions":[],"queue":[],
     "approvals":[{"id":"apr_1","risk":"R1","toolName":"write_file","tool":{"toolTitle":"编辑","locations":["native/ios/Package.swift"]},
       "options":[{"id":"once","kind":"allow_once","label":"允许一次"},{"id":"always","kind":"allow_always","label":"始终允许"},{"id":"no","kind":"reject_once","label":"拒绝"},{"id":"never","kind":"reject_always","label":"始终拒绝"}]}],
     "messages":[{"id":"w1","role":"user","text":"把 swift-nio 升到 2.104，跑一遍测试。","createdAt":"{{-200}}"},
      {"id":"w2","role":"tool","toolName":"write_file","state":"awaiting-approval","tool":{"toolTitle":"编辑","locations":["native/ios/Package.swift"]}}]}
    """ }
    private static let hitsText = """
    {"hits":[{"sessionId":"ses_old","messageId":"h1","title":"检查 relay 的超时","snippet":"连接在 relay 握手后 15 秒没有数据就断开","match":{"start":4,"end":9},"archived":false},
     {"sessionId":"ses_arch2","messageId":"h2","title":"试验 relay 的 v2 填充","snippet":"relay 外层填充改为 v2 之后","match":{"start":0,"end":5},"archived":true}],"truncated":false}
    """
    private static var reviewDetail: String { """
    {"agent":{"id":"\(review)","name":"代码审阅","avatar":{"kind":"face","bracket":"curly","eyes":"dot","hue":"pine"},"description":"只报真实的问题，按严重程度排","harnessId":"codex","mode":"agent","defaultProjectId":"latch","available":true,"revision":3,
      "instructions":"先读改动涉及的源码与测试，再下结论。\\n只报会出错的地方，每条写清复现方法。","skills":["review-kit:review"],"createdAt":"{{-864000}}","updatedAt":"{{-3600}}"},
     "memories":[
      {"id":"mem_1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","content":"这个仓库用 pnpm，不要建议 npm 命令。","revision":1,"createdAt":"{{-600000}}","updatedAt":"{{-600000}}"},
      {"id":"mem_2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e","content":"Swift 代码按 native/ios/AGENTS.md 的规则审：写入超时保持结果未知。","revision":2,"createdAt":"{{-300000}}","updatedAt":"{{-7200}}"},
      {"id":"mem_4d5e6f7a-8b9c-4d0e-8f1a-3b4c5d6e7f80","content":"报告先写结论，再写复现步骤。","revision":1,"createdAt":"{{-5000}}","updatedAt":"{{-5000}}",
       "source":{"proposalId":"prp_5e6f7a8b-9c0d-4e1f-8a2b-4c5d6e7f8091","origin":"user","external":false,"sessionId":"ses_review","messageId":"m1","proposedAt":"{{-5200}}"}}],
     "memoryChanges":[{"memoryId":"mem_2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e","operation":"update","at":"{{-7200}}","previous":{"id":"mem_2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e","content":"Swift 代码按规则审。","revision":1,"createdAt":"{{-300000}}","updatedAt":"{{-300000}}"}},
      {"memoryId":"mem_6f7a8b9c-0d1e-4f2a-8b3c-5d6e7f809102","operation":"delete","at":"{{-3600}}","previous":{"id":"mem_6f7a8b9c-0d1e-4f2a-8b3c-5d6e7f809102","content":"不审 docs/ 下的文件。","revision":1,"createdAt":"{{-400000}}","updatedAt":"{{-400000}}"}}],
     "sessions":[]}
    """ }
    private static var dailyDetail: String { """
    {"agent":{"id":"\(daily)","name":"每日简报","avatar":{"kind":"face","bracket":"round","eyes":"arc","hue":"slate"},"description":"每天早上汇总依赖更新与 CI","harnessId":"standard","mode":"chat","model":{"providerId":"deepseek","model":"deepseek-chat"},"available":true,"revision":1,
      "instructions":"汇总昨晚以来的依赖更新与失败的 CI。","skills":[],"tools":[],"createdAt":"{{-864000}}","updatedAt":"{{-864000}}"},
     "memories":[],"sessions":[]}
    """ }
    private static let general = """
    {"general":{"id":"general","instructions":"回答用中文，先给结论。","revision":2},
     "memories":[{"id":"mem_3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f","content":"我在东京时区工作。","revision":1,"createdAt":"{{-900000}}","updatedAt":"{{-900000}}"}]}
    """
    private static let proposalsText = """
    {"proposals":[
     {"id":"prp_7a8b9c0d-1e2f-4a3b-8c4d-6e7f80910213","content":"复核时先跑 swift build 再下结论。","origin":"user","external":false,"state":"pending","source":{"sessionId":"ses_review","messageId":"m1"},"createdAt":"{{-990}}","updatedAt":"{{-990}}"},
     {"id":"prp_8b9c0d1e-2f3a-4b4c-8d5e-7f8091021324","content":"relay 的默认超时是 15 秒。","reason":"在 relay.json 的注释里读到的。","origin":"agent","external":true,"state":"pending","source":{"sessionId":"ses_review","messageId":"m1"},"createdAt":"{{-950}}","updatedAt":"{{-950}}"}]}
    """
    private static var dailyTopic: String { """
    {"id":"ses_daily_talk","title":"依赖更新怎么看","status":"idle","updatedAt":"{{-300}}","harnessId":"standard","mode":"chat","agent":{"customAgentId":"\(daily)"}}
    """ }
    private static func card(_ id: String, _ outcome: String, _ at: Int, _ extra: String) -> String {
        #"{"id":"\#(id)","automationId":"\#(checks)","owner":"\#(daily)","name":"每日依赖检查","outcome":"\#(outcome)","trigger":"schedule","runAt":"{{\#(at - 60)}}","at":"{{\#(at)}}","topicId":"ses_daily_talk"\#(extra)}"#
    }
    private static var dailyConversation: String { """
    {"summary":{"id":"ses_daily_talk","title":"依赖更新怎么看","status":"idle","harnessId":"standard","mode":"chat","agent":{"customAgentId":"\(daily)"}},
     "sync":{"instanceId":"screens","revision":42},"approvals":[],"questions":[],"queue":[],
     "messages":[
      {"id":"d1","role":"user","text":"以后每天的依赖检查有问题再叫我。","createdAt":"{{-90000}}"},
      {"id":"d2","role":"assistant","text":"好的。没问题的日子我只在这里留一张结果卡。","createdAt":"{{-89900}}"},
      {"id":"d3","role":"user","text":"工作日晚上也帮我看一眼 CI。","createdAt":"{{-600}}"},
      {"id":"d4","role":"assistant","text":"可以，我提议一个工作日 20:00 的定时，你看看。","createdAt":"{{-560}}"}],
     "results":[
      \(card("res_a", "completed", -86000, ""))  ,
      \(card("res_b", "completed", -43000, #","sessionId":"ses_daily","reply":"今天有 3 个依赖更新：\n- swift-nio 2.104：修复了 TLS 关闭时的竞态\n- zod 4.2：只是类型调整\n- vitest 5.0.6：修了 watch 模式\n都可以直接合并。","files":[{"root":"latch","path":"docs/deps/2026-11-13.md","change":"created"},{"root":"latch","path":"pnpm-workspace.yaml","change":"modified"}]"#)),
      \(card("res_c", "failed", -20000, #","failure":{"reason":"模型服务没有回答，连接超时。"}"#)),
      \(card("res_d", "interrupted", -1200, #","failure":{"reason":"Host 重启时这次运行还没有结束。","code":"harness-session-lost"},"sessionId":"ses_daily""#))]}
    """ }
    private static var scheduleProposals: String { """
    {"proposals":[
     {"id":"prp_9c0d1e2f-3a4b-4c5d-8e6f-809102132435","kind":"schedule","schedule":{"name":"晚间 CI 检查","plan":{"kind":"weekdays","time":"20:00"}},"content":"看一下今天 main 上的 CI：\\n1. 失败的任务和原因\\n2. 变慢超过 20% 的任务\\n只列需要我处理的。","reason":"你说工作日晚上也要看 CI。","origin":"agent","external":false,"state":"pending","source":{"sessionId":"ses_daily_talk","messageId":"d3"},"createdAt":"{{-550}}","updatedAt":"{{-550}}"}]}
    """ }
    private static var activityText: String { """
    {"items":[
     {"kind":"proposal","id":"act_1","at":"{{-550}}","proposalId":"prp_9c0d1e2f-3a4b-4c5d-8e6f-809102132435","proposal":"schedule","state":"pending","sessionId":"ses_daily_talk"},
     {"kind":"result","id":"act_2","at":"{{-1200}}","resultId":"res_d","name":"每日依赖检查","outcome":"interrupted","topicId":"ses_daily_talk"},
     {"kind":"result","id":"act_3","at":"{{-20000}}","resultId":"res_c","name":"每日依赖检查","outcome":"failed","topicId":"ses_daily_talk"},
     {"kind":"memory","id":"act_4","at":"{{-30000}}","change":"added","memoryId":"mem_1"},
     {"kind":"result","id":"act_5","at":"{{-43000}}","resultId":"res_b","name":"每日依赖检查","outcome":"completed","topicId":"ses_daily_talk"},
     {"kind":"topic","id":"act_6","at":"{{-90000}}","sessionId":"ses_daily_talk","title":"依赖更新怎么看"},
     {"kind":"run","id":"act_7","at":"{{-400000}}","automationId":"\(checks)","name":"每日依赖检查","state":"missed"}],
     "next":"2026-11-01T00:00:00.000Z|act_7"}
    """ }
    private static var libraryText: String { """
    {"groups":[
     {"sessionId":"ses_daily","title":"每日依赖检查","at":"{{-43000}}","automationId":"\(checks)","items":[
      {"kind":"file","sessionId":"ses_daily","root":"latch","path":"docs/deps/2026-11-13.md","change":"created","at":"{{-43000}}"},
      {"kind":"file","sessionId":"ses_daily","root":"latch","path":"pnpm-workspace.yaml","change":"modified","at":"{{-43000}}"},
      {"kind":"file","sessionId":"ses_daily","root":"latch","path":"docs/deps/old.md","change":"deleted","at":"{{-43000}}"}]},
     {"sessionId":"ses_daily_talk","title":"依赖更新怎么看","at":"{{-90000}}","items":[
      {"kind":"attachment","sessionId":"ses_daily_talk","messageId":"d1","attachment":{"id":"att0000000000000000009","name":"ci-截图.png","kind":"image","mime":"image/png","size":120000},"at":"{{-90000}}"}]}]}
    """ }
    private static let runs = """
    {"automation":{"id":"auto_9a1c3d40-5f7e-4b0d-8e4f-3d4e5f607182","name":"每日依赖检查"},
     "runs":[{"at":"{{-21600}}","state":"completed","trigger":"schedule","sessionId":"ses_daily"},{"at":"{{-108000}}","state":"missed","trigger":"schedule"},
      {"at":"{{-180000}}","state":"failed","trigger":"manual"},{"at":"{{-194400}}","state":"completed","trigger":"schedule"}]}
    """
}

@main struct ScreensApp: App {
    @StateObject private var model = PhoneModel()
    /** Live mode's notifications reach the App the way the product's do. */
    @UIApplicationDelegateAdaptor(PhoneAppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var phase
    /** `-LatchTheme dark` or `light`; absent: the device's own. */
    private var theme: ColorScheme? {
        switch UserDefaults.standard.string(forKey: "LatchTheme") { case "dark": .dark; case "light": .light; default: nil }
    }
    var body: some Scene {
        WindowGroup {
            PhoneRootView().environmentObject(model).tint(.blue).preferredColorScheme(theme)
                .task {
                    // Live mode (`-LatchLive 1`) opens the store and pairs like the product; otherwise a canned scene.
                    if PhoneLive.isOn { await model.open() } else { ScreensStage.stage(model); ScreensStage.fitWindow() }
                }
                .onChange(of: phase) { _, next in
                    guard PhoneLive.isOn else { return }
                    if next == .background { model.enterBackground() }
                    if next == .active { Task { await model.open() } }
                }
                .onChange(of: model.sessionId) { _, session in
                    if model.staged, let session {
                        switch ScreensStage.scene {
                        case "question-reminder": ScreensStage.openWorkSession(session, model: model)
                        case "session-team": ScreensStage.openTeamExample(session, model: model)
                        default: break
                        }
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataWillBecomeUnavailableNotification)) { _ in
                    if PhoneLive.isOn { model.protectedDataChanged(available: false) }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)) { _ in
                    if PhoneLive.isOn { model.protectedDataChanged(available: true) }
                }
        }
    }
}

extension ScreensStage {
    private static let teamLead = "ses_aaaaaaaaaaaaaaaaaaaaaa"
    private static let teamExample = "tem_aaaaaaaaaaaaaaaaaaaaaa"
    private static let teamMembers = [
        (id: "ses_bbbbbbbbbbbbbbbbbbbbbb", title: "你好", harness: "codex"),
        (id: "ses_cccccccccccccccccccccc", title: "输出检查结果", harness: "standard"),
        (id: "ses_dddddddddddddddddddddd", title: "输出 1", harness: "codex"),
        (id: "ses_eeeeeeeeeeeeeeeeeeeeee", title: "输出2", harness: "standard"),
    ]

    private static func sessionTeamSnapshot(_ base: NativeJSON) -> NativeJSON {
        let membership = NativeJSON.object(["teamId": .string(teamExample), "leadSessionId": .string(teamLead)])
        func task(_ id: String, _ title: String, harness: String, project: String = "pc-studio", minutes: Int) -> NativeJSON {
            json(#"{"id":"\#(id)","title":"\#(title)","status":"idle","updatedAt":"{{-\#(minutes * 60)}}","harnessId":"\#(harness)","mode":"agent","workspaceId":"\#(project)"}"#)
        }
        let children = teamMembers.enumerated().map { index, member in
            patched(task(member.id, member.title, harness: member.harness, minutes: 10 - index)) { $0["teamOf"] = membership }
        }
        let members = teamMembers.map { member in
            NativeJSON.object(["itemId": .string("itm_" + member.id.dropFirst(4)), "sessionId": .string(member.id),
                "name": .string(member.title), "title": .string(member.title), "harnessId": .string(member.harness), "state": .string("done")])
        }
        return patched(base) { fields in
            fields["catalog"] = patched(base["catalog"]) {
                $0["workspaces"] = json(#"[{"id":"pc-studio","name":"pc-studio","path":"/work/pc-studio"},{"id":"rust-learn","name":"rust-learn","path":"/work/rust-learn"}]"#)
            }
            fields["tasks"] = .array([task(teamLead, "你好", harness: "standard", minutes: 1),
                task("ses_ffffffffffffffffffffff", "你好", harness: "codex", minutes: 20),
                task("ses_gggggggggggggggggggggg", "检查 Rust 项目", harness: "codex", project: "rust-learn", minutes: 30)] + children)
            fields["teams"] = .array([.object(["id": .string(teamExample), "leadSessionId": .string(teamLead), "members": .array(members),
                "state": .string("returned"), "createdAt": .string("2026-11-01T09:00:00Z"), "updatedAt": .string("2026-11-01T10:00:00Z")])])
        }
    }

    static func openTeamExample(_ session: String, model: PhoneModel) {
        guard let summary = model.snapshot["tasks"].array.first(where: { $0["id"].string == session }) else { return }
        let title = summary["title"].string ?? ""
        let answer: String
        if session == teamLead { answer = "这个会话发起了四项团队分工。" }
        else if let index = teamMembers.firstIndex(where: { $0.id == session }) { answer = "这是第\(index + 1) 个成员的回复。" }
        else { answer = "这是单独开始的会话。" }
        model.detail = .object(["summary": summary, "sync": .object(["instanceId": .string("screens"), "revision": .number(42)]),
            "messages": .array([.object(["id": .string("user"), "role": .string("user"), "text": .string(title)]),
                .object(["id": .string("reply"), "role": .string("assistant"), "text": .string(answer)])])])
    }
}

/** Review, 提交, handoffs and the Host's notices. */
extension ScreensStage {
    static var reviewSelection: PhoneLineSelection?
    static var delivering = false
    static var deliveryRefusal: (kind: String, value: NativeHostRefusal)?
    fileprivate static func stageReview(_ model: PhoneModel, _ name: String, snapshot value: NativeJSON) -> Bool {
        let withNotes = patched(value) { object in
            var features = object["catalog"]!["features"].object
            for key in ["changes", "reviewNotes", "gitDelivery", "handoffs"] { features[key] = .bool(true) }
            var catalog = object["catalog"]!.object; catalog["features"] = .object(features); object["catalog"] = .object(catalog)
            object["reviewNotes"] = json(#"[{"sessionId":"ses_review","pending":2,"sent":1,"claimed":0,"reviewed":0,"revision":3}]"#)
            object["handoffs"] = json(#"[{"id":"hof_1","sourceSessionId":"ses_actions","targetSessionId":"ses_site","status":"started","returnScope":"summary","updatedAt":"{{-300}}"},{"id":"hof_2","sourceSessionId":"ses_review","targetSessionId":"ses_site","status":"returned","returnScope":"summary","updatedAt":"{{-200}}"}]"#)
        }
        switch name {
        case "review-list":
            model.tab = .code; model.snapshot = withNotes; model.reviewShortcuts = ["ses_review": "复核 3 处改动", "ses_actions": "复核改动"]
        case "updating":
            model.tab = .code; model.snapshot = withNotes; model.connected = false; model.offline = true
            model.hostNotice = PhoneHostNotice.parse(Data(#"{"type":"host-state","instanceId":"screens","state":"stopping","reason":"update","retryAfter":5,"at":"2026-11-12T10:00:00.000Z"}"#.utf8))
        case "review", "review-locked":
            model.tab = .code
            model.snapshot = name == "review" ? withNotes : patched(withNotes) { object in
                var device = object["device"]!.object; device["dataScope"] = .string("work"); object["device"] = .object(device)
            }
            reviewSelection = name == "review" ? PhoneLineSelection(side: .new, start: 13, end: 14, anchor: 13) : nil
            model.reviewTarget = PhoneReviewTarget(sessionId: "ses_review", file: "native/ios/Sources/LatchNativeCore/PhoneAgents.swift")
        case "commit", "commit-hook", "commit-unknown":
            model.tab = .code; model.snapshot = withNotes; delivering = true
            if name == "commit-hook" {
                deliveryRefusal = ("commit", NativeHostRefusal(status: 409, code: "git-hook-failed", message: "提交钩子没通过",
                    details: json(#"{"hook":"pre-commit","exitCode":1,"tail":"> lint\nnative/ios/App/Review/ReviewView.swift:12: trailing whitespace\n1 problem (1 error, 0 warnings)"}"#)))
            }
            if name == "commit-unknown", let write = try? PhoneDelivery.commit(sessionId: "ses_review", message: "fix(ios): only send a model the service owns", skipHooks: false) {
                model.pending = [write]
            }
            model.reviewTarget = PhoneReviewTarget(sessionId: "ses_review")
        case "handoff":
            model.tab = .code; model.snapshot = withNotes; model.sessionId = "ses_site"
            model.detail = json(#"{"summary":{"id":"ses_site","title":"官网首页换新截图","status":"idle","harnessId":"standard","workspaceId":"site","mode":"agent"},"sync":{"instanceId":"screens","revision":42},"approvals":[],"questions":[],"queue":[],"messages":[{"id":"h1","role":"user","text":"把首页截图换成新的深色版本。","createdAt":"{{-600}}"},{"id":"h2","role":"assistant","text":"换好了：hero.png 与 hero-dark.png 都已更新，尺寸不变。","createdAt":"{{-500}}"}]}"#)
            model.sessionHandoffs = ("ses_site", json(#"[{"id":"hof_1","requestId":"r1","sourceSessionId":"ses_actions","targetSessionId":"ses_site","target":{"kind":"new-session"},"returnScope":"summary","locale":"zh-CN","status":"started","createdAt":"{{-700}}","updatedAt":"{{-300}}"}]"#).array)
        case "about", "licenses": model.tab = .settings
        case "returned":
            model.tab = .code; model.snapshot = withNotes; model.sessionId = "ses_review"; model.detail = conversation()
            model.sessionHandoffs = ("ses_review", json(#"[{"id":"hof_2","requestId":"r2","sourceSessionId":"ses_review","targetSessionId":"ses_site","target":{"kind":"new-session"},"returnScope":"summary","locale":"zh-CN","status":"returned","createdAt":"{{-900}}","updatedAt":"{{-200}}","result":{"summary":"首页截图已换成深色版本，hero.png 与 hero-dark.png 尺寸不变。","evidence":[],"at":"{{-200}}","requestId":"r3"}}]"#).array)
        default: return false
        }
        return true
    }
    /** The review's canned Host answers, by route. */
    static func review(_ path: String) throws -> NativeJSON {
        let fileName = scene == "work-review" ? workLongFile : "native/ios/Sources/LatchNativeCore/PhoneAgents.swift"
        if path.contains("/changes/file") {
            var lines: [String] = []
            for index in 1...12 { lines.append(#"{"kind":"context","text":"    line \#(index)","oldLine":\#(index),"newLine":\#(index)}"#) }
            lines.append(#"{"kind":"remove","text":"    if harness.usesServices { send(model) }","oldLine":13}"#)
            lines.append(#"{"kind":"add","text":"    if PhoneStart.usesServices(harness), let model {","newLine":13}"#)
            lines.append(#"{"kind":"add","text":"        fields[\"model\"] = model.json","newLine":14}"#)
            lines.append(#"{"kind":"add","text":"    }","newLine":15}"#)
            for index in 14...24 { lines.append(#"{"kind":"context","text":"    tail \#(index)","oldLine":\#(index),"newLine":\#(index + 2)}"#) }
            return json(#"{"scope":"turn","file":{"root":"latch","path":"\#(fileName)","status":"M"},"hunks":[{"oldStart":1,"oldLines":24,"newStart":1,"newLines":26,"lines":["# + lines.joined(separator: ",") + "]}]}")
        }
        if path.contains("/changes") {
            return json(#"{"scope":"turn","turnId":"turn_1","totals":{"files":3,"add":12,"del":4},"files":[{"root":"latch","path":"\#(fileName)","status":"M","add":3,"del":1},{"root":"latch","path":"native/ios/App/Agents/AgentsView.swift","status":"M","add":8,"del":3},{"root":"latch","path":"docs/CUSTOM-AGENTS.md","status":"M","add":1,"del":0,"byCommand":true}]}"#)
        }
        if path.contains("/review-notes") {
            return json(##"{"revision":3,"notes":[{"id":"n1","root":"latch","path":"\##(fileName)","range":{"start":15,"end":15},"side":"new","anchor":{"scope":"turn","linesHash":"h","lines":["    }"]},"text":"这里漏了 else：模型服务不可用时应该报错，而不是静默不发。","status":"pending","createdBy":{"deviceId":"d","name":"iPhone"},"createdAt":"{{-60}}","updatedAt":"{{-60}}"},{"id":"n2","root":"latch","path":"\##(fileName)","range":{"start":3,"end":3},"side":"new","anchor":{"scope":"turn","linesHash":"h","lines":["    let removed = something that is not here anymore"]},"text":"这一行后来被删了吗？","status":"sent","messageId":"m9","createdBy":{"deviceId":"d","name":"iPhone"},"createdAt":"{{-600}}","updatedAt":"{{-500}}"},{"id":"n3","root":"latch","path":"docs/OTHER.md","range":{"start":1,"end":1},"side":"new","anchor":{"scope":"session","linesHash":"h","lines":["# 其他"]},"text":"这份文档也要跟着改。","status":"pending","createdBy":{"deviceId":"d","name":"iPhone"},"createdAt":"{{-60}}","updatedAt":"{{-60}}"}]}"##)
        }
        if path.hasSuffix("/git") {
            return json(#"{"branch":"step/ios-review","head":"f36f0060aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","upstream":"origin/step/ios-review","ahead":0,"behind":0,"staged":[{"path":"native/ios/Sources/LatchNativeCore/PhoneAgents.swift","status":"M"}],"unstaged":[{"path":"native/ios/App/Agents/AgentsView.swift","status":"M"}],"untracked":["native/ios/App/Review/Notes.swift"],"conflicted":[],"hooks":["pre-commit"],"filters":false,"remote":"origin"}"#)
        }
        throw NativeFailure.unsupported
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

/** 接入已有会话: the entry, the list, a preview, 继续用 and what an import leaves on a session. */
extension ScreensStage {
    static var creating = false
    static var importing = false
    static var previewing = false
    static var rebuildTarget: String?
    static var importUnknown = false
    private static var busyPreview = false
    private static let handles = ["hh_" + String(repeating: "a1", count: 16), "hh_" + String(repeating: "b2", count: 16), "hh_" + String(repeating: "c3", count: 16)]
    private static func historyCatalog(_ value: NativeJSON, dataScope: String = "all") -> NativeJSON {
        patched(value) { object in
            var catalog = object["catalog"]!.object
            var features = catalog["features"]!.object; features["historyImport"] = .number(1); catalog["features"] = .object(features)
            var harnesses = catalog["harnesses"]!.array.map { harness in
                harness["id"].string == "codex" ? patched(harness) { $0["history"] = json(#"{"list":true,"rebuild":true}"#) } : harness
            }
            harnesses.append(json(#"{"id":"opencode","status":"ready","modes":["agent"],"agentContext":"first-turn","history":{"rebuild":true},"capabilities":{"display":{"label":"OpenCode","mark":"opencode"},"models":{"owner":"harness"},"permission":{"enforcement":"harness"}}}"#))
            catalog["harnesses"] = .array(harnesses)
            catalog["workspaces"] = json(#"[{"id":"default","name":"默认文件夹","path":"/work"},{"id":"latch","name":"latch","path":"/work/latch","folders":[{"id":"f1","path":"/work/latch"},{"id":"f2","path":"/work/latch-docs"}]},{"id":"site","name":"官网","path":"/work/site"}]"#)
            object["catalog"] = .object(catalog)
            var device = object["device"]!.object; device["dataScope"] = .string(dataScope); object["device"] = .object(device)
            object["tasks"] = .array(object["tasks"]!.array + [json(#"{"id":"ses_imported","title":"登录页的 token 刷新","status":"idle","updatedAt":"{{-5000}}","harnessId":"opencode","workspaceId":"latch","mode":"agent","imported":{"from":"codex","mode":"text","prefixLength":64}}"#),
                json(#"{"id":"ses_lost","title":"拆分 relay 的握手","status":"idle","updatedAt":"{{-7000}}","harnessId":"codex","workspaceId":"latch","mode":"agent","imported":{"from":"codex","mode":"native"}}"#)])
        }
    }
    fileprivate static func stageHistory(_ model: PhoneModel, _ name: String, snapshot value: NativeJSON) -> Bool {
        guard name.hasPrefix("history-") else { return false }
        model.tab = .code
        model.snapshot = historyCatalog(value, dataScope: name == "history-locked" ? "work" : "all")
        switch name {
        case "history-entry", "history-locked": creating = true
        case "history-list": creating = true; importing = true
        case "history-preview": creating = true; importing = true; previewing = true
        case "history-rebuild": creating = true; importing = true; previewing = true; rebuildTarget = "opencode"
        case "history-unknown":
            creating = true; importing = true; previewing = true; importUnknown = true
            if let write = try? PhoneHistory.importWrite(previewId: "hp_" + String(repeating: "d4", count: 16), harnessId: "codex") { model.pending = [write] }
        case "history-busy": creating = true; importing = true; previewing = true; busyPreview = true
        case "history-imported":
            model.sessionId = "ses_imported"
            let context = "用户：登录后 token 过一会儿就失效\n助手：刷新逻辑在 auth.ts，过期前五分钟换新。\n"
            let prefix = context.utf16.count
            model.detail = json(#"{"summary":{"id":"ses_imported","title":"登录页的 token 刷新","status":"idle","harnessId":"opencode","workspaceId":"latch","mode":"agent","imported":{"from":"codex","mode":"text","prefixLength":\#(prefix)}},"sync":{"instanceId":"screens","revision":42},"approvals":[],"questions":[],"queue":[],"messages":[{"id":"i1","role":"user","text":"\#(context.replacingOccurrences(of: "\n", with: "\\n"))接着把刷新失败时的重试加上。","importContext":{"from":"Codex","prefixLength":\#(prefix)},"createdAt":"{{-600}}"},{"id":"i2","role":"assistant","text":"加好了：刷新失败时按 1、2、4 秒重试三次，之后回到登录页。","createdAt":"{{-540}}"}]}"#)
        case "history-seed":
            model.sessionId = "ses_imported"
            model.detail = json(#"{"summary":{"id":"ses_imported","title":"登录页的 token 刷新","status":"idle","harnessId":"opencode","workspaceId":"latch","mode":"agent","imported":{"from":"codex","mode":"text","prefixLength":120}},"sync":{"instanceId":"screens","revision":42},"approvals":[],"questions":[],"queue":[],"messages":[]}"#)
        case "history-lost":
            model.sessionId = "ses_lost"; model.lostSessions = ["ses_lost"]
            model.detail = json(#"{"summary":{"id":"ses_lost","title":"拆分 relay 的握手","status":"idle","harnessId":"codex","workspaceId":"latch","mode":"agent","imported":{"from":"codex","mode":"native"}},"sync":{"instanceId":"screens","revision":42},"approvals":[],"questions":[],"queue":[],"messages":[{"id":"l1","role":"user","text":"把握手拆成两步。","imported":true,"createdAt":"{{-90000}}"},{"id":"l2","role":"assistant","text":"拆好了：先验 HMAC，再发证书。","imported":true,"createdAt":"{{-89900}}"}]}"#)
        default: return false
        }
        return true
    }
    /** The canned answers of a listing and a preview. */
    static func history(_ request: PhoneHistoryRead) throws -> NativeJSON {
        if request.path.hasSuffix("/list") {
            return json(#"{"rows":[{"handle":"\#(handles[0])","title":"Web 构建变慢","updatedAt":"{{-3600}}","subdir":"web"},{"handle":"\#(handles[1])","title":"登录页的 token 刷新","updatedAt":"{{-90000}}","subdir":"","importedTaskId":"ses_imported"},{"handle":"\#(handles[2])","title":"拆分 relay 的握手","updatedAt":"{{-260000}}","subdir":"native/ios"}],"otherFolders":2,"scanned":6,"truncated":false}"#)
        }
        if busyPreview { throw PhoneHistoryReadFailure.refused(NativeHostRefusal(status: 409, code: "history-session-busy", message: "这个会话正在别处使用", details: .null)) }
        return json(#"{"previewId":"hp_\#(String(repeating: "d4", count: 16))","title":"Web 构建变慢","model":"gpt-5.5","turns":4,"truncated":true,"messages":[{"role":"user","text":"web 的构建最近慢了一倍，看看为什么。"},{"role":"tool","text":"rg --files web/src","outputHidden":true,"status":"completed"},{"role":"tool","text":"pnpm build --profile","outputHidden":true,"status":"failed"},{"role":"assistant","text":"慢在类型检查：tsconfig 把 dist 也包含进来了。去掉之后构建回到 40 秒左右。"},{"role":"user","text":"那就去掉，再跑一次。"}]}"#)
    }
    static var stagedRows: [PhoneHistoryRow] { PhoneHistory.list(try! history(PhoneHistory.listRead(projectId: "latch", harnessId: "codex")))?.rows ?? [] }
}

/** Several computers: the menu's states, 其他电脑 under 等你处理 and the notification setting. */
extension ScreensStage {
    private static func stageQuestionReminder(_ model: PhoneModel) {
        guard let computer = host("studiohostaaaa", "aaaaaaaaaaaaaaaaaaaaaa", "Mac Studio") else { return }
        model.hosts = [computer]; model.selectedHost = computer
        setQuestionCount(0, model: model)
        Task {
            try? await Task.sleep(for: .seconds(1))
            setQuestionCount(1, model: model)
        }
    }

    private static func setQuestionCount(_ count: Int, model: PhoneModel) {
        guard let computer = model.selectedHost else { return }
        model.snapshot = patched(model.snapshot) { fields in
            fields["tasksComplete"] = .bool(true)
            fields["tasks"] = .array([json(#"{"id":"ses_review","title":"调整并验证原生审阅","status":"running","harnessId":"codex","workspaceId":"latch","pendingQuestions":\#(count)}"#)])
        }
        model.updateQuestionAttention(computer: computer.id)
    }

    static func answerFixtureQuestion(_ fields: [String: NativeJSON], model: PhoneModel) -> Bool {
        guard model.sessionId == workSession,
              fields["answers"]?.array.first?["questionId"].string == "layout",
              !model.detail["questions"].array.isEmpty else { return false }
        model.detail = patched(model.detail) { detail in
            detail["questions"] = .array([])
            detail["summary"] = patched(model.currentSummary) { $0["pendingQuestions"] = .number(0) }
        }
        setQuestionCount(0, model: model)
        return true
    }

    private static func host(_ hostId: String, _ device: String, _ name: String) -> RegisteredHost? {
        let device = #"{"hostId":"\#(hostId)","deviceId":"dev_\#(device)","rootSpki":"AA==","knockKey":"AA==","signedAddressBook":"","bookGeneration":0,"bookHash":"AA=="}"#
        guard let prepared = try? JSONDecoder().decode(PreparedNativeDevice.self, from: Data(device.utf8)) else { return nil }
        return RegisteredHost(name: name, device: prepared, keys: DeviceKeyReference(connectionTag: Data(), verificationTag: Data(), connectionSpki: Data(), verificationSpki: Data()), prepared: false)
    }
    fileprivate static func stageDisconnected(_ model: PhoneModel) {
        model.selectedHost = host("studiohostaaaa", "aaaaaaaaaaaaaaaaaaaaaa", "Mac Studio")
        model.hosts = [model.selectedHost].compactMap { $0 }
        model.lastConfirmed = Date().addingTimeInterval(-120)
        model.connected = false
        model.offline = true
    }
    fileprivate static func stageComputers(_ model: PhoneModel, _ name: String) -> Bool {
        guard name == "computers" || name == "computers-settings" else { return false }
        let hosts = [host("studiohostaaaa", "aaaaaaaaaaaaaaaaaaaaaa", "studio"), host("buildminibbbb", "bbbbbbbbbbbbbbbbbbbbbb", "build-mini"),
                     host("macminicccc", "cccccccccccccccccccccc", "Mac mini"), host("d7k2spoofdddd", "dddddddddddddddddddddd", "build-m\u{0456}ni")].compactMap { $0 }
        model.hosts = hosts; model.selectedHost = hosts.first; model.lastConfirmed = Date()
        let token = model.computerDesk.watch(selected: hosts[0].id, others: hosts.dropFirst().map(\.id))
        let readings = [
            NativeWatchReading(token: token, id: hosts[1].id, state: .online, list: json(#"{"tasks":[{"id":"ses_b1","title":"升级 Node 到 24.22 并跑一遍测试","status":"waiting-approval","updatedAt":"{{-120}}","live":{"lastEventAt":"{{-120}}"}},{"id":"ses_b2","title":"夜间构建要不要清缓存","status":"running","pendingQuestions":1,"updatedAt":"{{-900}}","live":{"lastEventAt":"{{-900}}"}}]}"#), lastSeen: Date()),
            NativeWatchReading(token: token, id: hosts[2].id, state: .offline, list: json(#"{"tasks":[{"id":"ses_c1","title":"a","status":"waiting-approval","updatedAt":"{{-4000}}"},{"id":"ses_c2","title":"b","status":"waiting-approval","updatedAt":"{{-4100}}"},{"id":"ses_c3","title":"c","status":"running","pendingQuestions":2,"updatedAt":"{{-4200}}"}]}"#), lastSeen: Date().addingTimeInterval(-3600)),
            NativeWatchReading(token: token, id: hosts[3].id, state: .wrongHost, list: .null, lastSeen: nil),
        ]
        for reading in readings { _ = model.computerDesk.receive(reading, notifying: false) }
        model.tab = name == "computers" ? .code : .settings
        if name == "computers-settings" { UserDefaults.standard.set(true, forKey: PhoneComputerNotices.key) }
        return true
    }
}

/** Static work-item scenes use the same read adapter and navigation as the product. */
extension ScreensStage {
    private static let workId = "itm_aaaaaaaaaaaaaaaaaaaaaa"
    private static let workPrivate = "itm_bbbbbbbbbbbbbbbbbbbbbb"
    private static let workPost = "pst_aaaaaaaaaaaaaaaaaaaaaa"
    private static let workRun = "turn_1"
    private static let workSession = "ses_review"
    private static let workHead = String(repeating: "a", count: 40)
    private static let prHead = String(repeating: "b", count: 40)
    private static let workLongFile = "native/ios/Sources/LatchNativeCore/ConversationAndWorkItemEvidence/PhoneNativeReviewCoordinates.swift"

    fileprivate static func stageWork(_ model: PhoneModel, _ name: String) -> Bool {
        guard name.hasPrefix("work-") else { return false }
        model.tab = .code
        model.snapshot = workSnapshot()
        model.showWorkItems(true)
        if name == "work-locked" {
            model.verifiedUntil = nil
            model.privateSnapshot.clear()
            model.snapshot = PhoneAgents.withoutPrivate(model.snapshot)
            return true
        }
        if name == "work-list-offline" { stageDisconnected(model); return true }
        if name == "work-list" || name == "work-empty" { return true }
        model.selectWorkItem(workId)
        guard let source = PhoneWorkPost(workPostValue())?.source else { return true }
        switch name {
        case "work-question", "work-approval", "work-read-only":
            model.setWorkPath([.source(source)])
        case "work-reply":
            model.setWorkPath([.reply(post: workPost, message: "work-reply", source: source)])
        case "work-evidence":
            model.setWorkPath([.evidence(session: workSession)])
        case "work-pr":
            model.setWorkPath([.evidence(session: workSession), .pullRequest(session: workSession, number: 42)])
        case "work-log":
            model.setWorkPath([.checkLog(session: workSession, number: 42, sha: prHead, job: "128")])
        case "work-commit":
            model.setWorkPath([.commit(session: workSession, sha: workHead)])
        case "work-review":
            reviewSelection = PhoneLineSelection(side: .new, start: 13, end: 14, anchor: 13)
            model.setWorkPath([.review(session: workSession, turn: workRun)])
        case "work-offline":
            model.connected = false
            model.offline = true
        default: break
        }
        return true
    }

    static func openWorkWindow(_ model: PhoneModel) {
        model.verifiedUntil = .distantFuture
        model.privateSnapshot.clear()
        if let opened = model.privateSnapshot.adopt(workSnapshot(), captured: model.privateSnapshot.epoch, windowOpen: true) {
            model.snapshot = opened
        }
    }

    static func openWorkSession(_ id: String, model: PhoneModel) {
        guard id == workSession else { return }
        let reason = scene == "work-approval" ? "approval" : "question"
        model.sessionId = id
        model.detail = json(#"""
        {"summary":{"id":"ses_review","title":"调整并验证原生审阅","status":"waiting-approval","runId":"turn_1","harnessId":"codex","workspaceId":"latch","pendingQuestions":1},
         "sync":{"instanceId":"screens","revision":42},
         "messages":[
            {"id":"earlier","role":"user","text":"查看已有审阅页面。"},
            {"id":"earlier-reply","role":"assistant","text":"已找到文件栏。"},
            {"id":"work-input","role":"user","text":"修改分屏下的审阅布局，保留过期反馈警告。"},
            {"id":"work-reply","role":"assistant","text":"已定位文件栏占宽。接下来需要明确窄屏下的文件选择方式。"}
         ],"questions":\#(reason == "question" ? #"[{"id":"question-work","state":"pending","toolCallId":"pick","prompt":"窄屏的文件列表如何打开？","questions":[{"id":"layout","label":"窄屏文件列表","options":[{"id":"sheet","label":"用弹出列表选择"},{"id":"inline","label":"展开内嵌列表"}]}]}]"# : "[]"),
         "approvals":\#(reason == "approval" ? #"[{"id":"approval-work","sessionId":"ses_review","risk":"R1","toolName":"apply_patch","reason":"为审阅页新增文件选择器","arguments":"修改 native/ios/App/Review/ReviewView.swift","tool":{"kind":"edit","locations":["native/ios/App/Review/ReviewView.swift"]}}]"# : "[]"),"queue":[]}
        """#)
    }

    static func workRead(_ read: PhoneWorkRead) throws -> NativeJSON {
        switch read {
        case let .item(id) where scene.hasPrefix("work-list") && id != workId:
            guard let item = workSnapshot()["items"].array.first(where: { $0["id"].string == id }) else { throw PhoneWorkReadFailure.itemMissing }
            return .object(["item": patched(item) { $0["prompt"] = .string("") }])
        case let .posts(id, _) where scene.hasPrefix("work-list") && id != workId:
            return .object(["posts": .array([]), "revision": .number(0)])
        case .item: return .object(["item": workItemValue()])
        case .posts: return .object(["posts": .array([workPostValue()]), "revision": .number(2)])
        case .post: return .object(["post": workPostValue()])
        case .reply:
            return .object(["turn": workTurn(), "messageId": .string("work-reply"), "text": .string("""
                已定位文件栏占宽。窄屏应先保留差异的阅读空间，让文件从列表里挑选。

                ## 验收
                - 在 iPad 分屏下仍能读到警告和行级反馈。
                - 在加大字后，文件路径与操作可以换行。
                - 提交差异、PR 检查与本次会话保持关联。
                """)])
        case .delivery:
            return .object(["entries": .array([.object(["sessionId": .string(workSession), "observedAt": json(#""{{-600}}""#),
                "prObservedAt": json(#""{{-600}}""#), "state": .object(["head": .string(workHead)]), "pr": workPR()])])])
        case let .commit(_, sha, file):
            if let file {
                return json(#"{"sha":"\#(sha)","file":{"path":"\#(file)","status":"M","add":2,"del":1},"hunks":[{"lines":[{"kind":"remove","oldLine":13,"text":"if wide { fileList }"},{"kind":"add","newLine":13,"text":"if let width = fileColumnWidth { fileList.frame(width: width) }"}]}]}"#)
            }
            return json(#"{"sha":"\#(sha)","files":[{"path":"\#(workLongFile)","status":"M","add":12,"del":4},{"path":"docs/GIT-DELIVERY.md","status":"M","add":2,"del":0}],"totals":{"files":2,"add":14,"del":4}}"#)
        case .pullRequest: return workPR()
        case .checkLog:
            return .object(["name": .string("native-simulator"), "truncated": .bool(true), "text": .string("""
                [验证 iPad 布局]
                失败：分屏时反馈警告无法完整显示。
                [上传截图]
                已保存失败场景的截图。
                """)])
        }
    }

    private static func workSnapshot() -> NativeJSON {
        patched(snapshot()) { object in
            var catalog = object["catalog"]!.object, features = catalog["features"]!.object
            for key in ["workItems", "workItemTurns", "workItemCreateReceipt", "changes", "reviewNotes", "gitDelivery"] { features[key] = .bool(true) }
            catalog["features"] = .object(features); object["catalog"] = .object(catalog)
            let item = patched(workItemValue()) { $0.removeValue(forKey: "prompt") }
            let todo = json(#"{"id":"itm_cccccccccccccccccccccc","title":"整理连接说明","projectId":"site","sessionIds":[],"revision":1,"updatedAt":"{{-900}}","board":{"group":"todo"}}"#)
            var items = [
                item,
                json(#"{"id":"\#(workPrivate)","title":"升级通知与内部发布检查","private":true,"projectId":"latch","sessionIds":[],"revision":1,"updatedAt":"{{-300}}","board":{"group":"running"}}"#),
                scene.hasPrefix("work-list") ? patched(todo) { fields in
                    fields["priority"] = .string("low")
                    fields["tags"] = .array([.string("文档")])
                } : todo,
            ]
            if scene.hasPrefix("work-list") {
                items += [
                    json(#"{"id":"itm_dddddddddddddddddddddd","title":"更新官网的手机端截图","projectId":"site","sessionIds":["ses_site"],"revision":2,"createdAt":"{{-86400}}","updatedAt":"{{-600}}","board":{"group":"deliver"},"note":"浅色和深色两套截图已就绪。"}"#),
                    json(#"{"id":"itm_eeeeeeeeeeeeeeeeeeeeee","title":"核对新版本的发布说明","projectId":"latch","sessionIds":[],"revision":2,"createdAt":"{{-172800}}","updatedAt":"{{-7200}}","closedAt":"{{-7200}}","board":{"group":"done"}}"#),
                ]
            }
            object["items"] = .array(scene == "work-empty" ? [] : items)
            object["tasks"] = .array(object["tasks"]!.array.map { task in
                if scene.hasPrefix("work-list"), task["id"].string == "ses_site" {
                    return patched(task) { $0["itemId"] = .string("itm_dddddddddddddddddddddd") }
                }
                guard task["id"].string == workSession else { return task }
                return patched(task) { fields in
                    fields["itemId"] = .string(workId)
                    fields["title"] = .string("调整并验证原生审阅")
                    fields["status"] = .string(scene == "work-review" ? "idle" : "waiting-approval")
                    fields["runId"] = .string(workRun)
                    fields["pendingQuestions"] = .number(1)
                }
            })
            if scene == "work-read-only" {
                var device = object["device"]!.object; device["scopes"] = .array([.string("view")]); device["dataScope"] = .string("work")
                object["device"] = .object(device)
            }
        }
    }

    private static func workItemValue() -> NativeJSON {
        let group = switch scene { case "work-running": "running"; case "work-evidence", "work-pr", "work-commit", "work-review": "deliver"; default: "attention" }
        let reason = switch scene { case "work-approval": "approval"; case "work-failed": "failed"; case "work-unknown": "unknown"; default: "question" }
        let board = group == "attention" ? json(#"{"group":"attention","reason":"\#(reason)","postId":"\#(workPost)"}"#) : .object(["group": .string(group)])
        return patched(json(#"""
        {"id":"\#(workId)","title":"让 iPad 分屏里的改动更好读","projectId":"latch","sessionIds":["\#(workSession)"],
          "revision":2,"threadRevision":2,"updatedAt":"{{-150}}",
          "prompt":"窄屏时保留差异宽度。检查横竖屏、分屏以及较大的字体，并完整显示过期反馈警告。"}
        """#)) { fields in
            fields["board"] = board
            if scene.hasPrefix("work-list") {
                fields["tags"] = .array([.string("iPad"), .string("审阅"), .string("无障碍")])
                fields["priority"] = .string("high")
                fields["hasPrompt"] = .bool(true)
                fields["note"] = .string("先确认窄屏时的文件选择方式。")
            }
        }
    }

    private static func workTurn() -> NativeJSON {
        .object(["sessionId": .string(workSession), "userMessageId": .string("work-input"), "runId": .string(workRun)])
    }

    private static func workPostValue() -> NativeJSON {
        let approval = scene == "work-approval"
        return patched(json(#"""
        {"id":"\#(workPost)","at":"{{-150}}","text":"修改分屏下的审阅布局，保留过期反馈警告。",
         "delivery":{"sessionId":"\#(workSession)","state":"sent"},
         "attention":{"reason":"\#(approval ? "approval" : "question")","decisionId":"\#(approval ? "approval-work" : "question-work")"},
         "reply":{"messageId":"work-reply","text":"已定位文件栏占宽。接下来需要明确窄屏下的文件选择方式。","more":true}}
        """#)) { fields in
            fields["turn"] = workTurn()
            if scene == "work-unknown" || scene == "work-failed" {
                let unknown = scene == "work-unknown"
                fields["delivery"] = .object(["state": .string(unknown ? "unknown" : "failed"), "sessionId": .string(workSession),
                    "reason": .string(unknown ? "没有确认送达。" : "会话正在运行，发言没有送达。")])
                fields["turn"] = nil; fields["reply"] = nil
                fields["attention"] = .object(["reason": .string(unknown ? "unknown" : "failed")])
            }
        }
    }

    private static func workPR() -> NativeJSON {
        json(#"""
        {"pr":{"number":42,"title":"让 iPad 分屏审阅保持足够宽度","state":"open","draft":false,
               "url":"https://example.invalid/acme/latch/pull/42","headSha":"\#(prHead)","reviewDecision":"changes-requested"},
         "checks":[{"name":"native-simulator","state":"fail","job":"128"},{"name":"types","state":"pass"},{"name":"screenshots","state":"pending"}],
         "discussion":[{"kind":"line","review":"commented","author":"审阅者","path":"\#(workLongFile)","line":31,"body":"请保留长路径的完整内容，并在分屏下复核。"}],"discussionCapped":true}
        """#)
    }
}
