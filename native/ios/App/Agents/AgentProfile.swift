import LatchNativeCore
import SwiftUI

struct AgentProfileSheet: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let id: String
    let openTopic: (String) -> Void
    enum Part: String, CaseIterable {
        case activity = "动态", library = "资料库", memory = "记忆", runSettings = "运行设置"
    }
    @State private var part = Part.activity
    @State private var read = PhoneAgentRead.loading
    @State private var reading = UUID()
    /** The memory being written, held here with the sheet's navigation so a reread of the section never drops it. */
    @State private var editing: MemoryDraft?
    @StateObject private var files = SessionFilePreview()
    @State private var detent = PresentationDetent.medium
    private var general: Bool { id == PhoneAgents.generalId }
    private var summary: NativeJSON { model.snapshot["customAgents"].array.first { $0["id"].string == id } ?? .null }
    private var entry: PhoneAgentEntry? { PhoneAgents.entry(model.snapshot, id: id, windowOpen: model.verifiedUntil != nil) }
    var body: some View {
        NavigationStack {
            Group {
                if let entry, model.agentAccess == .ready { content(entry) }
                else if model.agentAccess == .loading { LoadingAgents() }
                else { AgentReadState(read: model.agentAccess == .locked ? .locked : model.agentAccess == .confirming ? .confirming : .closed, retry: reload) }
            }
            .background(PhoneTheme.canvas)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("关闭", systemImage: "xmark") { dismiss() }.labelStyle(.iconOnly) } }
            .navigationDestination(item: $editing) { draft in MemoryEditor(owner: id, draft: draft, saved: reload) }
        }
        .sessionFilePreview(files)
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        // A reload keeps what is shown until the answer comes, so the memory editor pushed over it stays alive.
        .task(id: reading) {
            guard model.agentAccess == .ready, model.verifiedUntil != nil else { read = .closed; return }
            if case .ready = read {} else { read = .loading }
            let next = await model.readAgent(id)
            if next != .loading { read = next }
        }
        .task(id: [PhoneProposals.signature(model.snapshot, owner: id), model.verifiedUntil == nil ? "closed" : "open"]) { await model.loadProposals(id) }
        // What the window showed goes with it.
        .onChange(of: model.verifiedUntil == nil) { _, closed in if closed { dismiss() } }
        .onChange(of: model.privateSnapshot.epoch) { _, _ in
            editing = nil; read = .closed
            if model.agentAccess == .ready, model.verifiedUntil != nil { reload() }
        }
        .onChange(of: model.agentAccess) { _, access in
            if access == .ready, model.verifiedUntil != nil { reload() }
            else { editing = nil; read = .closed }
        }
        // A window that closed takes what it showed and never opens again by itself (no unasked Face ID).
        .onChange(of: model.contentGeneration) { _, _ in
            let showing: Bool = { if case .ready = read { return true }; return false }()
            switch PhoneContentChange.next(windowOpen: model.verifiedUntil != nil, showing: showing) {
            case .close: read = .closed
            case .reload: reload()
            case .none: break
            }
        }
        #if LATCH_SCREENS
        .onAppear {
            if let staged = ScreensStage.profilePart { part = staged }
            if part == .runSettings { detent = .large }
        }
        #endif
    }
    private func reload() { reading = UUID() }
    private func content(_ entry: PhoneAgentEntry) -> some View {
        ScrollViewReader { reader in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header(entry).id("profile-top")
                    Picker("资料页签", selection: $part) {
                        ForEach(Part.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.segmented)
                    switch part {
                    case .activity:
                        ActivitySection(owner: id, openTopic: openTopic, openMemory: { part = .memory })
                        if model.snapshot["catalog"]["features"]["automations"].bool {
                            section("即将进行") { UpcomingSection(id: id, agent: summary, openTopic: openTopic) }
                        }
                    case .library:
                        LibrarySection(owner: id, openTopic: openTopic, openFile: {
                            let root = $0.root == PhoneActivity.attachmentRoot ? PreviewFiles.attachmentRoot : $0.root
                            files.open(model, reference: $0.reference, root: root, session: $0.sessionId)
                        })
                    case .memory:
                        detailed { MemorySection(owner: id, detail: $0, reload: reload, openTopic: openTopic, editing: $editing) }
                    case .runSettings:
                        runSettings(entry)
                    }
                }
                .padding(.horizontal, 20).padding(.bottom, 24).frame(maxWidth: 720, alignment: .leading).frame(maxWidth: .infinity)
            }.onChange(of: part) { _, _ in reader.scrollTo("profile-top", anchor: .top) }
        }
    }
    @ViewBuilder private func runSettings(_ entry: PhoneAgentEntry) -> some View {
        if entry.destination != .local { section("工作电脑") { AgentWorkComputer(entry: entry) } }
        if entry.destination == .local, model.snapshot["catalog"]["features"]["agentMentions"].bool {
            detailed { value in
                let agent = general ? value["general"] : value["agent"]
                let engine = model.engineInfo(entry.harnessId)
                let supported = general || (agent["mode"].string == "agent" && (entry.harnessId == "standard" || engine["skills"].string == "server"))
                if supported || agent["canConsultAgents"].bool {
                    ConsultationPermission(owner: id, agent: agent, supported: supported, saved: reload)
                }
            }
        }
        section(entry.destination == .local ? "电脑" : "原电脑上的定时") { ComputerSection(id: id, agent: general ? .null : summary) }
        if !general, summary != .null { section("通知") { NotificationSection(agent: summary) } }
        section("工作位置") { Text(entry.place ?? "不带项目").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2).lineLimit(1) }
        if !general {
            section("技能与工具") {
                Text(PhoneAgentChat.kitWords(model.snapshot["catalog"], agent: summary)).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2)
            }
        }
    }
    private func settings(_ entry: PhoneAgentEntry) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if entry.destination == .local, model.canRun, PhoneAgentChat.owner(model.currentSummary) == id,
                   PhoneAgentChat.isCurrent(model.snapshot, task: model.currentSummary),
                   model.detail["summary"]["id"].string == model.sessionId {
                    let controls = PhoneSessionConfig.controls(model.detail, harness: model.engineInfo(model.currentSummary["harnessId"].string))
                    if !controls.isEmpty {
                        section("当前聊天") {
                            ViewThatFits(in: .horizontal) {
                                HStack(spacing: 12) { ConfigChips(controls: controls, chip: { AnyView($0.font(PhoneTheme.caption)) }) }
                                VStack(alignment: .leading, spacing: 12) { ConfigChips(controls: controls, chip: { AnyView($0.font(PhoneTheme.caption)) }) }
                            }
                        }
                    }
                }
                detailed { value in
                    if !general, model.canRun {
                        NavigationLink { HelperDefaultsEditor(agent: value["agent"], saved: reload) } label: {
                            HStack { Text("做事方式"); Spacer(); Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)) }
                                .font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                    if general {
                        section("Harness · 模型") { Text("每个话题自己选").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2) }
                    }
                    AgentSettingsSection(detail: value, general: general)
                }
            }.padding(20).frame(maxWidth: 720, alignment: .leading).frame(maxWidth: .infinity)
        }
        .background(PhoneTheme.canvas).navigationTitle("设置").navigationBarTitleDisplayMode(.inline)
    }
    private func header(_ entry: PhoneAgentEntry) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                AgentFace(avatar: entry.avatar, size: 64, face: entry.face)
                Spacer()
                NavigationLink { settings(entry) } label: {
                    Label("设置", systemImage: "gearshape").font(PhoneTheme.body)
                }.buttonStyle(.bordered).tint(PhoneTheme.ink)
            }
            HStack(spacing: 6) {
                Text(entry.name).font(.system(size: 22, weight: .semibold)).foregroundStyle(PhoneTheme.ink)
                if entry.general { BuiltInMark() }
                if let words = entry.face.words { FaceWord(face: entry.face, words: words) }
            }
            if !entry.duty.isEmpty { Text(entry.duty).font(.system(size: 15)).foregroundStyle(PhoneTheme.ink2) }
            if entry.destination == .local, !entry.available { Unavailable(reason: entry.unavailableReason) }
            else if !model.connected { Label("Mac 不在线", systemImage: "wifi.slash").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
        }
    }
    private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.muted)
            content()
        }
    }
    @ViewBuilder private func detailed<Content: View>(@ViewBuilder _ content: (NativeJSON) -> Content) -> some View {
        switch read {
        case .ready(let value): content(value)
        default: AgentReadState(read: read, retry: reload)
        }
    }
}

/**
 * 想记住：… with 保存 and 不要. Nothing is saved until the person presses 保存 and the Host answers; a write whose result is
 * unknown keeps its request for 重试同一请求. In a conversation 保存 is the one blue action; in the profile it is not.
 */
struct ProposalRow: View {
    @EnvironmentObject private var model: PhoneModel
    let owner: String
    let proposal: PhoneProposal
    var effect: String? = nil
    var compact = false
    var saved: (() -> Void)? = nil
    /** True while 保存 runs, false while 不要 runs. */
    @State private var working: Bool?
    @State private var failure: String?
    private var held: (write: NativePendingWrite, saving: Bool)? { PhoneProposals.held(model.pending, owner: owner, proposalId: proposal.id) }
    private var locked: Bool { !model.connected || !model.canRun || model.busy || working != nil || (!model.pending.isEmpty && held == nil) }
    var body: some View {
        if proposal.refused {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("没有记下").font(.system(size: 12, weight: .medium)).foregroundStyle(PhoneTheme.red)
                Text(proposal.content).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2)
            }.accessibilityElement(children: .combine)
        } else { row }
    }
    private var row: some View {
        VStack(alignment: .leading, spacing: 8) {
            (compact ? Text(proposal.content) : Text("想记住：").foregroundColor(PhoneTheme.muted) + Text(proposal.content))
                .font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink).textSelection(.disabled)
            HStack(spacing: 8) {
                Text(PhoneProposals.originWords(proposal.origin)).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                if proposal.external { ExternalMark() }
                if let reason = proposal.reason { HintButton(label: "理由", text: reason) }
                Spacer(minLength: 4)
                outcome
            }
            if let held, working == nil {
                HStack {
                    Label("结果未知", systemImage: "questionmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                    Spacer()
                    Button("核对并放下") { Task { if await model.checkAgentWrite(held.write) == nil { failure = "没能核对，稍后再试" } } }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                    Button("重试同一请求") { run(held.write, saving: held.saving) }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                }
            }
            if let failure { Label(failure, systemImage: "exclamationmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.red) }
        }
        .padding(12)
        .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(proposal.state == .pending ? PhoneTheme.lineStrong : PhoneTheme.line))
        .accessibilityElement(children: .contain).accessibilityLabel("记忆提议")
    }
    @ViewBuilder private var outcome: some View {
        switch proposal.state {
        case .saved:
            HStack(spacing: 6) {
                Label("已保存", systemImage: "checkmark").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2)
                if let effect { Text(effect).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
            }
        case .dismissed: Text("不要了").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
        case .pending:
            HStack(spacing: 8) {
                Button { decide(saving: false) } label: { busyLabel("不要", on: working == false) }
                    .buttonStyle(.bordered).tint(PhoneTheme.ink)
                Group {
                    if compact { Button { decide(saving: true) } label: { busyLabel("保存", on: working == true) }.buttonStyle(.bordered).tint(PhoneTheme.ink) }
                    else { Button { decide(saving: true) } label: { busyLabel("保存", on: working == true) }.buttonStyle(.borderedProminent).tint(PhoneTheme.accent) }
                }
            }
            .buttonBorderShape(.capsule).controlSize(.small).disabled(locked || held != nil)
        }
    }
    private func busyLabel(_ words: String, on: Bool) -> some View {
        ZStack { Text(words).opacity(on ? 0 : 1); if on { ProgressView().controlSize(.mini) } }
    }
    private func decide(saving: Bool) {
        guard let write = try? (saving ? PhoneProposals.save(owner: owner, proposalId: proposal.id) : PhoneProposals.dismiss(owner: owner, proposalId: proposal.id)) else { return }
        run(write, saving: saving)
    }
    private func run(_ write: NativePendingWrite, saving: Bool) {
        working = saving; failure = nil
        Task {
            let outcome = await model.writeAgent(write)
            working = nil
            switch outcome {
            case .done: if saving { saved?() }
            case .unknown: break
            case .changed: failure = "已在别处处理"
            case let .refused(message): failure = message
            }
            // The Host's state, whatever this device heard.
            if outcome != .unknown { await model.loadProposals(owner) }
        }
    }
}

/** Amber 「来自外部内容」: a tool that read outside content ran before it. */
struct ExternalMark: View {
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 10)).foregroundStyle(PhoneTheme.amberIcon)
            Text("来自外部内容").font(.system(size: 12, weight: .medium)).foregroundStyle(PhoneTheme.amber)
        }
    }
}

/**
 * 记忆: pending proposals first, then what the person wrote or saved for this Agent, to add, change and delete; the last
 * edit or delete of each can be undone once, and a deleted memory's text can be cleared now.
 */
private struct MemorySection: View {
    @EnvironmentObject private var model: PhoneModel
    let owner: String
    let detail: NativeJSON
    let reload: () -> Void
    let openTopic: (String) -> Void
    @Binding var editing: MemoryDraft?
    @State private var deleting: NativeJSON?
    /** The last undo, clear or delete this section sent, with what became of it. */
    @State private var step: (memoryId: String, write: NativePendingWrite, state: PhoneAgentWrite?)?
    private var memories: [NativeJSON] { detail["memories"].array }
    private var held: [NativePendingWrite] { model.pending.filter { PhonePending.kind($0) == .memory(owner: owner) } }
    private var canWrite: Bool { model.connected && model.canRun && !model.busy && step?.state != .unknown }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            let pending = PhoneProposals.pending(model.proposals[owner] ?? [])
            if !pending.isEmpty {
                Text("提议").font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.muted)
                ForEach(pending) { ProposalRow(owner: owner, proposal: $0, compact: true, saved: reload) }
            }
            HStack(spacing: 6) {
                Text("只给这个 Agent").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                HintButton(label: "只给这个 Agent", text: "只有你能写或保存，只有这个 Agent 会用，工具不会改写它。内置 Harness 每轮重新读取；外部 Harness 在清空上下文后重新读取。")
                Spacer()
                Button("添加", systemImage: "plus") { editing = MemoryDraft(memory: nil, text: "") }
                    .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(PhoneTheme.ink).disabled(!canWrite || !held.isEmpty)
            }
            ForEach(held.filter { $0.requestId != step?.write.requestId }, id: \.requestId) { pending in
                WriteNotice(state: .unknown, retry: { Task { if await model.writeAgent(pending) == .done { reload() } } }, held: pending)
            }
            if let step, let state = step.state { WriteNotice(state: state, retry: { send(step.memoryId, step.write) }, reload: { self.step = nil; reload() }, held: model.pending.first { $0.requestId == step.write.requestId }) }
            if memories.isEmpty { Text("还没有记忆").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.vertical, 20) }
            ForEach(memories, id: \.id) { memory in
                memoryRow(memory)
                Divider().overlay(PhoneTheme.line)
            }
            let deleted = PhoneMemories.deleted(detail)
            if !deleted.isEmpty {
                HStack(spacing: 6) {
                    Text("已删除").font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.muted)
                    HintButton(label: "7 天", text: "7 天后或按「清除」后不能再撤销，记忆与它的提议里不再留这段文字；话题里的对话记录不变。")
                }.padding(.top, 8)
                ForEach(deleted.map { ($0["memoryId"].string ?? "", $0) }, id: \.0) { deletedRow($0.1) }
            }
        }
        .confirmationDialog("删除这条记忆？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("删除", role: .destructive) {
                if let memory = deleting, let id = memory["id"].string, let write = try? PhoneMemoryWrite.remove(owner: owner, memoryId: id) { send(id, write) }
            }
        } message: { Text("7 天内可以撤销。已经开始的外部 Harness 会话里已发出的内容不会撤回。") }
    }
    private func memoryRow(_ memory: NativeJSON) -> some View {
        let id = memory["id"].string ?? ""
        let edited = PhoneMemories.edited(detail, memoryId: id)
        return HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(PhoneConversation.visible(memory["content"].string ?? "")).font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink).textSelection(.disabled)
                if let source = PhoneMemories.source(memory) {
                    HStack(spacing: 6) {
                        Text(source.words).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                        if source.external { ExternalMark() }
                        if let topic = source.sessionId, let task = model.snapshot["tasks"].array.first(where: { $0["id"].string == topic }) {
                            Button { openTopic(topic) } label: {
                                Text(PhoneConversation.visible(task["title"].string ?? "话题")).font(PhoneTheme.caption).underline().lineLimit(1)
                            }.buttonStyle(.plain).foregroundStyle(PhoneTheme.ink2).accessibilityHint("打开话题")
                        }
                        if let at = source.at { Text(PhoneTime.relative(at)).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                        if memory["edited"].bool { Text("已修改").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                    }
                } else {
                    Text(PhoneTime.parse(memory["updatedAt"]).map { PhoneTime.relative($0) } ?? "").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                }
            }
            Spacer(minLength: 4)
            Menu {
                if edited, let revision = memory["revision"].integer {
                    Button("撤销修改", systemImage: "arrow.uturn.backward") {
                        if let write = try? PhoneMemories.undo(owner: owner, memoryId: id, baseRevision: Int(revision)) { send(id, write) }
                    }
                }
                Button("修改", systemImage: "pencil") { editing = MemoryDraft(memory: memory, text: memory["content"].string ?? "") }
                Button("删除", systemImage: "trash", role: .destructive) { deleting = memory }
            } label: { Image(systemName: "ellipsis").frame(width: 32, height: 32).foregroundStyle(PhoneTheme.muted) }
                .disabled(!canWrite || !held.isEmpty).accessibilityLabel("记忆操作")
        }.padding(.vertical, 6)
    }
    private func deletedRow(_ change: NativeJSON) -> some View {
        let id = change["memoryId"].string ?? "", revision = Int(change["previous"]["revision"].integer ?? 0)
        return HStack(alignment: .top, spacing: 8) {
            Text(PhoneConversation.visible(change["previous"]["content"].string ?? "")).font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted)
                .strikethrough(color: PhoneTheme.faint).textSelection(.disabled).lineLimit(3)
            Spacer(minLength: 4)
            Button("撤销") { if let write = try? PhoneMemories.undo(owner: owner, memoryId: id, baseRevision: revision) { send(id, write) } }
                .buttonStyle(.bordered).tint(PhoneTheme.ink)
            Button("清除") { if let write = try? PhoneMemories.forget(owner: owner, memoryId: id, baseRevision: revision) { send(id, write) } }
                .buttonStyle(.bordered).tint(PhoneTheme.ink)
        }
        .buttonBorderShape(.capsule).controlSize(.small).disabled(!canWrite || !held.isEmpty).padding(.vertical, 4)
    }
    private func send(_ memoryId: String, _ write: NativePendingWrite) {
        step = (memoryId, write, nil)
        Task {
            let outcome = await model.writeAgent(write)
            if outcome == .done { step = nil; reload() } else { step = (memoryId, write, outcome) }
        }
    }
}

/** 即将进行: this Agent's schedules, each with its plan and a switch; tapping one lists its runs. */
private struct UpcomingSection: View {
    @EnvironmentObject private var model: PhoneModel
    let id: String
    let agent: NativeJSON
    let openTopic: (String) -> Void
    @State private var states: [String: PhoneAgentWrite] = [:]
    @State private var working: Set<String> = []
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let items = PhoneAgents.automations(model.snapshot, id: id, windowOpen: model.verifiedUntil != nil) {
                if items.isEmpty { Text("没有定时任务").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted) }
                ForEach(items, id: \.id) { item in row(item); Divider().overlay(PhoneTheme.line) }
            } else if !model.connected {
                Text("Mac 不在线，连上后可以查看").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted)
            } else { ConfirmingAgents() }
            NotYet(text: "修改与手动新建定时任务")
        }
    }
    private func row(_ item: NativeJSON) -> some View {
        let automationId = item.id
        let held = PhoneScheduleWrite.held(model.pending, automationId: automationId)
        let block = PhoneScheduleWrite.blocker(agent: id == PhoneAgents.generalId ? .null : agent, connected: model.connected, canRun: model.canRun)
        let on = item["enabled"].bool
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                NavigationLink { AutomationRuns(id: automationId, name: item["name"].string ?? "定时任务", openTopic: openTopic) } label: { ScheduleRow(item: item) }
                    .buttonStyle(.plain)
                if working.contains(automationId) { ProgressView().controlSize(.small) }
                Toggle(item["name"].string.map { $0 + " 开启" } ?? "开启", isOn: Binding(get: { on }, set: { flip(item, to: $0) }))
                    .labelsHidden().tint(PhoneTheme.accent)
                    .disabled(working.contains(automationId) || held != nil || model.busy || !model.connected || !model.canRun
                        || (!model.pending.isEmpty && held == nil) || (!on && block != nil))
            }
            if !on, let block, model.connected, model.canRun { Text(block).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(2) }
            if let held, !working.contains(automationId) {
                WriteNotice(state: .unknown, retry: { send(automationId, held) }, held: held)
            } else if let state = states[automationId] {
                WriteNotice(state: state, reload: { states[automationId] = nil; Task { await model.refresh() } })
            }
        }
    }
    private func flip(_ item: NativeJSON, to on: Bool) {
        guard let write = try? PhoneScheduleWrite.enabled(item, on: on) else { return }
        send(item.id, write)
    }
    private func send(_ automationId: String, _ write: NativePendingWrite) {
        working.insert(automationId); states[automationId] = nil
        Task {
            let outcome = await model.writeAgent(write)
            working.remove(automationId)
            // Unknown stays with the model's pending write, which the row offers again.
            if outcome != .done && outcome != .unknown { states[automationId] = outcome }
        }
    }
}


private struct ConsultationPermission: View {
    @EnvironmentObject private var model: PhoneModel
    let owner: String
    let agent: NativeJSON
    let supported: Bool
    let saved: () -> Void
    @State private var state: PhoneAgentWrite?
    @State private var saving = false
    private var on: Bool { agent["canConsultAgents"].bool }
    private var held: NativePendingWrite? {
        model.pending.first { item in
            item.method == "PATCH" && item.path == "/link/api/custom-agents/" + owner
                && (try? NativeJSON.decode(item.body).object["canConsultAgents"]) != nil
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Toggle("允许主动联系其他 Agent", isOn: Binding(get: { on }, set: setPermission))
                .font(.body.weight(.medium))
                .disabled(locked)
            Text(!supported ? "当前运行方式不支持主动联系其他 Agent。" : legacy ? "当前只可联系内置 Agent。允许后，它也可在你发消息时询问同一台电脑上已确认的 DeepSeek Harness。DeepSeek 以你的电脑账户运行，只回复文字。"
                        : "你直接发消息时，它每轮可询问同一台电脑上的一位 Agent。已确认的 DeepSeek Harness 以你的电脑账户运行，本轮只回复文字。")
                .font(.caption).foregroundStyle(PhoneTheme.muted)
            if legacy && supported {
                Button("允许联系 DeepSeek Harness") { setPermission(true) }.disabled(locked)
            }
            if let outcome = held == nil ? state : .unknown {
                WriteNotice(state: outcome, retry: held.map { write in { submit(write) } }, reload: saved, held: held, settled: saved)
            }
        }
    }
    private var legacy: Bool { on && !agent["canConsultDeepSeek"].bool }
    private var locked: Bool {
        !model.canRun || !model.transportReady || model.busy || saving || !model.pending.isEmpty || agent["revision"].integer == nil
    }
    private func setPermission(_ enabled: Bool) {
        guard !locked, !enabled || supported, let revision = agent["revision"].integer else { return }
        var fields: [String: NativeJSON] = ["baseRevision": .number(Double(revision)), "canConsultAgents": .bool(enabled)]
        if enabled { fields["canConsultDeepSeek"] = .bool(true) }
        guard let request = try? NativePendingWrite(method: .patch, path: "/link/api/custom-agents/" + owner, fields: fields) else { return }
        submit(request)
    }
    private func submit(_ request: NativePendingWrite) {
        guard !saving else { return }
        let host = model.generation, window = model.privateSnapshot.epoch
        saving = true
        Task {
            let result = await model.writeAgent(request)
            guard model.generation == host, model.privateSnapshot.accepts(window) else { return }
            saving = false; state = result
            if result == .done { saved() }
        }
    }
}
