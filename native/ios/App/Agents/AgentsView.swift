import LatchNativeCore
import SwiftUI

/** 我的 Agent: the list is the root, an Agent's page is pushed on a phone and stands beside the list on an iPad. */
struct AgentsTabView: View {
    @EnvironmentObject private var model: PhoneModel
    private var selection: Binding<String?> {
        Binding(get: { model.agentPath.first }, set: { model.agentPath = $0.map { [$0] } ?? [] })
    }
    var body: some View {
        NavigationSplitView {
            AgentList(selection: selection)
        } detail: {
            if let id = model.agentPath.first { NavigationStack { AgentPage(id: id).id(id) } }
            else { PhoneTheme.canvas.ignoresSafeArea() }
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

/** The Agent's glyph on the neutral plate; 通用 has its own. */
struct AgentTile: View {
    let glyph: String?
    var size: CGFloat = 40
    private static let symbols: [String: String] = [
        "glasses": "eyeglasses", "library": "books.vertical", "newspaper": "newspaper", "package": "shippingbox",
        "pen-line": "pencil.line", "flask-conical": "testtube.2", "compass": "safari", "hammer": "hammer",
        "lightbulb": "lightbulb", "list-checks": "checklist", "palette": "paintpalette", "telescope": "binoculars",
    ]
    var body: some View {
        Image(systemName: glyph.flatMap { Self.symbols[$0] } ?? "person.crop.circle")
            .font(.system(size: size * 0.45)).foregroundStyle(PhoneTheme.ink2)
            .frame(width: size, height: size)
            .background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: size * 0.26))
            .accessibilityHidden(true)
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
            Image(systemName: "exclamationmark.triangle").font(.system(size: 11)).foregroundStyle(PhoneTheme.amberIcon)
            Text("不可用").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
            if let reason { HintButton(label: "为什么不可用", text: reason) }
        }
    }
}

private struct AgentList: View {
    @EnvironmentObject private var model: PhoneModel
    @Binding var selection: String?
    var body: some View {
        let access = model.agentAccess
        let entries = PhoneAgents.entries(model.snapshot, windowOpen: model.verifiedUntil != nil)
        List(selection: $selection) {
            if !model.connected, let host = model.selectedHost {
                Label(host.name + " 不在线", systemImage: "wifi.slash").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).plainAgentRow()
            }
            switch access {
            case .locked: LockedAgents().plainAgentRow()
            case .confirming: ConfirmingAgents().plainAgentRow()
            case .closed: ClosedAgents().plainAgentRow()
            case .hidden: EmptyView()
            case .ready:
                ForEach(entries) { entry in
                    AgentRow(entry: entry).tag(entry.id)
                        .listRowInsets(EdgeInsets(top: 10, leading: 20, bottom: 10, trailing: 20)).listRowBackground(Color.clear)
                }
                if entries.count == 1 {
                    HStack(spacing: 6) {
                        Text("还没有自己的 Agent").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted)
                        HintButton(label: "新建 Agent", text: "新建 Agent 尚未实现：在网页或桌面端新建。")
                    }.frame(maxWidth: .infinity).padding(.top, 32).plainAgentRow()
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(PhoneTheme.canvas)
        .navigationTitle("我的 Agent")
        .navigationBarTitleDisplayMode(.large)
        .refreshable { await model.refresh() }
        // Without Face ID nothing asks, so the list comes by itself; with it, the first opening asks once, as a conversation does.
        .task(id: model.connected) { if model.agentAccess == .closed { await model.openAgents() } }
    }
}

/** Outside a content window the list is not sent; one tap opens it. */
struct ClosedAgents: View {
    @EnvironmentObject private var model: PhoneModel
    @AppStorage(PhoneFaceID.key) private var faceID = false
    var body: some View {
        Group {
            if model.verifying { ProgressView().controlSize(.small).tint(PhoneTheme.muted) }
            else if model.connected {
                Button(PhoneUnlock.reopenWords(faceID: faceID)) { Task { await model.openAgents() } }
                    .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
            } else { Text("Mac 不在线，连上后可以查看").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted) }
        }.frame(maxWidth: .infinity).padding(.top, 48)
    }
}

extension View {
    func plainAgentRow() -> some View { listRowSeparator(.hidden).listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16)) }
}

private struct AgentRow: View {
    @EnvironmentObject private var model: PhoneModel
    let entry: PhoneAgentEntry
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AgentTile(glyph: entry.glyph, size: 40)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(entry.name).font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink).lineLimit(1)
                    if entry.general { BuiltInMark() }
                }
                if !entry.duty.isEmpty { Text(entry.duty).font(.system(size: 14)).foregroundStyle(PhoneTheme.ink2).lineLimit(1) }
                HStack(spacing: 6) {
                    if let harness = entry.harnessId { EngineTile(mark: model.engineMark(harness), size: 14) }
                    Text(([entry.runs] + [entry.place].compactMap { $0 }).joined(separator: " · "))
                        .font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                }
                if !entry.available { Unavailable(reason: entry.unavailableReason) }
            }
            Spacer(minLength: 0)
        }.contentShape(Rectangle())
    }
}

enum AgentSection: String, Hashable, CaseIterable {
    case delegate = "委托", memory = "记忆", schedules = "定时", settings = "设置"
}

/** An Agent's page: its name and duty, how it runs, and 委托 · 记忆 · 定时 · 设置 (通用 has no 委托). */
struct AgentPage: View {
    @EnvironmentObject private var model: PhoneModel
    let id: String
    @State private var section: AgentSection?
    @State private var read = PhoneAgentRead.loading
    @State private var reading = UUID()
    private var general: Bool { id == PhoneAgents.generalId }
    private var summary: NativeJSON { model.snapshot["customAgents"].array.first { $0["id"].string == id } ?? .null }
    private var entry: PhoneAgentEntry? { PhoneAgents.entry(model.snapshot, id: id, windowOpen: model.verifiedUntil != nil) }
    private var sections: [AgentSection] {
        (general ? [] : [.delegate]) + [.memory] + (model.snapshot["catalog"]["features"]["automations"].bool ? [.schedules] : []) + [.settings]
    }
    private var current: AgentSection { section.flatMap { sections.contains($0) ? $0 : nil } ?? sections[0] }
    var body: some View {
        Group {
            switch model.agentAccess {
            case .locked: LockedAgents()
            case .confirming: ConfirmingAgents()
            case .closed: ClosedAgents()
            default:
                if let entry { page(entry) }
                else {
                    VStack(spacing: 12) {
                        Text("找不到这个 Agent").font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink)
                        Button("回到列表") { model.agentPath = [] }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
                    }.frame(maxWidth: .infinity).padding(.top, 48)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(PhoneTheme.canvas)
        .navigationTitle(entry?.name ?? "Agent").navigationBarTitleDisplayMode(.inline)
        .task(id: reading) { await load() }
        #if LATCH_SCREENS
        .onAppear { if section == nil { section = ScreensStage.section } }
        #endif
        // What the window showed goes with it; a refusal or a changed scope clears content too, and the page reads again.
        .onChange(of: model.verifiedUntil == nil) { _, closed in if closed, case .ready = read { read = .closed } }
        .onChange(of: model.contentGeneration) { _, _ in
            guard case .ready = read else { return }
            if model.verifiedUntil == nil { read = .closed } else { reload() }
        }
    }
    private func load() async {
        read = .loading
        read = await model.readAgent(id)
    }
    private func reload() { reading = UUID() }
    private func page(_ entry: PhoneAgentEntry) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    AgentTile(glyph: entry.glyph, size: 44)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(entry.name).font(.system(size: 20, weight: .semibold)).foregroundStyle(PhoneTheme.ink)
                            if entry.general { BuiltInMark() }
                        }
                        Text(entry.duty).font(.system(size: 14)).foregroundStyle(PhoneTheme.ink2)
                    }
                }
                facts(entry)
                Picker("\(entry.name) 的页面", selection: Binding(get: { current }, set: { section = $0 })) {
                    ForEach(sections, id: \.self) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented)
                switch current {
                case .delegate: DelegateSection(agent: summary, name: entry.name)
                case .memory: detailed { MemorySection(owner: id, memories: $0["memories"].array, reload: reload) }
                case .schedules: ScheduleSection(id: id)
                case .settings: detailed { AgentSettingsSection(detail: $0, general: general) }
                }
            }.padding(.horizontal, 20).padding(.vertical, 12).frame(maxWidth: 720, alignment: .leading)
        }
    }
    private func facts(_ entry: PhoneAgentEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            fact("执行方式") {
                HStack(spacing: 6) {
                    if let harness = entry.harnessId { EngineTile(mark: model.engineMark(harness), size: 14) }
                    Text(entry.general ? "每个会话自己选" : entry.runs)
                }
            }
            if let place = entry.place { fact("工作位置") { Text(place) } }
            if !entry.available { fact("可用性") { Unavailable(reason: entry.unavailableReason) } }
        }
    }
    private func fact<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        HStack(spacing: 12) {
            Text(label).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).frame(width: 64, alignment: .leading)
            value().font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2).lineLimit(1)
        }
    }
    @ViewBuilder private func detailed<Content: View>(@ViewBuilder _ content: (NativeJSON) -> Content) -> some View {
        switch read {
        case .ready(let value): content(value)
        default: AgentReadState(read: read, retry: reload)
        }
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
                Button(PhoneUnlock.reopenWords(faceID: faceID), action: retry).buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink).disabled(!model.connected)
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

/** 委托: a real session of this Agent, its picks changeable for this one; under it, this Agent's sessions. */
private struct DelegateSection: View {
    @EnvironmentObject private var model: PhoneModel
    let agent: NativeJSON
    let name: String
    @State private var choice = PhoneStartChoice()
    @State private var prompt = ""
    @State private var sending = false
    @State private var all = false
    private var catalog: NativeJSON { model.snapshot["catalog"] }
    private var harness: NativeJSON { catalog["harnesses"].array.first { $0["id"].string == choice.harnessId } ?? .null }
    private var agentId: String { agent["id"].string ?? "" }
    private var mine: [NativePendingWrite] { model.pending.filter { PhonePending.kind($0) == .delegation(agentId: agentId) } }
    private var blocker: String? {
        if !mine.isEmpty { return nil }
        if !model.pending.isEmpty { return "上一项提交结果待确认" }
        return PhoneAgents.blocker(catalog, agent: agent, choice: choice, connected: model.connected, canRun: model.canRun)
    }
    private var canSend: Bool { blocker == nil && mine.isEmpty && !sending && !model.busy && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(spacing: 0) {
                projectRow
                Divider().overlay(PhoneTheme.line)
                harnessRow
                if PhoneStart.usesServices(harness) { Divider().overlay(PhoneTheme.line); modelRow }
            }
            .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(PhoneTheme.line))
            .disabled(sending || !mine.isEmpty)
            LocalTextEditor(text: $prompt, placeholder: "交给\(name)一件事…", maximumLines: 6)
                .overlay(alignment: .topLeading) {
                    if prompt.isEmpty { Text("交给\(name)一件事…").font(PhoneTheme.body).foregroundStyle(PhoneTheme.faint).allowsHitTesting(false).accessibilityHidden(true) }
                }
                .padding(14).frame(minHeight: 96, alignment: .topLeading)
                .background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 16))
            ForEach(mine, id: \.requestId) { pending in
                HStack {
                    Label("委托结果待确认", systemImage: "questionmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                    Spacer()
                    Button("重试同一请求") { retry(pending) }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                }
            }
            HStack(spacing: 8) {
                if let blocker { Text(blocker).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).lineLimit(2) }
                Spacer(minLength: 0)
                HintButton(label: "新会话", text: "按 Agent 现在的定义开始一个新会话。要接着原来的对话，在近期委托里打开那个会话直接输入。")
                Button { send() } label: {
                    if sending { ProgressView().controlSize(.small).tint(.white) } else { Text("委托") }
                }
                .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).controlSize(.large).tint(PhoneTheme.accent).disabled(!canSend)
            }
            recent
        }
        .task(id: (agent["id"].string ?? "") + "\(agent["revision"].integer ?? 0)") { choice = PhoneAgents.choice(catalog, agent: agent) }
    }
    private func send() {
        sending = true
        Task {
            if await model.delegate(agent: agent, choice: choice, prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines)) { prompt = "" }
            sending = false
        }
    }
    private func retry(_ pending: NativePendingWrite) {
        sending = true
        Task {
            if await model.finishDelegation(pending) { prompt = "" }
            sending = false
        }
    }
    @ViewBuilder private var recent: some View {
        let sessions = PhoneAgents.recent(model.snapshot["tasks"].array, id: agentId)
        let shown = all ? sessions : Array(sessions.prefix(6))
        HStack {
            Text("近期委托").font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.muted)
            Spacer()
            if sessions.count > shown.count { Button("全部（\(sessions.count)）") { all = true }.font(PhoneTheme.caption) }
        }.padding(.top, 12)
        if sessions.isEmpty { Text("还没有委托").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.vertical, 16) }
        ForEach(shown, id: \.id) { task in
            Button { Task { await model.openFromAgent(task.id) } } label: {
                InboxRow(task: task, frozen: !model.connected, inWaiting: false, project: nil)
            }.buttonStyle(.plain)
            Divider().overlay(PhoneTheme.line)
        }
    }
    private func row<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.system(size: 15, weight: .medium)).foregroundStyle(PhoneTheme.ink)
            Spacer(minLength: 8)
            value().font(.system(size: 15)).lineLimit(1)
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .medium)).foregroundStyle(PhoneTheme.faint)
        }.padding(.horizontal, 16).frame(height: 48).contentShape(Rectangle())
    }
    private func check(_ name: String, on: Bool) -> some View {
        Group { if on { Label(name, systemImage: "checkmark") } else { Text(name) } }
    }
    private var projectRow: some View {
        Menu {
            ForEach(PhoneStart.projects(catalog)) { project in Button { choice.workspaceId = project.id } label: { check(project.name, on: project.id == choice.workspaceId) } }
        } label: {
            row("项目") {
                HStack(spacing: 6) {
                    Image(systemName: "folder").font(.system(size: 13)).foregroundStyle(PhoneTheme.muted)
                    Text(PhoneAgents.worksIn(catalog, projectId: choice.workspaceId)).foregroundStyle(PhoneTheme.ink2)
                }
            }
        }
    }
    private var harnessRow: some View {
        Menu {
            ForEach(PhoneAgents.harnesses(catalog)) { engine in Button { choice.harnessId = engine.id } label: { check(engine.name, on: engine.id == choice.harnessId) } }
        } label: {
            row("Harness") {
                HStack(spacing: 6) {
                    if choice.harnessId != nil { EngineTile(mark: PhoneStart.mark(harness), size: 18); Text(PhoneStart.engineName(harness)).foregroundStyle(PhoneTheme.ink2) }
                    else { Text("先选 Harness").foregroundStyle(PhoneTheme.muted) }
                }
            }
        }
    }
    private var modelRow: some View {
        Menu {
            Button { choice.model = nil } label: { check("默认模型", on: choice.model == nil) }
            ForEach(PhoneStart.models(catalog)) { item in Button { choice.model = item } label: { check(item.model + " · " + item.providerName, on: item == choice.model) } }
        } label: { row("模型") { Text(choice.model?.model ?? "默认模型").foregroundStyle(PhoneTheme.ink2) } }
    }
}

/** 记忆: what the person wrote for this Agent, to add, change and delete. Each write keeps its request until the Mac answers. */
private struct MemorySection: View {
    @EnvironmentObject private var model: PhoneModel
    let owner: String
    let memories: [NativeJSON]
    let reload: () -> Void
    @State private var editing: MemoryDraft?
    @State private var deleting: NativeJSON?
    @State private var deleteState: PhoneAgentWrite?
    @State private var deleteWrite: NativePendingWrite?
    private var held: [NativePendingWrite] { model.pending.filter { PhonePending.kind($0) == .memory(owner: owner) } }
    private var canWrite: Bool { model.connected && model.canRun && !model.busy }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Text("只给这个 Agent").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                HintButton(label: "只给这个 Agent", text: "只有你能写，只有这个 Agent 会用，工具不会改写它。在这里删除只删 Latch 保存的这一条，不会抹掉上游服务里已有的记录。")
                Spacer()
                Button("添加", systemImage: "plus") { editing = MemoryDraft(memory: nil, text: "") }
                    .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(PhoneTheme.ink).disabled(!canWrite || !held.isEmpty)
            }
            ForEach(held, id: \.requestId) { pending in
                WriteNotice(state: .unknown, retry: { Task { if await model.writeMemory(pending) == .done { reload() } } })
            }
            if let deleteState { WriteNotice(state: deleteState, retry: retryDelete, reload: { self.deleteState = nil; reload() }) }
            if memories.isEmpty { Text("还没有记忆").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.vertical, 24) }
            ForEach(memories, id: \.id) { memory in
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(memory["content"].string ?? "").font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink).textSelection(.disabled)
                        Text(PhoneTime.parse(memory["updatedAt"]).map { PhoneTime.relative($0) } ?? "").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                    }
                    Spacer(minLength: 4)
                    Menu {
                        Button("修改", systemImage: "pencil") { editing = MemoryDraft(memory: memory, text: memory["content"].string ?? "") }
                        Button("删除", systemImage: "trash", role: .destructive) { deleting = memory }
                    } label: { Image(systemName: "ellipsis").frame(width: 32, height: 32).foregroundStyle(PhoneTheme.muted) }
                        .disabled(!canWrite || !held.isEmpty).accessibilityLabel("记忆操作")
                }.padding(.vertical, 6)
                Divider().overlay(PhoneTheme.line)
            }
        }
        .sheet(item: $editing) { draft in MemoryEditor(owner: owner, draft: draft, saved: reload) }
        .confirmationDialog("删除这条记忆？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("删除", role: .destructive) { if let deleting { remove(deleting) } }
        } message: { Text("这个 Agent 之后不再收到它。已经开始的外部 Harness 会话里已发出的内容不会撤回。") }
    }
    private func remove(_ memory: NativeJSON) {
        guard let id = memory["id"].string, let write = try? PhoneMemoryWrite.remove(owner: owner, memoryId: id) else { return }
        deleteWrite = write
        Task { await settle(write) }
    }
    private func retryDelete() { if let deleteWrite { Task { await settle(deleteWrite) } } }
    private func settle(_ write: NativePendingWrite) async {
        let outcome = await model.writeMemory(write)
        if outcome == .done { deleteState = nil; deleteWrite = nil; reload() } else { deleteState = outcome }
    }
}

struct MemoryDraft: Identifiable {
    let id = UUID()
    let memory: NativeJSON?
    var text: String
}

/** A write's state: refused, changed meanwhile, or unknown with a retry of the same request. */
struct WriteNotice: View {
    let state: PhoneAgentWrite
    var retry: (() -> Void)? = nil
    var reload: (() -> Void)? = nil
    var body: some View {
        switch state {
        case .done: EmptyView()
        case .unknown:
            HStack {
                Label("结果未知", systemImage: "questionmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                Spacer()
                if let retry { Button("重试同一请求", action: retry).font(PhoneTheme.caption) }
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
}

private struct MemoryEditor: View {
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
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                LocalTextEditor(text: $draft.text, placeholder: draft.memory == nil ? "新记忆" : "修改记忆", maximumLines: 10)
                    .padding(14).frame(minHeight: 140, alignment: .topLeading)
                    .background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 16))
                    .disabled(write != nil)
                if draft.text.count > PhoneMemoryWrite.maximum { Text("最多 \(PhoneMemoryWrite.maximum) 字").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
                if let state { WriteNotice(state: state, retry: { save() }, reload: { saved(); dismiss() }) }
                Spacer(minLength: 0)
            }
            .padding(16)
            .navigationTitle(draft.memory == nil ? "新记忆" : "修改记忆").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }.buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(PhoneTheme.accent)
                        .disabled(saving || text.isEmpty || unchanged || draft.text.count > PhoneMemoryWrite.maximum || !model.connected)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(saving || state == .unknown)
        // An unconfirmed write stays with the model and is offered again on the page; the text goes with the window.
        .onChange(of: model.verifiedUntil == nil) { _, closed in if closed { dismiss() } }
    }
    private func save() {
        if write == nil {
            write = draft.memory.map { try? PhoneMemoryWrite.change(owner: owner, memory: $0, text: draft.text) } ?? (try? PhoneMemoryWrite.create(owner: owner, text: draft.text))
        }
        guard let write else { return }
        saving = true
        Task {
            let outcome = await model.writeMemory(write)
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

/** 定时: this Agent's schedules and their runs, read-only here. */
private struct ScheduleSection: View {
    @EnvironmentObject private var model: PhoneModel
    let id: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let items = PhoneAgents.automations(model.snapshot, id: id, windowOpen: model.verifiedUntil != nil) {
                if items.isEmpty { Text("没有定时任务").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.vertical, 24) }
                ForEach(items, id: \.id) { item in
                    NavigationLink { AutomationRuns(id: item.id, name: item["name"].string ?? "定时任务") } label: { ScheduleRow(item: item) }.buttonStyle(.plain)
                    Divider().overlay(PhoneTheme.line)
                }
            } else if !model.connected {
                Text("Mac 不在线，连上后可以查看").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.top, 32)
            } else { ConfirmingAgents() }
            NotYet(text: "新建与修改定时任务")
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

private struct ScheduleRow: View {
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

private struct AutomationRuns: View {
    @EnvironmentObject private var model: PhoneModel
    let id: String
    let name: String
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
                        Button { if let session { Task { await model.openFromAgent(session) } } } label: {
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
private struct AgentSettingsSection: View {
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
            NotYet(text: general ? "修改通用" : "修改 Agent")
        }
    }
    private func field<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            value().font(.system(size: 15)).foregroundStyle(PhoneTheme.ink).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
