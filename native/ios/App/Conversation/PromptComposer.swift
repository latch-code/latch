import LatchNativeCore
import SwiftUI

/** A pill that grows into a card on focus. Where this phone cannot send, a plain line takes its place, with stop still in reach. */
struct PromptComposer: View {
    @EnvironmentObject private var model: PhoneModel
    /** Where unsent text waits while the window is closed; nil where nothing is kept. */
    let draftId: String?
    /** 「给 <名字> 发消息…」 in a topic of 我的 Agent; the engine's own words elsewhere. */
    var placeholder: String? = nil
    /** Why this phone cannot type here; nil when it can. */
    let gate: String?
    let engine: String
    @State private var text = ""
    @State private var focused = false
    @State private var nextModel: PhoneModelChoice?
    /** 「已送达」 for a moment, after 放弃这次提交 found the message already in its session. */
    @State private var settled: String?
    @AppStorage(PhoneFaceID.key) private var faceID = false
    /** The picker the ＋ opened; held here, as the field changes shape when focus leaves it. */
    @State private var attachSource: AttachSource?
    /** Waiting for uploads before the message goes. */
    @State private var sending = false
    private var harness: NativeJSON { model.engineInfo(model.currentSummary["harnessId"].string) }
    private var attachKey: String? { draftId.flatMap { model.sessionId == $0 ? $0 : nil } }
    private var attachments: PhoneAttachTray { attachKey.map { model.tray($0) } ?? PhoneAttachTray() }
    private var heldBack: String? {
        PhoneAttachments.heldBack(followUp, running: running && rejecting == nil, count: attachments.items.count)
    }
    private var running: Bool { ["running", "waiting-approval"].contains(model.currentSummary["status"].string ?? "") }
    /** The drawer above already holds the answers, stop among them where it cannot be allowed. */
    private var drawerOpen: Bool { !model.detail["approvals"].array.isEmpty || !model.detail["questions"].array.isEmpty }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var rejecting: String? {
        // A question's drawer covers any approval, and typing answers what is on screen.
        guard model.engineInfo(model.currentSummary["harnessId"].string)["capabilities"]["permission"]["rejectionNote"].bool, model.detail["questions"].array.isEmpty, let approval = model.detail["approvals"].array.first else { return nil }
        return approval["id"].string
    }
    private var hint: String { rejecting != nil ? "输入内容会拒绝并告诉 Agent 改做什么" : placeholder ?? "回复 " + engine + "…" }
    private var noteTooLong: Bool { rejecting != nil && PhoneConversation.rejectionNoteTooLong(text) }
    /** While a turn runs: 追加 where the Harness takes more text now, else 排队 where the Host queues. */
    private var followUp: PhoneFollowUp {
        PhoneFollowUp.of(detail: model.detail, status: model.currentSummary["status"].string, queues: model.canQueueCurrent)
    }
    private var controls: [PhoneConfigControl] {
        guard model.sessionId != nil, model.detail["summary"]["id"].string == model.sessionId else { return [] }
        return PhoneSessionConfig.controls(model.detail, harness: model.engineInfo(model.currentSummary["harnessId"].string))
    }
    private var canSend: Bool {
        let attached = !attachments.isEmpty && rejecting == nil
        return (!trimmed.isEmpty || attached) && model.canRun && !model.busy && !sending && model.pending.isEmpty && !noteTooLong
            && (!running || rejecting != nil || followUp != .none) && heldBack == nil
    }
    var body: some View {
        VStack(spacing: 8) {
            ForEach(model.pending, id: \.requestId) { pending in
                HStack {
                    Label(PhonePending.words(pending), systemImage: "clock").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                    Spacer()
                    // A new topic's start is retried on its own page or the list, never into this conversation.
                    if PhonePending.retried(pending, at: draftId.map { .session($0) } ?? .list) {
                        Button("重试这次提交") { Task { if PhoneHistory.isImport(pending) { await model.retryPending(pending) } else { await model.submit(pending) } } }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
                    }
                    if PhonePending.prompt(pending) != nil, let draftId, PhonePending.kind(pending) == .session(id: draftId) {
                        Button("放弃这次提交") { Task { await abandon(pending) } }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).disabled(model.busy)
                        InfoHint(text: PromptComposer.abandonHint)
                    }
                }.padding(.horizontal, 16)
            }
            if let settled {
                Label(settled, systemImage: settled == "已送达" ? "checkmark" : "info.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
                    .task { try? await Task.sleep(for: .seconds(4)); self.settled = nil }
            }
            if let attachKey, gate == nil {
                AttachmentRows(key: attachKey, selection: model.attachSelection(attachKey))
                if let heldBack {
                    Text(heldBack).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
                }
            }
            if noteTooLong {
                Text("告诉 Agent 的话最多 \(PhoneConversation.rejectionNoteLimit) 个字").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
            }
            if let gate { gateLine(gate) } else { field }
            if gate == nil && model.sessionId != nil && (focused || !controls.isEmpty) { chips }
        }
        .padding(.bottom, 8).padding(.top, 4)
        .animation(.easeOut(duration: 0.2), value: focused)
        .onAppear { if let held = model.takeDraft(for: draftId) { text = held }; insert() }
        // 加入对话 and 带入输入框 put text after what is written, never send it.
        .onChange(of: draftId.flatMap { model.draftInserts[$0] }) { _, value in if value != nil { insert() } }
        .onDisappear { model.holdDraft(text, for: draftId) }
        // An iPad keeps this composer while the session beside the list changes.
        .onChange(of: draftId) { old, new in model.holdDraft(text, for: old); text = model.takeDraft(for: new) ?? ""; nextModel = nil }
        .onChange(of: model.selectedHost?.id) { _, _ in text = ""; nextModel = nil }
        // A turn that starts takes back 清空上下文, as the web's composer does.
        .onChange(of: running) { _, now in if now, let id = draftId { model.clearing.remove(id) } }
        .onChange(of: model.verifiedUntil) { old, value in
            if value == nil { model.holdDraft(text, for: draftId); text = "" }
            else if old == nil, let held = model.takeDraft(for: draftId) { text = held }
        }
        .modifier(AttachSupport(key: attachKey, selection: attachKey.flatMap { model.attachSelection($0) }, harness: harness, source: $attachSource))
    }
    private func insert() {
        guard let added = model.takeInsert(for: draftId) else { return }
        text = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? added : text + "\n\n" + added
    }
    private func gateLine(_ words: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: gate == "Mac 不在线" ? "wifi.slash" : gate == Self.closedWindow ? PhoneUnlock.closedWindowSymbol(faceID: faceID) : "laptopcomputer").font(.system(size: 14)).foregroundStyle(PhoneTheme.muted)
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
        let attach = attachKey != nil && rejecting == nil
        return layout {
            if attach && !open { AttachButton(key: attachKey!, harness: harness, selection: model.attachSelection(attachKey!), source: $attachSource).padding(.leading, -8) }
            editor.layoutPriority(1)
            HStack(spacing: 8) {
                if attach && open { AttachButton(key: attachKey!, harness: harness, selection: model.attachSelection(attachKey!), source: $attachSource).padding(.leading, -6) }
                Spacer(minLength: 0)
                action
            }.frame(maxWidth: open ? .infinity : nil, alignment: .trailing)
        }
        .padding(.leading, 16).padding(.trailing, open ? 10 : 8).padding(.top, open ? 12 : 0).padding(.bottom, open ? 10 : 0).frame(minHeight: 52)
        .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: open ? 22 : 26))
        .overlay(RoundedRectangle(cornerRadius: open ? 22 : 26).stroke(PhoneTheme.lineStrong))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
        .padding(.horizontal, 12)
    }
    private var editor: some View {
        LocalTextEditor(text: $text, placeholder: hint, focused: $focused)
            .overlay(alignment: .topLeading) { if text.isEmpty { Text(hint).font(PhoneTheme.body).foregroundStyle(PhoneTheme.faint).lineLimit(1).allowsHitTesting(false).accessibilityHidden(true) } }
    }
    /** Empty while a turn runs, the circle stops it; with text it queues. */
    @ViewBuilder private var action: some View {
        if running && trimmed.isEmpty { stopButton(quiet: drawerOpen) }
        else if running && rejecting == nil && followUp != .none {
            let steer = followUp == .steer
            Button { send() } label: {
                Text(steer ? "追加" : "排队").font(.system(size: 14, weight: .semibold)).foregroundStyle(canSend ? Color.white : PhoneTheme.faint)
                    .padding(.horizontal, 14).frame(height: 36).background(canSend ? PhoneTheme.accent : PhoneTheme.bubble, in: Capsule())
            }.buttonStyle(.plain).disabled(!canSend).accessibilityLabel(steer ? "追加到本轮" : "排队发送")
        } else {
            Button { send() } label: {
                Group {
                    if sending { ProgressView().controlSize(.small).tint(Color.white) }
                    else { Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)).foregroundStyle(canSend ? Color.white : PhoneTheme.faint) }
                }.frame(width: 36, height: 36).background(canSend || sending ? PhoneTheme.accent : PhoneTheme.bubble, in: Circle())
            }.buttonStyle(.plain).disabled(!canSend).accessibilityLabel(sending ? "等待附件上传" : running ? "排队发送" : "发送")
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
        let input = text, reject = rejecting, next = followUp
        let queue = running && reject == nil && next == .queue, steer = running && reject == nil && next == .steer
        // The send's target is fixed now: after waiting for uploads it goes to this session or nowhere.
        let chosen = nextModel, key = attachKey, target = model.sessionId
        Task {
            let sent: Bool
            if let reject { sent = await model.mutate(.post, path: PhoneModel.approvalPath(reject), fields: ["decision": .string("reject"), "note": .string(input)]) }
            else {
                // A send waits for the uploads still on their way; one that cannot go keeps the message here.
                var ids: [String] = []
                if let key, !model.tray(key).isEmpty {
                    sending = true
                    let ready = await model.attachmentsToSend(key, target: target)
                    sending = false
                    guard case let .success(value) = ready else { model.endAttachmentSend(key); return }
                    ids = value
                }
                sent = await model.send(text: input, queue: queue, steer: steer, nextModel: chosen, attachments: ids, target: ids.isEmpty ? nil : .some(target))
                if let key { model.endAttachmentSend(key) }
            }
            if sent, text == input { text = "" }
        }
    }
    /** One scrolling row above the keyboard. The built-in engine takes a model for each message; the Host offers no other choice before a send. */
    private var chips: some View {
        let summary = model.currentSummary, models = PhoneStart.models(model.snapshot["catalog"])
        let current = nextModel?.model ?? summary["model"].string
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ConfigChips(controls: controls) { label in AnyView(chip { label }) }
                if !models.isEmpty, PhoneStart.usesServices(model.engineInfo(summary["harnessId"].string)) {
                    Menu {
                        ForEach(models) { item in
                            Button { nextModel = item } label: {
                                if item.model == current { Label(item.model, systemImage: "checkmark") } else { Text(item.model) }
                            }
                        }
                    } label: {
                        chip { HStack(spacing: 6) { EngineTile(mark: model.engineMark(summary["harnessId"].string), size: 14); Text(current ?? "模型"); Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)) } }
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

extension PromptComposer {
    static let abandonHint = "重试沿用同一请求，电脑已经收到的不会再算一次。放弃这次提交只在这台设备上放下它，文字回到输入框；电脑如果其实已经收到，它会出现在会话里，再发送就是第二条消息。"
    static let abandonStartHint = "重试沿用同一请求，电脑已经收到的不会再开一个会话。放弃这次提交只在这台设备上放下它，文字回到输入框；电脑如果其实已经收到，那个会话会出现在列表里，再发送会开始另一个会话，可能另建一个工作树。"
    /** The text goes back after whatever was written meanwhile. */
    fileprivate func abandon(_ pending: NativePendingWrite) async {
        switch await model.abandonPrompt(pending) {
        case .delivered: settled = "已送达"
        case let .text(back, twin):
            text = PhonePending.joined(text, back)
            if twin { settled = PhoneAbandoned.queuedTwinWords }
        case nil: break
        }
    }
}
