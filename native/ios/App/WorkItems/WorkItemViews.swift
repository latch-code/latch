import LatchNativeCore
import SwiftUI

struct WorkItemList: View {
    @EnvironmentObject private var model: PhoneModel
    private var selection: Binding<String?> { Binding(get: { model.workItemId }, set: model.selectWorkItem) }

    var body: some View {
        let items = model.workItems
        List(selection: selection) {
            if !model.connected {
                Section { WorkConnectionLine() }
            }
            ForEach(PhoneWorkGroup.allCases, id: \.self) { group in
                let rows = items.filter { $0.group == group }
                if !rows.isEmpty {
                    Section {
                        ForEach(rows) { item in row(item).tag(item.id) }
                    } header: { Text(group.label).textCase(nil).font(.subheadline).foregroundStyle(PhoneTheme.muted) }
                }
            }
            ForEach(items.filter { $0.group == nil }) { item in row(item).tag(item.id) }
            if items.isEmpty, model.connected {
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
        .background(PhoneTheme.canvas).navigationTitle("待办").navigationBarTitleDisplayMode(.large)
        .refreshable { await model.refresh() }
    }

    private func row(_ item: PhoneWorkItemSummary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(PhoneConversation.visible(item.title)).font(.body.weight(model.workItemId == item.id ? .semibold : .medium)).foregroundStyle(PhoneTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let project = projectName(item.projectId, snapshot: model.snapshot) {
                Text(PhoneConversation.visible(project)).font(.subheadline).foregroundStyle(PhoneTheme.muted)
            }
            if let reason = item.reason, item.group == .attention { WorkStatus(reason: reason) }
        }.frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
            .contentShape(Rectangle()).accessibilityElement(children: .combine)
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
            WorkSectionTitle(title: "讨论")
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
            }
        }
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
