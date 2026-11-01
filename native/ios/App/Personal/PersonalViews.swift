import LatchNativeCore
import SwiftUI

struct PersonalHomeView: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var creating = false
    @State private var creatingGroup = false
    @State private var routine: NativeJSON?
    var body: some View {
        NavigationStack {
            Group {
                if !model.connected && model.personalOverview == .null {
                    ContentUnavailableView("正在等待电脑连接", systemImage: "laptopcomputer", description: Text("连接恢复后，继续你的助手与会话。"))
                } else if !model.supportsPersonal {
                    ContentUnavailableView("个人助手暂不可用", systemImage: "person.crop.circle", description: Text("连接支持个人助手的电脑后，就可以开始日常会话。"))
                } else if model.snapshot["device"]["dataScope"].string != "all" {
                    ContentUnavailableView("请在电脑上允许访问", systemImage: "person.crop.circle", description: Text("个人助手包含你的私有记忆。请在电脑上的设备设置中，允许这台手机使用个人助手。"))
                } else if model.verifiedUntil == nil {
                    ContentUnavailableView {
                        Label("继续你的日常", systemImage: "person.crop.circle")
                    } description: { Text("你的助手和私有记忆保存在电脑上。") }
                    actions: { Button("继续") { Task { await model.refreshPersonal() } }.buttonStyle(.borderedProminent).disabled(!model.connected || model.verifying) }
                } else {
                    List {
                        PersonalPendingWrites()
                        if model.personalOverview["assistants"].array.isEmpty && !model.personalLoading {
                            ContentUnavailableView("给日常留一个地方", systemImage: "text.bubble", description: Text("创建一个助手，帮你整理想法、资料或日常安排，无需先选择项目。"))
                                .listRowBackground(Color.clear)
                            Button("创建助手") { creating = true }.disabled(!model.canRun || !model.pending.isEmpty)
                        }
                        ForEach(model.personalOverview["assistants"].array, id: \.id) { assistant in
                            Button { if let id = assistant["id"].string { Task { await model.openAssistant(id) } } } label: {
                                HStack(alignment: .top, spacing: 12) {
                                    Image(systemName: "person.crop.circle").font(.system(size: 19)).foregroundStyle(.secondary).frame(width: 24).padding(.top, 2)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(assistant["name"].string ?? "个人助手").font(.body.weight(.medium)).foregroundStyle(.primary)
                                        if let role = assistant["role"].string, !role.isEmpty { Text(role).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
                                        if let reason = assistant["unavailableReason"].string { Text(reason).font(.caption).foregroundStyle(.secondary) }
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                                }.padding(.vertical, 5)
                            }.disabled(model.personalLoading)
                        }
                        if model.supportsGroups {
                            Section("助手群聊") {
                                ForEach(model.personalOverview["groups"].array, id: \.id) { group in
                                    Button { Task { await model.openGroup(group.id) } } label: {
                                        Label(group["name"].string ?? "助手群聊", systemImage: "person.2").foregroundStyle(.primary)
                                    }
                                }
                                Button("创建群聊", systemImage: "plus") { creatingGroup = true }.disabled(!model.canRun || !model.pending.isEmpty || model.personalOverview["assistants"].array.isEmpty)
                            }
                        }
                        if model.supportsRoutines {
                            Section("例行任务") {
                                ForEach(model.personalOverview["routines"].array, id: \.id) { item in PersonalRoutineRow(routine: item) { routine = item } }
                                Button("创建例行任务", systemImage: "plus") { routine = .null }.disabled(!model.canRun || !model.pending.isEmpty || !model.personalOverview["assistants"].array.contains { $0["canSchedule"].bool })
                            }
                        }
                    }.refreshable { await model.refreshPersonal() }
                }
            }
            .navigationTitle("个人助手")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Agent", systemImage: "chevron.left") { model.openProjects() } }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if model.personalLoading || model.verifying { ProgressView().controlSize(.small) }
                    if model.supportsPersonal && model.verifiedUntil != nil {
                        Button("创建助手", systemImage: "plus") { creating = true }.labelStyle(.iconOnly)
                            .disabled(!model.canRun || !model.pending.isEmpty)
                    }
                }
            }
            .sheet(isPresented: $creating) { PersonalAssistantEditor(assistant: .null) }
            .sheet(isPresented: $creatingGroup) { PersonalGroupEditor(group: .null) }
            .sheet(item: $routine) { PersonalRoutineEditor(routine: $0) }
            .onChange(of: model.contentGeneration) { _, _ in creating = false; creatingGroup = false; routine = nil }
            .onChange(of: model.selectedHost?.id) { _, _ in creating = false; creatingGroup = false; routine = nil }
            .task(id: "\(model.selectedHost?.id ?? ""):\(model.connected)") {
                if model.connected, model.area == .personal, model.assistantId == nil { await model.refreshPersonal() }
            }
        }
    }
}

struct PersonalPendingWrites: View {
    @EnvironmentObject private var model: PhoneModel
    var body: some View {
        ForEach(model.pending, id: \.requestId) { pending in
            HStack {
                Label("提交结果待确认", systemImage: "clock").font(.caption).foregroundStyle(.orange)
                Spacer()
                Button("重试这次提交") { Task { await model.submit(pending) } }.font(.caption).disabled(model.busy || !model.connected)
            }
        }
    }
}

struct PersonalAssistantEditor: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let assistant: NativeJSON
    @State private var name = ""
    @State private var role = ""
    @State private var harness = "standard"
    @State private var mode = "chat"
    @State private var modelChoice = ""
    @State private var selectedPlugins: Set<String> = []
    @State private var memory: NativeJSON?
    @State private var deleting = false
    private var editing: Bool { assistant["id"].string != nil }
    private var changedModel: NativeJSON { modelChoice == "saved-unavailable" ? assistant["model"] : models.first { $0.id == modelChoice }?.value ?? .null }
    private var harnesses: [NativeJSON] { model.snapshot["catalog"]["harnesses"].array.filter { $0["personalContext"].string == "private" && $0["status"].string == "ready" && $0["level"].string == "L1" } }
    private struct ModelChoice: Identifiable {
        let id: String, label: String
        let value: NativeJSON
    }
    private var models: [ModelChoice] {
        model.snapshot["catalog"]["providers"].array.flatMap { provider in
            provider["models"].array.enumerated().compactMap { index, entry in
                guard let id = provider["id"].string, let name = provider["name"].string, let value = entry.string else { return nil }
                return ModelChoice(id: id + ":" + String(index), label: name + " · " + value, value: .object(["providerId": .string(id), "model": .string(value)]))
            }
        }
    }
    var body: some View {
        NavigationStack {
            Form {
                PersonalPendingWrites()
                Section("名称") { LocalTextEditor(text: $name, placeholder: "例如：资料整理", maximumLines: 2).frame(minHeight: 36) }
                Section("职责") { LocalTextEditor(text: $role, placeholder: "告诉它负责什么", maximumLines: 6).frame(minHeight: 96) }
                Section {
                    Picker("执行方式", selection: $harness) {
                        ForEach(harnesses, id: \.id) { item in Text(item["name"].string ?? "执行方式").tag(item.id) }
                        if !harnesses.contains(where: { $0.id == harness }) { Text("当前配置暂不可用").tag(harness) }
                    }
                    Picker("工作方式", selection: $mode) { Text("只对话").tag("chat"); Text("使用插件工具").tag("agent") }
                    Picker("模型", selection: $modelChoice) {
                        Text("使用默认模型").tag("")
                        if assistant["model"] != .null && !models.contains(where: { $0.value == assistant["model"] }) { Text("已保存的模型暂不可用").tag("saved-unavailable") }
                        ForEach(models) { item in Text(item.label).tag(item.id) }
                    }
                }
                Section {
                    if !model.personalPluginsLoaded { Text("暂时无法读取插件，请稍后重试。").foregroundStyle(.secondary) }
                    else if model.personalPlugins.isEmpty { Text("电脑上暂无可选插件").foregroundStyle(.secondary) }
                    ForEach(model.personalPlugins, id: \.id) { item in
                        Toggle(isOn: Binding(get: { selectedPlugins.contains(item.id) }, set: { if $0 { selectedPlugins.insert(item.id) } else { selectedPlugins.remove(item.id) } })) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item["name"].string ?? "插件")
                                if let description = item["description"].string, !description.isEmpty { Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                            }
                        }
                    }
                    ForEach(selectedPlugins.filter { id in !model.personalPlugins.contains(where: { $0.id == id }) }.sorted(), id: \.self) { id in
                        Toggle("未加载的插件", isOn: Binding(get: { selectedPlugins.contains(id) }, set: { if !$0 { selectedPlugins.remove(id) } }))
                    }
                } header: { Text("使用插件") } footer: { Text("只使用你选择的插件工具与技能。插件由电脑运行。") }
                if editing {
                    Section {
                        ForEach(model.assistantDetail["memories"].array, id: \.id) { item in
                            Button { memory = item } label: { ConversationText(text: item["content"].string ?? "").foregroundStyle(.primary) }
                        }
                        Button("添加记忆", systemImage: "plus") { memory = .object(["id": .string("")]) }
                    } header: { Text("私有记忆") } footer: { Text("由你维护，只用于这个助手；不会自动传给其他助手、项目或群聊。") }
                    Section { Button("删除助手", role: .destructive) { deleting = true } }
                }
                if name.count > 80 || role.count > 2000 { Text("名称最多 80 字，职责最多 2000 字。").font(.caption).foregroundStyle(.secondary) }
            }
            .navigationTitle(editing ? "助手设置" : "创建助手").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { clear(); dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { await save() } }.disabled(!valid || model.busy || !model.pending.isEmpty) }
            }
            .sheet(item: $memory) { PersonalMemoryEditor(assistantId: assistant.id, memory: $0) }
            .confirmationDialog("删除这个助手？", isPresented: $deleting, titleVisibility: .visible) {
                Button("删除助手", role: .destructive) { Task { await remove() } }
            } message: { Text("私有记忆会一起删除，已有会话仍保留。") }
            .onAppear {
                name = assistant["name"].string ?? ""; role = assistant["role"].string ?? ""
                harness = assistant["harnessId"].string ?? "standard"; mode = assistant["mode"].string ?? "chat"
                selectedPlugins = Set(assistant["pluginIds"].array.compactMap(\.string))
                modelChoice = assistant["model"] == .null ? "" : models.first { $0.value == assistant["model"] }?.id ?? "saved-unavailable"
            }
            .onChange(of: model.contentGeneration) { _, _ in clear(); dismiss() }
            .onChange(of: model.selectedHost?.id) { _, _ in clear(); dismiss() }
        }
    }
    private var valid: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 80 && role.count <= 2000 && model.canRun && harnesses.contains(where: { $0.id == harness }) }
    private func clear() { name = ""; role = ""; selectedPlugins = []; memory = nil }
    private func save() async {
        var fields: [String: NativeJSON] = ["name": .string(name), "role": .string(role), "harnessId": .string(harness), "mode": .string(mode), "pluginIds": .array(selectedPlugins.sorted().map(NativeJSON.string))]
        if editing { fields["baseRevision"] = assistant["revision"]; fields["model"] = changedModel }
        else if changedModel != .null { fields["model"] = changedModel }
        let path = "/link/api/personal/assistants" + (editing ? "/" + assistant.id : "")
        await model.mutate(editing ? .patch : .post, path: path, fields: fields)
        if model.pending.isEmpty && model.error == nil { clear(); dismiss() }
    }
    private func remove() async {
        await model.mutate(.delete, path: "/link/api/personal/assistants/" + assistant.id, fields: [:])
        if model.pending.isEmpty && model.error == nil { clear(); dismiss(); await model.openPersonalHome() }
    }
}

private struct PersonalMemoryEditor: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let assistantId: String
    let memory: NativeJSON
    @State private var text = ""
    private var editing: Bool { !memory.id.isEmpty }
    var body: some View {
        NavigationStack {
            Form {
                PersonalPendingWrites()
                Section { LocalTextEditor(text: $text, placeholder: "写下你希望这个助手记住的偏好", maximumLines: 14).frame(minHeight: 160) }
                footer: { Text("只对这个助手生效。保存前不会加入它的上下文。") }
                if editing { Button("删除记忆", role: .destructive) { Task { await write(remove: true) } } }
            }
            .navigationTitle(editing ? "编辑记忆" : "添加记忆").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { text = ""; dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { await write(remove: false) } }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.count > 4000 || !model.canRun || model.busy || !model.pending.isEmpty) }
            }
            .onAppear { text = memory["content"].string ?? "" }
            .onChange(of: model.contentGeneration) { _, _ in text = ""; dismiss() }
            .onChange(of: model.selectedHost?.id) { _, _ in text = ""; dismiss() }
        }
    }
    private func write(remove: Bool) async {
        var fields: [String: NativeJSON] = [:]
        if !remove { fields["content"] = .string(text); if editing { fields["baseRevision"] = memory["revision"] } }
        await model.mutate(remove ? .delete : editing ? .patch : .post,
            path: "/link/api/personal/assistants/" + assistantId + "/memories" + (editing ? "/" + memory.id : ""), fields: fields)
        if model.pending.isEmpty && model.error == nil { text = ""; dismiss() }
    }
}
