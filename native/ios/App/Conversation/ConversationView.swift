import LatchNativeCore
import SwiftUI

struct ConversationView: View {
    @EnvironmentObject private var model: PhoneModel
    let id: String
    /** Set where the navigation has no back of its own. */
    var back: (() -> Void)? = nil
    @State private var preview: PreviewItem?
    @State private var previewTask: Task<Void, Never>?
    @State private var previewRequest: UUID?
    /** What the 文件 sheet lists, counted when it is asked for: the counts take a diff of every edit in the session. */
    @State private var fileList: [PhoneChangedFile]?
    @Environment(\.horizontalSizeClass) private var width
    @AppStorage(PhoneFaceID.key) private var faceID = false
    private var summary: NativeJSON { model.currentSummary }
    private var engine: String { model.engineName(summary["harnessId"].string) }
    private var hasContent: Bool { model.detail["summary"]["id"].string == id }
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
        .onChange(of: model.verifiedUntil) { _, value in if value == nil { preview = nil } }
        .onChange(of: model.contentGeneration) { _, _ in preview = nil; cancelFile() }
        .onDisappear { cancelFile(); preview = nil; PreviewFiles.clear() }
    }
    @ToolbarContentBuilder private var header: some ToolbarContent {
        if let back { ToolbarItem(placement: .topBarLeading) { Button("返回", systemImage: "chevron.left", action: back).labelStyle(.iconOnly) } }
        if #available(iOS 26, *) {
            ToolbarItem(placement: .topBarLeading) { title }.sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { title }
        }
        if hasContent && PhoneConversation.hasFiles(model.detail) {
            ToolbarItem(placement: .topBarTrailing) { Button("文件", systemImage: "folder") { fileList = sessionFiles }.labelStyle(.iconOnly) }
        }
    }
    private var title: some View {
        HeaderTitle(title: model.detail["summary"]["title"].string ?? summary["title"].string ?? "会话",
            subtitle: hasContent ? PhoneConversation.subtitle(model.detail, engine: engine) : ([engine], false))
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
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                ForEach(Array(turns.enumerated()), id: \.element.id) { index, turn in
                    let latest = index == turns.count - 1
                    TurnView(turn: turn, latest: latest, status: latest ? status : nil, running: latest && running, frozen: !model.connected,
                        delivery: latest && running ? PhoneConversation.delivery(model.detail, turn: turn) : nil, switched: switches[turn.id],
                        mark: model.engineMark(summary["harnessId"].string), engine: engine,
                        endSaid: latest && !running && PhoneConversation.runEnd(model.detail["summary"], engine: engine) != nil, open: openFile).equatable()
                }
                if running { RunStatusLine().id("status") }
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
                    QuestionDrawer(question: question, sessionId: id, total: model.detail["questions"].array.count)
                } else if let approval = model.detail["approvals"].array.first {
                    ApprovalDrawer(approval: approval, total: model.detail["approvals"].array.count)
                }
                if !model.detail["queue"].array.isEmpty { QueueChips(items: model.detail["queue"].array, sessionId: id) }
                if let cleared = PhoneConversation.clearedNote(model.detail, engine: engine) {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "eraser").font(.system(size: 14)).foregroundStyle(PhoneTheme.muted)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(cleared.title).font(.system(size: 14, weight: .medium)).foregroundStyle(PhoneTheme.ink)
                            Text(cleared.line).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                        }
                        Spacer(minLength: 0)
                    }.padding(.horizontal, 16).accessibilityElement(children: .combine)
                }
            }
            if summary["personal"]["groupId"].string == nil && model.groupId == nil {
                // A stop needs no window, so it stays in reach while the content is closed.
                PromptComposer(draftId: id, gate: hasContent || !model.connected ? PhoneConversation.inputGate(summary: summary, permission: model.detail["permission"], canRun: model.canRun, connected: model.connected) : PromptComposer.closedWindow, engine: engine)
            }
        }.frame(maxWidth: 760).frame(maxWidth: .infinity)
    }
    private var sessionFiles: [PhoneChangedFile] {
        guard hasContent else { return [] }
        var seen = Set<String>(), result: [PhoneChangedFile] = []
        for turn in PhoneConversation.turns(model.detail["messages"].array).reversed() {
            let outputs = turn.replies.flatMap { $0["outputs"].array }
            for file in PhoneConversation.summary(turn, outputs: outputs).files where !file.deleted && seen.insert(file.path).inserted { result.append(file) }
        }
        return result
    }
    private func cancelFile() {
        previewTask?.cancel(); previewTask = nil; previewRequest = nil; model.cancelPreview()
    }
    private func openFile(_ path: String, _ root: String?) {
        cancelFile()
        let selected = id, generation = model.contentGeneration, request = UUID()
        previewRequest = request
        previewTask = Task {
            defer { if previewRequest == request { previewTask = nil; previewRequest = nil } }
            do {
                let item = try await model.preview(reference: path, root: root)
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
        }.frame(width: width == .compact ? 236 : 420, alignment: .leading)
    }
}

/** What the run is really doing. While the phone cannot hear the Mac nothing here ticks: it says when it was last true. */
private struct RunStatusLine: View {
    @EnvironmentObject private var model: PhoneModel
    var body: some View {
        if !model.connected {
            Text(model.lastConfirmed.map { "上次确认 " + PhoneTime.message($0) } ?? "状态未更新").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
        } else {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                let status = PhoneConversation.runStatus(model.detail, stopping: model.stoppingCurrent, engine: model.engineName(model.currentSummary["harnessId"].string), hostNow: model.hostNow())
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
            List(files, id: \.path) { file in
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
