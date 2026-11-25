import LatchNativeCore
import SwiftUI
import UIKit

@MainActor final class AgentMentionSession: ObservableObject {
    @Published var rows: [PhoneAgentConsultation] = []
    @Published var readError: String?
    @Published var revision = 0

    func observe(_ model: PhoneModel, owner: String) async {
        guard let path = PhoneAgentMentions.path(owner), model.agentAccess == .ready,
              PhoneAgentMentions.supports(model.snapshot, owner: owner), model.connected, model.tab == .agents else { return }
        let window = model.privateSnapshot.epoch, host = model.generation
        repeat {
            let read = await model.readAgentPart(path)
            guard !Task.isCancelled, model.privateSnapshot.accepts(window), model.generation == host, model.agentAccess == .ready,
                  model.tab == .agents, model.agentPath.first == owner else { return }
            if case let .ready(value) = read, case let .array(items) = value["mentions"] {
                rows = items.compactMap { PhoneAgentConsultation($0, owner: owner) }; readError = nil
            } else if read != .loading {
                readError = "协作记录暂时无法读取"
                if read == .locked || read == .closed { rows = [] }
                return
            }
            let active = rows.contains { ["sending", "running", "waiting-approval"].contains($0.status) }
            do { try await Task.sleep(for: .seconds(active ? 2 : 10)) } catch { return }
        } while !Task.isCancelled
    }
}

struct AgentConsultations: View {
    @EnvironmentObject private var model: PhoneModel
    @ObservedObject var consultation: AgentMentionSession

    var body: some View {
        ForEach(consultation.rows) { row in
            let entry = PhoneAgents.entry(model.snapshot, id: row.target)
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    AgentFace(avatar: entry?.avatar ?? .general, size: 26)
                    Text(entry.map { PhoneConversation.visible($0.name) } ?? "已移除的 Agent").font(.subheadline.weight(.semibold))
                    Spacer()
                    Text(row.words).font(.caption).foregroundStyle(row.status == "failed" ? PhoneTheme.red : PhoneTheme.muted)
                }
                Text((row.autonomous ? "Agent 发起 · " : "你发起 · ") + PhoneConversation.visible(row.text)).font(.subheadline).foregroundStyle(PhoneTheme.ink2)
                if let reply = row.reply, !reply.isEmpty {
                    Divider()
                    Text(PhoneConversation.visible(reply)).font(.body).foregroundStyle(PhoneTheme.ink)
                }
                if row.more, row.targetSession != nil, PhoneAgentChat.session(model.snapshot, owner: row.target) == row.targetSession {
                    Button("在对方聊天查看完整回复") { model.agentPath = [row.target] }.font(.caption)
                }
                if let failure = row.failure { Text(PhoneConversation.visible(failure)).font(.caption).foregroundStyle(PhoneTheme.red) }
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 14))
        }
        if let error = consultation.readError {
            HStack { Text(error); Button("重试") { consultation.revision += 1 } }.font(.caption).foregroundStyle(PhoneTheme.muted)
        }
    }
}

struct AgentPickerKeys {
    var keys: [String] = []
    var select: (String) -> Void = { _ in }
}

extension EnvironmentValues {
    @Entry var agentPickerKeys = AgentPickerKeys()
}

/** Both the first message and an existing chat use this field. A recipient is bound only on selection. */
struct AgentMentionField<Content: View>: View {
    @EnvironmentObject private var model: PhoneModel
    @ObservedObject var consultation: AgentMentionSession
    @ObservedObject var editor: SlashComposerState
    let owner: String
    @Binding var text: String
    @Binding var focused: Bool
    let hasMaterial: Bool
    let mentions: MentionComposer
    let maximumHeight: CGFloat
    @ViewBuilder let field: () -> Content
    @State private var target: PhoneAgentEntry?
    @State private var message = ""
    @State private var previous = ""
    @State private var opened: UUID?
    @State private var sending = false
    @State private var addressedFocus = false
    @State private var failure: String?
    @State private var highlighted: String?
    @State private var dismissed: NSRange?
    private var held: NativePendingWrite? { model.pending.first { PhoneAgentMentions.owner(of: $0) == owner } }
    private var available: Bool { model.agentAccess == .ready && model.canRun && PhoneAgentMentions.supports(model.snapshot, owner: owner) }
    private var token: (range: NSRange, query: String)? {
        guard available, focused, !editor.composing, target == nil, let token = PhoneAgentMentions.token(text, selection: editor.selection),
              token.range != dismissed else { return nil }
        return token
    }
    private var blockingMaterial: Bool {
        guard let token, let range = Range(token.range, in: text) else { return hasMaterial }
        let remainder = text.replacingCharacters(in: range, with: "")
        return hasMaterial || mentions.team?.round(in: remainder) != nil
    }
    private var materialNotice: String { "协作只发送文字，请先移除附件、引用或成员。" }
    private var suggestions: MentionComposer {
        var input = mentions
        if let token {
            input.personal = .init(entries: PhoneAgentMentions.options(model.snapshot, owner: owner, query: token.query),
                blocked: blockingMaterial ? materialNotice : held == nil ? nil : "有待确认的协作请求",
                select: { choose($0, using: token.range) })
        }
        return input
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let held {
                HStack {
                    Label("协作发送结果未知", systemImage: "questionmark.circle")
                    Spacer()
                    Button("重试同一请求") { submit(held) }.disabled(!available || model.busy || sending || !model.connected)
                }.font(.caption).foregroundStyle(PhoneTheme.amber).padding(.horizontal, 16)
            }
            if let target, available {
                HStack(spacing: 7) {
                    AgentFace(avatar: target.avatar, size: 22)
                    Text("发给 " + PhoneConversation.visible(target.name)).font(.subheadline.weight(.medium))
                    Button("移除接收者", systemImage: "xmark.circle.fill") {
                        text = message; self.target = nil; failure = nil; focused = true
                    }.labelStyle(.iconOnly).foregroundStyle(PhoneTheme.muted).disabled(sending || held != nil)
                }.padding(.horizontal, 16)
                if let failure { Text(failure).font(.caption).foregroundStyle(PhoneTheme.red).padding(.horizontal, 16) }
                let body = message.trimmingCharacters(in: .whitespacesAndNewlines)
                if body.utf16.count > PhoneAgentMentions.textLimit {
                    Text("协作消息过长，请缩短后发送。").font(.caption).foregroundStyle(PhoneTheme.amber).padding(.horizontal, 16)
                }
                let canSend = body.utf16.count <= PhoneAgentMentions.textLimit && !hasMaterial && model.transportReady && !model.busy && model.pending.isEmpty && !sending && !editor.composing
                    && !body.isEmpty
                ConversationInputBar(focused: $addressedFocus) {
                    Image(systemName: "at").foregroundStyle(PhoneTheme.muted).padding(.leading, 12).accessibilityHidden(true)
                } editor: {
                    let hint = "请" + PhoneConversation.visible(target.name) + "协作…"
                    LocalTextEditor(text: $message, placeholder: hint, focused: $addressedFocus, composing: $editor.composing,
                        commandKeys: canSend ? ["submit"] : [], onCommand: { if $0 == "submit" && canSend { send(to: target) } })
                        .overlay(alignment: .topLeading) { if message.isEmpty { PromptHint(text: hint) } }
                        .disabled(sending || held != nil)
                        .task(id: target.id) { await Task.yield(); addressedFocus = true }
                } action: {
                    Button { send(to: target) } label: {
                        Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)).foregroundStyle(canSend ? .white : PhoneTheme.faint)
                            .frame(width: 36, height: 36).background(canSend ? PhoneTheme.accent : PhoneTheme.bubble, in: Circle())
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }.disabled(!canSend).accessibilityLabel("发送给" + PhoneConversation.visible(target.name))
                }
            } else {
                MentionSuggestions(input: suggestions, maximumHeight: maximumHeight).padding(.horizontal, 12)
                if !mentions.handlesToken, let token { picker(token) }
                field().environment(\.agentPickerKeys, pickerKeys)
            }
        }
        .onAppear {
            opened = model.heldDrafts.opening
            if available, let draft = model.heldDrafts.addressedDraft(for: owner) {
                target = draft.target; message = draft.message; previous = draft.original
            }
        }
        .onChange(of: target?.id) { _, _ in remember() }
        .onChange(of: message) { _, _ in remember() }
        .onChange(of: text) { _, _ in dismissed = nil; highlighted = nil }
        .onChange(of: model.privateSnapshot.epoch) { _, _ in target = nil; previous = ""; message = ""; failure = nil; sending = false }
    }
    private func remember() {
        guard let opened, available else { return }
        model.heldDrafts.address(target, owner: owner, message: message, original: previous, opening: opened)
    }
    private func picker(_ token: (range: NSRange, query: String)) -> some View {
        let options = PhoneAgentMentions.options(model.snapshot, owner: owner, query: token.query)
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("选择协作 Agent").font(.caption.weight(.semibold)).foregroundStyle(PhoneTheme.muted)
                Spacer()
                Button("关闭", systemImage: "xmark") { dismissed = token.range }.labelStyle(.iconOnly).font(.caption)
                    .frame(minWidth: 40, minHeight: 36)
            }.padding(.horizontal, 12)
            if blockingMaterial {
                Text(materialNotice).font(.caption).foregroundStyle(PhoneTheme.amber).padding([.horizontal, .bottom], 12)
            } else if options.isEmpty {
                Text(token.query.isEmpty ? "这台电脑上没有其他 Agent" : "没有匹配的 Agent").font(.subheadline)
                    .foregroundStyle(PhoneTheme.muted).padding([.horizontal, .bottom], 12)
            } else {
                ScrollViewReader { reader in
                    ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(options) { entry in
                            Button {
                                choose(entry, using: token.range)
                            } label: {
                                HStack(spacing: 10) {
                                    AgentFace(avatar: entry.avatar, size: 32, face: entry.face)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(PhoneConversation.visible(entry.name)).font(.subheadline.weight(.semibold)).foregroundStyle(PhoneTheme.ink)
                                        if !entry.duty.isEmpty { Text(PhoneConversation.visible(entry.duty)).font(.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1) }
                                    }
                                    Spacer()
                                    if !entry.available { Text("不可用").font(.caption).foregroundStyle(PhoneTheme.muted) }
                                }.padding(.horizontal, 12).frame(height: 48).contentShape(Rectangle())
                                    .background((highlighted ?? options.first(where: \.available)?.id) == entry.id ? PhoneTheme.bubble : .clear)
                            }.buttonStyle(.plain).disabled(!entry.available || held != nil).id(entry.id)
                        }
                    }
                    }.onChange(of: highlighted) { _, id in if let id { reader.scrollTo(id) } }
                }.frame(height: min(144, CGFloat(options.count) * 48))
            }
        }.padding(.bottom, 3)
            .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(PhoneTheme.lineStrong).allowsHitTesting(false)).padding(.horizontal, 12)
    }
    private func choose(_ entry: PhoneAgentEntry, using token: NSRange) {
        guard !editor.composing, !blockingMaterial, held == nil, let range = Range(token, in: text) else { return }
        previous = text; message = text.replacingCharacters(in: range, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        target = entry; failure = nil; focused = true
    }
    private var pickerKeys: AgentPickerKeys {
        guard let token else { return AgentPickerKeys() }
        if mentions.handlesToken {
            let input = suggestions
            return AgentPickerKeys(keys: input.keys, select: { _ = input.handle($0) })
        }
        let entries = PhoneAgentMentions.options(model.snapshot, owner: owner, query: token.query).filter(\.available)
        var keys = [UIKeyCommand.inputEscape]
        if !blockingMaterial && !entries.isEmpty { keys += [UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow, "\r", "\t"] }
        return AgentPickerKeys(keys: keys, select: { key in
            if key == UIKeyCommand.inputEscape { dismissed = token.range; return }
            guard !entries.isEmpty else { return }
            let at = entries.firstIndex { $0.id == highlighted } ?? 0
            if key == UIKeyCommand.inputUpArrow { highlighted = entries[max(0, at - 1)].id }
            else if key == UIKeyCommand.inputDownArrow { highlighted = entries[min(entries.count - 1, highlighted == nil ? 0 : at + 1)].id }
            else { choose(entries[at], using: token.range) }
        })
    }
    private func send(to entry: PhoneAgentEntry) {
        guard !editor.composing, !hasMaterial, !sending, model.pending.isEmpty else { return }
        guard PhoneAgentMentions.options(model.snapshot, owner: owner, query: "").contains(where: { $0.id == entry.id && $0.available }) else {
            failure = "这位 Agent 已不在这台电脑上或暂时不可用。"; return
        }
        guard let write = try? PhoneAgentMentions.request(owner: owner, target: entry.id, text: message) else { return }
        submit(write)
    }
    private func submit(_ write: NativePendingWrite) {
        guard available, !sending, let transport = model.installedTransport, transport.valid else { return }
        let window = model.privateSnapshot.epoch, host = model.generation, retry = held?.requestId == write.requestId
        sending = true
        Task {
            let result = await model.write(write, refresh: false, on: transport, mustBePending: retry, permitted: {
                model.tab == .agents && model.agentPath.first == owner && available
            })
            guard model.generation == host, model.privateSnapshot.accepts(window) else { return }
            sending = false; consultation.revision += 1
            switch result {
            case .done:
                if text == previous { text = "" }
                target = nil; message = ""; previous = ""; failure = nil; remember()
            case let .refused(reason):
                if target == nil, let input = try? NativeJSON.decode(write.body), let id = input["target"]["customAgentId"].string {
                    target = PhoneAgents.entry(model.snapshot, id: id); previous = text; message = input["text"].string ?? ""
                }
                failure = PhoneConversation.visible(reason.message)
                if target == nil { model.error = failure }
            case .unknown: break
            case .failed: failure = "暂时无法发送，请再试一次。"
            }
        }
    }
}

struct AgentMentionMenuItem: View {
    @ObservedObject var editor: SlashComposerState
    @Binding var text: String
    @Binding var focused: Bool
    var body: some View {
        Button("联系其他 Agent", systemImage: "at") {
            let range = Range(editor.selection, in: text) ?? text.endIndex..<text.endIndex
            let left = text[..<range.lowerBound]
            let insert = left.last.map { $0.isWhitespace ? "@" : " @" } ?? "@"
            let start = left.utf16.count + insert.utf16.count
            text.replaceSubrange(range, with: insert)
            editor.selection = NSRange(location: start, length: 0)
            editor.selectionRequest = EditorSelectionRequest(text: text, range: editor.selection); focused = true
        }.disabled(editor.composing)
    }
}
