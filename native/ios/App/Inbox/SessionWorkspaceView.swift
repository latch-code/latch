import LatchNativeCore
import SwiftUI

struct SessionWorkspaceView: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var editingAssistant = false
    var body: some View {
        NavigationStack {
            Group {
                if let id = model.sessionId { SessionDetailView(id: id) }
                else {
                    List {
                        if !model.connected { Label(model.status, systemImage: "wifi.slash").foregroundStyle(.secondary) }
                        if model.workspaceTasks.isEmpty { ContentUnavailableView("还没有会话", systemImage: "text.bubble", description: Text("开始一个新任务，或等待电脑上的会话同步。")) }
                        ForEach(model.workspaceTasks, id: \.id) { task in
                            Button { if let id = task["id"].string { Task { await model.openSession(id) } } } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Circle().fill(task["status"].string == "running" ? Color.blue : Color.secondary.opacity(0.4)).frame(width: 6, height: 6).padding(.top, 7)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(task["title"].string ?? "会话").foregroundStyle(.primary).lineLimit(2)
                                        Text(statusText(task["status"].string)).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if (task["pendingQuestions"].integer ?? 0) > 0 { Image(systemName: "questionmark.bubble").foregroundStyle(.orange).font(.footnote) }
                                }.padding(.vertical, 5)
                            }
                        }
                    }.refreshable { await model.refresh() }
                }
            }
            .navigationTitle(model.sessionId == nil ? (model.area == .personal ? model.assistantDetail["assistant"]["name"].string ?? "个人助手" : "项目工作") : model.detail["summary"]["title"].string ?? "会话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if model.sessionId != nil { Button(model.groupId == nil ? "会话" : "群聊", systemImage: "chevron.left") { model.newSession() } }
                    else if model.area == .personal { Button("个人助手", systemImage: "chevron.left") { Task { await model.openPersonalHome() } } }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if model.verifying { ProgressView().controlSize(.small) }
                    if model.area == .personal && model.assistantId != nil { Button("助手设置", systemImage: "slider.horizontal.3") { editingAssistant = true }.labelStyle(.iconOnly).disabled(model.assistantDetail == .null) }
                    if model.groupId == nil { Button("新会话", systemImage: "square.and.pencil") { model.newSession() }.labelStyle(.iconOnly) }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if model.groupId == nil && model.currentSummary["personal"]["groupId"].string == nil { PromptComposer() }
            }
            .sheet(isPresented: $editingAssistant) { PersonalAssistantEditor(assistant: model.assistantDetail["assistant"]) }
            .onChange(of: model.contentGeneration) { _, _ in editingAssistant = false }
        }
    }
    private func statusText(_ value: String?) -> String {
        switch value { case "running": "正在工作"; case "waiting-approval": "等你处理"; case "failed": "运行失败"; case "cancelled": "已停止"; case "interrupted": "执行中断"; default: "已就绪" }
    }
}
