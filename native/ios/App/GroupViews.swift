import LatchNativeCore
import SwiftUI

struct PersonalGroupView: View {
    @EnvironmentObject private var model: PhoneModel
    let id: String
    @State private var text = ""
    @State private var responders: [String] = []
    @State private var editing = false
    private var group: NativeJSON { model.groupDetail["group"] }
    private var active: Bool { model.groupControl?.active == true }
    private func name(_ id: String?) -> String { model.personalOverview["assistants"].array.first { $0.id == id }?["name"].string ?? "助手" }
    var body: some View {
        NavigationStack {
            Group {
                if model.verifiedUntil == nil {
                    ContentUnavailableView {
                        Label("继续群聊", systemImage: "person.2")
                    } description: { Text("解锁后查看共享讨论。每位助手的私有记忆独立保留。") }
                    actions: { Button("继续") { Task { await model.openGroup(id) } }.buttonStyle(.borderedProminent).disabled(!model.connected || model.verifying) }
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 20) {
                            PersonalPendingWrites()
                            if model.groupDetail["messages"].array.isEmpty {
                                Text("说说想一起完成的事").font(.title3.weight(.medium))
                                Text("选择回复助手，需要接力时再明确添加下一位。私有记忆不会加入讨论。").font(.subheadline).foregroundStyle(.secondary)
                            }
                            ForEach(model.groupDetail["messages"].array, id: \.id) { message in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(message["role"].string == "user" ? "你" : name(message["assistantId"].string)).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                                    ConversationText(text: message["text"].string ?? "")
                                    if let session = message["sessionId"].string { Button("打开完整会话") { Task { await model.openSession(session) } }.font(.caption) }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if model.groupDetail["turn"] != .null {
                                VStack(alignment: .leading, spacing: 8) {
                                    Label(turnStatus(model.groupDetail["turn"]["state"].string), systemImage: active ? "circle.dotted" : model.groupDetail["turn"]["state"].string == "completed" ? "checkmark.circle" : "pause.circle")
                                        .font(.subheadline).foregroundStyle(active ? Color.secondary : .primary)
                                    if let reason = model.groupDetail["turn"]["reason"].string { Text(turnReason(reason)).font(.caption).foregroundStyle(.secondary) }
                                }
                            }
                            ForEach(model.groupDetail["sessions"].array.filter { model.groupDetail["turn"]["sessionIds"].array.contains(.string($0.id)) }, id: \.id) { session in
                                Button { Task { await model.openSession(session.id) } } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(name(session["personal"]["assistantId"].string)).foregroundStyle(.primary)
                                            Text(session["status"].string == "waiting-approval" ? "等你处理 · 打开实际会话" : (session["pendingQuestions"].integer ?? 0) > 0 ? "等你回答 · 打开实际会话" : "查看本轮执行与文件").font(.caption).foregroundStyle(.secondary)
                                        }
                                        Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                                    }.padding(12).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                                }
                            }
                        }.padding(20).frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity)
                    }.refreshable { await model.refreshPersonal() }
                }
            }
            .navigationTitle(group["name"].string ?? "助手群聊").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("个人助手", systemImage: "chevron.left") { Task { await model.openPersonalHome() } } }
                ToolbarItem(placement: .topBarTrailing) { Button("群聊设置", systemImage: "slider.horizontal.3") { editing = true }.labelStyle(.iconOnly).disabled(group == .null) }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 10) {
                    if active { HStack { Text("当前轮次正在执行").font(.caption).foregroundStyle(.secondary); Spacer(); Button("停止接力") { Task { await model.stopGroup() } }.disabled(!model.connected || model.busy) } }
                    if model.verifiedUntil != nil {
                        Menu {
                            Button("由默认助手回复") { responders = [] }
                            ForEach(group["memberIds"].array.compactMap(\.string), id: \.self) { member in
                                Button {
                                    if responders.contains(member) { responders.removeAll { $0 == member } }
                                    else if responders.count < min(4, (group["maxRelays"].integer ?? 0) + 1) { responders.append(member) }
                                } label: { Label(name(member), systemImage: responders.contains(member) ? "checkmark" : "person.crop.circle") }
                            }
                        } label: { HStack { Text(responders.isEmpty ? name(group["defaultAssistantId"].string) + " 回复" : responders.map { name($0) }.joined(separator: " → ")).font(.caption); Image(systemName: "chevron.down").font(.caption2); Spacer() } }.disabled(active)
                        HStack(alignment: .bottom, spacing: 10) {
                            LocalTextEditor(text: $text, placeholder: "说说要一起完成的事…").padding(12).background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                            Button("发送", systemImage: "arrow.up") { let value = text, members = responders; Task { if await model.sendGroup(text: value, assistantIds: members), text == value, model.pending.isEmpty { text = "" } } }
                                .labelStyle(.iconOnly).buttonStyle(.borderedProminent).controlSize(.large)
                                .disabled(active || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.count > 16000 || !model.canRun || model.busy || !model.pending.isEmpty)
                        }
                    }
                }.padding(.horizontal, 16).padding(.vertical, 12).background(.bar)
            }
            .sheet(isPresented: $editing) { PersonalGroupEditor(group: group) }
            .onChange(of: model.contentGeneration) { _, _ in text = ""; responders = []; editing = false }
            .onChange(of: model.selectedHost?.id) { _, _ in text = ""; responders = []; editing = false }
        }
    }
    private func turnStatus(_ state: String?) -> String { switch state { case "running": "正在接力"; case "waiting-approval": "等你处理"; case "completed": "本轮已完成"; case "failed": "本轮运行失败"; case "cancelled": "本轮已停止"; default: "本轮已中断" } }
    private func turnReason(_ reason: String) -> String { switch reason { case "definition-changed": "成员配置已改变，请检查后开始新轮次。"; case "owner-unavailable": "原设备授权已变化，请检查后开始新轮次。"; case "host-restarted": "电脑已重新启动，原轮次不会自动重发。"; case "storage-unavailable": "记录结果尚未确认，请同步实际会话。"; default: "结果尚未确认，请先检查实际会话。" } }
}

struct PersonalGroupEditor: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let group: NativeJSON
    @State private var name = ""
    @State private var instructions = ""
    @State private var defaultMember = ""
    @State private var members: Set<String> = []
    @State private var relays = 0
    @State private var deleting = false
    private var editing: Bool { group["id"].string != nil }
    private var choices: [NativeJSON] { model.personalOverview["assistants"].array.filter { $0["available"].bool && $0["harnessId"].string == "standard" || members.contains($0.id) } }
    private var active: Bool { editing && model.groupControl?.groupId == group.id && model.groupControl?.active == true }
    var body: some View {
        NavigationStack {
            Form {
                PersonalPendingWrites()
                Section("名称") { LocalTextEditor(text: $name, placeholder: "例如：一起整理旅行计划", maximumLines: 2).frame(minHeight: 36) }
                Section("群成员") {
                    if choices.isEmpty { Text("先创建一个可用的个人助手。").foregroundStyle(.secondary) }
                    ForEach(choices, id: \.id) { item in Toggle(item["name"].string ?? "助手", isOn: Binding(get: { members.contains(item.id) }, set: { if $0 { members.insert(item.id); if defaultMember.isEmpty { defaultMember = item.id } } else { members.remove(item.id); if defaultMember == item.id { defaultMember = members.sorted().first ?? "" } } })).disabled(active) }
                }
                Section {
                    Picker("默认回复", selection: $defaultMember) { ForEach(choices.filter { members.contains($0.id) }, id: \.id) { Text($0["name"].string ?? "助手").tag($0.id) } }.disabled(active)
                    Stepper("最多接力 \(relays + 1) 位", value: $relays, in: 0...3).disabled(active)
                    LocalTextEditor(text: $instructions, placeholder: "这组助手共同负责什么（可选）", maximumLines: 8).frame(minHeight: 100).disabled(active)
                } header: { Text("协作方式") } footer: { Text(active ? "当前轮次结束后可修改成员与协作方式。" : "每次由你明确选择回复顺序。成员职责只给自己使用，私有记忆不会加入群聊。") }
                if editing { Button("删除群聊", role: .destructive) { deleting = true }.disabled(active || !model.canRun || !model.pending.isEmpty) }
            }
            .navigationTitle(editing ? "群聊设置" : "创建群聊").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { clear(); dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { await save() } }.disabled(!valid || model.busy || !model.pending.isEmpty) }
            }
            .confirmationDialog("删除这个群聊？", isPresented: $deleting, titleVisibility: .visible) { Button("删除群聊", role: .destructive) { Task { if await model.mutate(.delete, path: "/link/api/personal/groups/" + group.id, fields: [:]), model.pending.isEmpty { clear(); dismiss(); await model.openPersonalHome() } } } }
            .onAppear { name = group["name"].string ?? ""; instructions = group["instructions"].string ?? ""; members = Set(group["memberIds"].array.compactMap(\.string)); defaultMember = group["defaultAssistantId"].string ?? ""; relays = Int(min(3, group["maxRelays"].integer ?? 0)) }
            .onChange(of: model.contentGeneration) { _, _ in clear(); dismiss() }
            .onChange(of: model.selectedHost?.id) { _, _ in clear(); dismiss() }
        }
    }
    private var valid: Bool { model.canRun && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 80 && instructions.count <= 8000 && (1...8).contains(members.count) && members.contains(defaultMember) }
    private func clear() { name = ""; instructions = ""; members = []; defaultMember = ""; relays = 0; deleting = false }
    private func save() async {
        var fields: [String: NativeJSON] = ["name": .string(name), "memberIds": .array(members.sorted().map(NativeJSON.string)), "defaultAssistantId": .string(defaultMember), "instructions": .string(instructions), "maxRelays": .number(Double(relays))]
        if editing { fields["baseRevision"] = group["revision"] }
        if active { fields = ["name": .string(name), "baseRevision": group["revision"]] }
        if await model.mutate(editing ? .patch : .post, path: "/link/api/personal/groups" + (editing ? "/" + group.id : ""), fields: fields), model.pending.isEmpty { clear(); dismiss() }
    }
}
