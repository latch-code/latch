import LatchNativeCore
import SwiftUI

/** The review page's reads: the scope's list, the file shown, and the session's notes. Content: it lives with the window. */
@MainActor final class ReviewStore: ObservableObject {
    @Published var list: NativeJSON?
    @Published var listFailure: String?
    @Published var denied = false
    @Published var current: String?
    @Published var lines: [PhoneReviewLine]?
    @Published var fileFailure: String?
    @Published var notes: [PhoneReviewNote]?
    @Published var noteList = NativeJSON.null
    @Published var notesFailure: String?
    @Published var error: String?
    private var asked = 0, fileAsked = 0, notesAsked = 0
    var files: [NativeJSON] { list.map(PhoneReview.files) ?? [] }
    static func key(_ file: NativeJSON) -> String { (file["root"].string ?? "") + "\n" + (file["path"].string ?? "") }

    func load(_ model: PhoneModel, target: PhoneReviewTarget) async {
        asked += 1; let mine = asked
        do {
            let value = try await model.reviewRead(try PhoneReview.listPath(target.sessionId, scope: target.scope))
            guard mine == asked else { return }
            list = value; listFailure = nil; denied = false
            let files = PhoneReview.files(value)
            if let wanted = target.file, let found = files.first(where: { $0["path"].string == wanted }) { current = Self.key(found) }
            else if !files.contains(where: { Self.key($0) == current }) { current = files.first.map(Self.key) }
            await readFile(model, target: target)
        } catch {
            guard mine == asked else { return }
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
            let value = try await model.reviewRead(try PhoneReview.filePath(target.sessionId, scope: target.scope, turnId: list?["turnId"].string, root: root, path: path))
            guard mine == fileAsked else { return }
            lines = PhoneReview.lines(value); fileFailure = nil
        } catch {
            guard mine == fileAsked else { return }
            lines = nil
            // A whole file past one response never arrives here: the Mac shows it.
            fileFailure = (error as? NativeFailure) == .invalidRecord ? "文件太大，到 Mac 上看" : "读不到这个文件"
        }
    }
    func loadNotes(_ model: PhoneModel, sessionId: String) async {
        guard model.snapshot["catalog"]["features"]["reviewNotes"].bool, model.snapshot["device"]["dataScope"].string == "all" else { return }
        notesAsked += 1; let mine = notesAsked
        do {
            let value = try await model.reviewRead(try PhoneReview.notesPath(sessionId))
            guard mine == notesAsked else { return }
            noteList = value; notes = PhoneReview.notes(value); notesFailure = nil
            // A send this device has no answer for, now held open (or done) on the Host: the Host answers it from here on.
            for write in model.pending where PhoneReview.heldByHost(write, list: value, sessionId: sessionId) { await model.settle(write) }
        } catch { if mine == notesAsked { notesFailure = (error as? NativeFailure)?.errorDescription ?? "读不到反馈" } }
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
    private var summary: NativeJSON { model.summary(of: target.sessionId) }
    private var canRead: Bool { model.snapshot["device"]["dataScope"].string == "all" }
    private var running: Bool { ["running", "waiting-approval"].contains(summary["status"].string ?? "") }
    private var canWrite: Bool { model.canRun && model.connected && summary["personal"] == .null && model.snapshot["catalog"]["features"]["reviewNotes"].bool && canRead }
    private var file: NativeJSON? { store.files.first { ReviewStore.key($0) == store.current } }
    private var index: Int { store.files.firstIndex { ReviewStore.key($0) == store.current } ?? 0 }
    private var notes: [PhoneReviewNote] { store.notes ?? [] }
    private var fileNotes: [PhoneReviewNote] { file.map { f in notes.filter { $0.same(root: f["root"].string ?? "", path: f["path"].string ?? "") } } ?? [] }
    private var revision: UInt64 { PhoneReview.counts(model.snapshot, target.sessionId)["revision"].integer ?? 0 }

    var body: some View {
        VStack(spacing: 0) {
            if canRead {
                Picker("改动范围", selection: $target.scope) { ForEach(PhoneReviewScope.allCases, id: \.self) { Text($0.label).tag($0) } }
                    .pickerStyle(.segmented).padding(.horizontal, 16).padding(.vertical, 8)
            }
            // An iPad lists the scope's files beside the diff; a phone steps through them one at a time.
            HStack(spacing: 0) {
                if wide && canRead && !store.files.isEmpty {
                    fileList.frame(width: 280)
                    Rectangle().fill(PhoneTheme.line).frame(width: 1)
                }
                VStack(spacing: 0) {
                    if canRead, let file { pager(file) }
                    ScrollView { content.padding(.horizontal, 12).padding(.bottom, 16) }.background(PhoneTheme.canvas)
                }
            }
        }
        .background(PhoneTheme.canvas)
        .navigationTitle("改动").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text("改动").font(.system(size: 15, weight: .semibold))
                    Text(PhoneConversation.visible(summary["title"].string ?? "未命名会话")).font(.system(size: 11)).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                }
            }
            if let totals = store.list?["totals"], store.list?["unavailable"] == .null, !(store.list?["files"].array.isEmpty ?? true) {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 4) {
                        Text("+\(totals["add"].integer ?? 0)").foregroundStyle(PhoneTheme.green)
                        Text("−\(totals["del"].integer ?? 0)").foregroundStyle(PhoneTheme.red)
                    }.font(.system(size: 12, design: .monospaced))
                }
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .safeAreaInset(edge: .bottom, spacing: 0) { foot }
        .navigationDestination(isPresented: $delivering) {
            DeliveryView(sessionId: target.sessionId) { path in target.file = path; target.scope = .uncommitted; delivering = false; Task { await store.load(model, target: target) } }
        }
        .sheet(isPresented: Binding(get: { writing && selection != nil }, set: { if !$0 { writing = false } })) { noteSheet }
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
        .task(id: revision) { await store.loadNotes(model, sessionId: target.sessionId) }
        .task(id: summary["status"].string ?? "") { await store.loadNotes(model, sessionId: target.sessionId); if !running { await store.load(model, target: target) } }
        .onChange(of: store.current) { _, _ in selection = nil; expanded = []; Task { await store.readFile(model, target: target) } }
        .onAppear {
            model.markSeen(target.sessionId)
            #if LATCH_SCREENS
            #endif
        }
        .onChange(of: model.summary(of: target.sessionId)["updatedAt"].string) { _, _ in model.markSeen(target.sessionId) }
    }

    @Environment(\.horizontalSizeClass) private var widthClass
    private var wide: Bool { widthClass == .regular }
    private var fileList: some View {
        List {
            ForEach(store.files.indices, id: \.self) { index in
                let file = store.files[index], key = ReviewStore.key(file), path = file["path"].string ?? ""
                Button { store.current = key } label: {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(PhoneConversation.visible(path.split(separator: "/").last.map(String.init) ?? path)).font(.system(size: 14, weight: key == store.current ? .semibold : .regular)).lineLimit(1)
                            if path.contains("/") { Text(PhoneConversation.visible(String(path[..<path.lastIndex(of: "/")!]))).font(.system(size: 11)).foregroundStyle(PhoneTheme.muted).lineLimit(1).truncationMode(.head) }
                        }
                        Spacer(minLength: 4)
                        let count = notes.filter { $0.same(root: file["root"].string ?? "", path: path) }.count
                        if count > 0 { Label("\(count)", systemImage: "text.bubble").labelStyle(TightLabel()).font(.system(size: 11)).foregroundStyle(PhoneTheme.muted) }
                    }.foregroundStyle(PhoneTheme.ink).contentShape(Rectangle())
                }.buttonStyle(.plain)
                    .listRowBackground(key == store.current ? PhoneTheme.accent.opacity(0.12) : Color.clear)
            }
        }.listStyle(.plain).scrollContentBackground(.hidden).background(PhoneTheme.sunken)
    }
    private func pager(_ file: NativeJSON) -> some View {
        let path = file["path"].string ?? ""
        let folder = path.contains("/") ? String(path[..<path.lastIndex(of: "/")!]) : ""
        let stale = store.lines.map { lines in PhoneReview.place(fileNotes, old: PhoneReview.textLines(lines, side: .old), new: PhoneReview.textLines(lines, side: .new)).stale.count } ?? 0
        return HStack(spacing: 4) {
            Button { step(-1) } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }.disabled(index == 0).accessibilityLabel("上一个文件")
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(PhoneConversation.visible(path.split(separator: "/").last.map(String.init) ?? path)).font(.system(size: 14, weight: .medium)).lineLimit(1)
                    if !PhoneReview.contentHidden(file) {
                        if file["status"].string == "A" { Text("新文件").font(.system(size: 11)).foregroundStyle(PhoneTheme.green) }
                        else if file["status"].string == "D" { Text("已删除").font(.system(size: 11)).foregroundStyle(PhoneTheme.red) }
                        else {
                            if let add = file["add"].integer, add > 0 { Text("+\(add)").foregroundStyle(PhoneTheme.green).font(.system(size: 11, design: .monospaced)) }
                            if let del = file["del"].integer, del > 0 { Text("−\(del)").foregroundStyle(PhoneTheme.red).font(.system(size: 11, design: .monospaced)) }
                        }
                    }
                }
                HStack(spacing: 6) {
                    if !folder.isEmpty { Text(PhoneConversation.visible(folder)).lineLimit(1).truncationMode(.head) }
                    if let note = PhoneReview.fileNote(file) { Text(note) }
                    if !fileNotes.isEmpty { Label("\(fileNotes.count)", systemImage: "text.bubble").labelStyle(TightLabel()) }
                    if stale > 0 { Label("位置可能过期", systemImage: "exclamationmark.circle").labelStyle(TightLabel()).foregroundStyle(PhoneTheme.amber) }
                }.font(.system(size: 11)).foregroundStyle(PhoneTheme.muted)
            }.frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .combine)
            Text("\(index + 1) / \(store.files.count)").font(.system(size: 12).monospacedDigit()).foregroundStyle(PhoneTheme.muted)
            Button { step(1) } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44) }.disabled(index >= store.files.count - 1).accessibilityLabel("下一个文件")
        }.padding(.horizontal, 4).tint(PhoneTheme.ink).background(PhoneTheme.sunken)
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
                if running { Label("运行中 · 下拉刷新", systemImage: "circle.dotted").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
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
            offline: !model.connected, unknownSend: open != nil && !model.busy, canWrite: canWrite, canDeliver: model.snapshot["catalog"]["features"]["gitDelivery"].bool)
        VStack(spacing: 6) {
            if !model.connected { Text("\(model.selectedHost?.name ?? "Mac") 不在线，反馈留在待发").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
            else if let error = store.error { Text(error).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
            if let pending = reviewPending {
                HStack {
                    Label(PhoneReview.pendingWords(pending) ?? "结果待确认", systemImage: "questionmark.circle").foregroundStyle(PhoneTheme.amber)
                    Spacer()
                    Button("重试同一请求") { Task { await write(pending) } }.disabled(model.busy || !model.connected)
                }.font(PhoneTheme.caption)
            }
            HStack(spacing: 10) {
                switch action {
                case let .note(label):
                    Text(label).font(PhoneTheme.body.monospacedDigit()); Spacer()
                    Button("取消") { selection = nil }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
                    primary("写反馈") { writing = true }
                case .unknown:
                    Label("发送结果未知", systemImage: "questionmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber); Spacer()
                    Button("放弃这次发送") { if let open { Task { await making(try PhoneReview.abandonSend(sessionId: target.sessionId, sendId: open.id)) } } }
                        .font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                    Button("重试同一请求") { if let open { Task { await making(try PhoneReview.retrySend(sessionId: target.sessionId, sendId: open.id)) } } }
                        .buttonStyle(.bordered).buttonBorderShape(.capsule).font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                case let .send(label, _, disabled):
                    Button("清空") { askClear = true }.disabled(model.busy).tint(PhoneTheme.ink); Spacer()
                    primary(model.busy ? "发送中…" : label) {
                        Task { await making(try PhoneReview.send(sessionId: target.sessionId, noteIds: tally.ready, queue: running && model.snapshot["catalog"]["features"]["queue"].bool)) }
                    }.disabled(disabled || model.busy || reviewPending != nil)
                case let .deliver(status, busy):
                    statusText(status, busy); Spacer()
                    primary("去提交") { delivering = true }
                case let .none(status, busy): statusText(status, busy); Spacer()
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
        Button(action: action) { Text(label).font(.system(size: 15, weight: .semibold)).padding(.horizontal, 18).frame(minHeight: 44) }
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
        await store.loadNotes(model, sessionId: target.sessionId)
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
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if let place = `where` { Text(PhoneConversation.visible(place)).font(.system(size: 12, design: .monospaced)).foregroundStyle(PhoneTheme.muted).lineLimit(1) }
                Text(PhoneReview.linesLabel(start: note.start, end: note.end)).font(.system(size: 12, weight: .medium)).foregroundStyle(PhoneTheme.ink2)
                if stale { Label("位置可能过期", systemImage: "exclamationmark.circle").labelStyle(TightLabel()).font(.system(size: 11)).foregroundStyle(PhoneTheme.amber) }
                Spacer()
                Text(note.word).font(.system(size: 11)).foregroundStyle(note.status == .sent || note.status == .reviewed ? PhoneTheme.green : PhoneTheme.muted)
                if canWrite && !note.sending {
                    Button { Task { await write(try! PhoneReview.remove(sessionId: sessionId, noteId: note.id)) } } label: { Image(systemName: "xmark").font(.system(size: 11)) }
                        .buttonStyle(.plain).foregroundStyle(PhoneTheme.muted).accessibilityLabel("删除反馈").disabled(model.busy)
                }
            }
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
                HStack(spacing: 12) {
                    Spacer()
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
