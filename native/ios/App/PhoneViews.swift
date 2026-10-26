import LatchNativeCore
import SwiftUI

struct PhoneRootView: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var scan = false
    @State private var settings = false
    var body: some View {
        NavigationSplitView {
            List {
                if model.selectedHost != nil {
                    Section {
                        Button("个人助手", systemImage: "person.crop.circle") { Task { await model.openPersonalHome() } }
                            .foregroundStyle(.primary)
                        Button("项目工作", systemImage: "folder") { model.openProjects() }.foregroundStyle(.primary)
                    }
                }
                if model.hosts.isEmpty {
                    ContentUnavailableView("把电脑带在身边", systemImage: "laptopcomputer", description: Text("在电脑上的 Latch 打开手机配对，扫描二维码连接。"))
                        .listRowBackground(Color.clear)
                }
                ForEach(model.hosts) { host in
                    Button { Task { await model.connect(host) } } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "laptopcomputer").font(.system(size: 18)).foregroundStyle(.secondary).frame(width: 24)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(host.name).foregroundStyle(.primary)
                                Text(model.selectedHost?.id == host.id ? model.status : host.prepared ? "登记待核对" : "已登记").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if model.selectedHost?.id == host.id { Image(systemName: "checkmark").font(.footnote.weight(.semibold)) }
                        }.padding(.vertical, 3)
                    }.disabled(model.busy || model.verifying)
                }
                if model.draft != nil {
                    Button("继续未完成的登记", systemImage: "arrow.clockwise") { model.resumePairing() }.disabled(model.busy)
                }
                Button("添加电脑", systemImage: "plus") { scan = true }.disabled(model.busy)
            }
            .navigationTitle("电脑")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("设置", systemImage: "gearshape") { settings = true }.labelStyle(.iconOnly) } }
        } detail: {
            if model.selectedHost != nil {
                if model.area == .personal && model.assistantId == nil { PersonalHomeView() }
                else { SessionWorkspaceView() }
            }
            else {
                VStack(spacing: 20) {
                    Image("LatchMark").resizable().frame(width: 42, height: 42).clipShape(RoundedRectangle(cornerRadius: 10))
                    Text("你的工作，随时继续").font(.title2.weight(.semibold))
                    Text("连接已登记的电脑，查看进展、回答问题并继续会话。").foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("添加电脑") { scan = true }.buttonStyle(.borderedProminent).controlSize(.large)
                }.padding(32).frame(maxWidth: 460)
            }
        }
        .sheet(isPresented: $scan) { PairingView() }
        .sheet(isPresented: $settings) { PhoneSettingsView() }
        .sheet(isPresented: Binding(get: { model.comparisonCode != nil }, set: { _ in })) {
            if let code = model.comparisonCode {
                VStack(spacing: 24) {
                    Text("在 Mac 上确认").font(.title2.weight(.semibold))
                    Text("在电脑显示的 Latch 确认窗口中输入：").foregroundStyle(.secondary)
                    Text(code).font(.system(size: 38, weight: .medium, design: .monospaced)).tracking(6).accessibilityLabel(code.map(String.init).joined(separator: " "))
                    Label("确认前不会授予手机操作权限", systemImage: "lock").font(.footnote).foregroundStyle(.secondary)
                    ProgressView().controlSize(.small)
                }.padding(32).interactiveDismissDisabled()
                    .presentationDetents([.medium])
            }
        }
        .alert("暂时无法完成", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("知道了") { model.error = nil }
        } message: { Text(model.error ?? "") }
        .onReceive(NotificationCenter.default.publisher(for: .latchStatusHint)) { _ in Task { await model.refresh() } }
    }
}

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
                    if model.sessionId != nil { Button("会话", systemImage: "chevron.left") { model.newSession() } }
                    else if model.area == .personal { Button("个人助手", systemImage: "chevron.left") { Task { await model.openPersonalHome() } } }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if model.verifying { ProgressView().controlSize(.small) }
                    if model.area == .personal { Button("助手设置", systemImage: "slider.horizontal.3") { editingAssistant = true }.labelStyle(.iconOnly).disabled(model.assistantDetail == .null) }
                    Button("新会话", systemImage: "square.and.pencil") { model.newSession() }.labelStyle(.iconOnly)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { PromptComposer() }
            .sheet(isPresented: $editingAssistant) { PersonalAssistantEditor(assistant: model.assistantDetail["assistant"]) }
            .onChange(of: model.contentGeneration) { _, _ in editingAssistant = false }
        }
    }
    private func statusText(_ value: String?) -> String {
        switch value { case "running": "正在工作"; case "waiting-approval": "等你处理"; case "failed": "运行失败"; case "cancelled": "已停止"; case "interrupted": "执行中断"; default: "已就绪" }
    }
}

private struct SessionDetailView: View {
    @EnvironmentObject private var model: PhoneModel
    let id: String
    @State private var preview: PreviewItem?
    @State private var previewTask: Task<Void, Never>?
    @State private var previewRequest: UUID?
    var body: some View {
        Group {
            if model.verifiedUntil == nil {
                ContentUnavailableView {
                    Label("继续这个会话", systemImage: "lock")
                } description: { Text("解锁后即可查看会话与文件。") }
                actions: { Button("解锁") { Task { await model.openSession(id) } }.buttonStyle(.borderedProminent).disabled(model.verifying || !model.connected) }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        ForEach(model.detail["messages"].array, id: \.id) { message in MessageRow(message: message, open: openFile) }
                        if let live = model.detail["liveText"].string, !live.isEmpty { ConversationText(text: live).frame(maxWidth: .infinity, alignment: .leading) }
                        ForEach(model.detail["approvals"].array, id: \.id) { approval in ApprovalCard(approval: approval) }
                        ForEach(model.detail["questions"].array, id: \.id) { question in QuestionCard(question: question, sessionId: id) }
                        if !model.detail["queue"].array.isEmpty { QueueList(items: model.detail["queue"].array, sessionId: id) }
                    }.padding(20).frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity)
                }.refreshable { await model.refresh() }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let progress = model.previewProgress {
                HStack(spacing: 12) {
                    if progress.total > 0 { ProgressView(value: Double(progress.completed), total: Double(progress.total)).frame(width: 72).tint(.secondary) }
                    else { ProgressView().controlSize(.small) }
                    Text(progress.total > 0 ? "读取文件 · " + ByteCountFormatter.string(fromByteCount: Int64(progress.completed), countStyle: .file) + " / " + ByteCountFormatter.string(fromByteCount: Int64(progress.total), countStyle: .file) : "正在打开文件…").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("取消") { cancelFile() }.font(.caption).foregroundStyle(.primary)
                }.padding(.horizontal, 20).padding(.vertical, 10).background(.bar)
            }
        }
        .sheet(item: $preview, onDismiss: { PreviewFiles.clear() }) { NativePreviewView(item: $0) }
        .onChange(of: model.verifiedUntil) { _, value in if value == nil { preview = nil } }
        .onChange(of: model.contentGeneration) { _, _ in preview = nil; cancelFile() }
        .onDisappear { cancelFile(); preview = nil; PreviewFiles.clear() }
    }
    private func cancelFile() {
        previewTask?.cancel(); previewTask = nil; previewRequest = nil; model.cancelPreview()
    }
    private func openFile(_ path: String, _ root: String?) {
        cancelFile()
        let selected = id, generation = model.contentGeneration, request = UUID()
        previewRequest = request
        previewTask = Task {
            defer { if previewRequest == request { previewTask = nil; previewRequest = nil } }
            do {
                let item = try await model.preview(reference: path, root: root)
                guard !Task.isCancelled, previewRequest == request, model.sessionId == selected, model.contentGeneration == generation, item.lease.valid else { PreviewFiles.discard(item); return }
                preview = item
            }
            catch { if !Task.isCancelled, previewRequest == request, model.contentGeneration == generation { model.previewFailed(error) } }
        }
    }
}

private struct MessageRow: View {
    let message: NativeJSON
    let open: (String, String?) -> Void
    @State private var expanded = false
    var body: some View {
        let role = message["role"].string ?? "system"
        VStack(alignment: .leading, spacing: 8) {
            if role == "tool" {
                DisclosureGroup(isExpanded: $expanded) {
                    ConversationText(text: message["tool"]["output"].string ?? message["text"].string ?? "", monospaced: true)
                } label: { Label(message["tool"]["title"].string ?? message["toolName"].string ?? "工具", systemImage: "chevron.left.forwardslash.chevron.right").font(.subheadline).foregroundStyle(.secondary) }
            } else {
                if role == "user" { Text("你").font(.caption.weight(.medium)).foregroundStyle(.secondary) }
                ConversationText(text: message["text"].string ?? "")
                    .padding(role == "user" ? 12 : 0).background(role == "user" ? Color.secondary.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 12))
            }
            ForEach(message["outputs"].array.indices, id: \.self) { index in
                let file = message["outputs"].array[index]
                if file["change"].string != "deleted", let path = file["path"].string {
                    Button { open(path, file["root"].string) } label: { Label(path, systemImage: "doc").font(.caption).lineLimit(1) }
                }
            }
            ForEach(message["tool"]["locations"].array.indices, id: \.self) { index in
                if let path = message["tool"]["locations"].array[index].string {
                    Button { open(path, nil) } label: { Label(path, systemImage: "doc").font(.caption).lineLimit(1) }
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct PromptComposer: View {
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
                    Task { if await model.send(text: input, queue: model.currentSummary["status"].string == "running"), text == input { text = "" } }
                }.labelStyle(.iconOnly).buttonStyle(.borderedProminent).controlSize(.large)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.canRun || model.busy || !model.pending.isEmpty || (model.area == .personal && ["running", "waiting-approval"].contains(model.currentSummary["status"].string ?? "")))
            }
            if !model.connected { Text(model.status).font(.caption).foregroundStyle(.secondary) }
        }.padding(.horizontal, 16).padding(.vertical, 12).background(.bar)
            .onChange(of: model.sessionId) { _, _ in text = "" }
            .onChange(of: model.selectedHost?.id) { _, _ in text = "" }
            .onChange(of: model.verifiedUntil) { _, value in if value == nil { text = "" } }
    }
}

private struct ApprovalCard: View {
    @EnvironmentObject private var model: PhoneModel
    let approval: NativeJSON
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("需要你确认", systemImage: "hand.raised").font(.subheadline.weight(.medium)).foregroundStyle(.orange)
            if let name = approval["toolName"].string { Text(name).font(.subheadline.weight(.medium)) }
            Text(approval["reason"].string ?? "工具正在等待许可").font(.subheadline)
            if let input = approval["arguments"].string { ConversationText(text: input, monospaced: true) }
            HStack {
                Button("拒绝") { if let id = approval["id"].string { Task { await model.reject(id) } } }.buttonStyle(.bordered)
                if approval["risk"].string == "R1", !approval["advisory"].bool,
                   approval["options"].array.isEmpty || approval["options"].array.contains(where: { $0["kind"].string == "allow_once" }),
                   let id = approval["id"].string {
                    Button("允许一次") {
                        var fields: [String: NativeJSON] = ["decision": .string("allow")]
                        if let option = approval["options"].array.first(where: { $0["kind"].string == "allow_once" })?["id"].string { fields["optionId"] = .string(option) }
                        Task { await model.mutate(.post, path: "/link/api/approvals/" + id, fields: fields) }
                    }.buttonStyle(.borderedProminent).disabled(!model.canApproveStandard)
                } else { Text("请在 Mac 上确认此操作").font(.caption).foregroundStyle(.secondary) }
            }.disabled(model.busy)
        }.padding(16).background(Color.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct QuestionCard: View {
    @EnvironmentObject private var model: PhoneModel
    let question: NativeJSON
    let sessionId: String
    @State private var choices: [String: Set<String>] = [:]
    @State private var other: [String: String] = [:]
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("等你回答", systemImage: "questionmark.bubble").font(.subheadline.weight(.medium)).foregroundStyle(.orange)
            Text(question["prompt"].string ?? "")
            ForEach(question["questions"].array, id: \.id) { item in
                if let id = item["id"].string {
                    Text(item["label"].string ?? "").font(.subheadline.weight(.medium))
                    ForEach(item["options"].array, id: \.id) { option in
                        if let optionId = option["id"].string {
                            Button {
                                var value = choices[id] ?? []
                                if value.contains(optionId) { value.remove(optionId) }
                                else { if !item["multiple"].bool { value.removeAll() }; value.insert(optionId) }
                                choices[id] = value
                            } label: {
                                HStack(alignment: .top) {
                                    Image(systemName: choices[id]?.contains(optionId) == true ? "checkmark.circle.fill" : "circle")
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(option["label"].string ?? "")
                                        if let description = option["description"].string { Text(description).font(.caption).foregroundStyle(.secondary) }
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.buttonStyle(.plain).foregroundStyle(choices[id]?.contains(optionId) == true ? .blue : .primary)
                        }
                    }
                    LocalTextEditor(text: Binding(get: { other[id] ?? "" }, set: { other[id] = $0 }), placeholder: "其他想法（可选）")
                        .overlay(alignment: .topLeading) { if (other[id] ?? "").isEmpty { Text("其他想法（可选）").foregroundStyle(.secondary).allowsHitTesting(false).accessibilityHidden(true) } }
                        .padding(8).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            Button("提交回答") { answer() }.buttonStyle(.borderedProminent).disabled(!complete || model.busy || question["state"].string != "pending")
        }.padding(16).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    }
    private var complete: Bool {
        question["questions"].array.allSatisfy { value in
            guard let id = value["id"].string else { return false }
            return !(choices[id] ?? []).isEmpty || !(other[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }
    private func answer() {
        guard let id = question["id"].string else { return }
        let answers = question["questions"].array.compactMap { value -> NativeJSON? in
            guard let id = value["id"].string else { return nil }
            var fields: [String: NativeJSON] = ["questionId": .string(id), "optionIds": .array((choices[id] ?? []).sorted().map(NativeJSON.string))]
            if let text = other[id], !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { fields["other"] = .string(text) }
            return .object(fields)
        }
        Task { await model.mutate(.post, path: "/link/api/tasks/\(sessionId)/questions/\(id)/answer", fields: ["answers": .array(answers)]) }
    }
}

private struct QueueList: View {
    @EnvironmentObject private var model: PhoneModel
    let items: [NativeJSON]
    let sessionId: String
    @State private var editing: String?
    @State private var text = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("接下来 · \(items.count)").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            ForEach(items, id: \.id) { item in
                if let id = item["id"].string {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(item["text"].string ?? "").lineLimit(4)
                        if item["state"].string != "waiting" { Text("已暂停，请确认后继续").font(.caption).foregroundStyle(.orange) }
                        HStack {
                            Button("编辑") { editing = id; text = item["text"].string ?? "" }
                            Button("移除", role: .destructive) { Task { await model.mutate(.delete, path: "/link/api/tasks/\(sessionId)/queue/\(id)", fields: [:]) } }
                            Spacer()
                            if item["state"].string == "parked" { Button("继续") { Task { await model.mutate(.post, path: "/link/api/tasks/\(sessionId)/queue/\(id)/send", fields: [:]) } } }
                        }.font(.caption).disabled(model.busy)
                    }.padding(12).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                }
            }
        }
        .sheet(isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
            NavigationStack {
                LocalTextEditor(text: $text, placeholder: "编辑待发送内容", maximumLines: nil).padding().navigationTitle("编辑待发送内容")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("取消") { editing = nil } }
                        ToolbarItem(placement: .confirmationAction) { Button("保存") {
                            if let id = editing { Task { await model.mutate(.patch, path: "/link/api/tasks/\(sessionId)/queue/\(id)", fields: ["text": .string(text)]) } }
                            editing = nil
                        }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                    }
            }.presentationDetents([.medium, .large])
        }
    }
}

extension NativeJSON: @retroactive Identifiable {
    public var id: String { self["id"].string ?? "invalid" }
}
