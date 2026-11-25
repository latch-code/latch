import LatchNativeCore
import SwiftUI
import UIKit

struct WorkPostComposer: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let itemId: String
    let stamp: PhoneWorkReadStamp
    let send: (PhoneWorkChange) async -> PhoneWriteOutcome
    @State private var text = ""
    @State private var recipient: PhoneWorkPostTarget?
    @State private var sending = false
    @State private var failure: String?
    @State private var composing = false
    @State private var focused = false
    @State private var selection = NSRange(location: 0, length: 0)
    @State private var selectionRequest: EditorSelectionRequest?
    @State private var previousToken: PhoneFileMentionToken?
    @State private var dismissed: PhoneFileMentionToken?
    @State private var highlight: PhoneWorkPostTarget?

    private var choices: [PhoneWorkPostChoice] {
        guard model.hasContentWindow, model.privateSnapshot.confirmed, model.workStamp(itemId) == stamp, let item = model.workItem(itemId) else { return [] }
        return PhoneWorkPostChoice.choices(snapshot: model.snapshot, item: item)
    }
    private var chosen: PhoneWorkPostChoice? { choices.first { $0.id == recipient } }
    private var targetProblem: String? {
        guard recipient != nil else { return nil }
        guard let chosen else { return "这个接收对象已不可用，请重新选择。" }
        return chosen.disabled
    }
    private var token: PhoneFileMentionToken? {
        guard focused, !composing, !sending, model.canRun, model.hasContentWindow, model.privateSnapshot.confirmed, model.workStamp(itemId) == stamp,
              let token = PhoneFileMentionToken.active(in: text, selection: selection, continuing: previousToken), token.query.utf16.count <= 40 else { return nil }
        return token
    }
    private var openToken: PhoneFileMentionToken? { token == dismissed ? nil : token }
    private var canSubmit: Bool {
        !sending && !composing && targetProblem == nil && !model.busy && model.pending.isEmpty && model.canRun
            && model.workStamp(itemId) == stamp && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.utf16.count <= 4000
    }

    var body: some View {
        let rows = choices, active = openToken
        let matches = active.map { PhoneWorkPostChoice.matching(rows, query: $0.query) } ?? []
        let enabled = matches.filter { $0.disabled == nil }.map(\.id)
        let highlighted = highlight.flatMap { enabled.contains($0) ? $0 : nil } ?? enabled.first
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Menu {
                            Button("只记在待办") { recipient = nil }
                            ForEach(rows) { row in
                                Button { select(row, token: active) } label: {
                                    Text(label(row, in: rows) + " · " + (row.disabled ?? kind(row.id)))
                                }.disabled(row.disabled != nil)
                            }
                        } label: {
                            HStack {
                                Text("发给").foregroundStyle(.primary)
                                Spacer()
                                Text(chosen.map { label($0, in: rows) } ?? (recipient == nil ? "只记在待办" : "已不可用"))
                                    .lineLimit(1).foregroundStyle(.secondary)
                                Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary)
                            }.contentShape(Rectangle())
                        }
                        if recipient != nil {
                            Button("移除接收对象", systemImage: "xmark.circle.fill") { recipient = nil }.labelStyle(.iconOnly)
                                .foregroundStyle(.secondary).frame(minWidth: 44, minHeight: 44)
                        }
                    }.buttonStyle(.borderless)
                    if let targetProblem { Text(targetProblem).foregroundStyle(PhoneTheme.amber) }
                } footer: {
                    if case .agent = recipient, model.workItem(itemId)?.isPrivate == false {
                        Text("发给 Agent 后，这条待办仅对有完整数据权限的设备可见。")
                    }
                }
                Section {
                    if let active {
                        suggestions(matches, all: rows, token: active, highlighted: highlighted)
                    }
                    ZStack(alignment: .topLeading) {
                        if text.isEmpty { Text("写发言，@ 会话或 Agent…").foregroundStyle(.tertiary).allowsHitTesting(false).accessibilityHidden(true) }
                        LocalTextEditor(text: $text, placeholder: "发言内容", maximumLines: 7, minimumLines: 5, focused: $focused,
                            selection: $selection, composing: $composing, selectionRequest: $selectionRequest,
                            commandKeys: active == nil ? [] : [UIKeyCommand.inputEscape] + (enabled.isEmpty ? [] : [UIKeyCommand.inputDownArrow, UIKeyCommand.inputUpArrow, "\t", "\r"]),
                            onCommand: { key in
                                guard let active, openToken == active else { return }
                                if key == UIKeyCommand.inputEscape { dismissed = active; return }
                                guard let highlighted, let at = enabled.firstIndex(of: highlighted) else { return }
                                if key == UIKeyCommand.inputDownArrow { highlight = enabled[(at + 1) % enabled.count] }
                                else if key == UIKeyCommand.inputUpArrow { highlight = enabled[(at + enabled.count - 1) % enabled.count] }
                                else if let row = matches.first(where: { $0.id == highlighted }) { select(row, token: active) }
                            })
                    }
                    if text.utf16.count > 4000 { Text("发言最多 4,000 个字符").font(.footnote).foregroundStyle(PhoneTheme.amber) }
                    if let failure { Text(failure).font(.footnote).foregroundStyle(PhoneTheme.amber) }
                }
            }
            .onChange(of: token) { _, now in previousToken = now; dismissed = nil; highlight = nil }
            .disabled(sending)
            .navigationTitle("写发言").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(sending) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(recipient == nil ? "记录" : "发送") { Task { await submit() } }.disabled(!canSubmit)
                }
            }
            .interactiveDismissDisabled(sending)
        }
    }

    private func kind(_ target: PhoneWorkPostTarget) -> String {
        switch target { case .session: "会话"; case .agent: "Agent" }
    }
    private func label(_ row: PhoneWorkPostChoice, in rows: [PhoneWorkPostChoice]) -> String {
        let name = PhoneConversation.visible(row.label)
        guard rows.contains(where: { $0.id != row.id && $0.label == row.label && kind($0.id) == kind(row.id) }) else { return name }
        switch row.id { case .session(let id), .agent(let id): return name + " · " + String(id.suffix(6)) }
    }
    private func suggestions(_ matches: [PhoneWorkPostChoice], all: [PhoneWorkPostChoice], token: PhoneFileMentionToken, highlighted: PhoneWorkPostTarget?) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if matches.isEmpty { Text("没有匹配的会话或 Agent").foregroundStyle(.secondary).font(.footnote).frame(minHeight: 44) }
                    ForEach(matches) { row in
                        Button { select(row, token: token) } label: {
                            HStack(spacing: 8) {
                                if case .session = row.id { EngineTile(mark: model.engineMark(row.harnessId), size: 18) }
                                else { Image(systemName: "person.crop.circle").frame(width: 18) }
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(label(row, in: all)).lineLimit(1)
                                    Text(row.disabled ?? kind(row.id)).font(.caption).foregroundStyle(.secondary)
                                }
                            }.padding(.horizontal, 8).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .contentShape(Rectangle()).background(row.id == highlighted ? PhoneTheme.bubble : .clear)
                        }.buttonStyle(.plain).disabled(row.disabled != nil).id(row.id)
                    }
                }
            }
            .frame(height: CGFloat(min(4, max(1, matches.count))) * 44)
            .onChange(of: highlighted) { _, id in if let id { proxy.scrollTo(id) } }
        }.accessibilityElement(children: .contain).accessibilityLabel("发给")
    }
    private func select(_ row: PhoneWorkPostChoice, token: PhoneFileMentionToken?) {
        guard choices.contains(where: { $0.id == row.id && $0.disabled == nil }) else { return }
        if let token {
            guard let edit = token.removing(in: text, selection: selection) else { return }
            text = edit.text; selection = edit.selection
            selectionRequest = EditorSelectionRequest(text: edit.text, range: edit.selection); focused = true
        }
        recipient = row.id
    }
    private func submit() async {
        guard canSubmit else { return }
        sending = true; defer { sending = false }
        let result = await send(.post(item: itemId, text: text, target: recipient))
        guard model.workStamp(itemId) == stamp else { return }
        switch result {
        case .done, .unknown: dismiss()
        case .refused, .failed: failure = workChangeFailure(result)
        }
    }
}
