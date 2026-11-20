import LatchNativeCore
import SwiftUI

struct WorkPostComposer: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let itemId: String
    let stamp: PhoneWorkReadStamp
    let send: (PhoneWorkChange) async -> PhoneWriteOutcome
    @State private var text = ""
    @State private var recipient: String?
    @State private var sending = false
    @State private var failure: String?
    @State private var composing = false

    private var members: [NativeJSON] {
        (model.workItem(itemId)?.sessionIds ?? []).filter { model.workSourceVisibility($0) == .readable }.map(model.summary(of:))
    }
    private var targetAvailable: Bool {
        guard let recipient else { return true }
        return members.contains { $0.id == recipient && !$0["archived"].bool && !["running", "waiting-approval"].contains($0["status"].string ?? "") }
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("发给", selection: $recipient) {
                        Text("只记在待办").tag(String?.none)
                        ForEach(members, id: \.id) { task in
                            let title = task["title"].string ?? task.id
                            let duplicate = members.contains { $0.id != task.id && $0["title"].string == title }
                            Text(PhoneConversation.visible(title) + (duplicate ? " · " + String(task.id.suffix(6)) : ""))
                                .tag(Optional(task.id))
                                .disabled(task["archived"].bool || ["running", "waiting-approval"].contains(task["status"].string ?? ""))
                        }
                    }
                    if !targetAvailable { Text("这个会话暂时不能接收发言，请重新选择。").foregroundStyle(PhoneTheme.amber) }
                }
                Section {
                    ZStack(alignment: .topLeading) {
                        if text.isEmpty { Text("写一条发言…").foregroundStyle(.tertiary).allowsHitTesting(false).accessibilityHidden(true) }
                        LocalTextEditor(text: $text, placeholder: "发言内容", maximumLines: 7, minimumLines: 5, composing: $composing)
                    }
                    if text.utf16.count > 4000 { Text("发言最多 4,000 个字符").font(.footnote).foregroundStyle(PhoneTheme.amber) }
                    if let failure { Text(failure).font(.footnote).foregroundStyle(PhoneTheme.amber) }
                }
            }
            .disabled(sending)
            .navigationTitle("写发言").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(sending) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(recipient == nil ? "记录" : "发送") { Task { await submit() } }
                        .disabled(sending || composing || !targetAvailable || model.busy || !model.pending.isEmpty
                            || !model.canRun || model.workStamp(itemId) != stamp || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.utf16.count > 4000)
                }
            }
            .interactiveDismissDisabled(sending)
        }
    }

    private func submit() async {
        guard !sending, !composing, targetAvailable else { return }
        sending = true; defer { sending = false }
        let result = await send(.post(item: itemId, text: text, session: recipient))
        guard model.workStamp(itemId) == stamp else { return }
        switch result {
        case .done, .unknown: dismiss()
        case .refused, .failed: failure = workChangeFailure(result)
        }
    }
}
