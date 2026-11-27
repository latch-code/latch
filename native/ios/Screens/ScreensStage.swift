import ActivityKit
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
    /** The Agent scenes: the profile sheet opens on a chosen tab. */
    static var profile = false
    static var profilePart: AgentProfileSheet.Part?
    static var scanning = false
    /** The list's search field, for the 内容中包含 scene. */
    static var query = ""
    static var scene: String { UserDefaults.standard.string(forKey: "LatchScene") ?? "code" }
    /** The 额度与用量 scenes: the sheet opened from 设置 on this tab. */
    static var usageTab: UsageTab?
    private static var locked = false
    private static var pendingActivityBusy = false

    private struct PendingActivityFixture: Decodable {
        let attributes: LatchQuestionAttributes
        let contentState: LatchQuestionAttributes.ContentState
    }

    /** Simulator visual check of the real Widget renderer, independent of signed APNs delivery. */
    static func showPendingActivity() async {
        let arguments = ProcessInfo.processInfo.arguments
        guard scene == "push-approval", arguments.contains("-LatchShowPendingActivity"),
              UIApplication.shared.applicationState == .active, !pendingActivityBusy else { return }
        pendingActivityBusy = true
        defer { pendingActivityBusy = false }
        typealias Live = Activity<LatchQuestionAttributes>
        let variant = UserDefaults.standard.string(forKey: "LatchPendingActivityVariant")
        // Replay the Host's attributes with their matching content state so the preview uses the same routing context.
        let fixture = arguments.firstIndex(of: "-LatchPendingActivityFixture").flatMap {
            arguments.dropFirst($0 + 1).first
        }.flatMap { try? JSONDecoder().decode(PendingActivityFixture.self, from: Data($0.utf8)) }
        #if targetEnvironment(simulator)
        if arguments.contains("-LatchInstallScreenshotPreviewKey"), let route = fixture?.attributes.route {
            let receipt = ApprovalPreviewFixture.install(route: route)
            try? Data(receipt.utf8).write(to: FileManager.default.temporaryDirectory.appendingPathComponent("LatchScreensPreviewKeyStatus"))
        }
        #endif
        let isApproval = fixture?.attributes.approval ?? (variant != "question")
        let content = ActivityContent(state: fixture?.contentState ?? .init(), staleDate: Date().addingTimeInterval(variant == "stale" ? 1 : 600))
        let activities = Live.activities
        let existing = activities.first { activity in
            guard activity.attributes.approval == isApproval else { return false }
            guard let fixture else { return true }
            return activity.attributes.route == fixture.attributes.route && activity.attributes.ticket == fixture.attributes.ticket
        }
        for previous in activities where previous.id != existing?.id {
            await endPendingActivity(previous.id)
        }
        if let existing {
            await refreshPendingActivity(existing.id, content: content)
            return
        }
        guard UIApplication.shared.applicationState == .active else { return }
        let attributes = fixture?.attributes ?? LatchQuestionAttributes(
            route: UUID().uuidString.lowercased(), ticket: String(repeating: "a", count: 32), approval: isApproval
        )
        let result: String
        do {
            _ = try Live.request(attributes: attributes, content: content, pushType: nil)
            result = "started"
        } catch { result = "unavailable" }
        try? Data(result.utf8).write(to: FileManager.default.temporaryDirectory.appendingPathComponent("LatchScreensActivityResult"))
    }

    static func notePendingLink(_ hint: PhonePushHint) {
        guard scene == "push-approval", ProcessInfo.processInfo.arguments.contains("-LatchShowPendingActivity") else { return }
        let matches = Activity<LatchQuestionAttributes>.activities.contains { $0.attributes.route == hint.route && $0.attributes.ticket == hint.ticket }
        let result = (matches ? "same-activity-" : "unknown-activity-") + (hint.reject ? "reject" : "review")
        try? Data(result.utf8).write(to: FileManager.default.temporaryDirectory.appendingPathComponent("LatchScreensActivityLink"))
    }

    private nonisolated static func refreshPendingActivity(_ id: String, content: ActivityContent<LatchQuestionAttributes.ContentState>) async {
        await Activity<LatchQuestionAttributes>.activities.first { $0.id == id }?.update(content)
    }

    private nonisolated static func endPendingActivity(_ id: String) async {
        await Activity<LatchQuestionAttributes>.activities.first { $0.id == id }?.end(nil, dismissalPolicy: .immediate)
    }

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
        case "inbox-first-rows":
            stageFirstRows(model, base: value)
        case "question-reminder":
            stageQuestionReminder(model)
        case "session-team":
            model.snapshot = sessionTeamSnapshot(value)
        case "team-results":
            stageTeamResults(model, base: value)
        case "team-graph":
            stageTeamGraph(model, base: value)
        case "usage-empty":
            model.tab = .settings
            usageTab = .quota
            model.snapshot = patched(value) { root in
                root["catalog"] = patched(value["catalog"]) { catalog in
                    catalog["features"] = patched(value["catalog"]["features"]) { $0["modelUsage"] = nil }
                    catalog["harnesses"] = .array(value["catalog"]["harnesses"].array.filter { $0["id"].string == "standard" })
                }
            }
        case "usage-quota", "usage-spend":
            stageUsage(model, base: value, tab: name == "usage-quota" ? .quota : .usage)
        case "usage-widgets":
            // The quota widgets' file from the same Harnesses, Antigravity's read long enough ago to be out of date, for
            // placing the Home and Lock Screen widgets by hand.
            stageUsage(model, base: value, tab: .quota, staleAntigravity: true)
            QuotaWidgetWriter.note(model.snapshot["catalog"], computer: "staged", hostNow: Date(), hostOffset: 0)
        case "workspace", "workspace-offline":
            model.snapshot = workSnapshot()
            if name == "workspace-offline" { stageDisconnected(model) }
        case "harness-accounts":
            model.tab = .settings
            model.snapshot = patched(value) { root in
                root["catalog"] = patched(value["catalog"]) { catalog in
                    catalog["harnesses"] = json(#"""
                    [
                      {"id":"codex","presetId":"codex","capabilities":{"display":{"label":"Codex","mark":"codex"}}},
                      {"id":"codex-work","presetId":"codex","account":true,"capabilities":{"display":{"label":"Codex · 工作","mark":"codex"}}},
                      {"id":"codex-research","presetId":"codex","account":true,"capabilities":{"display":{"label":"研究项目","mark":"codex"}}},
                      {"id":"codex-command","presetId":"codex","capabilities":{"display":{"label":"自定命令","mark":"codex"}}},
                      {"id":"qwen","presetId":"qwen","capabilities":{"display":{"label":"Qwen Code","mark":"qwen"}}},
                      {"id":"grok","presetId":"grok","offer":{"presetId":"grok"},"capabilities":{"display":{"label":"Grok Build","mark":"grok"}}},
                      {"id":"plugin","capabilities":{"display":{"label":"插件实例","mark":"codex"}}}
                    ]
                    """#)
                }
            }
        case "account-models", "account-thinking":
            creating = true
            model.snapshot = patched(value) { root in
                root["catalog"] = patched(value["catalog"]) { catalog in
                    let codex = PhoneStart.harness(value["catalog"], "codex")
                    let work = patched(codex) { item in
                        item["id"] = .string("codex-2"); item["account"] = .bool(true); item["presetId"] = .string("codex")
                        item["capabilities"] = patched(codex["capabilities"]) {
                            $0["display"] = .object(["label": .string("Codex · 工作"), "mark": .string("codex")])
                        }
                        item["catalogueRead"] = .object(["when": .string("select")])
                        item["catalogue"] = json(#"""
                        {"options":[{"id":"model","category":"model","currentValue":"work-balanced","options":[{"value":"work-balanced","name":"Balanced"},{"value":"work-fast","name":"Fast"}]}],
                        "perModel":[{"model":"work-fast","options":[{"id":"work-reasoning","category":"thought_level","options":[{"value":"low","name":"简短思考"},{"value":"high","name":"深入思考"}]}]}]}
                        """#)
                    }
                    catalog["harnesses"] = .array(value["catalog"]["harnesses"].array.map { engine in
                        engine["id"].string == "codex" ? patched(engine) { $0["presetId"] = .string("codex") } : engine
                    } + [work])
                    catalog["defaults"] = patched(value["catalog"]["defaults"]) { $0["harnessId"] = .string("codex-2") }
                }
            }
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
        case "conversation", "recovering-chat":
            model.tab = .code; model.sessionId = "ses_review"; model.detail = conversation()
            if name == "recovering-chat" {
                model.draftInserts["ses_review"] = "请再看一下相关测试。"
                model.stageReconnect()
            }
        case "reply-quote-draft", "terminal-draft":
            model.tab = .code; model.sessionId = "ses_review"; model.detail = conversation()
            if name == "reply-quote-draft" {
                model.detail = patched(model.detail) { detail in
                    let sent = json(#"{"id":"m3","role":"user","text":"[引用回复 ses_review/m2@0]\n> 读完了。\n\n请继续核对。","createdAt":"{{-900}}"}"#)
                    detail["messages"] = .array((detail["messages"]?.array ?? []) + [sent])
                }
            }
            ReplyQuoteDraftFixture.stage(model, session: "ses_review", terminal: name == "terminal-draft")
        case "conversation-sending":
            model.tab = .code; model.sessionId = "ses_review"; model.detail = conversation()
            if let write = try? NativePendingWrite(method: .post, path: "/link/api/tasks/ses_review/prompt", fields: ["prompt": .string("再看一下发送回执")]) {
                model.pending = [write]
                model.submittingPromptId = write.requestId
                model.busy = true
            }
        case "conversation-limited":
            // Codex used its 5-hour limit up: the conversation says so above its input.
            model.tab = .code; model.sessionId = "ses_review"; model.detail = conversation()
            let limited = json(#"{"plan":"pro","state":"limited","observedAt":"{{-60}}","windows":[{"kind":"five-hour","usedPercent":100,"resetsAt":"{{7800}}"},{"kind":"weekly","usedPercent":64,"resetsAt":"{{400000}}"}]}"#)
            model.snapshot = patched(model.snapshot) { object in
                var catalog = object["catalog"]!.object
                catalog["harnesses"] = .array(catalog["harnesses"]!.array.map { harness in
                    harness["id"].string == "codex" ? patched(harness) { $0["quota"] = limited } : harness
                })
                object["catalog"] = .object(catalog)
            }
        case "pictures":
            model.tab = .code; model.sessionId = "ses_review"; model.detail = picturesConversation()
        case "markdown", "markdown-code", "markdown-prose", "markdown-dense", "markdown-diagram", "markdown-diagram-unsupported":
            if name == "markdown-prose" || name == "markdown-dense" { MarkdownLayoutFixture.recordIfRequested() }
            model.tab = .code; model.sessionId = "ses_review"; model.detail = markdownConversation(scene: name)
        case "conversation-reading", "project-files":
            if name == "project-files" {
                model.snapshot = patched(value) { root in
                    root["catalog"] = patched(value["catalog"]) { catalog in
                        catalog["features"] = patched(value["catalog"]["features"]) {
                            $0["fileTree"] = .bool(true); $0["fileSearch"] = .bool(true); $0["fileMentions"] = .bool(true)
                        }
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
        case "conversation-actions", "offline-draft":
            model.tab = .code; model.sessionId = "ses_actions"; model.detail = json(actionsText)
            if name == "offline-draft" {
                model.draftInserts["ses_actions"] = "请再看一下相关测试。"
                stageDisconnected(model)
            }
        case "subagents":
            model.tab = .code; model.sessionId = "ses_actions"; _ = model.subagentStops.begin("m3")
            model.snapshot = patched(model.snapshot) { object in
                object["tasks"] = .array(object["tasks"]!.array.map { task in task["id"].string == "ses_actions" ? patched(task) { $0["status"] = .string("running") } : task })
            }
            model.detail = json(actionsText.replacingOccurrences(of: "\"status\":\"idle\",\"harnessId\"", with: "\"status\":\"running\",\"harnessId\"")
                .replacingOccurrences(of: "\"clearContext\":true", with: "\"runStartedAt\":\"{{-80}}\""))
        case "steer":
            model.tab = .code; model.sessionId = "ses_run"; model.detail = json(steerText); model.draftInserts["ses_run"] = "顺便看一下测试有没有覆盖粘贴"
        case "prompt-queue":
            model.tab = .code; model.sessionId = "ses_run"
            model.snapshot = patched(value) { root in
                root["catalog"] = patched(value["catalog"]) { catalog in
                    catalog["features"] = patched(value["catalog"]["features"]) { $0["queueControl"] = .bool(true) }
                }
            }
            model.detail = patched(json(steerText)) { detail in
                detail["summary"] = patched(detail["summary"]!) { $0["runId"] = .string("run_fixture") }
                detail["steerAttachments"] = .bool(true)
                detail["queue"] = .array(["检查粘贴后的焦点", "再看一下无障碍标签", "补上回归测试"].enumerated().map { index, text in
                    var row: [String: NativeJSON] = ["id": .string("queue_\(index)"), "text": .string(text), "state": .string("waiting"), "canSteer": .bool(true)]
                    if index < 2 { row["attachmentCount"] = .number(Double(2 - index)) }
                    return .object(row)
                })
            }
        case "clearing":
            model.tab = .code; model.sessionId = "ses_review"; model.detail = conversation(); model.clearing = ["ses_review"]
        case "push-approval":
            model.tab = .code
            let variant = UserDefaults.standard.string(forKey: "LatchPendingActivityVariant")
            let fixture = switch variant {
            case "command", "private": commandApprovalText
            case "file": fileApprovalText
            default: approvalText
            }
            let request = json(fixture)
            model.sessionId = request["summary"]["id"].string
            if variant != nil {
                model.snapshot = patched(value) { snapshot in
                    snapshot["tasks"] = .array(value["tasks"].array.map { row in
                        guard row["id"].string == "ses_wait" else { return row }
                        return patched(row) { fields in
                            for key in ["id", "title", "branch"] { fields[key] = request["summary"][key] }
                        }
                    })
                }
            }
            model.detail = patched(request) { detail in
                let original = detail["approvals"]!.array[0]
                let actual = variant != nil
                    ? patched(original) { $0["advisory"] = .bool(true) }
                    : original
                let unrelated = patched(actual) { $0["id"] = .string("another-approval"); $0["toolName"] = .string("unrelated") }
                detail["approvals"] = .array([unrelated, actual])
            }
            if let session = model.sessionId, let approval = request["approvals"].array.first?["id"].string,
               let selected = PhonePushTarget(.object(["session": .string(session), "kind": .string("approval"), "id": .string(approval)])) {
                model.pushFocus = (selected, variant == nil)
            }
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
        case "code-status":
            // Each state a row can be in: at work (with its activity and clock), silent, failed, stopped, and a new answer.
            model.tab = .code
            func task(_ id: String, _ title: String, _ fields: String) -> NativeJSON {
                json(#"{"id":"\#(id)","title":"\#(title)","harnessId":"codex","workspaceId":"latch","mode":"agent",\#(fields)}"#)
            }
            let added: [NativeJSON] = [
                    task("ses_cmd", "跑一遍原生测试", #""status":"running","updatedAt":"{{-20}}","live":{"activity":"command","runStartedAt":"{{-192}}","lastEventAt":"{{-3}}"}"#),
                    task("ses_model", "整理 relay 的日志格式", #""status":"running","updatedAt":"{{-40}}","workspaceId":"site","live":{"activity":"model","runStartedAt":"{{-75}}","lastEventAt":"{{-2}}"}"#),
                    task("ses_quiet", "迁移旧的配对记录", #""status":"running","updatedAt":"{{-300}}","live":{"activity":"tool","silent":true,"runStartedAt":"{{-900}}","lastEventAt":"{{-420}}"}"#),
                    task("ses_fail", "修复 iPad 分屏的布局", #""status":"idle","runOutcome":"failed","updatedAt":"{{-1800}}","branch":"fix/ipad-split""#),
                    task("ses_new", "给设置页加入额度入口", #""status":"idle","updatedAt":"{{-600}}","branch":"feat/usage""#),
                    task("ses_stop", "试一下新的差异视图", #""status":"cancelled","updatedAt":"{{-7200}}""#),
            ]
            model.snapshot = patched(model.snapshot) { object in object["tasks"] = .array((object["tasks"]?.array ?? []) + added) }
            model.seenState = PhoneSeen(baseline: "2000-01-01T00:00:00.000Z", seen: ["ses_actions": "2100-01-01T00:00:00.000Z", "ses_site": "2100-01-01T00:00:00.000Z", "ses_fail": "2100-01-01T00:00:00.000Z"])
        case "search":
            model.tab = .code; query = "relay"
            model.contentSearch = PhoneContentSearch(query: "relay", hits: PhoneSearch.results(json(hitsText)).hits, truncated: false)
        case "agents", "agents-locked", "agent-create": model.tab = .agents
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
        case "agent-new", "agent-mentions", "agent-consultation", "agent-consultation-approval":
            if name == "agent-mentions" {
                model.snapshot = patched(model.snapshot) { root in
                    root["catalog"] = patched(root["catalog"]!) { catalog in
                        catalog["features"] = patched(catalog["features"]!) { features in
                            features["fileSearch"] = .bool(true); features["fileMentions"] = .bool(true)
                        }
                    }
                }
            }
            model.tab = .agents; model.agentPath = [review]; chat(model, owner: review, session: nil)
            if name.hasPrefix("agent-consultation") {
                chat(model, owner: daily, session: "ses_daily_talk")
                model.snapshot = patched(model.snapshot) {
                    $0["tasks"] = .array(($0["tasks"]?.array ?? []) + [consultationDetail["summary"]])
                    if name == "agent-consultation-approval" { $0["approvals"] = .array(consultationDetail["approvals"].array) }
                }
            }
        case "agent-work-computer":
            let hostId = String(repeating: "b", count: 52)
            model.hosts = [host(String(repeating: "a", count: 52), "aaaaaaaaaaaaaaaaaaaaaa", "工作室"),
                           host(hostId, "bbbbbbbbbbbbbbbbbbbbbb", "云端 Mac")].compactMap { $0 }
            model.selectedHost = model.hosts.first
            model.snapshot = patched(value) { root in
                root["customAgents"] = .array(value["customAgents"].array.map { agent in
                    agent["id"].string != review ? agent : patched(agent) {
                        $0["workComputer"] = .object(["hostId": .string(hostId), "agentId": .string(daily)])
                    }
                })
            }
            model.tab = .agents; model.agentPath = [review]; chat(model, owner: review, session: nil)
        case "agent-waiting":
            model.tab = .agents; model.agentPath = [daily]
            model.snapshot = patched(model.snapshot) { object in object["tasks"] = .array(object["tasks"]!.array + [json(waitingTask)]) }
            chat(model, owner: daily, session: "ses_brief")
            model.sessionId = "ses_brief"
            model.detail = json(approvalText.replacingOccurrences(of: "\"id\":\"ses_wait\",\"title\":\"升级 swift-nio 到 2.104\"", with: "\"id\":\"ses_brief\",\"title\":\"汇总本周依赖更新\""))
        case "agent-consent":
            model.tab = .agents; model.agentPath = [daily]; profile = true; profilePart = .runSettings
            model.snapshot = patched(model.snapshot) { root in
                root["customAgents"] = .array(model.snapshot["customAgents"].array.map { agent in
                    agent["id"].string == daily ? patched(agent) { $0["mode"] = .string("agent") } : agent
                })
            }
        case "agent-schedules": model.tab = .agents; model.agentPath = [daily]; profile = true; profilePart = .activity
        case "agent-computer":
            // 每日简报 with two missed times of one schedule, kept awake for a schedule, and its 完成 notification off.
            model.tab = .agents; model.agentPath = [daily]; profile = true; profilePart = .runSettings
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
        case "pairing-compare": model.pairing = .confirming(comparisonCode: "052413")
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
            model.draftInserts["ses_review"] = "这两张截图里按钮的间距不一样，看看是哪里的样式"
        case "attach-unavailable":
            model.sessionId = "ses_review"; model.detail = conversation()
            model.attachStates["ses_review"] = PhoneAttachState(revision: "staged",
                caps: PhoneAttachCaps(images: false, text: false, textBytes: 0, reason: "这个 Harness 不接收图片和文件。"))
            var held = PhoneAttachTray(); held.note = "这个 Harness 不接收图片和文件。"; model.attachTrays["ses_review"] = held
        case "attach-held":
            model.sessionId = "ses_run"; model.detail = json(steerText)
            model.attachStates["ses_run"] = PhoneAttachState(revision: "staged", caps: both)
            model.attachTrays["ses_run"] = tray([("IMG_0420.jpg", .image, .ready)])
            model.draftInserts["ses_run"] = "顺便看一下这张截图"
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
        if scene.hasPrefix("agent-consultation"), path == "/link/api/tasks/ses_daily_talk" { return .ready(consultationDetail) }
        if path.hasSuffix("/mentions") {
            if scene == "agent-consultation-approval", path == PhoneAgentMentions.path(review) {
                return .ready(json("""
                    {"mentions":[{"id":"example-approval","requestId":"example-0000000002","sourceAgentId":"\(review)","targetAgentId":"\(daily)",
                      "initiator":"agent","consultationMode":"own-permissions","targetSessionId":"ses_daily_talk","targetMessageId":"request-1",
                      "text":"把这次审阅的待办整理成三条。","status":"waiting-approval","approval":{"id":"consultation-approval","runId":"consultation-run"}}]}
                    """))
            }
            if scene == "agent-consultation", path == PhoneAgentMentions.path(review) {
                return .ready(json("""
                    {"mentions":[{"id":"example","requestId":"example-0000000001","sourceAgentId":"\(review)","targetAgentId":"\(daily)",
                      "initiator":"agent","consultationMode":"text-only","targetSessionId":"ses_daily_talk","targetMessageId":"request-1","text":"把这次审阅的待办整理成三条。","status":"completed",
                      "reply":{"messageId":"reply-1","text":"先补齐空列表测试，再核对重复提交，最后在手机上确认回复的显示。"}}]}
                    """))
            }
            return .ready(json(#"{"mentions":[]}"#))
        }
        if path.hasSuffix("/proposals") {
            return .ready(path.contains(review) ? json(proposalsText) : path.contains(daily) ? json(scheduleProposals) : json(#"{"proposals":[]}"#))
        }
        let id = String(path.split(separator: "/").last ?? "")
        if id == PhoneAgents.generalId { return .ready(json(general)) }
        if id == review { return .ready(json(reviewDetail)) }
        if id == daily && scene == "agent-consent" {
            return .ready(patched(json(dailyDetail)) { detail in
                detail["agent"] = patched(detail["agent"] ?? .null) {
                    $0["mode"] = .string("agent"); $0["canConsultAgents"] = .bool(true)
                }
            })
        }
        if id == daily || id == docs { return .ready(json(dailyDetail.replacingOccurrences(of: daily, with: id))) }
        if id == checks { return .ready(json(runs)) }
        return .missing
    }

    private static var consultationDetail: NativeJSON {
        patched(json(dailyConversation)) { detail in
            let message = json(#"{"id":"request-1","role":"user","text":"把这次审阅的待办整理成三条。"}"#)
            if scene == "agent-consultation-approval" {
                detail["messages"] = .array([message])
                detail["summary"] = patched(detail["summary"] ?? .null) {
                    $0["status"] = .string("waiting-approval"); $0["runId"] = .string("consultation-run")
                }
                detail["approvals"] = json(#"[{"id":"consultation-approval","sessionId":"ses_daily_talk","risk":"R1","toolName":"write_file","tool":{"title":"写入「原审批.txt」"}}]"#)
            } else {
                detail["messages"] = .array([message,
                    json(#"{"id":"reply-1","role":"assistant","text":"先补齐空列表测试，再核对重复提交，最后在手机上确认回复的显示。"}"#),
                    json(#"{"id":"request-2","role":"user","text":"继续下一个任务。"}"#)
                ])
            }
        }
    }

    static func finishConsultationApproval(_ path: String, fields: [String: NativeJSON], model: PhoneModel) -> Bool {
        guard scene == "agent-consultation-approval" else { return false }
        let stop = path == "/link/api/tasks/ses_daily_talk/cancel" && fields["runId"] == .string("consultation-run")
        let decide = path == "/link/api/approvals/consultation-approval" && ["allow", "reject"].contains(fields["decision"]?.string ?? "")
        guard stop || decide else { return false }
        model.snapshot = patched(model.snapshot) { snapshot in
            snapshot["tasks"] = .array((snapshot["tasks"]?.array ?? []).map { task in
                guard task["id"].string == "ses_daily_talk" else { return task }
                return patched(task) { $0["runId"] = .string("later-run") }
            })
            snapshot["approvals"] = json(#"[{"id":"later-approval","sessionId":"ses_daily_talk","risk":"R1","toolName":"write_file","tool":{"title":"写入「下一轮.txt」"}}]"#)
        }
        return true
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
        let project = scene == "team-results" ? ["README.md", "src/eden.proxy.ts"] : ["文档/验收步骤.md", "README.md"]
        let paths = project.filter { query.isEmpty || $0.localizedCaseInsensitiveContains(query) }
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

    /** A sent screenshot and an agent's generated picture, drawn from bytes staged in memory. */
    private static func picturesConversation() -> NativeJSON {
        func ref(_ id: String, _ name: String, _ width: Int, _ height: Int, size: Int) -> NativeJSON {
            .object(["id": .string(id), "name": .string(name), "mime": .string("image/png"), "kind": .string("image"), "size": .number(Double(size)),
                     "sha256": .string(String(repeating: "a", count: 64)), "width": .number(Double(width)), "height": .number(Double(height))])
        }
        let shot = "shotAAAAAAAAAAAAAAAAAA", chart = "chartAAAAAAAAAAAAAAAAA", log = "logAAAAAAAAAAAAAAAAAAA"
        PhonePictures.staged[shot] = stagedPicture(CGSize(width: 390, height: 300), title: "image.png", hue: 0.62)
        PhonePictures.staged[chart] = stagedPicture(CGSize(width: 640, height: 400), title: "chart.png", hue: 0.38)
        var logRef = ref(log, "build.log", 0, 0, size: 4096).object
        logRef["mime"] = .string("text/plain"); logRef["kind"] = .string("text"); logRef["width"] = nil; logRef["height"] = nil
        return patched(conversation()) { root in
            root["messages"] = .array([
                .object(["id": .string("m1"), "role": .string("user"), "text": .string("这些你没感知到嘛"), "createdAt": .string(stamp.string(from: Date().addingTimeInterval(-1000))),
                         "attachments": .array([ref(shot, "image.png", 390, 300, size: 51_200), .object(logRef)])]),
                .object(["id": .string("m2"), "role": .string("assistant"), "text": .string("看到了。按你贴的截图，团队里出现过 **5 种** Agent。我画了一张分布图："),
                         "createdAt": .string(stamp.string(from: Date().addingTimeInterval(-940))), "attachments": .array([ref(chart, "chart.png", 640, 400, size: 88_000)])]),
            ])
        }
    }
    private static func stagedPicture(_ size: CGSize, title: String, hue: CGFloat) -> UIImage {
        UIGraphicsImageRenderer(size: size).image { context in
            let colors = [UIColor(hue: hue, saturation: 0.35, brightness: 0.95, alpha: 1).cgColor, UIColor(hue: hue + 0.08, saturation: 0.55, brightness: 0.6, alpha: 1).cgColor]
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            for index in 0..<5 {
                let bar = CGRect(x: 40 + CGFloat(index) * (size.width - 80) / 5, y: size.height * (0.75 - CGFloat(index % 3) * 0.15), width: (size.width - 80) / 7, height: size.height * (0.2 + CGFloat(index % 3) * 0.15))
                UIColor.white.withAlphaComponent(0.8).setFill(); UIBezierPath(roundedRect: bar, cornerRadius: 6).fill()
            }
            (title as NSString).draw(at: CGPoint(x: 24, y: 20), withAttributes: [.font: UIFont.systemFont(ofSize: 24, weight: .semibold), .foregroundColor: UIColor.white])
        }
    }
    /** A reply with each kind of block the web draws: headings, a table, lists and tasks, a quote, code, a rule, links. */
    private static func markdownConversation(scene: String) -> NativeJSON {
        let table = """
        当前会话的团队共有 4 个 Agent，只有主 Agent 正在运行。

        | Agent | 角色 | 当前状态 |
        |---|---|---|
        | `/root` | 主 Agent（Codex） | **正在运行** |
        | `/root/greeting_one` | 子 Agent | 已完成，回复了“你好” |
        | `/root/greeting_two` | 子 Agent | 已完成，回复了“你好” |
        | `/root/greeting_three` | 子 Agent | ~~等待~~ 已完成 |

        ## 下一步

        1. 读 `PhoneRichText.swift` 的分块规则
        2. 对照 [Markdown 文档](https://github.github.com/gfm/) 补齐表格
           - 嵌套的要点
           - 第二个要点
        - [x] 表格横向滚动
        - [ ] 公式渲染

        > 引用：手机上的回复应和电脑上一样易读。
        >
        > 第二段引用，*斜体*与 **加粗**。

        ---

        改动在 [MarkdownView.swift](native/ios/App/Conversation/MarkdownView.swift)。
        """
        let source = """
        先看解析：

        ```swift
        /// Reads a reply as blocks.
        public static func blocks(_ text: String) -> [PhoneRichBlock]? {
            guard text.utf8.count <= limit else { return nil }
            let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .full)
            return try? AttributedString(markdown: text, options: options).runs.map { _ in .rule(quote: 0) } // a deliberately long line to scroll sideways
        }
        ```

        ```bash
        pnpm exec vitest run --config vitest.config.ts apps/host/test/native-swift.test.ts
        ```

        ```diff
        - let font = UIFont.systemFont(ofSize: 16)
        + let font = UIFont.systemFont(ofSize: scaled)
        ```

        """ + "\n\n```text\n" + (1...30).map { "第 \($0) 行日志" }.joined(separator: "\n") + "\n```"
        let prose = """
        ### 接入与协议层

        服务从 [main.go](main.go) 启动，[router.go](router.go) 注册路由。[idl/](idl/) 保存协议定义，例子见 [API.md](docs/API.md)。

        - **请求入口**：`POST /chat` 接收消息，交给 `HandleChat` 处理。
        - **流式返回**：处理器通过 `SSE` 逐段发送结果；客户端按 `event_id` 记录位置。
        - **长标识符**：`ConversationSession.requestConfigurationForSelectedProject` 可随屏幕宽度换行。

        | 阶段 | 内容 |
        | --- | --- |
        | 执行 | `ModelInput` 与 `ToolResults` |

        细节见[协议说明](https://example.org/events)和[路由实现 `router.go`](router.go)。
        """
        let dense = """
        1. **三种消息副本严格隔离**
           - **保存态**（`PersistMessages` / `Storage`）：落入数据库作为事实源。
           - **模型态**（`ModelInput` / `ModelView` / `ContextProvider`）：专供 LLM 推理。
           - **展示态**（`Display` / `DisplayView` / `Surface`）：面向不同客户端出口。
        2. **业务判断下沉到能力包，公共层只管机制和时机**
           - 公共流程（`Handler`、`StreamProcessor`、`eino`）不针对具体业务写 `if/switch` 分支。
           - 并在 [app/wiring.go](app/wiring.go) 和 [app/profiles/](app/profiles/) 完成接线。

        | 类型 | 字段 |
        | --- | --- |
        | 保存态 | `PersistMessages` / `Storage` |
        """
        let diagram = #"""
        ### 单次请求如何流转

        执行入口是 `Runner.Run`。

        ```mermaid
        flowchart TD
          S0["1. 接收请求\n校验身份与会话"] --> S1{"2. 是否命中动作？"}
          S1 -- "命中" --> A1["执行工具"]
          S1 -- "未命中" --> S2["模型推理<br/>Runner.Run"]
          A1 --> S3["3. 写入会话记录"]
          S2 --> S3
          S3 --> S4["返回结果"]
        ```
        """#
        let answer = switch scene {
        case "markdown-code": source
        case "markdown-dense": dense
        case "markdown-prose": prose
        case "markdown-diagram-unsupported": "```mermaid\nflowchart TD\n  A --> B\n  classDef accent fill:#abc\n```"
        case "markdown-diagram": diagram
        default: table
        }
        return patched(conversation()) { root in
            root["messages"] = .array([
                .object(["id": .string("m1"), "role": .string("user"), "text": .string("我们现在的 agent team 有哪些 agent"), "createdAt": .string(stamp.string(from: Date().addingTimeInterval(-1000)))]),
                .object(["id": .string("m2"), "role": .string("assistant"), "text": .string(answer), "createdAt": .string(stamp.string(from: Date().addingTimeInterval(-940)))]),
            ])
        }
    }

    private static let harnesses = """
    [{"id":"standard","status":"ready","modes":["agent","chat"],"agentContext":"private","textOnlyConsultations":true,"capabilities":{"display":{"label":"Latch","mark":"latch"},"models":{"owner":"latch"},"permission":{"enforcement":"latch"},"tools":{"fileMentions":true}}},
     {"id":"codex","status":"ready","modes":["agent"],"agentContext":"first-turn","capabilities":{"display":{"label":"Codex","mark":"codex"},"models":{"owner":"harness"},"permission":{"enforcement":"harness"},"tools":{"fileMentions":true}}},
     {"id":"qwen","status":"missing","modes":["agent"],"agentContext":"first-turn","capabilities":{"display":{"label":"Qwen Code","mark":"qwen"},"models":{"owner":"harness"},"permission":{"enforcement":"harness"}}}]
    """
    private static var snapshotText: String { """
    {"instanceId":"screens","revision":42,"hostName":"\(marker)","approvals":[],"hostTime":"{{0}}",
     "device":{"id":"dev_screens0000000000000000","status":"active","scopes":["view","run","approve:standard"],"dataScope":"all"},
     "catalog":{"features":{"customAgents":true,"agentMentions":true,"singleAgentChat":true,"automations":true,"appPages":1,"queue":true,"fork":true,"search":true},"harnesses":\(harnesses),
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
    private static var fileApprovalText: String { #"""
    {"summary":{"id":"ses_activity_file","title":"补充 README 安装说明","status":"waiting-approval","harnessId":"codex","workspaceId":"latch","mode":"agent","branch":"docs/install"},
     "sync":{"instanceId":"screens","revision":42},"questions":[],"queue":[],
     "approvals":[{"id":"apr_activity_file","risk":"R1","toolName":"write_file","tool":{"kind":"edit","toolTitle":"编辑","locations":["README.md"],
       "diffs":[{"path":"README.md","previous":"text","oldText":"## 安装\npnpm install\n","newText":"## 安装\ncorepack enable\npnpm install\n"}]},
       "options":[{"id":"once","kind":"allow_once","label":"允许一次"},{"id":"no","kind":"reject_once","label":"拒绝"}]}],
     "messages":[{"id":"w1","role":"user","text":"在 README 里补上 Corepack 启用步骤。","createdAt":"{{-200}}"},
      {"id":"w2","role":"tool","toolName":"write_file","state":"awaiting-approval","tool":{"kind":"edit","toolTitle":"编辑","locations":["README.md"]}}]}
    """# }
    private static var commandApprovalText: String { #"""
    {"summary":{"id":"ses_activity_shell","title":"验证终端截图队列","status":"waiting-approval","harnessId":"codex","workspaceId":"latch","mode":"agent","branch":"fix/test"},
     "sync":{"instanceId":"screens","revision":42},"questions":[],"queue":[],
     "approvals":[{"id":"apr_activity_shell","risk":"R2","toolName":"shell","tool":{"kind":"execute","input":"{\"command\":\"pnpm test\",\"cwd\":\"/Users/dev/Projects/latch\",\"grants\":[\"允许后，这条命令在沙箱之外运行\"]}"},
       "options":[{"id":"once","kind":"allow_once","label":"允许一次"},{"id":"no","kind":"reject_once","label":"拒绝"}]}],
     "messages":[{"id":"w1","role":"user","text":"跑一遍当前分支的测试。","createdAt":"{{-200}}"},
      {"id":"w2","role":"tool","toolName":"shell","state":"awaiting-approval","tool":{"kind":"execute","input":"{\"command\":\"pnpm test\",\"cwd\":\"/Users/dev/Projects/latch\"}"}}]}
    """# }
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
                    if PhoneLive.isOn { await model.open() } else { ScreensStage.stage(model); ScreensStage.fitWindow(); await ScreensStage.showPendingActivity() }
                }
                .onChange(of: phase) { _, next in
                    if next == .active && !PhoneLive.isOn { Task { await ScreensStage.showPendingActivity() } }
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
        (id: "ses_eeeeeeeeeeeeeeeeeeeeee", title: "输出 4", harness: "standard"),
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

    /** List metadata is already here. The screenshot test releases the private team projection after reading the screen. */
    private static func stageFirstRows(_ model: PhoneModel, base: NativeJSON) {
        let team = sessionTeamSnapshot(base)
        let names = [teamLead: "核对发布清单", teamMembers[0].id: "检查缓存读取", "ses_ffffffffffffffffffffff": "整理接口说明"]
        let full = patched(team) { fields in
            fields["tasks"] = .array(team["tasks"].array.compactMap { task in
                guard let id = task["id"].string, let title = names[id] else { return nil }
                return patched(task) { $0["title"] = .string(title) }
            })
            fields["catalog"] = patched(team["catalog"]) { catalog in
                catalog["features"] = patched(catalog["features"] ?? .null) { $0["teams"] = .bool(true) }
            }
        }
        stageDisconnected(model)
        model.verifiedUntil = nil; model.privateSnapshot.clear()
        model.connected = false; model.offline = false; model.busy = true
        model.snapshot = patched(full) { fields in
            fields["tasks"] = .array(full["tasks"].array.map { task in patched(task) { $0["teamOf"] = nil } })
            fields["teams"] = nil
        }
        guard let token = UserDefaults.standard.string(forKey: "LatchInboxProbe"), UUID(uuidString: token) != nil else { return }
        let gate = FileManager.default.temporaryDirectory.appendingPathComponent("inbox-" + token)
        try? Data().write(to: gate.appendingPathExtension("ready"))
        Task {
            while !FileManager.default.fileExists(atPath: gate.path) {
                do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
            }
            model.busy = false; model.connected = true; model.verifiedUntil = .distantFuture
            _ = model.privateSnapshot.adopt(full, captured: model.privateSnapshot.epoch, windowOpen: true)
            model.snapshot = full
        }
    }

    /** The lead after round 3 came back: the results card in place of the Host's message, as the desktop draws it. */
    fileprivate static func stageTeamResults(_ model: PhoneModel, base: NativeJSON) {
        let returned = "msg_return_round_three_x", (one, four) = (teamMembers[2], teamMembers[3])
        let item = { (id: String) in "itm_" + id.dropFirst(4) }
        model.snapshot = patched(sessionTeamSnapshot(base)) { fields in
            fields["catalog"] = patched(fields["catalog"]!) { catalog in
                catalog["features"] = patched(catalog["features"]!) {
                    $0["teams"] = .bool(true); $0["fileSearch"] = .bool(true); $0["fileMentions"] = .bool(true)
                }
            }
            var team = fields["teams"]!.array[0].object
            team["members"] = .array(team["members"]!.array.enumerated().map { index, member in
                patched(member) { $0["said"] = .string(index >= 2 ? "你好" : "完成了检查") }
            })
            team["round"] = .number(3); team["returnedMessageId"] = .string(returned)
            func round(_ number: Int, _ ids: [String], returned id: String, at message: String? = nil) -> NativeJSON {
                var round: [String: NativeJSON] = ["round": .number(Double(number)), "by": .string("person"), "state": .string("returned"), "returnedMessageId": .string(id),
                    "createdAt": .string("2026-11-01T09:00:00Z"),
                    "members": .array(ids.map { .object(["itemId": .string(item($0)), "state": .string("done"), "requestId": .string("req_" + $0.dropFirst(4))]) })]
                if let message { round["messageId"] = .string(message) }
                return .object(round)
            }
            // Round 3 was sent from the lead's reply m2: its 团队分工 card stands after that turn, above the results.
            team["rounds"] = .array([round(1, teamMembers.map(\.id), returned: "msg_r1"), round(2, [one.id], returned: "msg_r2"),
                                     round(3, [one.id, four.id], returned: returned, at: "m2")])
            fields["teams"] = .array([.object(team)])
        }
        let lead = model.snapshot["tasks"].array.first { $0["id"].string == teamLead } ?? .null
        let now = Date()
        func message(_ id: String, _ role: String, _ text: String, _ ago: Double) -> NativeJSON {
            .object(["id": .string(id), "role": .string(role), "text": .string(text), "createdAt": .string(stamp.string(from: now.addingTimeInterval(-ago)))])
        }
        let back = PhoneTeamReturn.heading + "\n\n## 输出 1\n你好\n\n## 输出 4\n你好"
        model.tab = .code; model.sessionId = teamLead
        model.detail = .object(["summary": lead, "sync": .object(["instanceId": .string("screens"), "revision": .number(42)]),
            "messages": .array([message("m1", "user", "@输出 1 @输出 4 再各说一次你好", 300), message("m2", "assistant", "已经发给两个成员，等它们回来。", 290),
                                message(returned, "user", back, 60), message("m4", "assistant", "两个成员都回复了“你好”。", 40)])])
        for member in [one, four] {
            model.stagedMemberSessions[member.id] = [
                .object(["id": .string("a"), "role": .string("user"), "text": .string("开始"), "requestId": .string("first")]),
                .object(["id": .string("b"), "role": .string("assistant"), "text": .string("你好")]),
                .object(["id": .string("c"), "role": .string("user"), "text": .string("再说一次"), "requestId": .string("req_" + member.id.dropFirst(4))]),
                .object(["id": .string("d"), "role": .string("assistant"), "text": .string("**你好**，这是第 3 轮的回复。\n\n| 项 | 结果 |\n|---|---|\n| 问候 | 已完成 |")]),
            ]
        }
    }

    /**
     * The lead after round 3, with a newer team started from its last reply and still at work: one member running, one
     * waiting for the person, one done, one failed and one its Harness refused, on the switch that lets the agent send work.
     */
    fileprivate static func stageTeamGraph(_ model: PhoneModel, base: NativeJSON) {
        stageTeamResults(model, base: base)
        let started = stamp.string(from: Date().addingTimeInterval(-95))
        func member(_ id: String, _ name: String, _ harness: String, _ state: String, said: String? = nil, refusal: String? = nil) -> NativeJSON {
            var fields: [String: NativeJSON] = ["itemId": .string("itm_check_" + id), "name": .string(name), "title": .string(name),
                "harnessId": .string(harness), "state": .string(state), "startedAt": .string(started)]
            if refusal == nil { fields["sessionId"] = .string("ses_check_" + id) }
            if let said { fields["said"] = .string(said) }
            if let refusal { fields["refusal"] = .string(refusal) }
            return .object(fields)
        }
        let newer = NativeJSON.object(["id": .string("tem_bbbbbbbbbbbbbbbbbbbbbb"), "leadSessionId": .string(teamLead), "messageId": .string("m4"),
            "goal": .string("核对团队分工卡片"), "state": .string("running"), "agentDispatch": .bool(true),
            "createdAt": .string("2026-11-01T11:00:00Z"), "updatedAt": .string("2026-11-01T11:00:00Z"),
            "members": .array([member("read", "审阅改动", "codex", "running", said: "正在读 PhoneTeamGraph.swift"),
                               member("test", "跑测试", "standard", "waiting", said: "要运行 pnpm check:quick，等你批准"),
                               member("docs", "写文档", "codex", "done", said: "DESIGN.md 已更新"),
                               member("lint", "修复 lint", "standard", "failed", said: "oxlint 没有通过"),
                               member("qwen", "对照桌面", "qwen", "unstarted", refusal: "Qwen Code 没有登录")])])
        model.snapshot = patched(model.snapshot) { fields in fields["teams"] = .array(fields["teams"]!.array + [newer]) }
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
            return json(#"{"scope":"turn","turnId":"turn_1","totals":{"files":3,"add":12,"del":4},"files":[{"root":"latch","path":"\#(fileName)","status":"M","add":3,"del":1},{"root":"latch","path":"native/ios/App/Agents/AgentsView.swift","status":"M","add":8,"del":3},{"root":"latch","path":"docs/ARCHITECTURE.md","status":"M","add":1,"del":0,"byCommand":true}]}"#)
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
        guard ["computers", "computers-settings", "computers-work", "computers-work-list"].contains(name) else { return false }
        // A Host with 待办 puts the 会话 | 待办 switch beside a long computer name and both toolbar actions.
        if name.hasPrefix("computers-work") { model.snapshot = workSnapshot(); model.showWorkItems(name == "computers-work-list") }
        let hosts = [host("studiohostaaaa", "aaaaaaaaaaaaaaaaaaaaaa", "Studio-MacBook-Pro"), host("buildminibbbb", "bbbbbbbbbbbbbbbbbbbbbb", "build-mini"),
                     host("macminicccc", "cccccccccccccccccccccc", "Mac mini"), host("d7k2spoofdddd", "dddddddddddddddddddddd", "build-m\u{0456}ni")].compactMap { $0 }
        model.hosts = hosts; model.selectedHost = hosts.first; model.lastConfirmed = Date()
        let token = model.computerDesk.watch(selected: hosts[0].id, others: hosts.dropFirst().map(\.id))
        let readings = [
            NativeWatchReading(token: token, id: hosts[1].id, state: .online, list: json(#"{"tasks":[{"id":"ses_b1","title":"升级 Node 到 24.22 并跑一遍测试","status":"waiting-approval","updatedAt":"{{-120}}","live":{"lastEventAt":"{{-120}}"}},{"id":"ses_b2","title":"夜间构建要不要清缓存","status":"running","pendingQuestions":1,"updatedAt":"{{-900}}","live":{"lastEventAt":"{{-900}}"}}]}"#), lastSeen: Date()),
            NativeWatchReading(token: token, id: hosts[2].id, state: .offline, list: json(#"{"tasks":[{"id":"ses_c1","title":"a","status":"waiting-approval","updatedAt":"{{-4000}}"},{"id":"ses_c2","title":"b","status":"waiting-approval","updatedAt":"{{-4100}}"},{"id":"ses_c3","title":"c","status":"running","pendingQuestions":2,"updatedAt":"{{-4200}}"}]}"#), lastSeen: Date().addingTimeInterval(-3600)),
            NativeWatchReading(token: token, id: hosts[3].id, state: .wrongHost, list: .null, lastSeen: nil),
        ]
        for reading in readings { _ = model.computerDesk.receive(reading, notifying: false) }
        model.tab = name == "computers-settings" ? .settings : .code
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
            return json(#"{"sha":"\#(sha)","files":[{"path":"\#(workLongFile)","status":"M","add":12,"del":4},{"path":"docs/HARNESSES.md","status":"M","add":2,"del":0}],"totals":{"files":2,"add":14,"del":4}}"#)
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
            if scene == "work-waiting" {
                object["agentChats"] = patched(object["agentChats"]!) { chats in
                    chats[daily] = .object(["state": .string("ready"), "sessionId": .string("ses_daily")])
                }
            }
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

extension ScreensStage {
    /** 额度与用量 opened from 设置: Harnesses in every state the sheet draws, and a canned 用量 for each period and grouping. */
    fileprivate static func stageUsage(_ model: PhoneModel, base: NativeJSON, tab: UsageTab, staleAntigravity: Bool = false) {
        model.tab = .settings
        usageTab = tab
        func own(_ id: String, _ label: String, quota: Bool = true, _ extra: String = "") -> String {
            #"{"id":"\#(id)","status":"ready","modes":["agent"],"capabilities":{"display":{"label":"\#(label)","mark":"\#(id)"},"models":{"owner":"harness"\#(quota ? #","quota":true"# : "")}}\#(extra)}"#
        }
        let harnesses = "[" + [
            #"{"id":"standard","status":"ready","modes":["agent","chat"],"capabilities":{"display":{"label":"Latch","mark":"latch"},"models":{"owner":"latch"}}}"#,
            own("claude-agent", "Claude Agent", #","quota":{"plan":"max","account":"n•••@f•••.com","state":"near","observedAt":"{{-120}}","windows":[{"kind":"five-hour","usedPercent":18,"resetsAt":"{{9000}}"},{"kind":"weekly","usedPercent":22,"resetsAt":"{{410000}}"},{"kind":"weekly-opus","usedPercent":84,"resetsAt":"{{410000}}"}]}"#),
            own("codex", "Codex", #","quota":{"plan":"pro","account":"l•••@e•••.com","state":"ok","observedAt":"{{-300}}","windows":[{"kind":"five-hour","usedPercent":12,"resetsAt":"{{14400}}"},{"kind":"weekly","usedPercent":61,"resetsAt":"{{432000}}"}]}"#),
            own("antigravity", "Antigravity", #","quota":{"state":"limited","observedAt":"{{\#(staleAntigravity ? -2400 : -600)}}","windows":[{"kind":"rolling","group":"gemini","windowMinutes":300,"usedPercent":12,"resetsAt":"{{12000}}"},{"kind":"rolling","group":"claude-gpt","windowMinutes":300,"usedPercent":100,"resetsAt":"{{3000}}"}]}"#),
            own("grok", "Grok Build", #","quotaRead":{"running":true}"#),
            own("dsh", "DeepSeek Harness", #","quotaRead":{"failed":{"at":"{{-60}}","reason":"no-key"}}"#),
            own("pi", "pi", quota: false), own("opencode", "OpenCode", quota: false),
        ].joined(separator: ",") + "]"
        model.snapshot = patched(base) { object in
            var catalog = object["catalog"]!.object, features = catalog["features"]!.object
            features["modelUsage"] = .bool(true)
            catalog["features"] = .object(features)
            catalog["harnesses"] = json(harnesses)
            object["catalog"] = .object(catalog)
        }
    }

    /** What the Host would answer for `POST /link/api/usage`, the same shape for every period and grouping. */
    static func usage(period: String, group: String) throws -> NativeJSON {
        guard PhoneUsage.periods.contains(period), PhoneUsage.groups.contains(group) else { throw NativeFailure.invalidRecord }
        let hourly = period == "1", count = hourly ? 24 : Int(period) ?? 30
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .current
        let end = hourly ? calendar.dateInterval(of: .hour, for: Date())!.start : calendar.startOfDay(for: Date())
        let buckets = (0..<count).map { index in
            stamp.string(from: calendar.date(byAdding: hourly ? .hour : .day, value: index - count + 1, to: end)!)
        }
        let series = (0..<count).map { index -> NativeJSON in
            // A working week's rhythm: quiet nights and weekends, a busier middle.
            let wave = 0.55 + 0.45 * sin(Double(index) * (hourly ? 0.26 : 0.9)) + Double((index * 37) % 11) / 30
            let input = Int(wave * (hourly ? 90_000 : 1_800_000)), output = input / 9
            return .object(["bucket": .number(Double(index)), "by": .string("own"), "harness": .string("codex"), "requests": .number(0), "turns": .number(3),
                "measured": .number(3), "inputTokens": .number(Double(input)), "outputTokens": .number(Double(output)),
                "cacheReadTokens": .number(Double(input) * 0.62), "cacheBase": .number(Double(input))])
        }
        let scale = Double(count) / (hourly ? 24 : 7)
        func row(_ fields: String, _ input: Double, _ output: Double, turns: Int, requests: Int = 0, cost: String = "[]") -> String {
            #"{"by":"own",\#(fields),"requests":\#(requests),"turns":\#(turns),"failed":0,"fallbacks":0,"measured":\#(turns + requests),"usage":{"inputTokens":\#(Int(input * scale)),"outputTokens":\#(Int(output * scale))},"partial":{"cacheReadTokens":false,"cacheWriteTokens":false,"reasoningTokens":false},"cost":\#(cost),"uncosted":0}"#
        }
        let rows: [String] = switch group {
        case "harness": [
            row(#""harness":"codex""#, 6_200_000, 610_000, turns: 84, cost: #"[{"currency":"USD","micros":\#(Int(18_400_000 * scale)),"estimated":true}]"#),
            row(#""harness":"claude-agent""#, 4_100_000, 380_000, turns: 51),
            row(#""harness":"standard""#, 820_000, 96_000, turns: 0, requests: 140, cost: #"[{"currency":"CNY","micros":\#(Int(3_260_000 * scale))}]"#),
        ]
        case "model": [
            row(#""harness":"codex","model":"gpt-5.5""#, 6_200_000, 610_000, turns: 84, cost: #"[{"currency":"USD","micros":\#(Int(18_400_000 * scale)),"estimated":true}]"#),
            row(#""harness":"claude-agent","model":"claude-opus-5-5""#, 4_100_000, 380_000, turns: 51),
            row(#""providerId":"deepseek","model":"deepseek-chat","harness":"standard""#, 820_000, 96_000, turns: 0, requests: 140, cost: #"[{"currency":"CNY","micros":\#(Int(3_260_000 * scale))}]"#),
        ]
        default: [
            row(#""projectId":"latch""#, 8_300_000, 790_000, turns: 112),
            row(#""projectId":"site""#, 2_000_000, 210_000, turns: 23),
            row(#""projectId":"default""#, 820_000, 86_000, turns: 0, requests: 140),
        ]
        }
        return patched(json("{\"rows\":[" + rows.joined(separator: ",") + "]}")) { fields in
            fields["period"] = .string(period); fields["group"] = .string(group); fields["by"] = .string("all")
            fields["timeZone"] = .string(TimeZone.current.identifier)
            fields["buckets"] = .array(buckets.map(NativeJSON.string)); fields["series"] = .array(series)
            fields["truncated"] = .bool(false)
        }
    }
}
