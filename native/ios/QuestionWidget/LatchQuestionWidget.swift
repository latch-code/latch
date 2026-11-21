import ActivityKit
import SwiftUI
import WidgetKit

@main struct LatchQuestionWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LatchQuestionAttributes.self) { context in
            HStack(spacing: 12) {
                mark(context.isStale)
                    .font(.title2)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Latch").font(.caption).foregroundStyle(.secondary)
                    Text(title(context.isStale)).font(.headline)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption.bold()).foregroundStyle(.secondary)
            }
            .padding().widgetURL(LatchQuestionAttributes.link)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { mark(context.isStale) }
                DynamicIslandExpandedRegion(.center) { Text("Latch").font(.headline) }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(title(context.isStale)).font(.subheadline).padding(.bottom, 4)
                }
            } compactLeading: {
                mark(context.isStale)
            } compactTrailing: {
                Text(context.isStale ? "待更新" : "待回答").font(.caption2)
            } minimal: {
                mark(context.isStale).accessibilityLabel(title(context.isStale))
            }
            .widgetURL(LatchQuestionAttributes.link)
        }
    }

    private func mark(_ stale: Bool) -> some View {
        Image(systemName: stale ? "clock" : "questionmark.bubble.fill")
            .foregroundStyle(stale ? Color.secondary : .orange)
    }
    private func title(_ stale: Bool) -> String { stale ? "打开 Latch 查看最新状态" : "Agent 有问题等你回答" }
}
