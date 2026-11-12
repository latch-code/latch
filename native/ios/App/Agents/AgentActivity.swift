import LatchNativeCore
import SwiftUI

extension PhoneTone {
    var color: Color {
        switch self {
        case .failed: PhoneTheme.red
        case .warn: PhoneTheme.amber
        case .running: PhoneTheme.accent
        case .done, .neutral: PhoneTheme.muted
        }
    }
}

/** A state word in its tone: red only for a real failure, amber for what waits or is not known. */
struct ToneWord: View {
    let word: String
    let tone: PhoneTone
    var body: some View {
        Text(word).font(.system(size: 12, weight: .medium)).foregroundStyle(tone.color).lineLimit(1)
    }
}

/**
 * Cards in one place of the conversation, oldest first: the newest three, and 「还有 N 条结果」 that opens 动态, where
 * every result is listed.
 */
struct ResultStack: View {
    let results: [PhoneScheduleResult]
    let openActivity: () -> Void
    let openRun: (String) -> Void
    /** Absent where a file cannot be opened here. */
    var openFile: ((PhoneResultFile, String) -> Void)? = nil
    var body: some View {
        let stack = PhoneResults.stack(results)
        VStack(alignment: .leading, spacing: 10) {
            if stack.hidden > 0 {
                Button("还有 \(stack.hidden) 条结果", action: openActivity).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2).buttonStyle(.plain)
            }
            ForEach(stack.shown) { ResultCard(result: $0, openRun: openRun, openFile: openFile) }
        }
    }
}

/**
 * 定时 · <name>: a Host record of a run that settled, never a message. Its outcome, the start of the last reply with 展开,
 * the files, why it did not complete with one next step, and 打开运行.
 */
struct ResultCard: View {
    @EnvironmentObject private var model: PhoneModel
    let result: PhoneScheduleResult
    let openRun: (String) -> Void
    var openFile: ((PhoneResultFile, String) -> Void)? = nil
    @State private var open = false
    @State private var running = false
    @State private var state: PhoneAgentWrite?
    private var run: String? { PhoneResults.run(result, tasks: model.snapshot["tasks"].array) }
    private var step: PhoneResultStep? {
        PhoneResults.nextStep(result, automations: model.snapshot["automations"].array, canRun: model.canRun, connected: model.connected)
    }
    private var held: NativePendingWrite? { PhoneResults.heldRun(model.pending, automationId: result.automationId) }
    var body: some View {
        let outcome = PhoneResults.outcomeWords(result.outcome)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "alarm").font(.system(size: 12)).foregroundStyle(PhoneTheme.muted)
                Text("定时").font(.system(size: 13, weight: .semibold)).foregroundStyle(PhoneTheme.ink)
                Text(result.name).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2).lineLimit(1)
                Spacer(minLength: 4)
                if let at = PhoneTime.parse(.string(result.at)) { Text(PhoneTime.message(at)).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1) }
                ToneWord(word: outcome.word, tone: outcome.tone)
            }
            if result.contentRemoved {
                Text("运行的会话已删除").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            } else {
                if let reason = result.reason { Text(reason).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2).textSelection(.disabled) }
                if let reply = result.reply, !reply.isEmpty {
                    let preview = PhoneResults.preview(reply)
                    ConversationText(text: open ? reply : preview.short, markdown: true).frame(maxWidth: .infinity, alignment: .leading)
                    if preview.more {
                        Button(open ? "收起" : "展开") { open.toggle() }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2).buttonStyle(.plain)
                            .accessibilityValue(open ? "已展开" : "已收起")
                    }
                    if open && result.replyTruncated { Text("完整回复在运行的会话里").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                }
                if !result.files.isEmpty { files }
            }
            actions
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(PhoneTheme.line))
        .accessibilityElement(children: .contain).accessibilityLabel("定时结果：" + result.name)
    }
    private var files: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(result.files) { file in
                HStack(spacing: 6) {
                    Image(systemName: "doc").font(.system(size: 12)).foregroundStyle(PhoneTheme.muted)
                    if let openFile, let run, !file.deleted {
                        Button { openFile(file, run) } label: { Text(file.shown).font(.system(size: 13, design: .monospaced)).underline().lineLimit(1).truncationMode(.head) }
                            .buttonStyle(.plain).foregroundStyle(PhoneTheme.ink2)
                    } else {
                        Text(file.shown).font(.system(size: 13, design: .monospaced)).foregroundStyle(file.deleted ? PhoneTheme.muted : PhoneTheme.ink2).lineLimit(1).truncationMode(.head)
                    }
                    Spacer(minLength: 4)
                    Text(file.change).font(.system(size: 12)).foregroundStyle(PhoneTheme.muted)
                }
            }
            if result.filesMore > 0 { Text("另有 \(result.filesMore) 个文件").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
        }
    }
    @ViewBuilder private var actions: some View {
        if step != nil || run != nil || held != nil {
            HStack(spacing: 8) {
                if case let .runNow(automationId) = step, held == nil {
                    Button { runNow(automationId) } label: {
                        ZStack { Text("立即运行").opacity(running ? 0 : 1); if running { ProgressView().controlSize(.mini) } }
                    }
                    .buttonStyle(.bordered).tint(PhoneTheme.ink).disabled(running || model.busy || !model.pending.isEmpty)
                }
                if let run { Button("打开运行") { openRun(run) }.buttonStyle(.bordered).tint(PhoneTheme.ink) }
            }.buttonBorderShape(.capsule).controlSize(.small)
        }
        if let held, !running {
            WriteNotice(state: .unknown, retry: { send(held) }, held: held)
        } else if let state { WriteNotice(state: state) }
    }
    private func runNow(_ automationId: String) {
        guard let write = try? PhoneResults.runNow(automationId: automationId) else { return }
        send(write)
    }
    private func send(_ write: NativePendingWrite) {
        running = true; state = nil
        Task {
            let outcome = await model.writeAgent(write)
            running = false
            // Unknown stays with the model's pending write, which the card offers again.
            if outcome != .done && outcome != .unknown { state = outcome }
        }
    }
}

/**
 * 想定时：<name> · <plan>, the first line of each run's input, 它推断的 and amber 来自外部内容. Nothing is created or runs
 * until the person saves it in the form; 不要 sets it aside through the Host.
 */
struct ScheduleProposalRow: View {
    @EnvironmentObject private var model: PhoneModel
    let owner: String
    let proposal: PhoneProposal
    @State private var working = false
    @State private var failure: String?
    @State private var form = false
    private var held: (write: NativePendingWrite, saving: Bool)? { PhoneProposals.held(model.pending, owner: owner, proposalId: proposal.id) }
    private var heldCreate: NativePendingWrite? { PhoneScheduleProposals.held(model.pending, proposalId: proposal.id) }
    private var locked: Bool { !model.connected || !model.canRun || model.busy || working || (!model.pending.isEmpty && held == nil) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            (Text("想定时：").foregroundColor(PhoneTheme.muted) + Text(PhoneScheduleProposals.line(proposal)))
                .font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink).textSelection(.disabled)
            Text(PhoneScheduleProposals.inputLine(proposal.content)).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2).lineLimit(2)
            HStack(spacing: 8) {
                Text(PhoneProposals.originWords(proposal.origin)).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                if proposal.external { ExternalMark() }
                if let reason = proposal.reason { HintButton(label: "理由", text: reason) }
                Spacer(minLength: 4)
                outcome
            }
            if let held, !working {
                HStack {
                    Label("结果未知", systemImage: "questionmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                    Spacer()
                    Button("核对并放下") { Task { if await model.checkAgentWrite(held.write) == nil { failure = "没能核对，稍后再试" } } }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                    Button("重试同一请求") { send(held.write) }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                }
            } else if heldCreate != nil && !form {
                HStack {
                    Label("保存结果未知", systemImage: "questionmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                    Spacer()
                    Button("查看") { form = true }.font(PhoneTheme.caption)
                }
            }
            if let failure { Label(failure, systemImage: "exclamationmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.red) }
        }
        .padding(12)
        .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(proposal.state == .pending ? PhoneTheme.lineStrong : PhoneTheme.line))
        .accessibilityElement(children: .contain).accessibilityLabel("定时提议")
        .sheet(isPresented: $form) { ScheduleProposalForm(owner: owner, proposal: proposal).presentationCornerRadius(28) }
        .onChange(of: model.verifiedUntil == nil) { _, closed in if closed { form = false } }
    }
    @ViewBuilder private var outcome: some View {
        switch proposal.state {
        case .saved: Label("已保存", systemImage: "checkmark").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2)
        case .dismissed: Text("不要了").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
        case .pending:
            HStack(spacing: 8) {
                Button { dismissIt() } label: { ZStack { Text("不要").opacity(working ? 0 : 1); if working { ProgressView().controlSize(.mini) } } }
                    .buttonStyle(.bordered).tint(PhoneTheme.ink).disabled(locked || held != nil || heldCreate != nil)
                Button("打开") { form = true }.buttonStyle(.borderedProminent).tint(PhoneTheme.accent)
                    .disabled(!model.connected || !model.canRun || held != nil)
            }
            .buttonBorderShape(.capsule).controlSize(.small)
        }
    }
    private func dismissIt() {
        guard let write = try? PhoneProposals.dismiss(owner: owner, proposalId: proposal.id) else { return }
        send(write)
    }
    private func send(_ write: NativePendingWrite) {
        working = true; failure = nil
        Task {
            let outcome = await model.writeAgent(write)
            working = false
            switch outcome {
            case .done, .unknown: break
            case .changed: failure = "已在别处处理"
            case let .refused(message): failure = message
            }
            if outcome != .unknown { await model.loadProposals(owner) }
        }
    }
}

/**
 * The schedule a proposal offers, before anything exists: its name, when, where it works and each run's input in full
 * under 它写的. 保存 creates it through the Host's create with the proposal's ID; a result that is unknown keeps the request.
 */
struct ScheduleProposalForm: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let owner: String
    let proposal: PhoneProposal
    @State private var location: String?
    @State private var notify = false
    @State private var saving = false
    @State private var state: PhoneAgentWrite?
    private var catalog: NativeJSON { model.snapshot["catalog"] }
    private var agent: NativeJSON { owner == PhoneAgents.generalId ? .null : model.snapshot["customAgents"].array.first { $0["id"].string == owner } ?? .null }
    private var held: NativePendingWrite? { PhoneScheduleProposals.held(model.pending, proposalId: proposal.id) }
    private var places: [PhoneScheduleLocation] { PhoneScheduleProposals.locations(catalog, harness: PhoneScheduleProposals.harness(catalog, agent: agent)) }
    private var blocker: String? {
        if held != nil { return nil }
        if !model.pending.isEmpty { return "上一项提交结果待确认" }
        return PhoneScheduleProposals.blocker(proposal, location: location, catalog: catalog, agent: agent, connected: model.connected, canRun: model.canRun)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("名称") { Text(proposal.schedule?.name ?? "").foregroundStyle(PhoneTheme.ink) }
                    LabeledContent("时间") { Text(proposal.schedule.map { PhoneAgents.scheduleWords($0.plan) } ?? "").foregroundStyle(PhoneTheme.ink) }
                    LabeledContent("工作位置") {
                        Menu {
                            ForEach(places) { place in
                                Button { location = place.id } label: {
                                    if place.id == location { Label(place.name, systemImage: "checkmark") } else { Text(place.name) }
                                    if let why = place.unavailable { Text(why) } else if place.codeRoot { Text(PhoneScheduleLocation.codeRootWords) }
                                }.disabled(place.unavailable != nil)
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Text(places.first { $0.id == location }?.name ?? "选择").foregroundStyle(location == nil ? PhoneTheme.muted : PhoneTheme.ink)
                                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11)).foregroundStyle(PhoneTheme.muted)
                            }
                        }.accessibilityLabel("工作位置")
                    }
                    if places.first(where: { $0.id == location })?.codeRoot == true {
                        Label(PhoneScheduleLocation.codeRootNotice, systemImage: "exclamationmark.triangle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                    }
                    Toggle("结果出来时通知我", isOn: $notify).tint(PhoneTheme.accent)
                }
                .disabled(held != nil || saving)
                Section {
                    Text(proposal.content).font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink).textSelection(.disabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } header: {
                    HStack(spacing: 8) {
                        Text("每次的输入 · 它写的")
                        if proposal.external { ExternalMark() }
                    }
                }
                Section {
                    if let held, !saving { WriteNotice(state: .unknown, retry: { send(held) }, held: held) }
                    else if let state { WriteNotice(state: state, reload: { dismiss() }) }
                    if let blocker, held == nil { Text(blocker).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
                    HStack {
                        Spacer()
                        Button("保存") { save() }.buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(PhoneTheme.accent)
                            .disabled(saving || held != nil || blocker != nil)
                    }
                }.listRowBackground(Color.clear)
            }
            .scrollContentBackground(.hidden).background(PhoneTheme.canvas)
            .navigationTitle("新建定时").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(saving) } }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(saving)
        .task(id: owner) {
            if let request = held, let body = try? NativeJSON.decode(request.body) {
                location = body["projectId"].string ?? "default"; notify = body["notify"].bool
            } else if location == nil { location = PhoneScheduleProposals.location(agent, catalog: catalog) }
        }
        .onChange(of: model.verifiedUntil == nil) { _, closed in if closed { dismiss() } }
    }
    private func save() {
        guard let location, let write = try? PhoneScheduleProposals.create(owner: owner, proposal: proposal, location: location, notify: notify) else { return }
        send(write)
    }
    private func send(_ write: NativePendingWrite) {
        saving = true; state = nil
        Task {
            let outcome = await model.writeAgent(write)
            saving = false
            if outcome == .done { await model.loadProposals(owner); dismiss() }
            else if outcome != .unknown { state = outcome; await model.loadProposals(owner) }
        }
    }
}

/** A page of 动态 or 资料库 read inside the window, with 加载更多; closing the window takes it. */
@MainActor final class AgentPages<Row: Equatable & Sendable>: ObservableObject {
    @Published var read = PhonePagedRead<Row>()
    @Published var failure: PhoneAgentRead?
    let parse: (NativeJSON) -> [Row]
    init(parse: @escaping (NativeJSON) -> [Row]) { self.parse = parse }
    func load(_ model: PhoneModel, owner: String, part: String) async {
        let token = read.begin()
        let answer = await model.readAgentPage(owner: owner, part: part, before: nil)
        if case let .ready(value) = answer {
            if read.finish(token, rows: parse(value), next: value["next"].string, more: false, windowOpen: model.verifiedUntil != nil) { failure = nil }
        } else if answer != .loading, read.current(token) { failure = answer }
    }
    func more(_ model: PhoneModel, owner: String, part: String) async {
        guard let page = read.beginMore() else { return }
        if case let .ready(value) = await model.readAgentPage(owner: owner, part: part, before: page.before) {
            if !read.finish(page.token, rows: parse(value), next: value["next"].string, more: true, windowOpen: model.verifiedUntil != nil) { read.failed(page.token) }
        } else { read.failed(page.token) }
    }
    func clear() { read.clear(); failure = nil }
}

/** The states a paged list shares: reading, failed, empty, then its rows and 加载更多. */
private struct PagedFrame<Row: Equatable & Sendable, Content: View>: View {
    @ObservedObject var pages: AgentPages<Row>
    let empty: String
    let retry: () -> Void
    let more: () -> Void
    @ViewBuilder let content: () -> Content
    var body: some View {
        if let failure = pages.failure, pages.read.rows.isEmpty { AgentReadState(read: failure, retry: retry) }
        else if !pages.read.loaded { ProgressView().controlSize(.small).tint(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.vertical, 16) }
        else if pages.read.rows.isEmpty && !pages.read.more { Text(empty).font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.vertical, 16) }
        else {
            content()
            if pages.read.more {
                Button { more() } label: {
                    ZStack { Text("加载更多").opacity(pages.read.loadingMore ? 0 : 1); if pages.read.loadingMore { ProgressView().controlSize(.small) } }
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink).disabled(pages.read.loadingMore)
            }
        }
    }
}

/**
 * 动态: what happened with this Agent, from the Host's records only, newest first in 今天 / 本周 / 更早. A row opens where
 * it happened: a topic, a run, or 记忆.
 */
struct ActivitySection: View {
    @EnvironmentObject private var model: PhoneModel
    let owner: String
    let openTopic: (String) -> Void
    let openMemory: () -> Void
    @StateObject private var pages = AgentPages<PhoneActivityRow>(parse: PhoneActivity.rows)
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PagedFrame(pages: pages, empty: "还没有动态", retry: reload, more: { Task { await pages.more(model, owner: owner, part: "activity") } }) {
                ForEach(Array(PhoneActivity.bucketed(pages.read.rows).enumerated()), id: \.offset) { _, bucket in
                    Text(bucket.label).font(.system(size: 12, weight: .medium)).foregroundStyle(PhoneTheme.muted).padding(.top, 4)
                    ForEach(bucket.rows) { row in
                        rowView(row)
                        Divider().overlay(PhoneTheme.line)
                    }
                }
            }
        }
        .task(id: [PhoneActivity.signature(model.snapshot, owner: owner), model.verifiedUntil == nil ? "closed" : "open"]) { await load() }
        .onChange(of: model.contentGeneration) { _, _ in pages.clear() }
    }
    private func load() async {
        guard model.verifiedUntil != nil else { pages.clear(); return }
        await pages.load(model, owner: owner, part: "activity")
    }
    private func reload() { Task { await load() } }
    @ViewBuilder private func rowView(_ row: PhoneActivityRow) -> some View {
        let listed: Bool = {
            if case let .session(id) = row.target { return model.snapshot["tasks"].array.contains { $0["id"].string == id } }
            return row.target == .memory
        }()
        Button {
            switch row.target {
            case let .session(id): openTopic(id)
            case .memory: openMemory()
            case .none: break
            }
        } label: {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    (Text(row.lead).foregroundColor(PhoneTheme.ink) + Text(row.subject.map { " · " + $0 } ?? "").foregroundColor(PhoneTheme.ink2))
                        .font(.system(size: 14)).lineLimit(1)
                    if let at = PhoneTime.parse(.string(row.at)) { Text(PhoneTime.message(at)).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                }
                Spacer(minLength: 6)
                if let state = row.state { ToneWord(word: state, tone: row.tone) }
                if listed { Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(PhoneTheme.faint) }
            }.padding(.vertical, 4).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!listed)
    }
}

/**
 * 资料库: the files this Agent's sessions changed and the attachments the person gave it, by session, newest first. A file
 * opens in the file preview of its session, under that session's rules.
 */
struct LibrarySection: View {
    @EnvironmentObject private var model: PhoneModel
    let owner: String
    let openTopic: (String) -> Void
    let openFile: (PhoneLibraryFile) -> Void
    @StateObject private var pages = AgentPages<PhoneLibraryGroup>(parse: PhoneActivity.groups)
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            PagedFrame(pages: pages, empty: "还没有文件", retry: reload, more: { Task { await pages.more(model, owner: owner, part: "library") } }) {
                ForEach(pages.read.rows) { group in groupView(group) }
            }
        }
        .task(id: [PhoneActivity.signature(model.snapshot, owner: owner), model.verifiedUntil == nil ? "closed" : "open"]) { await load() }
        .onChange(of: model.contentGeneration) { _, _ in pages.clear() }
    }
    private func load() async {
        guard model.verifiedUntil != nil else { pages.clear(); return }
        await pages.load(model, owner: owner, part: "library")
    }
    private func reload() { Task { await load() } }
    private func groupView(_ group: PhoneLibraryGroup) -> some View {
        let listed = model.snapshot["tasks"].array.contains { $0["id"].string == group.sessionId }
        return VStack(alignment: .leading, spacing: 6) {
            Button { openTopic(group.sessionId) } label: {
                HStack(spacing: 6) {
                    if group.run { Image(systemName: "alarm").font(.system(size: 11)).foregroundStyle(PhoneTheme.muted) }
                    Text(group.title).font(.system(size: 14, weight: .medium)).foregroundStyle(PhoneTheme.ink).lineLimit(1)
                    Spacer(minLength: 4)
                    if let at = PhoneTime.parse(.string(group.at)) { Text(PhoneTime.relative(at)).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(!listed)
            ForEach(group.files) { file in
                HStack(spacing: 6) {
                    Image(systemName: file.image ? "photo" : "doc").font(.system(size: 12)).foregroundStyle(PhoneTheme.muted)
                    if file.openable && listed {
                        Button { openFile(file) } label: { Text(file.shown).font(.system(size: 13, design: .monospaced)).underline().lineLimit(1).truncationMode(.head) }
                            .buttonStyle(.plain).foregroundStyle(PhoneTheme.ink2)
                    } else {
                        Text(file.shown).font(.system(size: 13, design: .monospaced)).foregroundStyle(PhoneTheme.muted).lineLimit(1).truncationMode(.head)
                    }
                    Spacer(minLength: 4)
                    Text(file.words).font(.system(size: 12)).foregroundStyle(PhoneTheme.muted)
                }
            }
            if group.more > 0 { Text("另有 \(group.more) 个").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
        }
    }
}

/**
 * Opens a file of a given session (a run's, from a card or 资料库) in the file preview, as the conversation does: one at a
 * time, dropped when the window's content changes, and its temporary file cleared when the preview closes.
 */
@MainActor final class SessionFilePreview: ObservableObject {
    @Published var item: PreviewItem?
    private var task: Task<Void, Never>?
    private var request: UUID?
    func open(_ model: PhoneModel, reference: String, root: String?, session: String) {
        cancel(model)
        let generation = model.contentGeneration, request = UUID()
        self.request = request
        task = Task {
            defer { if self.request == request { self.task = nil; self.request = nil } }
            do {
                let item = try await model.preview(reference: reference, root: root, session: session)
                guard !Task.isCancelled, self.request == request, model.contentGeneration == generation, item.lease.valid else { PreviewFiles.discard(item); return }
                self.item = item
            } catch { if !Task.isCancelled, self.request == request, model.contentGeneration == generation { model.previewFailed(error) } }
        }
    }
    func cancel(_ model: PhoneModel) {
        if task != nil { model.cancelPreview() }
        task?.cancel(); task = nil; request = nil
    }
}

private struct SessionFilePreviewSheet: ViewModifier {
    @EnvironmentObject private var model: PhoneModel
    @ObservedObject var preview: SessionFilePreview
    func body(content: Content) -> some View {
        content
            .sheet(item: $preview.item, onDismiss: { PreviewFiles.clear() }) { NativePreviewView(item: $0) }
            .onChange(of: model.contentGeneration) { _, _ in preview.item = nil; preview.cancel(model) }
            .onChange(of: model.verifiedUntil == nil) { _, closed in if closed { preview.item = nil; preview.cancel(model) } }
            .onDisappear { preview.cancel(model) }
    }
}

extension View {
    func sessionFilePreview(_ preview: SessionFilePreview) -> some View { modifier(SessionFilePreviewSheet(preview: preview)) }
}
