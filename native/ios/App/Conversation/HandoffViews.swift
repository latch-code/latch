import LatchNativeCore
import SwiftUI

/** 交回的结果 in the source's timeline: drawn from the record, not a message. */
struct ReturnedResultCard: View {
    @EnvironmentObject private var model: PhoneModel
    let result: PhoneReturnedResult
    let sessionId: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("交回的结果", systemImage: "arrow.uturn.backward").font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.ink2)
            if result.removed { Text("内容已随会话删除").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
            else if let summary = result.summary { Text(PhoneConversation.visible(summary)).font(.system(size: 14)).foregroundStyle(PhoneTheme.ink).lineLimit(12) }
            else { Text("无权查看").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
            ForEach(Array(result.evidence.enumerated()), id: \.offset) { _, item in
                Label(PhoneConversation.visible(item), systemImage: "paperclip").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1)
            }
            HStack(spacing: 10) {
                if let target = result.targetSessionId, model.snapshot["tasks"].array.contains(where: { $0["id"].string == target }) {
                    Button("打开代码会话") { Task { await model.openSession(target) } }
                }
                if let summary = result.summary, !result.removed, model.canRun {
                    Button("带入输入框") { model.addToDraft(PhoneHandoffs.quoted("", summary: summary), session: sessionId) }
                }
            }.font(PhoneTheme.caption).buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 12))
    }
}

/** 交回结果 above the target's composer once its turn ends: the conclusion (the last reply by default) and, if agreed, messages as evidence. */
struct HandBackDrawer: View {
    @EnvironmentObject private var model: PhoneModel
    let handoff: NativeJSON
    @State private var open = false
    @State private var summary = ""
    @State private var picked: Set<String> = []
    @State private var failure: String?
    /** A hand-back without an answer: sent again unchanged, never rebuilt. */
    @State private var request: NativePendingWrite?
    var body: some View {
        HStack {
            Label("交回结果", systemImage: "arrow.uturn.backward").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
            Spacer()
            Button("交回结果") { if request == nil { summary = PhoneHandoffs.defaultSummary(model.detail["messages"].array); picked = []; failure = nil }; open = true }
                .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(PhoneTheme.ink).disabled(!model.canRun || !model.connected)
        }.padding(.horizontal, 16)
        .sheet(isPresented: $open) {
            NavigationStack {
                Form {
                    Section("结论") { TextField("结论", text: $summary, axis: .vertical).lineLimit(4...12).disabled(request != nil) }
                    if handoff["returnScope"].string == "summary-and-evidence" {
                        Section {
                            ForEach(PhoneHandoffs.evidence(model.detail["messages"].array)) { item in
                                Button { if picked.contains(item.id) { picked.remove(item.id) } else { picked.insert(item.id) } } label: {
                                    Label(PhoneConversation.visible(item.label), systemImage: picked.contains(item.id) ? "checkmark.square.fill" : "square").foregroundStyle(PhoneTheme.ink)
                                }
                            }
                        } header: { HStack { Text("证据"); InfoHint(text: "文件证据尚未实现：在网页或桌面端交回文件。") } }
                    }
                    if let failure { Text(failure).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
                }
                .navigationTitle("交回结果").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { open = false } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(model.busy ? "交回中…" : request != nil ? "重试同一请求" : "交回") { Task { await send() } }
                            .disabled(summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
                    }
                }
            }.presentationDetents([.medium, .large])
        }
    }
    private func send() async {
        guard let id = handoff["id"].string else { return }
        if request == nil {
            let evidence = PhoneHandoffs.evidence(model.detail["messages"].array).filter { picked.contains($0.id) }
            request = try? PhoneHandoffs.handBack(handoffId: id, summary: summary, scope: handoff["returnScope"].string ?? "summary", evidence: evidence)
        }
        guard let request else { return }
        switch await model.write(request) {
        case .done: self.request = nil; open = false; model.handoffSignature = ""; if let session = model.sessionId { await model.loadHandoffs(session) }
        case let .refused(refusal): self.request = nil; failure = PhoneHandoffs.refusalWords(refusal)
        case .unknown: failure = "已发出，Mac 没有回答；重试同一请求不会交回两次。"
        case let .failed(error): self.request = nil; failure = (error as? NativeFailure)?.errorDescription ?? "暂时无法完成，请稍后重试。"
        }
    }
}

/** 交给代码任务… from a turn's ⋯: the turn's messages as material, the requirements, the target and what comes back. */
struct HandoffSheet: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let draft: PhoneHandoffDraft
    @State private var chosen: Set<String> = []
    @State private var requirements = ""
    @State private var newSession = true
    @State private var projectId: String?
    @State private var harnessId: String?
    @State private var sessionTarget: String?
    @State private var scope = "summary"
    @State private var failure: String?
    @State private var request: NativePendingWrite?
    var body: some View {
        let catalog = model.snapshot["catalog"]
        let source = model.summary(of: draft.sourceSessionId)
        NavigationStack {
            Form {
                Section("材料") {
                    ForEach(draft.materials) { item in
                        Button { if chosen.contains(item.id) { chosen.remove(item.id) } else { chosen.insert(item.id) } } label: {
                            Label(PhoneConversation.visible(item.label), systemImage: chosen.contains(item.id) ? "checkmark.square.fill" : "square").foregroundStyle(PhoneTheme.ink).lineLimit(2)
                        }
                    }
                }
                Section("要求") { TextField("要它做什么", text: $requirements, axis: .vertical).lineLimit(3...8) }
                Section("交给") {
                    Picker("交给", selection: $newSession) { Text("新会话").tag(true); Text("已有会话").tag(false) }.pickerStyle(.segmented)
                    if newSession {
                        Picker("项目", selection: $projectId) {
                            if PhoneStart.acceptsChat(catalog, harnessId: harnessId) { Text("不用项目").tag(String?.none) }
                            ForEach(PhoneStart.projects(catalog), id: \.id) { Text($0.name).tag(Optional($0.id)) }
                        }
                        Picker("Harness", selection: $harnessId) {
                            ForEach(PhoneStart.engines(catalog), id: \.id) { Text($0.name).tag(Optional($0.id)) }
                        }
                    } else {
                        Picker("会话", selection: $sessionTarget) {
                            Text("选一个已有会话").tag(String?.none)
                            ForEach(PhoneHandoffs.targets(model.snapshot["tasks"].array, source: source), id: \.id) { task in
                                Text(PhoneConversation.visible(task["title"].string ?? "未命名会话")).tag(task["id"].string)
                            }
                        }
                    }
                }
                Section {
                    Picker("回传", selection: $scope) { ForEach(PhoneHandoffs.scopes, id: \.value) { Text($0.label).tag($0.value) } }.pickerStyle(.segmented)
                } header: { HStack { Text("回传"); InfoHint(text: PhoneHandoffs.scopeFacts[scope] ?? "") } }
                if let failure { Text(failure).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
            }
            .navigationTitle("交给代码任务").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(request != nil ? "重试同一请求" : model.busy ? "正在交接…" : "交给") { Task { await send() } }.disabled(model.busy || !model.connected || problem != nil)
                }
            }
            .onAppear {
                chosen = Set(draft.materials.map(\.id))
                let defaults = PhoneStart.defaults(catalog)
                projectId = defaults.workspaceId ?? PhoneStart.projects(catalog).first?.id; harnessId = defaults.harnessId
            }
        }
    }
    private var problem: String? {
        PhoneHandoffs.problem(materials: chosen.count, requirements: requirements, targetSession: sessionTarget, newSession: newSession, harnessId: harnessId)
    }
    private func send() async {
        let catalog = model.snapshot["catalog"]
        if request == nil {
            let materials = draft.materials.filter { chosen.contains($0.id) }
            request = try? PhoneHandoffs.create(sourceSessionId: draft.sourceSessionId, materials: materials, requirements: requirements, returnScope: scope,
                newSession: newSession ? harnessId.map { (projectId, $0, PhoneStart.defaultModel(catalog, harnessId: $0)) } : nil, sessionId: newSession ? nil : sessionTarget)
        }
        guard let request else { failure = problem; return }
        switch await model.write(request) {
        case let .done(value):
            dismiss()
            if let target = value["handoff"]["targetSessionId"].string ?? value["targetSessionId"].string { await model.openSession(target) }
        case let .refused(refusal): failure = PhoneHandoffs.refusalWords(refusal); self.request = nil
        case .unknown: failure = "已发出，Mac 没有回答；重试不会多建一个会话。"
        case let .failed(error): failure = (error as? NativeFailure)?.errorDescription ?? "暂时无法完成，请稍后重试。"; self.request = nil
        }
    }
}
