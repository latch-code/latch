import LatchNativeCore
import SwiftUI

/**
 * Under the new session's first message: 「接入已有会话」 where the project has a Harness that lists its sessions. A device
 * that may not see private sessions sees the same line locked, with where that is opened behind ⓘ.
 */
struct HistoryEntryRow: View {
    @EnvironmentObject private var model: PhoneModel
    let entry: PhoneHistoryEntry
    let open: () -> Void
    var body: some View {
        switch entry {
        case .hidden: EmptyView()
        case .locked:
            HStack(spacing: 6) {
                Image(systemName: "lock").font(.system(size: 12))
                Text(PhoneHistory.entryWords).font(PhoneTheme.caption)
                HintButton(label: "为什么不能接入", text: PhoneHistory.lockedWords(computer: model.selectedHost?.name ?? "Mac"))
                Spacer()
            }.foregroundStyle(PhoneTheme.faint).padding(.horizontal, 4)
        case .open:
            HStack {
                Button(action: open) { Label(PhoneHistory.entryWords, systemImage: "clock.arrow.circlepath").font(.system(size: 14, weight: .medium)) }
                    .buttonStyle(.plain).foregroundStyle(PhoneTheme.ink2).disabled(!model.connected)
                Spacer()
            }.padding(.horizontal, 4)
        }
    }
}

/** The project's sessions a Harness had before Latch, newest first; a row pushes a read-only preview of its last messages. */
struct HistoryImportView: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let project: NativeJSON
    let sources: [PhoneHistorySource]
    /** A session brought in now or before: open it. */
    let onOpen: (String) -> Void
    @State private var sourceId = ""
    @State private var list: PhoneHistoryList?
    @State private var refusal: NativeHostRefusal?
    @State private var failure: String?
    @State private var nonce = 0
    @State private var path: [PhoneHistoryRow] = []
    private var source: PhoneHistorySource { sources.first { $0.harnessId == sourceId } ?? sources[0] }
    var body: some View {
        NavigationStack(path: $path) {
            List {
                scope.listRowSeparator(.hidden).listRowBackground(Color.clear)
                content
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(PhoneTheme.canvas)
            .navigationTitle(PhoneHistory.entryWords).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭", systemImage: "xmark") { dismiss() }.labelStyle(.iconOnly) } }
            .navigationDestination(for: PhoneHistoryRow.self) { row in
                HistoryPreviewView(row: row, source: source, onOpen: onOpen, onExpired: { path = []; nonce += 1 })
            }
        }
        .onAppear {
            if sourceId.isEmpty { sourceId = sources[0].harnessId }
            #if LATCH_SCREENS
            if model.staged, ScreensStage.previewing, let row = ScreensStage.stagedRows.first { path = [row] }
            #endif
        }
        .task(id: "\(sourceId)\n\(nonce)") { await load() }
        // A closed window takes the content with it.
        .onChange(of: model.verifiedUntil) { _, value in if value == nil { dismiss() } }
    }
    private func load() async {
        guard !sourceId.isEmpty, let projectId = project["id"].string else { return }
        list = nil; refusal = nil; failure = nil
        do {
            let value = try await model.historyRead(PhoneHistory.listRead(projectId: projectId, harnessId: sourceId))
            guard !Task.isCancelled else { return }
            if let found = PhoneHistory.list(value) { list = found } else { failure = "没有读到会话" }
        } catch PhoneHistoryReadFailure.refused(let value) {
            if !Task.isCancelled { refusal = value }
        } catch PhoneHistoryReadFailure.failed(let words) {
            if !Task.isCancelled { failure = words }
        } catch { if !Task.isCancelled { failure = "没有读到会话" } }
    }
    /** Which project, and which Harness lists it: the scope of every row below. */
    private var scope: some View {
        HStack(spacing: 8) {
            Label(PhoneConversation.visible(project["name"].string ?? ""), systemImage: "folder").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2).lineLimit(1)
            if sources.count > 1 {
                Menu {
                    ForEach(sources) { item in
                        Button { sourceId = item.harnessId } label: {
                            if item.harnessId == source.harnessId { Label(item.label, systemImage: "checkmark") } else { Text(item.label) }
                        }
                    }
                } label: { harnessLabel(source).foregroundStyle(PhoneTheme.ink2) }
            } else { harnessLabel(source).foregroundStyle(PhoneTheme.ink2) }
            Spacer(minLength: 4)
            Text("主文件夹里的会话").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            HintButton(label: "列出哪些会话", text: PhoneHistory.scopeDetail(source.label))
        }
    }
    private func harnessLabel(_ item: PhoneHistorySource) -> some View {
        HStack(spacing: 5) {
            EngineTile(mark: item.mark, size: 16)
            Text(item.label).font(PhoneTheme.caption).lineLimit(1)
            if sources.count > 1 { Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .medium)).foregroundStyle(PhoneTheme.faint) }
        }
    }
    @ViewBuilder private var content: some View {
        switch PhoneHistory.listView(list, failure: refusal, error: failure) {
        case .loading:
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text("正在读取 \(source.label) 的会话…").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                .padding(.vertical, 12).listRowSeparator(.hidden).listRowBackground(Color.clear)
        case .notSupported:
            state("这个 Harness 不能列出已有会话", detail: "\(source.label) 没有声明列出与加载会话。", retry: false)
        case .login:
            let command = model.engineInfo(source.harnessId)["login"]["command"].string
            VStack(alignment: .leading, spacing: 10) {
                Text("\(source.label) 还没登录").font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink)
                Text(command == nil ? "按它自己的方式登录后重试。" : "在这台 Mac 的终端里运行这条命令，登录后重试。").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                if let command { Text(command).font(PhoneTheme.mono).textSelection(.enabled).foregroundStyle(PhoneTheme.ink2) }
                Button("重试", systemImage: "arrow.clockwise") { nonce += 1 }.buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(PhoneTheme.ink)
            }.padding(.vertical, 16).listRowSeparator(.hidden).listRowBackground(Color.clear)
        case let .failed(message):
            state("没有读到会话", detail: message, retry: true)
        case let .empty(others):
            Text("这个项目里没有 \(source.label) 会话").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.top, 32)
                .listRowSeparator(.hidden).listRowBackground(Color.clear)
            othersLine(others)
        case let .rows(rows, others, truncated):
            let primary = PhoneHistory.primaryName(project)
            ForEach(rows) { row in
                Button {
                    if let taskId = row.importedTaskId { onOpen(taskId) } else { path.append(row) }
                } label: { HistoryRowLabel(row: row, folder: PhoneHistory.folder(row, primary: primary)) }
                    .buttonStyle(.plain).listRowBackground(Color.clear)
            }
            if truncated { note("只读了最近的会话；更早的没有列出") }
            othersLine(others)
        }
    }
    @ViewBuilder private func othersLine(_ count: Int) -> some View {
        if let words = PhoneHistory.othersWords(count) { note(words) }
    }
    private func note(_ words: String) -> some View {
        Text(words).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).listRowSeparator(.hidden).listRowBackground(Color.clear)
    }
    private func state(_ title: String, detail: String, retry: Bool) -> some View {
        VStack(spacing: 8) {
            Text(title).font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink)
            Text(detail).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).multilineTextAlignment(.center)
            if retry { Button("重试", systemImage: "arrow.clockwise") { nonce += 1 }.buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(PhoneTheme.ink) }
        }.frame(maxWidth: .infinity).padding(.top, 32).listRowSeparator(.hidden).listRowBackground(Color.clear)
    }
}

private struct HistoryRowLabel: View {
    let row: PhoneHistoryRow
    let folder: String
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(row.title.isEmpty ? "未命名会话" : PhoneConversation.visible(row.title)).font(.system(size: 15)).foregroundStyle(PhoneTheme.ink).lineLimit(1)
            HStack(spacing: 8) {
                if row.importedTaskId != nil {
                    Label("已接入", systemImage: "checkmark").labelStyle(TightLabel()).foregroundStyle(PhoneTheme.accent)
                }
                Text(PhoneConversation.visible(folder)).font(.system(size: 12, design: .monospaced)).lineLimit(1).truncationMode(.head)
                if let at = PhoneTime.parse(.string(row.updatedAt ?? "")) { Text(PhoneTime.relative(at)) }
            }.font(.system(size: 12)).foregroundStyle(PhoneTheme.muted)
        }.padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }
}

/** One explicit load of the session, read-only: words as the Host gave them, tools by title and state alone. */
struct HistoryPreviewView: View {
    @EnvironmentObject private var model: PhoneModel
    let row: PhoneHistoryRow
    let source: PhoneHistorySource
    let onOpen: (String) -> Void
    let onExpired: () -> Void
    @State private var preview: PhoneHistoryPreview?
    @State private var failure: PhoneHistoryFailure?
    @State private var nonce = 0
    @State private var targetId: String?
    @State private var importing = false
    /** How the last 接入 ended when it did not open a session. */
    @State private var result: ImportResultLine?
    /** Brought in: the Host closed the preview itself. */
    @State private var imported = false
    private var targets: [PhoneImportTarget] { PhoneHistory.targets(model.snapshot["catalog"], sourceId: source.harnessId) }
    private var target: PhoneImportTarget? { targets.first { $0.harnessId == (targetId ?? source.harnessId) } ?? targets.first }
    var body: some View {
        Group {
            if let preview { messages(preview) }
            else if let failure { failed(failure) }
            else {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("\(source.label) 正在打开这个会话…").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(PhoneTheme.canvas)
        .navigationTitle(row.title.isEmpty ? "未命名会话" : PhoneConversation.visible(row.title)).navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom, spacing: 0) { if let preview { footer(preview) } }
        .task(id: nonce) {
            await load()
            #if LATCH_SCREENS
            if model.staged { targetId = ScreensStage.rebuildTarget; if ScreensStage.importUnknown { result = .unknown(nil) } }
            #endif
        }
        .onDisappear { close() }
    }
    private func load() async {
        close()
        preview = nil; failure = nil; result = nil
        do {
            let value = try await model.historyRead(PhoneHistory.previewRead(handle: row.handle))
            guard let found = PhoneHistory.preview(value) else { failure = .failed("没有打开这个会话"); return }
            // Left before it came: the Host still holds it open, so let it go now.
            if Task.isCancelled { model.closeHistoryPreview(found.previewId); return }
            preview = found
        } catch PhoneHistoryReadFailure.refused(let refusal) {
            guard !Task.isCancelled else { return }
            let reading = PhoneHistory.previewFailure(refusal)
            if reading == .expired { onExpired() } else { failure = reading }
        } catch PhoneHistoryReadFailure.failed(let words) {
            if !Task.isCancelled { failure = .failed(words) }
        } catch { if !Task.isCancelled { failure = .failed("没有打开这个会话") } }
    }
    /** Leaving: the Host closed it itself after an import; one an unanswered import names stays (the closer holds it). */
    private func close() {
        if let id = preview?.previewId, !imported { model.closeHistoryPreview(id) }
    }
    private var unknown: Bool { if case .unknown = result { true } else { false } }
    private var unanswered: NativePendingWrite? {
        preview.flatMap { preview in model.pending.first { PhoneHistory.isImport($0) && PhoneHistoryCloser.held(preview.previewId, by: [$0]) } }
    }
    private func messages(_ preview: PhoneHistoryPreview) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 8) {
                    if !preview.meta.isEmpty { Text(preview.meta).foregroundStyle(PhoneTheme.muted) }
                    Spacer(minLength: 4)
                    Label(PhoneHistory.hiddenWords, systemImage: "eye.slash").labelStyle(TightLabel()).foregroundStyle(PhoneTheme.muted)
                    HintButton(label: "预览里有什么", text: PhoneHistory.previewDetail(count: preview.messages.count, source: source.label))
                }.font(PhoneTheme.caption)
                if preview.truncated { Text("更早的消息没有显示").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                ForEach(Array(preview.messages.enumerated()), id: \.offset) { _, message in PreviewMessageView(message: message) }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity)
        }.defaultScrollAnchor(.bottom)
    }
    @ViewBuilder private func failed(_ failure: PhoneHistoryFailure) -> some View {
        VStack(spacing: 10) {
            switch failure {
            case .busy:
                Image(systemName: "exclamationmark.triangle").font(.system(size: 22)).foregroundStyle(PhoneTheme.amberIcon)
                Text(PhoneHistory.busyWords).font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink)
                Text(PhoneHistory.busyDetail(source.label)).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).multilineTextAlignment(.center)
                Button("再看一次", systemImage: "arrow.clockwise") { nonce += 1 }.buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(PhoneTheme.ink)
            case .expired, .failed:
                Text("没有打开这个会话").font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink)
                if case let .failed(words) = failure { Text(words).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).multilineTextAlignment(.center) }
                Button("重试", systemImage: "arrow.clockwise") { nonce += 1 }.buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(PhoneTheme.ink)
            }
        }.padding(.horizontal, 32).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private func footer(_ preview: PhoneHistoryPreview) -> some View {
        return VStack(alignment: .leading, spacing: 10) {
            // While an answer is unknown the same request goes again, for the same Harness; the core keeps one at a time.
            ImportTargetChoice(targets: targets, target: target, sourceLabel: source.label, disabled: importing || unknown) { targetId = $0; result = nil }
            HStack(spacing: 10) {
                if let result { result.view }
                Spacer(minLength: 0)
                if unknown, let write = unanswered {
                    Button("核对并放下") { Task { await check(write) } }.font(PhoneTheme.caption).disabled(importing || model.busy || !model.connected)
                }
                if result == .expired {
                    Button("重新打开", systemImage: "arrow.clockwise") { onExpired() }.primaryCapsule()
                } else {
                    Button { Task { await send(preview.previewId) } } label: {
                        HStack(spacing: 6) {
                            if importing { ProgressView().controlSize(.small).tint(.white) }
                            Text(importing ? "正在接入" : unknown ? "重试" : "接入")
                        }
                    }.primaryCapsule().disabled(importing || target == nil || !model.connected)
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(PhoneTheme.canvas.overlay(alignment: .top) { Divider().overlay(PhoneTheme.line) })
    }
    private func send(_ previewId: String) async {
        guard let target else { return }
        let write: NativePendingWrite
        if let again = PhoneHistory.attempt(model.pending, source: previewId, harnessId: target.harnessId) { write = again }
        else {
            guard let fresh = try? PhoneHistory.importWrite(previewId: previewId, harnessId: target.harnessId) else { return }
            write = fresh
        }
        importing = true; result = nil
        let (outcome, retry) = await model.importHistory(write)
        importing = false
        switch outcome {
        case let .done(value):
            guard let taskId = PhoneHistory.importedTask(value) else { result = .failed("没有接入"); return }
            // The Host closed the preview as it brought the session in.
            imported = true; onOpen(taskId)
        case let .refused(refusal):
            // The write is gone, so leaving this page closes the preview (brought in by another request, or refused).
            switch PhoneHistory.outcome(refusal, retry: retry) {
            case let .open(taskId): onOpen(taskId)
            case .notDone: result = .failed(PhoneHistory.notDoneWords)
            case .deletedSince: result = .failed(PhoneHistory.deletedSinceWords)
            case .busy: result = .failed(PhoneHistory.busyWords)
            case .expired: result = .expired
            case let .failed(words): result = .failed(words)
            }
        case let .unknown(refusal): result = .unknown(refusal?.message)
        case let .failed(error): result = .failed(error.localizedDescription)
        }
    }
    /** 核对并放下: the Host's receipt says whether the unanswered import happened. */
    private func check(_ write: NativePendingWrite) async {
        let (words, taskId) = await model.checkImport(write, release: false)
        guard let words else { result = .unknown("没能核对，稍后再试"); return }
        // Brought in: opened once the cover has gone, as an import is.
        if let taskId { imported = true; result = nil; onOpen(taskId) }
        else if words == PhoneHistory.notDoneWords { result = .failed(words) }
        else { result = .unknown(words) }
    }
}

/** How an import that opened nothing ended: unknown in amber, refused in red, both with words. */
enum ImportResultLine: Equatable {
    /** With the Host's words when a retry was refused without settling it. */
    case unknown(String?)
    case expired
    case failed(String)
    @ViewBuilder var view: some View {
        switch self {
        case let .unknown(words):
            Label(words.map { "结果未确认 · " + $0 } ?? "结果未确认", systemImage: "questionmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).lineLimit(2)
        case .expired: Text("预览已过期，请重新打开").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.red)
        case let .failed(words): Text(words).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.red).lineLimit(2)
        }
    }
}

private struct PreviewMessageView: View {
    let message: PhoneHistoryMessage
    var body: some View {
        switch message.role {
        case .tool:
            VStack(alignment: .leading, spacing: 2) {
                Text(PhoneConversation.visible(message.text)).font(.system(size: 13, design: .monospaced)).foregroundStyle(PhoneTheme.muted).lineLimit(2)
                Text(message.toolWords).font(.system(size: 12)).foregroundStyle(PhoneTheme.faint)
            }
        case .user:
            Text(PhoneConversation.visible(message.text) + (message.clipped ? " …" : "")).font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink)
                .padding(.horizontal, 14).padding(.vertical, 9).background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 18))
                .frame(maxWidth: .infinity, alignment: .trailing)
        case .assistant:
            Text(PhoneConversation.visible(message.text) + (message.clipped ? " …" : "")).font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/**
 * 继续用: the Harness the session continues in, and what that means. The source itself continues it as it was; any other
 * is a text rebuild, said in amber at once.
 */
struct ImportTargetChoice: View {
    let targets: [PhoneImportTarget]
    let target: PhoneImportTarget?
    let sourceLabel: String
    let disabled: Bool
    let change: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("继续用").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                if targets.count > 1 {
                    Menu {
                        ForEach(targets) { item in
                            Button { change(item.harnessId) } label: {
                                let words = item.mode == .text ? item.label + " · 按文字重建" : item.label
                                if item.harnessId == target?.harnessId { Label(words, systemImage: "checkmark") } else { Text(words) }
                            }
                        }
                    } label: { chosen(chevron: true) }.disabled(disabled).accessibilityLabel("继续用")
                } else { chosen(chevron: false) }
            }
            if let target {
                HStack(spacing: 5) {
                    if target.mode == .text {
                        Label(PhoneHistory.rebuildWords, systemImage: "exclamationmark.triangle").labelStyle(TightLabel()).foregroundStyle(PhoneTheme.amber)
                        HintButton(label: "按文字重建是什么", text: PhoneHistory.modeDetail(target, source: sourceLabel))
                    } else {
                        Label("原样接入", systemImage: "clock.arrow.circlepath").labelStyle(TightLabel()).foregroundStyle(PhoneTheme.muted)
                        HintButton(label: "原样接入是什么", text: PhoneHistory.modeDetail(target, source: sourceLabel))
                    }
                }.font(PhoneTheme.caption)
            }
        }
    }
    private func chosen(chevron: Bool) -> some View {
        HStack(spacing: 5) {
            EngineTile(mark: target?.mark, size: 16)
            Text(target?.label ?? "").font(.system(size: 14, weight: .medium)).foregroundStyle(PhoneTheme.ink)
            if chevron { Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .medium)).foregroundStyle(PhoneTheme.faint) }
        }
    }
}

extension View {
    /** The surface's one blue action, 44 high. */
    func primaryCapsule() -> some View {
        buttonStyle(.borderedProminent).buttonBorderShape(.capsule).controlSize(.large).tint(PhoneTheme.accent)
    }
}

/**
 * 按文字重建 a session brought in as it was whose Harness lost it: the same 继续用 (its own Harness first) and one request
 * (`fromTaskId`) whose retry reuses its request ID. The new session waits for the first message, as an import does.
 */
struct RebuildLostSheet: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let summary: NativeJSON
    @State private var targetId: String?
    @State private var sending = false
    @State private var result: ImportResultLine?
    private var targets: [PhoneImportTarget] { PhoneHistory.rebuildTargets(model.snapshot["catalog"], ownId: summary["harnessId"].string) }
    private var target: PhoneImportTarget? { targets.first { $0.harnessId == targetId } ?? targets.first }
    private var sourceLabel: String {
        let from = summary["imported"]["from"].string
        let info = model.engineInfo(from)
        return info != .null ? PhoneStart.engineName(info) : from ?? "Harness"
    }
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Label("从「\(PhoneConversation.visible(summary["title"].string ?? "未命名会话"))」的对话文字开始一个新会话；这个会话留着，只能查看。", systemImage: "clock.arrow.circlepath")
                    .font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2).fixedSize(horizontal: false, vertical: true)
                if target != nil {
                    ImportTargetChoice(targets: targets, target: target, sourceLabel: sourceLabel, disabled: sending || isUnknown) { targetId = $0; result = nil }
                } else {
                    Text("没有能按文字重建的 Harness").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.red)
                }
                HStack(spacing: 10) {
                    if let result { result.view }
                    Spacer(minLength: 0)
                    Button { Task { await send() } } label: {
                        HStack(spacing: 6) {
                            if sending { ProgressView().controlSize(.small).tint(.white) }
                            Text(sending ? "正在重建" : isUnknown ? "重试" : "按文字重建")
                        }
                    }.primaryCapsule().disabled(sending || target == nil || !model.connected)
                }
            }
            .padding(16)
            .frame(maxHeight: .infinity, alignment: .top)
            .navigationTitle("按文字重建").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭", systemImage: "xmark") { dismiss() }.labelStyle(.iconOnly).disabled(sending) } }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(sending)
    }
    private func send() async {
        guard let target, let id = summary["id"].string else { return }
        let write: NativePendingWrite
        if let again = PhoneHistory.attempt(model.pending, source: id, harnessId: target.harnessId) { write = again }
        else {
            guard let fresh = try? PhoneHistory.rebuildWrite(fromTaskId: id, harnessId: target.harnessId) else { return }
            write = fresh
        }
        sending = true; result = nil
        let (outcome, retry) = await model.importHistory(write)
        sending = false
        switch outcome {
        case let .done(value):
            guard let taskId = PhoneHistory.importedTask(value) else { result = .failed("没有重建"); return }
            model.openAfterDismiss = taskId; dismiss()
        case let .refused(refusal):
            switch PhoneHistory.outcome(refusal, retry: retry) {
            case let .open(taskId): model.openAfterDismiss = taskId; dismiss()
            case .notDone: result = .failed(PhoneHistory.notDoneWords)
            case .deletedSince: result = .failed(PhoneHistory.deletedSinceWords)
            case .busy, .expired: result = .failed("这个会话现在不能重建")
            case let .failed(words): result = .failed(words)
            }
        case let .unknown(refusal): result = .unknown(refusal?.message)
        case let .failed(error): result = .failed(error.localizedDescription)
        }
    }
    private var isUnknown: Bool { if case .unknown = result { true } else { false } }
}
