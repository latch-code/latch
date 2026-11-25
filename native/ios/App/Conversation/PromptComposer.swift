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
    private var rawDraft: Binding<String> {
        let opening = drafts.opening, window = model.privateSnapshot.epoch, id = draftId
        func visible() -> Bool {
            drafts.opening == opening && model.sessionId == id && model.hasContentWindow && model.privateSnapshot.accepts(window)
        }
        return Binding(get: { drafts.text(for: id, visible: visible()) },
            set: { drafts.set($0, for: id, opening: opening, permitted: visible()) })
    }
    private var draftText: Binding<String> {
        let raw = rawDraft
        return Binding(get: { PhoneInputReferences(raw.wrappedValue, collapseQuotes: true).display },
            set: { raw.wrappedValue = PhoneInputReferences(raw.wrappedValue, collapseQuotes: true).restore($0) })
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
    @AppStorage(PhoneFollowUpDefault.key) private var followUpDefault = PhoneFollowUpDefault.steer
    /** The picker opened from the input menu. */
    @State private var choosingReference = false
    @State private var attachSource: AttachSource?
    /** Held from the tap through upload and the Host's receipt; a second tap cannot create another request. */
    @State private var sendID: UUID?
    private var sending: Bool { sendID != nil }
    @State private var pasteID: UUID?
    @StateObject private var slash = SlashComposerState()
    @StateObject private var mentionState = MentionState()
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
    private var mentions: MentionComposer {
        let scope = draftId.map(PhoneMentionScope.session)
        return MentionComposer(model: model, state: mentionState, editor: slash, text: draftText,
            context: MentionContext(model, scope: scope, owner: draftId),
            enabled: focused && slashSpace >= 44 && slashContext.bodyOpen && !slashContext.pending, sourceText: rawDraft.wrappedValue)
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
    private var hasRoundMaterials: Bool {
        !attachments.isEmpty || !mentions.references.isEmpty || rawDraft.wrappedValue.contains("[conversation-ref:")
    }
    private var memberRound: PhoneMemberMentions.Round? {
        guard gate == nil, !drawerOpen, PhoneSlash.actionOf(text) == nil, text.contains("@") else { return nil }
        return mentions.team?.round(in: rawDraft.wrappedValue, hasMaterials: hasRoundMaterials, fileRefs: mentions.references)
    }
    private var heldBack: String? {
        if let round = memberRound { return round.reason }
        if rejecting == nil, PhoneSlash.actionOf(text) == nil, let issue = PhoneConversation.promptLengthIssue(rawDraft.wrappedValue) { return issue }
        if rejecting == nil, running, !mentions.references.isEmpty { return "本轮结束后才能发送文件引用" }
        if followUp == .queue && model.canQueueAttachments || followUp == .steer && model.detail["steerAttachments"].bool { return nil }
        return PhoneAttachments.heldBack(followUp, running: running && rejecting == nil, count: attachments.items.count)
    }
    private var running: Bool { ["running", "waiting-approval"].contains(model.currentSummary["status"].string ?? "") }
    /** The drawer above already holds the answers, stop among them where it cannot be allowed. */
    private var drawerOpen: Bool { !model.detail["approvals"].array.isEmpty || !model.detail["questions"].array.isEmpty }
    private var trimmed: String { phonePromptTrim(text) }
    private var rejecting: String? {
        // A question's drawer covers any approval, and typing answers what is on screen.
        guard model.engineInfo(model.currentSummary["harnessId"].string)["capabilities"]["permission"]["rejectionNote"].bool, model.detail["questions"].array.isEmpty, let approval = model.detail["approvals"].array.first else { return nil }
        return approval["id"].string
    }
    private var hint: String { rejecting != nil ? "输入内容会拒绝并告诉 Agent 改做什么" : placeholder ?? "回复 " + engine + "…" }
    private var noteTooLong: Bool { rejecting != nil && PhoneConversation.rejectionNoteTooLong(rawDraft.wrappedValue) }
    private var followUpChoices: (primary: PhoneFollowUp, alternate: PhoneFollowUp?) {
        PhoneFollowUp.choices(detail: model.detail, status: model.currentSummary["status"].string, queues: model.canQueueCurrent,
            attached: !attachments.isEmpty || pasteID != nil, queueAttachments: model.canQueueAttachments,
            nextTurnOnly: model.stoppingCurrent || nextModel != nil || rawDraft.wrappedValue.contains("[conversation-ref:"), preferred: followUpDefault)
    }
    private var followUp: PhoneFollowUp { followUpChoices.primary }
    private var controls: [PhoneConfigControl] {
        guard model.sessionId != nil, model.detail["summary"]["id"].string == model.sessionId else { return [] }
        return PhoneSessionConfig.controls(model.detail, harness: model.engineInfo(model.currentSummary["harnessId"].string))
    }
    private var canSend: Bool {
        guard model.transportReady, !sending, pasteID == nil, attachKey.map({ !model.attachLocked($0) }) ?? true else { return false }
        if rejecting == nil, PhoneSlash.actionOf(text) != nil {
            if case .open = PhoneSlash.action(text, context: slashContext) { return !slash.composing }; return false
        }
        if let round = memberRound { return round.reason == nil && !model.busy && model.pending.isEmpty && !slash.composing }
        let attached = !attachments.isEmpty && rejecting == nil
        return (!trimmed.isEmpty || attached) && model.canRun && !model.busy && !slash.composing && model.pending.isEmpty && !noteTooLong
            && (!running || rejecting != nil || followUp != .none) && heldBack == nil
    }
    var body: some View {
        VStack(spacing: 8) {
            ForEach(model.writesAwaitingConfirmation, id: \.requestId) { pending in
                HStack {
                    Label(PhonePending.words(pending), systemImage: "clock").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                    Spacer()
                    // A new topic's start is retried on its own page or the list, never into this conversation.
                    if PhonePending.retried(pending, at: draftId.map { .session($0) } ?? .list) {
                        Button("重试这次提交") { Task { if PhoneHistory.isImport(pending) { await model.retryPending(pending) } else { await model.submit(pending) } } }.font(PhoneTheme.caption).disabled(model.busy || !model.transportReady)
                    }
                    if pending.teamRound != nil || PhoneQueueControl(pending) != nil, let draftId, PhonePending.kind(pending) == .session(id: draftId) {
                        AbandonSessionWrite(pending: pending)
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
                if pasteID != nil {
                    ProgressView("正在添加图片…").font(PhoneTheme.caption).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
                }
                if let heldBack {
                    Text(heldBack).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
                }
            }
            if noteTooLong {
                Text("告诉 Agent 的话最多 \(PhoneConversation.rejectionNoteLimit) 个字").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
            }
            if let slashReason { Text(slashReason).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16) }
            MentionSuggestions(input: mentions, maximumHeight: slashSpace).padding(.horizontal, 12)
            if let menu = slashMenu {
                SlashSuggestions(menu: menu, active: slash.active(menu, text: text), engine: engine,
                    mark: model.engineMark(model.currentSummary["harnessId"].string), reportedCommands: slashCommands.count, loading: slash.loading, failure: slash.failure,
                    maximumHeight: slashSpace, retry: { slash.retry += 1 }, choose: { slash.complete(menu, option: $0, text: draftText, enabled: slashContext.bodyOpen && slashContext.canRun && !slashContext.pending) })
                    .padding(.horizontal, 12)
            }
            if let draftId {
                CodexTeamView(sessionId: draftId, draft: rawDraft,
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
        .onDisappear { pasteID = nil; slash.clear(); mentionState.clear() }
        .onChange(of: text) { _, value in slash.changed(value) }
        .onChange(of: model.privateSnapshot.epoch) { _, _ in sendID = nil; pasteID = nil; choosingReference = false; slash.clear(); slashControl = nil; slashStart = nil }
        .onChange(of: mentions.context) { _, _ in mentionState.clear() }
        .task(id: slashRead) { await slash.load(model, key: slashRead) }
        .sheet(isPresented: $choosingReference) {
            if let id = draftId, model.hasContentWindow, model.detail["canReferenceConversation"].bool { ConversationReferenceSources(target: id) }
        }
        .sheet(item: $slashControl) { SlashControlSheet(request: $0, nextModel: $nextModel) }
        .sheet(item: $slashStart) { NewSessionSheet(fork: $0.fork, initialChoice: $0.choice, initialPrompt: $0.prompt).presentationCornerRadius(28) }
        // An iPad keeps this composer while the session beside the list changes.
        .onChange(of: draftId) { _, _ in
            sendID = nil; pasteID = nil; choosingReference = false; nextModel = nil
            slash.clear(); slashControl = nil; slashStart = nil
        }
        .onChange(of: model.selectedHost?.id) { _, _ in nextModel = nil }
        // A turn that starts takes back 清空上下文, as the web's composer does.
        .onChange(of: running) { _, now in if now, let id = draftId { model.clearing.remove(id) } }
        .modifier(AttachSupport(key: attachKey, selection: attachKey.flatMap { model.attachSelection($0) }, harness: harness, source: $attachSource))
    }
    private func insert() {
        guard let added = model.takeInsert(for: draftId) else { return }
        let draft = rawDraft.wrappedValue
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            rawDraft.wrappedValue = added
        } else {
            let separator = draft.hasSuffix("\n\n") ? "" : draft.hasSuffix("\n") ? "\n" : "\n\n"
            rawDraft.wrappedValue = draft + separator + added
        }
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
            if model.detail["canReferenceConversation"].bool && model.canRun && model.hasContentWindow {
                Button("引用另一条会话", systemImage: "text.bubble") { choosingReference = true }
            }
            if let alternate {
                Button(alternate == .queue ? "排到下一轮" : "立即发送", systemImage: alternate == .queue ? "text.badge.plus" : "arrow.up") {
                    send(as: alternate)
                }.disabled(!canSend)
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
    private var imagePasteHandler: (@MainActor ([NSItemProvider]) async -> Void)? {
        guard let key = attachKey, rejecting == nil, gate == nil else { return nil }
        let host = model.generation, reading = model.contentGeneration, window = model.privateSnapshot.epoch
        return { providers in
            guard model.generation == host, model.contentGeneration == reading, model.privateSnapshot.accepts(window), model.sessionId == key else { return }
            await pasteImages(providers)
        }
    }
    private var editor: some View {
        let input = LocalTextEditor(text: draftText, placeholder: hint, maximumLines: slashMenu == nil && !mentions.isOpen ? 6 : 3, focused: $focused,
            selection: $slash.selection, composing: $slash.composing, selectionRequest: $slash.selectionRequest,
            mentionMarkers: mentions.markers, commandKeys: slashKeys, onCommand: slashKey,
            suffixHint: slash.hint(text, commands: slashCommands, enabled: slashContext.bodyOpen && slashContext.canRun && !slashContext.pending),
            onPasteImages: imagePasteHandler, referenceDraft: rawDraft)
        // UIKit's undo history belongs to a single session and unlocked window.
        return input.id(draftId).id(model.privateSnapshot.epoch)
            .overlay(alignment: .topLeading) { if text.isEmpty { PromptHint(text: hint) } }
    }
    private func pasteImages(_ providers: [NSItemProvider]) async {
        guard pasteID == nil, let key = attachKey, let selection = model.attachSelection(key),
              gate == nil, rejecting == nil, model.canRun, model.hasContentWindow, model.transportReady else { return }
        guard !model.attachLocked(key) else { model.attachTrays[key, default: PhoneAttachTray()].note = PhoneAttachments.lockedWords; return }
        let id = UUID(), host = model.generation, reading = model.contentGeneration, window = model.privateSnapshot.epoch, driver = harness
        pasteID = id
        defer { if pasteID == id { pasteID = nil } }
        let current = { pasteID == id && model.privateSnapshot.accepts(window) && model.acceptsAttachmentIntake(key, selection: selection, host: host, reading: reading) }
        guard current() else { return }
        if model.attachState(key).caps == nil { await model.loadAttachCaps(key, selection: selection, harness: driver, asked: true) }
        guard current() else { return }
        guard let caps = model.attachState(key).caps else {
            model.attachTrays[key, default: PhoneAttachTray()].note = "没能读取这个会话能收的附件，请再粘贴一次。"
            return
        }
        let count = model.tray(key).items.count
        if let reason = PhoneAttachments.admit(kind: .image, name: "截图", size: 1, count: count, caps: caps) {
            model.attachTrays[key, default: PhoneAttachTray()].note = reason; return
        }
        let remaining = PhoneAttachments.perMessage - count
        var picked: [PhonePicked] = []
        for (index, provider) in providers.prefix(remaining).enumerated() {
            guard current() else { break }
            picked.append(await pickedImage(provider, name: provider.suggestedName ?? "截图 \(index + 1)", limit: PhoneAttachments.limit(.image, caps), paste: true))
        }
        let before = model.tray(key).items.count
        guard model.finishAttachmentIntake(key, selection: selection, host: host, reading: reading, window: window, pick: .files(picked.count),
            picked: picked, active: pasteID == id) else { return }
        if providers.count > remaining {
            let tray = model.tray(key), added = max(0, tray.items.count - before)
            let reason = tray.note ?? PhoneAttachments.tooMany
            model.attachTrays[key, default: PhoneAttachTray()].note = "已添加 \(added) 张图片，\(providers.count - added) 张未添加。\(reason)"
        }
    }
    /** Stop remains the primary action only while there is nothing this phone can send to the next turn. */
    @ViewBuilder private var action: some View {
        if running && trimmed.isEmpty && (rejecting != nil || followUp == .none || heldBack != nil || (attachments.isEmpty && pasteID == nil)) { stopButton(quiet: drawerOpen) }
        else if (memberRound != nil && !hasRoundMaterials) || (memberRound == nil && running && rejecting == nil && followUp != .none && PhoneSlash.actionOf(text) == nil) {
            let round = memberRound, steer = followUp == .steer
            let label = round != nil ? "派给成员" : steer ? "立即发送" : "排队"
            Button { if let round { dispatch(round) } else { send() } } label: {
                Text(label).font(.system(size: 14, weight: .semibold)).foregroundStyle(canSend ? Color.white : PhoneTheme.faint)
                    .padding(.horizontal, 14).frame(height: 36).background(canSend ? PhoneTheme.accent : PhoneTheme.bubble, in: Capsule())
                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(!canSend).accessibilityLabel(round != nil || steer ? label : "排队发送")
                .contextMenu {
                    if let alternate {
                        Button("立即发送", systemImage: "arrow.up") { send(as: alternate == .steer ? alternate : nil) }
                        Button("排到下一轮", systemImage: "text.badge.plus") { send(as: alternate == .queue ? alternate : nil) }
                    }
                }
        } else {
            Button { send() } label: {
                Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)).foregroundStyle(canSend ? Color.white : PhoneTheme.faint)
                    .frame(width: 36, height: 36).background(canSend ? PhoneTheme.accent : PhoneTheme.bubble, in: Circle())
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(!canSend).accessibilityLabel(memberRound != nil ? "派给成员" : rejecting != nil ? "拒绝并发送说明" : "发送")
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
        }.buttonStyle(.plain).disabled(sending || model.stoppingCurrent || !model.transportReady).accessibilityLabel(model.stoppingCurrent ? "正在停止" : "停止")
    }
    private func dispatch(_ round: PhoneMemberMentions.Round) {
        guard let target = draftId, round == memberRound, round.reason == nil, canSend else { return }
        let input = rawDraft.wrappedValue, submission = UUID(), context = mentions.context, materials = hasRoundMaterials
        sendID = submission
        Task {
            defer { if sendID == submission { sendID = nil } }
            guard sendID == submission, mentions.context == context, model.sessionId == target else { return }
            _ = await model.sendTeamRound(round, draft: input, session: target, hasMaterials: materials)
        }
    }
    private var alternate: PhoneFollowUp? {
        guard !trimmed.isEmpty || !attachments.isEmpty, !drawerOpen, memberRound == nil, PhoneSlash.actionOf(text) == nil,
              mentions.references.isEmpty else { return nil }
        return followUpChoices.alternate
    }
    private func send(as override: PhoneFollowUp? = nil) {
        guard override == nil || override == alternate else { return }
        guard let target = draftId, model.sessionId == target, gate == nil, canSend else { return }
        if let round = memberRound { dispatch(round); return }
        if rejecting == nil {
            switch PhoneSlash.action(text, context: slashContext) {
            case .text: break
            case .unavailable: return
            case let .open(action, _):
                let draft = PhoneInputReferences(rawDraft.wrappedValue, collapseQuotes: true)
                guard let words = draft.readableText(in: NSRange(location: 0, length: draft.display.utf16.count)),
                      let request = PhoneSlash.actionOf(words) else { return }
                runSlash(action, argument: request.argument)
                return
            }
        }
        let input = rawDraft.wrappedValue, reject = rejecting, next = override ?? followUp
        let queue = running && reject == nil && next == .queue, steer = running && reject == nil && next == .steer
        // The send's target is fixed now: after waiting for uploads it goes to this session or nowhere.
        let chosen = nextModel, key = attachKey, refs = mentions.references
        let host = model.generation, reading = model.contentGeneration, window = model.privateSnapshot.epoch
        let submission = UUID()
        sendID = submission
        Task {
            var lockedTray: String?
            defer {
                if let lockedTray { model.endAttachmentSend(lockedTray, owner: submission) }
                if sendID == submission { sendID = nil }
            }
            guard sendID == submission, model.generation == host, model.contentGeneration == reading, model.sessionId == target else { return }
            let sent: Bool
            if let reject { sent = await model.mutate(.post, path: PhoneModel.approvalPath(reject), fields: ["decision": .string("reject"), "note": .string(input)]) }
            else {
                var ids: [String] = []
                if let key, !model.tray(key).isEmpty {
                    lockedTray = key
                    let ready = await model.attachmentsToSend(key, target: target, owner: submission)
                    guard sendID == submission, model.generation == host, model.contentGeneration == reading, model.privateSnapshot.accepts(window),
                          model.sessionId == target, case let .success(value) = ready else { return }
                    ids = value
                }
                sent = await model.send(text: input, queue: queue, steer: steer, nextModel: chosen, attachments: ids, fileRefs: refs, target: .some(target), takingDraft: true)
            }
            if reject == nil, sent, sendID == submission { mentionState.clear() }
            if reject != nil, sent, sendID == submission, model.generation == host, model.contentGeneration == reading, model.sessionId == target, rawDraft.wrappedValue == input {
                rawDraft.wrappedValue = ""
            }
        }
    }
    private var slashKeys: [String] {
        var keys = mentions.keys
        if canSend && !mentions.isOpen && slashMenu == nil {
            keys.append("submit")
            if alternate != nil { keys.append("alternateSubmit") }
        }
        guard let menu = slashMenu else { return keys }
        keys.append(UIKeyCommand.inputEscape)
        if menu.options.contains(where: { $0.unavailable == nil }) { keys += [UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow] }
        if slash.active(menu, text: text) != nil { keys += ["\t", "\r"] }
        return keys
    }
    private func slashKey(_ key: String) {
        guard !slash.composing else { return }
        if mentions.handle(key) { return }
        if key == "submit" || key == "alternateSubmit" {
            guard canSend, !mentions.isOpen, slashMenu == nil else { return }
            if key == "submit" { send() } else if let alternate { send(as: alternate) }
            return
        }
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
