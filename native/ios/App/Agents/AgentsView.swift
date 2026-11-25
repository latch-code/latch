import LatchNativeCore
import SwiftUI

/** 我的 Agent: the list is the root; choosing an Agent opens the conversation with it, pushed on a phone and beside the list on an iPad. */
struct AgentsTabView: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var column = NavigationSplitViewColumn.sidebar
    private var selection: Binding<String?> {
        Binding(get: { model.agentPath.first }, set: { model.agentPath = $0.map { [$0] } ?? [] })
    }
    private var activeComputer: UUID? {
        model.tab == .agents && model.connected && model.snapshot["catalog"]["features"]["customAgents"].bool ? model.generation : nil
    }
    var body: some View {
        NavigationSplitView(preferredCompactColumn: $column) {
            AgentList(selection: selection)
        } detail: {
            if let id = model.agentPath.first { NavigationStack { AgentChat(id: id).id([model.generation.uuidString, id]) } }
            else {
                ContentUnavailableView("选择 Agent", systemImage: "person.crop.circle")
                    .frame(maxWidth: .infinity, maxHeight: .infinity).background(PhoneTheme.canvas)
            }
        }
        .onChange(of: model.agentPath.first, initial: true) { _, id in column = id == nil ? .sidebar : .detail }
        .onChange(of: activeComputer, initial: true) { _, current in
            guard let current else { return }
            Task {
                guard activeComputer == current, model.agentAccess == .closed else { return }
                await model.openAgents()
            }
        }
    }
}

/** A detail a person may need, behind ⓘ. */
struct HintButton: View {
    let label: String
    let text: String
    @State private var shown = false
    var body: some View {
        Button { shown = true } label: { Image(systemName: "info.circle").font(.system(size: 14)).foregroundStyle(PhoneTheme.muted) }
            .buttonStyle(.plain).accessibilityLabel(label)
            .popover(isPresented: $shown) {
                Text(text).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2).padding(14).frame(idealWidth: 280)
                    .fixedSize(horizontal: false, vertical: true).presentationCompactAdaptation(.popover)
            }
    }
}

struct BuiltInMark: View {
    var body: some View {
        Text("内置").font(.system(size: 11, weight: .medium)).foregroundStyle(PhoneTheme.muted)
            .padding(.horizontal, 6).padding(.vertical, 2).overlay(Capsule().stroke(PhoneTheme.lineStrong))
    }
}

/** A smaller data scope: what is locked, with the fine print behind ⓘ. Never an empty list. */
struct LockedAgents: View {
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "lock").font(.system(size: 13)).foregroundStyle(PhoneTheme.muted)
            Text("这台设备看不到 Agent").font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink2)
            HintButton(label: "为什么看不到", text: "Agent 的指令、记忆和会话只对能读取全部数据的设备开放。在这台 Mac 的 设置 › 设备 里为这台设备打开「可以看项目文件」后可见。")
        }.frame(maxWidth: .infinity).padding(.top, 48)
    }
}

/** The Host confirms an earlier write and leaves Agents out until it knows. */
struct ConfirmingAgents: View {
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "clock").font(.system(size: 13))
            Text("正在确认上一项修改").font(PhoneTheme.body)
            HintButton(label: "正在确认", text: "结果确认前不能读取或修改 Agent，Mac 会自己重试。")
        }.foregroundStyle(PhoneTheme.amber).frame(maxWidth: .infinity).padding(.top, 48)
    }
}

/** Whether a session can start on the Agent now, shown only when it cannot. */
struct Unavailable: View {
    let reason: String?
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "exclamationmark.triangle").font(.caption).imageScale(.small).foregroundStyle(PhoneTheme.amberIcon).accessibilityHidden(true)
            Text("不可用").font(.caption).foregroundStyle(PhoneTheme.amber)
            if let reason { HintButton(label: "为什么不可用", text: reason) }
        }
    }
}

private struct AgentList: View {
    @EnvironmentObject private var model: PhoneModel
    @Binding var selection: String?
    @State private var creating = false
    var body: some View {
        let access = model.agentAccess
        let entries = PhoneAgents.entries(model.snapshot, windowOpen: model.verifiedUntil != nil)
        List(selection: $selection) {
            if !model.connected && (model.offline || model.hostNotice != nil) { CodeConnectionRow() }
            switch access {
            case .loading: LoadingAgents().plainAgentRow()
            case .locked: LockedAgents().plainAgentRow()
            case .confirming: ConfirmingAgents().plainAgentRow()
            case .closed: ClosedAgents().plainAgentRow()
            case .hidden: EmptyView()
            case .ready:
                if let receipt = model.createdHelper {
                    if entries.contains(where: { $0.id == receipt.id }) {
                        Button("打开新建的 Agent") { selection = receipt.id; model.createdHelper = nil }.foregroundStyle(PhoneTheme.ink).plainAgentRow()
                    } else {
                        HStack {
                            Text("已创建 · 列表暂未更新").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                            Spacer()
                            Button("刷新列表") { Task { await model.refresh() } }.foregroundStyle(PhoneTheme.ink).font(PhoneTheme.caption)
                        }.plainAgentRow()
                    }
                }
                if let general = entries.first(where: \.general) {
                    AgentRow(entry: general, selected: general.id == selection)
                        .padding(16)
                        .background(selection == general.id ? PhoneTheme.selectedRow : PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 18))
                        .tag(general.id)
                        .listRowInsets(EdgeInsets(top: 10, leading: 20, bottom: 20, trailing: 20))
                        .listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
                let personal = entries.filter { !$0.general }
                Section {
                    ForEach(personal) { entry in
                        AgentRow(entry: entry, selected: entry.id == selection).tag(entry.id)
                            .listRowInsets(EdgeInsets(top: 14, leading: 20, bottom: 14, trailing: 20))
                            .listRowBackground(entry.id == selection ? PhoneTheme.selectedRow : Color.clear)
                            .listRowSeparatorTint(PhoneTheme.line)
                    }
                    if personal.isEmpty && model.canRun {
                        Button { creating = true } label: {
                            Label("创建第一个 Agent", systemImage: "plus.circle").font(.subheadline.weight(.medium))
                                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                        }.foregroundStyle(PhoneTheme.ink).plainAgentRow()
                    }
                } header: {
                    HStack(spacing: 8) {
                        Text("个人 Agent").font(.headline).foregroundStyle(PhoneTheme.ink)
                        if !personal.isEmpty { Text("\(personal.count)").font(.subheadline.monospacedDigit()).foregroundStyle(PhoneTheme.muted) }
                    }.textCase(nil).accessibilityElement(children: .combine)
                }.listSectionSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .tint(PhoneTheme.selectedRow)
        .scrollContentBackground(.hidden)
        .background(PhoneTheme.canvas)
        .navigationTitle("我的 Agent")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            if access == .ready {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("新建 Agent", systemImage: "plus") { creating = true }.labelStyle(.iconOnly).disabled(!model.canRun)
                }
            }
        }
        .sheet(isPresented: $creating) {
            HelperCreateSheet { id in creating = false; selection = id; model.createdHelper = nil }.presentationCornerRadius(28)
        }
        #if LATCH_SCREENS
        .onAppear { if ScreensStage.scene == "agent-create" { creating = true } }
        #endif
        .onChange(of: model.privateSnapshot.epoch) { _, _ in creating = false }
        .refreshable {
            if model.agentAccess == .closed && model.connected { await model.openAgents() }
            else { await model.refreshInbox() }
        }
    }
}

struct LoadingAgents: View {
    var body: some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small).tint(PhoneTheme.muted).accessibilityHidden(true)
            Text("正在读取 Agent…").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted)
        }.frame(maxWidth: .infinity).padding(.top, 36)
    }
}

/** Outside a content window the list is not sent; one tap opens it. */
struct ClosedAgents: View {
    @EnvironmentObject private var model: PhoneModel
    @AppStorage(PhoneFaceID.key) private var faceID = false
    var body: some View {
        Group {
            if model.connected {
                Button(model.hasContentWindow ? "重新读取 Agent" : PhoneUnlock.reopenWords(faceID: faceID)) { Task { await model.openAgents() } }
                    .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
            } else { Text("Mac 不在线，连上后可以查看").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted) }
        }.frame(maxWidth: .infinity).padding(.top, 48)
    }
}

extension View {
    func plainAgentRow() -> some View { tint(PhoneTheme.ink).listRowSeparator(.hidden).listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16)) }
}

private struct AgentRow: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dynamicTypeSize) private var typeSize
    let entry: PhoneAgentEntry
    let selected: Bool
    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            AgentFace(avatar: entry.avatar, size: entry.general ? 52 : 46, face: entry.face)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 7) {
                    Text(PhoneConversation.visible(entry.name)).font(entry.general ? .title3.weight(.semibold) : .headline.weight(selected ? .bold : .semibold))
                        .foregroundStyle(PhoneTheme.ink).lineLimit(2)
                    if entry.general { BuiltInMark() }
                }
                if !entry.duty.isEmpty {
                    Text(PhoneConversation.visible(entry.duty)).font(.subheadline).foregroundStyle(PhoneTheme.ink2).lineLimit(2)
                }
                metadata
            }
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold)).foregroundStyle(PhoneTheme.muted).accessibilityHidden(true)
        }.contentShape(Rectangle())
    }

    private var location: (icon: String, name: String)? {
        if case let .remote(hostId, _) = entry.destination {
            let host = model.hosts.first { $0.device.hostId == hostId }
            return ("desktopcomputer", host.map(model.computerName) ?? "工作电脑 · " + String(hostId.prefix(8)))
        }
        return entry.place.map { ("folder", $0) }
    }

    @ViewBuilder private var metadata: some View {
        let place = location
        let words = liveWords
        let unavailable = !entry.available && entry.destination == .local
        if place != nil || words != nil || unavailable {
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 3))
                : AnyLayout(HStackLayout(spacing: 6))
            layout {
                if let place {
                    HStack(spacing: 4) {
                        Image(systemName: place.icon).imageScale(.small).accessibilityHidden(true)
                        Text(PhoneConversation.visible(place.name)).lineLimit(1)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("工作位置，" + PhoneConversation.visible(place.name))
                    if !typeSize.isAccessibilitySize && (words != nil || unavailable) {
                        Text("·").accessibilityHidden(true)
                    }
                }
                if let words { FaceWord(face: entry.face, words: words).layoutPriority(1) }
                else if unavailable { Unavailable(reason: entry.unavailableReason).layoutPriority(1) }
            }
            .font(.caption)
            .foregroundStyle(PhoneTheme.muted)
        }
    }

    private var liveWords: String? {
        guard model.connected else { return nil }
        if entry.face == .waiting {
            let own = model.snapshot["tasks"].array.filter { PhoneAgentChat.owner($0) == entry.id }
            if own.contains(where: { PhoneSessions.waitsOnYou($0) && ($0["pendingQuestions"].integer ?? 0) > 0 }) { return "等你回答" }
            let approvals = Set(model.snapshot["approvals"].array.compactMap { $0["sessionId"].string })
            if own.contains(where: { $0["status"].string == "waiting-approval" || approvals.contains($0["id"].string ?? "") }) { return "等你批准" }
        }
        if entry.face == .running, let task = model.snapshot["tasks"].array.first(where: { PhoneAgentChat.owner($0) == entry.id && $0["status"].string == "running" }) {
            return PhoneHelperSpeech.activity(task) ?? entry.face.words
        }
        return entry.face.words
    }
}

/** Every read state but the ready one, in the words the rest of the App uses. */
struct AgentReadState: View {
    @EnvironmentObject private var model: PhoneModel
    @AppStorage(PhoneFaceID.key) private var faceID = false
    let read: PhoneAgentRead
    let retry: () -> Void
    var body: some View {
        Group {
            switch read {
            case .loading, .ready: ProgressView().controlSize(.small).tint(PhoneTheme.muted)
            case .locked: LockedAgents()
            case .confirming: ConfirmingAgents()
            case .offline: Text("Mac 不在线，连上后可以查看").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted)
            case .closed:
                Button(PhoneUnlock.reopenWords(faceID: faceID)) { Task { await model.openAgents(); retry() } }
                    .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink).disabled(!model.connected || model.verifying)
            case .missing: Text("找不到这个 Agent").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted)
            case .failed:
                VStack(spacing: 10) {
                    Label("读取失败", systemImage: "exclamationmark.circle").font(PhoneTheme.body).foregroundStyle(PhoneTheme.red)
                    Button("重试", action: retry).buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
                }
            }
        }.frame(maxWidth: .infinity).padding(.top, 32)
    }
}

struct MemoryDraft: Identifiable, Hashable {
    let id = UUID()
    let memory: NativeJSON?
    var text: String
    static func == (a: MemoryDraft, b: MemoryDraft) -> Bool { a.id == b.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/** A write's state: refused, changed meanwhile, or unknown with a retry of the same request. */
struct WriteNotice: View {
    @EnvironmentObject private var model: PhoneModel
    let state: PhoneAgentWrite
    var retry: (() -> Void)? = nil
    var reload: (() -> Void)? = nil
    /** The unconfirmed write itself, for 核对并放下: what the Host now says is shown and the write is let go. */
    var held: NativePendingWrite? = nil
    var settled: (() -> Void)? = nil
    @State private var checked: String?
    @State private var abandoning = false
    var body: some View {
        switch state {
        case .done: EmptyView()
        case .unknown:
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Label("结果未知", systemImage: "questionmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                    Spacer()
                    if let held {
                        if PhoneHelperCreate.isCreation(held) {
                            Button("放弃这次创建") { abandoning = true }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                                .confirmationDialog("放下这次创建？", isPresented: $abandoning, titleVisibility: .visible) {
                                    Button("放下这次创建", role: .destructive) { settle(held, failure: "没能放下，稍后再试") }
                                } message: { Text("只在这台设备放下待确认的请求。电脑上如果已经创建，它仍会保留；再次创建会新增一个 Agent。") }
                        } else {
                            Button("核对并放下") { settle(held, failure: "没能核对，稍后再试") }
                                .font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                        }
                    }
                    if let retry { Button("重试同一请求", action: retry).font(PhoneTheme.caption).disabled(model.busy || !model.connected) }
                }
                if let checked { Text(checked).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
            }
        case .changed:
            HStack {
                Label("已在别处修改", systemImage: "exclamationmark.triangle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                Spacer()
                if let reload { Button("载入最新", action: reload).font(PhoneTheme.caption) }
            }
        case .refused(let message):
            Label("没有保存：" + message, systemImage: "exclamationmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.red)
        }
    }
    private func settle(_ write: NativePendingWrite, failure: String) {
        let current = model.generation, content = model.privateSnapshot.epoch
        Task {
            let result = await model.checkAgentWrite(write)
            guard current == model.generation, model.privateSnapshot.accepts(content) else { return }
            checked = result ?? failure
            if result != nil { settled?() }
        }
    }
}

struct MemoryEditor: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let owner: String
    @State var draft: MemoryDraft
    let saved: () -> Void
    /** Made once, on the first 保存, so a retry is the same request. */
    @State private var write: NativePendingWrite?
    @State private var state: PhoneAgentWrite?
    @State private var saving = false
    private var text: String { draft.text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var unchanged: Bool { draft.memory.map { text == $0["content"].string } ?? false }
    var body: some View {
        // Pushed inside the profile sheet's own navigation, never a second sheet over it.
        VStack(alignment: .leading, spacing: 12) {
                LocalTextEditor(text: $draft.text, placeholder: draft.memory == nil ? "新记忆" : "修改记忆", maximumLines: 10)
                    .padding(14).frame(minHeight: 140, alignment: .topLeading)
                    .background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 16))
                    .disabled(write != nil)
                if draft.text.count > PhoneMemoryWrite.maximum { Text("最多 \(PhoneMemoryWrite.maximum) 字").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
                if let state { WriteNotice(state: state, retry: { save() }, reload: { saved(); dismiss() }, held: write.flatMap { held in model.pending.first { $0.requestId == held.requestId } }) }
                // In the content rather than the bar: a pushed page's bar items do not follow its state inside a sheet.
                HStack(spacing: 10) {
                    Spacer()
                    Button("取消") { dismiss() }.buttonStyle(.bordered).tint(PhoneTheme.ink).disabled(saving)
                    Button("保存") { save() }.buttonStyle(.borderedProminent).tint(PhoneTheme.accent)
                        .disabled(saving || text.isEmpty || unchanged || draft.text.count > PhoneMemoryWrite.maximum || !model.connected)
                }.buttonBorderShape(.capsule)
                Spacer(minLength: 0)
            }
            .padding(16)
            .navigationTitle(draft.memory == nil ? "新记忆" : "修改记忆").navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .background(PhoneTheme.canvas)
        .interactiveDismissDisabled(saving || state == .unknown)
        // An unconfirmed write stays with the model and is offered again on the page; the text goes with the window.
        .onChange(of: model.verifiedUntil == nil) { _, closed in if closed { dismiss() } }
        .onChange(of: model.privateSnapshot.epoch) { _, _ in
            draft = MemoryDraft(memory: nil, text: ""); write = nil; state = nil; dismiss()
        }
    }
    private func save() {
        if write == nil {
            write = draft.memory.map { try? PhoneMemoryWrite.change(owner: owner, memory: $0, text: draft.text) } ?? (try? PhoneMemoryWrite.create(owner: owner, text: draft.text))
        }
        guard let write else { return }
        let content = model.privateSnapshot.epoch
        saving = true
        Task {
            let outcome = await model.writeAgent(write)
            guard model.privateSnapshot.accepts(content) else { return }
            saving = false
            if outcome == .done { saved(); dismiss() }
            else {
                state = outcome
                // A refusal or a change elsewhere ends this request; the text stays to try again as a new one.
                if outcome != .unknown { self.write = nil }
            }
        }
    }
}

/** Where a person would look for something not built: says so, and where it is. */
struct NotYet: View {
    let text: String
    var body: some View {
        HStack(spacing: 6) {
            Text(text).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            Text("尚未实现").font(.system(size: 11, weight: .medium)).foregroundStyle(PhoneTheme.muted)
                .padding(.horizontal, 6).padding(.vertical, 2).overlay(Capsule().stroke(PhoneTheme.lineStrong))
            HintButton(label: "在哪里修改", text: "在网页或桌面端修改。")
        }.padding(.top, 8)
    }
}

struct ScheduleRow: View {
    let item: NativeJSON
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(item["name"].string ?? "定时任务").font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink).lineLimit(1)
                Spacer()
                Text(PhoneAgents.automationState(item)).font(PhoneTheme.caption)
                    .foregroundStyle(item["state"].string == "paused" ? PhoneTheme.amber : PhoneTheme.muted)
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(PhoneTheme.faint)
            }
            Text(([PhoneAgents.scheduleWords(item["schedule"])] + [item["lastRun"] == .null ? "还没有运行" : PhoneAgents.runWords(item["lastRun"]["state"].string)
                + (PhoneTime.parse(item["lastRun"]["at"]).map { " " + PhoneTime.relative($0) } ?? "")]).joined(separator: " · "))
                .font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1)
            if let message = item["pause"]["message"].string { Text(message).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).lineLimit(2) }
        }.padding(.vertical, 6).contentShape(Rectangle())
    }
}

struct AutomationRuns: View {
    @EnvironmentObject private var model: PhoneModel
    let id: String
    let name: String
    /** A run's session is a topic of the Agent: it opens in the conversation. */
    let openTopic: (String) -> Void
    @State private var read = PhoneAgentRead.loading
    @State private var reading = UUID()
    var body: some View {
        List {
            switch read {
            case .ready(let value):
                Section("运行记录") {
                    if value["runs"].array.isEmpty { Text("还没有运行").foregroundStyle(PhoneTheme.muted) }
                    ForEach(Array(value["runs"].array.prefix(50).enumerated()), id: \.offset) { _, run in
                        let session = run["sessionId"].string.flatMap { id in model.snapshot["tasks"].array.contains { $0["id"].string == id } ? id : nil }
                        Button { if let session { openTopic(session) } } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(PhoneTime.parse(run["at"]).map { PhoneTime.message($0) } ?? "").font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink)
                                    Text(run["trigger"].string == "manual" ? "立即运行" : "按时运行").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                                }
                                Spacer()
                                Text(PhoneAgents.runWords(run["state"].string)).font(PhoneTheme.caption)
                                    .foregroundStyle(run["state"].string == "failed" ? PhoneTheme.red : ["waiting", "unknown"].contains(run["state"].string ?? "") ? PhoneTheme.amber : PhoneTheme.muted)
                                if session != nil { Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(PhoneTheme.faint) }
                            }
                        }.disabled(session == nil)
                    }
                }
            default: AgentReadState(read: read, retry: { reading = UUID() }).listRowBackground(Color.clear)
            }
        }
        .navigationTitle(name).navigationBarTitleDisplayMode(.inline)
        .task(id: reading) { read = .loading; read = await model.readAutomation(id) }
    }
}

/** 设置: what the Agent is, read-only here. */
struct AgentSettingsSection: View {
    @EnvironmentObject private var model: PhoneModel
    let detail: NativeJSON
    let general: Bool
    private var catalog: NativeJSON { model.snapshot["catalog"] }
    var body: some View {
        let agent = general ? detail["general"] : detail["agent"]
        VStack(alignment: .leading, spacing: 14) {
            if !general {
                field("名称") { Text(agent["name"].string ?? "") }
                if let described = agent["description"].string, !described.isEmpty { field("说明") { Text(described) } }
                field("Harness · 模型") { Text(PhoneAgents.runsWith(catalog, agent: agent)) }
                field("默认项目") { Text(PhoneAgents.worksIn(catalog, projectId: agent["defaultProjectId"].string)) }
            }
            field("指令") {
                let text = agent["instructions"].string ?? ""
                Text(text.isEmpty ? "没有指令" : text).foregroundStyle(text.isEmpty ? PhoneTheme.muted : PhoneTheme.ink).textSelection(.disabled)
            }
            field("技能") { Text(PhoneAgents.skillWords(catalog, skills: agent["skills"])) }
            if !general { field("可以使用") { Text(PhoneAgents.toolWords(agent["tools"])) } }
            NotYet(text: general ? "修改通用指令" : "修改名字、职责与指令")
        }
    }
    private func field<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            value().font(.system(size: 15)).foregroundStyle(PhoneTheme.ink).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
