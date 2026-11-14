import LatchNativeCore
import SwiftUI

struct ConversationView: View {
    @EnvironmentObject private var model: PhoneModel
    let id: String
    /** Set where the navigation has no back of its own. */
    var back: (() -> Void)? = nil
    /** A topic of 我的 Agent: the Agent's frame takes the header, and its memory proposals follow their turns. */
    var frame: AgentFrame? = nil
    @State private var preview: PreviewItem?
    @State private var previewTask: Task<Void, Never>?
    @State private var previewRequest: UUID?
    /** What the 文件 sheet lists, counted when it is asked for: the counts take a diff of every edit in the session. */
    @State private var fileList: [PhoneChangedFile]?
    /** 按文字重建 from the stop row of a session its Harness lost. */
    @State private var rebuilding = false
    @Environment(\.horizontalSizeClass) private var width
    @AppStorage(PhoneFaceID.key) private var faceID = false
    private var summary: NativeJSON { model.currentSummary }
    private var engine: String { model.engineName(summary["harnessId"].string) }
    private var hasContent: Bool { model.detail["summary"]["id"].string == id }
    private var inputReason: String? {
        if let reason = PhoneConversation.inputGate(summary: summary, permission: model.detail["permission"], canRun: model.canRun, connected: model.connected) { return reason }
        if frame != nil, hasContent, PhoneHelperSpeech.permission(model.detail, harness: model.engineInfo(summary["harnessId"].string))?.blocked == true { return "权限没确认，暂不能发送" }
        return nil
    }
    var body: some View {
        Group {
            if hasContent { transcript }
            else if model.verifiedUntil == nil && !model.verifying { locked }
            else if model.detailFailed == id { unreadable }
            else if !model.connected && !model.verifying { macAway }
            else { ProgressView().controlSize(.small).tint(PhoneTheme.muted).frame(maxWidth: .infinity, maxHeight: .infinity) }
        }
        .background(PhoneTheme.canvas)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(back != nil)
        .toolbar { header }
        // Beside the list on an iPad the tabs stay; a pushed conversation on a phone needs the room.
        .toolbar(width == .compact ? .hidden : .automatic, for: .tabBar)
        .safeAreaInset(edge: .bottom, spacing: 0) { dock }
        .sheet(item: $preview, onDismiss: { PreviewFiles.clear() }) { NativePreviewView(item: $0) }
        .sheet(isPresented: Binding(get: { fileList != nil }, set: { if !$0 { fileList = nil } })) {
            SessionFilesSheet(files: fileList ?? [], open: { path, root in fileList = nil; openFile(path, root) })
        }
        .sheet(item: $model.forkDraft) { draft in NewSessionSheet(fork: draft).presentationCornerRadius(28) }
        .sheet(item: $model.handoffDraft) { draft in HandoffSheet(draft: draft).presentationCornerRadius(28) }
        .sheet(isPresented: $rebuilding, onDismiss: { model.openPendingImport() }) { RebuildLostSheet(summary: hasContent ? model.detail["summary"] : summary).presentationCornerRadius(28) }
        // The handoffs this session is part of, read again when the snapshot says they changed.
        .task(id: [id, PhoneHandoffs.involved(model.snapshot, sessionId: id), model.verifiedUntil == nil ? "closed" : "open"]) { await model.loadHandoffs(id) }
        .onChange(of: model.verifiedUntil) { _, value in if value == nil { preview = nil } }
        .onChange(of: model.contentGeneration) { _, _ in preview = nil; cancelFile() }
        .onChange(of: model.privateSnapshot.epoch) { _, _ in preview = nil; fileList = nil }
        .onDisappear { cancelFile(); preview = nil; PreviewFiles.clear() }
    }
    @ToolbarContentBuilder private var header: some ToolbarContent {
        if let back { ToolbarItem(placement: .topBarLeading) { Button("返回", systemImage: "chevron.left", action: back).labelStyle(.iconOnly) } }
        if let frame {
            AgentFrameItems(frame: frame, topic: hasContent ? model.detail["summary"] : summary, shown: id)
        } else if #available(iOS 26, *) {
            ToolbarItem(placement: .topBarLeading) { titleMenu }.sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { titleMenu }
        }
        if hasContent && PhoneConversation.hasFiles(model.detail) {
            ToolbarItem(placement: .topBarTrailing) { Button("文件", systemImage: "folder") { fileList = sessionFiles }.labelStyle(.iconOnly) }
        }
    }
    /** The title opens the session menu, as the web's title row does; a phone that may not run sessions has none. */
    @ViewBuilder private var titleMenu: some View {
        let task = summary
        if !PhoneSessionMenu.sections(task, canRun: model.canRun).isEmpty {
            Menu { SessionMenuButtons(task: task, open: true) } label: { title }.accessibilityHint("会话操作")
        } else { title }
    }
    private var title: some View {
        let line: (parts: [String], neverAsks: Bool) = hasContent ? PhoneConversation.subtitle(model.detail, engine: engine) : ([engine], false)
        let delegated = PhoneAgents.ownerName(model.snapshot, task: hasContent ? model.detail["summary"] : summary, windowOpen: model.verifiedUntil != nil)
        let current = hasContent ? model.detail["summary"] : summary
        let imported = PhoneHistory.mark(current, sourceLabel: current["imported"]["from"].string.flatMap { from in
            model.engineInfo(from) != .null ? model.engineName(from) : nil
        })
        return HeaderTitle(title: model.detail["summary"]["title"].string ?? summary["title"].string ?? "会话",
            subtitle: (([delegated, imported?.label].compactMap { $0 }) + line.parts, line.neverAsks), detail: imported?.detail)
    }
    /** After a declined Face ID or a closed window: the session's name stays, and one plain way back in. There is no unlock screen before the first try. */
    private var locked: some View {
        VStack(spacing: 12) {
            if model.connected {
                Button(PhoneUnlock.reopenWords(faceID: faceID)) { Task { await model.openSession(id) } }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
            } else { macAway }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private var macAway: some View {
        Text("Mac 不在线，连上后可以查看内容").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private var unreadable: some View {
        VStack(spacing: 12) {
            Text("没能读取这个会话").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted)
            Button("重试") { Task { await model.openSession(id) } }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private var transcript: some View {
        let turns = PhoneConversation.turns(PhoneConversation.rendered(model.detail))
        let switches = PhoneConversation.switches(turns)
        let status = summary["status"].string ?? model.detail["summary"]["status"].string
        let running = status == "running" || status == "waiting-approval"
        let canSend = model.connected && inputReason == nil
        let canFork = model.connected && model.canFork && summary["personal"] == .null
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                if let origin = PhoneForkDraft.origin(model.detail["summary"]) {
                    Button { Task { await model.openSession(origin.taskId) } } label: {
                        Label(origin.words, systemImage: "arrow.triangle.branch").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                    }.buttonStyle(.plain).disabled(!model.snapshot["tasks"].array.contains { $0["id"].string == origin.taskId }).accessibilityHint("返回来源会话")
                }
                if let crumb = PhoneHandoffs.crumb(model.snapshot, sessionId: id) {
                    Button { Task { await model.openSession(crumb.sourceId) } } label: {
                        Label(crumb.words, systemImage: "arrow.turn.down.right").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                    }.buttonStyle(.plain).disabled(!crumb.listed).accessibilityHint("返回来源会话")
                }
                let returned = PhoneHandoffs.place(PhoneHandoffs.results(model.openHandoffs, sessionId: id), turns: turns)
                ForEach(returned[""] ?? []) { ReturnedResultCard(result: $0, sessionId: id) }
                let proposals = placedProposals(turns)
                let results = placedResults(turns)
                if let lead = results[""] { resultStack(lead) }
                ForEach(proposals[""] ?? []) { proposalRow($0) }
                ForEach(Array(turns.enumerated()), id: \.element.id) { index, turn in
                    let latest = index == turns.count - 1
                    TurnView(turn: turn, latest: latest, status: latest ? status : nil, running: latest && running, frozen: !model.connected,
                        delivery: latest && running ? PhoneConversation.delivery(model.detail, turn: turn) : nil, switched: switches[turn.id],
                        mark: model.engineMark(summary["harnessId"].string), engine: engine, helper: frame?.entry, fileScope: PhoneFileScope(model.detail["summary"]),
                        endSaid: latest && !running && PhoneConversation.runEnd(model.detail["summary"], engine: engine) != nil,
                        actions: model.detailCached ? .none : PhoneTurnActions.of(turn, latest: latest, running: latest && running, canSend: canSend, canFork: canFork),
                        index: index, open: { openFile($0, $1) }).equatable()
                    ForEach(returned[turn.id] ?? []) { ReturnedResultCard(result: $0, sessionId: id) }
                    if let placed = results[turn.id] { resultStack(placed) }
                    ForEach(proposals[turn.id] ?? []) { proposalRow($0) }
                }
                if running { RunStatusLine(person: frame != nil).id("status") }
                else if let end = PhoneConversation.runEnd(model.detail["summary"], engine: engine) { RunEndView(end: end) }
                if model.detailCached { Text("这是之前读到的内容，连上 Mac 后更新").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                if model.detail["permission"]["drift"] != .null || summary["permissionDrift"].bool {
                    Text("这个会话的权限被改变了，已停止接受输入。").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                }
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 24)
            .frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom)
        .refreshable { await model.refresh() }
    }
    @ViewBuilder private var dock: some View {
        VStack(spacing: 8) {
            ControlPendingBar()
            if let progress = model.previewProgress {
                HStack(spacing: 12) {
                    if progress.total > 0 { ProgressView(value: Double(progress.completed), total: Double(progress.total)).frame(width: 72).tint(PhoneTheme.muted) }
                    else { ProgressView().controlSize(.small) }
                    Text(progress.total > 0 ? "读取文件 · " + ByteCountFormatter.string(fromByteCount: Int64(progress.completed), countStyle: .file) + " / " + ByteCountFormatter.string(fromByteCount: Int64(progress.total), countStyle: .file) : "正在打开文件…").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                    Spacer()
                    Button("取消") { cancelFile() }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink)
                }.padding(.horizontal, 16)
            }
            if hasContent {
                if let question = model.detail["questions"].array.first {
                    QuestionDrawer(question: question, sessionId: id, total: model.detail["questions"].array.count, asker: engine)
                } else if let approval = model.detail["approvals"].array.first {
                    ApprovalDrawer(approval: approval, total: model.detail["approvals"].array.count)
                }
                if !model.detail["queue"].array.isEmpty { QueueChips(items: model.detail["queue"].array, sessionId: id) }
                ClearingDrawer(sessionId: id, engine: engine)
                if let handoff = PhoneHandoffs.returnable(model.openHandoffs, sessionId: id, status: summary["status"].string) { HandBackDrawer(handoff: handoff) }
            }
            let rebuiltInto = PhoneHistory.rebuiltFrom(model.snapshot["tasks"].array, taskId: id)
            let running = ["running", "waiting-approval"].contains(summary["status"].string ?? "")
            if let rebuiltInto, let target = rebuiltInto["id"].string {
                HStack(spacing: 8) {
                    Image(systemName: "clock.arrow.circlepath").font(.system(size: 13)).foregroundStyle(PhoneTheme.muted)
                    Text("已按文字重建为新会话").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2)
                    Spacer(minLength: 4)
                    Button("打开「\(rebuiltInto["title"].string ?? "未命名会话")」") { Task { await model.openSession(target) } }
                        .font(PhoneTheme.caption).lineLimit(1).buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(PhoneTheme.ink)
                }.padding(.horizontal, 16)
            } else if hasContent, PhoneHistory.seedWaiting(model.detail["summary"], messages: model.detail["messages"].array) {
                Label(PhoneHistory.seedWords(service: model.seedService(model.detail["summary"])), systemImage: "clock.arrow.circlepath")
                    .font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
            }
            if rebuiltInto == nil, model.lostSessions.contains(id), !running {
                // The Harness lost its own session: input stops here, as the web's stop row says.
                HStack(spacing: 8) {
                    Image(systemName: "shield").font(.system(size: 13)).foregroundStyle(PhoneTheme.muted)
                    Text(PhoneHistory.lostWords).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2)
                    Spacer(minLength: 4)
                    if PhoneHistory.offersRebuild(hasContent ? model.detail["summary"] : summary, lost: true, snapshot: model.snapshot) {
                        Button("按文字重建", systemImage: "clock.arrow.circlepath") { rebuilding = true }
                            .font(PhoneTheme.caption).buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(PhoneTheme.ink).disabled(!model.connected)
                    }
                }
                .padding(.leading, 16).padding(.trailing, 8).frame(minHeight: 52)
                .background(PhoneTheme.raised, in: Capsule()).overlay(Capsule().stroke(PhoneTheme.lineStrong))
                .padding(.horizontal, 12).padding(.bottom, 8)
            } else {
                // A stop needs no window, so it stays in reach while the content is closed.
                PromptComposer(draftId: id, placeholder: frame.map { PhoneAgentChat.placeholder($0.entry.name) }, gate: rebuiltInto != nil ? "已按文字重建为新会话 · 这个会话只能查看"
                    : hasContent || !model.connected ? inputReason : PromptComposer.closedWindow, engine: engine, person: frame != nil,
                    newTopic: frame.map { person in { prompt in
                        guard model.sessionId == id, hasContent, model.pending.isEmpty else { return }
                        let key = PhoneModel.topicTray(person.owner)
                        let held = model.takeDraft(for: key) ?? ""
                        model.holdDraft(PhonePending.joined(held, prompt), for: key)
                        person.newTopic()
                    } })
            }
        }.frame(maxWidth: 760).frame(maxWidth: .infinity)
    }
    /** This topic's proposals and the 「记住…」 the Host did not keep, each after its turn; none outside 我的 Agent. */
    private func placedProposals(_ turns: [PhoneTurn]) -> [String: [PhoneProposal]] {
        guard let frame, hasContent else { return [:] }
        return PhoneProposals.place((model.proposals[frame.owner] ?? []) + PhoneProposals.refusals(model.detail), sessionId: id,
            messages: model.detail["messages"].array, turnIds: turns.map(\.id))
    }
    private var effect: String { PhoneProposals.effectWords(model.engineInfo(summary["harnessId"].string)) }
    /** A memory proposal, or a schedule proposal with its own row and form. */
    @ViewBuilder private func proposalRow(_ proposal: PhoneProposal) -> some View {
        if proposal.schedule != nil { ScheduleProposalRow(owner: frame?.owner ?? "", proposal: proposal) }
        else { ProposalRow(owner: frame?.owner ?? "", proposal: proposal, effect: effect) }
    }
    /** This topic's result cards, each where its run settled; none outside 我的 Agent. */
    private func placedResults(_ turns: [PhoneTurn]) -> [String: [PhoneScheduleResult]] {
        guard frame != nil, hasContent else { return [:] }
        return PhoneResults.place(PhoneResults.parse(model.detail["results"]), turns: turns)
    }
    private func resultStack(_ results: [PhoneScheduleResult]) -> some View {
        ResultStack(results: results, openActivity: { frame?.openProfile() }, openRun: { frame?.openTopic($0) },
            openFile: { file, run in openFile(file.path, file.root, session: run) })
    }
    private var sessionFiles: [PhoneChangedFile] {
        guard hasContent else { return [] }
        var seen = Set<String>(), result: [PhoneChangedFile] = []
        for turn in PhoneConversation.turns(model.detail["messages"].array).reversed() {
            let outputs = turn.replies.flatMap { $0["outputs"].array }
            for file in PhoneConversation.summary(turn, outputs: outputs, scope: PhoneFileScope(model.detail["summary"])).files
                where !file.deleted && seen.insert(file.id).inserted { result.append(file) }
        }
        return result
    }
    private func cancelFile() {
        previewTask?.cancel(); previewTask = nil; previewRequest = nil; model.cancelPreview()
    }
    /** A file of this session, or of a run's (`session`) from a result card, under that session's file rules. */
    private func openFile(_ path: String, _ root: String?, session: String? = nil) {
        cancelFile()
        let selected = id, generation = model.contentGeneration, request = UUID()
        previewRequest = request
        previewTask = Task {
            defer { if previewRequest == request { previewTask = nil; previewRequest = nil } }
            do {
                let item = try await model.preview(reference: path, root: root, session: session)
                guard !Task.isCancelled, previewRequest == request, model.sessionId == selected, model.contentGeneration == generation, item.lease.valid else { PreviewFiles.discard(item); return }
                preview = item
            }
            catch { if !Task.isCancelled, previewRequest == request, model.contentGeneration == generation { model.previewFailed(error) } }
        }
    }
}

private struct HeaderTitle: View {
    let title: String
    let subtitle: (parts: [String], neverAsks: Bool)
    /** What a part of the line stands for in full (from where and how a session was brought in), for VoiceOver. */
    var detail: String? = nil
    @Environment(\.horizontalSizeClass) private var width
    private var line: Text {
        subtitle.parts.enumerated().reduce(Text("")) { text, entry in
            let part = Text((entry.offset > 0 ? " · " : "") + entry.element)
            return text + (subtitle.neverAsks && entry.element == PhoneConversation.tierTitles["never"] ? part.foregroundColor(PhoneTheme.amber) : part)
        }
    }
    var body: some View {
        // A toolbar item takes the width it is given, and without one it shrinks to a letter.
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(PhoneTheme.ink).lineLimit(1)
            line.font(.system(size: 12)).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                .accessibilityHint(detail ?? "")
        }.frame(width: width == .compact ? 236 : 420, alignment: .leading)
    }
}

/** What the run is really doing. While the phone cannot hear the Mac nothing here ticks: it says when it was last true. */
private struct RunStatusLine: View {
    @EnvironmentObject private var model: PhoneModel
    var person = false
    var body: some View {
        if !model.connected {
            Text(model.lastConfirmed.map { "上次确认 " + PhoneTime.message($0) } ?? "状态未更新").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
        } else {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                let status = person
                    ? PhoneHelperSpeech.status(model.detail, stopping: model.stoppingCurrent, engine: model.engineName(model.currentSummary["harnessId"].string), hostNow: model.hostNow())
                    : PhoneConversation.runStatus(model.detail, stopping: model.stoppingCurrent, engine: model.engineName(model.currentSummary["harnessId"].string), hostNow: model.hostNow())
                if status.tone != .quiet {
                    VStack(alignment: .leading, spacing: 8) {
                        (Text(status.text) + Text(status.clock.map { " · " + $0 } ?? "").monospacedDigit())
                            .font(PhoneTheme.caption).foregroundStyle(status.tone == .amber ? PhoneTheme.amber : PhoneTheme.muted)
                        if !status.actions.isEmpty {
                            HStack(spacing: 8) {
                                if status.actions.contains(.keepWaiting) { Button("继续等") { Task { await model.keepWaiting() } } }
                                if status.actions.contains(.stop) { Button("停止") { Task { await model.stop() } } }
                            }.buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(PhoneTheme.ink).disabled(model.busy)
                        }
                    }.accessibilityElement(children: .contain)
                }
            }
        }
    }
}

private struct RunEndView: View {
    let end: PhoneRunEnd
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(end.text).font(PhoneTheme.caption).foregroundStyle(end.failed ? PhoneTheme.red : PhoneTheme.amber)
            ForEach(end.unknown, id: \.self) { name in Text(name).font(.system(size: 12, design: .monospaced)).foregroundStyle(PhoneTheme.muted).lineLimit(1) }
        }
    }
}

private struct SessionFilesSheet: View {
    @Environment(\.dismiss) private var dismiss
    let files: [PhoneChangedFile]
    let open: (String, String?) -> Void
    var body: some View {
        NavigationStack {
            List(files) { file in
                Button { open(file.path, file.root) } label: { FileRowLabel(file: file) }
            }
            .listStyle(.plain)
            .navigationTitle("文件").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }.presentationDetents([.medium, .large])
    }
}

struct FileRowLabel: View {
    let file: PhoneChangedFile
    var body: some View {
        let parts = file.path.split(separator: "/").map(String.init)
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(parts.last ?? file.path).font(.system(size: 14)).foregroundStyle(file.deleted ? PhoneTheme.muted : PhoneTheme.ink).strikethrough(file.deleted).lineLimit(1)
                if parts.count > 1 { Text(parts.dropLast().joined(separator: "/")).font(.system(size: 12)).foregroundStyle(PhoneTheme.muted).lineLimit(1).truncationMode(.head) }
            }
            Spacer(minLength: 6)
            DiffStatText(add: file.add, del: file.del)
        }
    }
}

struct DiffStatText: View {
    let add: Int?
    let del: Int?
    var body: some View {
        if let add, let del {
            HStack(spacing: 4) {
                Text("+\(add)").foregroundStyle(PhoneTheme.green)
                Text("−\(del)").foregroundStyle(PhoneTheme.red)
            }.font(.system(size: 13).monospacedDigit())
        }
    }
}
