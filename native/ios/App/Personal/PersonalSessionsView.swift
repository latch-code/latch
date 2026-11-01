import LatchNativeCore
import SwiftUI

/** An assistant's own sessions, until the Agent tab takes them over. */
struct SessionWorkspaceView: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var editingAssistant = false
    var body: some View {
        if let id = model.sessionId {
            NavigationStack { ConversationView(id: id, back: { model.backToPersonalList() }) }
        } else {
            NavigationStack {
                List {
                    if model.workspaceTasks.isEmpty { ContentUnavailableView("还没有会话", systemImage: "text.bubble", description: Text("在下面写下第一句话。")) }
                    ForEach(model.workspaceTasks, id: \.id) { task in
                        Button { if let id = task["id"].string { Task { await model.openSession(id) } } } label: {
                            InboxRow(task: task, frozen: !model.connected, inWaiting: false, project: nil)
                        }
                    }
                }
                .listStyle(.plain)
                .refreshable { await model.refresh() }
                .navigationTitle(model.assistantDetail["assistant"]["name"].string ?? "助手")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button("助手", systemImage: "chevron.left") { Task { await model.openPersonalHome() } } }
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        if model.verifying { ProgressView().controlSize(.small) }
                        Button("助手设置", systemImage: "slider.horizontal.3") { editingAssistant = true }.labelStyle(.iconOnly).disabled(model.assistantDetail == .null)
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) { PromptComposer(draftId: nil, gate: nil, engine: model.assistantDetail["assistant"]["name"].string ?? "助手") }
                .sheet(isPresented: $editingAssistant) { PersonalAssistantEditor(assistant: model.assistantDetail["assistant"]) }
                .onChange(of: model.contentGeneration) { _, _ in editingAssistant = false }
            }
        }
    }
}
