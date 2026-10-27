import LatchNativeCore
import SwiftUI

struct SessionDetailView: View {
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
                        if item["state"].string != "waiting" { Text(item["reason"].string ?? "已暂停，请确认后继续").font(.caption).foregroundStyle(.orange) }
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
        .onChange(of: model.contentGeneration) { _, _ in editing = nil; text = "" }
        .onChange(of: model.selectedHost?.id) { _, _ in editing = nil; text = "" }
    }
}
