import LatchNativeCore
import SwiftUI

/** A sheet as tall as what it holds: rows for what the session runs on, then the first message. */
struct NewSessionSheet: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    @State private var choice = PhoneStartChoice()
    @State private var prompt = ""
    @State private var height: CGFloat = 520
    @State private var starting = false
    private var catalog: NativeJSON { model.snapshot["catalog"] }
    private var harness: NativeJSON { catalog["harnesses"].array.first { $0["id"].string == choice.harnessId } ?? .null }
    private var blocker: String? { PhoneStart.blocker(catalog, choice: choice) }
    private var canStart: Bool { blocker == nil && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.canRun && !starting && model.pending.isEmpty }
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                VStack(spacing: 0) {
                    row("Agent") { Text("通用").foregroundStyle(PhoneTheme.ink2) }
                    Divider().overlay(PhoneTheme.line)
                    projectRow
                    Divider().overlay(PhoneTheme.line)
                    engineRow
                    Divider().overlay(PhoneTheme.line)
                    modelRow
                    Divider().overlay(PhoneTheme.line)
                    row("思考") { Text("模型默认").foregroundStyle(PhoneTheme.muted) }
                    Divider().overlay(PhoneTheme.line)
                    row("权限") { HStack(spacing: 6) { Image(systemName: "shield").font(.system(size: 13)); Text("需要时询问") }.foregroundStyle(PhoneTheme.ink2) }
                }
                .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(PhoneTheme.line))
                Text(blocker ?? "改文件前会问你。放宽权限和其他引擎都在 Mac 上开始。").font(PhoneTheme.caption).foregroundStyle(blocker == nil ? PhoneTheme.muted : PhoneTheme.amber)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
                LocalTextEditor(text: $prompt, placeholder: "让 Agent 做点什么…", maximumLines: 6)
                    .overlay(alignment: .topLeading) { if prompt.isEmpty { Text("让 Agent 做点什么…").font(PhoneTheme.body).foregroundStyle(PhoneTheme.faint).allowsHitTesting(false).accessibilityHidden(true) } }
                    .padding(14).frame(minHeight: 110, alignment: .topLeading)
                    .background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 16))
                ForEach(model.pending, id: \.requestId) { pending in
                    HStack {
                        Label("提交结果待确认", systemImage: "clock").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                        Spacer()
                        Button("重试这次提交") { Task { if await model.submit(pending), model.pending.isEmpty { dismiss() } } }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                    }
                }
            }
            .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 16)
            .background(GeometryReader { proxy in Color.clear.onChange(of: proxy.size.height, initial: true) { _, value in height = value + 72 } })
            .frame(maxHeight: .infinity, alignment: .top)
            .navigationTitle("新会话").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消", systemImage: "xmark") { dismiss() }.labelStyle(.iconOnly) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("开始") { start() }.buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(PhoneTheme.accent).disabled(!canStart)
                }
            }
        }
        .presentationDetents([.height(height), .large])
        .presentationDragIndicator(.visible)
        .onAppear { choice = PhoneStart.defaults(catalog) }
    }
    private func start() {
        starting = true
        Task {
            let started = await model.start(choice, prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines))
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
                Button { choice.workspaceId = project.id } label: { menuLabel(project.name, line: project.line, on: project.id == choice.workspaceId) }.disabled(!project.startable)
            }
            if PhoneStart.acceptsChat(catalog, harnessId: choice.harnessId) {
                let startable = PhoneStart.chatStartable(catalog)
                Button { choice.workspaceId = nil } label: { menuLabel("不用项目", line: startable ? "只对话" : PhoneStart.onMac, on: choice.workspaceId == nil) }.disabled(!startable)
            }
        } label: { row("项目") { HStack(spacing: 6) { Image(systemName: "folder").font(.system(size: 13)).foregroundStyle(PhoneTheme.muted); Text(projectName).foregroundStyle(PhoneTheme.ink2); updown } } }
    }
    private var engineRow: some View {
        Menu {
            ForEach(PhoneStart.engines(catalog)) { engine in
                Button { choice.harnessId = engine.id } label: { menuLabel(engine.name, line: engine.line, on: engine.id == choice.harnessId) }.disabled(!engine.startable)
            }
        } label: {
            row("引擎") {
                HStack(spacing: 6) {
                    if choice.harnessId != nil { EngineTile(harnessId: choice.harnessId, size: 18); Text(PhoneStart.engineName(harness)).foregroundStyle(PhoneTheme.ink2) }
                    else { Text("没有可用的引擎").foregroundStyle(PhoneTheme.muted) }
                    updown
                }
            }
        }
    }
    @ViewBuilder private var modelRow: some View {
        if harness["models"].string == "agent" { row("模型") { Text("由引擎决定").foregroundStyle(PhoneTheme.muted) } }
        else {
            NavigationLink {
                ModelList(models: PhoneStart.models(catalog), chosen: $choice.model)
            } label: {
                row("模型") {
                    HStack(spacing: 6) {
                        Text(choice.model?.model ?? "还没有模型").foregroundStyle(choice.model == nil ? PhoneTheme.muted : PhoneTheme.ink2)
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
