import LatchNativeCore
import SwiftUI

/** 会话: a list that collapses into a push on the phone and stays beside the conversation on an iPad. */
struct InboxView: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var query = ""
    @State private var creating = false
    @State private var showConnecting = false
    private var frozen: Bool { !model.connected }
    private var selection: Binding<String?> {
        Binding(get: { model.area == .projects ? model.sessionId : nil }, set: { id in
            if let id { Task { await model.openSession(id) } } else if model.sessionId != nil { model.closeSession() }
        })
    }
    var body: some View {
        NavigationSplitView {
            let workspaces = model.snapshot["catalog"]["workspaces"].array
            let shelves = model.shelves(query: query)
            List(selection: selection) {
                if showConnecting { Text("正在连接…").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).listRowSeparator(.hidden) }
                if model.offline, let host = model.selectedHost { OfflineBanner(host: host.name).plainRow() }
                ForEach(shelves, id: \.id) { shelf in
                    Section {
                        ForEach(shelf.tasks, id: \.id) { task in
                            InboxRow(task: task, frozen: frozen, inWaiting: shelf.id == "waiting", project: shelf.id == "waiting" ? PhoneSessions.project(of: task, workspaces: workspaces)?["name"].string ?? "对话" : nil)
                                .tag(task.id).listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 8, trailing: 20)).listRowBackground(Color.clear)
                        }
                    } header: { ShelfHeader(label: shelf.label, count: shelf.id == "waiting" ? shelf.tasks.count : nil) }
                }
                if shelves.isEmpty { emptyState.plainRow() }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(PhoneTheme.canvas)
            .navigationTitle("会话")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $query, prompt: "搜索")
            .refreshable { await model.refresh() }
            .toolbar {
                if model.hosts.count > 1 {
                    ToolbarItem(placement: .topBarLeading) {
                        Menu {
                            ForEach(model.hosts) { host in
                                Button { Task { await model.connect(host) } } label: {
                                    if model.selectedHost?.id == host.id { Label(host.name, systemImage: "checkmark") } else { Text(host.name) }
                                }
                            }
                        } label: { HStack(spacing: 4) { Text(model.selectedHost?.name ?? "选择 Mac").lineLimit(1); Image(systemName: "chevron.down").font(.caption2.weight(.semibold)) } }
                            .disabled(model.busy || model.verifying)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("新会话", systemImage: "square.and.pencil") { creating = true }.labelStyle(.iconOnly).disabled(!model.connected)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { ControlPendingBar() }
        } detail: {
            if let id = model.area == .projects ? model.sessionId : nil { ConversationView(id: id) }
            else { PhoneTheme.canvas.ignoresSafeArea() }
        }
        .sheet(isPresented: $creating) { NewSessionSheet().presentationCornerRadius(28) }
        .task(id: model.selectedHost == nil || model.connected || model.offline) {
            // A connection that settles within a second never mentions connecting.
            showConnecting = false
            guard model.selectedHost != nil, !model.connected, !model.offline else { return }
            try? await Task.sleep(for: .seconds(1))
            if !Task.isCancelled { showConnecting = true }
        }
    }
    @ViewBuilder private var emptyState: some View {
        if !query.isEmpty { Text("没有符合的会话").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity).padding(.top, 48) }
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
                EngineTile(harnessId: task["harnessId"].string, size: 14)
                Text(([task["personal"]["assistantId"].string == nil ? "通用" : "助手"] + [PhoneSessions.rowMeta(task, project: project)].compactMap { $0 }).joined(separator: " · "))
                    .font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1)
            }
        }.frame(minHeight: 48, alignment: .center).accessibilityElement(children: .combine)
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
