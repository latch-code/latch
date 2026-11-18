import LatchNativeCore
import SwiftUI

/** The review page's reads: the scope's list, the file shown, and the session's notes. Content: it lives with the window. */
@MainActor final class ReviewStore: ObservableObject {
    @Published var list: NativeJSON?
    @Published var listFailure: String?
    @Published var denied = false
    @Published var current: String? {
        didSet { if oldValue != current { lines = nil; fileFailure = nil; fileAsked += 1 } }
    }
    @Published var lines: [PhoneReviewLine]?
    @Published var fileFailure: String?
    @Published var notes: [PhoneReviewNote]?
    @Published var noteList = NativeJSON.null
    @Published var notesFailure: String?
    @Published var error: String?
    private var asked = 0, fileAsked = 0, notesAsked = 0
    private var displayedScope: PhoneReviewScope?
    var files: [NativeJSON] { list.map(PhoneReview.files) ?? [] }
    static func key(_ file: NativeJSON) -> String { (file["root"].string ?? "") + "\n" + (file["path"].string ?? "") }

    func load(_ model: PhoneModel, target: PhoneReviewTarget) async {
        asked += 1; let mine = asked
        if displayedScope != target.scope {
            list = nil; lines = nil; current = nil; listFailure = nil
            displayedScope = target.scope
        }
        do {
            let value = try await model.reviewRead(try PhoneReview.listPath(target.sessionId, scope: target.scope, turnId: target.turnId),
                work: target.work)
            guard mine == asked, !Task.isCancelled else { return }
            if let turn = target.turnId, !turn.utf8.elementsEqual((value["turnId"].string ?? "").utf8) {
                throw PhoneWorkReadFailure.versionChanged
            }
            guard model.publishReview(target.work, {
                list = value; listFailure = nil; denied = false
                let files = PhoneReview.files(value)
                if let wanted = target.file, let found = files.first(where: { $0["path"].string == wanted }) { current = Self.key(found) }
                else if !files.contains(where: { Self.key($0) == current }) { current = files.first.map(Self.key) }
            }) else { return }
            await readFile(model, target: target)
        } catch {
            guard mine == asked, !Task.isCancelled, !(error is CancellationError) else { return }
            if (error as? PhoneWorkReadFailure) == .versionChanged {
                list = nil; current = nil; listFailure = "这轮没有可读取的改动记录"
                return
            }
            if (error as? NativeFailure) == .forbidden { denied = true; list = nil }
            else if list == nil { listFailure = (error as? NativeFailure)?.errorDescription ?? "暂时无法完成，请稍后重试。" }
            else { listFailure = "没有刷新成功 · 这是上次的列表" }
        }
    }
    func readFile(_ model: PhoneModel, target: PhoneReviewTarget) async {
        fileAsked += 1; let mine = fileAsked
        guard let file = files.first(where: { Self.key($0) == current }), !PhoneReview.contentHidden(file), let root = file["root"].string,
              let path = file["path"].string else { lines = nil; fileFailure = nil; return }
        do {
            let key = Self.key(file)
            let value = try await model.reviewRead(try PhoneReview.filePath(target.sessionId, scope: target.scope, turnId: list?["turnId"].string, root: root, path: path),
                work: target.work)
            guard mine == fileAsked, key == current, !Task.isCancelled else { return }
            let next = PhoneReview.lines(value)
            model.publishReview(target.work) { lines = next; fileFailure = nil }
        } catch {
            guard mine == fileAsked, !Task.isCancelled, !(error is CancellationError) else { return }
            lines = nil
            // A whole file past one response never arrives here: the Mac shows it.
            fileFailure = (error as? NativeFailure) == .invalidRecord ? "文件太大，到 Mac 上看" : "读不到这个文件"
        }
    }
    func loadNotes(_ model: PhoneModel, sessionId: String, work: PhoneWorkReadStamp? = nil) async {
        guard model.snapshot["catalog"]["features"]["reviewNotes"].bool, model.snapshot["device"]["dataScope"].string == "all" else { return }
        notesAsked += 1; let mine = notesAsked
        do {
            let value = try await model.reviewRead(try PhoneReview.notesPath(sessionId), work: work)
            guard mine == notesAsked, !Task.isCancelled else { return }
            let next = PhoneReview.notes(value)
            guard model.publishReview(work, {
                noteList = value; notes = next; notesFailure = nil
            }) else { return }
            // A send this device has no answer for, now held open (or done) on the Host: the Host answers it from here on.
            for write in model.pending where PhoneReview.heldByHost(write, list: value, sessionId: sessionId) { await model.settle(write) }
        } catch { if mine == notesAsked && !Task.isCancelled && !(error is CancellationError) { notesFailure = (error as? NativeFailure)?.errorDescription ?? "读不到反馈" } }
    }
}

/** The phone's review of a session, pushed from a row's 「复核 N 处改动」: one file at a time, line notes, and 提交 over it. */
struct ReviewView: View {
    @EnvironmentObject private var model: PhoneModel
    @StateObject private var store = ReviewStore()
    @State var target: PhoneReviewTarget
    @State private var selection: PhoneLineSelection?
    @State private var writing = false
    @State private var noteText = ""
    @State private var delivering = false
    @State private var expanded: Set<Int> = []
    @State private var askClear = false
    @State private var showFiles = false
    @State private var hideFiles = false
    @Environment(\.dynamicTypeSize) private var textSize
    private var summary: NativeJSON { model.summary(of: target.sessionId) }
    private var canRead: Bool {
        guard model.hasScope("view"), PhoneWorkItems.canReadFiles(model.snapshot) else { return false }
        guard target.taskReview else { return true }
        guard let itemId = model.workItemId, let work = target.work, model.workStamp(itemId) == work else { return false }
        return model.workDestinationAllowed(.review(session: target.sessionId, turn: target.turnId), itemId: itemId)
    }
    private var running: Bool { ["running", "waiting-approval"].contains(summary["status"].string ?? "") }
    private var canWrite: Bool { model.canRun && model.connected && summary["personal"] == .null && model.snapshot["catalog"]["features"]["reviewNotes"].bool && canRead && model.snapshot["device"]["dataScope"].string == "all" }
    private var file: NativeJSON? { store.files.first { ReviewStore.key($0) == store.current } }
    private var index: Int { store.files.firstIndex { ReviewStore.key($0) == store.current } ?? 0 }
    private var notes: [PhoneReviewNote] { store.notes ?? [] }
    private var fileNotes: [PhoneReviewNote] { file.map { f in notes.filter { $0.same(root: f["root"].string ?? "", path: f["path"].string ?? "") } } ?? [] }
    private var revision: UInt64 { PhoneReview.counts(model.snapshot, target.sessionId)["revision"].integer ?? 0 }

    var body: some View {
        GeometryReader { area in
            let column = PhoneReview.fileColumnWidth(detail: Double(area.size.width), accessibility: textSize.isAccessibilitySize).map { CGFloat($0) }
            reviewLayout(fileColumn: column)
        }
        .background(PhoneTheme.canvas)
        .navigationTitle(target.turnId != nil ? "本轮改动" : "改动").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(target.turnId != nil ? "本轮改动" : "改动").font(.headline)
                    Text(PhoneConversation.visible(summary["title"].string ?? "未命名会话"))
                        .font(.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                }
            }
            if canRead, let totals = store.list?["totals"], store.list?["unavailable"] == .null, !store.files.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 4) {
                        Text("+\(totals["add"].integer ?? 0)").foregroundStyle(PhoneTheme.green)
                        Text("−\(totals["del"].integer ?? 0)").foregroundStyle(PhoneTheme.red)
                    }.font(.caption.monospacedDigit())
                }
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .safeAreaInset(edge: .bottom, spacing: 0) { if !target.taskReview || canRead { foot } }
        .navigationDestination(isPresented: $delivering) {
            DeliveryView(sessionId: target.sessionId) { path in target.file = path; target.scope = .uncommitted; delivering = false; Task { await store.load(model, target: target) } }
        }
        .sheet(isPresented: Binding(get: { writing && selection != nil && canRead }, set: { if !$0 { writing = false } })) {
            if canRead { noteSheet }
        }
        .sheet(isPresented: Binding(get: { showFiles && canRead }, set: { showFiles = $0 })) {
            if canRead {
                NavigationStack {
                    fileList { showFiles = false }
                        .navigationTitle("改动文件").navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { showFiles = false } } }
                }.presentationDetents([.medium, .large])
            }
        }
        .confirmationDialog("清空待发反馈", isPresented: $askClear, titleVisibility: .visible) {
            Button("清空", role: .destructive) { Task { for id in PhoneReview.tally(notes).ready { await making(try PhoneReview.remove(sessionId: target.sessionId, noteId: id)) } } }
            Button("取消", role: .cancel) {}
        } message: { Text("这些反馈还没有发出，清空后不能恢复。") }
        .task(id: target.scope) {
            selection = nil; expanded = []; await store.load(model, target: target)
            #if LATCH_SCREENS
            if model.staged { try? await Task.sleep(for: .milliseconds(300)); selection = ScreensStage.reviewSelection; delivering = ScreensStage.delivering }
            #endif
        }
        .task(id: revision) { await store.loadNotes(model, sessionId: target.sessionId, work: target.work) }
        .onChange(of: running) { _, isRunning in
            if !isRunning {
                Task {
                    await store.load(model, target: target)
                    await store.loadNotes(model, sessionId: target.sessionId, work: target.work)
                }
            }
        }
        .onChange(of: store.current) { _, _ in selection = nil; expanded = []; Task { await store.readFile(model, target: target) } }
        .onAppear {
            model.markSeen(target.sessionId)
            #if LATCH_SCREENS
            #endif
        }
        .onChange(of: model.summary(of: target.sessionId)["updatedAt"].string) { _, _ in model.markSeen(target.sessionId) }
        .onChange(of: model.privateSnapshot.epoch) { _, _ in showFiles = false; writing = false; noteText = ""; selection = nil }
    }

    private func reviewLayout(fileColumn: CGFloat?) -> some View {
        VStack(spacing: 0) {
            if canRead && target.turnId == nil {
                Group {
                    if textSize.isAccessibilitySize { scopePicker.pickerStyle(.menu) }
                    else { scopePicker.pickerStyle(.segmented) }
                }.padding(.horizontal, 16).padding(.vertical, 8)
            }
            HStack(spacing: 0) {
                if let fileColumn, canRead && !hideFiles && !store.files.isEmpty {
                    fileList {}.frame(width: fileColumn)
                    Rectangle().fill(PhoneTheme.line).frame(width: 1)
                }
                VStack(spacing: 0) {
                    if canRead, file != nil { pager(canTile: fileColumn != nil) }
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            if canRead, let file { fileHeading(file) }
                            content.padding(.horizontal, 12).padding(.bottom, 16)
                        }
                    }.background(PhoneTheme.canvas)
                        .refreshable { await store.load(model, target: target) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var scopePicker: some View {
        Picker("改动范围", selection: $target.scope) {
            ForEach(PhoneReviewScope.allCases, id: \.self) { Text($0.label).tag($0) }
        }
    }
    private func fileList(_ chosen: @escaping () -> Void) -> some View {
        List {
            ForEach(store.files.indices, id: \.self) { index in
                let file = store.files[index], key = ReviewStore.key(file), path = file["path"].string ?? ""
                Button { store.current = key; chosen() } label: {
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(PhoneConversation.visible(path.split(separator: "/").last.map(String.init) ?? path))
                                .font(.subheadline.weight(key == store.current ? .semibold : .regular))
                            if let slash = path.lastIndex(of: "/") {
                                Text(PhoneConversation.visible(String(path[..<slash]))).font(.caption).foregroundStyle(PhoneTheme.muted)
                            }
                        }
                        Spacer(minLength: 4)
                        let count = notes.filter { $0.same(root: file["root"].string ?? "", path: path) }.count
                        if count > 0 {
                            Label("\(count)", systemImage: "text.bubble").labelStyle(TightLabel()).font(.caption).foregroundStyle(PhoneTheme.muted)
                        }
                    }.foregroundStyle(PhoneTheme.ink).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityAddTraits(key == store.current ? .isSelected : [])
                .listRowBackground(key == store.current ? PhoneTheme.line.opacity(0.65) : Color.clear)
            }
        }.listStyle(.plain).scrollContentBackground(.hidden).background(PhoneTheme.sunken)
    }

    private func pager(canTile: Bool) -> some View {
        HStack(spacing: 4) {
            Button { step(-1) } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }
                .disabled(index == 0).accessibilityLabel("上一个文件")
            Text("\(index + 1) / \(store.files.count)").font(.caption.monospacedDigit()).foregroundStyle(PhoneTheme.muted)
            Button { step(1) } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44) }
                .disabled(index >= store.files.count - 1).accessibilityLabel("下一个文件")
            Spacer(minLength: 0)
            if !canTile || hideFiles {
                Button { showFiles = true } label: { Image(systemName: "list.bullet").frame(width: 44, height: 44) }
                    .accessibilityLabel("选改动文件")
            }
            if canTile {
                Button { hideFiles.toggle() } label: { Image(systemName: "sidebar.left").frame(width: 44, height: 44) }
                    .accessibilityLabel(hideFiles ? "显示文件栏" : "隐藏文件栏")
            }
        }.padding(.horizontal, 8).tint(PhoneTheme.ink).background(PhoneTheme.sunken)
    }

    private func fileHeading(_ file: NativeJSON) -> some View {
        let path = file["path"].string ?? ""
        let folder = path.lastIndex(of: "/").map { String(path[..<$0]) } ?? ""
        let stale = store.lines.map { lines in PhoneReview.place(fileNotes, old: PhoneReview.textLines(lines, side: .old), new: PhoneReview.textLines(lines, side: .new)).stale.count } ?? 0
        return VStack(alignment: .leading, spacing: 4) {
            Text(PhoneConversation.visible(path.split(separator: "/").last.map(String.init) ?? path)).font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            if !folder.isEmpty {
                Text(PhoneConversation.visible(folder)).font(.caption).foregroundStyle(PhoneTheme.muted)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { fileFacts(file) }.fixedSize(horizontal: true, vertical: false)
                VStack(alignment: .leading, spacing: 4) { fileFacts(file) }
            }.font(.caption).foregroundStyle(PhoneTheme.muted)
            if stale > 0 { staleWarning }
        }.padding(.horizontal, 16).padding(.bottom, 10).frame(maxWidth: .infinity, alignment: .leading)
            .background(PhoneTheme.sunken)
    }

    @ViewBuilder private func fileFacts(_ file: NativeJSON) -> some View {
        if let note = PhoneReview.fileNote(file) { Text(note) }
        if let add = file["add"].integer, add > 0 { Text("+\(add)").foregroundStyle(PhoneTheme.green) }
        if let del = file["del"].integer, del > 0 { Text("−\(del)").foregroundStyle(PhoneTheme.red) }
        if !fileNotes.isEmpty { Label("\(fileNotes.count)", systemImage: "text.bubble").labelStyle(TightLabel()) }
    }
    private func step(_ by: Int) {
        guard let next = PhoneReview.step(index, count: store.files.count, by: by) else { return }
        store.current = ReviewStore.key(store.files[next])
    }

    @ViewBuilder private var content: some View {
        if !canRead || store.denied {
            VStack(spacing: 10) {
                Image(systemName: "lock").font(.system(size: 20)).foregroundStyle(PhoneTheme.muted)
                Text("这台设备看不到会话文件夹里的文件").font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink)
                Text("在 \(model.selectedHost?.name ?? "Mac") 上开启「可以看项目文件」").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            }.frame(maxWidth: .infinity).padding(.top, 64)
        } else if let failure = store.listFailure, store.list == nil {
            VStack(spacing: 10) {
                Text("读不到改动").font(PhoneTheme.body)
                Text(failure).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                Button("重试") { Task { await store.load(model, target: target) } }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
            }.frame(maxWidth: .infinity).padding(.top, 64)
        } else if let list = store.list {
            LazyVStack(alignment: .leading, spacing: 8) {
                if list["running"].bool { Label("运行中 · 下拉刷新", systemImage: "circle.dotted").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                if list["partial"].bool { Label(PhoneReview.partialWords, systemImage: "exclamationmark.triangle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
                if let failure = store.listFailure { Label(failure, systemImage: "exclamationmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                if let empty = PhoneReview.empty(list), store.files.isEmpty || empty.title.hasPrefix("这个文件夹") {
                    VStack(spacing: 6) {
                        Text(empty.title).font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink2)
                        if let detail = empty.detail { Text(detail).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                    }.frame(maxWidth: .infinity).padding(.top, 48)
                } else if let file {
                    if PhoneReview.contentHidden(file) {
                        Text(PhoneReview.fileNote(file) ?? "没有可以显示的内容").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.top, 48)
                    } else if let failure = store.fileFailure {
                        Text(failure).font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.top, 48)
                    } else if let lines = store.lines { diff(lines) }
                    else { ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.top, 48) }
                }
                let apart = notes.filter { note in !store.files.contains { note.same(root: $0["root"].string ?? "", path: $0["path"].string ?? "") } }
                if !apart.isEmpty {
                    Text("不在这个范围的反馈").font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.muted).padding(.top, 12)
                    ForEach(apart) { NoteCard(note: $0, where: $0.path, quote: true, sessionId: target.sessionId, canWrite: canWrite, write: write) }
                }
                if let failure = store.notesFailure, store.notes == nil { Label("读不到反馈 · " + failure, systemImage: "exclamationmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
            }.padding(.top, 8)
        } else { ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.top, 64) }
    }

    /** The diff in runs: lines in view (each run a TextKit 2 view), folded unchanged lines, and the cards under their last line. */
    private func diff(_ lines: [PhoneReviewLine]) -> some View {
        let placed = PhoneReview.place(fileNotes, old: PhoneReview.textLines(lines, side: .old), new: PhoneReview.textLines(lines, side: .new))
        let segments = PhoneReview.segments(lines) { line in placed.noted(line, notes: fileNotes) || selection?.contains(line) == true }
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(placed.stale) { NoteCard(note: $0, where: nil, quote: true, stale: true, sessionId: target.sessionId, canWrite: canWrite, write: write) }
            ForEach(Array(segments.enumerated()), id: \.offset) { offset, segment in
                switch segment {
                case let .gap(folded):
                    if expanded.contains(offset) { runs(folded, placed: placed) }
                    else {
                        Button { expanded.insert(offset) } label: {
                            Text("\(folded.count) 行未改动").font(.system(size: 12)).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity, minHeight: 32).background(PhoneTheme.sunken)
                        }.buttonStyle(.plain)
                    }
                case let .lines(shown): runs(shown, placed: placed)
                }
            }
        }.background(PhoneTheme.raised).clipShape(RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(PhoneTheme.line))
    }
    /** Lines up to each one a card sits under, then the card. */
    @ViewBuilder private func runs(_ lines: [PhoneReviewLine], placed: PhonePlacedNotes) -> some View {
        let parts: [(lines: [PhoneReviewLine], cards: [PhoneReviewNote])] = {
            var out: [(lines: [PhoneReviewLine], cards: [PhoneReviewNote])] = [], run: [PhoneReviewLine] = []
            for line in lines {
                run.append(line)
                let cards = placed.notes(under: line)
                if !cards.isEmpty { out.append((run, cards)); run = [] }
            }
            if !run.isEmpty { out.append((run, [])) }
            return out
        }()
        ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
            DiffTextView(lines: part.lines, selection: selection, noted: Set(part.lines.indices.filter { placed.noted(part.lines[$0], notes: fileNotes) }),
                onTap: canWrite && !model.busy ? { line in selection = PhoneReview.tap(selection, line) } : nil)
            ForEach(part.cards) { NoteCard(note: $0, where: nil, quote: false, sessionId: target.sessionId, canWrite: canWrite, write: write).padding(8) }
        }
    }

    // MARK: the bottom bar

    private var reviewPending: NativePendingWrite? { model.pending.first { $0.path.hasPrefix("/link/api/tasks/\(target.sessionId)/review-notes") } }
    @ViewBuilder private var foot: some View {
        let tally = PhoneReview.tally(notes)
        let open = PhoneReview.openSend(store.noteList)
        let action = PhoneReview.foot(tally: tally, selection: selection, running: running, canQueue: model.snapshot["catalog"]["features"]["queue"].bool,
            offline: !model.connected, unknownSend: open != nil && !model.busy, canWrite: canWrite, canDeliver: !target.taskReview && model.snapshot["catalog"]["features"]["gitDelivery"].bool)
        VStack(spacing: 6) {
            if !model.connected { Text("\(model.selectedHost?.name ?? "Mac") 不在线，反馈留在待发").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
            else if let error = store.error { Text(error).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
            if let pending = reviewPending {
                let row = textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 8))
                row {
                    Label(PhoneReview.pendingWords(pending) ?? "结果待确认", systemImage: "questionmark.circle").foregroundStyle(PhoneTheme.amber)
                    if !textSize.isAccessibilitySize { Spacer() }
                    Button("重试同一请求") { Task { await write(pending) } }.disabled(model.busy || !model.connected)
                }.font(PhoneTheme.caption)
            }
            let row = textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 4)) : AnyLayout(HStackLayout(spacing: 10))
            row {
                switch action {
                case let .note(label):
                    Text(label).font(.subheadline.monospacedDigit()); if !textSize.isAccessibilitySize { Spacer() }
                    Button("取消") { selection = nil }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
                    primary("写反馈") { writing = true }
                case .unknown:
                    Label("发送结果未知", systemImage: "questionmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber); if !textSize.isAccessibilitySize { Spacer() }
                    Button("放弃这次发送") { if let open { Task { await making(try PhoneReview.abandonSend(sessionId: target.sessionId, sendId: open.id)) } } }
                        .font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                    Button("重试同一请求") { if let open { Task { await making(try PhoneReview.retrySend(sessionId: target.sessionId, sendId: open.id)) } } }
                        .buttonStyle(.bordered).buttonBorderShape(.capsule).font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                case let .send(label, _, disabled):
                    Button("清空") { askClear = true }.disabled(model.busy).tint(PhoneTheme.ink); if !textSize.isAccessibilitySize { Spacer() }
                    primary(model.busy ? "发送中…" : label) {
                        Task { await making(try PhoneReview.send(sessionId: target.sessionId, noteIds: tally.ready, queue: running && model.snapshot["catalog"]["features"]["queue"].bool)) }
                    }.disabled(disabled || model.busy || reviewPending != nil)
                case let .deliver(status, busy):
                    statusText(status, busy); if !textSize.isAccessibilitySize { Spacer() }
                    primary("去提交") { delivering = true }
                case let .none(status, busy): statusText(status, busy); if !textSize.isAccessibilitySize { Spacer() }
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10).background(.bar)
    }
    @ViewBuilder private func statusText(_ text: String?, _ busy: Bool) -> some View {
        if let text {
            HStack(spacing: 6) { if busy { ProgressView().controlSize(.mini).tint(PhoneTheme.accent) }; Text(text).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2) }
        }
    }
    private func primary(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(label).font(.subheadline.weight(.semibold)).padding(.horizontal, 12).frame(minHeight: 44) }
            .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(PhoneTheme.accent)
    }

    private var noteSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                if let selection, let lines = store.lines {
                    ScrollView {
                        Text(PhoneConversation.visible(PhoneReview.snippet(PhoneReview.textLines(lines, side: selection.side), selection).joined(separator: "\n")))
                            .font(.system(size: 12, design: .monospaced)).foregroundStyle(PhoneTheme.ink2).frame(maxWidth: .infinity, alignment: .leading).padding(10)
                    }.frame(maxHeight: 120).background(PhoneTheme.sunken, in: RoundedRectangle(cornerRadius: 8)).accessibilityLabel("选中的代码")
                }
                TextField("写给 Agent 的反馈…", text: $noteText, axis: .vertical).lineLimit(3...8).textFieldStyle(.roundedBorder)
                Spacer(minLength: 0)
            }
            .padding(16)
            .navigationTitle(selection?.label ?? "反馈").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { writing = false } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.busy ? "加入中…" : "加入待发") { Task { await addNote() } }
                        .disabled(noteText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy).keyboardShortcut(.return, modifiers: .command)
                }
            }
        }.presentationDetents([.medium, .large])
    }
    private func addNote() async {
        guard let selection, let file, let lines = store.lines, let root = file["root"].string, let path = file["path"].string else { return }
        let snippet = PhoneReview.snippet(PhoneReview.textLines(lines, side: selection.side), selection)
        let done = await making(try PhoneReview.create(sessionId: target.sessionId, root: root, path: path, selection: selection, scope: target.scope,
            turnId: store.list?["turnId"].string, lines: snippet, text: noteText))
        if done { writing = false; self.selection = nil; noteText = "" }
    }
    /** One review write; the notes are read again whatever the answer. */
    @discardableResult private func making(_ make: @autoclosure () throws -> NativePendingWrite) async -> Bool {
        guard let request = try? make() else { return false }
        return await write(request)
    }
    @discardableResult private func write(_ request: NativePendingWrite) async -> Bool {
        store.error = nil
        let outcome = await model.write(request, refresh: false)
        await store.loadNotes(model, sessionId: target.sessionId, work: target.work)
        switch outcome {
        case .done: return true
        case let .refused(refusal): store.error = refusal.message.isEmpty ? "没有完成" : refusal.message
        // The bar above offers 重试同一请求 for it: the same request, never a second write.
        case .unknown: store.error = nil
        case let .failed(error): store.error = (error as? NativeFailure)?.errorDescription ?? "暂时无法完成，请稍后重试。"
        }
        return false
    }
}

private var staleWarning: some View {
    Label("位置可能过期", systemImage: "exclamationmark.circle").labelStyle(TightLabel())
        .font(.caption).foregroundStyle(PhoneTheme.amber).fixedSize(horizontal: false, vertical: true)
}

/** One kept note: where it is, its state, its words, and what the person can set next. */
struct NoteCard: View {
    @EnvironmentObject private var model: PhoneModel
    let note: PhoneReviewNote
    let `where`: String?
    let quote: Bool
    var stale = false
    let sessionId: String
    let canWrite: Bool
    let write: (NativePendingWrite) async -> Bool
    @State private var editing = false
    @State private var text = ""
    @Environment(\.dynamicTypeSize) private var textSize
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let place = `where` {
                Text(PhoneConversation.visible(place)).font(.caption.monospaced()).foregroundStyle(PhoneTheme.muted)
            }
            HStack(spacing: 6) {
                Text(PhoneReview.linesLabel(start: note.start, end: note.end)).font(.caption.weight(.medium)).foregroundStyle(PhoneTheme.ink2)
                Spacer(minLength: 4)
                Text(note.word).font(.caption).foregroundStyle(note.status == .sent || note.status == .reviewed ? PhoneTheme.green : PhoneTheme.muted)
                if canWrite && !note.sending {
                    Button { Task { await write(try! PhoneReview.remove(sessionId: sessionId, noteId: note.id)) } } label: {
                        Image(systemName: "xmark").font(.caption).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).foregroundStyle(PhoneTheme.muted).accessibilityLabel("删除反馈").disabled(model.busy)
                }
            }
            if stale { staleWarning }
            if stale || quote {
                Text(PhoneConversation.visible(note.lines.joined(separator: "\n"))).font(.system(size: 12, design: .monospaced)).foregroundStyle(PhoneTheme.ink2)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(8).background(PhoneTheme.sunken, in: RoundedRectangle(cornerRadius: 6)).accessibilityLabel("原来的代码")
            }
            if editing {
                TextField("反馈", text: $text, axis: .vertical).lineLimit(2...6).textFieldStyle(.roundedBorder)
                HStack {
                    Spacer()
                    Button("取消") { editing = false }.font(PhoneTheme.caption)
                    Button("保存") { Task { if await write(try! PhoneReview.edit(sessionId: sessionId, noteId: note.id, text: text)) { editing = false } } }
                        .font(PhoneTheme.caption).disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
                }
            } else {
                Text(PhoneConversation.visible(note.text)).font(.system(size: 14)).foregroundStyle(PhoneTheme.ink).textSelection(.disabled)
            }
            if canWrite && !editing && (note.canEdit || note.status == .sent || note.status == .claimed) {
                let layout = textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 4)) : AnyLayout(HStackLayout(spacing: 12))
                layout {
                    if !textSize.isAccessibilitySize { Spacer() }
                    if note.canEdit { Button("编辑") { text = note.text; editing = true } }
                    if note.status == .sent { Button("Agent 称已修") { Task { await write(try! PhoneReview.status(sessionId: sessionId, noteId: note.id, status: .claimed)) } } }
                    if note.status == .sent || note.status == .claimed {
                        Button { Task { await write(try! PhoneReview.status(sessionId: sessionId, noteId: note.id, status: .reviewed)) } } label: { Label("标为已复核", systemImage: "checkmark") }
                            .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
                    }
                }.font(PhoneTheme.caption).disabled(model.busy)
            }
        }
        .padding(10).background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
    }
}
