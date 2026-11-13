import LatchNativeCore
import SwiftUI

/** A sheet as tall as what it holds: rows for what the session runs on, then the first message. */
struct NewSessionSheet: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    /** 从这里分叉: the same sheet, keeping the source up to the turn it was opened from. */
    var fork: PhoneForkDraft? = nil
    @State private var choice = PhoneStartChoice()
    @State private var prompt = ""
    @State private var height: CGFloat = 520
    @State private var starting = false
    /** A model the person chose in a fork's sheet; it wins over the source's. */
    @State private var picked: PhoneModelChoice?
    /** 接入已有会话, over the sheet: the project and Harnesses as they were when it opened, so it never goes blank. */
    @State private var importing: HistoryScope?
    /** The picker the ＋ opened. */
    @State private var attachSource: AttachSource?
    private let attachKey = PhoneModel.newSessionTray
    /** A fork carries its source's conversation; attachments go with a plain new session only. */
    private var attaches: Bool { fork == nil }
    private var attachSelection: NativeJSON? { PhoneAttachments.selection(startFields: PhoneStart.fields(catalog, choice: choice, prompt: "")) }
    private var catalog: NativeJSON { model.snapshot["catalog"] }
    /** The source's detail when it is the open session, else its list row: what a fork can carry. */
    private var source: NativeJSON {
        guard let fork else { return .null }
        return model.detail["summary"]["id"].string == fork.taskId ? model.detail : .object(["summary": model.summary(of: fork.taskId)])
    }
    private var plan: PhoneForkPlan? { fork?.plan(catalog, source: source, choice: choice, picked: picked) }
    private var shownModel: PhoneModelChoice? { plan.map { $0.choice.model ?? $0.forwarded } ?? choice.model }
    private var harness: NativeJSON { catalog["harnesses"].array.first { $0["id"].string == choice.harnessId } ?? .null }
    private var blocker: String? { PhoneStart.blocker(catalog, choice: choice) }
    private var canStart: Bool {
        let attached = attaches && !model.tray(attachKey).isEmpty
        return blocker == nil && (!prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attached) && (fork == nil ? model.canRun : model.canFork) && !starting && model.pending.isEmpty
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                VStack(spacing: 0) {
                    projectRow
                    Divider().overlay(PhoneTheme.line)
                    engineRow
                    Divider().overlay(PhoneTheme.line)
                    modelRow
                    Divider().overlay(PhoneTheme.line)
                    row("思考") { Text(plan?.thinkingWords ?? "模型默认").foregroundStyle(plan?.thinkingWords == nil ? PhoneTheme.muted : PhoneTheme.ink2) }
                    Divider().overlay(PhoneTheme.line)
                    row("权限") { HStack(spacing: 6) { Image(systemName: "shield").font(.system(size: 13)); Text(plan?.pick(.permission)?.name ?? "先问你") }.foregroundStyle(PhoneTheme.ink2) }
                }
                .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(PhoneTheme.line))
                Text(blocker ?? fork?.origin ?? "开始后可以换权限。").font(PhoneTheme.caption).foregroundStyle(blocker == nil ? PhoneTheme.muted : PhoneTheme.amber)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
                // What the fork could not keep from its source, in the web's words.
                ForEach(plan?.missed ?? [], id: \.self) { line in
                    Text(line).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
                }
                // Rows above the field, as in the composer: they stay in view with the keyboard up.
                if attaches && (!model.tray(attachKey).isEmpty || model.tray(attachKey).note != nil) {
                    AttachmentRows(key: attachKey, selection: attachSelection, inset: 0).padding(.vertical, 2)
                }
                LocalTextEditor(text: $prompt, placeholder: "要做什么？", maximumLines: 6)
                    .overlay(alignment: .topLeading) { if prompt.isEmpty { Text("要做什么？").font(PhoneTheme.body).foregroundStyle(PhoneTheme.faint).allowsHitTesting(false).accessibilityHidden(true) } }
                    .padding(14).padding(.bottom, attaches ? 40 : 0).frame(minHeight: 110, alignment: .topLeading)
                    .background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 16))
                    .overlay(alignment: .bottomLeading) {
                        if attaches { AttachButton(key: attachKey, harness: harness, selection: attachSelection, source: $attachSource).padding(10) }
                    }
                if fork == nil { HistoryEntryRow(entry: PhoneHistory.entry(model.snapshot, workspaceId: choice.workspaceId)) { importing = HistoryScope(model.snapshot, workspaceId: choice.workspaceId) } }
                ForEach(model.pending, id: \.requestId) { pending in
                    HStack {
                        Label(PhonePending.words(pending), systemImage: "clock").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                        Spacer()
                        Button("重试这次提交") { Task { if PhoneHistory.isImport(pending) { await model.retryPending(pending); if model.pending.isEmpty { dismiss() } } else if await model.submit(pending), model.pending.isEmpty { dismiss() } } }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                        if PhonePending.prompt(pending) != nil, PhonePending.kind(pending) == .start {
                            Button("放弃这次提交") {
                                Task { if case let .text(back, _) = await model.abandonPrompt(pending) { prompt = PhonePending.joined(prompt, back) } }
                            }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).disabled(model.busy)
                            InfoHint(text: PromptComposer.abandonStartHint)
                        }
                    }
                }
            }
            .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 16)
            .background(GeometryReader { proxy in Color.clear.onChange(of: proxy.size.height, initial: true) { _, value in height = value + 72 } })
            .frame(maxHeight: .infinity, alignment: .top)
            .navigationTitle(fork == nil ? "新会话" : "从这里分叉").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消", systemImage: "xmark") { dismiss() }.labelStyle(.iconOnly) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("开始") { start() }.buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(PhoneTheme.accent).disabled(!canStart)
                }
            }
        }
        // Another Harness starts on its own default model: Latch's for one that uses its services, none otherwise.
        .onChange(of: choice.harnessId) { old, new in if old != nil, old != new { choice.model = PhoneStart.defaultModel(catalog, harnessId: new); picked = nil } }
        // The sheet goes once the cover has; the session opens once both have (InboxView's onDismiss).
        .fullScreenCover(item: $importing, onDismiss: { if model.openAfterDismiss != nil { dismiss() } }) { scope in
            HistoryImportView(project: scope.project, sources: scope.sources) { taskId in
                model.openAfterDismiss = taskId; importing = nil
            }
        }
        .modifier(AttachSupport(key: attaches ? attachKey : nil, selection: attachSelection, harness: harness, source: $attachSource))
        // Not delivered, for certain: the text comes back into the sheet.
        .onChange(of: model.returnedText[attachKey]) { _, value in if let value { prompt = PhonePending.joined(prompt, value); model.returnedText[attachKey] = nil } }
        // Closing the sheet lets go of what was attached here; the Host's drafts go too.
        // Only a real dismiss lets go: not while starting or opening the window for it, an unconfirmed start, or 接入已有会话 over it.
        .onDisappear {
            if PhoneAttachments.dropsOnClose(key: attachKey, pending: model.pending, starting: starting, verifying: model.verifying, covered: importing != nil) {
                model.dropAttachments(attachKey)
            }
        }
        .presentationDetents([.height(height), .large])
        .presentationDragIndicator(.visible)
        .onAppear {
            if let fork {
                let source = model.detail["summary"]["id"].string == fork.taskId ? model.detail["summary"] : model.summary(of: fork.taskId)
                choice = fork.choice(catalog, source: source); if prompt.isEmpty { prompt = PhoneForkDraft.prompt }
            } else { choice = PhoneStart.defaults(catalog) }
            #if LATCH_SCREENS
            if model.staged, ScreensStage.importing, fork == nil { importing = HistoryScope(model.snapshot, workspaceId: choice.workspaceId) }
            #endif
        }
    }
    private func start() {
        starting = true
        Task {
            let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
            var ids: [String] = []
            if attaches, !model.tray(attachKey).isEmpty {
                // Waits for uploads still on their way; one that cannot go, or rows taken away meanwhile, keep the sheet open.
                guard case let .success(value) = await model.attachmentsToSend(attachKey, target: nil) else { model.endAttachmentSend(attachKey); starting = false; return }
                ids = value
            }
            let started = if let fork, let plan { await model.startFork(fork, plan: plan, prompt: text) } else { await model.start(choice, prompt: text, attachments: ids) }
            model.endAttachmentSend(attachKey)
            starting = false
            if started, model.pending.isEmpty { dismiss() }
        }
    }
    private func row<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.system(size: 15, weight: .medium)).foregroundStyle(PhoneTheme.ink)
            Spacer(minLength: 8)
            value().font(.system(size: 15)).lineLimit(1)
        }.padding(.horizontal, 16).frame(height: 50).contentShape(Rectangle())
    }
    private var updown: some View { Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .medium)).foregroundStyle(PhoneTheme.faint) }
    private var projectName: String {
        guard let id = choice.workspaceId else { return "不用项目" }
        return catalog["workspaces"].array.first { $0["id"].string == id }?["name"].string ?? id
    }
    private var projectRow: some View {
        Menu {
            ForEach(PhoneStart.projects(catalog)) { project in
                Button { choice.workspaceId = project.id } label: { menuLabel(project.name, line: nil, on: project.id == choice.workspaceId) }
            }
            if PhoneStart.acceptsChat(catalog, harnessId: choice.harnessId) {
                Button { choice.workspaceId = nil } label: { menuLabel("不用项目", line: "只对话", on: choice.workspaceId == nil) }
            }
        } label: { row("项目") { HStack(spacing: 6) { Image(systemName: "folder").font(.system(size: 13)).foregroundStyle(PhoneTheme.muted); Text(projectName).foregroundStyle(PhoneTheme.ink2); updown } } }
    }
    private var engineRow: some View {
        Menu {
            Picker("Harness", selection: $choice.harnessId) {
                ForEach(PhoneStart.engines(catalog)) { engine in
                    let info = catalog["harnesses"].array.first { $0["id"].string == engine.id } ?? .null
                    Label { Text(engine.name) } icon: { EngineTile.menuImage(PhoneStart.mark(info), scheme: scheme) }
                        .tag(Optional(engine.id))
                }
            }
            .pickerStyle(.inline)
        } label: {
            row("Harness") {
                HStack(spacing: 6) {
                    if choice.harnessId != nil { EngineTile(mark: PhoneStart.mark(harness), size: 18); Text(PhoneStart.engineName(harness)).foregroundStyle(PhoneTheme.ink2) }
                    else { Text("没有可用的 Harness").foregroundStyle(PhoneTheme.muted) }
                    updown
                }
            }
        }
    }
    @ViewBuilder private var modelRow: some View {
        if !PhoneStart.usesServices(harness) {
            // A fork that keeps the service Latch forwarded this Harness's requests to says so.
            row("模型") { Text(plan?.forwarded?.model ?? "由 Harness 决定").foregroundStyle(plan?.forwarded == nil ? PhoneTheme.muted : PhoneTheme.ink2) }
        } else {
            NavigationLink {
                ModelList(models: PhoneStart.models(catalog), chosen: Binding(get: { shownModel }, set: { choice.model = $0; picked = fork == nil ? nil : $0 }))
            } label: {
                row("模型") {
                    HStack(spacing: 6) {
                        Text(shownModel?.model ?? "还没有模型").foregroundStyle(shownModel == nil ? PhoneTheme.muted : PhoneTheme.ink2)
                        Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(PhoneTheme.faint)
                    }
                }
            }.buttonStyle(.plain)
        }
    }
    @ViewBuilder private func menuLabel(_ name: String, line: String?, on: Bool) -> some View {
        if on { Label(line.map { name + " · " + $0 } ?? name, systemImage: "checkmark") }
        else { Text(line.map { name + " · " + $0 } ?? name) }
    }
}

private struct ModelList: View {
    @Environment(\.dismiss) private var dismiss
    let models: [PhoneModelChoice]
    @Binding var chosen: PhoneModelChoice?
    var body: some View {
        let providers = Array(Dictionary(grouping: models, by: \.providerId).values).sorted { ($0.first?.providerName ?? "") < ($1.first?.providerName ?? "") }
        List {
            ForEach(providers, id: \.first?.providerId) { group in
                Section(group.first?.providerName ?? "") {
                    ForEach(group) { item in
                        Button { chosen = item; dismiss() } label: {
                            HStack {
                                Text(item.model).font(.system(size: 15)).foregroundStyle(PhoneTheme.ink)
                                Spacer()
                                if item == chosen { Image(systemName: "checkmark").foregroundStyle(PhoneTheme.accent) }
                            }
                        }
                    }
                }
            }
        }.navigationTitle("模型").navigationBarTitleDisplayMode(.inline)
    }
}

/** What 接入已有会话 lists from, taken when it opens. */
struct HistoryScope: Identifiable {
    let project: NativeJSON
    let sources: [PhoneHistorySource]
    var id: String { project["id"].string ?? "" }
    init?(_ snapshot: NativeJSON, workspaceId: String?) {
        guard case let .open(sources) = PhoneHistory.entry(snapshot, workspaceId: workspaceId),
              let project = snapshot["catalog"]["workspaces"].array.first(where: { $0["id"].string == workspaceId }) else { return nil }
        self.project = project; self.sources = sources
    }
}
