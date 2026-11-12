import LatchNativeCore
import SwiftUI

/** 会话: a list that collapses into a push on the phone and stays beside the conversation on an iPad. */
struct InboxView: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var query = ""
    @State private var creating = false
    @State private var showConnecting = false
    @State private var column = NavigationSplitViewColumn.sidebar
    private var frozen: Bool { !model.connected }
    private var selection: Binding<String?> {
        Binding(get: { model.sessionId }, set: { id in
            if let id { Task { await model.openSession(id) } } else if model.sessionId != nil { model.closeSession() }
        })
    }
    var body: some View {
        NavigationSplitView(preferredCompactColumn: $column) {
            let workspaces = model.snapshot["catalog"]["workspaces"].array
            // Code lists its own sessions; 我的 Agent's topics are in their conversations, as on the web.
            let tasks = PhoneSpaces.tasks(model.snapshot, in: .code)
            let shelves = model.showArchived ? PhoneSessions.archivedShelves(tasks, query: query) : model.shelves(query: query)
            let searching = PhoneSearch.query(query) != nil && model.canSearchContent && !model.showArchived
            List(selection: selection) {
                if showConnecting { Text("正在连接…").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).listRowSeparator(.hidden) }
                if let notice = model.hostNotice, !model.connected { HostNoticeBanner(words: notice.words(computer: model.selectedHost.map(model.computerName) ?? "Mac")).plainRow() }
                else if model.offline, let host = model.selectedHost { OfflineBanner(host: model.computerName(host)).plainRow() }
                if model.showArchived {
                    Button { model.showArchived = false } label: { ArchivedLine(back: true, count: PhoneSessions.archived(tasks).count) }.buttonStyle(.plain).plainRow()
                }
                let others = model.showArchived || !query.isEmpty ? [] : model.otherComputerGroups
                if !others.isEmpty, shelves.first?.id != "waiting" { OtherComputersSection(groups: others) }
                ForEach(shelves, id: \.id) { shelf in
                    Section {
                        ForEach(shelf.tasks, id: \.id) { task in
                            InboxRow(task: task, frozen: frozen, inWaiting: shelf.id == "waiting", project: shelf.id == "waiting" ? PhoneSessions.project(of: task, workspaces: workspaces)?["name"].string ?? "对话" : nil)
                                .tag(task.id).listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 8, trailing: 20)).listRowBackground(Color.clear)
                                .sessionActions(task, model: model)
                        }
                    } header: { if !shelf.label.isEmpty { ShelfHeader(label: shelf.label, count: shelf.id == "waiting" ? shelf.tasks.count : nil) } }
                    if shelf.id == "waiting", !others.isEmpty { OtherComputersSection(groups: others) }
                }
                if shelves.isEmpty && !searching { emptyState.plainRow() }
                if searching { ContentSearchSection(query: query) }
                if !model.showArchived, query.isEmpty, case let count = PhoneSessions.archived(tasks).count, count > 0 {
                    Button { model.showArchived = true } label: { ArchivedLine(back: false, count: count) }.buttonStyle(.plain).plainRow()
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(PhoneTheme.canvas)
            .navigationTitle("会话")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索")
            .refreshable { await model.refresh() }
            .toolbar {
                if model.hosts.count > 1 {
                    ToolbarItem(placement: .topBarLeading) {
                        ComputerMenu().disabled(model.busy || model.verifying)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("新会话", systemImage: "square.and.pencil") { creating = true }.labelStyle(.iconOnly).disabled(!model.connected)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { VStack(spacing: 6) { PendingWritesBar(); ControlPendingBar() } }
        } detail: {
            // The review is the detail column's own stack, so 提交 is pushed on top of it; a destination of the list
            // replaces the detail column and cannot push again.
            if let target = model.reviewTarget { NavigationStack { ReviewView(target: target) }.id(target.sessionId) }
            else if let id = model.sessionId { ConversationView(id: id) }
            else { PhoneTheme.canvas.ignoresSafeArea() }
        }
        .sheet(isPresented: $creating, onDismiss: { model.openPendingImport() }) { NewSessionSheet().presentationCornerRadius(28) }
        .onChange(of: model.reviewTarget?.sessionId) { _, id in if id != nil { column = .detail } else if model.sessionId == nil { column = .sidebar } }
        // Back to the list from the review leaves it.
        .onChange(of: column) { _, now in if now == .sidebar, model.reviewTarget != nil { model.reviewTarget = nil } }
        .modifier(SessionDialogs())
        #if LATCH_SCREENS
        .onAppear { if model.staged, !ScreensStage.query.isEmpty { query = ScreensStage.query } }
        .task(id: model.staged) { if model.staged, ScreensStage.creating { creating = true } }
        #endif
        // The Host searches once the typing settles; a later query or a closed window drops what an earlier one finds.
        .task(id: [query, model.verifiedUntil == nil ? "closed" : "open"]) {
            #if LATCH_SCREENS
            if model.staged { return }
            #endif
            guard PhoneSearch.query(query) != nil, model.canSearchContent, !model.showArchived else { model.contentSearch = PhoneContentSearch(); return }
            try? await Task.sleep(for: .milliseconds(300))
            if !Task.isCancelled { await model.searchContent(query) }
        }
        .task(id: model.selectedHost == nil || model.connected || model.offline) {
            // A connection that settles within a second never mentions connecting.
            showConnecting = false
            guard model.selectedHost != nil, !model.connected, !model.offline else { return }
            try? await Task.sleep(for: .seconds(1))
            if !Task.isCancelled { showConnecting = true }
        }
    }
    @ViewBuilder private var emptyState: some View {
        if model.showArchived { Text("没有已归档的会话").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.top, 48) }
        else if !query.isEmpty { Text("没有符合的会话").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.top, 48) }
        else if model.connected {
            VStack(spacing: 8) {
                Text("还没有会话").font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink)
                Button("新会话") { creating = true }.font(PhoneTheme.body)
            }.frame(maxWidth: .infinity).padding(.top, 48)
        }
    }
}

private extension View {
    func plainRow() -> some View { listRowSeparator(.hidden).listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16)) }
    /** The session menu held down, and swiped: 置顶 from the leading edge, 归档 and 删除 from the trailing one. */
    @ViewBuilder func sessionActions(_ task: NativeJSON, model: PhoneModel) -> some View {
        if PhoneSessionMenu.sections(task, canRun: model.canRun).isEmpty { self }
        else {
            let busy = model.busy || !model.connected
            contextMenu { SessionMenuButtons(task: task) }
                .swipeActions(edge: .leading) {
                    Button(task["pinned"].bool ? "取消置顶" : "置顶", systemImage: task["pinned"].bool ? "pin.slash" : "pin") { Task { await model.choose(.pin, task: task) } }
                        .tint(PhoneTheme.muted).disabled(busy)
                }
                .swipeActions(edge: .trailing) {
                    if !PhoneSessionMenu.active(task) {
                        Button("删除", systemImage: "trash", role: .destructive) { Task { await model.choose(.delete, task: task) } }.disabled(busy)
                    }
                    Button(task["archived"].bool ? "取消归档" : "归档", systemImage: "archivebox") { Task { await model.choose(.archive, task: task) } }
                        .tint(PhoneTheme.ink2).disabled(busy)
                }
        }
    }
}

/** 已归档 at the end of the list, and the way back from it, as the phone web draws them. */
private struct ArchivedLine: View {
    let back: Bool
    let count: Int
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: back ? "chevron.left" : "archivebox").font(.system(size: 14)).foregroundStyle(PhoneTheme.muted)
            Text("已归档").font(.system(size: 15)).foregroundStyle(back ? PhoneTheme.ink : PhoneTheme.ink2)
            Text("\(count)").font(.system(size: 13)).foregroundStyle(PhoneTheme.faint)
            Spacer()
        }.frame(minHeight: 44).contentShape(Rectangle()).accessibilityElement(children: .combine).accessibilityLabel(back ? "返回会话 · 已归档 \(count)" : "已归档的会话（\(count)）")
    }
}

private struct ShelfHeader: View {
    let label: String
    let count: Int?
    var body: some View {
        HStack(spacing: 8) {
            Text(label).font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.muted).lineLimit(1)
            if let count { Text("\(count)").font(.system(size: 13)).foregroundStyle(PhoneTheme.faint) }
            Rectangle().fill(PhoneTheme.line).frame(height: 1)
        }.textCase(nil)
    }
}

/** The Mac may be away; what the list shows stays readable and says when it was last true. Nothing here is red. */
private struct OfflineBanner: View {
    @EnvironmentObject private var model: PhoneModel
    let host: String
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "wifi.slash").font(.system(size: 15)).foregroundStyle(PhoneTheme.muted)
            Text(words).font(.system(size: 14, weight: .medium)).foregroundStyle(PhoneTheme.ink2).lineLimit(1)
            Spacer(minLength: 4)
            Button("重试") { model.retryConnection() }.buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(PhoneTheme.ink)
        }.padding(.leading, 12).padding(.trailing, 6).frame(height: 44).background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 14))
    }
    private var words: String {
        guard let at = model.lastConfirmed else { return host + " 不在线" }
        return host + " 不在线 · 上次在线 " + PhoneTime.message(at)
    }
}

/** The Host said it is installing an update or asleep: a plain line, not a failure; it reconnects by itself. */
private struct HostNoticeBanner: View {
    let words: (title: String, body: String)
    var body: some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small).tint(PhoneTheme.muted)
            VStack(alignment: .leading, spacing: 1) {
                Text(PhoneConversation.visible(words.title)).font(.system(size: 14, weight: .medium)).foregroundStyle(PhoneTheme.ink2).lineLimit(1)
                Text(words.body).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1)
            }
            Spacer(minLength: 4)
        }.padding(.horizontal, 12).frame(minHeight: 52).background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 14))
            .accessibilityElement(children: .combine)
    }
}

struct InboxRow: View {
    @EnvironmentObject private var model: PhoneModel
    let task: NativeJSON
    let frozen: Bool
    let inWaiting: Bool
    let project: String?
    private var status: PhoneRowStatus { PhoneSessions.rowStatus(task, frozen: frozen) }
    private var strong: Bool { if case .read = status { return false }; return true }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(task["title"].string ?? "会话").font(strong ? PhoneTheme.row : .system(size: 15)).foregroundStyle(strong ? PhoneTheme.ink : PhoneTheme.ink2).lineLimit(1)
                Spacer(minLength: 4)
                RowStatusSlot(task: task, status: status, frozenAt: model.lastConfirmed)
            }
            HStack(spacing: 6) {
                EngineTile(mark: model.engineMark(task["harnessId"].string), size: 14)
                Text(([model.engineName(task["harnessId"].string)] + [PhoneSessions.rowMeta(task, project: project)].compactMap { $0 }).joined(separator: " · "))
                    .font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                if let id = task["id"].string, PhoneHandoffs.awaiting(model.snapshot).contains(id) {
                    Spacer(minLength: 4)
                    Text("待交回").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                }
            }
            if let id = task["id"].string, let label = model.reviewShortcuts[id] {
                Button { model.openReview(id) } label: {
                    HStack(spacing: 4) {
                        Text(label).font(.system(size: 13, weight: .medium))
                        Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                    }.foregroundStyle(PhoneTheme.ink).padding(.horizontal, 10).frame(minHeight: 30).background(PhoneTheme.bubble, in: Capsule())
                }.buttonStyle(.borderless).padding(.top, 2).accessibilityHint("打开复核页")
            }
        }.frame(minHeight: 48, alignment: .center).accessibilityElement(children: .contain)
    }
}

private struct RowStatusSlot: View {
    @EnvironmentObject private var model: PhoneModel
    let task: NativeJSON
    let status: PhoneRowStatus
    let frozenAt: Date?
    var body: some View {
        switch status {
        case .waiting: Label { Text("等你处理") } icon: { Image(systemName: "shield").foregroundStyle(PhoneTheme.amberIcon) }.labelStyle(TightLabel()).foregroundStyle(PhoneTheme.amber).font(PhoneTheme.caption)
        case .silent:
            TimelineView(.periodic(from: .now, by: 30)) { _ in
                Text(PhoneSessions.silentWords(task["live"], hostNow: model.hostNow())).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).lineLimit(1)
            }
        case .stopping: running("正在停止")
        case .running:
            TimelineView(.periodic(from: .now, by: 1)) { _ in running(PhoneSessions.runningWords(task["live"], hostNow: model.hostNow())) }
        case .failed: Label { Text("失败") } icon: { Image(systemName: "exclamationmark.circle") }.labelStyle(TightLabel()).foregroundStyle(PhoneTheme.red).font(PhoneTheme.caption)
        case let .ended(word, unknown): Text(word).font(PhoneTheme.caption).foregroundStyle(unknown > 0 ? PhoneTheme.amber : PhoneTheme.muted)
        case .frozen: Text(frozenAt.map { "上次确认 " + PhoneTime.message($0) } ?? "状态未更新").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1)
        case .read: Text(PhoneTime.parse(task["updatedAt"]).map { PhoneTime.relative($0) } ?? "").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
        }
    }
    private func running(_ words: String) -> some View {
        HStack(spacing: 5) { ProgressView().controlSize(.mini).tint(PhoneTheme.accent); Text(words).font(PhoneTheme.caption.monospacedDigit()).foregroundStyle(PhoneTheme.ink2).lineLimit(1) }
    }
}

struct TightLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View { HStack(spacing: 4) { configuration.icon; configuration.title } }
}

/**
 * A write whose answer never came blocks every later one until it is sent again, so the list offers it too, not only the
 * conversation it belongs to.
 */
private struct PendingWritesBar: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var checked: String?
    var body: some View {
        if let checked {
            Label(checked, systemImage: "info.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).padding(.horizontal, 16)
                .task { try? await Task.sleep(for: .seconds(6)); self.checked = nil }
        }
        ForEach(model.pending, id: \.requestId) { pending in
            HStack {
                Label(PhoneReview.pendingWords(pending) ?? PhoneDelivery.pendingWords(pending) ?? PhoneFileEdit.pendingWords(pending) ?? PhoneHandoffs.pendingWords(pending) ?? PhonePending.words(pending), systemImage: "clock").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                Spacer()
                if PhoneHistory.isImport(pending) {
                    Button("核对并放下") { Task { checked = await model.checkImportFromList(pending) ?? "没能核对，稍后再试" } }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                } else if PhoneDelivery.isStage(pending) || PhoneFileEdit.pendingSave(pending) != nil {
                    Button("核对并放下") { Task { checked = await model.checkAndDrop(pending) ?? "没能核对，稍后再试" } }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                }
                Button("重试这次提交") {
                    Task {
                        // A new topic's start opens its topic in 我的 Agent, where the conversation with that Agent is.
                        if let owner = PhonePending.topicOwner(pending) {
                            if await model.finishTopic(pending) { model.tab = .agents; model.agentPath = [owner] }
                        } else { await model.retryPending(pending) }
                    }
                }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                if PhonePending.prompt(pending) != nil, case let .session(id) = PhonePending.kind(pending) {
                    Button("放弃这次提交") {
                        Task {
                            switch await model.abandonPrompt(pending) {
                            case .delivered: checked = "已送达"
                            case let .text(back, twin):
                                model.addToDraft(back, session: id)
                                if twin { checked = PhoneAbandoned.queuedTwinWords }
                            case nil: break
                            }
                        }
                    }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).disabled(model.busy)
                    InfoHint(text: PromptComposer.abandonHint)
                }
            }.padding(.horizontal, 16).padding(.vertical, 6)
        }
    }
}

/** The computer menu: each computer's name, state and what waits there; choosing one switches to it. */
private struct ComputerMenu: View {
    @EnvironmentObject private var model: PhoneModel
    var body: some View {
        let rows = model.computerRows
        Menu {
            ForEach(rows) { row in
                Button { Task { await model.switchComputer(row.host) } } label: {
                    if row.selected { Image(systemName: "checkmark") }
                    Text(row.name)
                    Text(row.line)
                }.accessibilityLabel("\(row.name)，\(row.line)")
            }
        } label: {
            HStack(spacing: 4) {
                Text(model.selectedHost.map(model.computerName) ?? "选择 Mac").lineLimit(1)
                // Something waits on another computer that answers now: an amber dot, no number, as the tab bar's.
                if rows.contains(where: { !$0.selected && $0.state == .online && $0.waiting > 0 }) {
                    Circle().fill(PhoneTheme.amberIcon).frame(width: 6, height: 6).accessibilityLabel("其他电脑有等你处理")
                }
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
            }
        }
    }
}

/** 其他电脑 under 等你处理: live rows while a computer answers, one grey 「离线前 N 项」 row while it does not. */
private struct OtherComputersSection: View {
    @EnvironmentObject private var model: PhoneModel
    let groups: [PhoneComputerGroup]
    var body: some View {
        Section {
            ForEach(groups, id: \.id) { group in
                if group.live {
                    ForEach(group.items, id: \.taskId) { item in
                        Button { Task { await model.openOther(computer: group.id, session: item.taskId) } } label: { OtherRow(item: item, computer: group.name) }
                            .buttonStyle(.plain).otherRow()
                    }
                } else {
                    Button { Task { await model.openOther(computer: group.id, session: nil) } } label: { StaleRow(group: group) }
                        .buttonStyle(.plain).otherRow()
                }
            }
        } header: { ShelfHeader(label: "其他电脑", count: nil) }
    }
}

private struct OtherRow: View {
    let item: PhoneComputerItem
    let computer: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(item.title.isEmpty ? "未命名会话" : PhoneConversation.visible(item.title)).font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink).lineLimit(1)
                Spacer(minLength: 4)
                Text(item.since.map { PhoneTime.relative($0) } ?? "").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            }
            HStack(spacing: 5) {
                Image(systemName: "laptopcomputer").font(.system(size: 11)).foregroundStyle(PhoneTheme.muted)
                Text(computer).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                Text("· " + item.kind.words).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).lineLimit(1)
            }
        }.frame(minHeight: 48).contentShape(Rectangle())
            .accessibilityElement(children: .combine).accessibilityLabel("\(item.title)，\(computer)，\(item.kind.words)").accessibilityHint("切换到这台电脑并打开")
    }
}

private struct StaleRow: View {
    @EnvironmentObject private var model: PhoneModel
    let group: PhoneComputerGroup
    var body: some View {
        let reading = model.computerReadings[group.id]
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(group.name).font(.system(size: 15)).foregroundStyle(PhoneTheme.ink2).lineLimit(1)
                Spacer(minLength: 4)
                Text("离线前 \(group.items.count) 项").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            }
            HStack(spacing: 5) {
                Image(systemName: "laptopcomputer").font(.system(size: 11))
                Text(PhoneComputers.stateWords(reading?.state, lastSeen: reading?.lastSeen)).font(PhoneTheme.caption).lineLimit(1)
            }.foregroundStyle(PhoneTheme.muted)
        }.frame(minHeight: 48).contentShape(Rectangle())
            .accessibilityElement(children: .combine).accessibilityLabel("\(group.name)，离线前 \(group.items.count) 项，不是实时")
    }
}

private extension View {
    func otherRow() -> some View { listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 8, trailing: 20)).listRowBackground(Color.clear) }
}
