import LatchNativeCore
import SwiftUI

struct PromptComposer: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var text = ""
    var body: some View {
        VStack(spacing: 10) {
            ForEach(model.pending, id: \.requestId) { pending in
                HStack {
                    Label("提交结果待确认", systemImage: "clock").font(.caption).foregroundStyle(.orange)
                    Spacer()
                    Button("重试这次提交") { Task { await model.submit(pending) } }.font(.caption).disabled(model.busy || !model.connected)
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
                LocalTextEditor(text: $text, placeholder: "继续说说你的想法…")
                    .overlay(alignment: .topLeading) { if text.isEmpty { Text("继续说说你的想法…").foregroundStyle(.secondary).allowsHitTesting(false).accessibilityHidden(true) } }.padding(12)
                    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                if ["running", "waiting-approval"].contains(model.currentSummary["status"].string ?? "") {
                    Button("停止", systemImage: "stop.fill") { Task { await model.stop() } }.labelStyle(.iconOnly).buttonStyle(.bordered).controlSize(.large)
                }
                Button("发送", systemImage: "arrow.up") {
                    let input = text
                    Task { if await model.send(text: input, queue: ["running", "waiting-approval"].contains(model.currentSummary["status"].string ?? "") && model.canQueueCurrent), text == input { text = "" } }
                }.labelStyle(.iconOnly).buttonStyle(.borderedProminent).controlSize(.large)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.canRun || model.busy || !model.pending.isEmpty || (["running", "waiting-approval"].contains(model.currentSummary["status"].string ?? "") && !model.canQueueCurrent))
            }
            if !model.connected { Text(model.status).font(.caption).foregroundStyle(.secondary) }
        }.padding(.horizontal, 16).padding(.vertical, 12).background(.bar)
            .onChange(of: model.sessionId) { _, _ in text = "" }
            .onChange(of: model.selectedHost?.id) { _, _ in text = "" }
            .onChange(of: model.verifiedUntil) { _, value in if value == nil { text = "" } }
    }
}
