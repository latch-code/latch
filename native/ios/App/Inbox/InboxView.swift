import LatchNativeCore
import SwiftUI

/** 会话: a list that collapses into a push on the phone and stays beside the conversation on an iPad. */
struct InboxView: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.horizontalSizeClass) private var width
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(PhoneFaceID.key) private var faceID = false
    @State private var query = ""
    @State private var creating = false
    @State private var creatingWorkItem: PhoneWorkReadStamp?
    @State private var disclosure = PhoneShelfDisclosure()
    @State private var column = NavigationSplitViewColumn.sidebar
    private var showsConnectionStatus: Bool { !model.connected && (model.selectedHost != nil || model.offline || model.hostNotice != nil) }
    private var frozen: Bool { !model.connected }
    private var filtering: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var computer: String { model.selectedHost?.id ?? "" }
    private var selection: Binding<String?> {
        Binding(get: { model.sessionId }, set: { id in
            if let id { model.selectInboxSession(id) } else if model.sessionId != nil { model.closeSession() }
        })
    }
    var body: some View {
        NavigationSplitView(preferredCompactColumn: $column) {
            Group {
                if model.workItemsShown && model.offersWorkItems { WorkItemList(disclosure: $disclosure, showsConnectionStatus: showsConnectionStatus) }
                else { sessionList }
            }
            // The bar holds only the computer and the actions; 会话 | 待办 gets a full-width row under it, so a long
            // computer name never squeezes the switch.
            .safeAreaInset(edge: .top, spacing: 0) {
                if model.offersWorkItems {
                    Picker("Code 视图", selection: Binding(get: { model.workItemsShown }, set: model.showWorkItems)) {
                        Text("会话").tag(false)
                        Text("待办").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 6)
                    .background(PhoneTheme.canvas)
                }
            }
            .navigationTitle(model.offersWorkItems ? "Code" : "会话")
            .navigationBarTitleDisplayMode(.inline)
            .modifier(HiddenBarTitle(hidden: model.hosts.count > 1))
            .toolbar {
                if model.hosts.count > 1 {
                    ToolbarItem(placement: .topBarLeading) {
                        ComputerMenu().disabled(model.busy || model.verifying)
                    }
                }
                // 额度与用量 beside the session list, tinted when a subscription is nearly or wholly used.
                if !model.workItemsShown && !model.snapshot["catalog"]["harnesses"].array.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) { UsageToolbarButton() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if !model.workItemsShown {
                        Button("新会话", systemImage: "square.and.pencil") { creating = true }.labelStyle(.iconOnly).disabled(!model.connected)
                    } else if model.offersWorkCreation {
                        Button("新建待办", systemImage: "plus") {
                            Task { creatingWorkItem = await model.prepareWorkCreation() }
                        }.labelStyle(.iconOnly).disabled(model.busy || model.verifying || !model.pending.isEmpty)
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { VStack(spacing: 6) { PendingWritesBar(); ControlPendingBar() } }
            .syncTabBar(hidden: width != .compact && model.reviewTarget != nil)
        } detail: {
            // The review is the detail column's own stack, so 提交 is pushed on top of it; a destination of the list
            // replaces the detail column and cannot push again.
            if model.workItemsShown && model.offersWorkItems {
                if let id = model.workItemId { WorkItemStack(itemId: id).id(id) }
                else {
                    ContentUnavailableView("选择待办", systemImage: "checklist")
                        .foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity, maxHeight: .infinity).background(PhoneTheme.canvas)
                }
            } else if let target = model.reviewTarget { NavigationStack { ReviewView(target: target) }.id(target.sessionId) }
            else if let id = model.sessionId { ConversationView(id: id) }
            else {
                ContentUnavailableView("选择会话", systemImage: "bubble.left.and.bubble.right")
                    .frame(maxWidth: .infinity, maxHeight: .infinity).background(PhoneTheme.canvas)
            }
        }
        .sheet(isPresented: $creating, onDismiss: { model.openPendingImport() }) { NewSessionSheet().presentationCornerRadius(28) }
        .sheet(isPresented: Binding(get: { creatingWorkItem != nil }, set: { if !$0 { creatingWorkItem = nil } })) {
            if let stamp = creatingWorkItem, stamp == model.workCreationStamp {
                WorkItemCreationForm(stamp: stamp).presentationDetents([.medium, .large])
            }
        }
        .onChange(of: model.workCreationStamp) { _, updated in
            if creatingWorkItem != updated { creatingWorkItem = nil }
        }
        .onChange(of: computer) { _, _ in query = "" }
        .onChange(of: model.teamListReadKey(faceID: faceID), initial: true) { _, key in
            if key != nil { Task { await model.loadTeamList() } }
        }
        .onChange(of: model.privateSnapshot.epoch) { _, _ in query = "" }
        .onChange(of: model.reviewTarget?.sessionId) { _, id in if id != nil { column = .detail } else if model.sessionId == nil { column = .sidebar } }
        // Back to the list from the review leaves it.
        .onChange(of: model.workItemId, initial: true) { _, id in
            if model.workItemsShown { column = id == nil ? .sidebar : .detail }
        }
        .onChange(of: model.offersWorkItems) { _, supported in if !supported { model.resetWorkItems() } }
        .onChange(of: column) { _, now in
            if now == .sidebar {
                if model.workItemsShown { model.selectWorkItem(nil) }
                else if model.reviewTarget != nil { model.reviewTarget = nil }
            }
        }
        .modifier(SessionDialogs())
        #if LATCH_SCREENS
        .onAppear { if model.staged, !ScreensStage.query.isEmpty { query = ScreensStage.query } }
        .task(id: model.staged) { if model.staged, ScreensStage.creating { creating = true } }
        #endif
        // The Host searches once the typing settles; a later query or a closed window drops what an earlier one finds.
        .task(id: [query, computer, model.verifiedUntil == nil ? "closed" : "open", model.workItemsShown ? "work" : "sessions", model.showArchived ? "archived" : "current", model.canSearchContent ? "search" : "unavailable"]) {
            #if LATCH_SCREENS
            if model.staged { return }
            #endif
            guard !model.workItemsShown, PhoneSearch.query(query) != nil, model.canSearchContent, !model.showArchived else { model.contentSearch = PhoneContentSearch(); return }
            try? await Task.sleep(for: .milliseconds(300))
            if !Task.isCancelled { await model.searchContent(query) }
        }
    }
    private var sessionList: some View {
        let workspaces = model.snapshot["catalog"]["workspaces"].array
        // Code lists its own sessions; 我的 Agent's topics are in their conversations, as on the web.
        let tasks = PhoneSpaces.tasks(model.snapshot, in: .code)
        let shelves = model.shelves(query: query, archived: model.showArchived)
        let searching = PhoneSearch.query(query) != nil && model.canSearchContent && !model.showArchived
        return List(selection: selection) {
            InboxSearchField(query: $query, prompt: model.showArchived ? "搜索已归档的会话" : "搜索会话或项目", identifier: "inbox.search").plainRow()
            if showsConnectionStatus { CodeConnectionRow() }
            if model.offersTeamListUnlock(faceID: faceID) {
                Button {
                    Task { await model.loadTeamList(userInitiated: true) }
                } label: {
                    Label("查看团队关系", systemImage: "lock.open")
                        .font(.subheadline).foregroundStyle(PhoneTheme.ink2)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }.buttonStyle(.plain).plainRow()
            }
            if model.showArchived {
                Button { model.showArchived = false } label: { ArchivedLine(back: true, count: PhoneSessions.archived(tasks).count) }.buttonStyle(.plain).plainRow()
            }
            let others = model.showArchived || filtering ? [] : model.otherComputerGroups
            if !others.isEmpty, shelves.first?.id != "waiting" { OtherComputersSection(groups: others) }
            let waitingItems = model.showArchived || filtering ? 0 : model.workItems.filter { $0.group == .attention }.count
            if waitingItems > 0 && shelves.first?.id != "waiting" {
                Section { workWaitingLink(count: waitingItems).plainRow() } header: { ShelfHeader(label: "等你处理", count: nil) }
            }
            ForEach(shelves, id: \.id) { shelf in
                let collapsible = shelf.id.hasPrefix("project:") || shelf.id == "other"
                let collapsed = disclosure.isCollapsed(shelf.id, computer: computer, filtering: filtering)
                Section {
                    // Every group's title is a row of the same height, so the groups stand evenly apart.
                    if !collapsible && !shelf.label.isEmpty {
                        ShelfHeader(label: shelf.label, count: shelf.id == "waiting" && waitingItems > 0 ? nil : shelf.rows.count)
                            .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 0, trailing: 16))
                            .listRowSeparator(.hidden).listRowBackground(PhoneTheme.canvas)
                            .accessibilityAddTraits(.isHeader)
                    }
                    if collapsible {
                        FoldableListHeading(title: PhoneConversation.visible(shelf.label), count: shelf.rows.count, noun: "会话",
                            collapsed: collapsed, filtering: filtering, identifier: "inbox.project." + shelf.id,
                            symbol: shelf.id == "other" ? "bubble.left.and.bubble.right" : "folder") {
                            disclosure.toggle(shelf.id, computer: computer)
                        }
                    }
                    if waitingItems > 0 && shelf.id == "waiting" { workWaitingLink(count: waitingItems).plainRow() }
                    if !collapsed {
                        let visibleRows = shelf.rows.filter { row in row.parentId.map { !teamCollapsed($0) } ?? true }
                        ForEach(visibleRows) { row in
                            sessionRow(row, inWaiting: shelf.id == "waiting" || shelf.id == "running", workspaces: workspaces)
                                .tag(row.id)
                                .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 16))
                                .listRowBackground(model.sessionId == row.id ? PhoneTheme.selectedRow : PhoneTheme.canvas)
                                .listRowSeparatorTint(PhoneTheme.line)
                                .sessionActions(row.task, model: model)
                        }
                    }
                }
                if shelf.id == "waiting", !others.isEmpty { OtherComputersSection(groups: others) }
            }
            if shelves.isEmpty && !searching && !showsConnectionStatus { emptyState.plainRow() }
            if searching { ContentSearchSection(query: query) }
            if !model.showArchived, !filtering, case let count = PhoneSessions.archived(tasks).count, count > 0 {
                Button { model.showArchived = true } label: { ArchivedLine(back: false, count: count) }.buttonStyle(.plain).plainRow()
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(.compact)
        .tint(PhoneTheme.selectedRow)
        .scrollContentBackground(.hidden)
        .background(PhoneTheme.canvas)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await model.refreshInbox() }
    }

    private func teamCollapsed(_ lead: String) -> Bool {
        disclosure.isCollapsed("team:" + lead, computer: computer, filtering: filtering)
    }

    private func sessionRow(_ row: PhoneShelf.Row, inWaiting: Bool, workspaces: [NativeJSON]) -> some View {
        let task = row.task
        return HStack(spacing: 4) {
            InboxRow(task: task, frozen: frozen, inWaiting: inWaiting,
                project: inWaiting ? PhoneSessions.project(of: task, workspaces: workspaces)?["name"].string ?? "对话" : nil,
                isTeamMember: row.parentId != nil)
                .frame(maxWidth: .infinity, alignment: .leading)
            if row.memberCount > 0 {
                let collapsed = teamCollapsed(row.id)
                let title = PhoneConversation.visible(task["title"].string ?? "会话")
                if filtering {
                    Label("\(row.memberCount)", systemImage: "person.2")
                        .font(.caption).foregroundStyle(PhoneTheme.muted)
                        .accessibilityLabel("\(row.memberCount) 个匹配的团队成员")
                } else {
                    Button {
                        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
                            disclosure.toggle("team:" + row.id, computer: computer)
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(row.memberCount, format: .number).monospacedDigit()
                            Image(systemName: collapsed ? "chevron.forward" : "chevron.down").imageScale(.small)
                        }.font(.caption.weight(.medium)).foregroundStyle(PhoneTheme.ink2)
                            .padding(.horizontal, 8).padding(.vertical, 4).background(PhoneTheme.bubble, in: Capsule())
                            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel((collapsed ? "展开" : "收起") + "「" + title + "」的团队成员")
                    .accessibilityValue("\(row.memberCount) 个成员，" + (collapsed ? "已折叠" : "已展开"))
                }
            }
        }
        .padding(.vertical, 5)
        .padding(.leading, row.parentId == nil ? 0 : 26)
        .overlay(alignment: .leading) {
            if row.parentId != nil { TeamBranch(last: row.isLastMember).frame(width: 20) }
        }
        .contentShape(Rectangle())
    }

    private func workWaitingLink(count: Int) -> some View {
        Button { model.showWorkItems(true) } label: {
            HStack {
                Label("\(count) 项待办", systemImage: "checklist").foregroundStyle(PhoneTheme.ink)
                Spacer()
                Image(systemName: "chevron.right").foregroundStyle(PhoneTheme.muted)
            }.frame(minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityHint("打开待办中的等你处理")
    }

    @ViewBuilder private var emptyState: some View {
        if model.connected && !model.snapshot["tasksComplete"].bool {
            VStack(spacing: 4) {
                Text("会话列表尚未完整").font(.subheadline).foregroundStyle(PhoneTheme.muted)
                Button("刷新会话") { Task { await model.refreshInbox() } }
                    .font(.subheadline.weight(.medium)).foregroundStyle(PhoneTheme.accent)
            }.frame(maxWidth: .infinity).padding(.vertical, 20)
        } else if model.showArchived { Text("没有已归档的会话").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.top, 48) }
        else if filtering { Text("没有符合的会话").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.top, 48) }
        else if model.connected {
            VStack(spacing: 8) {
                Text("还没有会话").font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink)
                Button("新会话") { creating = true }.font(.body.weight(.medium)).foregroundStyle(PhoneTheme.accent)
            }.frame(maxWidth: .infinity).padding(.top, 48)
        }
    }
}

struct InboxSearchField: View {
    @EnvironmentObject private var model: PhoneModel
    @Binding var query: String
    let prompt: String
    let identifier: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(PhoneTheme.muted).accessibilityHidden(true)
            LocalSearchInput(query: $query, prompt: prompt, identifier: identifier)
                .id([model.generation, model.privateSnapshot.epoch])
        }.font(.subheadline).padding(.leading, 12).padding(.trailing, 4)
            .frame(minHeight: 44).background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 12))
            .onChange(of: model.verifiedUntil == nil) { _, closed in if closed { query = "" } }
    }
}

private extension View {
    func plainRow() -> some View { tint(PhoneTheme.ink).listRowSeparator(.hidden).listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16)) }
    /** The session menu held down, and swiped: 已读 and 置顶 from the leading edge, 归档 and 删除 from the trailing one. */
    @ViewBuilder func sessionActions(_ task: NativeJSON, model: PhoneModel) -> some View {
        if PhoneSessionMenu.sections(task, canRun: model.canRun).isEmpty { self }
        else {
            let busy = model.busy || !model.connected
            contextMenu { SessionMenuButtons(task: task) }
                .swipeActions(edge: .leading) {
                    // A new answer can be marked read without opening it; this device keeps what it has seen.
                    if model.unread(task), let id = task["id"].string {
                        Button("标为已读", systemImage: "checkmark.circle") { model.markSeen(id) }.tint(PhoneTheme.accent)
                    }
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

struct FoldableListHeading: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection
    let title: String
    let count: Int
    let noun: String
    let collapsed: Bool
    let filtering: Bool
    let identifier: String
    var symbol: String? = nil
    var titleColor = PhoneTheme.ink
    let toggle: () -> Void

    var body: some View {
        // A group's title is a quiet line, not a card: the rows are what is read.
        let label = HStack(spacing: 7) {
            if let symbol { Image(systemName: symbol).font(.footnote.weight(.medium)).foregroundStyle(PhoneTheme.muted) }
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(titleColor).lineLimit(2)
            Text(count, format: .number).font(.caption.monospacedDigit()).foregroundStyle(PhoneTheme.faint)
            Spacer(minLength: 4)
            if !filtering {
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold)).foregroundStyle(PhoneTheme.faint).frame(width: 12)
                    .rotationEffect(.degrees(collapsed ? (layoutDirection == .rightToLeft ? 90 : -90) : 0))
            }
        }.padding(.horizontal, 4).frame(minHeight: 44).contentShape(Rectangle())
        Group {
            if filtering {
                label.accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
            } else {
                Button {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
                        toggle()
                    }
                } label: { label }
                    .buttonStyle(.plain)
                    .accessibilityLabel(title)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityValue("\(count) 个\(noun)，" + (collapsed ? "已折叠" : "已展开"))
                    .accessibilityHint((collapsed ? "展开" : "折叠") + noun)
                    .accessibilityIdentifier(identifier)
            }
        }
        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 0, trailing: 16))
        .listRowSeparator(.hidden).listRowBackground(PhoneTheme.canvas)
    }
}

private struct ShelfHeader: View {
    let label: String
    let count: Int?
    var body: some View {
        HStack(spacing: 7) {
            Text(label).font(.subheadline.weight(.semibold)).foregroundStyle(PhoneTheme.ink).lineLimit(2)
            if let count { Text("\(count)").font(.caption.monospacedDigit()).foregroundStyle(PhoneTheme.faint) }
            Spacer(minLength: 0)
        }.textCase(nil).padding(.horizontal, 4).frame(minHeight: 44)
    }
}

/** The same connection status and recovery action precede each Code list. */
struct CodeConnectionRow: View {
    @EnvironmentObject private var model: PhoneModel
    var body: some View {
        Group {
            if let notice = model.hostNotice {
                HostNoticeBanner(words: notice.words(computer: model.selectedHost.map(model.computerName) ?? "Mac")).plainRow()
            } else if model.offline {
                HStack(spacing: 10) {
                    Image(systemName: "wifi.slash").font(.subheadline).foregroundStyle(PhoneTheme.amberIcon)
                    VStack(alignment: .leading, spacing: 2) {
                        Text((model.selectedHost.map(model.computerName) ?? "Mac") + " 不在线")
                            .font(.subheadline.weight(.medium)).foregroundStyle(PhoneTheme.ink)
                        if let at = model.lastConfirmed {
                            Text("上次在线 " + PhoneTime.message(at)).font(.caption).foregroundStyle(PhoneTheme.muted)
                        }
                    }
                    Spacer(minLength: 4)
                    Button { model.retryConnection() } label: {
                        Text("重试").font(.subheadline.weight(.medium)).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.borderless).foregroundStyle(PhoneTheme.ink)
                }
                .padding(.horizontal, 12).padding(.vertical, 4)
                .background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 12)).plainRow()
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在连接…").font(.subheadline).foregroundStyle(PhoneTheme.muted)
                }.plainRow()
            }
        }
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

private struct TeamBranch: View {
    @Environment(\.layoutDirection) private var direction
    let last: Bool

    var body: some View {
        Canvas { context, size in
            let rtl = direction == .rightToLeft
            let trunk: CGFloat = rtl ? size.width - 5 : 5
            let end: CGFloat = rtl ? 0 : size.width
            let middle = size.height / 2
            var branch = Path()
            branch.move(to: CGPoint(x: trunk, y: 0))
            if last {
                branch.addLine(to: CGPoint(x: trunk, y: middle - 5))
                branch.addQuadCurve(to: CGPoint(x: trunk + (rtl ? -5 : 5), y: middle),
                                    control: CGPoint(x: trunk, y: middle))
            } else {
                branch.addLine(to: CGPoint(x: trunk, y: size.height))
                branch.move(to: CGPoint(x: trunk, y: middle))
            }
            branch.addLine(to: CGPoint(x: end, y: middle))
            context.stroke(branch, with: .color(PhoneTheme.lineStrong), lineWidth: 1)
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}

/**
 * A session row as the leading agent apps lay it out, in the web's words: its Harness with a mark for what needs you
 * (amber), what failed (red) or a new answer (blue); the title with the time, or the run's clock while it works; then
 * what it is doing or waits on, the Harness and its project or branch.
 */
struct InboxRow: View {
    @EnvironmentObject private var model: PhoneModel
    let task: NativeJSON
    let frozen: Bool
    let inWaiting: Bool
    let project: String?
    let isTeamMember: Bool
    private var status: PhoneRowStatus { PhoneSessions.rowStatus(task, frozen: frozen) }
    private var selected: Bool { model.sessionId == task.id }
    var body: some View {
        let status = status, unread = !selected && model.unread(task), mark = PhoneSessions.mark(status, unread: unread)
        let title = PhoneConversation.visible(task["title"].string ?? "会话")
        HStack(alignment: .top, spacing: 10) {
            RowMarkTile(mark: model.engineMark(task["harnessId"].string), state: mark).padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(title).font(.body.weight(selected ? .semibold : (mark != nil && mark != .running) || unread ? .medium : .regular))
                        .foregroundStyle(PhoneTheme.ink).lineLimit(2)
                        .accessibilityLabel((isTeamMember ? "团队成员，" : "") + title)
                    Spacer(minLength: 4)
                    RowTrailing(task: task, status: status).layoutPriority(1)
                }
                RowSecondLine(task: task, status: status, meta: ([model.engineName(task["harnessId"].string)] + [PhoneSessions.rowMeta(task, project: project)].compactMap { $0 }).joined(separator: " · "),
                    awaitingReturn: task["id"].string.map { PhoneHandoffs.awaiting(model.snapshot).contains($0) } ?? false)
                if let id = task["id"].string, let label = model.reviewShortcuts[id] {
                    Button { model.openReview(id) } label: {
                        HStack(spacing: 4) {
                            Text(label).font(.system(size: 13, weight: .medium))
                            Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                        }.foregroundStyle(PhoneTheme.ink).padding(.horizontal, 10).frame(minHeight: 30).background(PhoneTheme.bubble, in: Capsule())
                    }.buttonStyle(.borderless).padding(.top, 3).accessibilityHint("打开复核页")
                }
            }
        }
        .frame(minHeight: 48, alignment: .center).accessibilityElement(children: .contain)
        .accessibilityValue(unread ? "有新内容" : "")
    }
}

/** The Harness's mark with a small dot at its corner for the row's state; a working run says so on its clock instead. */
private struct RowMarkTile: View {
    let mark: String?
    let state: PhoneSessions.Mark?
    var body: some View {
        EngineTile(mark: mark, size: 20)
            .overlay(alignment: .bottomTrailing) {
                if let color {
                    Circle().fill(color).frame(width: 8, height: 8)
                        .overlay(Circle().stroke(PhoneTheme.canvas, lineWidth: 2))
                        .offset(x: 3, y: 3)
                        .accessibilityHidden(true)
                }
            }
            .frame(width: 22, height: 22)
    }
    private var color: Color? {
        switch state {
        case .waiting, .unknown: PhoneTheme.amberIcon
        case .failed: PhoneTheme.red
        case .unread: PhoneTheme.accent
        case .running, .silent, nil: nil
        }
    }
}

/** The time it last changed, or, while it works, a small ring and the run's clock, counted on the Host's clock. */
private struct RowTrailing: View {
    @EnvironmentObject private var model: PhoneModel
    let task: NativeJSON
    let status: PhoneRowStatus
    var body: some View {
        switch status {
        case .running, .stopping, .silent:
            // The ring sits on the clock's line, so the row keeps the height of a row at rest.
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    ProgressView().controlSize(.mini).tint(PhoneTheme.accent)
                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                    Text(PhoneSessions.runningClock(task["live"], hostNow: model.hostNow()) ?? "").font(PhoneTheme.caption.monospacedDigit()).foregroundStyle(PhoneTheme.ink2)
                }
            }
        case .frozen:
            EmptyView()
        default:
            Text(PhoneTime.parse(task["updatedAt"]).map { PhoneTime.relative($0) } ?? "").font(PhoneTheme.caption.monospacedDigit()).foregroundStyle(PhoneTheme.muted)
        }
    }
}

/** What the row is doing or waits on, in its tone, then the Harness and its place; a row at rest says only the latter. */
private struct RowSecondLine: View {
    @EnvironmentObject private var model: PhoneModel
    let task: NativeJSON
    let status: PhoneRowStatus
    let meta: String
    let awaitingReturn: Bool
    var body: some View {
        HStack(spacing: 5) {
            phrase
            Text(meta).foregroundStyle(PhoneTheme.muted).lineLimit(1).layoutPriority(-1)
            if awaitingReturn {
                Spacer(minLength: 4)
                Text("待交回").foregroundStyle(PhoneTheme.amber)
            }
        }.font(.caption)
    }
    @ViewBuilder private var phrase: some View {
        switch status {
        case .waiting: said(PhoneSessions.waitWords(task).map { "等你处理 · " + $0 } ?? "等你处理", PhoneTheme.amber)
        case .silent:
            TimelineView(.periodic(from: .now, by: 30)) { _ in said(PhoneSessions.silentWords(task["live"], hostNow: model.hostNow()), PhoneTheme.muted) }
        case .stopping: said("正在停止", PhoneTheme.ink2)
        case .running: said(PhoneSessions.activityWords(task["live"]), PhoneTheme.ink2)
        case .failed: said("失败", PhoneTheme.red)
        case let .ended(word, unknown): said(word, unknown > 0 ? PhoneTheme.amber : PhoneTheme.muted)
        case .frozen: said(model.lastConfirmed.map { "上次确认 " + PhoneTime.message($0) } ?? "状态未更新", PhoneTheme.muted)
        case .read: EmptyView()
        }
    }
    private func said(_ words: String, _ tone: Color) -> some View {
        HStack(spacing: 5) {
            Text(words).foregroundStyle(tone).lineLimit(1).fixedSize()
            Text("·").foregroundStyle(PhoneTheme.faint)
        }
    }
}

struct TightLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View { HStack(spacing: 4) { configuration.icon; configuration.title } }
}

/**
 * A write whose answer never came blocks every later one until it is sent again, so the list offers it too, not only the
 * conversation it belongs to.
 */
struct PendingWritesBar: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var checked: String?
    @State private var abandoningWork: NativePendingWrite?
    var body: some View {
        if let checked {
            Label(checked, systemImage: "info.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).padding(.horizontal, 16)
                .task { try? await Task.sleep(for: .seconds(6)); self.checked = nil }
        }
        ForEach(model.writesAwaitingConfirmation, id: \.requestId) { pending in
            HStack {
                Label(PhoneWorkChange(pending)?.pendingWords ?? PhoneReview.pendingWords(pending) ?? PhoneDelivery.pendingWords(pending) ?? PhoneFileEdit.pendingWords(pending) ?? PhoneHandoffs.pendingWords(pending) ?? PhoneAgentWrites.words(pending, proposals: model.proposals.all.flatMap { $0 }), systemImage: "clock").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                Spacer()
                if PhoneWorkChange(pending) != nil {
                    Button("放弃重试") { abandoningWork = pending }.font(PhoneTheme.caption).disabled(model.busy)
                } else if PhoneHistory.isImport(pending) {
                    Button("核对并放下") { Task { checked = await model.checkImportFromList(pending) ?? "没能核对，稍后再试" } }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                } else if PhoneAgentWrites.handles(pending) && !PhoneHelperCreate.isCreation(pending) {
                    Button("核对并放下") { Task { checked = await model.checkAgentWrite(pending) ?? "没能核对，稍后再试" } }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                } else if PhoneDelivery.isStage(pending) || PhoneFileEdit.pendingSave(pending) != nil {
                    Button("核对并放下") { Task { checked = await model.checkAndDrop(pending) ?? "没能核对，稍后再试" } }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                }
                let retryLabel: String = switch PhoneWorkChange(pending) {
                case .creation: "核对保存结果"
                case .post(_, _, .some): "核对投递"
                default: "重试这次提交"
                }
                if pending.teamRound == nil {
                    Button(retryLabel) {
                        Task {
                            // A new topic's start opens its topic in 我的 Agent, where the conversation with that Agent is.
                            if let owner = PhonePending.topicOwner(pending) {
                                if await model.finishTopic(pending) { model.tab = .agents; model.agentPath = [owner] }
                            } else { await model.retryPending(pending) }
                        }
                    }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                }
                if pending.teamRound != nil || PhoneQueueControl(pending) != nil { AbandonSessionWrite(pending: pending) }
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
        .confirmationDialog("放弃重试这次待办操作？", isPresented: Binding(get: { abandoningWork != nil }, set: { if !$0 { abandoningWork = nil } }), presenting: abandoningWork) { request in
            Button("放弃重试", role: .destructive) { Task { await model.abandonWorkChange(request) } }
            Button("取消", role: .cancel) {}
        } message: { _ in Text("电脑可能已经处理。放弃重试不会撤回已经完成的操作。") }
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
                // Capped so the dot and chevron stay and the trailing actions keep their room.
                Text(model.selectedHost.map(model.computerName) ?? "选择 Mac").lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: 190, alignment: .leading)
                // Something waits on another computer that answers now: an amber dot, no number, as the tab bar's.
                if rows.contains(where: { !$0.selected && $0.state == .online && $0.waiting > 0 }) {
                    Circle().fill(PhoneTheme.amberIcon).frame(width: 6, height: 6).accessibilityLabel("其他电脑有等你处理")
                }
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
            }
        }
    }
}

/** The computer menu names the list, so the centred title gives way to it; before iOS 18 the bar drops the title itself when room runs out. */
private struct HiddenBarTitle: ViewModifier {
    let hidden: Bool
    func body(content: Content) -> some View {
        if hidden, #available(iOS 18, *) { content.toolbar(removing: .title) } else { content }
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
