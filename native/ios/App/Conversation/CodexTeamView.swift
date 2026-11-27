import LatchNativeCore
import SwiftUI

/** The actual Codex members in one conversation, using the same approval card as the turn. */
struct CodexTeamView: View {
    @EnvironmentObject private var model: PhoneModel
    let sessionId: String
    @Binding var draft: String
    let canPrepare: Bool
    @State private var open = false
    @State private var selected: String?
    @State private var approvalID: String?

    private struct Delegation: Identifiable {
        let id: String
        let userMessageId: String?
        var members: [NativeJSON] = []
    }

    private static let request = "请启动 Codex 的子 Agent 并行处理下列任务。分工后等待各成员结果，再汇总给我。"
    private var ownsContent: Bool {
        model.sessionId == sessionId && model.detail["summary"]["id"].string == sessionId && model.verifiedUntil.map { $0 > Date() } == true
    }
    private var messages: [NativeJSON] { ownsContent ? model.detail["messages"].array : [] }
    private var approvals: [NativeJSON] { ownsContent ? model.detail["approvals"].array : [] }
    private var availability: String? { ownsContent ? model.detail["codexTeam"].string : nil }
    private var canAdd: Bool { canPrepare && availability == "available" }
    private var conflict: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") }

    private var delegations: [Delegation] {
        var ordered: [String] = []
        var groups: [String: Delegation] = [:]
        for message in messages {
            let team = message["subagent"]["team"]
            guard let id = team["id"].string else { continue }
            if groups[id] == nil {
                ordered.append(id)
                groups[id] = Delegation(id: id, userMessageId: team["userMessageId"].string)
            }
            groups[id]?.members.append(message)
        }
        return ordered.reversed().compactMap { groups[$0] }
    }

    var body: some View {
        let groups = delegations
        let chosen = groups.first { $0.id == selected } ?? groups.first
        if availability != nil || chosen != nil {
            Button {
                open = true
            } label: {
                Label(chosen == nil ? "用团队分工" : "Agent 团队", systemImage: "person.2")
                    .font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2)
                    .padding(.horizontal, 8).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 10)
            .sheet(isPresented: $open) {
                if ownsContent {
                    NavigationStack {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 14) {
                                if let chosen {
                                    members(chosen, groups: groups)
                                } else {
                                    Text("发送分工请求后，Codex 自行创建成员。这里会显示实际分工和成员回报。").font(PhoneTheme.body)
                                }
                                if availability == "disabled" { note("当前 Codex 会话的原生协作已关闭。") }
                                if model.detail["summary"]["modelRoute"] != .null { note("成员走当前会话的模型服务，调用量合计在此会话。") }
                                if chosen != nil, model.connected, model.hasScope("view"), model.detail["activity"] != .null,
                                   ["running", "waiting-approval"].contains(model.currentSummary["status"].string ?? "") {
                                    let context = model.currentStopContext
                                    Button(model.stoppingCurrent ? "正在停止本轮…" : "停止本轮", role: .destructive) {
                                        Task { if let context { await model.stop(context: context) } }
                                    }.buttonStyle(.bordered).disabled(context == nil || model.stoppingCurrent)
                                }
                                if canAdd {
                                    note(conflict ? "输入框里已有斜杠命令，先发送或移除它。" : "把分工请求放入输入框，写清目标后亲自发送。")
                                    Button("加入输入框") {
                                        draft = PhonePending.joined(Self.request, draft)
                                        if draft == Self.request { draft += "\n\n" }
                                        open = false
                                    }
                                    .buttonStyle(.borderedProminent)
                                    .disabled(conflict || draft.hasPrefix(Self.request))
                                }
                            }
                            .frame(maxWidth: 560, alignment: .leading).frame(maxWidth: .infinity)
                            .padding(20)
                        }
                        .foregroundStyle(PhoneTheme.ink)
                        .background(PhoneTheme.canvas)
                        .navigationTitle("Agent 团队")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { open = false } } }
                    }
                }
            }
            .onChange(of: model.privateSnapshot.epoch) { _, _ in open = false; approvalID = nil }
            .onChange(of: model.sessionId) { _, _ in open = false; approvalID = nil }
            .onChange(of: open) { _, shown in if !shown { approvalID = nil } }
        }
    }

    @ViewBuilder private func members(_ chosen: Delegation, groups: [Delegation]) -> some View {
        if groups.count > 1 {
            Menu {
                ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                    Button("第 \(groups.count - index) 次委派") { selected = group.id; approvalID = nil }
                }
            } label: {
                Label("委派记录", systemImage: "clock.arrow.circlepath")
            }
            .font(PhoneTheme.caption)
        }
        if let requestID = chosen.userMessageId, let request = messages.first(where: { $0["id"].string == requestID })?["text"].string {
            let words = request.replacingOccurrences(of: Self.request, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
            Text(words.isEmpty ? request : words).font(PhoneTheme.body).lineLimit(2)
        }
        ForEach(Array(chosen.members.enumerated()), id: \.offset) { _, message in
            member(message)
        }
    }

    private func member(_ message: NativeJSON) -> some View {
        let agent = message["subagent"]
        let rowID = message["id"].string
        let approval = approvals.first { $0["subagentId"].string == rowID }
        return VStack(alignment: .leading, spacing: 8) {
            Divider()
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(PhoneConversation.visible(agent["title"].string ?? "子 Agent")).font(PhoneTheme.body).fontWeight(.semibold)
                Spacer(minLength: 4)
                note(status(approval == nil ? agent["status"].string : "waiting"))
            }
            if agent["status"].string == "failed", let failure = agent["team"]["failure"].string { note(PhoneConversation.visible(failure)) }
            if let assignment = agent["description"].string { note(PhoneConversation.visible(assignment)) }
            if let result = agent["team"]["result"].string {
                DisclosureGroup(agent["status"].string == "running" ? "成员回报" : "成员结果") {
                    MarkdownView(text: result, size: 14).padding(.top, 8)
                }.font(PhoneTheme.caption)
            }
            if let approval, let id = approval["id"].string {
                if approvalID == id {
                    ApprovalDrawer(approval: approval, total: 1)
                } else {
                    Button("查看此成员的审批") { approvalID = id }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            }
        }
    }

    private func note(_ text: String) -> some View { Text(text).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }

    private func status(_ value: String?) -> String {
        switch value {
        case "running": return model.connected ? "运行中" : "状态未知"
        case "waiting": return "待审批"
        case "done": return "已完成"
        case "failed": return "失败"
        case "cancelled": return "已停止"
        default: return "状态未知"
        }
    }
}
