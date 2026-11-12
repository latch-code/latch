import LatchNativeCore
import SwiftUI

private struct DrawerCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(PhoneTheme.lineStrong))
            .shadow(color: .black.opacity(0.08), radius: 16, y: 4)
            .padding(.horizontal, 12)
    }
}

/** As tall as its content up to a limit, then it scrolls; a plain ScrollView would always take the limit. */
private struct BoundedScroll<Content: View>: View {
    let limit: CGFloat
    @ViewBuilder var content: Content
    @State private var height: CGFloat = 0
    var body: some View {
        ScrollView {
            content.background(GeometryReader { proxy in Color.clear.onChange(of: proxy.size.height, initial: true) { _, value in height = value } })
        }.frame(height: min(height, limit))
    }
}

/**
 * Above the composer: what is asked, and the answers this phone really has, as the web offers them: 拒绝 and one allow,
 * the other choices under 更多. What this phone's scopes do not cover says so plainly.
 */
struct ApprovalDrawer: View {
    @EnvironmentObject private var model: PhoneModel
    let approval: NativeJSON
    let total: Int
    @State private var details = false
    /** Counted once per request: this view redraws on every update of the session. */
    @State private var stat: PhoneDiffStat?
    private static let argumentsLimit = 16_000
    var body: some View {
        let gate = PhoneConversation.approvalGate(approval, canApproveStandard: model.canApproveStandard, canApproveElevated: model.canApproveElevated, canRun: model.canRun)
        // What may read as something else is drawn with its hidden characters marked, as the web does.
        let mark: (String) -> String = { gate.hidden ? PhoneConversation.visible($0) : $0 }
        let arguments = (approval["tool"]["input"].string ?? approval["arguments"].string).map(mark)
        let diffs = approval["tool"]["diffs"].array.map { gate.hidden ? PhoneConversation.visibleDiff($0) : $0 }
        let places = approval["tool"]["locations"].array.compactMap(\.string).map(mark)
        let id = approval["id"].string
        let rejecting = id.map { model.controlsInFlight.contains(PhoneModel.approvalPath($0)) } ?? false
        DrawerCard {
            HStack(spacing: 6) {
                Image(systemName: "shield").font(.system(size: 14)).foregroundStyle(gate.riskClause == nil ? PhoneTheme.amberIcon : PhoneTheme.red)
                Text("需要你允许").font(.system(size: 14, weight: .medium)).foregroundStyle(gate.riskClause == nil ? PhoneTheme.amber : PhoneTheme.red)
                if total > 1 { Text("1/\(total)").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                Spacer()
                if arguments != nil || !diffs.isEmpty || places.count > 1 {
                    Button(details ? "收起" : "详情") { withAnimation(.easeOut(duration: 0.2)) { details.toggle() } }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                }
            }
            // What is being allowed is never cut: a command's tail is where it does its damage.
            HStack(alignment: .top, spacing: 6) {
                BoundedScroll(limit: 124) { Text(mark(gate.heading)).font(.system(size: 15)).foregroundStyle(PhoneTheme.ink).frame(maxWidth: .infinity, alignment: .leading) }
                if let stat { DiffStatText(add: stat.add, del: stat.del) }
            }
            if let clause = gate.riskClause { Text(clause).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.red) }
            if gate.hidden { Label(PhoneConversation.hiddenNote, systemImage: "exclamationmark.triangle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
            if details {
                BoundedScroll(limit: 220) {
                    VStack(alignment: .leading, spacing: 8) {
                        if places.count > 1 { ForEach(places, id: \.self) { Text($0).font(.system(size: 12, design: .monospaced)).foregroundStyle(PhoneTheme.ink2) } }
                        if !diffs.isEmpty { ForEach(Array(diffs.enumerated()), id: \.offset) { _, diff in DiffPreview(diff: diff) } }
                        else if let arguments {
                            ConversationText(text: String(arguments.prefix(Self.argumentsLimit)), monospaced: true, size: 14)
                            if arguments.count > Self.argumentsLimit { Text("还有 \(arguments.count - Self.argumentsLimit) 个字没有显示，到 Mac 上看全部").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
                        }
                    }
                }
            }
            if !model.connected { Text("Mac 不在线，连上后可以处理").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
            else {
                if let line = gate.refusal { Text(line).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                HStack(spacing: 8) {
                    if !gate.more.isEmpty, let id {
                        Menu {
                            ForEach(gate.more) { choice in
                                Button(choice.label) { Task { await model.decide(id, option: choice.id, allows: choice.allows) } }
                            }
                            Button("停止这一轮") { Task { await model.stop() } }
                        } label: {
                            Text("更多").font(.system(size: 15, weight: .medium)).foregroundStyle(PhoneTheme.ink).padding(.horizontal, 14).frame(height: 40)
                                .overlay(Capsule().stroke(PhoneTheme.lineStrong)).contentShape(Capsule())
                        }.disabled(rejecting || model.stoppingCurrent)
                    }
                    // A stop on its way answers this request too, so a rejection could only be told it came second.
                    button(rejecting ? "正在拒绝…" : "拒绝", prominent: false) { if let id { Task { await model.reject(id) } } }.disabled(rejecting || model.stoppingCurrent)
                    if gate.canAllow {
                        button(gate.allowLabel, prominent: !gate.hidden) { if let id { Task { await model.allow(id, option: gate.allowOption) } } }.disabled(model.stoppingCurrent)
                    } else {
                        button(model.stoppingCurrent ? "正在停止…" : "停止", prominent: false) { Task { await model.stop() } }.disabled(model.stoppingCurrent)
                    }
                }.disabled(model.busy)
            }
        }
        .task(id: id) { stat = PhoneConversation.diffStat(approval["tool"]); if PhoneConversation.hidesText(approval) { details = true } }
    }
    private func button(_ title: String, prominent: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 15, weight: .medium)).frame(maxWidth: .infinity).frame(height: 40)
                .foregroundStyle(prominent ? Color.white : PhoneTheme.ink)
                .background(prominent ? PhoneTheme.accent : Color.clear, in: Capsule())
                .overlay(Capsule().stroke(prominent ? Color.clear : PhoneTheme.lineStrong))
                .contentShape(Capsule())
        }.buttonStyle(.plain)
    }
}

struct QuestionDrawer: View {
    @EnvironmentObject private var model: PhoneModel
    let question: NativeJSON
    let sessionId: String
    let total: Int
    @State private var page = 0
    @State private var choices: [String: Set<String>] = [:]
    @State private var other: [String: String] = [:]
    @State private var writing = false
    private var items: [NativeJSON] { question["questions"].array }
    var body: some View {
        let item = items.indices.contains(page) ? items[page] : .null
        let id = item["id"].string ?? ""
        DrawerCard {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.bubble").font(.system(size: 14)).foregroundStyle(PhoneTheme.amberIcon)
                Text("等你回答").font(.system(size: 14, weight: .medium)).foregroundStyle(PhoneTheme.amber)
                if items.count > 1 { Text("\(page + 1)/\(items.count)").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                Spacer()
                if page > 0 { Button("上一个") { page -= 1 }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
            }
            if let prompt = question["prompt"].string, !prompt.isEmpty, page == 0 { Text(prompt).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(3) }
            Text(item["label"].string ?? "").font(.system(size: 15, weight: .medium)).foregroundStyle(PhoneTheme.ink)
            BoundedScroll(limit: 240) {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(item["options"].array, id: \.id) { option in optionRow(option, question: item) }
                    if writing {
                        LocalTextEditor(text: Binding(get: { other[id] ?? "" }, set: { other[id] = $0 }), placeholder: "其他想法")
                            .padding(10).background(PhoneTheme.sunken, in: RoundedRectangle(cornerRadius: 12))
                    } else { Button("其他…") { writing = true }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).padding(.top, 2) }
                }
            }
            HStack {
                Spacer()
                if page < items.count - 1 {
                    Button("下一个") { writing = false; page += 1 }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink).disabled(!answered(item))
                } else {
                    Button("提交回答") { answer() }.buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(PhoneTheme.accent)
                        .disabled(!items.allSatisfy(answered) || model.busy || question["state"].string != "pending" || !model.connected)
                }
            }
        }
        .onChange(of: question["id"].string) { _, _ in page = 0; choices = [:]; other = [:]; writing = false }
    }
    private func optionRow(_ option: NativeJSON, question item: NativeJSON) -> some View {
        let id = item["id"].string ?? "", optionId = option["id"].string ?? "", on = choices[id]?.contains(optionId) == true
        return Button {
            var value = choices[id] ?? []
            if on { value.remove(optionId) } else { if !item["multiple"].bool { value.removeAll() }; value.insert(optionId) }
            choices[id] = value
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: on ? "checkmark.circle.fill" : "circle").foregroundStyle(on ? PhoneTheme.accent : PhoneTheme.faint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option["label"].string ?? "").font(.system(size: 15)).foregroundStyle(PhoneTheme.ink)
                    if let description = option["description"].string { Text(description).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                }
                Spacer(minLength: 0)
            }.padding(.vertical, 6).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
    private func answered(_ item: NativeJSON) -> Bool {
        guard let id = item["id"].string else { return false }
        return !(choices[id] ?? []).isEmpty || !(other[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private func answer() {
        guard let id = question["id"].string else { return }
        let answers = items.compactMap { value -> NativeJSON? in
            guard let id = value["id"].string else { return nil }
            var fields: [String: NativeJSON] = ["questionId": .string(id), "optionIds": .array((choices[id] ?? []).sorted().map(NativeJSON.string))]
            if let text = other[id], !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { fields["other"] = .string(text) }
            return .object(fields)
        }
        Task { await model.mutate(.post, path: "/link/api/tasks/\(sessionId)/questions/\(id)/answer", fields: ["answers": .array(answers)]) }
    }
}

/** What waits behind the running turn; each can be edited or taken back until it is sent. */
struct QueueChips: View {
    @EnvironmentObject private var model: PhoneModel
    let items: [NativeJSON]
    let sessionId: String
    @State private var editing: String?
    @State private var text = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(items, id: \.id) { item in
                if let id = item["id"].string {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text("排队 · " + (item["text"].string ?? "")).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2).lineLimit(2)
                            Spacer(minLength: 4)
                            Button("编辑") { editing = id; text = item["text"].string ?? "" }
                            Button("移除") { Task { await model.mutate(.delete, path: "/link/api/tasks/\(sessionId)/queue/\(id)", fields: [:]) } }
                            if item["state"].string == "parked" { Button("继续") { Task { await model.mutate(.post, path: "/link/api/tasks/\(sessionId)/queue/\(id)/send", fields: [:]) } } }
                        }
                        if item["state"].string != "waiting" { Text(item["reason"].string ?? "已暂停，确认后继续").font(.system(size: 12)).foregroundStyle(PhoneTheme.amber) }
                    }
                    .font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).padding(.horizontal, 12).padding(.vertical, 8)
                    .background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 14)).disabled(model.busy || !model.connected)
                }
            }
        }
        .padding(.horizontal, 12)
        .sheet(isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
            NavigationStack {
                LocalTextEditor(text: $text, placeholder: "编辑待发送内容", maximumLines: nil).padding().navigationTitle("编辑待发送内容").navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("取消") { editing = nil } }
                        ToolbarItem(placement: .confirmationAction) { Button("保存") {
                            if let id = editing { Task { await model.mutate(.patch, path: "/link/api/tasks/\(sessionId)/queue/\(id)", fields: ["text": .string(text)]) } }
                            editing = nil
                        }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                    }
            }.presentationDetents([.medium, .large])
        }
        .onChange(of: model.contentGeneration) { _, _ in editing = nil; text = "" }
        .onChange(of: model.selectedHost?.id) { _, _ in editing = nil; text = "" }
    }
}
