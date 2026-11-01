import LatchNativeCore
import SwiftUI

/** A pill that grows into a card on focus. Where this phone cannot send, a plain line takes its place, with stop still in reach. */
struct PromptComposer: View {
    @EnvironmentObject private var model: PhoneModel
    /** Where unsent text waits while the window is closed; nil where nothing is kept. */
    let draftId: String?
    /** Why this phone cannot type here; nil when it can. */
    let gate: String?
    let engine: String
    @State private var text = ""
    @State private var focused = false
    @State private var nextModel: PhoneModelChoice?
    private var running: Bool { ["running", "waiting-approval"].contains(model.currentSummary["status"].string ?? "") }
    /** The drawer above already holds the answers, stop among them where it cannot be allowed. */
    private var drawerOpen: Bool { !model.detail["approvals"].array.isEmpty || !model.detail["questions"].array.isEmpty }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var rejecting: String? {
        // A question's drawer covers any approval, and typing answers what is on screen.
        guard model.snapshot["host"]["rejectionNote"].bool, model.detail["questions"].array.isEmpty, let approval = model.detail["approvals"].array.first, !approval["advisory"].bool else { return nil }
        return approval["id"].string
    }
    private var placeholder: String { rejecting != nil ? "输入内容会拒绝并告诉 Agent 改做什么" : "回复 " + engine + "…" }
    private var noteTooLong: Bool { rejecting != nil && PhoneConversation.rejectionNoteTooLong(text) }
    private var canSend: Bool {
        !trimmed.isEmpty && model.canRun && !model.busy && model.pending.isEmpty && !noteTooLong && (!running || rejecting != nil || model.canQueueCurrent)
    }
    var body: some View {
        VStack(spacing: 8) {
            ForEach(model.pending, id: \.requestId) { pending in
                HStack {
                    Label("提交结果待确认", systemImage: "clock").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                    Spacer()
                    Button("重试这次提交") { Task { await model.submit(pending) } }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                }.padding(.horizontal, 16)
            }
            if noteTooLong {
                Text("告诉 Agent 的话最多 \(PhoneConversation.rejectionNoteLimit) 个字").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
            }
            if let gate { macLine(gate) } else { field }
            if gate == nil && focused && model.sessionId != nil { chips }
        }
        .padding(.bottom, 8).padding(.top, 4)
        .animation(.easeOut(duration: 0.2), value: focused)
        .onAppear { if let held = model.takeDraft(for: draftId) { text = held } }
        .onDisappear { model.holdDraft(text, for: draftId) }
        // An iPad keeps this composer while the session beside the list changes.
        .onChange(of: draftId) { old, new in model.holdDraft(text, for: old); text = model.takeDraft(for: new) ?? ""; nextModel = nil }
        .onChange(of: model.selectedHost?.id) { _, _ in text = ""; nextModel = nil }
        .onChange(of: model.verifiedUntil) { old, value in
            if value == nil { model.holdDraft(text, for: draftId); text = "" }
            else if old == nil, let held = model.takeDraft(for: draftId) { text = held }
        }
    }
    private func macLine(_ words: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: gate == "Mac 不在线" ? "wifi.slash" : gate == Self.closedWindow ? "faceid" : "laptopcomputer").font(.system(size: 14)).foregroundStyle(PhoneTheme.muted)
            Text(words).font(.system(size: 15)).foregroundStyle(PhoneTheme.muted).lineLimit(2)
            Spacer(minLength: 4)
            if running && gate != "Mac 不在线" && model.detail["approvals"].array.isEmpty { stopButton(quiet: false) }
        }
        .padding(.leading, 16).padding(.trailing, 8).frame(minHeight: 52)
        .background(PhoneTheme.raised, in: Capsule()).overlay(Capsule().stroke(PhoneTheme.lineStrong))
        .padding(.horizontal, 12)
    }
    static let closedWindow = "查看内容后可以回复"
    private var field: some View {
        let open = focused || !text.isEmpty
        // One layout that changes shape: separate branches would replace the text view, and with it the keyboard, on every focus.
        let layout = open ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
        return layout {
            editor.layoutPriority(1)
            action.frame(maxWidth: open ? .infinity : nil, alignment: .trailing)
        }
        .padding(.leading, 16).padding(.trailing, open ? 10 : 8).padding(.top, open ? 12 : 0).padding(.bottom, open ? 10 : 0).frame(minHeight: 52)
        .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: open ? 22 : 26))
        .overlay(RoundedRectangle(cornerRadius: open ? 22 : 26).stroke(PhoneTheme.lineStrong))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
        .padding(.horizontal, 12)
    }
    private var editor: some View {
        LocalTextEditor(text: $text, placeholder: placeholder, focused: $focused)
            .overlay(alignment: .topLeading) { if text.isEmpty { Text(placeholder).font(PhoneTheme.body).foregroundStyle(PhoneTheme.faint).lineLimit(1).allowsHitTesting(false).accessibilityHidden(true) } }
    }
    /** Empty while a turn runs, the circle stops it; with text it queues. */
    @ViewBuilder private var action: some View {
        if running && trimmed.isEmpty { stopButton(quiet: drawerOpen) }
        else {
            Button { send() } label: {
                Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)).foregroundStyle(canSend ? Color.white : PhoneTheme.faint)
                    .frame(width: 36, height: 36).background(canSend ? PhoneTheme.accent : PhoneTheme.bubble, in: Circle())
            }.buttonStyle(.plain).disabled(!canSend).accessibilityLabel(running ? "排队发送" : "发送")
        }
    }
    /** While a drawer waits on you, stop steps back without going away. */
    private func stopButton(quiet: Bool) -> some View {
        Button { Task { await model.stop() } } label: {
            Group {
                if model.stoppingCurrent { ProgressView().controlSize(.small).tint(PhoneTheme.canvas) }
                else { RoundedRectangle(cornerRadius: 2).fill(quiet ? PhoneTheme.muted : PhoneTheme.canvas).frame(width: 12, height: 12) }
            }.frame(width: 36, height: 36).background(quiet ? PhoneTheme.bubble : PhoneTheme.ink, in: Circle())
        }.buttonStyle(.plain).disabled(model.stoppingCurrent).accessibilityLabel(model.stoppingCurrent ? "正在停止" : "停止")
    }
    private func send() {
        let input = text, reject = rejecting, queue = running && reject == nil
        let chosen = nextModel
        Task {
            let sent: Bool
            if let reject { sent = await model.mutate(.post, path: PhoneModel.approvalPath(reject), fields: ["decision": .string("reject"), "note": .string(input)]) }
            else { sent = await model.send(text: input, queue: queue, nextModel: chosen) }
            if sent, text == input { text = "" }
        }
    }
    /** One scrolling row above the keyboard. The built-in engine takes a model for each message; the Host offers no other choice before a send. */
    private var chips: some View {
        let summary = model.currentSummary, models = PhoneStart.models(model.snapshot["catalog"])
        let current = nextModel?.model ?? summary["model"].string
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip { Text(summary["personal"]["assistantId"].string == nil ? "通用" : "助手") }
                if !models.isEmpty, model.engineInfo(summary["harnessId"].string)["models"].string == "host" {
                    Menu {
                        ForEach(models) { item in
                            Button { nextModel = item } label: {
                                if item.model == current { Label(item.model, systemImage: "checkmark") } else { Text(item.model) }
                            }
                        }
                    } label: {
                        chip { HStack(spacing: 6) { EngineTile(harnessId: summary["harnessId"].string, size: 14); Text(current ?? "模型"); Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)) } }
                    }
                }
            }.padding(.horizontal, 12)
        }
    }
    private func chip<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content().font(.system(size: 13)).foregroundStyle(PhoneTheme.ink2).lineLimit(1).padding(.horizontal, 12).frame(height: 32)
            .background(PhoneTheme.raised, in: Capsule()).overlay(Capsule().stroke(PhoneTheme.line))
    }
}
