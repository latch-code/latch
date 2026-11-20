import LatchNativeCore
import SwiftUI

struct WorkItemList: View {
    @EnvironmentObject private var model: PhoneModel
    let showsConnectionStatus: Bool

    var body: some View {
        WorkItemRows(list: PhoneWorkList(items: model.workItems, snapshot: model.snapshot), showsConnectionStatus: showsConnectionStatus)
            .id(model.selectedHost?.id)
    }
}

private struct WorkItemRows: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var query = ""
    @State private var selectedProjects = Set<PhoneWorkList.Project>()
    let list: PhoneWorkList
    let showsConnectionStatus: Bool

    private var selection: Binding<String?> { Binding(get: { model.workItemId }, set: model.selectWorkItem) }

    var body: some View {
        let projects = selectedProjects.intersection(list.projects)
        let items = list.matching(title: query, projects: projects)
        let filtering = !projects.isEmpty || !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        List(selection: selection) {
            let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6)) : AnyLayout(HStackLayout(spacing: 8))
            layout {
                InboxSearchField(query: $query, prompt: "搜索待办标题", identifier: "work.search")
                if !list.projects.isEmpty {
                    // Withdraw an open menu with the window that supplied its private project options.
                    projectFilter(projects).id(model.mayReadPrivateWork)
                }
            }
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            .listRowSeparator(.hidden).listRowBackground(PhoneTheme.canvas)
            if showsConnectionStatus { CodeConnectionRow() }
            ForEach(PhoneWorkGroup.allCases, id: \.self) { group in
                groupSection(items.filter { $0.group == group }, group: group)
            }
            groupSection(items.filter { $0.group == nil }, group: nil)
            if items.isEmpty && filtering {
                VStack(spacing: 6) {
                    Text("当前列表没有匹配的待办").font(.subheadline).foregroundStyle(PhoneTheme.muted)
                    Button("清除搜索和筛选") { query = ""; selectedProjects = [] }
                        .font(.subheadline.weight(.medium)).foregroundStyle(PhoneTheme.accent)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 20).listRowSeparator(.hidden)
            } else if items.isEmpty, model.connected {
                Text(model.hasContentWindow ? "还没有待办" : "没有可显示的待办")
                    .font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.vertical, 24)
                    .listRowSeparator(.hidden)
            }
            if model.connected && model.snapshot["device"]["dataScope"].string == "all" && !model.mayReadPrivateWork {
                Button { Task { await model.openWorkWindow() } } label: {
                    Label(model.verifying ? "正在验证…" : "查看全部待办", systemImage: "lock.open")
                        .font(.subheadline).foregroundStyle(PhoneTheme.ink).frame(minHeight: 44)
                }.buttonStyle(.plain).disabled(model.verifying).listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden)
        // A split-view list uses its tint for the selected row's fill. Keep the tab's ink tint out of that surface.
        .tint(PhoneTheme.selectedRow)
        .background(PhoneTheme.canvas)
        .onChange(of: list.projects) { _, available in selectedProjects.formIntersection(available) }
        .onChange(of: model.privateSnapshot.epoch) { _, _ in query = ""; selectedProjects = [] }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await model.refreshInbox() }
    }

    private func projectFilter(_ selected: Set<PhoneWorkList.Project>) -> some View {
        let label: String
        if selected.count == 1, let project = selected.first { label = list.name(of: project) }
        else { label = selected.isEmpty ? "项目" : "项目 · \(selected.count)" }
        return Menu {
            Button { selectedProjects = [] } label: {
                if selected.isEmpty { Label("全部项目", systemImage: "checkmark") } else { Text("全部项目") }
            }
            Divider()
            ForEach(list.projects, id: \.self) { project in
                Toggle(PhoneConversation.visible(list.name(of: project)), isOn: Binding(get: { selectedProjects.contains(project) }, set: { checked in
                    if checked { selectedProjects.insert(project) } else { selectedProjects.remove(project) }
                }))
            }
        } label: {
            HStack(spacing: 6) {
                if selected.isEmpty { Image(systemName: "line.3.horizontal.decrease") }
                Text(PhoneConversation.visible(label)).lineLimit(1).truncationMode(.middle)
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
            }
            .font(.subheadline).foregroundStyle(PhoneTheme.ink)
            .padding(.horizontal, 10).frame(maxWidth: 160, minHeight: 44)
            .fixedSize(horizontal: true, vertical: false)
            .background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 12))
        }
        .menuActionDismissBehavior(.disabled)
        .accessibilityLabel("筛选待办项目")
        .accessibilityValue(selected.isEmpty ? "全部项目" : PhoneConversation.visible(label))
        .accessibilityIdentifier("work.projects")
    }

    @ViewBuilder private func groupSection(_ rows: [PhoneWorkItemSummary], group: PhoneWorkGroup?) -> some View {
        if !rows.isEmpty {
            Section {
                ForEach(rows) { item in row(item).tag(item.id) }
            } header: {
                HStack(spacing: 8) {
                    Text(group?.label ?? "状态未确认").font(.subheadline.weight(.semibold))
                    Text(rows.count, format: .number).font(.caption.monospacedDigit()).foregroundStyle(PhoneTheme.muted)
                }
                .textCase(nil).foregroundStyle(group == .attention ? PhoneTheme.amber : PhoneTheme.ink)
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func row(_ item: PhoneWorkItemSummary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(PhoneConversation.visible(item.title)).font(.body.weight(model.workItemId == item.id ? .semibold : .medium)).foregroundStyle(PhoneTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let project = projectName(item.projectId, snapshot: model.snapshot) {
                Label(PhoneConversation.visible(project), systemImage: "folder")
                    .labelStyle(TightLabel()).font(.caption).foregroundStyle(PhoneTheme.muted).lineLimit(2)
            }
            if let reason = item.reason, item.group == .attention { WorkStatus(reason: reason) }
        }.frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
            .listRowInsets(EdgeInsets(top: 5, leading: 20, bottom: 5, trailing: 20))
            .listRowBackground(model.workItemId == item.id ? PhoneTheme.selectedRow : PhoneTheme.canvas)
            .listRowSeparatorTint(PhoneTheme.line)
            .contentShape(Rectangle()).accessibilityElement(children: .combine)
    }
}

/** Saves a work item without choosing an engine or starting a session. */
struct WorkItemCreationForm: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let stamp: PhoneWorkReadStamp
    @State private var title = ""
    @State private var prompt = ""
    @State private var projectId: String?
    @State private var composingTitle = false
    @State private var composingPrompt = false
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        let projects = PhoneStart.projects(model.snapshot["catalog"]).filter { $0.id != "default" }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let projectMissing = projectId != nil && !projects.contains { $0.id == projectId }
        let invalidTitle = cleanTitle.unicodeScalars.count > 120 || cleanTitle.rangeOfCharacter(from: .newlines) != nil
        let longPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count > 16_000
        NavigationStack {
            Form {
                Section("标题") {
                    LocalTextEditor(text: $title, placeholder: "待办标题", maximumLines: 2, minimumLines: 2, composing: $composingTitle)
                    if invalidTitle { Text("标题最多 120 个字，只能写一行").font(.caption).foregroundStyle(PhoneTheme.red) }
                }
                Section("要求（选填）") {
                    LocalTextEditor(text: $prompt, placeholder: "待办要求", maximumLines: 6, minimumLines: 4, composing: $composingPrompt)
                    if longPrompt { Text("要求最多 16,000 个字符").font(.caption).foregroundStyle(PhoneTheme.red) }
                }
                Section {
                    Picker("项目", selection: $projectId) {
                        Text("无项目").tag(String?.none)
                        ForEach(projects) { project in Text(PhoneConversation.visible(project.name)).tag(Optional(project.id)) }
                        if projectMissing { Text("项目不可用").tag(projectId) }
                    }
                } footer: {
                    Text("保存后列入「未开始」。")
                }
                if let error { Text(error).font(.subheadline).foregroundStyle(PhoneTheme.red) }
            }
            .disabled(saving)
            .navigationTitle("新建待办").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存待办") { Task { await save() } }
                        .disabled(saving || model.busy || !model.pending.isEmpty || cleanTitle.isEmpty || invalidTitle || longPrompt
                            || projectMissing || composingTitle || composingPrompt || model.workCreationStamp != stamp)
                }
            }
        }.interactiveDismissDisabled(saving)
    }

    private func save() async {
        guard !saving else { return }
        saving = true; defer { saving = false }
        let outcome = await model.saveWorkItem(title: title, prompt: prompt, project: projectId, stamp: stamp)
        guard model.workCreationStamp == stamp else { return }
        switch outcome {
        case .done, .unknown: dismiss()
        default: error = workChangeFailure(outcome)
        }
    }
}

struct WorkItemStack: View {
    @EnvironmentObject private var model: PhoneModel
    let itemId: String
    @State private var anchor: String?

    var body: some View {
        NavigationStack(path: Binding(get: { model.workPath }, set: model.setWorkPath)) {
            Group {
                if let item = model.workItem(itemId) {
                    if let stamp = model.workStamp(itemId) { WorkItemContents(itemId: itemId, stamp: stamp, anchor: $anchor).id(stamp) }
                    else { locked(item) }
                } else if !model.connected {
                    WorkConnectionLine()
                } else if !model.hasContentWindow {
                    WorkUnlock(label: "查看待办")
                } else {
                    ContentUnavailableView("待办不可用", systemImage: "checklist")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(PhoneTheme.canvas)
            .navigationTitle("待办").navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: PhoneWorkDestination.self) { destination in
                if let stamp = model.workStamp(itemId) {
                    if model.workDestinationAllowed(destination, itemId: itemId) { page(destination, stamp: stamp).id(stamp) }
                    else { ContentUnavailableView(model.workSourceVisibility(destination.sourceSession).notice ?? "会话不可用", systemImage: "bubble.left") }
                } else { WorkUnlock(label: "查看待办") }
            }
        }
    }

    private func locked(_ item: PhoneWorkItemSummary) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            WorkItemHeading(item: item)
            if model.connected { WorkUnlock(label: "查看待办") }
            else { WorkConnectionLine(detail: "当前只显示已保存的待办摘要。打开讨论需要连接电脑。") }
            Spacer(minLength: 0)
        }.padding(20).frame(maxWidth: 720, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder private func page(_ destination: PhoneWorkDestination, stamp: PhoneWorkReadStamp) -> some View {
        switch destination {
        case let .source(source):
            WorkSourceView(itemId: itemId, source: source, stamp: stamp)
        case let .session(id):
            WorkSessionPage(itemId: itemId, sessionId: id)
        case let .reply(post, message, source):
            WorkReplyView(itemId: itemId, stamp: stamp, postId: post, messageId: message, source: source)
        case let .review(session, turn):
            if PhoneSessions.mayReadBody(snapshot: model.snapshot, sessionId: session) {
                ReviewView(target: PhoneReviewTarget(sessionId: session, turnId: turn, work: stamp))
            } else { ContentUnavailableView("会话不可用", systemImage: "bubble.left") }
        case let .evidence(session):
            WorkEvidenceView(itemId: itemId, sessionId: session, stamp: stamp)
        case let .commit(session, sha):
            WorkCommitView(itemId: itemId, sessionId: session, sha: sha, stamp: stamp)
        case let .commitFile(session, sha, path):
            WorkCommitFileView(itemId: itemId, sessionId: session, sha: sha, path: path, stamp: stamp)
        case let .pullRequest(session, number):
            WorkPullRequestView(itemId: itemId, sessionId: session, number: number, stamp: stamp)
        case let .checkLog(session, number, sha, job):
            WorkCheckLogView(itemId: itemId, sessionId: session, number: number, sha: sha, job: job, stamp: stamp)
        }
    }
}

private struct WorkItemReadout {
    let detail: PhoneWorkItemDetail
    var posts: [PhoneWorkPost]
    var before: String?
    let threadRevision: UInt64
    var attention: PhoneWorkPost?

    mutating func withdrawUnreadableSources(_ snapshot: NativeJSON) {
        posts = posts.map { $0.projectingSource(snapshot) }
        attention = attention?.projectingSource(snapshot)
    }

    func currentPost(_ id: String) -> PhoneWorkPost? { attention?.id == id ? attention : posts.first { $0.id == id } }
}

private struct WorkItemContents: View {
    @EnvironmentObject private var model: PhoneModel
    let itemId: String
    let stamp: PhoneWorkReadStamp
    @Binding var anchor: String?
    @State private var value: WorkItemReadout?
    @State private var failure: String?
    @State private var pageFailure: String?
    @State private var loadingMore = false
    @State private var ticket = UUID()
    @State private var writingPost = false
    @State private var actionNotice: String?

    private var unreadableSources: [String] {
        guard let value else { return [] }
        let sources = Set(value.posts.compactMap(\.sourceSessionId) + [value.attention?.sourceSessionId].compactMap { $0 })
        return sources.sorted().compactMap { id in
            let state = model.workSourceVisibility(id)
            return state == .readable ? nil : id + ":" + state.rawValue
        }
    }

    private var refreshKey: [String] {
        guard let item = model.workItem(itemId) else { return [] }
        let members = item.sessionIds.map { id -> String in
            let task = model.summary(of: id)
            return [id, task["runId"].string ?? "", task["status"].string ?? ""].joined(separator: ":")
        }
        return [model.connected ? "online" : "offline", item.id, String(item.revision), String(item.threadRevision ?? 0),
                item.group?.rawValue ?? "", item.reason?.rawValue ?? "", item.postId ?? "", stamp.network.uuidString] + members + unreadableSources
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                if !model.connected { WorkConnectionLine(detail: "打开讨论和交付证据需要连接电脑。") }
                if let item = model.workItem(itemId) { WorkItemHeading(item: item).id(itemId) }
                if let failure {
                    WorkReadNotice(title: failure) { await load() }
                }
                if let actionNotice { Text(actionNotice).font(.subheadline).foregroundStyle(PhoneTheme.amber) }
                if let value {
                    attention(value)
                    instructions(value.detail)
                    sessions()
                    discussion(value)
                } else if failure == nil, model.connected {
                    WorkLoading(label: "正在读取待办…")
                }
            }
            .scrollTargetLayout()
            .padding(.horizontal, 20).padding(.vertical, 18)
            .frame(maxWidth: 720, alignment: .leading).frame(maxWidth: .infinity)
        }
        .scrollPosition(id: $anchor)
        .refreshable { _ = await model.refresh(); await load() }
        .toolbar {
            if model.canRun, let detail = value?.detail {
                Button(detail.closed ? "重新打开" : "标为完成") {
                    Task { _ = await perform(.completion(item: itemId, revision: detail.item.revision, closed: !detail.closed)) }
                }.disabled(model.busy || !model.pending.isEmpty || detail.item.revision != model.workItem(itemId)?.revision)
            }
        }
        .sheet(isPresented: $writingPost) {
            WorkPostComposer(itemId: itemId, stamp: stamp) { change in await perform(change) }
                .presentationDetents([.medium, .large])
        }
        .task(id: refreshKey) { await load() }
        .onChange(of: unreadableSources) { _, absent in
            if !absent.isEmpty { value?.withdrawUnreadableSources(model.snapshot) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { VStack(spacing: 6) { PendingWritesBar(); ControlPendingBar() } }
    }

    @ViewBuilder private func attention(_ value: WorkItemReadout) -> some View {
        let item = model.workItem(itemId) ?? value.detail.item
        if let postId = item.postId, let read = value.currentPost(postId) {
            let post = read.projectingSource(model.snapshot)
            VStack(alignment: .leading, spacing: 10) {
                if let reason = post.attention ?? item.reason { WorkStatus(reason: reason) }
                Text(PhoneConversation.visible(post.text)).font(.subheadline).lineLimit(3)
                if let refusal = post.refusal { Text(PhoneConversation.visible(refusal)).font(.subheadline).foregroundStyle(PhoneTheme.muted) }
                if let source = post.source, post.attention != nil {
                    WorkRouteLink(title: source.decision == nil ? "查看原回合" : source.decision?.kind == .question ? "前往提问" : "前往审批",
                                  icon: "arrow.turn.down.right", destination: .source(source))
                        .disabled(!model.connected)
                }
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(PhoneTheme.line))
        }
    }

    @ViewBuilder private func instructions(_ detail: PhoneWorkItemDetail) -> some View {
        if !detail.prompt.isEmpty || detail.note != nil || detail.origin != nil {
            VStack(alignment: .leading, spacing: 10) {
                WorkSectionTitle(title: "要求")
                if !detail.prompt.isEmpty { ConversationText(text: detail.prompt, markdown: true) }
                if let note = detail.note { Text(PhoneConversation.visible(note)).font(.subheadline).foregroundStyle(PhoneTheme.muted) }
                if let origin = detail.origin, PhoneSessions.mayReadBody(snapshot: model.snapshot, sessionId: origin.sessionId) {
                    WorkRouteLink(title: "查看提议来源", icon: "arrow.turn.down.right", destination: .source(origin))
                        .disabled(!model.connected)
                }
            }
        }
    }

    @ViewBuilder private func sessions() -> some View {
        let members = model.workItem(itemId)?.sessionIds ?? []
        let summaries = members.filter { model.workSourceVisibility($0) == .readable }.map { model.summary(of: $0) }
        if !summaries.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                WorkSectionTitle(title: "关联会话")
                ForEach(summaries, id: \.id) { session in
                    WorkLinkedSession(session: session)
                }
            }
        }
    }

    private func discussion(_ value: WorkItemReadout) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                WorkSectionTitle(title: "讨论")
                Spacer()
                if model.canRun {
                    Button("写发言", systemImage: "square.and.pencil") { writingPost = true }
                        .font(.subheadline).disabled(model.busy || !model.pending.isEmpty)
                }
            }
            if value.posts.isEmpty { Text("还没有发言").font(.subheadline).foregroundStyle(PhoneTheme.muted) }
            if let before = value.before {
                Button { Task { await older(before) } } label: {
                    Label(loadingMore ? "正在读取…" : "阅读更早的发言", systemImage: "clock.arrow.circlepath")
                        .font(.subheadline).frame(minHeight: 44)
                }.buttonStyle(.plain).disabled(loadingMore || !model.connected)
                if let pageFailure { Text(pageFailure).font(.subheadline).foregroundStyle(PhoneTheme.amber) }
            }
            ForEach(value.posts) { post in
                WorkPostRow(post: post).id(post.id)
                if post.delivery == .unknown || post.delivery == .sending {
                    Button("核对投递") { Task { await checkPost(post.id) } }.disabled(!model.connected)
                }
            }
        }
    }

    private func checkPost(_ id: String) async {
        let reading = ticket
        do {
            let answer = try await model.readWork(.post(itemId, post: id), itemId: itemId, stamp: stamp)
            guard let post = PhoneWorkPost(answer["post"]), post.id == id, reading == ticket else { return }
            model.publishWork(stamp, itemId: itemId) {
                let next = post.projectingSource(model.snapshot)
                if let index = value?.posts.firstIndex(where: { $0.id == id }) { value?.posts[index] = next }
                if value?.attention?.id == id { value?.attention = next }
            }
        } catch { if reading == ticket, stamp == model.workStamp(itemId) { actionNotice = workReadWords(error, fallback: "投递结果尚未确认") } }
    }

    private func perform(_ change: PhoneWorkChange) async -> PhoneWriteOutcome {
        actionNotice = nil
        let result = await model.workChange(change, stamp: stamp)
        guard stamp == model.workStamp(itemId) else { return result }
        if case .unknown = result { actionNotice = nil } else { actionNotice = workChangeFailure(result) }
        await model.refresh(includeSelectedBody: false)
        if stamp == model.workStamp(itemId) { await load() }
        return result
    }

    private func load() async {
        guard model.connected, stamp == model.workStamp(itemId) else { return }
        let mine = UUID(); ticket = mine; loadingMore = false; pageFailure = nil
        do {
            let raw = try await model.readWork(.item(itemId), itemId: itemId, stamp: stamp)
            let detail = try PhoneWorkItemDetail(raw, itemId: itemId, privateAllowed: model.mayReadPrivateWork)
            let latest = try PhoneWorkPostPage(await model.readWork(.posts(itemId, before: nil), itemId: itemId, stamp: stamp))
            let focus: PhoneWorkPost?
            if let postId = detail.item.postId, !latest.posts.contains(where: { $0.id == postId }) {
                do {
                    let direct = try await model.readWork(.post(itemId, post: postId), itemId: itemId, stamp: stamp)
                    guard let post = PhoneWorkPost(direct["post"]), post.id == postId else { throw NativeFailure.invalidRecord }
                    focus = post
                } catch PhoneWorkReadFailure.postMissing { focus = nil }
            } else { focus = nil }
            guard mine == ticket, stamp == model.workStamp(itemId), !Task.isCancelled,
                  let current = model.workItem(itemId), detail.item.revision >= current.revision,
                  latest.revision >= (current.threadRevision ?? 0) else { return }
            let merge = value.map {
                latest.keepingEarlierPosts($0.posts, before: $0.before, revision: $0.threadRevision, snapshot: model.snapshot)
            } ?? (posts: latest.posts, before: latest.before)
            var next = WorkItemReadout(detail: detail, posts: merge.posts, before: merge.before, threadRevision: latest.revision, attention: focus)
            next.withdrawUnreadableSources(model.snapshot)
            model.publishWork(stamp, itemId: itemId) { value = next; failure = nil }
        } catch {
            guard mine == ticket, stamp == model.workStamp(itemId), !Task.isCancelled, !(error is CancellationError) else { return }
            model.publishWork(stamp, itemId: itemId) {
                failure = value == nil ? workReadWords(error, fallback: "读不到待办") : "待办未刷新 · 上次读取"
            }
        }
    }

    private func older(_ before: String) async {
        guard !loadingMore, var current = value, current.before == before, current.posts.count < 500 else { return }
        loadingMore = true; pageFailure = nil
        let mine = ticket
        defer { if mine == ticket { loadingMore = false } }
        do {
            let older = try PhoneWorkPostPage(await model.readWork(.posts(itemId, before: before), itemId: itemId, stamp: stamp))
            guard mine == ticket, stamp == model.workStamp(itemId), value?.before == before, !Task.isCancelled else { return }
            let ids = Set(current.posts.map(\.id))
            guard older.revision == current.threadRevision, older.posts.allSatisfy({ !ids.contains($0.id) }),
                  current.posts.count + older.posts.count <= 500 else {
                pageFailure = "讨论已有更新，请下拉刷新"
                return
            }
            let oldAnchor = current.posts.first?.id
            current.posts.insert(contentsOf: older.posts, at: 0)
            current.before = older.before
            current.withdrawUnreadableSources(model.snapshot)
            model.publishWork(stamp, itemId: itemId) { anchor = oldAnchor; value = current }
        } catch {
            guard mine == ticket, stamp == model.workStamp(itemId), !Task.isCancelled, !(error is CancellationError) else { return }
            model.publishWork(stamp, itemId: itemId) {
                pageFailure = workReadWords(error, fallback: "读不到更早的发言")
            }
        }
    }
}

private struct WorkItemHeading: View {
    @EnvironmentObject private var model: PhoneModel
    let item: PhoneWorkItemSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            let computer = model.selectedHost.map(model.computerName) ?? "Mac"
            let project = projectName(item.projectId, snapshot: model.snapshot)
            Label(PhoneConversation.visible([computer, project].compactMap { $0 }.joined(separator: " · ")), systemImage: "desktopcomputer")
                .font(.subheadline).foregroundStyle(PhoneTheme.muted)
            Text(PhoneConversation.visible(item.title)).font(.title2.weight(.semibold)).foregroundStyle(PhoneTheme.ink)
                .accessibilityAddTraits(.isHeader)
            if model.connected && !model.canRun {
                Text("无运行权限").font(.caption).foregroundStyle(PhoneTheme.muted)
            }
            if let group = item.group {
                if let reason = item.reason, group == .attention { WorkStatus(reason: reason) }
                else if group == .running && model.connected {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small).tint(PhoneTheme.accent)
                        Text(group.label).font(.subheadline).foregroundStyle(PhoneTheme.ink2)
                    }
                } else { Text(group.label).font(.subheadline).foregroundStyle(PhoneTheme.ink2) }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct WorkLinkedSession: View {
    @EnvironmentObject private var model: PhoneModel
    let session: NativeJSON

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            WorkRouteLink(title: session["title"].string ?? "会话", icon: "bubble.left", destination: .session(session.id))
            if PhoneWorkItems.canReadFiles(model.snapshot) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 18) { evidenceLinks.fixedSize(horizontal: true, vertical: false) }
                    VStack(alignment: .leading, spacing: 4) { evidenceLinks }
                }.padding(.leading, 6)
            }
        }.padding(.vertical, 6).padding(.horizontal, 12)
            .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 12))
            .disabled(!model.connected)
    }

    @ViewBuilder private var evidenceLinks: some View {
        if model.snapshot["catalog"]["features"]["changes"].bool {
            WorkRouteLink(title: "改动与反馈", icon: "list.bullet.rectangle", destination: .review(session: session.id, turn: nil), subrow: true)
        }
        if model.snapshot["catalog"]["features"]["gitDelivery"].bool {
            WorkRouteLink(title: "交付证据", icon: "checkmark.seal", destination: .evidence(session: session.id), subrow: true)
        }
    }
}

private struct WorkPostRow: View {
    @EnvironmentObject private var model: PhoneModel
    let post: PhoneWorkPost

    var body: some View {
        let visible = post.projectingSource(model.snapshot)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(post.at, format: .dateTime.month().day().hour().minute()).font(.caption).foregroundStyle(PhoneTheme.muted)
                Spacer()
                if let delivery = post.delivery {
                    Text(delivery.label).font(.caption).foregroundStyle(delivery == .failed ? PhoneTheme.red : delivery == .unknown ? PhoneTheme.amber : PhoneTheme.muted)
                }
            }
            ConversationText(text: post.text)
            if let id = visible.sourceSessionId, model.workSourceVisibility(id) == .readable {
                Label(PhoneConversation.visible(model.summary(of: id)["title"].string ?? id), systemImage: "arrow.turn.up.right")
                    .font(.caption).foregroundStyle(PhoneTheme.ink2)
                    .accessibilityLabel("接收会话，" + PhoneConversation.visible(model.summary(of: id)["title"].string ?? id))
            }
            if let refusal = visible.refusal { Text(PhoneConversation.visible(refusal)).font(.subheadline).foregroundStyle(PhoneTheme.muted) }
            if let reply = visible.reply {
                VStack(alignment: .leading, spacing: 6) {
                    Text(reply.live && model.connected ? "回复中" : "本轮回复").font(.caption.weight(.medium)).foregroundStyle(PhoneTheme.muted)
                    ConversationText(text: reply.text, markdown: true)
                    if let source = visible.source {
                        WorkRouteLink(title: "完整回复", icon: "text.alignleft", destination: .reply(post: post.id, message: reply.id, source: source), subrow: true)
                            .disabled(!model.connected)
                    }
                }.padding(10).frame(maxWidth: .infinity, alignment: .leading).background(PhoneTheme.sunken, in: RoundedRectangle(cornerRadius: 10))
            }
            if let source = visible.source {
                WorkRouteLink(title: "查看原回合", icon: "arrow.turn.down.right", destination: .source(source), subrow: true)
                    .disabled(!model.connected)
            } else if let id = post.sourceSessionId, let notice = model.workSourceVisibility(id).notice {
                Text(notice).font(.caption).foregroundStyle(PhoneTheme.muted)
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct WorkRouteLink: View {
    let title: String
    let icon: String
    let destination: PhoneWorkDestination
    var subrow = false

    var body: some View {
        NavigationLink(value: destination) {
            Label(PhoneConversation.visible(title), systemImage: icon)
                .font(subrow ? .subheadline : .body.weight(.medium))
                .foregroundStyle(PhoneTheme.ink)
                .frame(minHeight: 44, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

struct WorkSectionTitle: View {
    let title: String
    var body: some View { Text(title).font(.headline).foregroundStyle(PhoneTheme.ink).accessibilityAddTraits(.isHeader) }
}

struct WorkStatus: View {
    let reason: PhoneWorkReason
    var body: some View {
        Label(reason.label, systemImage: reason == .failed ? "exclamationmark.circle" : reason == .question ? "questionmark.bubble" : reason == .approval ? "shield" : "clock")
            .font(.subheadline.weight(.medium)).foregroundStyle(reason == .failed ? PhoneTheme.red : reason == .settled ? PhoneTheme.muted : PhoneTheme.amber)
    }
}

struct WorkUnlock: View {
    @EnvironmentObject private var model: PhoneModel
    @AppStorage(PhoneFaceID.key) private var faceID = false
    let label: String
    var body: some View {
        if !model.connected { WorkConnectionLine() }
        else {
            Button(faceID ? PhoneUnlock.reopenWords(faceID: true) : label, systemImage: "lock.open") {
                Task { await model.openWorkWindow() }
            }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink).disabled(model.verifying)
        }
    }
}

struct WorkConnectionLine: View {
    @EnvironmentObject private var model: PhoneModel
    var detail: String? = nil
    var body: some View {
        if !model.connected {
            VStack(alignment: .leading, spacing: 4) {
                Label((model.selectedHost.map(model.computerName) ?? "Mac") + " 不在线", systemImage: "wifi.slash")
                    .font(.subheadline).foregroundStyle(PhoneTheme.amber)
                if let detail { Text(detail).font(.subheadline).foregroundStyle(PhoneTheme.muted) }
            }
        }
    }
}

struct WorkReadNotice: View {
    let title: String
    var retry: (() async -> Void)? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: "exclamationmark.circle").font(.subheadline).foregroundStyle(PhoneTheme.amber)
            if let retry {
                Button("重试") { Task { await retry() } }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct WorkLoading: View {
    let label: String
    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(label).font(.subheadline).foregroundStyle(PhoneTheme.muted)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

func workReadWords(_ error: Error, fallback: String) -> String {
    switch error as? PhoneWorkReadFailure {
    case .itemMissing: "待办不可用"
    case .postMissing: "这条发言已不可用"
    case .replyMissing: "这条回复已不可用"
    case .checkChanged: "此检查已变化，请返回刷新 PR"
    case .versionChanged: "版本已有变化，请返回重新读取"
    case nil:
        switch error as? NativeFailure {
        case .forbidden: "这台设备没有查看权限"
        case .busy: "Mac 正在读取其他内容，请稍后重试"
        default: fallback
        }
    }
}

private func projectName(_ id: String?, snapshot: NativeJSON) -> String? {
    guard let id else { return nil }
    return snapshot["catalog"]["workspaces"].array.first { $0["id"].string == id }?["name"].string
}
