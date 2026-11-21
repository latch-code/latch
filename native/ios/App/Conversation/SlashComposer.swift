import LatchNativeCore
import SwiftUI
import UIKit

struct EditorSelectionRequest {
    let id = UUID()
    let text: String
    let range: NSRange
}

struct SlashReadKey: Equatable {
    let host: UUID
    let content: UUID
    let version: NativeJSON
    let enabled: Bool
    let retry: Int
    @MainActor init(model: PhoneModel, enabled: Bool, retry: Int) {
        host = model.generation; content = model.privateSnapshot.epoch
        version = model.snapshot["promptTemplatesVersion"]
        self.enabled = enabled && model.connected && model.verifiedUntil.map { $0 > Date() } == true
            && model.snapshot["catalog"]["features"]["promptTemplates"].bool
        self.retry = retry
    }
}

/** Ephemeral editor state. Private templates never leave the current App/window and are not a draft history. */
@MainActor final class SlashComposerState: ObservableObject {
    @Published var selection = NSRange(location: 0, length: 0)
    @Published var composing = false
    @Published var selectionRequest: EditorSelectionRequest?
    @Published private(set) var templates: [NativeJSON] = []
    @Published private(set) var loading = false
    @Published private(set) var failure: String?
    @Published var retry = 0
    @Published private var chosen: String?
    @Published private var chosenWord = ""
    @Published private var dismissed: String?
    private var read = UUID()

    private func word(_ text: String) -> String {
        let value = text as NSString
        return value.substring(to: min(value.length, max(0, selection.location)))
    }
    func menu(_ text: String, commands: [NativeJSON], context: PhoneSlashContext, focused: Bool) -> PhoneSlashMenu? {
        guard focused, !composing, selection.length == 0, dismissed != word(text) else { return nil }
        return PhoneSlash.menu(text, caret: selection.location, commands: commands, templates: templates, context: context)
    }
    func active(_ menu: PhoneSlashMenu, text: String) -> Int? {
        if chosenWord == word(text), let chosen { return menu.options.firstIndex { $0.id == chosen && $0.unavailable == nil } }
        return menu.initialSelection
    }
    func move(_ menu: PhoneSlashMenu, text: String, down: Bool) {
        guard let index = menu.moved(from: active(menu, text: text), down: down) else { return }
        chosenWord = word(text); chosen = menu.options[index].id
    }
    func dismiss(_ text: String) { dismissed = word(text) }
    func changed(_ text: String) {
        if dismissed != word(text) { dismissed = nil }
        if chosenWord != word(text) { chosen = nil }
    }
    func clear() {
        read = UUID(); templates = []; loading = false; failure = nil
        chosen = nil; dismissed = nil; selectionRequest = nil
    }
    func insertSlash(_ text: Binding<String>, enabled: Bool) {
        guard enabled, !composing, let edit = PhoneSlash.openSuggestions(text.wrappedValue, selection: selection) else { return }
        text.wrappedValue = edit.text; selection = NSRange(location: edit.selectionStart, length: 0)
        selectionRequest = EditorSelectionRequest(text: edit.text, range: selection)
        chosen = nil; dismissed = nil
    }
    @discardableResult func complete(_ menu: PhoneSlashMenu, option: PhoneSlashOption, text: Binding<String>, enabled: Bool) -> Bool {
        guard !composing, let edit = PhoneSlash.complete(menu, optionId: option.id, draft: text.wrappedValue,
            caret: selection.location, enabled: enabled) else { return false }
        text.wrappedValue = edit.text
        selection = NSRange(location: edit.selectionStart, length: edit.selectionEnd - edit.selectionStart)
        selectionRequest = EditorSelectionRequest(text: edit.text, range: selection)
        dismiss(edit.text); chosen = nil
        return true
    }
    func hint(_ text: String, commands: [NativeJSON], enabled: Bool) -> String? {
        guard enabled, !composing, selection.length == 0, selection.location == text.utf16.count,
              text.last?.isWhitespace == true else { return nil }
        let word = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard word.first == "/" || word.first == "／" else { return nil }
        let name = String(word.dropFirst()).lowercased()
        let hint = PhoneSlashAction(rawValue: name)?.inputHint
            ?? commands.first(where: { $0["name"].string?.lowercased().utf8.elementsEqual(name.utf8) == true })?["inputHint"].string
        return hint.map(PhoneConversation.visible)
    }
    func load(_ model: PhoneModel, key: SlashReadKey) async {
        read = UUID(); templates = []; loading = false; failure = nil
        guard key.enabled else { return }
        let ticket = read
        let pending = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, self?.read == ticket else { return }; self?.loading = true
        }
        defer { pending.cancel(); if read == ticket { loading = false } }
        let response = await model.readAgentPart("/link/api/prompts")
        guard read == ticket, !Task.isCancelled, key.host == model.generation, key.content == model.privateSnapshot.epoch,
              model.connected, model.verifiedUntil.map({ $0 > Date() }) == true else { return }
        switch response {
        case let .ready(value):
            guard case let .array(items) = value["templates"], items.count <= 200 else { failure = "提示模板暂时不可用"; return }
            templates = items
        case .loading, .closed: break
        case .locked: failure = "这台设备不能读取提示模板"
        case .offline: failure = "Mac 不在线"
        default: failure = "提示模板加载失败"
        }
    }
}

struct SlashSuggestions: View {
    let menu: PhoneSlashMenu
    let active: Int?
    let engine: String
    let mark: String?
    let reportedCommands: Int
    let loading: Bool
    let failure: String?
    let maximumHeight: CGFloat
    let retry: () -> Void
    let choose: (PhoneSlashOption) -> Void
    private var showUnreportedCommands: Bool { menu.token.initial && menu.token.query.isEmpty && reportedCommands == 0 }
    private var emptyMessage: String? {
        guard menu.options.isEmpty, !loading, failure == nil else { return nil }
        if !menu.token.initial { return menu.token.query.isEmpty ? "没有可插入的提示模板" : "没有匹配的提示模板" }
        if menu.token.query.isEmpty { return nil }
        return PhoneSlash.actionOf("/" + menu.token.query) == nil ? "没有匹配的命令，文字会照常发送" : "这个动作在当前页面不可用"
    }
    private var height: CGFloat {
        let notices = (loading ? 44 : 0) + (failure == nil ? 0 : 44)
        let rows = menu.options.count * 44
        let empty = (showUnreportedCommands ? 44 : 0) + (emptyMessage == nil ? 0 : 52)
        return min(198, max(0, maximumHeight), CGFloat(rows + menu.sections.count * 24 + notices + empty + 8))
    }
    private func source(_ kind: PhoneSlashOption.Kind) -> String { switch kind { case .command: engine; case .template: "提示模板"; case .action: "Latch" } }
    private func highlighted(_ option: PhoneSlashOption) -> Text {
        let positions = Set(option.positions)
        var text = Text(""), offset = 0
        for character in option.label {
            let value = String(character), end = offset + value.utf16.count
            text = text + ((offset..<end).contains(where: positions.contains) ? Text(value).bold() : Text(value))
            offset = end
        }
        return text
    }
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    if loading { Text("正在读取提示模板…").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).padding(12) }
                    if let failure {
                        HStack { Text(failure); Spacer(); Button("重试", action: retry) }.font(PhoneTheme.caption).padding(12)
                    }
                    if showUnreportedCommands { Text(engine + " 还没报告命令").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).padding(12) }
                    if menu.token.query.isEmpty {
                        ForEach(menu.sections, id: \.rawValue) { kind in
                            Section {
                                ForEach(menu.options.filter { $0.kind == kind }) { row($0, searching: false) }
                            } header: {
                                HStack(spacing: 6) {
                                    if kind == .command { EngineTile(mark: mark, size: 12) }
                                    Text(source(kind)).font(.system(size: 11, weight: .medium)).foregroundStyle(PhoneTheme.muted)
                                    Spacer()
                                }.padding(.horizontal, 12).frame(height: 24).background(PhoneTheme.raised)
                            }
                        }
                    } else {
                        ForEach(menu.options) { row($0, searching: true) }
                    }
                    if let emptyMessage {
                        Text(emptyMessage).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).padding(12)
                    }
                }.padding(.vertical, 4)
            }
            .frame(height: height)
            .onChange(of: active) { _, index in if let index, menu.options.indices.contains(index) { proxy.scrollTo(menu.options[index].id, anchor: .center) } }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .background {
            RoundedRectangle(cornerRadius: 8)
                .fill(PhoneTheme.raised)
                .shadow(color: .black.opacity(0.1), radius: 8, y: 2)
        }
        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(PhoneTheme.line).allowsHitTesting(false) }
        .accessibilityElement(children: .contain).accessibilityLabel("命令与提示模板")
    }
    private func row(_ option: PhoneSlashOption, searching: Bool) -> some View {
        let selected = active.map { menu.options.indices.contains($0) && menu.options[$0].id == option.id } ?? false
        return Button { choose(option) } label: {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    highlighted(option).font(.system(size: 13, design: .monospaced)).foregroundStyle(option.unavailable == nil ? PhoneTheme.ink : PhoneTheme.muted).lineLimit(1)
                    if !option.description.isEmpty { Text(option.description).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1) }
                }
                Spacer(minLength: 0)
                if searching { Text(source(option.kind)).font(.system(size: 11)).foregroundStyle(PhoneTheme.muted).lineLimit(1) }
            }.padding(.horizontal, 10).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle()).background(selected ? PhoneTheme.bubble : .clear, in: RoundedRectangle(cornerRadius: 6))
        }.buttonStyle(.plain).disabled(option.unavailable != nil).id(option.id)
    }
}

struct SlashMenuItem: View {
    @ObservedObject var slash: SlashComposerState
    @Binding var text: String
    @Binding var focused: Bool
    let context: PhoneSlashContext

    var body: some View {
        let enabled = context.bodyOpen && context.canRun && !context.pending && !slash.composing
        Button("命令与模板", systemImage: "text.badge.plus") {
            slash.insertSlash($text, enabled: enabled)
            focused = true
        }.disabled(!enabled)
    }
}

struct SlashStartDraft: Identifiable {
    let id = UUID()
    let choice: PhoneStartChoice
    let prompt: String
    var fork: PhoneForkDraft? = nil
}

struct SlashControlRequest: Identifiable {
    let id = UUID()
    let action: PhoneSlashAction
    let sessionId: String
    let query: String
    let host: UUID
    let content: UUID
}

/** The same reported rows and writer as ConfigChips; the slash action only opens this native selection surface. */
struct SlashControlSheet: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let request: SlashControlRequest
    @Binding var nextModel: PhoneModelChoice?
    @State private var query = ""
    private var current: Bool {
        model.generation == request.host && model.privateSnapshot.epoch == request.content && model.sessionId == request.sessionId
            && model.verifiedUntil.map { $0 > Date() } == true && model.connected
    }
    private var harness: NativeJSON { model.engineInfo(model.currentSummary["harnessId"].string) }
    private var controls: [PhoneConfigControl] {
        guard current, model.detail["summary"]["id"].string == request.sessionId else { return [] }
        return PhoneSessionConfig.controls(model.detail, harness: harness).filter {
            request.action == .model && $0.kind == .model || request.action == .think && $0.kind == .thinking || request.action == .permissions && $0.kind == .permission
        }
    }
    var body: some View {
        NavigationStack {
            Group {
                if current, request.action == .model, PhoneStart.usesServices(harness) {
                    ModelList(models: PhoneStart.models(model.snapshot["catalog"]), chosen: Binding(get: {
                        nextModel ?? PhoneStart.models(model.snapshot["catalog"]).first {
                            $0.providerId == model.currentSummary["providerId"].string && $0.model == model.currentSummary["model"].string
                        }
                    }, set: { if current, !model.busy, model.pending.isEmpty { nextModel = $0 } }), initialQuery: request.query)
                } else {
                    List {
                        ForEach(controls) { control in
                            Section {
                                ForEach(control.rows.filter { query.isEmpty || ($0.name + " " + ($0.line ?? "")).localizedCaseInsensitiveContains(query) }) { row in
                                    Button { choose(row, control: control) } label: {
                                        HStack {
                                            VStack(alignment: .leading) { Text(row.name); if let line = row.line { Text(line).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) } }
                                            Spacer(); if row.current { Image(systemName: "checkmark").foregroundStyle(PhoneTheme.accent) }
                                        }
                                    }.disabled(!current || model.busy || !model.pending.isEmpty)
                                }
                            } header: { Text(control.title) } footer: {
                                if let note = control.note { HStack { Text(note); if let detail = control.noteDetail { InfoHint(text: detail) } } }
                            }
                        }
                    }.searchable(text: $query).navigationTitle(request.action.label)
                }
            }
            .disabled(!current || model.busy || !model.pending.isEmpty)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        }
        .onAppear { query = request.query }
        .onChange(of: current) { _, value in if !value { dismiss() } }
    }
    private func choose(_ row: PhoneConfigRow, control: PhoneConfigControl) {
        guard current, !model.busy, model.pending.isEmpty else { return }
        if !row.current || control.kind == .permission || control.source == .launch {
            Task { guard current else { return }; await model.setConfig(control.configId, value: row.value) }
        }
        dismiss()
    }
}
