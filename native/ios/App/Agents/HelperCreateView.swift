import LatchNativeCore
import SwiftUI

/** Creation is a draft until the one Create button allocates its request. A held request never takes today's defaults. */
struct HelperCreateSheet: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let created: (String) -> Void
    @State private var draft = PhoneHelperDraft(harnessId: "")
    @State private var choosing = true
    @State private var write: NativePendingWrite?
    @State private var outcome: PhoneAgentWrite?
    @State private var completedId: String?
    @State private var saving = false
    @State private var active = true
    @State private var words = false
    @State private var more = false
    private var catalog: NativeJSON { model.snapshot["catalog"] }
    private var candidates: (ready: [PhoneHelperCandidate], waiting: [PhoneHelperCandidate]) { PhoneHelperCreate.candidates(catalog) }
    private var selected: PhoneHelperCandidate? { (candidates.ready + candidates.waiting).first { $0.id == draft.harnessId } }
    private var locked: Bool { saving || write != nil }
    private var canCreate: Bool {
        active && completedId == nil && model.canRun && model.agentAccess == .ready && !model.busy && !saving
            && model.pending.allSatisfy { $0.requestId == write?.requestId }
            && (write != nil || (try? PhoneHelperCreate.create(catalog, draft: draft, requestId: "helper-draft-validation")) != nil)
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if choosing { candidateList } else { identity }
                    if completedId != nil {
                        HStack {
                            Label("已创建 · 列表暂未更新", systemImage: "checkmark").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                            Spacer()
                            Button("刷新并打开") { openCreated() }.font(PhoneTheme.caption).disabled(saving || !model.connected)
                        }
                    }
                    if let outcome {
                        WriteNotice(state: outcome, retry: { save() }, held: write, settled: {
                            guard active else { return }
                            active = false; write = nil; self.outcome = nil; dismiss()
                        })
                    }
                }.padding(20).frame(maxWidth: 560).frame(maxWidth: .infinity)
            }
            .background(PhoneTheme.canvas)
            .navigationTitle(choosing ? "新建 Agent" : "给它一个名字")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(saving) }
                if !choosing {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(write == nil ? "创建" : "重试同一请求") { save() }.fontWeight(.semibold).disabled(!canCreate)
                    }
                }
            }
        }
        .interactiveDismissDisabled(saving)
        .onAppear { active = true; restore() }
        .onDisappear { active = false }
        .onChange(of: model.privateSnapshot.epoch) { _, _ in
            active = false; draft = PhoneHelperDraft(harnessId: ""); write = nil; outcome = nil; completedId = nil; dismiss()
        }
        .onChange(of: model.agentAccess) { _, access in if access != .ready { dismiss() } }
    }
    private var candidateList: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("你想让谁成为你的帮手？").font(.system(size: 21, weight: .semibold)).foregroundStyle(PhoneTheme.ink)
            VStack(spacing: 0) {
                ForEach(Array(candidates.ready.enumerated()), id: \.element.id) { index, candidate in
                    if index > 0 { Divider().padding(.leading, 68) }
                    Button { choose(candidate.id) } label: { candidateRow(candidate) }.buttonStyle(.plain)
                }
            }.background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 18))
            if candidates.ready.isEmpty { Text("还没有可用的帮手").font(PhoneTheme.body).foregroundStyle(PhoneTheme.muted) }
            if !candidates.waiting.isEmpty {
                DisclosureGroup("没准备好 · \(candidates.waiting.count)") {
                    ForEach(candidates.waiting) { candidate in candidateRow(candidate) }
                }.font(PhoneTheme.caption).tint(PhoneTheme.muted)
            }
        }
    }
    private func candidateRow(_ candidate: PhoneHelperCandidate) -> some View {
        HStack(alignment: .top, spacing: 12) {
            AgentFace(avatar: .parse(PhoneHelperCreate.firstFace(candidate.card, agents: model.snapshot["customAgents"].array)), size: 40)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(PhoneConversation.visible(candidate.name)).font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink)
                    EngineTile(mark: candidate.mark, size: 14)
                    Spacer(minLength: 0)
                    if candidate.reason == nil { Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(PhoneTheme.faint) }
                }
                if let line = candidate.reason ?? candidate.card["line"].string, !line.isEmpty {
                    Text(PhoneConversation.visible(line)).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).fixedSize(horizontal: false, vertical: true)
                }
                if candidate.reason == nil {
                    Text(candidate.abilities.map { HelperWords.abilities[$0] ?? $0 }.joined(separator: " · "))
                        .font(.system(size: 12)).foregroundStyle(PhoneTheme.muted).fixedSize(horizontal: false, vertical: true)
                    if candidate.unasked { Text("不先问你").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
                }
            }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }
    private var identity: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 12) {
                AgentFace(avatar: .parse(draft.avatar), size: 52)
                VStack(alignment: .leading, spacing: 4) {
                    Text(PhoneConversation.visible(selected?.name ?? draft.harnessId)).font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink)
                    Button("换一个") { choosing = true }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).disabled(locked)
                }
                Spacer()
                HelperAvatarPicker(avatar: $draft.avatar).disabled(locked)
            }
            field("名字") { LocalTextEditor(text: $draft.name, placeholder: "给它一个名字", maximumLines: 1) }
            if draft.name.utf16.count > 80 { limit("名字最多 80 字") }
            field("职责") { LocalTextEditor(text: $draft.description, placeholder: "一句话，例如：查资料，写成一页摘要", maximumLines: 3) }
            if draft.description.utf16.count > 200 { limit("职责最多 200 字") }
            DisclosureGroup("多说几句", isExpanded: $words) {
                field("指令") { LocalTextEditor(text: $draft.instructions, placeholder: "怎么做，哪些事需要留意", maximumLines: 10) }.padding(.top, 10)
                if draft.instructions.utf16.count > 32_000 { limit("指令最多 32000 字") }
            }.font(PhoneTheme.row).tint(PhoneTheme.muted)
            DisclosureGroup("更多", isExpanded: $more) {
                HelperDefaultFields(draft: $draft, catalog: catalog).padding(.top, 12)
            }.font(PhoneTheme.row).tint(PhoneTheme.muted)
            if PhoneStart.harness(catalog, draft.harnessId)["level"].string == "L3" { HelperBoundaryNote() }
            if let reason = selected?.reason { limit(PhoneConversation.visible(reason)) }
        }.disabled(locked)
    }
    private func limit(_ text: String) -> some View { Text(text).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
    private func field<Value: View>(_ title: String, @ViewBuilder value: () -> Value) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            value().padding(12).background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 12)).accessibilityLabel(title)
        }
    }
    private func choose(_ id: String) {
        do {
            draft = try PhoneHelperCreate.choose(catalog, harnessId: id, agents: model.snapshot["customAgents"].array, previous: draft.harnessId.isEmpty ? nil : draft)
            choosing = false; outcome = nil
        } catch { outcome = .refused("这个帮手现在不能用。") }
    }
    private func restore() {
        guard let held = try? PhoneHelperCreate.pending(model.pending), let fields = try? NativeJSON.decode(held.body) else { return }
        var restored = PhoneHelperDraft(harnessId: fields["harnessId"].string ?? "")
        restored.name = fields["name"].string ?? ""; restored.description = fields["description"].string ?? ""
        restored.instructions = fields["instructions"].string ?? ""; restored.avatar = fields["avatar"]
        restored.model = fields["model"] == .null ? nil : fields["model"]
        restored.engineOptions = fields["engineOptions"].object.compactMapValues(\.string)
        restored.defaultProjectId = fields["defaultProjectId"].string
        draft = restored; write = held; choosing = false; outcome = .unknown
    }
    private func save() {
        guard canCreate else { return }
        do { if write == nil { write = try PhoneHelperCreate.create(catalog, draft: draft) } }
        catch { outcome = .refused("检查名字、职责和所选设置后再试。"); return }
        guard let write else { return }
        let current = model.generation, content = model.privateSnapshot.epoch
        saving = true
        Task {
            let result = await model.writeAgent(write)
            guard active, current == model.generation, model.privateSnapshot.accepts(content) else { return }
            saving = false; outcome = result
            if result == .done, let receipt = model.createdHelper, receipt.requestId == write.requestId {
                if model.snapshot["customAgents"].array.contains(where: { $0["id"].string == receipt.id }) { created(receipt.id) }
                else { completedId = receipt.id }
            }
            else if result != .unknown { self.write = nil }
        }
    }
    private func openCreated() {
        guard let id = completedId else { return }
        let current = model.generation, content = model.privateSnapshot.epoch
        saving = true
        Task {
            _ = await model.refresh()
            guard active, current == model.generation, model.privateSnapshot.accepts(content) else { return }
            saving = false
            if model.snapshot["customAgents"].array.contains(where: { $0["id"].string == id }) { created(id) }
        }
    }
}

enum HelperWords {
    static let abilities = ["files": "文件", "commands": "命令", "mcp": "MCP", "ask": "提问", "memory": "记事", "schedule": "定时"]
}

struct HelperAvatarPicker: View {
    @Binding var avatar: NativeJSON
    var body: some View {
        Menu("换头像") {
            Menu("括号") { ForEach(Array(zip(PhoneAgentAvatar.brackets, ["圆括号", "花括号", "方括号", "尖括号"])), id: \.0) { key, name in Button(name) { set("bracket", key) } } }
            Menu("眼睛") { ForEach(Array(zip(PhoneAgentAvatar.eyeKinds, ["圆点", "弯弯", "椭圆", "困困"])), id: \.0) { key, name in Button(name) { set("eyes", key) } } }
            Menu("颜色") { ForEach(Array(zip(PhoneAgentAvatar.hues, ["墨", "石板", "松", "梅", "藤", "可可", "沙", "苔", "雾"])), id: \.0) { key, name in Button(name) { set("hue", key) } } }
        }.font(PhoneTheme.caption).tint(PhoneTheme.muted)
    }
    private func set(_ key: String, _ value: String) { var fields = avatar.object; fields[key] = .string(value); avatar = .object(fields) }
}

/** Saved defaults use only current, declared choices. Nothing is preselected from Code's last conversation. */
struct HelperDefaultFields: View {
    @Binding var draft: PhoneHelperDraft
    let catalog: NativeJSON
    private var harness: NativeJSON { PhoneStart.harness(catalog, draft.harnessId) }
    private var options: [NativeJSON] {
        var offered = harness["catalogue"]["options"].array
        if let model = offered.first(where: { $0["category"].string == "model" }), let id = model["id"].string,
           let picked = draft.engineOptions[id], picked != model["currentValue"].string {
            offered = offered.filter { !["thought_level", "model_config"].contains($0["category"].string ?? "") }
                + (harness["catalogue"]["perModel"].array.first { $0["model"].string == picked }?["options"].array ?? [])
        }
        return offered.filter { ["model", "thought_level"].contains($0["category"].string ?? "") && draft.model == nil }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            row("用的模型") {
                Menu {
                    Button { draft.model = nil } label: { checked("默认", on: draft.model == nil) }
                    ForEach(PhoneHelperCreate.services(catalog, harnessId: draft.harnessId)) { item in
                        Button {
                            draft.model = .object(["providerId": .string(item.choice.providerId), "model": .string(item.choice.model)])
                            for option in harness["catalogue"]["options"].array + harness["catalogue"]["perModel"].array.flatMap({ $0["options"].array }) where ["model", "thought_level", "model_config"].contains(option["category"].string ?? "") {
                                if let id = option["id"].string { draft.engineOptions[id] = nil }
                            }
                        } label: {
                            checked(item.choice.model + " · " + item.choice.providerName + (item.experimental ? " · 实验性" : ""),
                                on: draft.model?["providerId"].string?.utf8.elementsEqual(item.choice.providerId.utf8) == true
                                    && draft.model?["model"].string?.utf8.elementsEqual(item.choice.model.utf8) == true)
                        }
                    }
                } label: { value(draft.model?["model"].string ?? "默认") }
            }
            if let chosen = draft.model, let provider = chosen["providerId"].string, let name = chosen["model"].string,
               let service = catalog["providers"].array.first(where: { $0["id"].string == provider }),
               !service["modelCapabilities"][name]["thinking"].array.isEmpty {
                row("思考") {
                    Menu {
                        Button { setEffort(nil) } label: { checked("默认", on: chosen["effort"] == .null) }
                        ForEach(service["modelCapabilities"][name]["thinking"].array.compactMap(\.string), id: \.self) { effort in
                            Button { setEffort(effort) } label: { checked(effort.capitalized, on: chosen["effort"].string == effort) }
                        }
                    } label: { value(chosen["effort"].string?.capitalized ?? "默认") }
                }
            }
            ForEach(options, id: \.id) { option in
                if let id = option["id"].string {
                    row(option["category"].string == "model" ? "自己的模型" : "思考") {
                        Menu {
                            Button {
                                if option["category"].string == "model" { selectNativeModel(nil) }
                                else { draft.engineOptions[id] = nil }
                            } label: { checked("默认", on: draft.engineOptions[id] == nil) }
                            ForEach(Array(option["options"].array.enumerated()), id: \.offset) { _, item in
                                if let raw = item["value"].string {
                                    Button {
                                        if option["category"].string == "model" {
                                            selectNativeModel(raw)
                                        } else { draft.engineOptions[id] = raw }
                                    } label: { checked(item["name"].string ?? raw, on: draft.engineOptions[id] == raw) }
                                }
                            }
                        } label: { value(draft.engineOptions[id].flatMap { selected in option["options"].array.first { $0["value"].string == selected }?["name"].string } ?? draft.engineOptions[id] ?? "默认") }
                    }
                }
            }
            row("做事前") {
                let modes = harness["permission"]["modes"].array.compactMap(\.string)
                if modes.isEmpty { Text(harness["permission"]["approvals"].string == "none" ? "不先问你" : "先问你").foregroundStyle(harness["permission"]["approvals"].string == "none" ? PhoneTheme.amber : PhoneTheme.ink) }
                else {
                    Menu {
                        Button { draft.engineOptions["~mode"] = nil } label: { checked("默认", on: draft.engineOptions["~mode"] == nil) }
                        ForEach(modes, id: \.self) { mode in
                            Button { draft.engineOptions["~mode"] = mode } label: { checked(modeName(mode), on: draft.engineOptions["~mode"] == mode) }
                        }
                    } label: {
                        value(draft.engineOptions["~mode"].map(modeName) ?? harness["permission"]["startMode"].string.map(modeName) ?? "默认",
                            warning: harness["permission"]["modeTiers"][draft.engineOptions["~mode"] ?? ""]["tier"].string == "never")
                    }
                }
            }
            row("工作位置") {
                Menu {
                    ForEach(PhoneHelperCreate.projects(catalog, harnessId: draft.harnessId)) { place in
                        Button { draft.defaultProjectId = place.id == "default" ? nil : place.id } label: {
                            checked(place.name, on: place.id == (draft.defaultProjectId ?? "default"))
                        }.disabled(place.unavailable != nil)
                    }
                } label: { value(draft.defaultProjectId.map { id in PhoneHelperCreate.projects(catalog, harnessId: draft.harnessId).first { $0.id == id }?.name ?? "项目不可用" } ?? "家") }
            }
        }
    }
    private func modeName(_ mode: String) -> String {
        let tier = harness["permission"]["modeTiers"][mode]
        return tier["name"].string ?? tier["tier"].string.flatMap { PhoneConversation.tierTitles[$0] } ?? mode
    }
    private func setEffort(_ effort: String?) {
        guard var selected = draft.model?.object else { return }
        selected["effort"] = effort.map(NativeJSON.string); draft.model = .object(selected)
    }
    private func selectNativeModel(_ value: String?) {
        if let next = try? PhoneHelperCreate.selectNativeModel(catalog, draft: draft, value: value) { draft = next }
    }
    @ViewBuilder private func checked(_ text: String, on: Bool) -> some View {
        if on { Label(PhoneConversation.visible(text), systemImage: "checkmark") }
        else { Text(PhoneConversation.visible(text)) }
    }
    private func row<Value: View>(_ title: String, @ViewBuilder content: () -> Value) -> some View {
        HStack(alignment: .top, spacing: 12) { Text(title).foregroundStyle(PhoneTheme.muted); Spacer(minLength: 8); content() }.font(PhoneTheme.row)
    }
    private func value(_ text: String, warning: Bool = false) -> some View {
        HStack(spacing: 5) { Text(PhoneConversation.visible(text)).lineLimit(2); Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)) }.foregroundStyle(warning ? PhoneTheme.amber : PhoneTheme.ink)
    }
}

struct HelperBoundaryNote: View {
    var body: some View {
        HStack(spacing: 6) {
            Text("Latch 不隔离它").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            HintButton(label: "本机能力", text: "它能读写本机文件、运行命令。家是默认工作文件夹，不是隔离；做事前的选择只决定何时问你。")
        }
    }
}
