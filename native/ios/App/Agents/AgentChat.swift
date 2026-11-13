import LatchNativeCore
import SwiftUI

/** The Agent a conversation frames, and what its header does. */
struct AgentFrame {
    let owner: String
    let entry: PhoneAgentEntry
    let openProfile: () -> Void
    let newTopic: () -> Void
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
        ToolbarItem(placement: .topBarTrailing) { TopicsMenu(frame: frame, shown: shown) }
        if shown != nil { ToolbarItem(placement: .topBarTrailing) { TopicActions(topic: topic) } }
    }
}

private struct AgentFrameTitle: View {
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
                        if let words = entry.face.words { FaceWord(face: entry.face, words: words) }
                    }
                    Text(topic == .null ? "新话题" : PhoneConversation.visible(topic["title"].string ?? "未命名会话"))
                        .font(.system(size: 12)).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                }
            }
            .frame(width: width == .compact ? 168 : 400, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel(entry.name).accessibilityHint("打开资料")
    }
}

/** 话题: 新话题 first, then this Agent's topics newest first (the open one checked), then 已归档. */
private struct TopicsMenu: View {
    @EnvironmentObject private var model: PhoneModel
    let frame: AgentFrame
    let shown: String?
    var body: some View {
        let topics = PhoneAgentChat.topics(model.snapshot["tasks"].array, id: frame.owner)
        Menu {
            Button("新话题", systemImage: "square.and.pencil", action: frame.newTopic)
            Section { ForEach(topics.open, id: \.id) { row($0) } }
            if !topics.archived.isEmpty { Menu("已归档") { ForEach(topics.archived, id: \.id) { row($0) } } }
        } label: {
            HStack(spacing: 4) {
                Text("话题").font(.system(size: 15, weight: .medium))
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
            }.foregroundStyle(PhoneTheme.ink)
        }
        .accessibilityLabel("话题")
    }
    private func row(_ task: NativeJSON) -> some View {
        let id = task["id"].string ?? ""
        let words = PhoneAgentChat.topicWords(task, frozen: !model.connected) ?? PhoneTime.parse(task["updatedAt"]).map { PhoneTime.relative($0) } ?? ""
        return Button { frame.openTopic(id) } label: {
            if id == shown { Label(PhoneConversation.visible(task["title"].string ?? "未命名会话"), systemImage: "checkmark") }
            else { Text(PhoneConversation.visible(task["title"].string ?? "未命名会话")) }
            Text(words)
        }
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

/**
 * Talking with an Agent: its current topic (the newest open one that is not a schedule's run), opened as any conversation
 * is, or a new topic whose first message starts its session. Tapping the face or name opens its profile.
 */
struct AgentChat: View {
    @EnvironmentObject private var model: PhoneModel
    let id: String
    enum Pick: Equatable { case current, new, session(String) }
    @State private var pick = Pick.current
    @State private var profile = false
    @Environment(\.horizontalSizeClass) private var width
    private var tasks: [NativeJSON] { model.snapshot["tasks"].array }
    private var entry: PhoneAgentEntry? { PhoneAgents.entry(model.snapshot, id: id, windowOpen: model.verifiedUntil != nil) }
    /** The topic shown: the one picked while the Host still lists it, else the current one; nil for a new topic. */
    private var shown: String? {
        if case let .session(topic) = pick { return PhoneAgentChat.shown(tasks, owner: id, picked: topic, newTopic: false) }
        return PhoneAgentChat.shown(tasks, owner: id, picked: nil, newTopic: pick == .new)
    }
    var body: some View {
        Group {
            switch model.agentAccess {
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
        // A pushed conversation on a phone needs the room, a new topic as much as a topic.
        .toolbar(width == .compact && model.agentAccess == .ready ? .hidden : .automatic, for: .tabBar)
        .sheet(isPresented: $profile) {
            AgentProfileSheet(id: id, openTopic: { topic in profile = false; reach(topic) }).presentationCornerRadius(28)
        }
        // The topic shown is the one this page keeps open; a topic opened elsewhere meanwhile is replaced when it shows again.
        .task(id: [shown ?? "", model.verifiedUntil == nil ? "closed" : "open"]) { await follow() }
        .task(id: [id, PhoneProposals.signature(model.snapshot, owner: id), model.verifiedUntil == nil ? "closed" : "open"]) { await model.loadProposals(id) }
        .onChange(of: model.verifiedUntil == nil) { _, closed in if closed { profile = false } }
        #if LATCH_SCREENS
        .onAppear { if ScreensStage.profile { profile = true }; if ScreensStage.newTopic { pick = .new } }
        #endif
    }
    /**
     * Opens a session from this page: one of this Agent's own stays in its conversation; any other (a run of 通用's schedule
     * names no Agent and is Code's) opens in Code, as the web's `choose` does.
     */
    private func reach(_ session: String) {
        if PhoneAgentChat.home(tasks, session: session, owner: id) == .agents { pick = .session(session); return }
        Task { model.tab = .code; await model.openSession(session) }
    }
    private func follow() async {
        guard model.agentAccess == .ready else { return }
        if let shown {
            // The current topic stays this page's topic, even when another one becomes current later.
            if pick == .current { pick = .session(shown) }
            if model.sessionId != shown { await model.openSession(shown) }
        } else if model.sessionId != nil { model.closeSession() }
    }
    @ViewBuilder private func chat(_ entry: PhoneAgentEntry) -> some View {
        let frame = AgentFrame(owner: id, entry: entry, openProfile: { profile = true }, newTopic: { pick = .new }, openTopic: { reach($0) })
        if let shown { ConversationView(id: shown, frame: frame) }
        else { NewTopicView(frame: frame, started: { pick = .session($0) }) }
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
    private var mine: [NativePendingWrite] { model.pending.filter { PhonePending.kind($0) == .topic(owner: frame.owner) } }
    private var blocker: String? {
        if !mine.isEmpty { return nil }
        if !model.pending.isEmpty { return "上一项提交结果待确认" }
        if general { return PhoneAgentChat.generalBlocker(catalog, choice: choice, connected: model.connected, canRun: model.canRun) }
        return PhoneAgents.blocker(catalog, agent: agent, choice: choice, connected: model.connected, canRun: model.canRun)
    }
    private var canSend: Bool {
        blocker == nil && mine.isEmpty && !sending && !model.busy && (!prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.tray(attachKey).isEmpty)
    }
    /** Cards of runs that settled while the Agent had no topic: here until the next topic keeps them. */
    private var waiting: [PhoneScheduleResult] { model.agentResults[frame.owner] ?? [] }
    var body: some View {
        Group {
            if waiting.isEmpty { intro.padding(.horizontal, 24).frame(maxWidth: .infinity, maxHeight: .infinity) }
            else {
                ScrollView {
                    VStack(spacing: 20) {
                        intro
                        ResultStack(results: waiting, openActivity: frame.openProfile, openRun: frame.openTopic,
                            openFile: { file, run in files.open(model, reference: file.path, root: file.root, session: run) })
                            .frame(maxWidth: 760)
                    }.padding(.horizontal, 16).padding(.vertical, 32).frame(maxWidth: .infinity)
                }
            }
        }
        .sessionFilePreview(files)
        .task(id: [frame.owner, PhoneResults.signature(model.snapshot, owner: frame.owner), model.verifiedUntil == nil ? "closed" : "open"]) {
            await model.loadResults(frame.owner)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { AgentFrameItems(frame: frame, topic: .null, shown: nil) }
        .safeAreaInset(edge: .bottom, spacing: 0) { dock.frame(maxWidth: 760).frame(maxWidth: .infinity) }
        .task(id: frame.owner + "\(agent["revision"].integer ?? 0)") {
            choice = general ? PhoneAgentChat.generalChoice(catalog) : PhoneAgents.choice(catalog, agent: agent)
        }
        .modifier(AttachSupport(key: attachKey, selection: attachSelection, harness: harness, source: $attachSource))
        // Not delivered, for certain: the text comes back into this input.
        .onChange(of: model.returnedText[attachKey]) { _, value in if let value { prompt = PhonePending.joined(prompt, value); model.returnedText[attachKey] = nil } }
        // Leaving the new topic lets go of what was attached here, unless a start that carries them is still unconfirmed.
        .onDisappear {
            if PhoneAttachments.dropsOnClose(key: attachKey, pending: model.pending, starting: sending, verifying: model.verifying, covered: false) { model.dropAttachments(attachKey) }
        }
    }
    private var intro: some View {
        VStack(spacing: 10) {
            AgentFace(avatar: frame.entry.avatar, size: 56, face: frame.entry.face)
            Text(frame.entry.name).font(.system(size: 20, weight: .semibold)).foregroundStyle(PhoneTheme.ink)
            if !frame.entry.duty.isEmpty { Text(frame.entry.duty).font(.system(size: 14)).foregroundStyle(PhoneTheme.ink2).multilineTextAlignment(.center) }
            if !frame.entry.available { Unavailable(reason: frame.entry.unavailableReason) }
        }
    }
    private var dock: some View {
        VStack(spacing: 8) {
            ForEach(mine, id: \.requestId) { pending in
                HStack(spacing: 10) {
                    Label("新话题结果待确认", systemImage: "clock").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                    Spacer()
                    Button("重试同一请求") { retry(pending) }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                    Button("放弃这次提交") {
                        Task { if case let .text(back, _) = await model.abandonPrompt(pending) { prompt = PhonePending.joined(prompt, back) } }
                    }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).disabled(model.busy)
                    InfoHint(text: PromptComposer.abandonStartHint)
                }.padding(.horizontal, 16)
            }
            if let blocker { Text(blocker).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).lineLimit(2).padding(.horizontal, 16).frame(maxWidth: .infinity, alignment: .leading) }
            picks
            AttachmentRows(key: attachKey, selection: attachSelection)
            field
        }.padding(.bottom, 8).padding(.top, 4)
    }
    /** This topic's project (not for General) and model; the Harness remains the owner's. */
    private var picks: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if !general {
                    Menu {
                        ForEach(PhoneStart.projects(catalog)) { project in Button { choice.workspaceId = project.id } label: { check(project.name, on: project.id == choice.workspaceId) } }
                    } label: { chip { Image(systemName: "folder").font(.system(size: 12)); Text(PhoneAgents.worksIn(catalog, projectId: choice.workspaceId)) } }
                }
                if PhoneStart.usesServices(harness) {
                    Menu {
                        if !general { Button { choice.model = nil } label: { check("默认模型", on: choice.model == nil) } }
                        ForEach(PhoneStart.models(catalog)) { item in Button { choice.model = item } label: { check(item.model + " · " + item.providerName, on: item == choice.model) } }
                    } label: { chip { Text(choice.model?.model ?? "默认模型") } }
                }
            }.padding(.horizontal, 12)
        }
        .disabled(sending || !mine.isEmpty)
    }
    private var field: some View {
        let placeholder = PhoneAgentChat.placeholder(frame.entry.name)
        return HStack(alignment: .bottom, spacing: 8) {
            AttachButton(key: attachKey, harness: harness, selection: attachSelection, source: $attachSource).padding(.leading, -8).padding(.bottom, 8)
            LocalTextEditor(text: $prompt, placeholder: placeholder, focused: $focused)
                .overlay(alignment: .topLeading) {
                    if prompt.isEmpty { Text(placeholder).font(PhoneTheme.body).foregroundStyle(PhoneTheme.faint).lineLimit(1).allowsHitTesting(false).accessibilityHidden(true) }
                }
                .padding(.vertical, 12)
            Button { send() } label: {
                Group {
                    if sending { ProgressView().controlSize(.small).tint(.white) }
                    else { Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)) }
                }
                .foregroundStyle(canSend || sending ? Color.white : PhoneTheme.faint)
                .frame(width: 36, height: 36).background(canSend || sending ? PhoneTheme.accent : PhoneTheme.bubble, in: Circle())
            }.buttonStyle(.plain).disabled(!canSend).accessibilityLabel("发送").padding(.bottom, 8)
        }
        .padding(.leading, 16).padding(.trailing, 8).frame(minHeight: 52)
        .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 26))
        .overlay(RoundedRectangle(cornerRadius: 26).stroke(PhoneTheme.lineStrong))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
        .padding(.horizontal, 12)
        .disabled(!mine.isEmpty)
    }
    private func chip<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 6) { content() }.font(.system(size: 13)).foregroundStyle(PhoneTheme.ink2).lineLimit(1)
            .padding(.horizontal, 12).frame(height: 32).background(PhoneTheme.raised, in: Capsule()).overlay(Capsule().stroke(PhoneTheme.line))
    }
    private func check(_ name: String, on: Bool) -> some View {
        Group { if on { Label(name, systemImage: "checkmark") } else { Text(name) } }
    }
    private func send() {
        sending = true
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            var ids: [String] = []
            if !model.tray(attachKey).isEmpty {
                // Waits for uploads still on their way; one that cannot go keeps the message here.
                guard case let .success(value) = await model.attachmentsToSend(attachKey, target: nil) else { model.endAttachmentSend(attachKey); sending = false; return }
                ids = value
            }
            let done = await model.startTopic(owner: frame.owner, agent: agent, choice: choice, prompt: text, attachments: ids)
            model.endAttachmentSend(attachKey)
            prompt = PhoneAgentChat.promptAfterStart(prompt, pending: model.pending, owner: frame.owner, started: done)
            if done, let id = model.sessionId { started(id) }
            sending = false
        }
    }
    private func retry(_ pending: NativePendingWrite) {
        sending = true
        Task {
            if await model.finishTopic(pending), let id = model.sessionId { prompt = ""; started(id) }
            sending = false
        }
    }
}
