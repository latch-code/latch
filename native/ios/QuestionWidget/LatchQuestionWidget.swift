import ActivityKit
import SwiftUI
import WidgetKit

struct LatchQuestionWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LatchQuestionAttributes.self) { context in
            let status = QuestionActivityStatus(stale: context.isStale, approval: context.attributes.approval)
            HStack(spacing: 12) {
                brandMark(size: 44).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Latch").font(.caption).foregroundStyle(.secondary)
                    Label {
                        Text(status.title)
                    } icon: {
                        status.icon
                    }
                    .font(.headline)
                }.layoutPriority(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.forward").font(.caption.bold()).foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .padding()
            .accessibilityElement(children: .combine)
            .widgetURL(context.attributes.link())
        } dynamicIsland: { context in
            let status = QuestionActivityStatus(stale: context.isStale, approval: context.attributes.approval)
            let preview = status == .approval ? context.state : .init()
            let details = ApprovalSessionPreview.open(preview.approvalSession, attributes: context.attributes)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 4) {
                        brandMark(size: 23).accessibilityHidden(true)
                        Text("Latch")
                            .font(.caption.weight(.semibold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    .padding(.leading, 12)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Label {
                        Text(preview.isElevated ? "高风险" : status.shortTitle)
                    } icon: {
                        if preview.isElevated {
                            Image(systemName: "exclamationmark.shield.fill").foregroundStyle(PhoneTheme.red).accessibilityHidden(true)
                        } else {
                            status.icon
                        }
                    }
                    .font(.caption.weight(.medium))
                    // The island clips content along its top curve.
                    .padding(.trailing, 12)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if let details {
                            SessionActivityTitle(title: details.title, agent: preview.approvalAgent, agentName: preview.agentName)
                                .privacySensitive()
                        }
                        approvalLine(preview, fileName: details?.fileName)
                        let hasFile = details?.fileName != nil && preview.approvalOperation.flatMap(FileApprovalAction.init(rawValue:)) != nil
                        let hasDetails = hasFile || preview.technicalTarget != nil || preview.fileSummary != nil
                        actions(status, attributes: context.attributes, preview: preview, hasDetails: hasDetails).layoutPriority(1)
                    }
                    .padding(.horizontal, 18)
                }
            } compactLeading: {
                brandMark(size: 22).accessibilityHidden(true)
            } compactTrailing: {
                Text(status.shortTitle).font(.caption2).lineLimit(1).minimumScaleFactor(0.8)
                    .accessibilityLabel(Text("Latch，\(status.shortTitle)"))
            } minimal: {
                brandMark(size: 22)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text("Latch，\(status.shortTitle)"))
            }
            .widgetURL(context.attributes.link())
        }
    }

    @ViewBuilder private func brandMark(size: CGFloat) -> some View {
        if let image = widgetImage("LatchMark", points: size) {
            image.renderingMode(.original).frame(width: size, height: size)
        }
    }

    @ViewBuilder private func approvalLine(_ preview: LatchQuestionAttributes.ContentState, fileName: String?) -> some View {
        if preview.approvalOperation == "runCommand" {
            HStack(spacing: 8) {
                actionGlyph("terminal")
                if let command = preview.technicalTarget {
                    let code = Text(verbatim: command).monospaced()
                    Text("运行 \(code)").lineLimit(1).minimumScaleFactor(0.8)
                } else {
                    Text("运行终端命令").lineLimit(1)
                }
                if preview.approvalOutsideSandbox == true {
                    Label("沙箱外", systemImage: "shield.lefthalf.filled")
                        .font(.caption2.weight(.medium)).foregroundStyle(PhoneTheme.amber)
                        .lineLimit(1).layoutPriority(1)
                        .accessibilityLabel("在 Agent 沙箱外运行")
                }
            }
            .font(.subheadline)
            .accessibilityElement(children: .combine)
        } else if let operation = preview.approvalOperation,
                  let action = FileApprovalAction(rawValue: operation), let title = preview.operation {
            HStack(spacing: 8) {
                actionGlyph(action.icon, hazardous: action == .delete)
                let verb = action == .edit && preview.approvalFileChange == "create" ? "新建" : action.verb
                if let name = fileName ?? preview.technicalTarget {
                    Text("\(verb) \(Text(verbatim: name).monospaced())")
                } else if let scope = preview.fileSummary {
                    Text("\(verb) \(scope)")
                } else {
                    Text(title)
                }
            }
            .font(.subheadline)
            .lineLimit(1).minimumScaleFactor(0.8)
            .accessibilityElement(children: .combine)
            .privacySensitive(fileName != nil)
        } else if let operation = preview.approvalOperation,
                  let kind = ApprovalReviewKind.byOperation[operation], let title = preview.operation {
            HStack(spacing: 8) {
                actionGlyph(kind.icon)
                Text(title).font(.subheadline).lineLimit(1).minimumScaleFactor(0.8)
            }
        }
    }

    private func actionGlyph(_ icon: String, hazardous: Bool = false) -> some View {
        Image(systemName: icon)
            .foregroundStyle(hazardous ? PhoneTheme.red : PhoneTheme.muted)
            .font(.subheadline.weight(.medium)).frame(width: 17)
            .accessibilityHidden(true)
    }

    @ViewBuilder private func actions(
        _ status: QuestionActivityStatus, attributes: LatchQuestionAttributes, preview: LatchQuestionAttributes.ContentState,
        hasDetails: Bool
    ) -> some View {
        switch status {
        case .approval where hasDetails:
            HStack(spacing: 8) {
                activityLink("拒绝", icon: "xmark", destination: attributes.link(reject: true))
                    .accessibilityHint("解锁后查看并确认拒绝")
                activityLink("批准", icon: "checkmark", destination: attributes.link(), primary: true)
                    .accessibilityHint("解锁后查看并确认这条审批")
            }
        case .approval:
            let review = preview.approvalOperation.flatMap { ApprovalReviewKind.byOperation[$0] }
            activityLink(review?.action ?? "解锁查看审批", icon: "lock.open", destination: attributes.link())
        case .question:
            activityLink("查看问题", icon: "bubble.left", destination: attributes.link())
        case .stale:
            activityLink("打开 Latch 查看最新状态", icon: "arrow.up.forward.app", destination: attributes.link())
        }
    }

    private func activityLink(_ title: String, icon: String, destination: URL, primary: Bool = false) -> some View {
        Link(destination: destination) {
            Label(title, systemImage: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(primary ? Color.white : PhoneTheme.ink)
                .lineLimit(1).minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity, minHeight: 34)
                .background(primary ? PhoneTheme.accent : PhoneTheme.bubble, in: Capsule())
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private enum FileApprovalAction: String {
    case read = "readFile", edit = "editFile", move = "moveFile", delete = "deleteFile"

    var icon: String {
        switch self {
        case .read: "doc.text"
        case .edit: "doc"
        case .move: "arrow.right.square"
        case .delete: "trash"
        }
    }

    var verb: String {
        switch self {
        case .read: "读取"
        case .edit: "编辑"
        case .move: "移动"
        case .delete: "删除"
        }
    }
}

private struct SessionActivityTitle: View {
    let title: String
    let agent: String?
    let agentName: String?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 8) {
            if let agentName, let mark = EngineTile.smallImage(agent, scheme: scheme, points: 17) {
                mark.resizable().scaledToFit().frame(width: 17, height: 17)
                    .accessibilityLabel(Text(verbatim: agentName))
            } else {
                Image(systemName: "bubble.left").font(.subheadline)
                    .foregroundStyle(PhoneTheme.muted).frame(width: 17).accessibilityHidden(true)
            }
            Text(verbatim: title)
                .font(.headline)
                .lineLimit(1).truncationMode(.tail).minimumScaleFactor(0.8)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct ApprovalReviewKind {
    let icon: String
    let action: String

    static let byOperation = [
        "runCommand": Self(icon: "terminal", action: "查看终端命令"),
        "allowNetwork": Self(icon: "network", action: "查看联网请求"),
        "grantAccess": Self(icon: "key", action: "查看权限范围"),
        "provideInput": Self(icon: "keyboard", action: "查看要输入的内容"),
        "reviewPlan": Self(icon: "list.clipboard", action: "查看执行计划"),
        "search": Self(icon: "magnifyingglass", action: "查看搜索请求"),
        "fetch": Self(icon: "arrow.down.circle", action: "查看网络请求"),
    ]
}

private enum QuestionActivityStatus {
    case approval, question, stale

    init(stale: Bool, approval: Bool?) {
        if stale { self = .stale }
        else { self = approval == true ? .approval : .question }
    }

    var title: String {
        switch self {
        case .approval: "有审批等你处理"
        case .question: "Agent 有问题等你回答"
        case .stale: "打开 Latch 查看最新状态"
        }
    }

    var shortTitle: String {
        switch self {
        case .approval: "待审批"
        case .question: "待回答"
        case .stale: "待更新"
        }
    }

    var icon: some View {
        Image(systemName: symbol)
            .foregroundStyle(self == .stale ? Color.secondary : PhoneTheme.amber)
            .accessibilityHidden(true)
    }

    private var symbol: String {
        switch self {
        case .approval: "hand.raised.fill"
        case .question: "questionmark.bubble.fill"
        case .stale: "clock"
        }
    }
}
