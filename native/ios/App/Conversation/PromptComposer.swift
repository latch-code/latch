import LatchNativeCore
import SwiftUI
import UIKit

/** A pill that grows into a card on focus. Where this phone cannot send, a plain line takes its place, with stop still in reach. */
struct PromptComposer: View {
    @EnvironmentObject private var model: PhoneModel
    @ObservedObject var drafts: PhoneConversationDrafts
    /** Where unsent text waits while the window is closed; nil where nothing is kept. */
    let draftId: String?
    /** 「给 <名字> 发消息…」 in a topic of 我的 Agent; the engine's own words elsewhere. */
    var placeholder: String? = nil
    /** Why this phone cannot type here; nil when it can. */
    let gate: String?
    let editsOffline: Bool
    let engine: String
    var person: Bool = false
    var newTopic: ((String) -> Void)? = nil
    private var draftText: Binding<String> {
        let opening = drafts.opening, window = model.privateSnapshot.epoch, id = draftId
        func visible() -> Bool {
            drafts.opening == opening && model.sessionId == id && model.hasContentWindow && model.privateSnapshot.accepts(window)
        }
        return Binding(get: { drafts.text(for: id, visible: visible()) },
            set: { drafts.set($0, for: id, opening: opening, permitted: visible()) })
    }
    private var text: String {
        get { draftText.wrappedValue }
        nonmutating set { draftText.wrappedValue = newValue }
    }
    @State private var focused = false
    @State private var nextModel: PhoneModelChoice?
    /** 「已送达」 for a moment, after 放弃这次提交 found the message already in its session. */
    @State private var settled: String?
    @AppStorage(PhoneFaceID.key) private var faceID = false
    /** The picker opened from the input menu. */
    @State private var attachSource: AttachSource?
    /** Waiting for uploads before the message goes. */
    @State private var sending = false
    @StateObject private var slash = SlashComposerState()
    @State private var slashSpace: CGFloat = 198
    @State private var slashControl: SlashControlRequest?
    @State private var slashStart: SlashStartDraft?
    private var slashCommands: [NativeJSON] { model.detail["summary"]["id"].string == draftId ? model.detail["commands"].array : [] }
    private var slashContext: PhoneSlashContext {
        var value = PhoneSlashContext(bodyOpen: draftId != nil && gate == nil && rejecting == nil && !drawerOpen
            && model.verifiedUntil.map { $0 > Date() } == true && model.detail["summary"]["id"].string == draftId, canRun: model.canRun)
        value.pending = !model.pending.isEmpty || model.busy || sending; value.running = running; value.session = draftId != nil
        value.harnessId = model.currentSummary["harnessId"].string; value.projectId = model.currentSummary["workspaceId"].string
        if !person || newTopic != nil { value.actions.insert(.new) }
        if model.detail["clearContext"].bool || model.openClearing { value.actions.insert(.clear) }
        if forkDraft != nil { value.actions.insert(.fork) } else { value.actionReasons[.fork] = "还没有可分叉的回复" }
        if controls.contains(where: { $0.kind == .model }) || PhoneStart.usesServices(harness) && !PhoneStart.models(model.snapshot["catalog"]).isEmpty { value.actions.insert(.model) }
        if controls.contains(where: { $0.kind == .thinking }) { value.actions.insert(.think) } else { value.actionReasons[.think] = "这个模型没有思考档位" }
        if controls.contains(where: { $0.kind == .permission }) { value.actions.insert(.permissions) }
        if value.projectId != nil, PhoneReview.readsTurns(model.snapshot) { value.actions.insert(.changes) }
        return value
    }
    private var slashMenu: PhoneSlashMenu? { slashSpace < 44 ? nil : slash.menu(text, commands: slashCommands, context: slashContext, focused: focused) }
    private var slashRead: SlashReadKey { SlashReadKey(model: model, enabled: focused && slashContext.bodyOpen, retry: slash.retry) }
    private var slashReason: String? {
        guard rejecting == nil else { return nil }
        if case let .unavailable(reason) = PhoneSlash.action(text, context: slashContext) { return reason }; return nil
    }
    private var forkDraft: PhoneForkDraft? {
        guard model.canFork, !running, model.currentSummary["personal"] == .null, let id = draftId else { return nil }
        let turns = PhoneConversation.turns(model.detail["messages"].array)
        guard let last = turns.last, let end = PhoneTurnActions.of(last, latest: true, running: false, canSend: model.canRun, canFork: true).forkFrom else { return nil }
        return PhoneForkDraft(taskId: id, upToMessageId: end, title: model.currentSummary["title"].string ?? "", turn: turns.count)
    }
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
        guard model.transportReady else { return false }
        if rejecting == nil, PhoneSlash.actionOf(text) != nil {
            if case .open = PhoneSlash.action(text, context: slashContext) { return !slash.composing }; return false
        }
        let attached = !attachments.isEmpty && rejecting == nil
        return (!trimmed.isEmpty || attached) && model.canRun && !model.busy && !sending && !slash.composing && model.pending.isEmpty && !noteTooLong
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
                        Button("重试这次提交") { Task { if PhoneHistory.isImport(pending) { await model.retryPending(pending) } else { await model.submit(pending) } } }.font(PhoneTheme.caption).disabled(model.busy || !model.transportReady)
                    }
                    if PhoneQueueControl(pending) != nil, let draftId, PhonePending.kind(pending) == .session(id: draftId) {
                        AbandonQueueChange(pending: pending)
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
            if let slashReason { Text(slashReason).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16) }
            if let menu = slashMenu {
                SlashSuggestions(menu: menu, active: slash.active(menu, text: text), engine: engine,
                    mark: model.engineMark(model.currentSummary["harnessId"].string), reportedCommands: slashCommands.count, loading: slash.loading, failure: slash.failure,
                    maximumHeight: slashSpace, retry: { slash.retry += 1 }, choose: { slash.complete(menu, option: $0, text: draftText, enabled: slashContext.bodyOpen && slashContext.canRun && !slashContext.pending) })
                    .padding(.horizontal, 12)
            }
            if let draftId {
                CodexTeamView(sessionId: draftId, draft: draftText,
                    canPrepare: gate == nil && model.canRun && model.connected && !running && !drawerOpen && !sending && !model.busy && model.pending.isEmpty)
            }
            if editsOffline && model.offline {
                Label("Mac 不在线，连上后可发送", systemImage: "wifi.slash")
                    .font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
            }
            if let gate, !editsOffline { gateLine(gate) } else { field }
            if !person && gate == nil && model.sessionId != nil && (focused || !controls.isEmpty) { chips }
        }
        .padding(.bottom, 8).padding(.top, 4)
        .onAppear { insert() }
        // 加入对话 and 带入输入框 put text after what is written, never send it.
        .onChange(of: draftId.flatMap { model.draftInserts[$0] }) { _, value in if value != nil { insert() } }
        .onDisappear { slash.clear() }
        .onChange(of: text) { _, value in slash.changed(value) }
        .onChange(of: model.privateSnapshot.epoch) { _, _ in slash.clear(); slashControl = nil; slashStart = nil }
        .task(id: slashRead) { await slash.load(model, key: slashRead) }
        .sheet(item: $slashControl) { SlashControlSheet(request: $0, nextModel: $nextModel) }
        .sheet(item: $slashStart) { NewSessionSheet(fork: $0.fork, initialChoice: $0.choice, initialPrompt: $0.prompt).presentationCornerRadius(28) }
        // An iPad keeps this composer while the session beside the list changes.
        .onChange(of: draftId) { _, _ in
            nextModel = nil
            slash.clear(); slashControl = nil; slashStart = nil
        }
        .onChange(of: model.selectedHost?.id) { _, _ in nextModel = nil }
        // A turn that starts takes back 清空上下文, as the web's composer does.
        .onChange(of: running) { _, now in if now, let id = draftId { model.clearing.remove(id) } }
        .modifier(AttachSupport(key: attachKey, selection: attachKey.flatMap { model.attachSelection($0) }, harness: harness, source: $attachSource))
    }
    private func insert() {
        guard let added = model.takeInsert(for: draftId) else { return }
        text = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? added : text + "\n\n" + added
    }
    private func gateLine(_ words: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: gate == "Mac 不在线" ? "wifi.slash" : gate == Self.closedWindow ? PhoneUnlock.closedWindowSymbol(faceID: faceID) : "laptopcomputer").font(.system(size: 14)).foregroundStyle(PhoneTheme.muted)
            Text(words).font(.subheadline).foregroundStyle(PhoneTheme.muted).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if running && gate != "Mac 不在线" && model.detail["approvals"].array.isEmpty { stopButton(quiet: false) }
        }
        .padding(.leading, 16).padding(.trailing, 8).frame(minHeight: 52)
        .background(PhoneTheme.raised, in: Capsule()).overlay(Capsule().stroke(PhoneTheme.lineStrong))
        .padding(.horizontal, 12)
    }
    static let closedWindow = "查看内容后可以回复"
    private var inputMenu: some View {
        ComposerMenu(key: attachKey, harness: harness, selection: attachKey.flatMap { model.attachSelection($0) }, source: $attachSource) {
            if canQueueInstead {
                Button("排到下一轮", systemImage: "text.badge.plus") { send(queueInstead: true) }.disabled(!canSend)
            }
            SlashMenuItem(slash: slash, text: draftText, focused: $focused, context: slashContext)
        }
    }
    private var field: some View {
        ConversationInputBar(focused: $focused) {
            if rejecting == nil { inputMenu.disabled(!model.transportReady) }
        } editor: {
            editor.padding(.leading, rejecting == nil ? 0 : 10)
        } action: {
            action
        }
        .background(GeometryReader { proxy in
            Color.clear.onChange(of: proxy.frame(in: .global).minY, initial: true) { _, value in slashSpace = max(0, value - proxy.safeAreaInsets.top - 12) }
        })
    }
    private var editor: some View {
        LocalTextEditor(text: draftText, placeholder: hint, maximumLines: slashMenu == nil ? 6 : 3, focused: $focused,
            selection: $slash.selection, composing: $slash.composing, selectionRequest: $slash.selectionRequest,
            commandKeys: slashKeys, onCommand: slashKey,
            suffixHint: slash.hint(text, commands: slashCommands, enabled: slashContext.bodyOpen && slashContext.canRun && !slashContext.pending))
            .overlay(alignment: .topLeading) { if text.isEmpty { PromptHint(text: hint) } }
    }
    /** Empty while a turn runs, the circle stops it; with text it queues. */
    @ViewBuilder private var action: some View {
        if running && trimmed.isEmpty { stopButton(quiet: drawerOpen) }
        else if running && rejecting == nil && followUp != .none && PhoneSlash.actionOf(text) == nil {
            let steer = followUp == .steer
            Button { send() } label: {
                Text(steer ? "追加" : "排队").font(.system(size: 14, weight: .semibold)).foregroundStyle(canSend ? Color.white : PhoneTheme.faint)
                    .padding(.horizontal, 14).frame(height: 36).background(canSend ? PhoneTheme.accent : PhoneTheme.bubble, in: Capsule())
                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(!canSend).accessibilityLabel(steer ? "追加到本轮" : "排队发送")
        } else {
            Button { send() } label: {
                Group {
                    if sending { ProgressView().controlSize(.small).tint(Color.white) }
                    else { Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)).foregroundStyle(canSend ? Color.white : PhoneTheme.faint) }
                }.frame(width: 36, height: 36).background(canSend || sending ? PhoneTheme.accent : PhoneTheme.bubble, in: Circle())
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(!canSend).accessibilityLabel(sending ? "等待附件上传" : running ? "排队发送" : "发送")
        }
    }
    /** While a drawer waits on you, stop steps back without going away. */
    private func stopButton(quiet: Bool) -> some View {
        let host = model.generation, run = model.currentSummary["runId"].string
        return Button {
            Task {
                guard let draftId, model.generation == host, model.sessionId == draftId, model.currentSummary["runId"].string == run else { return }
                await model.stop()
            }
        } label: {
            Group {
                if model.stoppingCurrent { ProgressView().controlSize(.small).tint(PhoneTheme.canvas) }
                else { RoundedRectangle(cornerRadius: 2).fill(quiet ? PhoneTheme.muted : PhoneTheme.canvas).frame(width: 12, height: 12) }
            }.frame(width: 36, height: 36).background(quiet ? PhoneTheme.bubble : PhoneTheme.ink, in: Circle())
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(model.stoppingCurrent || !model.transportReady).accessibilityLabel(model.stoppingCurrent ? "正在停止" : "停止")
    }
    private var canQueueInstead: Bool {
        followUp == .steer && model.canQueueCurrent && !trimmed.isEmpty && rejecting == nil && PhoneSlash.actionOf(text) == nil
    }
    private func send() { send(queueInstead: false) }
    private func send(queueInstead: Bool) {
        guard !queueInstead || canQueueInstead else { return }
        guard let target = draftId, model.sessionId == target, gate == nil, canSend else { return }
        if rejecting == nil {
            switch PhoneSlash.action(text, context: slashContext) {
            case .text: break
            case .unavailable: return
            case let .open(action, argument): runSlash(action, argument: argument); return
            }
        }
        let input = text, reject = rejecting, next: PhoneFollowUp = queueInstead ? .queue : followUp
        let queue = running && reject == nil && next == .queue, steer = running && reject == nil && next == .steer
        // The send's target is fixed now: after waiting for uploads it goes to this session or nowhere.
        let chosen = nextModel, key = attachKey
        let host = model.generation, reading = model.contentGeneration
        Task {
            guard model.generation == host, model.contentGeneration == reading, model.sessionId == target else { return }
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
                sent = await model.send(text: input, queue: queue, steer: steer, nextModel: chosen, attachments: ids, target: .some(target))
                if let key { model.endAttachmentSend(key) }
            }
            if sent, model.generation == host, model.contentGeneration == reading, model.sessionId == target, text == input { text = "" }
        }
    }
    private var slashKeys: [String] {
        var keys = canSend ? ["submit"] : []
        guard let menu = slashMenu else { return keys }
        keys.append(UIKeyCommand.inputEscape)
        if menu.options.contains(where: { $0.unavailable == nil }) { keys += [UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow] }
        if slash.active(menu, text: text) != nil { keys += ["\t", "\r"] }
        return keys
    }
    private func slashKey(_ key: String) {
        guard !slash.composing else { return }
        if key == "submit" { if canSend { send() }; return }
        guard let menu = slashMenu else { return }
        if key == UIKeyCommand.inputEscape { slash.dismiss(text); return }
        if key == UIKeyCommand.inputUpArrow || key == UIKeyCommand.inputDownArrow { slash.move(menu, text: text, down: key == UIKeyCommand.inputDownArrow); return }
        guard let selected = slash.active(menu, text: text), menu.options.indices.contains(selected) else { return }
        let option = menu.options[selected]
        guard slash.complete(menu, option: option, text: draftText, enabled: slashContext.bodyOpen && slashContext.canRun && !slashContext.pending) else { return }
        if key == "\r", option.kind == .action { send() }
        else if key == "\r", option.kind == .command, option.inputHint == nil, !running { send() }
    }
    private func runSlash(_ action: PhoneSlashAction, argument: String) {
        guard !slash.composing, let id = draftId, id == model.sessionId, !slashContext.pending else { return }
        switch action {
        case .clear: if !model.openClearing { model.toggleClearing(id) }
        case .new:
            if person { guard let newTopic else { return }; newTopic(argument) }
            else {
                let harnessId = model.currentSummary["harnessId"].string, workspaceId = model.currentSummary["workspaceId"].string
                let service = PhoneStart.newSessionModel(model.snapshot["catalog"], harnessId: harnessId, workspaceId: workspaceId)
                slashStart = SlashStartDraft(choice: PhoneStartChoice(harnessId: harnessId, workspaceId: workspaceId, model: service), prompt: argument)
            }
        case .fork:
            guard let draft = forkDraft else { return }
            slashStart = SlashStartDraft(choice: draft.choice(model.snapshot["catalog"], source: model.currentSummary),
                prompt: argument.isEmpty ? PhoneForkDraft.prompt : argument, fork: draft)
        case .model, .think, .permissions:
            slashControl = SlashControlRequest(action: action, sessionId: id, query: argument, host: model.generation, content: model.privateSnapshot.epoch)
        case .changes: model.openReview(id)
        case .btw: return
        }
        text = ""; slash.clear()
    }
    /** One scrolling row above the keyboard. The built-in engine takes a model for each message; the Host offers no other choice before a send. */
    private var chips: some View {
        let summary = model.currentSummary, models = PhoneStart.models(model.snapshot["catalog"])
        let current = nextModel?.model ?? PhoneAgentChat.model(model.snapshot, task: summary)?.model ?? summary["model"].string
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

struct ConversationInputBar<Menu: View, Editor: View, Action: View>: View {
    @Binding var focused: Bool
    @ViewBuilder let menu: () -> Menu
    @ViewBuilder let editor: () -> Editor
    @ViewBuilder let action: () -> Action

    var body: some View {
        HStack(alignment: .bottom, spacing: 4) {
            menu()
            editor()
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .background {
                    Color.clear.contentShape(Rectangle())
                        .onTapGesture { focused = true }.accessibilityHidden(true)
                }
            action()
        }
        .padding(.horizontal, 6).padding(.vertical, 4)
        .fixedSize(horizontal: false, vertical: true)
        .background {
            RoundedRectangle(cornerRadius: 24)
                .fill(PhoneTheme.raised)
                .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
        }
        .overlay { RoundedRectangle(cornerRadius: 24).strokeBorder(PhoneTheme.lineStrong).allowsHitTesting(false) }
        .padding(.horizontal, 12)
    }
}

extension PromptComposer {
    static let abandonHint = "重试沿用同一请求，电脑已经收到的不会再算一次。放弃这次提交只在这台设备上放下它，文字回到输入框；电脑如果其实已经收到，它会出现在会话里，再发送就是第二条消息。"
    static let abandonStartHint = "重试沿用同一请求，电脑已经收到的不会再开一个会话。放弃这次提交只在这台设备上放下它，文字回到输入框；电脑如果其实已经收到，那个会话会出现在列表里，再发送会开始另一个会话，可能另建一个工作树。"
    /** The text goes back after whatever was written meanwhile. */
    fileprivate func abandon(_ pending: NativePendingWrite) async {
        guard case let .session(id) = PhonePending.kind(pending), id == draftId else { return }
        let opening = drafts.opening
        switch await model.abandonPrompt(pending) {
        case .delivered: if model.sessionId == id, drafts.opening == opening { settled = "已送达" }
        case let .text(back, twin):
            drafts.restore(back, for: id, opening: opening)
            if twin, model.sessionId == id, drafts.opening == opening { settled = PhoneAbandoned.queuedTwinWords }
        case nil: break
        }
    }
}
