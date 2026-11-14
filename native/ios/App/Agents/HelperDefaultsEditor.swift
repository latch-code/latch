import LatchNativeCore
import SwiftUI

/** A versioned patch of defaults. Existing topics keep their own choices; unknown writes retain their original bytes. */
struct HelperDefaultsEditor: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let agent: NativeJSON
    let saved: () -> Void
    @State private var draft: PhoneHelperDraft
    @State private var write: NativePendingWrite?
    @State private var outcome: PhoneAgentWrite?
    @State private var saving = false
    @State private var active = true
    init(agent: NativeJSON, saved: @escaping () -> Void) {
        self.agent = agent; self.saved = saved; _draft = State(initialValue: PhoneHelperCreate.defaults(agent))
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(spacing: 8) {
                    EngineTile(mark: model.engineMark(draft.harnessId), size: 16)
                    Text(model.engineName(draft.harnessId)).font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink)
                }
                HelperDefaultFields(draft: $draft, catalog: model.snapshot["catalog"]).disabled(saving || write != nil)
                if model.engineInfo(draft.harnessId)["level"].string == "L3" { HelperBoundaryNote() }
                if let outcome { WriteNotice(state: outcome, retry: save, reload: { saved(); dismiss() }, held: write) }
                HStack {
                    Spacer()
                    Button(write == nil ? "保存" : "重试同一请求", action: save)
                        .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(PhoneTheme.accent)
                        .disabled(saving || model.busy || !model.canRun || model.agentAccess != .ready)
                }
            }.padding(20).frame(maxWidth: 560).frame(maxWidth: .infinity)
        }
        .navigationTitle("做事方式").navigationBarTitleDisplayMode(.inline).background(PhoneTheme.canvas)
        .interactiveDismissDisabled(saving)
        .onAppear {
            active = true
            if let id = agent["id"].string, let held = model.pending.first(where: { $0.method == "PATCH" && $0.path == "/link/api/custom-agents/" + id }) {
                write = held; outcome = .unknown
                if let value = try? NativeJSON.decode(held.body) {
                    // An earlier patch may belong to another settings page: keep it intact and show only fields it owns.
                    if value.object["model"] != nil { draft.model = value["model"] == .null ? nil : value["model"] }
                    if value.object["engineOptions"] != nil { draft.engineOptions = value["engineOptions"].object.compactMapValues(\.string) }
                    if value.object["defaultProjectId"] != nil { draft.defaultProjectId = value["defaultProjectId"].string }
                }
            }
        }
        .onDisappear { active = false }
        .onChange(of: model.privateSnapshot.epoch) { _, _ in active = false; draft = PhoneHelperDraft(harnessId: ""); write = nil; outcome = nil; dismiss() }
    }
    private func save() {
        guard !saving, !model.busy, model.canRun, model.agentAccess == .ready else { return }
        do { if write == nil { write = try PhoneHelperCreate.changeDefaults(model.snapshot["catalog"], agent: agent, draft: draft) } }
        catch { outcome = .refused("这些选项现在不可用，请重新载入。"); return }
        guard let write else { return }
        let current = model.generation, content = model.privateSnapshot.epoch
        saving = true
        Task {
            let result = await model.writeAgent(write)
            guard active, current == model.generation, model.privateSnapshot.accepts(content) else { return }
            saving = false; outcome = result
            if result == .done { saved(); dismiss() }
            else if result != .unknown { self.write = nil }
        }
    }
}
