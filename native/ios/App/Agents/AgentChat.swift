import LatchNativeCore
import SwiftUI
import UIKit

/** The Agent a conversation frames, and what its header does. */
struct AgentFrame {
    let owner: String
    let entry: PhoneAgentEntry
    let openProfile: () -> Void
    let openTopic: (String) -> Void
}

/** The frame's header: the Agent's face, name and topic (they open the profile), then 话题 and the session's own menu. */
struct AgentFrameItems: ToolbarContent {
    let frame: AgentFrame
    /** The open topic's summary; null on a new topic. */
    let topic: NativeJSON
    let shown: String?
    var body: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .topBarLeading) { AgentFrameTitle(frame: frame, topic: topic) }.sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { AgentFrameTitle(frame: frame, topic: topic) }
        }
        if shown != nil { ToolbarItem(placement: .topBarTrailing) { TopicActions(topic: topic) } }
    }
}

private struct AgentFrameTitle: View {
    @EnvironmentObject private var model: PhoneModel
    let frame: AgentFrame
    let topic: NativeJSON
    @Environment(\.horizontalSizeClass) private var width
    var body: some View {
        let entry = frame.entry
        Button(action: frame.openProfile) {
            HStack(spacing: 8) {
                AgentFace(avatar: entry.avatar, size: 28, face: entry.face)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(entry.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(PhoneTheme.ink).lineLimit(1)
                        if let words = model.connected ? PhoneHelperSpeech.activity(topic) ?? entry.face.words : nil { FaceWord(face: entry.face, words: words) }
                    }
                    if topic != .null, let title = topic["title"].string {
                        Text(PhoneConversation.visible(title)).font(.system(size: 12)).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                    }
                }
            }
            .frame(width: width == .compact ? 168 : 400, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel(entry.name).accessibilityHint("打开资料")
    }
}

/** 重命名, 归档 and the rest, as the session's title menu has them in Code. */
private struct TopicActions: View {
    @EnvironmentObject private var model: PhoneModel
    let topic: NativeJSON
    var body: some View {
        if !PhoneSessionMenu.sections(topic, canRun: model.canRun).isEmpty {
            Menu { SessionMenuButtons(task: topic, open: true) } label: { Image(systemName: "ellipsis").foregroundStyle(PhoneTheme.ink) }
                .accessibilityLabel("会话操作")
        }
    }
}

/** The Host's chat is authoritative. A historical session opens only through an explicit link. */
struct AgentChat: View {
    @EnvironmentObject private var model: PhoneModel
    let id: String
    @State private var picked: String?
    @State private var firstPage = false
    @State private var profile = false
    @Environment(\.horizontalSizeClass) private var width
    private var tasks: [NativeJSON] { model.snapshot["tasks"].array }
    private var entry: PhoneAgentEntry? { PhoneAgents.entry(model.snapshot, id: id, windowOpen: model.verifiedUntil != nil) }
    private var shown: String? {
        if let picked { return picked }
        if firstPage || model.pending.contains(where: { PhonePending.kind($0) == .topic(owner: id) }) { return nil }
        return PhoneAgentChat.session(model.snapshot, owner: id)
    }
    var body: some View {
        Group {
            switch model.agentAccess {
            case .loading: LoadingAgents()
            case .locked: LockedAgents()
            case .confirming: ConfirmingAgents()
            case .closed: ClosedAgents()
            default:
                if let entry { chat(entry) }
                else {
                    VStack(spacing: 12) {
                        Text("找不到这个 Agent").font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink)
                        Button("回到列表") { model.agentPath = [] }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).padding(.top, 48)
                }
            }
        }
        .background(PhoneTheme.canvas)
        .safeAreaInset(edge: .top, spacing: 0) {
            if let entry, model.agentAccess == .ready, model.engineInfo(entry.harnessId)["level"].string == "L3" {
                let detail = shown != nil && model.detail["summary"]["id"].string == shown ? model.detail : .null
                HelperPermissionLine(name: entry.name, note: PhoneHelperSpeech.permission(detail, harness: model.engineInfo(entry.harnessId)))
                    .padding(.horizontal, 16).padding(.vertical, 6)
            }
        }
        // A pushed conversation on a phone needs the room, a new topic as much as a topic.
        .toolbar(width == .compact && model.agentAccess == .ready ? .hidden : .automatic, for: .tabBar)
        .sheet(isPresented: $profile) {
            AgentProfileSheet(id: id, openTopic: { topic in profile = false; reach(topic) }).presentationCornerRadius(28)
        }
        // The topic shown is the one this page keeps open; a topic opened elsewhere meanwhile is replaced when it shows again.
        .task(id: [shown ?? "", model.verifiedUntil == nil ? "closed" : "open"]) { await follow() }
        .onChange(of: model.questionTopic, initial: true) { _, target in
            guard let target, model.agentPath.first == id,
                  PhoneAgentChat.home(tasks, session: target, owner: id) == .agents else { return }
            picked = target; profile = false; model.questionTopic = nil
        }
        .task(id: [id, PhoneProposals.signature(model.snapshot, owner: id), model.verifiedUntil == nil ? "closed" : "open"]) { await model.loadProposals(id) }
        .onChange(of: model.verifiedUntil == nil) { _, closed in if closed { profile = false } }
        #if LATCH_SCREENS
        .onAppear { if ScreensStage.profile { profile = true } }
        #endif
    }
    /**
     * Opens a session from this page: one of this Agent's own stays in its conversation; any other (a run of 通用's schedule
     * names no Agent and is Code's) opens in Code, as the web's `choose` does.
     */
    private func reach(_ session: String) {
        if PhoneAgentChat.home(tasks, session: session, owner: id) == .agents { picked = session; return }
        Task { model.tab = .code; await model.openSession(session) }
    }
    private func follow() async {
        guard model.agentAccess == .ready else { return }
        if let shown {
            if model.sessionId != shown { await model.openSession(shown) }
        } else if model.sessionId != nil { model.closeSession() }
    }
    @ViewBuilder private func chat(_ entry: PhoneAgentEntry) -> some View {
        let frame = AgentFrame(owner: id, entry: entry, openProfile: { profile = true }, openTopic: { reach($0) })
        if let shown { ConversationView(id: shown, frame: frame) }
        else { NewTopicView(frame: frame, started: { picked = $0; firstPage = false }).onAppear { firstPage = true } }
    }
}

/**
 * A new topic: the Agent's face, name and duty, and an input whose first message starts its session with `customAgentId`
 * (通用's `general`) on the Agent's fixed Harness, with a model and project chosen for this topic. A start whose result is
 * unknown keeps its request: 重试同一请求, or 放弃这次提交 to have the text back.
 */
private struct NewTopicView: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.horizontalSizeClass) private var width
    let frame: AgentFrame
    let started: (String) -> Void
    @State private var choice = PhoneStartChoice()
    @State private var prompt = ""
    @State private var sending = false
    @State private var focused = false
    @StateObject private var slash = SlashComposerState()
    @State private var slashSpace: CGFloat = 198
    @State private var modelPicker = false
    @State private var modelQuery = ""
    @State private var openedHost: UUID?
    @State private var openedContent: UUID?
    @State private var delivered = false
    /** The picker the ＋ opened. */
    @State private var attachSource: AttachSource?
    @StateObject private var files = SessionFilePreview()
    private var attachKey: String { PhoneModel.topicTray(frame.owner) }
    /** Checked against this one topic's Harness, project and model, as the start will send them. */
    private var attachSelection: NativeJSON? {
        (try? model.topicFields(owner: frame.owner, agent: agent, choice: choice, prompt: "")).flatMap { PhoneAttachments.selection(startFields: $0) }
    }
    private var general: Bool { frame.owner == PhoneAgents.generalId }
    private var catalog: NativeJSON { model.snapshot["catalog"] }
    private var agent: NativeJSON { model.snapshot["customAgents"].array.first { $0["id"].string == frame.owner } ?? .null }
    private var harness: NativeJSON { PhoneStart.harness(catalog, choice.harnessId) }
    private var slashContext: PhoneSlashContext {
        var value = PhoneSlashContext(bodyOpen: model.agentAccess == .ready && model.connected && model.verifiedUntil.map { $0 > Date() } == true, canRun: model.canRun)
        value.pending = sending || model.busy || !model.pending.isEmpty
        value.firstTurn = true; value.harnessId = choice.harnessId; value.projectId = choice.workspaceId
        if PhoneStart.usesServices(harness), !PhoneStart.models(catalog).isEmpty { value.actions.insert(.model) }
        value.actionReasons[.new] = "每个 Agent 只有一条聊天"
        return value
    }
    private var slashMenu: PhoneSlashMenu? { slashSpace < 44 ? nil : slash.menu(prompt, commands: [], context: slashContext, focused: focused) }
    private var slashRead: SlashReadKey { SlashReadKey(model: model, enabled: focused && slashContext.bodyOpen, retry: slash.retry) }
    private var slashReason: String? { if case let .unavailable(reason) = PhoneSlash.action(prompt, context: slashContext) { reason } else { nil } }
    private var mine: [NativePendingWrite] { model.pending.filter { PhonePending.kind($0) == .topic(owner: frame.owner) } }
    private var readyChat: String? { PhoneAgentChat.session(model.snapshot, owner: frame.owner) }
    private var blocker: String? {
        if !mine.isEmpty { return nil }
        if !model.pending.isEmpty { return "上一项提交结果待确认" }
        if !catalog["features"]["singleAgentChat"].bool { return "Mac 需要更新后才能开始聊天" }
        let chat = PhoneAgentChat.slot(model.snapshot, owner: frame.owner)
        if chat["state"].string != "empty" { return readyChat == nil ? "正在确认聊天" : nil }
        if general { return PhoneAgentChat.generalBlocker(catalog, choice: choice, connected: model.connected, canRun: model.canRun) }
        return PhoneAgents.blocker(catalog, agent: agent, choice: choice, connected: model.connected, canRun: model.canRun)
    }
    private var canSend: Bool {
        guard PhoneAgentChat.slot(model.snapshot, owner: frame.owner)["state"].string == "empty" else { return false }
        if PhoneSlash.actionOf(prompt) != nil {
            if case .open = PhoneSlash.action(prompt, context: slashContext) { return !slash.composing }; return false
        }
        return blocker == nil && mine.isEmpty && !sending && !model.busy && !slash.composing && (!prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.tray(attachKey).isEmpty)
    }
    /** Cards of runs that settled while the Agent had no topic: here until the next topic keeps them. */
    private var waiting: [PhoneScheduleResult] { model.agentResults[frame.owner] ?? [] }
    var body: some View {
        ScrollView {
            if !waiting.isEmpty {
                ResultStack(results: waiting, openActivity: frame.openProfile, openRun: frame.openTopic,
                    openFile: { file, run in files.open(model, reference: file.path, root: file.root, session: run) })
                    .frame(maxWidth: 760).padding(.horizontal, 16).padding(.vertical, 20).frame(maxWidth: .infinity)
            }
        }
        .sessionFilePreview(files)
        .task(id: [frame.owner, PhoneResults.signature(model.snapshot, owner: frame.owner), model.verifiedUntil == nil ? "closed" : "open"]) {
            await model.loadResults(frame.owner)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { AgentFrameItems(frame: frame, topic: .null, shown: nil) }
        .conversationDock { dock.frame(maxWidth: 760).frame(maxWidth: .infinity) }
        .task(id: frame.owner + "\(agent["revision"].integer ?? 0)") {
            choice = general ? PhoneAgentChat.generalChoice(catalog) : PhoneAgents.choice(catalog, agent: agent)
        }
        .modifier(AttachSupport(key: attachKey, selection: attachSelection, harness: harness, source: $attachSource))
        .sheet(isPresented: $modelPicker) {
            NavigationStack { ModelList(models: PhoneStart.models(catalog), chosen: $choice.model, initialQuery: modelQuery) }.presentationCornerRadius(28)
        }
        .onChange(of: prompt) { _, value in slash.changed(value) }
        .onChange(of: model.privateSnapshot.epoch) { _, _ in slash.clear(); modelPicker = false }
        .task(id: slashRead) { await slash.load(model, key: slashRead) }
        .onAppear {
            openedHost = model.generation; openedContent = model.privateSnapshot.epoch
            if let held = model.takeDraft(for: attachKey) { prompt = held }
        }
        // Not delivered, for certain: the text comes back into this input.
        .onChange(of: model.returnedText[attachKey], initial: true) { _, value in if let value { prompt = PhonePending.joined(prompt, value); model.returnedText[attachKey] = nil } }
        // Leaving the new topic lets go of what was attached here, unless a start that carries them is still unconfirmed.
        .onDisappear {
            slash.clear()
            if !delivered, model.generation == openedHost, model.privateSnapshot.epoch == openedContent,
               model.verifiedUntil.map({ $0 > Date() }) == true { model.holdDraft(prompt, for: attachKey) }
            if PhoneAttachments.dropsOnClose(key: attachKey, pending: model.pending, starting: sending, verifying: model.verifying, covered: false) { model.dropAttachments(attachKey) }
        }
    }
    private var dock: some View {
        VStack(spacing: 8) {
            ForEach(mine, id: \.requestId) { pending in
                HStack(spacing: 10) {
                    Label("第一条消息结果待确认", systemImage: "clock").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                    Spacer()
                    Button("重试同一请求") { retry(pending) }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                    Button("放弃这次提交") {
                        Task { if case let .text(back, _) = await model.abandonPrompt(pending) { prompt = PhonePending.joined(prompt, back) } }
                    }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).disabled(model.busy)
                    InfoHint(text: "放弃只会结束此设备的等待。文字会保留。如果 Mac 已收到第一条消息，可以打开聊天继续。")
                }.padding(.horizontal, 16)
            }
            if let readyChat, mine.isEmpty {
                Button(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "打开聊天" : "带上草稿打开聊天") {
                    let prior = model.takeDraft(for: readyChat) ?? ""
                    model.holdDraft(PhonePending.joined(prior, prompt), for: readyChat)
                    prompt = ""
                    started(readyChat)
                }.buttonStyle(.borderedProminent).disabled(!model.tray(attachKey).isEmpty)
                if !model.tray(attachKey).isEmpty { Text("打开聊天前请先在此移除附件，再到聊天中添加。").font(PhoneTheme.caption) }
            }
            if let blocker { Text(blocker).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).lineLimit(2).padding(.horizontal, 16).frame(maxWidth: .infinity, alignment: .leading) }
            AttachmentRows(key: attachKey, selection: attachSelection)
            if let slashReason { Text(slashReason).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16) }
            if let menu = slashMenu {
                SlashSuggestions(menu: menu, active: slash.active(menu, text: prompt), engine: frame.entry.name, mark: PhoneStart.mark(harness), reportedCommands: 0,
                    loading: slash.loading, failure: slash.failure, maximumHeight: slashSpace, retry: { slash.retry += 1 },
                    choose: { slash.complete(menu, option: $0, text: $prompt, enabled: slashContext.bodyOpen && slashContext.canRun && !slashContext.pending) }).padding(.horizontal, 12)
            }
            if readyChat == nil || !prompt.isEmpty || !model.tray(attachKey).isEmpty || !mine.isEmpty { field }
        }.padding(.bottom, 8).padding(.top, 4)
    }
    /** This topic's project (not for General) and model; the Harness remains the owner's. */
    @ViewBuilder
    private var picks: some View {
        Section {
                if !general {
                    Menu("在项目里做") {
                        ForEach(PhoneHelperCreate.projects(catalog, harnessId: choice.harnessId ?? "")) { project in
                            Button { choice.workspaceId = project.id } label: { check(project.name, on: project.id == choice.workspaceId) }.disabled(project.unavailable != nil)
                        }
                    }
                }
                if PhoneStart.usesServices(harness) {
                    Menu("这次用的模型") {
                        if !general { Button { choice.model = nil } label: { check("默认模型", on: choice.model == nil) } }
                        ForEach(PhoneStart.models(catalog)) { item in Button { choice.model = item } label: { check(item.model + " · " + item.providerName, on: item == choice.model) } }
                    }
                }
        }
        .disabled(sending || !mine.isEmpty)
    }
    private var field: some View {
        let placeholder = PhoneAgentChat.placeholder(frame.entry.name)
        return ConversationInputBar(focused: $focused) {
            ComposerMenu(key: attachKey, harness: harness, selection: attachSelection, source: $attachSource) {
                SlashMenuItem(slash: slash, text: $prompt, focused: $focused, context: slashContext)
                picks
            }
        } editor: {
            LocalTextEditor(text: $prompt, placeholder: placeholder, maximumLines: slashMenu == nil ? 6 : 3, focused: $focused,
                selection: $slash.selection, composing: $slash.composing, selectionRequest: $slash.selectionRequest,
                commandKeys: slashKeys, onCommand: slashKey, suffixHint: slash.hint(prompt, commands: [], enabled: slashContext.bodyOpen && slashContext.canRun && !slashContext.pending))
                .overlay(alignment: .topLeading) {
                    if prompt.isEmpty { PromptHint(text: placeholder) }
                }
        } action: {
            Button { send() } label: {
                Group {
                    if sending { ProgressView().controlSize(.small).tint(.white) }
                    else { Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)) }
                }
                .foregroundStyle(canSend || sending ? Color.white : PhoneTheme.faint)
                .frame(width: 36, height: 36).background(canSend || sending ? PhoneTheme.accent : PhoneTheme.bubble, in: Circle())
                .frame(width: 44, height: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(!canSend).accessibilityLabel("发送")
        }
        .background(GeometryReader { proxy in Color.clear.onChange(of: proxy.frame(in: .global).minY, initial: true) { _, value in slashSpace = max(0, value - proxy.safeAreaInsets.top - 12) } })
        .disabled(!mine.isEmpty)
    }
    private func check(_ name: String, on: Bool) -> some View {
        Group { if on { Label(name, systemImage: "checkmark") } else { Text(name) } }
    }
    private func send() {
        guard canSend, !slash.composing else { return }
        switch PhoneSlash.action(prompt, context: slashContext) {
        case .text: break
        case .unavailable: return
        case let .open(action, argument):
            guard action == .model else { return }
            modelQuery = argument; modelPicker = true; prompt = ""; slash.clear(); return
        }
        sending = true
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let host = model.generation, content = model.privateSnapshot.epoch, reading = model.contentGeneration
        let owner = frame.owner, chosenAgent = agent, chosen = choice, key = attachKey
        Task {
            var ids: [String] = []
            if !model.tray(attachKey).isEmpty {
                // Waits for uploads still on their way; one that cannot go keeps the message here.
                guard case let .success(value) = await model.attachmentsToSend(attachKey, target: nil) else { model.endAttachmentSend(attachKey); sending = false; return }
                ids = value
            }
            guard model.generation == host, model.privateSnapshot.epoch == content, model.contentGeneration == reading else {
                model.endAttachmentSend(key); sending = false; return
            }
            let done = await model.startTopic(owner: owner, agent: chosenAgent, choice: chosen, prompt: text, attachments: ids)
            model.endAttachmentSend(key)
            guard model.generation == host, model.privateSnapshot.epoch == content else { sending = false; return }
            delivered = done
            prompt = PhoneAgentChat.promptAfterStart(prompt, pending: model.pending, owner: frame.owner, started: done)
            if done, let id = model.sessionId { started(id) }
            sending = false
        }
    }
    private var slashKeys: [String] {
        var keys = canSend ? ["submit"] : []
        guard let menu = slashMenu else { return keys }
        keys.append(UIKeyCommand.inputEscape)
        if menu.options.contains(where: { $0.unavailable == nil }) { keys += [UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow] }
        if slash.active(menu, text: prompt) != nil { keys += ["\t", "\r"] }
        return keys
    }
    private func slashKey(_ key: String) {
        guard !slash.composing else { return }
        if key == "submit" { if canSend { send() }; return }
        guard let menu = slashMenu else { return }
        if key == UIKeyCommand.inputEscape { slash.dismiss(prompt); return }
        if key == UIKeyCommand.inputUpArrow || key == UIKeyCommand.inputDownArrow { slash.move(menu, text: prompt, down: key == UIKeyCommand.inputDownArrow); return }
        guard let selected = slash.active(menu, text: prompt), menu.options.indices.contains(selected) else { return }
        let option = menu.options[selected]
        guard slash.complete(menu, option: option, text: $prompt, enabled: slashContext.bodyOpen && slashContext.canRun && !slashContext.pending) else { return }
        if key == "\r", option.kind == .action { send() }
    }
    private func retry(_ pending: NativePendingWrite) {
        sending = true
        Task {
            if await model.finishTopic(pending), let id = model.sessionId { prompt = ""; started(id) }
            sending = false
        }
    }
}

private struct HelperPermissionLine: View {
    let name: String
    let note: PhoneHelperPermission?
    var body: some View {
        HStack(spacing: 5) {
            Text(note?.words ?? "Latch 不隔离" + name).font(.system(size: 12)).foregroundStyle(note?.warning == true ? PhoneTheme.amber : PhoneTheme.muted)
            HintButton(label: "做事前与本机能力", text: (note?.words == "权限没确认" ? "Latch 说不准它动手前会不会问你。" : note?.words == "不先问你" ? "它动手前不问你。" : "") + "它能读写本机文件、运行命令，Latch 不隔离它。")
            Spacer(minLength: 0)
        }
    }
}
